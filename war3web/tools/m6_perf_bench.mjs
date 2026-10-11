// tools/m6_perf_bench.mjs — M6 wasm 模拟性能基准测试
//
// 目标：量化 wasm 模拟在不同单位规模下的性能，验证 30 fps 预算（33.33ms/tick）。
// 测量项：
//   - tick 耗时（100 / 200 / 500 单位场景）
//   - snapshot 生成耗时（sim_snapshot 写入 wasm heap 的 SOA buffer）
//   - binary 序列化耗时（HEAPU8.slice 拷出为独立 ArrayBuffer，WS/WebGPU 上传前必需）
//   - 内存占用（Node rss / heapUsed / arrayBuffers / wasm 内存）
//
// 用法：
//   node tools/m6_perf_bench.mjs
//   TICKS=600 WARMUP=50 node tools/m6_perf_bench.mjs     # 覆盖默认参数
//   NODE_OPTIONS="--expose-gc" node tools/m6_perf_bench.mjs  # 内存测量更干净（强制 GC）
//
// 输出：表格化结果 + 30 fps 预算占用百分比 + 瓶颈分析。
//
// 参考：
//   - tools/m4_wasm_server_poc.mjs（wasm 初始化 + spawn 模式）
//   - server/wasm_bridge.js（DEFAULT_TYPES 表 + snapshot 编码）
//   - engine/src/sim.c:1424-1450（sim_snapshot SOA 布局：header 5 + 15 列 + gold16）
//   - tools/perf_test.mjs（Node 侧 perf 测试参考，此工具是 wasm 版）
//
// 注意：本工具只测 Node 侧 wasm 模拟 + 快照 + 序列化，不涉及 client 渲染。
// wasm 侧 SIM_MAX = 1024（engine/src/sim.c:36），client 侧 M5_MAX_UNITS = 512
// （client/js/render.js:122），本工具覆盖 100/200/500 规模均在 wasm 上限内。

import createEngine from "../engine/out/engine.mjs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ---- 参数（可通过环境变量覆盖）----
const TICKS = +(process.env.TICKS || 300);       // 每场景稳定测量的 tick 数
const WARMUP = +(process.env.WARMUP || 30);      // 预热 tick（不计入）
const REPEAT = +(process.env.REPEAT || 5);        // 每组测量重复次数（取 min/avg）
const TICK_HZ = 30;
const TAU = 1 / TICK_HZ;
const FRAME_BUDGET_MS = 1000 / TICK_HZ;           // 33.33ms

// 场景规模：100（基线） / 200（中规模） / 500（大规模，接近 GPU buffer 上限 512）
const SCALES = [100, 200, 500];

// 单位类型表（与 server/wasm_bridge.js DEFAULT_TYPES 一致）
const ATK_TYPES = ["spells", "normal", "pierce", "siege", "magic", "chaos", "hero"];
const ARMOR_KINDS = ["small", "medium", "large", "fort", "normal", "hero", "divine", "none"];
const TYPES = {
  // 近战步兵：射程内立即交战，覆盖 combat 主路径
  hfoo: { isFight: true, hp: 420, armor: 2, armorType: "large", dmgBase: 11, dmgDice: 1, dmgSides: 2,
    atkCd: 1.35, atkRange: 90, attackPoint: 0.5, attackBackswing: 0.5,
    atkType: "normal", weaponKind: 0, missileSpeed: 0, moveSpeed: 270, radius: 31 },
  // 远程法师：导弹路径，覆盖 missile 生成/飞行/命中
  hwat: { isFight: true, hp: 525, armor: 0, armorType: "large", dmgBase: 17, dmgDice: 1, dmgSides: 5,
    atkCd: 1.5, atkRange: 300, attackPoint: 0.4, attackBackswing: 0.77,
    atkType: "pierce", weaponKind: 1, missileSpeed: 1300, moveSpeed: 220, radius: 32 },
  // 经济单位：静止 / 移动
  hpea: { kind: 1, isFight: false, moveSpeed: 190, radius: 16, hp: 160 },
  ngol: { kind: 2, isFight: false, moveSpeed: 0, radius: 50, hp: 50 },
  htow: { kind: 3, isFight: false, moveSpeed: 0, radius: 176, hp: 2000 },
};

