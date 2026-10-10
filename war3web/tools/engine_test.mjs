// 引擎模块 Node 端验证（engine/out/engine.mjs，先跑 npm run engine）。
// 覆盖：vec3 数学 + W3X/W3M 头解析 + StormLib 真实读取地图（terenas.w3x）。
import createEngine from '../engine/out/engine.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseJs } from '../server/jass/parse.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAP_PATH = path.join(ROOT, 'terenas.w3x');

const m = await createEngine();
let passed = 0, failed = 0;
const ck = (name, got, want) => {
  const ok = Math.abs(got - want) < 1e-6;
  if (ok) passed++; else failed++;
  console.log(`${ok ? '  ok   ' : '  FAIL '}${name} = ${got}${ok ? '' : ' (want ' + want + ')'}`);
};

// --- vec3 ---
ck('len(3,4,0)=5', m._vec3_lenf(3, 4, 0), 5);
ck('dot(1,0,0,0,1,0)=0', m._vec3_dotf(1, 0, 0, 0, 1, 0), 0);
ck('dot(1,0,0,1,0,0)=1', m._vec3_dotf(1, 0, 0, 1, 0, 0), 1);
const crossOut = m._malloc(3 * 4);
m._vec3_crossf(1, 0, 0, 0, 1, 0, crossOut);
const [cx, cy, cz] = new Float32Array(m.HEAPU8.buffer, crossOut, 3);
ck('cross.x=0', cx, 0);
ck('cross.y=0', cy, 0);
ck('cross.z=1', cz, 1);
m._free(crossOut);

// --- W3X 地图头 ---
const buf = m._malloc(12);
m.HEAPU8.set(new Uint8Array([0x57, 0x33, 0x58, 0x21, 30, 0, 0, 0, 0, 0, 0, 0]), buf); // "W3X!" ver=30
ck('w3x_check_header(W3X!)=1', m._w3x_check_header(buf, 12), 1);
ck('w3x_get_version=30', m._w3x_get_version(buf, 12), 30);
ck('w3x_check_header(短buf)=0', m._w3x_check_header(buf, 3), 0);
const bad = m._malloc(8);
m.HEAPU8.set([0x41, 0x42, 0x43, 0x44, 1, 0, 0, 0], bad); // "ABCD"
ck('w3x_check_header(ABCD)=0', m._w3x_check_header(bad, 8), 0);
m._free(buf);
m._free(bad);

// --- StormLib 真实读取地图（terenas.w3x）---
if (!fs.existsSync(MAP_PATH)) {
  console.log('  SKIP  地图读取（缺 terenas.w3x，手动补一份到项目根）');
} else {
  const bytes = fs.readFileSync(MAP_PATH);
  m.FS_createDataFile('/', 'map.w3x', new Uint8Array(bytes), true, false);
  ck('w3x_open(/map.w3x)', m.ccall('w3x_open', 'number', ['string'], ['/map.w3x']), 1);
  ck('war3map.w3i 存在', m.ccall('w3x_has_file', 'number', ['string'], ['war3map.w3i']), 1);
  ck('war3map.j 存在', m.ccall('w3x_has_file', 'number', ['string'], ['war3map.j']), 1);
  ck('war3map.w3e 存在', m.ccall('w3x_has_file', 'number', ['string'], ['war3map.w3e']), 1);
  ck('不存在文件=0', m.ccall('w3x_has_file', 'number', ['string'], ['war3map.nonexist']), 0);
  const w3i = m._malloc(8192);
  const n = m.ccall('w3x_read', 'number', ['string', 'number', 'number'], ['war3map.w3i', w3i, 8192]);
  ck('w3i 读取 > 0 字节', n > 0 ? 1 : 0, 1);
  const version = n >= 4 ? new DataView(m.HEAPU8.buffer, w3i, n).getInt32(0, true) : 0;
  ck('w3i version >= 4', version >= 4 ? 1 : 0, 1);
  console.log(`  info   terenas.w3x: ${bytes.length} 字节, w3i v${version}, 文件数(抽样 ${['war3map.w3i', 'war3map.j', 'war3map.w3e'].length})`);
  m._free(w3i);
}

// --- JASS 解析（WASM 版 vs JS 版 parse() 对照）---
const jassC = (s) => {
  const b = m._malloc(s.length + 1);
  m.stringToUTF8(s, b, s.length + 1);
  const ptr = m._jass_parse(b, s.length);
  const json = JSON.parse(m.UTF8ToString(ptr));
  m._free(ptr); m._free(b);
  return json;
};
const mini = `
globals
  integer x = 5
  constant real PI = 3.14
  unit array units
endglobals
type unit extends handle
native Test takes integer a, string b returns boolean
function Add takes integer a, integer b returns integer
  local integer r = a + b
  loop
    exitwhen r > 100
    set r = r + 1
  endloop
  call Test(r, "hi")
  return r
endfunction
function Main takes nothing returns nothing
  if x == 5 then
    call Add(1, 2)
  elseif x < 0 then
    return
  else
    set x = x + 1
  endif
endfunction
`;
const cm = jassC(mini);
const jm = parseJs(mini, 'mini');
ck('jass(小) types', cm.types.length, jm.types.length);
ck('jass(小) globals', cm.globals, jm.globals.length);
ck('jass(小) natives', cm.native_count, jm.natives.length);
ck('jass(小) functions', cm.function_count, jm.functions.length);
const cAdd = cm.functions.find((f) => f.name === 'Add');
const jAdd = jm.functions.find((f) => f.name === 'Add');
ck('jass(小) Add.stmts', cAdd.stmts, jAdd.body.length);
ck('jass(小) Add.params', cAdd.params.length, jAdd.params.length);
ck('jass(小) Add.ret', cAdd.ret === jAdd.ret ? 1 : 0, 1);
ck('jass(小) Main.ret=nothing', cm.functions.find((f) => f.name === 'Main').ret === 'nothing' ? 1 : 0, 1);

const JASS_PATH = path.join(ROOT, 'extracted', 'war3map.j');
if (!fs.existsSync(JASS_PATH)) {
  console.log('  SKIP  war3map.j 对照（缺 extracted/war3map.j）');
} else {
  const src = fs.readFileSync(JASS_PATH, 'utf8');
  const cm2 = jassC(src);
  const jm2 = parseJs(src, 'war3map.j');
  ck('jass(地图) types', cm2.types.length, jm2.types.length);
  ck('jass(地图) globals', cm2.globals, jm2.globals.length);
  ck('jass(地图) natives', cm2.native_count, jm2.natives.length);
  ck('jass(地图) functions', cm2.function_count, jm2.functions.length);
  const jFn = jm2.functions.find((f) => f.name === 'InitGlobals');
  const cFn = cm2.functions.find((f) => f.name === 'InitGlobals');
  ck('jass(地图) InitGlobals.stmts', cFn ? cFn.stmts : -1, jFn ? jFn.body.length : -1);
  const jDrop = jm2.functions.find((f) => f.name.endsWith('_DropItems'));
  const cDrop = cm2.functions.find((f) => f.name.endsWith('_DropItems'));
  ck('jass(地图) DropItems 参数数', cDrop ? cDrop.params.length : -1, jDrop ? jDrop.params.length : -1);
  console.log(`  info   war3map.j: ${cm2.function_count} 函数 / ${cm2.native_count} 原生 / ${cm2.globals} 全局`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
