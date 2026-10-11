// tools/m5_zero_copy_test.mjs — M5 零拷贝数据流 PoC 验证
//
// 验证路径：Node 侧 wasm sim_snapshot → SOA ArrayBuffer → 浏览器 snapshotFromBinary →
// 还原 ents → 与 tools/snaprender_test.mjs 的 golden 逐字段比对。
//
// 门禁（与 snaprender_test 一致）：
//   i / k / u / t / p / c / sel 精确；a 精确；
//   x / y Δ≤2；f Δ≤0.1；h Δ≤0（econ）/ Δ≤40（combat）；H / M / m / l 精确；mv Δ≤1
//
// 注意：此测试验证客户端 SOA 读路径（snapshotFromBinary 的解码逻辑），
// 不涉及 WebSocket 二进制帧传输与 GPUBuffer 上传——那些需要 M4 阶段 4 激活。
// snapshotFromBinary 的实现见 client/js/render.js（export），此处内联同一段代码，
// 便于在独立 HTML 页面无需加载 three.js 即可测试。
import createEngine from "../engine/out/engine.mjs";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import puppeteer from "puppeteer-core";
import { CHROME } from "./chrome.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = process.env.PORT || 8079;

// ---- 与 tools/snaprender_test.mjs 一致的测试场景配置 ----
const ATK_TYPES = ["spells", "normal", "pierce", "siege", "magic", "chaos", "hero"];
const ARMOR_KINDS = ["small", "medium", "large", "fort", "normal", "hero", "divine", "none"];
const gp = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "gameplay.json"), "utf8"));
const dt = gp.damageBonus || {};
const golden = JSON.parse(fs.readFileSync(path.join(ROOT, "goldens", "render_trace.json"), "utf8"));

const HFOO = { hp: 420, armor: 2, armorType: "large", dmgBase: 11, dmgDice: 1, dmgSides: 2, atkCd: 1.35, atkRange: 90, attackPoint: 0.5, attackBackswing: 0.5, atkType: "normal", weaponKind: 0, missileSpeed: 0, moveSpeed: 270, radius: 31 };
const HWAT = { hp: 525, armor: 0, armorType: "large", dmgBase: 17, dmgDice: 1, dmgSides: 5, atkCd: 1.5, atkRange: 300, attackPoint: 0.4, attackBackswing: 0.77, atkType: "pierce", weaponKind: 1, missileSpeed: 1300, moveSpeed: 220, radius: 32 };
const FIGHT = { hfoo: HFOO, hwat: HWAT };
const ECON = {
  hpea: { moveSpeed: 190, radius: 16, kind: 1 },
  htow: { moveSpeed: 0, radius: 176, kind: 3 },
  ngol: { moveSpeed: 0, radius: 50, kind: 2 },
};

// ---- Node 侧：构建 SOA buffer ----
const eng = await createEngine();
const W = 384, H = 384, OX = -6144, OY = -6144;
const walkArr = new Uint8Array(fs.readFileSync(path.join(ROOT, "public", "data", "walk.bin")));
const wp = eng._malloc(walkArr.length);
eng.HEAPU8.set(walkArr, wp);
eng._sim_grid_init(wp, W, H, OX, OY);
const tbl = eng._malloc(7 * 8 * 4);
for (let a = 0; a < 7; a++) for (let k = 0; k < 8; k++) eng.HEAPF32[(tbl >> 2) + a * 8 + k] = dt[ATK_TYPES[a]]?.[ARMOR_KINDS[k]] ?? 1;
eng._sim_set_dmg_table(tbl);
eng._free(tbl);
const SNAPBUF = eng._malloc(65536 * 4);

