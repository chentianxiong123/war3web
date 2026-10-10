// tools/path_golden.mjs — M4 阶段1 行为锁定：JS 寻路/移动黄金基准生成器
//
// 用途：在真实 Terenas 地图数据上，给若干单位下达移动命令，记录
//   - 到达耗时（tick）
//   - 实际路径长度（每 tick 采样位移累计）
//   - 终点坐标与误差
// 输出 goldens/path_trace.json 存档；后续 C 模拟核心移植后，同场景
// 用 C 复跑，按 到达耗时/路径长度/终点误差 容差对照（结果导向，规避
// 模拟内随机对逐 tick 轨迹的影响）。
//
// 用法：node tools/path_golden.mjs [秒数]

import { World } from '../server/world.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'goldens', 'path_trace.json');

const SECONDS = Number(process.argv[2] || 45);
const TICKS = SECONDS * 30;                 // world.dt = 1/30

// 场景：五个陆行单位（农民）——坐标经实测全部可达（endErr<=40 门禁）
// 混合直线与绕行段（movementPath 段数 1-4）
// 每场景独立 World（单单位）：锁定"单单位寻路/移动"行为（碰撞另测）
const runs = [
  { type: 'hpea', x: 1152, y: 1088, tx: 1500, ty: 1500 },   // 直线短程
  { type: 'hpea', x: 1856, y: 2624, tx: 2200, ty: 2400 },   // 西南区斜穿
  { type: 'hpea', x: 1856, y: 2624, tx: 1700, ty: 2800 },   // 短斜穿
  { type: 'hpea', x: 1472, y: 1216, tx: 1900, ty: 1400 },   // 出生区东移
  { type: 'hpea', x: 1856, y: 2624, tx: 2200, ty: 2700 },   // 长斜穿
];

const allRuns = [];
for (const r of runs) {
  const w = new World();
  const ph = { index: 0, team: 0 };
  const u = w.createUnit(ph, r.type, r.x, r.y, 0);
  const start = [u.x, u.y];
  w.order(u, { type: 'move', x: r.tx, y: r.ty });

  let arriveTick = null;
  let pathLen = 0;
  let prev = [u.x, u.y];
  const samples = [];
  for (let t = 0; t < TICKS; t++) {
    w.step();
    if (t % 10 === 0) samples.push({ t, pos: [Math.round(u.x), Math.round(u.y)] });
    const dx = u.x - prev[0], dy = u.y - prev[1];
    pathLen += Math.sqrt(dx * dx + dy * dy);
    prev = [u.x, u.y];
    if (arriveTick == null && Math.hypot(u.x - r.tx, u.y - r.ty) < 40) arriveTick = t;
  }
  allRuns.push({
    from: start, to: [r.tx, r.ty],
    arriveTick,
    arriveSec: arriveTick == null ? null : +(arriveTick / 30).toFixed(2),
    pathLen: +pathLen.toFixed(1),
    end: [Math.round(u.x), Math.round(u.y)],
    endErr: +Math.hypot(u.x - r.tx, u.y - r.ty).toFixed(1),
    samples,
  });
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const payload = { world: 'terenas', dt: 1 / 30, seconds: SECONDS, runs: allRuns.map(({ samples, ...r }) => r) };
fs.writeFileSync(OUT, JSON.stringify(payload, null, 1));
console.log(JSON.stringify({ meta: { seconds: SECONDS, ticks: TICKS }, runs: allRuns.map(({ samples, ...r }) => r) }, null, 1));
console.log('golden 已存档:', OUT);
// 场景有效性门禁：黄金基准必须全部到达（endErr<=40），否则 C 移植后
// 无从对照"到达"语义
const bad = allRuns.filter((r) => r.endErr > 40);
if (bad.length) {
  console.error('FAIL: ' + bad.length + ' 个场景未到达（endErr>40）——换坐标重试');
  process.exit(1);
}
console.log('OK: 全部场景到达，golden 基准有效');
