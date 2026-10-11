// tools/order_golden.mjs — 命令输入通道黄金锁定（M4 收尾）
//
// 三种命令路径：
//   move    — 单 hfoo 收到移动命令，检查点采轨迹
//   attack  — hwat/hfoo 显式 attack 指定目标（不走自动获取）+ 击杀赏金
//   stop    — 追击途中给 hfoo 下 stop，验证中断
// 每个检查点记录 units [x, y, facing, hp, alive, mv] 与累计 attack/death/bounty 事件。
// 输出 goldens/order_trace.json；C 侧 tools/order_test.mjs 用
// sim_order_push + sim_flush_orders 复现并逐字段对账。
//
// 用法：node tools/order_golden.mjs

import { World } from '../server/world.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'goldens', 'order_trace.json');

const scenes = [
  {
    name: 'move',
    spawns: [['hfoo', 1300, 1100]],
    orders: [[0, 0, 'move', 1700, 1400, -1]],
    checks: [30, 60, 120, 180, 300],
  },
  {
    name: 'attack',
    spawns: [['hwat', 1300, 1100], ['hfoo', 1700, 1100]],
    orders: [[0, 0, 'attack', -1, -1, 1], [0, 1, 'attack', -1, -1, 0]],
    checks: [30, 60, 180, 360, 600, 1200],
  },
  {
    name: 'stop',
    spawns: [['hwat', 1300, 1100], ['hfoo', 1700, 1100]],
    orders: [[30, 1, 'stop', -1, -1, -1]],
    checks: [1, 30, 60, 180, 360, 600, 1200],
  },
];

const runs = [];
for (const s of scenes) {
  const w = new World();
  // 最小 player 表（同 combat_golden）；givesBounty 对齐地图 init 给 Player 0..7
  w.jass = { players: Array.from({ length: 12 }, (_, i) => ({
    index: i, team: i >= 1 ? 1 : 0, gold: 0, lumber: 0, givesBounty: i < 8 })),
    eventId: () => null, fire: () => {}, triggers: [] };
  const players = [0, 1, 0, 1];
  const units = s.spawns.map(([type, x, y], i) =>
    w.createUnit({ index: players[i], team: players[i] }, type, x, y, 0));
  const pos = units.map((u) => [Math.round(u.x), Math.round(u.y)]);
  const atk = [], death = [], bounty = [];
  const seenDeath = new Set();
  let t = 0;
  const apply = (o) => {
    const u = units[o[1]];
    if (!u || !u.alive) return;
    if (o[2] === 'attack') w.order(u, { type: 'attack', target: units[o[5]] });
    else if (o[2] === 'stop') w.order(u, { type: 'stop' });
    else w.order(u, { type: o[2], x: o[3], y: o[4] });
  };
  const record = () => {
    runs[_i].checks.push({
      t,
      units: units.map((u) => [Math.round(u.x), Math.round(u.y), +u.facing.toFixed(2),
        Math.round(u.hp), u.alive ? 1 : 0, u.path ? 1 : 0]),
    });
  };
  const _i = runs.length;
  runs.push({ name: s.name, pos, types: units.map((u) => u.typeKey),
    pl: units.map((u) => u.playerIndex),
    unitBounty: units.map((u) => u.bounty || 0), level: units.map((u) => u.level || 0),
    orders: s.orders, checks: [] });
  for (const check of s.checks) {
    while (t < check) {
      for (const o of s.orders) if (o[0] === t) apply(o);
      const evs = w.step();
      for (const e of evs) {
        if (e.t === 'attack') atk.push([t, e.id, e.target]);
        else if (e.t === 'bounty') bounty.push([t, e.player, e.gold]);
      }
      for (let i = 0; i < units.length; i++)
        if (!units[i].alive && !seenDeath.has(i)) { seenDeath.add(i); death.push([t, i]); }
      t++;
    }
    record();
  }
  runs[_i].atk = atk.slice(0, 200);
  runs[_i].nAtk = atk.length;
  runs[_i].death = death.slice(0, 8);
  runs[_i].bounty = bounty.slice(0, 8);
  console.log(`${s.name}: pos=${JSON.stringify(pos)} atk=${atk.length} death=${JSON.stringify(death)} bounty=${JSON.stringify(bounty)}`);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ world: 'terenas', dt: 1 / 30, scenes: runs }, null, 1));
console.log('order golden 已存档:', OUT);
