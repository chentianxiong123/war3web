// tools/order_test.mjs — 命令输入通道 C/JS 逐字段对账（M4 收尾门禁）
//
// C 侧 sim_order_push + sim_flush_orders 复现 golden 的命令序列，
// 逐检查点比对单位 [x,y,facing,hp,alive,mv] 与 attack/death/bounty 事件。
// 门禁：
//   move（确定性）：Δx/Δy ≤2、Δfacing ≤0.1、ΔHP ≤0
//   attack/stop（含 RNG）：Δx/Δy ≤2、Δfacing ≤0.1、ΔHP ≤40、
//     首击 Δ≤3、攻击数 Δ≤6、死亡 tick Δ≤45、bounty 次数与金额精确
import createEngine from "../engine/out/engine.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ATK_TYPES = ["spells", "normal", "pierce", "siege", "magic", "chaos", "hero"];
const ARMOR_KINDS = ["small", "medium", "large", "fort", "normal", "hero", "divine", "none"];
const gp = JSON.parse(fs.readFileSync(path.join(HERE, "..", "data", "gameplay.json"), "utf8"));
const dt = gp.damageBonus || {};
const golden = JSON.parse(fs.readFileSync(path.join(HERE, "..", "goldens", "order_trace.json"), "utf8"));

const HFOO = { hp: 420, armor: 2, armorType: "large", dmgBase: 11, dmgDice: 1, dmgSides: 2, atkCd: 1.35, atkRange: 90, attackPoint: 0.5, attackBackswing: 0.5, atkType: "normal", weaponKind: 0, missileSpeed: 0, moveSpeed: 270, radius: 31 };
const HWAT = { hp: 525, armor: 0, armorType: "large", dmgBase: 17, dmgDice: 1, dmgSides: 5, atkCd: 1.5, atkRange: 300, attackPoint: 0.4, attackBackswing: 0.77, atkType: "pierce", weaponKind: 1, missileSpeed: 1300, moveSpeed: 220, radius: 32 };
const TYPES = { hfoo: HFOO, hwat: HWAT };
// op 字面量 → C 枚举（与 sim.c SIM_ORD_* 对齐）
const OP = { stop: 0, hold: 1, move: 2, attackMove: 3, attack: 4 };

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
const SNAPBUF = eng._malloc(65536 * 4);

// SOA 快照解码（列式布局：buf[5 + col*nU + i]，见 sim.c sim_snapshot）
// 取对账需要的列：0=x 1=y 2=facing 3=hp 5=alive 9=moving
function decode() {
  const nU = Math.round(eng.HEAPF32[(SNAPBUF >> 2) + 2]);
  const C = (col, i) => eng.HEAPF32[(SNAPBUF >> 2) + 5 + col * nU + i];
  const out = [];
  for (let i = 0; i < nU; i++)
    out.push([Math.round(C(0, i)), Math.round(C(1, i)), +C(2, i).toFixed(2),
      Math.round(C(3, i)), Math.round(C(5, i)), Math.round(C(9, i))]);
  return { units: out };
}

const spawnF = (id, x, y, team, typeKey, pi) => {
  const T = TYPES[typeKey] || HFOO;
  eng._sim_spawn_fight(id, x, y, 0, T.moveSpeed, T.radius, T.hp, T.hp, T.armor,
    ARMOR_KINDS.indexOf(T.armorType), team, T.dmgBase, T.dmgDice, T.dmgSides, T.atkCd,
    T.atkRange, T.attackPoint, T.attackBackswing, ATK_TYPES.indexOf(T.atkType), T.weaponKind, T.missileSpeed);
};

