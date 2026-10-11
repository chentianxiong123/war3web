// tools/sim_step_test.mjs — M4 phase2 收尾：sim_step 全量 tick + 事件桥对照
// 门禁：sim_step 跑战斗场景的死亡/攻击与 sim_combat_step 一致；
//      事件桥 attack/missileEnd/death 与 golden atkEvents/deaths 时序对齐。
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
const HFOO = { hp: 420, armor: 2, armorType: "large", dmgBase: 11, dmgDice: 1, dmgSides: 2, atkCd: 1.35, atkRange: 90, attackPoint: 0.5, attackBackswing: 0.5, atkType: "normal", weaponKind: 0, missileSpeed: 0, moveSpeed: 270, radius: 31 };
const HWAT = { hp: 525, armor: 0, armorType: "large", dmgBase: 17, dmgDice: 1, dmgSides: 5, atkCd: 1.5, atkRange: 300, attackPoint: 0.4, attackBackswing: 0.77, atkType: "pierce", weaponKind: 1, missileSpeed: 1300, moveSpeed: 220, radius: 32 };
const TYPES = { hfoo: HFOO, hwat: HWAT };
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
const EVBUF = eng._malloc(8192 * 4 * 4);
const spawnF = (id, x, y, team, typeKey) => {
  const T = TYPES[typeKey] || HFOO;
  eng._sim_spawn_fight(id, x, y, 0, T.moveSpeed, T.radius, T.hp, T.hp, T.armor, ARMOR_KINDS.indexOf(T.armorType), team, T.dmgBase, T.dmgDice, T.dmgSides, T.atkCd, T.atkRange, T.attackPoint, T.attackBackswing, ATK_TYPES.indexOf(T.atkType), T.weaponKind, T.missileSpeed);
};
let allOk = true;
for (const s of golden.scenes) {
  eng._sim_clear_all();
  const list = s.pos;
  const types = s.types || ["hfoo", "hfoo"];
  for (let i = 0; i < list.length; i++) spawnF(i, list[i][0], list[i][1], i === 0 ? 0 : 1, types[i]);
  eng._sim_events_reset();
  let cDeath = null;
  for (let t = 0; t < 120 * 30; t++) {
    eng._sim_step(1 / 30);   // 全量 tick（gather + missiles + 单位循环）
    const allAlive = [];
    for (let i = 0; i < list.length; i++) { eng._sim_get_fight(i, sg); allAlive.push(eng.HEAPF32[(sg >> 2) + 5] > 0.5); }
    if (cDeath == null && allAlive.some((v) => !v)) cDeath = t;
    if (cDeath != null && allAlive.every((v) => !v)) break;
  }
  const n = eng._sim_events_get(EVBUF, 8192);
  const evs = [];
  for (let i = 0; i < n; i++) {
    const b = (EVBUF >> 2) + i * 4;
    evs.push([eng.HEAPF32[b], eng.HEAPF32[b + 1], eng.HEAPF32[b + 2], eng.HEAPF32[b + 3]]);
  }
  const cAtk = evs.filter((e) => e[1] === 0);
  const cMiss = evs.filter((e) => e[1] === 1);
  const cDth = evs.filter((e) => e[1] === 2);
  const jsAtk = s.atkEvents.filter((e) => e[1] !== "missileEnd");
  const jsMiss = s.atkEvents.filter((e) => e[1] === "missileEnd");
  const dDeath = Math.abs(cDeath - s.deathTick);
  const dFirstAtk = Math.abs(cAtk[0]?.[0] - jsAtk[0]?.[0]);
  const okAtk = dFirstAtk <= 3 && Math.abs(cAtk.length - jsAtk.length) <= 6;
  const okMiss = Math.abs(cMiss.length - jsMiss.length) <= 3;
  const okDth = cDth.length >= 1 && Math.abs(cDth[0][0] - s.deathTick) <= 45;
  const ok = dDeath <= 45 && okAtk && okMiss && okDth;
  if (!ok) allOk = false;
  console.log(`${s.name}: 死亡 C${cDeath}/JS${s.deathTick}(Δ${dDeath}) | attack C${cAtk.length}/JS${jsAtk.length} 首击Δ${dFirstAtk} | missileEnd C${cMiss.length}/JS${jsMiss.length} | death C${cDth.length} 首个t${cDth[0]?.[0]} | ${ok ? "OK" : "FAIL"}`);
}
console.log(allOk ? "sim_step + 事件桥: 4/4 场景全过" : "sim_step + 事件桥: 存在不一致");
if (!allOk) process.exitCode = 1;
eng._free(wp);
eng._free(sg);
eng._free(EVBUF);