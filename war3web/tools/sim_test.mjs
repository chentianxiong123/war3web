// tools/sim_test.mjs — M4 阶段1 门禁：C sim.c 寻路 vs JS pathing.js Grid 对照
//
// 同一份 walk.bin + 相同网格参数 + 相同起终点，比较
//   - 路径段数（string-pull 后）
//   - 每段终点坐标（世界坐标，容差 < 0.5）
// 场景 = tools/path_golden.mjs 的 5 个（已实测可达）。
//
// 用法：node tools/sim_test.mjs

import createEngine from "../engine/out/engine.mjs";
import { Grid } from "../server/pathing.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

// 网格参数：terrain.json offset ±6144；walk.bin 147456 字节 = 384²
const W = 384, H = 384, OX = -6144, OY = -6144;
const walkArr = new Uint8Array(fs.readFileSync(path.join(ROOT, "public/data/walk.bin")));

const scenes = [
  [1152, 1088, 1500, 1500],
  [1856, 2624, 2200, 2400],
  [1856, 2624, 1700, 2800],
  [1472, 1216, 1900, 1400],
  [1856, 2624, 2200, 2700],
];

const eng = await createEngine();

// ---- C 侧：网格装入 wasm heap ----
const walkPtr = eng._malloc(walkArr.length);
eng.HEAPU8.set(walkArr, walkPtr);
eng._sim_grid_init(walkPtr, W, H, OX, OY);
const outPtr = eng._malloc(256 * 2 * 4);   // 最多 256 个路径点（float2）

function cPath(sx, sy, tx, ty) {
  const n = eng._sim_find_path(sx, sy, tx, ty, outPtr, 256);
  if (n < 0) return null;
  const pts = [];
  for (let i = 0; i < n; i++) pts.push([eng.HEAPF32[(outPtr >> 2) + 2 * i], eng.HEAPF32[(outPtr >> 2) + 2 * i + 1]]);
  return pts;
}

// ---- JS 侧：同一 Grid 同一参数 ----
const jsGrid = new Grid(walkArr, W, H, OX, OY);

let pass = 0, fail = 0;
for (let s = 0; s < scenes.length; s++) {
  const [sx, sy, tx, ty] = scenes[s];
  const jsP = jsGrid.path(sx, sy, tx, ty);
  const cP = cPath(sx, sy, tx, ty);
  const jsLen = jsP ? jsP.length : -1;
  const cLen = cP ? cP.length : -1;
  let ok = jsLen === cLen;
  if (ok && jsP) {
    for (let i = 0; i < jsLen; i++) {
      const d = Math.hypot(jsP[i][0] - cP[i][0], jsP[i][1] - cP[i][1]);
      if (d > 0.5) { ok = false; break; }
    }
  }
  if (ok) { pass++; console.log(`场景${s + 1} (${sx},${sy})->(${tx},${ty}): OK 段数 ${jsLen} C/JS 一致`); }
  else {
    fail++;
    console.log(`场景${s + 1} (${sx},${sy})->(${tx},${ty}): FAIL JS 段数 ${jsLen} C 段数 ${cLen}`);
    console.log('  JS:', JSON.stringify(jsP?.map((p) => [Math.round(p[0]), Math.round(p[1])])));
    console.log('  C :', JSON.stringify(cP?.map((p) => [Math.round(p[0]), Math.round(p[1])])));
  }
}

eng._free(outPtr);

console.log(`\nsim_test: ${pass}/${scenes.length} 场景 C/JS 寻路一致`);
process.exitCode = fail ? 1 : 0;


// ---- M4 阶段1 端到端：C 移动推进 vs golden（到达耗时/路径长度/终点）----
import { World } from "../server/world.js";
const golden = JSON.parse(fs.readFileSync(path.join(ROOT, "goldens/path_trace.json"), "utf8"));
const wv = new World();
const probe = wv.createUnit({ index: 0, team: 0 }, "hpea", 1152, 1088, 0);
const SPEED = probe.moveSpeed, RADIUS = probe.radius, TURN = probe.turnRate ?? 0.6;
const outState = eng._malloc(6 * 8);