// ---- 加载 wasm + 初始化 grid + damage table ----
const ROOT = path.resolve(import.meta.dirname, "..");
const eng = await createEngine();

const gp = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "gameplay.json"), "utf8"));
const dt = gp.damageBonus || {};

// walk grid（Terenas 384×384，origin -6144,-6144）
const walkArr = new Uint8Array(fs.readFileSync(path.join(ROOT, "public", "data", "walk.bin")));
const wp = eng._malloc(walkArr.length);
eng.HEAPU8.set(walkArr, wp);
eng._sim_grid_init(wp, 384, 384, -6144, -6144);

// damage bonus 表（7 攻击类型 × 8 护甲类型）
const tbl = eng._malloc(7 * 8 * 4);
for (let a = 0; a < 7; a++)
  for (let k = 0; k < 8; k++)
    eng.HEAPF32[(tbl >> 2) + a * 8 + k] = dt[ATK_TYPES[a]]?.[ARMOR_KINDS[k]] ?? 1;
eng._sim_set_dmg_table(tbl);
eng._free(tbl);

// 快照 buffer（64K float = 256 KB，足够 512 单位 + 16 gold + 256 missiles + 8192 events）
const SNAPBUF = eng._malloc(65536 * 4);

// ---- spawn 辅助（与 m4_wasm_server_poc.mjs 一致）----
function spawnFight(id, x, y, team, typeKey = "hfoo") {
  const T = TYPES[typeKey];
  eng._sim_spawn_fight(id, x, y, 0, T.moveSpeed, T.radius, T.hp, T.hp, T.armor,
    ARMOR_KINDS.indexOf(T.armorType), team, T.dmgBase, T.dmgDice, T.dmgSides,
    T.atkCd, T.atkRange, T.attackPoint, T.attackBackswing,
    ATK_TYPES.indexOf(T.atkType), T.weaponKind, T.missileSpeed);
  eng._sim_set_meta(id, team, 15, 1);
}
function spawnEcon(id, x, y, kind, pi, team, speed, radius, facing, hp) {
  eng._sim_spawn_econ(id, x, y, kind, pi, team, speed, radius, facing, hp);
  eng._sim_set_meta(id, pi, 0, 1);
}

/**
 * 布置场景：
 * - 80% 战斗单位分两队对垒（hfoo 近战 + hwat 远程交替），两队距离 ~120 → 射程内开始交战
 * - 20% 经济单位散布在中线以南（中立金矿 + 农民），覆盖 econ 路径
 *
 * 覆盖 sim 的 combat / movement / econ / missile 四条代码路径。
 * 单位位置按 8 列网格排列，行间距 70 > radius*2（避免重叠阻塞 sim）。
 *
 * @returns {{ nFighter: number, nEcon: number, total: number, spawnMs: number }}
 */
function setupScenario(nUnits) {
  eng._sim_clear_all();
  eng._sim_events_reset();
  const nFighter = Math.floor(nUnits * 0.8);
  const nEcon = nUnits - nFighter;

  const t0 = process.hrtime.bigint();
  let id = 0;
  // 战斗单位：左队 x=-60，右队 x=+60（相隔 120，hfoo atkRange=90+radius*2≈152 会拉过去打）
  for (let i = 0; i < nFighter; i++) {
    const team = i < nFighter / 2 ? 0 : 1;
    const sub = i < nFighter / 2 ? i : i - Math.floor(nFighter / 2);
    const row = Math.floor(sub / 8);
    const col = sub % 8;
    const side = team === 0 ? -1 : 1;
    const x = side * 60 + (col - 3.5) * 55;
    const y = row * 70;
    // 一半 hfoo 一半 hwat：hfoo 打近战，hwat 放远程导弹
    const typeKey = (i % 2 === 0) ? "hfoo" : "hwat";
    spawnFight(id++, x, y, team, typeKey);
  }
  // 经济单位：中立金矿 + 农民散布在中线以南（y=400+）
  for (let i = 0; i < nEcon; i++) {
    const row = Math.floor(i / 8);
    const col = i % 8;
    const x = (col - 3.5) * 60;
    const y = 400 + row * 70;
    const tk = TYPES[(i % 3 === 0) ? "ngol" : "hpea"];
    spawnEcon(id++, x, y, tk.kind, 12, 12, tk.moveSpeed, tk.radius, 0, tk.hp);
  }
  const spawnMs = Number(process.hrtime.bigint() - t0) / 1e6;

  return { nFighter, nEcon, total: nUnits, spawnMs };
}