/** 运行一个场景，返回最后一次 sim_snapshot 的 SOA ArrayBuffer（复制出来，脱离 wasm heap）。 */
function runScene(scene) {
  eng._sim_clear_all();
  for (let i = 0; i < scene.pos.length; i++) {
    const tk = scene.kinds[i];
    const [mx, my] = scene.pos[i];
    if (FIGHT[tk]) {
      const T = FIGHT[tk];
      eng._sim_spawn_fight(i, mx, my, scene.face[i], T.moveSpeed, T.radius, T.hp, T.hp, T.armor,
        ARMOR_KINDS.indexOf(T.armorType), i % 2, T.dmgBase, T.dmgDice, T.dmgSides, T.atkCd,
        T.atkRange, T.attackPoint, T.attackBackswing, ATK_TYPES.indexOf(T.atkType),
        T.weaponKind, T.missileSpeed);
    } else {
      const T = ECON[tk];
      eng._sim_spawn_econ(i, mx, my, T.kind, scene.pl[i], scene.team[i], T.moveSpeed, T.radius, scene.face[i], scene.hp[i]);
    }
    eng._sim_set_meta(i, scene.pl[i], scene.bounty[i], scene.level[i]);
  }
  const chk = scene.checks[scene.checks.length - 1];
  let t = 0;
  for (const c of scene.checks) {
    while (t < c.t) { eng._sim_step(1 / 30); t++; }
  }
  const need = eng._sim_snapshot(SNAPBUF, 65536);
  if (need > 65536) throw new Error(`SOA buffer overflow: need ${need}, cap 65536`);
  // 复制出 wasm heap，变成独立 ArrayBuffer
  const buf = eng.HEAPU8.slice(SNAPBUF, SNAPBUF + need * 4).buffer;
  return { buf, goldenEnts: chk.ents };
}

// 为每个场景构建 SOA buffer + golden ents
const scenes = golden.scenes.map((s) => {
  const { buf, goldenEnts } = runScene(s);
  return { name: s.name, hpTol: s.name === "econ" ? 0 : 40, buf, goldenEnts, slots: s.slots, colors: s.colors };
});

// ---- 浏览器端：测试页面 ----
// snapshotFromBinary 内联自 client/js/render.js（同一段代码，便于独立测试）。
// 修改 render.js 的 snapshotFromBinary 时须同步此处。
const TEST_PAGE = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>M5 Zero-Copy Test</title></head>
<body>
<div id="log">running…</div>
<script type="module">
// SOA 列布局常量（与 engine/src/sim.c:1316 sim_snapshot 一致）
const SOA_HEADER = 5;
const SOA_COLS = 15;
const SOA_COL = {
  X: 0, Y: 1, FACING: 2, HP: 3, MAX_HP: 4, ALIVE: 5, TEAM: 6, PI: 7,
  KIND: 8, MOVING: 9, GATHERING: 10, ID: 11, LEVEL: 12, MANA: 13, MAX_MANA: 14,
};

// 从 SOA ArrayBuffer 读回单位快照，形状对齐 world.snapshot() 的 ents 数组。
// 与 client/js/render.js:102 export function snapshotFromBinary 同一段代码。
function snapshotFromBinary(buf, slots, colors) {
  const f = new Float32Array(buf);
  const nUnits = Math.round(f[SOA_HEADER - 3]);
  const ents = new Array(nUnits);
  const colBase = SOA_HEADER;
  for (let i = 0; i < nUnits; i++) {
    const s = slots[Math.round(f[colBase + SOA_COL.ID * nUnits + i])] || {};
    ents[i] = {
      i: s.id ?? Math.round(f[colBase + SOA_COL.ID * nUnits + i]),
      k: s.k ?? Math.round(f[colBase + SOA_COL.KIND * nUnits + i]),
      u: s.u ?? '',
      sel: s.sel ?? true,
      x: Math.round(f[colBase + SOA_COL.X * nUnits + i]),
      y: Math.round(f[colBase + SOA_COL.Y * nUnits + i]),
      f: +f[colBase + SOA_COL.FACING * nUnits + i].toFixed(2),
      t: Math.round(f[colBase + SOA_COL.TEAM * nUnits + i]),
      p: Math.round(f[colBase + SOA_COL.PI * nUnits + i]),
      c: Math.round(colors?.[Math.round(f[colBase + SOA_COL.PI * nUnits + i])] ?? 0),
      a: Math.round(f[colBase + SOA_COL.ALIVE * nUnits + i]),
      h: Math.round(f[colBase + SOA_COL.HP * nUnits + i]),
      H: Math.round(f[colBase + SOA_COL.MAX_HP * nUnits + i]),
      m: Math.round(f[colBase + SOA_COL.MANA * nUnits + i]),
      M: Math.round(f[colBase + SOA_COL.MAX_MANA * nUnits + i]),
      l: Math.round(f[colBase + SOA_COL.LEVEL * nUnits + i]),
      mv: Math.round(f[colBase + SOA_COL.MOVING * nUnits + i]),
    };
  }
  return ents;
}

