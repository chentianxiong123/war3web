// M1: 用 zig cc 把 wasm/src/core.c 编译成裸 wasm（wasm/out/war3core.wasm）。
// zig 自带完整 LLVM（含 wasm32 后端）+ lld，无需 Emscripten 即可产出裸 wasm，
// Node / 浏览器直接 WebAssembly.instantiate 加载。
// zig 路径：环境变量 ZIG 优先，其次常用安装位置，最后 PATH。
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'wasm', 'src', 'core.c');
const OUT_DIR = path.join(ROOT, 'wasm', 'out');
const OUT = path.join(OUT_DIR, 'war3core.wasm');

function findZig() {
  if (process.env.ZIG) return process.env.ZIG;
  const candidates = [
    'C:\\Users\\a1\\zig\\zig-windows-x86_64-0.13.0\\zig.exe',
  ];
  for (const c of candidates) if (existsSync(c)) return c;
  return 'zig'; // 最后指望 PATH
}

const zig = findZig();
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
console.log(`\n构建成功: war3core.wasm (${size})`);
