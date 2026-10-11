// tools/snaprender_test.mjs — 快照驱动渲染对账（M4 收尾门禁）
//
// C 侧 sim_snapshot 经适配层 snapshotToRender 转成 world.snapshot() 的 ents 形状，
// 与 golden 的 JS 输出按单位 id 对齐逐字段比对——验证 SOA 快照足以驱动渲染。
// 注意：与 tools/render_test.mjs（Puppeteer WebGL 渲染器测试）无关。
//
// 门禁（确定性字段精确，RNG 字段容差）：
//   i / k / u / t / p / c / sel 精确；a 精确；
//   x / y Δ≤2；f Δ≤0.1；h Δ≤0（econ）/ Δ≤40（combat）；H / M / m / l 精确；mv Δ≤1
import createEngine from "../engine/out/engine.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ATK_TYPES = ["spells", "normal", "pierce", "siege", "magic", "chaos", "hero"];
const ARMOR_KINDS = ["small", "medium", "large", "fort", "normal", "hero", "divine", "none"];
const gp = JSON.parse(fs.readFileSync(path.join(HERE, "..", "data", "gameplay.json"), "utf8"));
const dt = gp.damageBonus || {};
const golden = JSON.parse(fs.readFileSync(path.join(HERE, "..", "goldens", "render_trace.json"), "utf8"));

// 战斗单位参数（与 combat_test/sim_step_test 一致）
const HFOO = { hp: 420, armor: 2, armorType: "large", dmgBase: 11, dmgDice: 1, dmgSides: 2, atkCd: 1.35, atkRange: 90, attackPoint: 0.5, attackBackswing: 0.5, atkType: "normal", weaponKind: 0, missileSpeed: 0, moveSpeed: 270, radius: 31 };
const HWAT = { hp: 525, armor: 0, armorType: "large", dmgBase: 17, dmgDice: 1, dmgSides: 5, atkCd: 1.5, atkRange: 300, attackPoint: 0.4, attackBackswing: 0.77, atkType: "pierce", weaponKind: 1, missileSpeed: 1300, moveSpeed: 220, radius: 32 };
const FIGHT = { hfoo: HFOO, hwat: HWAT };
// 经济单位（与 econ_test 一致）：hpea 190/16, htow 0/176, ngol 0/50；hp/face 取 golden
const ECON = {
  hpea: { moveSpeed: 190, radius: 16, kind: 1 },
  htow: { moveSpeed: 0, radius: 176, kind: 3 },
  ngol: { moveSpeed: 0, radius: 50, kind: 2 },
};

const eng = await createEngine();
const W = 384, H = 384, OX = -6144, OY = -6144;
const walkArr = new Uint8Array(fs.readFileSync(path.join(HERE, "..", "public", "data", "walk.bin")));
const wp = eng._malloc(walkArr.length);
eng.HEAPU8.set(walkArr, wp);
eng._sim_grid_init(wp, W, H, OX, OY);
const tbl = eng._malloc(7 * 8 * 4);
for (let a = 0; a < 7; a++) for (let k = 0; k < 8; k++) eng.HEAPF32[(tbl >> 2) + a * 8 + k] = dt[ATK_TYPES[a]]?.[ARMOR_KINDS[k]] ?? 1;
eng._sim_set_dmg_table(tbl);
eng._free(tbl);
const SNAPBUF = eng._malloc(65536 * 4);

// ---- 适配层：SOA 快照 → world.snapshot() ents ----
// units 来自解码；slots/colors 是 JS 侧按槽位回查的类型注册表（客户端 findMeta 等价物）
function snapshotToRender(units, slots, colors) {
  return units.map((u) => {
    const s = slots[u.id];
    return { i: s.id, k: s.k, u: s.u, sel: s.sel,
      x: Math.round(u.x), y: Math.round(u.y), f: +u.f.toFixed(2),
      t: Math.round(u.team), p: Math.round(u.pi), c: Math.round(colors[Math.round(u.pi)]),
      a: Math.round(u.alive), h: Math.round(u.hp), H: Math.round(u.maxHp),
      m: Math.round(u.mana), M: Math.round(u.maxMana), l: Math.round(u.level),
      mv: Math.round(u.mv) };
  });
}