// ---- 计时辅助 ----
/**
 * 测量 fn 的耗时。repeat 次取 min/avg（减少 GC / OS 调度噪声）。
 * fn(i) 接收当前轮次，便于内部变化参数。
 */
function measure(fn, repeat = REPEAT) {
  let best = Infinity;
  let total = 0;
  for (let i = 0; i < repeat; i++) {
    const t0 = process.hrtime.bigint();
    fn(i);
    const t1 = process.hrtime.bigint();
    const ms = Number(t1 - t0) / 1e6;
    if (ms < best) best = ms;
    total += ms;
  }
  return { min: best, avg: total / repeat };
}

// ---- 内存快照 ----
function memSnapshot() {
  const m = process.memoryUsage();
  // wasm 内存：emscripten 管理，随 HEAPU8.buffer 增长（16KB 步进）
  const wasmBytes = eng.HEAPU8.buffer.byteLength;
  return {
    rssMB: m.rss / 1048576,
    heapMB: m.heapUsed / 1048576,
    arrbufMB: (m.arrayBuffers || 0) / 1048576,
    wasmMB: wasmBytes / 1048576,
  };
}

// ---- 输出格式化 ----
function fmt(n, d = 2) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "—";
  return n.toFixed(d);
}
function pad(s, n) {
  const str = String(s);
  return str.length >= n ? str : str + " ".repeat(n - str.length);
}

// ---- 主流程 ----
console.log("\n=== M6 wasm 性能基准 ===");
console.log(`TICKS=${TICKS}  WARMUP=${WARMUP}  REPEAT=${REPEAT}  ` +
  `目标 ${TICK_HZ} fps（预算 ${FRAME_BUDGET_MS.toFixed(2)} ms/tick）`);
console.log(`Node ${process.version}  platform=${process.platform}/${process.arch}  cpus=${os.cpus().length}`);
console.log(`wasm 内存初始 ${(eng.HEAPU8.buffer.byteLength / 1048576).toFixed(2)} MB`);
console.log("");

const results = [];