// 从 SOA ArrayBuffer 读 header
function snapshotHeader(buf) {
  const f = new Float32Array(buf);
  return {
    tick: Math.round(f[0]),
    nowMs: Math.round(f[1]),
    nUnits: Math.round(f[2]),
    nMissiles: Math.round(f[3]),
    nEvents: Math.round(f[4]),
  };
}

// 暴露给 Puppeteer
window.__m5 = { snapshotFromBinary, snapshotHeader };
window.__m5Ready = true;
document.body.dataset.ready = 'yes';
</script>
</body></html>`;

// ---- HTTP server ----
const server = http.createServer((req, res) => {
  if (req.url === '/test.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(TEST_PAGE);
    return;
  }
  res.writeHead(404); res.end();
});
await new Promise((r) => server.listen(PORT, '127.0.0.1', r));

// ---- Puppeteer ----
let failed = 0;
const allResults = [];
try {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${PORT}/test.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__m5Ready === true, { timeout: 5000 });

  for (const sc of scenes) {
    // 把 SOA buffer 作为 base64 传给浏览器（避免 Puppeteer 的 ArrayBuffer 序列化问题）
    const b64 = Buffer.from(sc.buf).toString('base64');
    const result = await page.evaluate(async ({ b64, slots, colors, goldenEnts, hpTol }) => {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const buf = bytes.buffer;
      const header = window.__m5.snapshotHeader(buf);
      const ents = window.__m5.snapshotFromBinary(buf, slots, colors);

      // 逐字段比对
      const byId = new Map(goldenEnts.map(e => [e.i, e]));
      let dMeta = 0, dx = 0, dy = 0, dF = 0, dH = 0, dMv = 0;
      const seen = new Set();
      for (const c of ents) {
        const g = byId.get(c.i);
        seen.add(c.i);
        if (!g) { dMeta++; continue; }
        dx = Math.max(dx, Math.abs(c.x - g.x));
        dy = Math.max(dy, Math.abs(c.y - g.y));
        dF = Math.max(dF, Math.abs(c.f - g.f));
        dH = Math.max(dH, Math.abs(c.h - g.h));
        dMv = Math.max(dMv, Math.abs(c.mv - g.mv));
        for (const f of ['k', 'u', 't', 'p', 'c', 'sel', 'a', 'H', 'M', 'm', 'l'])
          if (c[f] !== g[f]) dMeta++;
      }
      const missing = goldenEnts.length - seen.size;
      const ok = ents.length === goldenEnts.length && missing === 0 && dMeta === 0
        && dx <= 2 && dy <= 2 && dF <= 0.1 && dH <= hpTol && dMv <= 1;
      return { ok, nUnits: header.nUnits, entsLen: ents.length, goldenLen: goldenEnts.length,
               dx, dy, dF, dH, dMv, dMeta, missing };
    }, { b64, slots: sc.slots, colors: sc.colors, goldenEnts: sc.goldenEnts, hpTol: sc.hpTol });

    allResults.push({ name: sc.name, ...result });
    const status = result.ok ? 'ok' : 'FAIL';
    console.log(`  ${status}  ${sc.name}: 单位${result.entsLen}/${result.goldenLen} Δx${result.dx} Δy${result.dy} Δf${result.dF.toFixed(2)} Δh${result.dH} mv${result.dMv} meta${result.dMeta}缺${result.missing}`);
    if (!result.ok) failed++;
  }
  await browser.close();
} catch (e) {
  failed++;
  console.error('测试失败:', e.message);
} finally {
  server.close();
  eng._free(wp);
  eng._free(SNAPBUF);
}

console.log(failed ? `\n${failed} scene(s) failed` : '\nM5 零拷贝 PoC: 全部场景通过 ✅');
process.exit(failed ? 1 : 0);
