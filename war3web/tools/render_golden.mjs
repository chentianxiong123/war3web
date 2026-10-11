// tools/render_golden.mjs — 快照驱动渲染黄金锁定（M4 收尾）
//
// 记录 JS world.snapshot() 的 ents 输出，供 C 侧 sim_snapshot 经适配层
// （tools/snaprender_test.mjs）对账——验证 SOA 快照足以驱动渲染。
//
// 适配层能拿到的（C 快照列 0-14）：x y f t p a h H m M l mv
// 需 JS 侧按槽位回查（本文件录 slots 表）：i（JS 单位 id）u（typeKey）k sel
// JS 专属、C 快照拿不到（渲染缺口，见 docs §2.13）：
//   b（buff 模型）bld（建造进度）q（命令队列长度）ab（可施法列表）
//   items / clock / quests / res（世界级字段）
//
// 用法：node tools/render_golden.mjs

import { World } from '../server/world.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'goldens', 'render_trace.json');

const scenes = [
  // 与 snapshot_golden 同一场景设置（金矿属中立玩家 2 但 team 0，与玩家队同侧）
  { name: 'econ', spawns: [['htow', 1600, 1200, 180, 0, 0], ['ngol', 1500, 1100, 0, 2, 0],
    ['hpea', 1392, 1104, 0, 0, 0]], checks: [1, 60, 180, 360, 600] },
  { name: 'ranged_hwat', spawns: [['hwat', 1300, 1100, 0, 0, 0], ['hfoo', 1700, 1100, 0, 1, 1]],
    checks: [1, 60, 180, 360, 600] },
];

const runs = [];
for (const s of scenes) {
  const w = new World();
  w.jass = { players: Array.from({ length: 12 }, (_, i) => ({
    index: i, team: i >= 1 ? 1 : 0, gold: 0, lumber: 0 })),
    eventId: () => null, fire: () => {}, triggers: [] };
  const units = s.spawns.map(([type, x, y, face, pi, team]) => {
    const p = { index: pi, team };
    return w.createUnit(p, type, x, y, face);
  });
  // —— 初态必须在步进前捕获（步进后 units 已经移动）——
  const pos = units.map((u) => [Math.round(u.x), Math.round(u.y)]);
  const kinds = units.map((u) => u.typeKey);
  const pl = units.map((u) => u.playerIndex);
  const team = units.map((u) => u.team);
  const hp = units.map((u) => u.maxHp);
  const face = units.map((u) => u.facing);
  // 类型注册表（客户端 findMeta 的等价物）：按槽位（=wasm 槽位，spawn 序）
  const slots = units.map((u) => ({ id: u.id, u: u.typeKey,
    k: u.isHero ? 1 : u.isBuilding ? 3 : 2, sel: !w.isLocust(u) }));
  const colors = Array.from({ length: 12 }, (_, i) => w.playerColorOf({ playerIndex: i }));
  const checks = [];
  let t = 0;
  for (const c of s.checks) {
    while (t < c) { w.step(); t++; }
    checks.push({ t, ents: w.snapshot().ents.map((e) => ({
      i: e.i, k: e.k, u: e.u, x: e.x, y: e.y, f: e.f, t: e.t, p: e.p, c: e.c,
      a: e.a, sel: e.sel, h: e.h, H: e.H, m: e.m, M: e.M, l: e.l, mv: e.mv,
    })) });
  }
  runs.push({ name: s.name, pos, kinds, pl, team, hp, face,
    bounty: units.map((u) => u.bounty || 0), level: units.map((u) => u.level || 0),
    mana: units.map((u) => [u.mana || 0, u.maxMana || 0]),
    slots, colors, checks });
  console.log(`${s.name}: ${units.length} 单位 slots=${JSON.stringify(slots.map((s) => s.u))}`
    + ` ents@t1=${checks[0].ents.length}`);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ world: 'terenas', dt: 1 / 30, scenes: runs }, null, 1));
console.log('render golden 已存档:', OUT);