for (const nUnits of SCALES) {
  const info = setupScenario(nUnits);

  // 预热：让 GC / wasm codegen 稳定，避免首 tick 尖峰
  for (let i = 0; i < WARMUP; i++) eng._sim_step(TAU);

  const memBefore = memSnapshot();

  // 1) tick 耗时：连续 TICKS 个 sim_step，重复 REPEAT 次取 min/avg
  //    每轮后清事件队列，避免事件缓冲区随测量增长
  const tickMs = measure((i) => {
    for (let t = 0; t < TICKS; t++) eng._sim_step(TAU);
    eng._sim_events_reset();
  }, REPEAT);

  // 2) snapshot 生成耗时：sim_snapshot 写入 wasm heap 内的 SOA buffer
  //    内部 O(SIM_MAX=1024)，但与单位数无关（已放置单位才拷字段）
  const snapGenMs = measure((i) => {
    eng._sim_snapshot(SNAPBUF, 65536);
  }, 20);

  // 3) binary 序列化耗时：HEAPU8.slice 拷出为独立 ArrayBuffer
  //    这是 M5 零拷贝上传前的必要步骤：wasm heap 不能直接传 WS/WebGPU
  //    拷贝大小 = sim_snapshot 返回的实际 float 数 × 4 字节
  const need = eng._sim_snapshot(SNAPBUF, 65536);
  const bufBytes = need * 4;
  const serializeMs = measure((i) => {
    eng.HEAPU8.slice(SNAPBUF, SNAPBUF + bufBytes);
  }, 20);

  const memAfter = memSnapshot();

  // 收尾：读一次快照 header，记录实际单位/导弹/事件数
  eng._sim_snapshot(SNAPBUF, 65536);
  const F = (i) => eng.HEAPF32[(SNAPBUF >> 2) + i];
  const snap = {
    tick: Math.round(F(0)),
    nUnits: Math.round(F(2)),
    nMissiles: Math.round(F(3)),
    nEvents: Math.round(F(4)),
    bufSize: need,
  };

  const perTick = tickMs.avg / TICKS;
  const budgetPct = perTick / FRAME_BUDGET_MS * 100;
  const memDelta = {
    rssMB: memAfter.rssMB - memBefore.rssMB,
    heapMB: memAfter.heapMB - memBefore.heapMB,
    arrbufMB: memAfter.arrbufMB - memBefore.arrbufMB,
    wasmMB: memAfter.wasmMB - memBefore.wasmMB,
  };

  results.push({
    scale: nUnits,
    nFighter: info.nFighter,
    nEcon: info.nEcon,
    spawnMs: info.spawnMs,
    nUnits: snap.nUnits,
    nMissiles: snap.nMissiles,
    nEvents: snap.nEvents,
    tickTotalMs: tickMs.avg,
    tickMinMs: tickMs.min,
    perTickMs: perTick,
    budgetPct,
    snapGenMs: snapGenMs.avg,
    snapGenMinMs: snapGenMs.min,
    serializeMs: serializeMs.avg,
    serializeMinMs: serializeMs.min,
    serializeKB: bufBytes / 1024,
    memBefore,
    memAfter,
    memDelta,
    bufSize: need,
  });
}

// ---- 输出表格：tick + snapshot + serialize ----
console.log("\n--- 基准结果 ---");
const header = [
  pad("规模", 6),
  pad("F/E", 8),
  pad("spawn", 7),
  pad("tick均ms", 10),
  pad("tickmin", 9),
  pad("每tick", 9),
  pad("预算%", 7),
  pad("snapms", 8),
  pad("serms", 8),
  pad("snapKB", 7),
  pad("nU/nM/nE", 12),
];
console.log(header.join(""));
console.log("-".repeat(header.join("").length));
for (const r of results) {
  const row = [
    pad(r.scale, 6),
    pad(`${r.nFighter}/${r.nEcon}`, 8),
    pad(fmt(r.spawnMs, 1), 7),
    pad(fmt(r.tickTotalMs, 1), 10),
    pad(fmt(r.tickMinMs, 1), 9),
    pad(fmt(r.perTickMs, 3), 9),
    pad(fmt(r.budgetPct, 1), 7),
    pad(fmt(r.snapGenMs, 4), 8),
    pad(fmt(r.serializeMs, 4), 8),
    pad(fmt(r.serializeKB, 1), 7),
    pad(`${r.nUnits}/${r.nMissiles}/${r.nEvents}`, 12),
  ];
  console.log(row.join(""));
}

// ---- 内存占用表格 ----
console.log("\n--- 内存占用（MB）---");
console.log(
  pad("规模", 6),
  pad("RSS前", 8), pad("RSS后", 8), pad("Δ", 7),
  pad("heap前", 8), pad("heap后", 8), pad("Δ", 7),
  pad("arrbuf前", 9), pad("arrbuf后", 9), pad("Δ", 7),
  pad("wasm前", 8), pad("wasm后", 8), pad("Δ", 7),
);
console.log("-".repeat(108));
for (const r of results) {
  console.log(
    pad(r.scale, 6),
    pad(fmt(r.memBefore.rssMB, 1), 8),
    pad(fmt(r.memAfter.rssMB, 1), 8),
    pad(fmt(r.memDelta.rssMB, 1), 7),
    pad(fmt(r.memBefore.heapMB, 1), 8),
    pad(fmt(r.memAfter.heapMB, 1), 8),
    pad(fmt(r.memDelta.heapMB, 1), 7),
    pad(fmt(r.memBefore.arrbufMB, 1), 9),
    pad(fmt(r.memAfter.arrbufMB, 1), 9),
    pad(fmt(r.memDelta.arrbufMB, 1), 7),
    pad(fmt(r.memBefore.wasmMB, 1), 8),
    pad(fmt(r.memAfter.wasmMB, 1), 8),
    pad(fmt(r.memDelta.wasmMB, 2), 7),
  );
}

