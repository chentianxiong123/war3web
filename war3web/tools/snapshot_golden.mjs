// snapshot_golden.mjs — SOA 快照黄金锁定（M4 阶段 3）
//
// 在 JS World 里跑「经济采集」与「远程战斗」两个场景，在若干检查点记录
// snapshot() 的可比子集（与 JS wire snapshot 同规则取整）：
//   units[i] = [x, y, facing(2位), hp, maxHp, team, pi, alive, mv]
//   gold[12] / nMissiles
// 输出 goldens/snapshot_trace.json。C 侧 sim_snapshot 同布局产出后逐字段对账。
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { World } from '../server/world.js';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'goldens', 'snapshot_trace.json');

// 检查点 tick（0-based，step 之后的第 t 拍）
const CHECKS = [1, 60, 180, 360, 600];

function entFields(u, w) {
  return [Math.round(u.x), Math.round(u.y), +u.facing.toFixed(2),
    Math.round(u.hp), Math.round(u.maxHp), u.team, u.playerIndex,
    u.alive ? 1 : 0, u.path ? 1 : 0];
}

function snapAt(w) {
  const ents = [];
  for (const u of w.units.values()) {
    if (u.hidden || u.removed || u.pickerProp) continue;
    if (w.isDummy(u)) continue;
    ents.push(entFields(u, w));
  }
  return {
    units: ents,
    gold: Array.from({ length: 12 }, (_, i) => w.playerRes(i).gold || 0),
    nMissiles: w.missiles.length,
  };
}

function runScene(name, build) {
  const w = new World();
  // 最小 player 表（playerOf 需有效；eventId null 让 JASS 事件桥早退）
  w.jass = { players: Array.from({ length: 12 }, (_, i) => ({ index: i, team: i >= 1 ? 1 : 0, gold: 0, lumber: 0 })),
    eventId: () => null, fire: () => {}, triggers: [] };
  const info = build(w);
  const checks = [];
  for (const t of CHECKS) {
    // 推进到检查点
    for (let step = 0; step < t; step++) w.step();
    checks.push({ t, ...snapAt(w) });
  }
  return { name, ...info, checks };
}

const runs = [];

// 场景 1：经济采集（确定性强，无 RNG）
runs.push(runScene('econ', (w) => {
  const p0 = { index: 0, team: 0 };
  const n1 = { index: 2, team: 0 };
  const base = w.createUnit(p0, 'htow', 1600, 1200, 180);
  const mine = w.createUnit(n1, 'ngol', 1500, 1100, 0);
  const peas = [w.createUnit(p0, 'hpea', 1392, 1104, 0)];
  const list = [base, mine, ...peas];
  return {
    pos: list.map((u) => [Math.round(u.x), Math.round(u.y)]),
    kinds: list.map((u) => u.typeKey),
    pl: list.map((u) => u.playerIndex),
    team: list.map((u) => u.team),
    hp: list.map((u) => u.maxHp),
    face: list.map((u) => u.facing),
  };
}));

// 场景 2：远程哨兵 vs 近战（含导弹/攻击/死亡）
runs.push(runScene('ranged_hwat', (w) => {
  const p0 = { index: 0, team: 0 };
  const p1 = { index: 1, team: 1 };
  const u0 = w.createUnit(p0, 'hwat', 1300, 1100, 0);
  const u1 = w.createUnit(p1, 'hfoo', 1700, 1100, 0);
  const list = [u0, u1];
  return {
    pos: list.map((u) => [Math.round(u.x), Math.round(u.y)]),
    types: list.map((u) => u.typeKey),
    pi: list.map((u) => u.playerIndex),
    bounty: list.map((u) => u.bounty || 0),
    level: list.map((u) => u.level || 0),
  };
}));

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ world: 'terenas', dt: 1 / 30, scenes: runs }, null, 1));
console.log(`snapshot golden 已存档: ${OUT}`);
for (const r of runs) {
  console.log(`  ${r.name}: pos=${JSON.stringify(r.pos)} 检查点 ${r.checks.map((c) => `${c.t}:U${c.units.length}/M${c.nMissiles}`).join(' ')}`);
}