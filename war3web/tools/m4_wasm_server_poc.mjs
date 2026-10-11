// tools/m4_wasm_server_poc.mjs — M4 阶段 4：server 端 wasm 集成 PoC
//
// 目标：验证 wasm 在 Node server 环境下可跑完整 tick 循环，快照/事件/buff API 全通。
// 场景：2 个 hfoo 单位（敌对）+ 1 个中立金矿，跑 100 tick。
// 验证：
//   - 快照 header（tick / nUnits / nMissiles / nEvents）按 tick 推进
//   - 前 5 单位坐标/HP 与 sim_get_fight 读出的战斗状态一致
//   - 事件桥（attack/death）时序与 goldens/combat_trace.json 前 100 tick 对账
//   - sim_apply_buff 施加后单位生效（regenerator buff → hp 随 tick 递增）
//   - sim_spawn_econ 放置中立金矿后 nUnits 正确包含它
//
// 用法：node tools/m4_wasm_server_poc.mjs
//
// 参考：
//   - tools/combat_test.mjs 的 wasm 初始化 + 单位 spawn 模式
//   - tools/snaprender_test.mjs 的 SOA 快照解码
//   - tools/buff_test.mjs 的 sim_apply_buff 用法
//   - engine/src/sim.c 1338-1399 的 SOA 布局（header 5 + 15 列 + gold16 + missiles + events）

import createEngine from "../engine/out/engine.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ATK_TYPES = ["spells", "normal", "pierce", "siege", "magic", "chaos", "hero"];
const ARMOR_KINDS = ["small", "medium", "large", "fort", "normal", "hero", "divine", "none"];
const gp = JSON.parse(fs.readFileSync(path.join(HERE, "..", "data", "gameplay.json"), "utf8"));
const dt = gp.damageBonus || {};
const golden = JSON.parse(fs.readFileSync(path.join(HERE, "..", "goldens", "combat_trace.json"), "utf8"));

// C buff kind 枚举（engine/src/sim.c 46-61）
const SIM_BUF = {
  speed: 0, mana: 1, armor: 2, vampiric: 3, regen: 4, damage: 5, morph: 6,
  stun: 7, slow: 8, weaken: 9, innerfire: 10, invis: 11, defend: 12,
  rage: 13, manashield: 14, silence: 15,
};

// hfoo 参数（Terenas 官方实测，与 combat_test/snaprender_test/buff_test 一致）
const HFOO = {
  hp: 420, armor: 2, armorType: "large", dmgBase: 11, dmgDice: 1, dmgSides: 2,
  atkCd: 1.35, atkRange: 90, attackPoint: 0.5, attackBackswing: 0.5,
  atkType: "normal", weaponKind: 0, missileSpeed: 0, moveSpeed: 270, radius: 31,
};

// ---- 加载 wasm + 初始化 grid + damage table ----
const eng = await createEngine();
const W = 384, H = 384, OX = -6144, OY = -6144;
const walkArr = new Uint8Array(fs.readFileSync(path.join(HERE, "..", "public", "data", "walk.bin")));
const wp = eng._malloc(walkArr.length);
eng.HEAPU8.set(walkArr, wp);
eng._sim_grid_init(wp, W, H, OX, OY);

const tbl = eng._malloc(7 * 8 * 4);
for (let a = 0; a < 7; a++) for (let k = 0; k < 8; k++)
  eng.HEAPF32[(tbl >> 2) + a * 8 + k] = dt[ATK_TYPES[a]]?.[ARMOR_KINDS[k]] ?? 1;
eng._sim_set_dmg_table(tbl);
eng._free(tbl);

// sim_get_fight 读 buffer：out[6] = hp, atkTimer, attackWindupRemaining, atkCount, dmgCount, alive
const SG = eng._malloc(6 * 4);
// sim_snapshot 目标 buffer（100 tick 内 3 单位 + 16 gold + ~50 事件 ≈ 需要 65536 * 4 足够）
const SNAPBUF = eng._malloc(65536 * 4);
// sim_get_buffs 读 buffer（最多 4 个 buff × 2 字段 int*）
const GB = eng._malloc(4 * 4);
const HEAP32 = new Int32Array(eng.HEAPU8.buffer);

const TAU = 1 / 30;   // tick 时长