// ---- 瓶颈分析 ----
console.log("\n--- 瓶颈分析 ---");
const ref = results[0];
const top = results[results.length - 1];
const growth = top.perTickMs / ref.perTickMs;
console.log(`100 → 500 单位：每 tick 耗时 ×${fmt(growth, 2)}（理想线性 ×5，> 5 说明有超线性瓶颈）`);
console.log(`500 单位 tick 占用 30 fps 预算：${fmt(top.budgetPct, 1)}%（预算 = ${FRAME_BUDGET_MS.toFixed(2)} ms）`);
if (top.budgetPct > 100) {
  console.log(`⚠  500 单位场景 tick 超出 30 fps 预算，需要优化或降低目标单位规模。`);
} else if (top.budgetPct > 70) {
  console.log(`⚠  500 单位场景 tick 接近 30 fps 预算上限，需注意尖峰与多房间叠加。`);
} else if (top.budgetPct > 50) {
  console.log(`✓  500 单位场景 tick 在 30 fps 预算内，但余量有限。`);
} else {
  console.log(`✓  500 单位场景 tick 在 30 fps 预算内，余量充足。`);
}

// 三块耗时占比（tick + snap + serialize 视为单帧端到端预算）
console.log("\n单帧端到端耗时（tick + snap + serialize）：");
for (const r of results) {
  const total = r.perTickMs + r.snapGenMs + r.serializeMs;
  const pct = (x) => fmt(x / total * 100, 1) + "%";
  console.log(
    `  ${r.scale} 单位：总 ${fmt(total, 3)} ms  ` +
    `| tick ${fmt(r.perTickMs, 3)} (${pct(r.perTickMs)})  ` +
    `| snap ${fmt(r.snapGenMs, 3)} (${pct(r.snapGenMs)})  ` +
    `| serialize ${fmt(r.serializeMs, 3)} (${pct(r.serializeMs)})  ` +
    `| snap KB ${fmt(r.serializeKB, 1)}`
  );
}

// 序列化速率
console.log("\n序列化速率（HEAPU8.slice 拷贝吞吐）：");
for (const r of results) {
  const mbPerSec = r.serializeKB / 1024 / (r.serializeMs / 1000);
  console.log(`  ${r.scale} 单位：${fmt(r.serializeKB, 1)} KB / ${fmt(r.serializeMs, 4)} ms = ${fmt(mbPerSec, 1)} MB/s`);
}

// 单位数线性度
console.log("\n单位数线性度（每单位摊薄的 tick 耗时）：");
for (const r of results) {
  console.log(`  ${r.scale} 单位：每 tick ${fmt(r.perTickMs, 3)} ms  ` +
    `→ 每单位 ${fmt(r.perTickMs * 1000 / r.nUnits, 3)} μs`);
}

// ---- 清理 ----
eng._free(SNAPBUF);
eng._free(wp);

console.log("");
console.log("提示：");
console.log("  - 运行加 --expose-gc 可让 arrayBuffers 内存数字更稳定（强制回收切片）");
console.log("  - wasm 侧 SIM_MAX=1024（engine/src/sim.c:36），本工具 500 单位在范围内");
console.log("  - client 侧 M5_MAX_UNITS=512（client/js/render.js:122），500 单位 GPU buffer 容量验证见 m6_gpu_buffer_test.mjs");
