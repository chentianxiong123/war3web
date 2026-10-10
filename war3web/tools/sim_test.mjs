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

eng._free(walkPtr); eng._free(outPtr);

console.log(`\nsim_test: ${pass}/${scenes.length} 场景 C/JS 寻路一致`);
process.exitCode = fail ? 1 : 0;

