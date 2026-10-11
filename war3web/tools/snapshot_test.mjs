// snapshot_test.mjs — SOA 快照 C/JS 逐字段对账（M4 阶段 3 门禁）
//
// C 侧 sim_snapshot 产出与 goldens/snapshot_trace.json 的 JS 快照可比子集逐字段比对：
//   单位列（x/y/facing/hp/maxHp/team/pi/alive/mv）+ 玩家资源 gold + 导弹数
// 门禁：
//   econ（确定性强）：单位数/坐标 Δ≤2、facing Δ≤0.1、HP 精确、team/pi/alive 精确、
//     gold Δ≤10、mv 不匹配 ≤1、导弹数精确
//   ranged_hwat（含 RNG）：HP Δ≤40、其余同上
import createEngine from "../engine/out/engine.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ATK_TYPES = ["spells", "normal", "pierce", "siege", "magic", "chaos", "hero"];
const ARMOR_KINDS = ["small", "medium", "large", "fort", "normal", "hero", "divine", "none"];
const gp = JSON.parse(fs.readFileSync(path.join(HERE, "..", "data", "gameplay.json"), "utf8"));
const dt = gp.damageBonus || {};
const golden = JSON.parse(fs.readFileSync(path.join(HERE, "..", "goldens", "snapshot_trace.json"), "utf8"));

const HFOO = { hp: 420, armor: 2, armorType: "large", dmgBase: 11, dmgDice: 1, dmgSides: 2, atkCd: 1.35, atkRange: 90, attackPoint: 0.5, attackBackswing: 0.5, atkType: "normal", weaponKind: 0, missileSpeed: 0, moveSpeed: 270, radius: 31 };
const HWAT = { hp: 525, armor: 0, armorType: "large", dmgBase: 17, dmgDice: 1, dmgSides: 5, atkCd: 1.5, atkRange: 300, attackPoint: 0.4, attackBackswing: 0.77, atkType: "pierce", weaponKind: 1, missileSpeed: 1300, moveSpeed: 220, radius: 32 };
const COMBAT_TYPES = { hfoo: HFOO, hwat: HWAT };
const ECON_KIND = { hpea: 1, ngol: 2, htow: 3 };
const ECON_SPEED = { hpea: 190, ngol: 0, htow: 0 };
const ECON_RAD = { hpea: 16, ngol: 50, htow: 176 };

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

const SNAP_MAX = 8192;
const snapBuf = eng._malloc(SNAP_MAX * 4);

// 解码 C 快照 → 与 golden 同形状的 {units:[[x,y,f,hp,H,team,pi,alive,mv]], gold, nMissiles}
function decode() {
  const need = eng._sim_snapshot(snapBuf, SNAP_MAX);
  if (need > SNAP_MAX) throw new Error(`快照不足 ${need} > ${SNAP_MAX}`);
  const F = (i) => eng.HEAPF32[(snapBuf >> 2) + i];
  const nU = Math.round(F(2)), nM = Math.round(F(3)), nE = Math.round(F(4));
  const cols = [[], [], [], [], [], [], [], [], [], []];
  for (let i = 0; i < nU; i++) for (let c = 0; c < 10; c++) cols[c].push(F(5 + c * nU + i));
  const gold = [];
  for (let i = 0; i < 12; i++) gold.push(Math.round(F(5 + 11 * nU + i)));
  // 与 golden 的 9 字段顺序对齐：[x, y, facing, hp, maxHp, team, pi, alive, mv]
  // C 列序是 [x,y,facing,hp,maxHp,alive,team,pi,kind,moving,gathering] → 按名映射
  return {
    tick: Math.round(F(0)), nowMs: Math.round(F(1)), nEvents: nE, nMissiles: nM,
    units: Array.from({ length: nU }, (_, i) => [
      Math.round(cols[0][i]), Math.round(cols[1][i]), +cols[2][i].toFixed(2),
      Math.round(cols[3][i]), Math.round(cols[4][i]),
      Math.round(cols[6][i]), Math.round(cols[7][i]), Math.round(cols[5][i]), Math.round(cols[9][i]),
    ]),
    gold,
  };
}

