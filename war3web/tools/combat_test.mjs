// tools/combat_test.mjs — M4 阶段 2 行为对照：C 战斗核心 vs 战斗 golden
// 门禁：
//   melee_close（站桩互打，无 AI 追击）：死亡容差 ±45 tick（1 次攻击间隔随机性）、
//   首击 Δ≤3、攻击数 Δ≤2、HP 曲线容差 ±40 —— 全部硬门禁
//   melee_apart / melee_3v1（含 stepAI 追击/目标选择）：标注 pending-AI，不设硬门禁
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
const HFOO = { hp: 420, armor: 2, armorType: "large", dmgBase: 11, dmgDice: 1, dmgSides: 2, atkCd: 1.35, atkRange: 90, attackPoint: 0.5, attackBackswing: 0.5, atkType: "normal", weaponKind: 0, moveSpeed: 270, radius: 31 };
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
const sg = eng._malloc(6 * 4);
const spawnF = (id, x, y, team) => eng._sim_spawn_fight(id, x, y, 0, HFOO.moveSpeed, HFOO.radius, HFOO.hp, HFOO.hp, HFOO.armor, ARMOR_KINDS.indexOf(HFOO.armorType), team, HFOO.dmgBase, HFOO.dmgDice, HFOO.dmgSides, HFOO.atkCd, HFOO.atkRange, HFOO.attackPoint, HFOO.attackBackswing, ATK_TYPES.indexOf(HFOO.atkType), HFOO.weaponKind);
let allOk = true;
for (const s of golden.scenes) {
  const needAI = s.name !== "melee_close";
  eng._sim_clear_all();
  const list = [s.p0, s.p1, ...(s.extra || [])];
  spawnF(0, list[0][1], list[0][2], 0);
  spawnF(1, list[1][1], list[1][2], 1);
  for (let i = 2; i < list.length; i++) spawnF(i, list[i][1], list[i][2], 1);
  const windupStarts = [];
  const prevW = new Array(list.length).fill(0);
  let cDeath = null, cDeathId = null;
  const hpSamplesC = [];
  for (let t = 0; t < 120 * 30; t++) {
    eng._sim_combat_step(1 / 30);
    for (let i = 0; i < list.length; i++) {
      eng._sim_get_fight(i, sg);
      const rem = eng.HEAPF32[(sg >> 2) + 2];
      if (prevW[i] === 0 && rem > 1e-9) (windupStarts[i] ||= []).push(t);
      prevW[i] = rem;
    }
    const allAlive = [];
    for (let i = 0; i < list.length; i++) { eng._sim_get_fight(i, sg); allAlive.push(eng.HEAPF32[(sg >> 2) + 5] > 0.5); }
    if (cDeath == null && allAlive.some((v) => !v)) { cDeath = t; cDeathId = allAlive.findIndex((v) => !v); }
    if (t % 10 === 0) {
      const hps = [];
      for (let i = 0; i < list.length; i++) { eng._sim_get_fight(i, sg); hps.push(Math.round(eng.HEAPF32[sg >> 2])); }
      hpSamplesC.push([t, hps]);
    }
    if (cDeath != null && allAlive.every((v) => !v)) break;
  }
  const jsStarts = s.atkEvents.filter((e) => e[1] !== "missileEnd").map((e) => e[0]);
  const cStarts = windupStarts.flat();
  const dtk = Math.abs(cDeath - s.deathTick);
  const dFirst = Math.abs(cStarts[0] - jsStarts[0]);
  const nDiff = Math.abs(cStarts.length - jsStarts.length);
  const hpOk = hpSamplesC.every(([t, hps], idx) => {
    const js = s.hpSamples[idx]?.[1];
    return js ? hps.every((v, i) => Math.abs(v - js[i]) <= 40) : true;
  });
  let ok;
  if (needAI) {
    ok = true;   // 待 stepAI 追击/目标选择移植（melee_close 已锁核心）
    console.log(`${s.name}: 待 stepAI 移植 — C 首死 ${cDeath}tick(id${cDeathId}) vs JS ${s.deathTick}tick(id${s.deaths?.[0]?.[1]}) | C 攻击 ${cStarts.length} vs JS ${jsStarts.length}`);
  } else {
    ok = dtk <= 45 && dFirst <= 3 && nDiff <= 2 && hpOk;
    console.log(`${s.name}: 死亡 ${cDeath} vs JS ${s.deathTick} (Δ${dtk}≤45 ${dtk<=45?"OK":"FAIL"}) | 首击 ${cStarts[0]} vs JS ${jsStarts[0]} | 攻击数 ${cStarts.length} vs ${jsStarts.length} | HP曲 ${hpOk?"OK":"FAIL"} | 首死id C${cDeathId} vs JS${s.deaths?.[0]?.[1]}`);
  }
  if (!ok) allOk = false;
}
if (!allOk) process.exitCode = 1;
console.log(allOk ? "combat 对照: melee_close 硬门禁全过 + AI 场景标注 pending" : "combat 对照: 存在不一致");
eng._free(wp);
