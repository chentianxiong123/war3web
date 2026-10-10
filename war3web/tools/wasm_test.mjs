// M1: Node 端加载 war3core.wasm（zig cc 编出的裸 wasm），验证导出函数。
// 依赖构建产物 wasm/out/war3core.wasm（先跑 npm run wasm）。
import { readFileSync } from 'node:fs';
import path from 'node:path';

const OUT = path.resolve(import.meta.dirname, '../wasm/out');
const { instance } = await WebAssembly.instantiate(readFileSync(path.join(OUT, 'war3core.wasm')));
const core = instance.exports;

let passed = 0, failed = 0;
const check = (name, got, want) => {
  if (got === want) { passed++; console.log(`  ok   ${name} = ${got}`); }
  else { failed++; console.log(`  FAIL ${name}: got ${got}, want ${want}`); }
};

check('add(2, 3)', core.add(2, 3), 5);
check('add(-5, 5)', core.add(-5, 5), 0);
check('multiply(6, 7)', core.multiply(6, 7), 42);
check('fib(10)', core.fib(10), 55);
check('fib(1)', core.fib(1), 1);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);