function decode() {
  const nU = Math.round(eng.HEAPF32[(SNAPBUF >> 2) + 2]);
  const C = (col, i) => eng.HEAPF32[(SNAPBUF >> 2) + 5 + col * nU + i];
  const out = [];
  for (let i = 0; i < nU; i++)
    out.push({ id: Math.round(C(11, i)), x: C(0, i), y: C(1, i), f: C(2, i),
      hp: C(3, i), maxHp: C(4, i), alive: C(5, i), team: C(6, i), pi: C(7, i),
      kind: C(8, i), mv: C(9, i), level: C(12, i), mana: C(13, i), maxMana: C(14, i) });
  return out;
}

let allOk = true;
for (const s of golden.scenes) {
  eng._sim_clear_all();
  for (let i = 0; i < s.pos.length; i++) {
    const tk = s.kinds[i];
    const [mx, my] = s.pos[i];
    if (FIGHT[tk]) {
      const T = FIGHT[tk];
      eng._sim_spawn_fight(i, mx, my, s.face[i], T.moveSpeed, T.radius, T.hp, T.hp, T.armor,
        ARMOR_KINDS.indexOf(T.armorType), i % 2, T.dmgBase, T.dmgDice, T.dmgSides, T.atkCd,
        T.atkRange, T.attackPoint, T.attackBackswing, ATK_TYPES.indexOf(T.atkType),
        T.weaponKind, T.missileSpeed);
    } else {
      const T = ECON[tk];
      eng._sim_spawn_econ(i, mx, my, T.kind, s.pl[i], s.team[i], T.moveSpeed, T.radius, s.face[i], s.hp[i]);
    }
    eng._sim_set_meta(i, s.pl[i], s.bounty[i], s.level[i]);
  }
  const hpTol = s.name === "econ" ? 0 : 40;
  const rows = [];
  let bad = false;
  let t = 0;
  for (const chk of s.checks) {
    while (t < chk.t) { eng._sim_step(1 / 30); t++; }
    const need = eng._sim_snapshot(SNAPBUF, 65536);
    if (need > 65536) bad = true;
    const cEnts = snapshotToRender(decode(), s.slots, s.colors);
    const byId = new Map(chk.ents.map((e) => [e.i, e]));
    let dx = 0, dy = 0, dF = 0, dH = 0, dMv = 0, dMeta = 0;
    const seen = new Set();
    for (const c of cEnts) {
      const g = byId.get(c.i);
      seen.add(c.i);
      if (!g) { dMeta++; continue; }
      dx = Math.max(dx, Math.abs(c.x - g.x)); dy = Math.max(dy, Math.abs(c.y - g.y));
      dF = Math.max(dF, Math.abs(c.f - g.f)); dH = Math.max(dH, Math.abs(c.h - g.h));
      dMv = Math.max(dMv, Math.abs(c.mv - g.mv));
      for (const f of ["k", "u", "t", "p", "c", "sel", "a", "H", "M", "m", "l"])
        if (c[f] !== g[f]) dMeta++;
    }
    const missing = chk.ents.length - seen.size;
    const ok = cEnts.length === chk.ents.length && missing === 0 && dMeta === 0
      && dx <= 2 && dy <= 2 && dF <= 0.1 && dH <= hpTol && dMv <= 1;
    if (!ok) bad = true;
    rows.push(`  t${chk.t}: 单位${cEnts.length}/${chk.ents.length} Δx${dx} Δy${dy} Δf${dF.toFixed(2)} Δh${dH} mv${dMv} meta${dMeta}缺${missing} ${ok ? "OK" : "FAIL"}`);
  }
  if (bad) allOk = false;
  console.log(`${s.name}${bad ? " ❌" : " ✅"} (HP容差 ${hpTol})`);
  console.log(rows.join("\n"));
}
console.log(allOk ? "snaprender 对账: 2/2 场景全过（快照可驱动渲染）" : "snaprender 对账: 存在不一致");
if (!allOk) process.exitCode = 1;
eng._free(wp); eng._free(SNAPBUF);