let mvPass = 0, mvFail = 0;
for (const r of golden.runs) {
  const [sx, sy] = r.from, [tx, ty] = r.to;
  const rc = eng._sim_run_move(sx, sy, tx, ty, RADIUS, SPEED, TURN, 1 / 30, 45 * 30, outState);
  const st = [];
  for (let i = 0; i < 6; i++) st.push(eng.HEAPF32[(outState >> 2) + i]);
  const got = { arriveTick: st[0], pathLen: st[1], end: [st[2], st[3]], endErr: st[4] };
  const jsArrive = Math.round((r.arriveSec ?? 45) * 30);
  const dtick = Math.abs(got.arriveTick - jsArrive);
  const dlen = r.arrivePathLen ? Math.abs(got.pathLen - r.arrivePathLen) / r.arrivePathLen : 1;
  const ok = got.arriveTick >= 0 && dtick <= 6 && dlen <= 0.03 && got.endErr <= r.arriveEndErr + 5;
  if (ok) { mvPass++; console.log(`golden场景 (${sx},${sy})->(${tx},${ty}): OK C到达 ${got.arriveTick}tick(${+(got.arriveTick/30).toFixed(2)}s) JS ${r.arriveSec}s | 路径 ${got.pathLen.toFixed(1)} vs ${r.arrivePathLen} | endErr ${got.endErr.toFixed(1)}`); }
  else { mvFail++; console.log(`golden场景 (${sx},${sy})->(${tx},${ty}): FAIL C到达 ${got.arriveTick} JS ${r.arriveSec}s C路径 ${got.pathLen.toFixed(1)} JS ${r.arrivePathLen} C endErr ${got.endErr.toFixed(1)}`); }
}
eng._free(outState);
console.log(`\nsim_move vs golden: ${mvPass}/${golden.runs.length} 到达行为一致`);
if (mvFail) process.exitCode = 1;

// ---- M4 阶段1 多单位碰撞对照：hold 挡路 + 移动单位绕行 ----
const w2 = new World();
const ph2 = { index: 0, team: 0 };
const a2 = w2.createUnit(ph2, "hpea", 1232, 1040, 0);
const b2 = w2.createUnit(ph2, "hpea", 1152, 1040, 0);
const aSpawn = [a2.x, a2.y], bSpawn = [b2.x, b2.y];   // spawn 后初始位置（freeSpotNear 微调后）
w2.order(a2, { type: "hold" });
w2.order(b2, { type: "move", x: 1500, y: 1500 });
const jsSegs = b2.path?.length ?? -1;
let jsArrive2 = null;
for (let t = 0; t < 45 * 30; t++) {
  w2.step();
  if (jsArrive2 == null && Math.hypot(b2.x - 1500, b2.y - 1500) < 40) jsArrive2 = t;
}
eng._sim_clear_all();
eng._sim_spawn(0, aSpawn[0], aSpawn[1], 0, SPEED, RADIUS, 0, 0);   // hold 挡路（spawn 位置）
eng._sim_spawn(1, bSpawn[0], bSpawn[1], 0, SPEED, RADIUS, 0, 0);
eng._sim_order_move(1, 1500, 1500);
const sg = eng._malloc(4 * 4);
eng._sim_get(1, sg);
const cSegs = eng.HEAPF32[(sg >> 2) + 3];
let cArrive2 = null;
for (let t = 0; t < 45 * 30; t++) {
  eng._sim_tick(1 / 30);
  eng._sim_get(1, sg);
  const bx = eng.HEAPF32[sg >> 2], by = eng.HEAPF32[(sg >> 2) + 1];
  if (cArrive2 == null && Math.hypot(bx - 1500, by - 1500) < 40) cArrive2 = t;
}
eng._sim_get(1, sg);
const cEnd = [eng.HEAPF32[sg >> 2], eng.HEAPF32[(sg >> 2) + 1]];
eng._free(sg);
const segOk = cSegs === jsSegs;
const dtick2 = Math.abs((cArrive2 ?? 45 * 30) - (jsArrive2 ?? 45 * 30));
const posOk = Math.hypot(cEnd[0] - b2.x, cEnd[1] - b2.y) <= 8;
const ok2 = segOk && dtick2 <= 6 && posOk;
console.log(`碰撞场景 (hold 挡路 + 绕行): ${ok2 ? "OK" : "FAIL"} 路径段数 C ${cSegs} vs JS ${jsSegs} | 到达 tick C ${cArrive2} vs JS ${jsArrive2} | 终位 C [${Math.round(cEnd[0])},${Math.round(cEnd[1])}] vs JS [${Math.round(b2.x)},${Math.round(b2.y)}]`);
if (!ok2) process.exitCode = 1;

eng._free(walkPtr);


