// econ_golden.mjs — 农民采集循环黄金锁定（M4 phase2 经济）
//
// 场景：p0 的一个 hpea 农民 + 中立 ngol 金矿 + p0 的 htow 基地。
// 农民自动找矿 → toMine → mining(1.8s) → toBase → +10 金 → 循环。
// 记录：初始微调 pos、gold 事件 tick 序列、农民轨迹抽样。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { World } from '../server/world.js';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'goldens', 'econ_trace.json');
const TICKS = 3600;   // 2 分钟（120s @30fps）

const w = new World();
// 最小 player 表（playerOf 需有效；eventId null 让 JASS 事件桥早退）
w.jass = { players: Array.from({ length: 12 }, (_, i) => ({ index: i, team: i >= 1 ? 1 : 0, gold: 0, lumber: 0 })),
  eventId: () => null, fire: () => {}, triggers: [] };
const p0 = { index: 0, team: 0 };
const n1 = { index: 2, team: 0 };

const base = w.createUnit(p0, 'htow', 1600, 1200, 180);
const mine = w.createUnit(n1, 'ngol', 1500, 1100, 0);
const peas = [];
peas.push(w.createUnit(p0, 'hpea', 1392, 1104, 0));

const pos = [base, mine, ...peas].map((u) => [Math.round(u.x), Math.round(u.y)]);
const kinds = [base, mine, ...peas].map((u) => u.typeKey);
const pl = [0, 2, 0];   // base p0 / mine n1 / pea p0
const hp = [base, mine, ...peas].map((u) => u.maxHp);
const face = [base, mine, ...peas].map((u) => u.facing);

const goldEvents = [];   // [t, gold]
const peaTrace = [];     // [t, x, y]
let prevGold = 0;
for (let t = 0; t < TICKS; t++) {
  w.step();
  const p = w.playerOf(peas[0]);
  const g = p ? p.gold : 0;
  if (g !== prevGold) { goldEvents.push([t, g]); prevGold = g; }
  if (t % 120 === 0) peaTrace.push([t, Math.round(peas[0].x), Math.round(peas[0].y)]);
}
peas[0].removed = true;   // 防 delete 后引用报错（golden 只读 pos）

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({
  world: 'terenas', dt: 1 / 30,
  scene: { pos, kinds, pl, hp, face },
  goldEvents: goldEvents,
  peaTrace,
}, null, 1));
console.log(`econ golden 已存档: ${OUT}`);
console.log(`首金 tick ${goldEvents[0]?.[0]} | 前 8 次交金:`, JSON.stringify(goldEvents.slice(0, 8)));
console.log(`农民轨迹抽样:`, JSON.stringify(peaTrace.slice(0, 6)));