// Node 端加载 war3core 并验证导出函数。
// 双模式：优先 Emscripten 模块（war3core.mjs，MODULARIZE，_add 等）；
// 否则加载 zig 编出的裸 wasm（war3core.wasm，add 等）。
// 依赖构建产物（先跑 npm run wasm）。
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const OUT = path.resolve(import.meta.dirname, '../wasm/out');
const MJS = path.join(OUT, 'war3core.mjs');
const WASM = path.join(OUT, 'war3core.wasm');

let core, mode;
if (existsSync(MJS)) {
  const mod = await import(pathToFileURL(MJS).href);
  const create = mod.default ?? mod.createWar3Core;
  core = await create();
  mode = 'Emscripten (war3core.mjs)';
} else if (existsSync(WASM)) {
  const { instance } = await WebAssembly.instantiate(readFileSync(WASM));
  core = instance.exports;
  mode = 'zig bare wasm';
} else {
  console.error('没有构建产物，先跑 npm run wasm');
  process.exit(1);
}

const f = (name) => (mode.startsWith('Emscripten') ? core['_' + name] : core[name]).bind(core);

let passed = 0, failed = 0;
const check = (name, got, want) => {
  if (got === want) { passed++; console.log(`  ok   ${name} = ${got}`); }
  else { failed++; console.log(`  FAIL ${name}: got ${got}, want ${want}`); }
};

console.log(`mode: ${mode}`);
check('add(2, 3)', f('add')(2, 3), 5);
check('add(-5, 5)', f('add')(-5, 5), 0);
check('multiply(6, 7)', f('multiply')(6, 7), 42);
check('fib(10)', f('fib')(10), 55);
check('fib(1)', f('fib')(1), 1);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