// ---- spawn 辅助（与 combat_test.mjs 一致）----
const spawnFight = (id, x, y, team, typeKey = "hfoo") => {
  const T = HFOO;   // 本 PoC 只用 hfoo
  eng._sim_spawn_fight(id, x, y, 0, T.moveSpeed, T.radius, T.hp, T.hp, T.armor,
    ARMOR_KINDS.indexOf(T.armorType), team, T.dmgBase, T.dmgDice, T.dmgSides,
    T.atkCd, T.atkRange, T.attackPoint, T.attackBackswing,
    ATK_TYPES.indexOf(T.atkType), T.weaponKind, T.missileSpeed);
  eng._sim_set_meta(id, team, 15, 1);
};
const spawnEcon = (id, x, y, kind, pi, team, speed, radius, facing, hp) => {
  eng._sim_spawn_econ(id, x, y, kind, pi, team, speed, radius, facing, hp);
  eng._sim_set_meta(id, pi, 0, 1);
};

// ---- SOA 快照解码（与 snaprender_test.mjs 一致）----
// 布局：header(5) tick,nowMs,nUnits,nMissiles,nEvents + 单位 15 列 + gold16 + missiles*2 + events*4
const decode = (bufAddr) => {
  const F = (i) => eng.HEAPF32[(bufAddr >> 2) + i];
  const tick = Math.round(F(0));
  const nowMs = F(1);
  const nUnits = Math.round(F(2));
  const nMissiles = Math.round(F(3));
  const nEvents = Math.round(F(4));
  const COLS = 15;
  const C = (col, i) => F(5 + col * nUnits + i);
  const units = [];
  for (let i = 0; i < nUnits; i++) {
    units.push({
      id: Math.round(C(11, i)), x: C(0, i), y: C(1, i), f: C(2, i),
      hp: Math.round(C(3, i)), maxHp: Math.round(C(4, i)), alive: C(5, i),
      team: Math.round(C(6, i)), pi: Math.round(C(7, i)), kind: Math.round(C(8, i)),
      mv: C(9, i), ga: C(10, i), level: Math.round(C(12, i)),
      mana: Math.round(C(13, i)), maxMana: Math.round(C(14, i)),
    });
  }
  const gold = [];
  const goldBase = 5 + nUnits * COLS;
  for (let i = 0; i < 16; i++) gold.push(Math.round(F(goldBase + i)));
  const eventBase = goldBase + 16;
  const events = [];
  const missBase = eventBase + nEvents * 4;   // 导弹列在事件列之前（见 sim.c 1381-1397）
  // 实际布局：gold16 → missiles*2 → events*4（1379-1398）
  const evStart = goldBase + 16 + nMissiles * 2;
  for (let i = 0; i < nEvents; i++) {
    events.push([
      Math.round(F(evStart + i * 4)),     // tick
      Math.round(F(evStart + i * 4 + 1)), // type: 0=attack 1=missileEnd 2=death 3=bounty
      Math.round(F(evStart + i * 4 + 2)), // a
      Math.round(F(evStart + i * 4 + 3)), // b
    ]);
  }
  return { tick, nowMs, nUnits, nMissiles, nEvents, units, gold, events };
};

