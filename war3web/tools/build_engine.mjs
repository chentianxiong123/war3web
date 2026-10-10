// 构建 C++ 引擎（engine/）：emcmake cmake -G Ninja → ninja → 产物复制到 engine/out/。
// Emscripten 主线（参考 WhiteoutFlakes：emcmake + Ninja + WebGPU 逐步铺入）。
// 环境：EMSDK 环境变量或默认 C:\Users\a1\emsdk\emsdk-main。
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ENGINE = path.join(ROOT, 'engine');
const EMSDK = process.env.EMSDK || 'C:\\Users\\a1\\emsdk\\emsdk-main';
const EMCC_DIR = path.join(EMSDK, 'upstream', 'emscripten');
const NODE_DIR = path.join(EMSDK, 'node', '24.19.0_64bit');
const PY_SCRIPTS = 'C:\\Users\\a1\\AppData\\Local\\Programs\\Python\\Python314\\Scripts';
const BUILD_DIR = path.join(ENGINE, 'build-web');
const OUT_DIR = path.join(ENGINE, 'out');

function run(cmd, args, cwd) {
  const r = spawnSync(cmd, args, {
    cwd, stdio: 'inherit',
    env: { ...process.env, PATH: [NODE_DIR, EMCC_DIR, PY_SCRIPTS, process.env.PATH].join(';'), EMSDK },
  });
  if (r.error) { console.error('无法启动:', r.error.message); process.exit(1); }
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (!existsSync(path.join(BUILD_DIR, 'build.ninja'))) {
  console.log('emcmake cmake -G Ninja -B build-web');
  run(path.join(EMCC_DIR, 'emcmake.exe'), ['cmake', '-G', 'Ninja', '-B', 'build-web', '-DCMAKE_BUILD_TYPE=Release'], ENGINE);
}
console.log('ninja -C build-web');
run('ninja', ['-C', 'build-web'], ENGINE);

mkdirSync(OUT_DIR, { recursive: true });
for (const f of ['engine.mjs', 'engine.wasm']) {
  copyFileSync(path.join(BUILD_DIR, f), path.join(OUT_DIR, f));
  console.log(`产物: engine/out/${f}`);
}
console.log('\n引擎构建成功 (Emscripten + CMake + Ninja)');