let allOk = true;
for (const s of golden.scenes) {
  eng._sim_clear_all();
  eng._sim_events_reset();
  for (let i = 0; i < s.pos.length; i++) {
    spawnF(i, s.pos[i][0], s.pos[i][1], i % 2, s.types[i]);
    eng._sim_set_meta(i, s.pl[i], s.unitBounty[i], s.level[i]);
    eng._sim_set_gives_bounty(s.pl[i], 1);   // 对齐 golden：Player 0..7 开启
  }
  // 从 golden 检查点重建命令时刻表：orders 内联在场景里
  const checks = s.checks;
  const hpTol = s.name === "move" ? 0 : 40;
  let t = 0;
  const rows = [];
  let bad = false;
  for (const check of checks) {
    while (t < check.t) {
      // 该 tick 的命令入队后 flush（JS 侧同 tick step 之前下发）
      for (const o of s.orders || []) if (o[0] === t)
        eng._sim_order_push(o[1], OP[o[2]], o[3], o[4], o[5]);
      eng._sim_flush_orders();
      eng._sim_step(1 / 30);
      t++;
    }
    // 快照解码（事件环是全量非消费式，故循环内只比单位、末次统一读事件）
    const need = eng._sim_snapshot(SNAPBUF, 65536);
    if (need > 65536) { bad = true; }
    const snap = decode();
    const g = check;
    let dx = 0, dy = 0, dF = 0, dHp = 0, dAlive = 0, dMv = 0;
    for (let i = 0; i < Math.min(snap.units.length, g.units.length); i++) {
      const a = snap.units[i], b = g.units[i];
      dx = Math.max(dx, Math.abs(a[0] - b[0])); dy = Math.max(dy, Math.abs(a[1] - b[1]));
      dF = Math.max(dF, Math.abs(a[2] - b[2])); dHp = Math.max(dHp, Math.abs(a[3] - b[3]));
      if (a[4] !== b[4]) dAlive++;
      if (a[5] !== b[5]) dMv++;
    }
    const okU = snap.units.length === g.units.length && dx <= 2 && dy <= 2 && dF <= 0.1
      && dHp <= hpTol && dAlive === 0 && dMv <= 1;
    if (!okU) bad = true;
    rows.push(`  t${g.t}: 单位${snap.units.length}/${g.units.length} Δx${dx} Δy${dy} Δf${dF.toFixed(2)} ΔHP${dHp} alive${dAlive} mv${dMv} ${okU ? "OK" : "FAIL"}`);
  }
  // 末次统一读事件环（全量非消费式，循环内读会重复累积）
  const atk = [], death = [], bounty = [];
  const n = eng._sim_events_get(EVBUF, 8192);
  for (let i = 0; i < n; i++) {
    const b = (EVBUF >> 2) + i * 4;
    const ev = [eng.HEAPF32[b], eng.HEAPF32[b + 1], eng.HEAPF32[b + 2], eng.HEAPF32[b + 3]];
    if (ev[1] === 0) atk.push(ev);
    else if (ev[1] === 2) death.push([ev[0], Math.round(ev[2])]);
    else if (ev[1] === 3) bounty.push([ev[0], Math.round(ev[2]), Math.round(ev[3])]);
  }
  const jsAtk = s.atk || [], cAtk = atk;
  const dFirst = Math.abs(cAtk[0]?.[0] - jsAtk[0]?.[0]);
  const okEv = jsAtk.length === 0
    ? true
    : dFirst <= 3 && Math.abs(cAtk.length - jsAtk.length) <= 6;
  const jsDth = s.death || [];
  const okDth = jsDth.length === 0
    ? death.length === 0
    : death.length >= 1 && Math.abs(death[0][0] - jsDth[0][0]) <= 45 && death[0][1] === jsDth[0][1];
  const jsB = s.bounty || [];
  const okB = bounty.length === jsB.length
    && bounty.every((e, i) => e[1] === jsB[i][1] && e[2] === jsB[i][2]);
  const ok = okEv && okDth && okB && !bad;
  if (!ok) allOk = false;
  console.log(`${s.name}${ok ? " ✅" : " ❌"} (HP容差 ${hpTol})`);
  console.log(rows.join("\n"));
  console.log(`  事件: attack C${cAtk.length}/JS${jsAtk.length} 首击Δ${dFirst} ${okEv ? "OK" : "FAIL"} | death C${JSON.stringify(death)} JS${JSON.stringify(jsDth)} ${okDth ? "OK" : "FAIL"} | bounty C${JSON.stringify(bounty)} JS${JSON.stringify(jsB)} ${okB ? "OK" : "FAIL"}`);
}
console.log(allOk ? "order 对账: 3/3 场景全过" : "order 对账: 存在不一致");
if (!allOk) process.exitCode = 1;
eng._free(wp); eng._free(sg); eng._free(EVBUF); eng._free(SNAPBUF);