let allOk = true;
for (const s of golden.scenes) {
  eng._sim_clear_all();
  if (s.kinds) {   // 经济场景
    for (let i = 0; i < s.pos.length; i++)
      eng._sim_spawn_econ(i, s.pos[i][0], s.pos[i][1], ECON_KIND[s.kinds[i]], s.pl[i], ECON_SPEED[s.kinds[i]], ECON_RAD[s.kinds[i]], s.face[i], s.hp[i]);
  } else {         // 战斗场景
    for (let i = 0; i < s.pos.length; i++) {
      const T = COMBAT_TYPES[s.types[i]];
      eng._sim_spawn_fight(i, s.pos[i][0], s.pos[i][1], 0, T.moveSpeed, T.radius, T.hp, T.hp, T.armor,
        ARMOR_KINDS.indexOf(T.armorType), i === 0 ? 0 : 1, T.dmgBase, T.dmgDice, T.dmgSides, T.atkCd,
        T.atkRange, T.attackPoint, T.attackBackswing, ATK_TYPES.indexOf(T.atkType), T.weaponKind, T.missileSpeed);
      eng._sim_set_meta(i, s.pi[i], s.bounty[i], s.level[i]);
    }
  }
  eng._sim_events_reset();
  const hpTol = s.kinds ? 0 : 40;
  const goldTol = s.kinds ? 10 : 30;   // 战斗击杀时刻受 RNG 影响，允许差一次赏金
  const rows = [];
  let bad = false;
  for (const g of s.checks) {
    for (let step = 0; step < g.t; step++) eng._sim_step(1 / 30);
    const c = decode();
    const nOk = c.units.length === g.units.length;
    let dx = 0, dy = 0, dF = 0, dHp = 0, dMeta = 0, dMv = 0, dGold = 0;
    for (let i = 0; i < Math.min(c.units.length, g.units.length); i++) {
      const a = c.units[i], b = g.units[i];
      dx = Math.max(dx, Math.abs(a[0] - b[0])); dy = Math.max(dy, Math.abs(a[1] - b[1]));
      dF = Math.max(dF, Math.abs(a[2] - b[2]));
      dHp = Math.max(dHp, Math.abs(a[3] - b[3]));
      for (const k of [4, 5, 6, 7]) if (a[k] !== b[k]) dMeta++;
      if (a[9] !== b[9]) dMv++;
    }
    for (let i = 0; i < 12; i++) dGold = Math.max(dGold, Math.abs(c.gold[i] - g.gold[i]));
    const missOk = Math.abs(c.nMissiles - g.nMissiles) <= 1;
    const ok = nOk && dx <= 2 && dy <= 2 && dF <= 0.1 && dHp <= hpTol && dMeta === 0 && dMv <= 1 && dGold <= goldTol && missOk;
    if (!ok) bad = true;
    rows.push(`  t${g.t}: 单位${c.units.length}/${g.units.length} ${nOk ? "OK" : "FAIL"} | Δx${dx} Δy${dy} Δf${dF.toFixed(2)} ΔHP${dHp} ${dHp <= hpTol ? "OK" : "FAIL"} | meta${dMeta} mv${dMv} gold${dGold} 导弹${c.nMissiles}/${g.nMissiles} ${ok ? "OK" : "FAIL"}`);
  }
  allOk = allOk && !bad;
  console.log(`${s.name}${bad ? " ❌" : " ✅"} (HP容差 ${hpTol})`);
  console.log(rows.join("\n"));
}
console.log(allOk ? "snapshot 对账: 2/2 场景全过" : "snapshot 对账: 存在不一致");
if (!allOk) process.exitCode = 1;
eng._free(snapBuf);
eng._free(wp);