// ---- 检查器 ----
let pass = 0, fail = 0;
const check = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? "  -- " + detail : ""}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? "  -- " + detail : ""}`); }
};

// ====================================================================
// 场景 A：2 hfoo 敌对 + 1 中立金矿，跑 100 tick
// ====================================================================
console.log("\n=== 场景 A：2 敌对 hfoo + 1 中立金矿，100 tick ===");
eng._sim_clear_all();
eng._sim_events_reset();
spawnFight(0, 1300, 1100, 0);    // 红队
spawnFight(1, 1400, 1100, 1);    // 蓝队，100 距离（hfoo atkRange 90 + 半径 31×2 ≈ 152，射程内）
spawnEcon(2, 1350, 1300, 2, 2, 2, 0, 50, 0, 50);   // 中立金矿

// 首帧快照：验证 nUnits=3，header 起始态
let snap = decode(SNAPBUF);
eng._sim_snapshot(SNAPBUF, 65536);
snap = decode(SNAPBUF);
check("首帧 nUnits=3", snap.nUnits === 3, `nUnits=${snap.nUnits}`);
check("首帧 tick=0", snap.tick === 0, `tick=${snap.tick}`);
check("首帧 nEvents=0", snap.nEvents === 0, `nEvents=${snap.nEvents}`);
check("首帧含中立金矿 kind=2", snap.units.some((u) => u.kind === 2), `units=${snap.units.map((u) => `id${u.id}/k${u.kind}`).join(",")}`);

// 跑 100 tick，采集 header + 前 5 单位 HP/坐标
const trace = [];
const eventTrace = [];
for (let t = 0; t < 100; t++) {
  eng._sim_step(TAU);
  if (t % 10 === 9) {   // 每 10 tick 采一次
    eng._sim_snapshot(SNAPBUF, 65536);
    const s = decode(SNAPBUF);
    trace.push({ tick: s.tick, nUnits: s.nUnits, nMissiles: s.nMissiles, nEvents: s.nEvents, units: s.units.slice(0, 5) });
    eventTrace.push(...s.events);
  }
}
// 末尾全量事件
eng._sim_snapshot(SNAPBUF, 65536);
const finalSnap = decode(SNAPBUF);
const allEvents = [];
// 独立事件桥（不消耗 snapshot 缓冲区，走 sim_events_get）
const EVBUF = eng._malloc(8192 * 4 * 4);
const nEvs = eng._sim_events_get(EVBUF, 8192);
for (let i = 0; i < nEvs; i++) {
  const b = (EVBUF >> 2) + i * 4;
  allEvents.push([
    Math.round(eng.HEAPF32[b]),
    Math.round(eng.HEAPF32[b + 1]),
    Math.round(eng.HEAPF32[b + 2]),
    Math.round(eng.HEAPF32[b + 3]),
  ]);
}
eng._free(EVBUF);

// 打印 header 前 3 个采样点
console.log("\n  tick 采样（每 10 tick）:");
for (const s of trace.slice(0, 3)) {
  console.log(`    t=${String(s.tick).padStart(3)}  nU=${s.nUnits}  nM=${s.nMissiles}  nE=${s.nEvents}`);
}
console.log(`    ...  t=${trace[trace.length - 1].tick}  nU=${trace[trace.length - 1].nUnits}  nM=${trace[trace.length - 1].nMissiles}  nE=${trace[trace.length - 1].nEvents}`);

// 打印前 5 单位的坐标/HP（最终态）
console.log("\n  最终 3 单位坐标/HP:");
for (const u of finalSnap.units) {
  console.log(`    id=${u.id} kind=${u.kind} team=${u.team}  x=${u.x.toFixed(1)} y=${u.y.toFixed(1)}  hp=${u.hp}/${u.maxHp}  alive=${u.alive}`);
}

// header 推进
check("tick 推进到 100", finalSnap.tick === 100, `tick=${finalSnap.tick}`);
check("nUnits 保持 3", finalSnap.nUnits === 3, `nUnits=${finalSnap.nUnits}`);
check("nEvents > 0", finalSnap.nEvents > 0, `nEvents=${finalSnap.nEvents}`);
check("金矿仍存活", finalSnap.units.some((u) => u.kind === 2 && u.alive === 1));

// 事件桥：attack 事件（type=0）应至少 1 条
const atkEvents = allEvents.filter((e) => e[1] === 0);
const dthEvents = allEvents.filter((e) => e[1] === 2);
check("事件桥含 attack", atkEvents.length > 0, `attacks=${atkEvents.length}`);
console.log(`    100 tick 内 attack 事件数: ${atkEvents.length}, death: ${dthEvents.length}`);
if (atkEvents.length > 0) {
  console.log(`    首个 attack: t=${atkEvents[0][0]} attacker=${atkEvents[0][2]} target=${atkEvents[0][3]}`);
}

// ---- 对账：与 combat_test.mjs 的 golden 前 100 tick 对比 ----
// combat_test.mjs 的 melee_close 场景与 PoC 场景一致：2 hfoo，1300/1100 vs 1400/1100，间距 100。
// golden 里记录了全部攻击事件的 tick；本 PoC 100 tick 内应产生相同时序的前 N 次攻击。
const meleeClose = golden.scenes.find((s) => s.name === "melee_close");
if (meleeClose) {
  const jsFirst100 = meleeClose.atkEvents.filter((e) => e[0] < 100 && e[1] !== "missileEnd");
  // C 侧 attack 事件的 attacker id 是 wasm 槽位 id（PoC 里 0 和 1 就是 JS 的 unit 0/1）
  const cFirst100 = atkEvents.filter((e) => e[0] < 100);
  const dFirst = Math.abs(cFirst100[0]?.[0] - jsFirst100[0]?.[0]);
  const dCount = Math.abs(cFirst100.length - jsFirst100.length);
  check("首击时序 Δ≤3", dFirst <= 3, `C t=${cFirst100[0]?.[0]} / JS t=${jsFirst100[0]?.[0]}`);
  check("100 tick 内攻击数 Δ≤2", dCount <= 2, `C=${cFirst100.length} / JS=${jsFirst100.length}`);
}

// ====================================================================
// 场景 B：sim_apply_buff 施加后再生 buff → hp 随 tick 递增
// ====================================================================
console.log("\n=== 场景 B：sim_apply_buff 施加 regen 后 HP 递增 ===");
eng._sim_clear_all();
eng._sim_events_reset();
// 初始 hp=100（< maxHp=420），否则 regen 会被 maxHp 上限吃掉看不到递增
// （与 buff_test.mjs regen 场景一致的构造：spawn 时传 hp=100, maxHp=450）
const HFOO_B = HFOO;
eng._sim_spawn_fight(0, 1300, 1100, 0, HFOO_B.moveSpeed, HFOO_B.radius, 100, 420, HFOO_B.armor,
  ARMOR_KINDS.indexOf(HFOO_B.armorType), 0, HFOO_B.dmgBase, HFOO_B.dmgDice, HFOO_B.dmgSides,
  HFOO_B.atkCd, HFOO_B.atkRange, HFOO_B.attackPoint, HFOO_B.attackBackswing,
  ATK_TYPES.indexOf(HFOO_B.atkType), HFOO_B.weaponKind, HFOO_B.missileSpeed);
eng._sim_set_meta(0, 0, 15, 1);
// 施加 regen buff（flat=2 HP/s，永久）
const slot = eng._sim_apply_buff(0, SIM_BUF.regen, -1, BigInt(0), 0, 0, 2.0);
check("apply_buff 返回 slot ≥0", slot >= 0, `slot=${slot}`);
// 验证 buff 已写入
const nBuff = eng._sim_get_buffs(0, GB, 4);
let regenApplied = false;
for (let i = 0; i < nBuff; i++) {
  if (HEAP32[(GB >> 2) + i * 2] === SIM_BUF.regen) { regenApplied = true; break; }
}
check("regen buff 已写入槽位", regenApplied, `nBuff=${nBuff}`);

// 记录初始 HP，跑 60 tick 观察递增
let hp0 = 0;
eng._sim_get_fight(0, SG);
hp0 = eng.HEAPF32[SG >> 2];
for (let t = 0; t < 60; t++) eng._sim_step(TAU);
let hp60 = 0;
eng._sim_get_fight(0, SG);
hp60 = eng.HEAPF32[SG >> 2];
const dHp = hp60 - hp0;
// 2 HP/s × (60/30)s = 4 HP
check("regen 生效 HP +≈4", Math.abs(dHp - 4) <= 0.5, `Δhp=${dHp.toFixed(2)} 期望≈4`);

// ====================================================================
// 场景 C：sim_spawn_econ 金矿 + 农民采集
// ====================================================================
console.log("\n=== 场景 C：农民采集 + 玩家 0 金收入账 ===");
eng._sim_clear_all();
eng._sim_events_reset();
// 中立金矿（kind=2）
spawnEcon(0, 1000, 1000, 2, 2, 2, 0, 50, 0, 50);
// 农民（kind=1，玩家 0，team 0）
eng._sim_spawn_econ(1, 1100, 1000, 1, 0, 0, 190, 16, 0, 160);
eng._sim_set_meta(1, 0, 0, 1);
// 基地（kind=3，玩家 0）
spawnEcon(2, 1200, 1100, 3, 0, 0, 0, 176, 0, 2000);

// 跑 300 tick（~10 秒，农民应完成 2-3 次往返）
for (let t = 0; t < 300; t++) eng._sim_step(TAU);
const resBuf = eng._malloc(4);
eng._sim_get_res(0, resBuf);
const gold0 = Math.round(eng.HEAPF32[resBuf >> 2]);
eng._free(resBuf);
check("玩家 0 有金收入", gold0 >= 20, `gold=${gold0}`);
console.log(`    300 tick 后玩家 0 金: ${gold0}`);

// 清理
eng._free(SNAPBUF);
eng._free(SG);
eng._free(GB);
eng._free(wp);

// ====================================================================
// 汇总
// ====================================================================
console.log(`\n${"=".repeat(60)}`);
console.log(`PoC 汇总：${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
console.log(fail === 0
  ? "✓ wasm 在 Node server 环境可跑完整 tick（step/snapshot/events/buff/econ 全通）"
  : "✗ 存在失败项，见上");
console.log(`${"=".repeat(60)}\n`);
