// 构建 wasm/src/core.c → wasm/out/war3core.wasm。
// 主线：Emscripten（emcc，产出 war3core.mjs + war3core.wasm，MODULARIZE 导出 createWar3Core）。
// 保底：zig cc（裸 wasm，无 JS glue）——emcc 不可用时自动回退。
// emcc 路径：环境变量 EMCC 优先，其次常用安装位置，最后 PATH。
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'wasm', 'src', 'core.c');
const OUT_DIR = path.join(ROOT, 'wasm', 'out');

function findEmcc() {
  if (process.env.EMCC) return process.env.EMCC;
  const candidates = [
    'C:\\Users\\a1\\emsdk\\emsdk-main\\upstream\\emscripten\\emcc.exe',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  const r = spawnSync('emcc', ['--version'], { stdio: 'ignore' });
  return r.status === 0 ? 'emcc' : null;
}

function findZig() {
  if (process.env.ZIG) return process.env.ZIG;
  const candidates = [
    'C:\\Users\\a1\\zig\\zig-windows-x86_64-0.13.0\\zig.exe',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return 'zig'; // 最后指望 PATH
}

const emcc = findEmcc();
if (emcc) {
  const OUT = path.join(OUT_DIR, 'war3core.mjs');
  const args = [
    SRC,
    '-O2',
    '--no-entry',
    '-sEXPORTED_FUNCTIONS=_add,_multiply,_fib',
    '-sMODULARIZE',
    '-sEXPORT_NAME=createWar3Core',
    '-sENVIRONMENT=node,web',
    '-o', OUT,
  ];
  console.log(`emcc: ${emcc}`);
  console.log(`src:  ${SRC}`);
  console.log(`out:  ${OUT} (+ war3core.wasm)`);
  const r = spawnSync(emcc, args, { stdio: 'inherit' });
  if (r.error) {
    console.error('无法启动 emcc：', r.error.message);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`emcc 失败 (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
  const wasm = path.join(OUT_DIR, 'war3core.wasm');
  const js = existsSync(OUT) ? `${(statSync(OUT).size / 1024).toFixed(1)} KB` : '?';
  const wm = existsSync(wasm) ? `${(statSync(wasm).size / 1024).toFixed(1)} KB` : '?';
  console.log(`\n构建成功 (Emscripten): war3core.mjs (${js}) + war3core.wasm (${wm})`);
} else {
  const zig = findZig();
  const OUT = path.join(OUT_DIR, 'war3core.wasm');
  const args = [
    'cc',
    '--target=wasm32-freestanding',
    '-O2',
    '-nostdlib',
    '-Wl,--no-entry',
    '-Wl,--export=add',
    '-Wl,--export=multiply',
    '-Wl,--export=fib',
    '-o', OUT,
    SRC,
  ];
  console.log(`zig: ${zig}`);
  console.log(`src: ${SRC}`);
  console.log(`out: ${OUT}`);
  const r = spawnSync(zig, args, { stdio: 'inherit' });
  if (r.error) {
    console.error('无法启动 zig：', r.error.message);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`zig cc 失败 (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
  const size = existsSync(OUT) ? `${(statSync(OUT).size / 1024).toFixed(1)} KB` : '?';
  console.log(`\n构建成功 (zig 保底): war3core.wasm (${size})`);
}
