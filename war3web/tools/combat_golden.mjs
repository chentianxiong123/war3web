// tools/combat_golden.mjs — M4 阶段 2 行为锁定：战斗黄金基准生成器
//
// 敌对单位对打，记录（真实 Terenas 数据 + world.js 全量行为）：
//   - 攻击事件时序（tick / attackerId / targetId）
//   - 死亡 tick
//   - HP 曲线（每 10 tick 采样）
// 输出 goldens/combat_trace.json。C 战斗移植后同场景对照（攻击序列/死亡 tick）。
//
// 用法：node tools/combat_golden.mjs

import { World } from '../server/world.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'goldens', 'combat_trace.json');
const TICKS = 120 * 30;

const scenes = [
  { name: 'melee_close', p0: ['hfoo', 1300, 1100], p1: ['hfoo', 1400, 1100] },   // 近战贴身
  { name: 'melee_apart', p0: ['hfoo', 1300, 1100], p1: ['hfoo', 1750, 1100] },   // 近战需走近
  { name: 'melee_3v1', p0: ['hfoo', 1300, 1100], p1: ['hfoo', 1750, 1100],
    extra: [['hfoo', 1350, 1150], ['hfoo', 1400, 1050]] },                       // 3v1 围攻
];

const runs = [];
for (const s of scenes) {
  const w = new World();
  const p0 = { index: 0, team: 0 };
  const p1 = { index: 1, team: 1 };
  const units = [];
  units.push(w.createUnit(p0, s.p0[0], s.p0[1], 0));
  units.push(w.createUnit(p1, s.p1[0], s.p1[1], 0));
  for (const [type, x, y] of s.extra || []) units.push(w.createUnit(p1, type, x, y, 0));
  const atkEvents = [];
  const hpSamples = [];
  let deathTick = null;
  const deaths = [];
  for (let t = 0; t < TICKS; t++) {
    const evs = w.step();
    for (const e of evs) {
      if (e.t === 'attack') atkEvents.push([t, e.id, e.target]);
      else if (e.t === 'missileEnd') atkEvents.push([t, 'missileEnd', e.fx]);
    }
    if (t % 10 === 0) hpSamples.push([t, units.map((u) => Math.round(u.hp))]);
    for (let i = 0; i < units.length; i++) if (!units[i].alive && !deaths.some((d) => d[1] === i)) deaths.push([t, i]);
    if (deathTick == null && deaths.length) deathTick = t;
    if (deathTick != null && units.every((u) => !u.alive)) break;
  }
  runs.push({
    p0: s.p0, p1: s.p1, extra: s.extra,
    name: s.name,
    nUnits: units.length,
    hp: units.map((u) => Math.round(u.maxHp)),
    deathTick,
    deaths: deaths.slice(0, 8),
    atkEvents: atkEvents.slice(0, 120),
    nAtk: atkEvents.length,
    hpSamples: hpSamples.slice(0, 120),
  });
  console.log(`${s.name}: 死亡 tick ${deathTick} | 攻击事件 ${atkEvents.length} | 首 5 攻击:`, JSON.stringify(atkEvents.slice(0, 5)));
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ world: 'terenas', dt: 1 / 30, scenes: runs }, null, 1));
console.log('combat golden 已存档:', OUT);




