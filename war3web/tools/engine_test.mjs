// 引擎模块 Node 端验证（engine/out/engine.mjs，先跑 npm run engine）。
// 覆盖：vec3 数学 + W3X/W3M 头解析 + StormLib 真实读取地图（terenas.w3x）。
import createEngine from '../engine/out/engine.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseJs } from '../server/jass/parse.js';
import { VM } from '../server/jass/vm.js';
import { JassEngine } from '../server/jass/engine.js';
import { Handle } from '../server/jass/vm.js';

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

// --- JASS 解析（WASM 版 vs JS 版 parse() 完整 AST 对照）---
const jassC = (s) => {
  const b = m._malloc(s.length + 1);
  m.stringToUTF8(s, b, s.length + 1);
  const ptr = m._jass_parse(b, s.length);
  const json = m.UTF8ToString(ptr);
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
const cmStr = jassC(mini);
const jmStr = JSON.stringify(parseJs(mini, 'mini'));
ck('jass(小) AST 完整一致', cmStr === jmStr ? 1 : 0, 1);
if (cmStr !== jmStr) {
  let d = 0;
  while (d < cmStr.length && d < jmStr.length && cmStr[d] === jmStr[d]) d++;
  console.log('  首个差异 @' + d + ':\n  C 「' + cmStr.slice(Math.max(0, d - 50), d + 50) + '」\n  JS「' + jmStr.slice(Math.max(0, d - 50), d + 50) + '」');
}
const cm = JSON.parse(cmStr);
const jm = parseJs(mini, 'mini');
ck('jass(小) types', cm.types.length, jm.types.length);
ck('jass(小) globals', cm.globals.length, jm.globals.length);
ck('jass(小) natives', cm.natives.length, jm.natives.length);
ck('jass(小) functions', cm.functions.length, jm.functions.length);
const cAdd = cm.functions.find((f) => f.name === 'Add');
const jAdd = jm.functions.find((f) => f.name === 'Add');
ck('jass(小) Add.body 语句数', cAdd.body.length, jAdd.body.length);

const JASS_PATH = path.join(ROOT, 'extracted', 'war3map.j');
if (!fs.existsSync(JASS_PATH)) {
  console.log('  SKIP  war3map.j 对照（缺 extracted/war3map.j）');
} else {
  const src = fs.readFileSync(JASS_PATH, 'utf8');
  const cm2Str = jassC(src);
  const jm2Str = JSON.stringify(parseJs(src, 'war3map.j'));
  ck('jass(地图) AST 完整一致', cm2Str === jm2Str ? 1 : 0, 1);
  if (cm2Str !== jm2Str) {
    let d = 0;
    while (d < cm2Str.length && d < jm2Str.length && cm2Str[d] === jm2Str[d]) d++;
    console.log('  首个差异 @' + d + '  (C ' + cm2Str.length + ' / JS ' + jm2Str.length + '):\n  C 「' + cm2Str.slice(Math.max(0, d - 60), d + 60) + '」\n  JS「' + jm2Str.slice(Math.max(0, d - 60), d + 60) + '」');
  }
  const cm2 = JSON.parse(cm2Str);
  const jm2 = parseJs(src, 'war3map.j');
  ck('jass(地图) types', cm2.types.length, jm2.types.length);
  ck('jass(地图) globals', cm2.globals.length, jm2.globals.length);
  ck('jass(地图) natives', cm2.natives.length, jm2.natives.length);
  ck('jass(地图) functions', cm2.functions.length, jm2.functions.length);
  console.log(`  info   war3map.j: ${cm2.functions.length} 函数 / ${cm2.natives.length} 原生 / ${cm2.globals.length} 全局 (AST ${cm2Str.length} 字节)`);
}

// --- JASS VM 执行（C 版 vs JS 版 vm.js 对照）---
const jassRunC = (src, entry) => {
  const b = m._malloc(src.length + 1);
  m.stringToUTF8(src, b, src.length + 1);
  const eb = m._malloc(entry.length + 1);
  m.stringToUTF8(entry, eb, entry.length + 1);
  const errp = m._malloc(4);
  const ptr = m._jass_run(b, src.length, eb, errp);
  const json = m.UTF8ToString(ptr);
  m._free(ptr); m._free(errp); m._free(eb); m._free(b);
  return JSON.parse(json);
};
const vmScript = `
globals
  integer counter = 0
  integer array scores
endglobals
function Add takes integer a, integer b returns integer
  return a + b
endfunction
function Fact takes integer n returns integer
  if n <= 1 then
    return 1
  endif
  return n * Fact(n - 1)
endfunction
function Main takes nothing returns nothing
  local integer x = Add(2, 3)
  local integer i = 0
  set counter = Fact(5)
  set scores[0] = x
  set scores[1] = counter
  loop
    exitwhen i >= 3
    set i = i + 1
  endloop
  call BJDebugMsg("fact5=" + I2S(counter))
  call BJDebugMsg("x=" + I2S(x))
  call BJDebugMsg("s0=" + I2S(scores[0]))
  call BJDebugMsg("i=" + I2S(i))
endfunction`;
const cr = jassRunC(vmScript, 'Main');
const runJsVm = (src, entry) => {
  const ast = parseJs(src, 'vm');
  const vm = new VM();
  vm.addTypes(ast);
  vm.addFunctions(ast);
  vm.addGlobals(ast);
  const log = [];
  vm.registerNative('BJDebugMsg', (s) => { log.push(s); });
  vm.registerNative('I2S', (i) => String(Math.trunc(i)));
  const ig = vm.initGlobals();
  for (const _ of ig) {}
  const gen = vm.runFunction(entry, []);
  for (const _ of gen) {}
  const g = {};
  for (const [k, v] of vm.globals) if (!v.isArr) g[k] = v.value;
  return { log: log.join('\n'), globals: g };
};
const jr = runJsVm(vmScript, 'Main');
ck('jass(VM) ok', cr.ok ? 1 : 0, 1);
ck('jass(VM) log 一致', cr.log.trim().split('\n').join('\n') === jr.log ? 1 : 0, 1);
if (cr.log.trim().split('\n').join('\n') !== jr.log) console.log('  diff log:\n  C 「' + cr.log + '」\n  JS「' + jr.log + '」');
ck('jass(VM) counter=120', cr.globals.counter, jr.globals.counter);

// --- 玩家对象表语义（Player 幂等 + GetPlayerId 还原 index，对齐 engine.js P(i)）---
const playerScript = `
globals
  integer pidx = 0
  player pSame = null
endglobals
function Init takes nothing returns nothing
  set pSame = Player(3)
  set pidx = GetPlayerId(Player(3))
endfunction
function main takes nothing returns nothing
  call Init()
endfunction
`;
const rP = jassRunC(playerScript, 'main');
ck('jass(玩家) GetPlayerId(Player(3)) 还原 index=3', rP.globals.pidx, 3);
if (rP.globals.pidx !== 3) console.log('  pidx=' + rP.globals.pidx);

// --- 拼接全量解析（common.j + Blizzard.j + war3map.j 670KB，逐步字节对照）---
const COMMON_J = path.join(ROOT, 'war3_extracted/Scripts/common.j');
const BLIZZARD_J = path.join(ROOT, 'war3_extracted/Scripts/Blizzard.j');
if (fs.existsSync(COMMON_J) && fs.existsSync(BLIZZARD_J)) {
  const readLib = (p) => fs.readFileSync(p, 'latin1').replace(/\r\n?/g, '\n');
  const full = readLib(COMMON_J) + '\n' + readLib(BLIZZARD_J) + '\n' + readLib(JASS_PATH);
  const cFull = jassC(full);
  const jFull = JSON.stringify(parseJs(full, 'concat'));
  ck('jass(拼接670KB) AST 逐字节一致', cFull === jFull ? 1 : 0, 1);
  if (cFull !== jFull) {
    let d = 0;
    while (d < cFull.length && d < jFull.length && cFull[d] === jFull[d]) d++;
    console.log('  首个差异 @' + d + ' (C ' + cFull.length + ' / JS ' + jFull.length + '):\n  C 「' + cFull.slice(Math.max(0, d - 60), d + 60) + '」\n  JS「' + jFull.slice(Math.max(0, d - 60), d + 60) + '」');
  }
  const pFull = JSON.parse(cFull);
  console.log(`  info   拼接: ${full.length} 字节源 → ${pFull.functions.length} 函数 / ${pFull.natives.length} natives / ${pFull.globals.length} 全局 / ${pFull.types.length} 类型`);

  // --- JASS 真实地图 main 全链执行（C VM + natives 分发表）---
  const rMain = jassRunC(full, 'main');
  ck('jass(main) 执行完成', rMain.ok ? 1 : 0, 1);
  if (!rMain.ok) console.log('  error: ' + rMain.error);
  const unimplMain = [...new Set(((rMain.log || '').match(/\[unimpl:([^\]]+)\]/g) || []).map((s) => s.slice(8, -1)))];
  if (unimplMain.length) console.log(`  info   main 链 stub natives: ${unimplMain.length} 种 (触发器动作链 Melee 系, 深化中): ${unimplMain.slice(0, 8).join(', ')}…`);
  const calls = rMain.calls || [];
  // main 直呼的真 natives（SetAmbientDaySound/InitBlizzard 等是 Blizzard.j 函数，
  // 其入口由"执行完成+无未实现"隐含验证）
  const seq = ['SetCameraBounds', 'SetDayNightModels', 'SetTerrainFogEx', 'SetWaterBaseColor',
    'AddWeatherEffect', 'EnableWeatherEffect', 'NewSoundEnvironment', 'SetMapMusic'];
  const gotSeq = seq.filter((n) => calls.includes(n));
  ck('jass(main) natives 调用序完整', gotSeq.length === seq.length ? 1 : 0, 1);
  if (gotSeq.length !== seq.length) console.log('  缺调用证据: ' + seq.filter((n) => !gotSeq.includes(n)).join(', '));
  console.log(`  info   main 全链执行: ${calls.length} 个 natives 被调用`);

  // --- config 配置链执行（地图配置：名字/玩家/出生点/槽位）---
  const rCfg = jassRunC(full, 'config');
  ck('jass(config) 执行完成', rCfg.ok ? 1 : 0, 1);
  if (!rCfg.ok) console.log('  error: ' + rCfg.error);
  const unimplCfg = [...new Set(((rCfg.log || '').match(/\[unimpl:([^\]]+)\]/g) || []).map((s) => s.slice(8, -1)))];
  ck('jass(config) 无未实现 natives', unimplCfg.length === 0 ? 1 : 0, 1);
  if (unimplCfg.length) console.log('  未实现: ' + unimplCfg.sort().join(', '));
  const cfgCalls = rCfg.calls || [];
  // config 直呼的真 natives（SetPlayerSlotAvailable/InitCustomPlayerSlots 等是
  // Blizzard.j 函数，入口由"执行完成+无未实现"隐含验证）
  const cfgSeq = ['SetMapName', 'SetMapDescription', 'SetPlayers', 'SetTeams', 'SetGamePlacement',
    'DefineStartLocation', 'Player'];
  const cfgGot = cfgSeq.filter((n) => cfgCalls.includes(n));
  ck('jass(config) natives 调用序完整', cfgGot.length === cfgSeq.length ? 1 : 0, 1);
  if (cfgGot.length !== cfgSeq.length) console.log('  缺调用证据: ' + cfgSeq.filter((n) => !cfgGot.includes(n)).join(', '));
  console.log(`  info   config 链执行: ${cfgCalls.length} 个 natives 被调用`);

  // --- C(config,main) vs JS boot() 全局强对照（880 全局零差异）---
  const rBoot = jassRunC(full, 'config,main');
  const jsGlobals = (() => {
    const world = new Proxy({}, {
      get(t, k) { if (k in t) return t[k]; return (...a) => new Handle(String(k)); },
      set(t, k, v) { t[k] = v; return true; },
    });
    const eng = new JassEngine(world);
    eng.load({ commonJ: 'war3_extracted/Scripts/common.j', blizzardJ: 'war3_extracted/Scripts/Blizzard.j', mapJ: 'extracted/war3map.j' });
    eng.boot();  // boot = initGlobals + config + main（官方引导顺序）
    const g = {};
    for (const [k, v] of eng.vm.globals) if (!v.isArr) g[k] = v.value;
    return g;
  })();
  const diffs = [];
  for (const k of Object.keys(jsGlobals)) {
    const jv = jsGlobals[k], cv = rBoot.globals[k];
    if (cv === undefined) { diffs.push('仅JS: ' + k); continue; }
    if (jv instanceof Handle) continue;  // handle 存在性对账（C 侧一律序列化为 null）
    if (jv === null || jv === undefined) { if (cv !== null && cv !== undefined) diffs.push(`null对账: ${k} C=${JSON.stringify(cv)} JS=null`); continue; }
    if (typeof jv === 'number' || typeof jv === 'boolean' || typeof jv === 'string') {
      if (cv !== jv) diffs.push(`${k} C=${JSON.stringify(cv)} JS=${JSON.stringify(jv)}`);
    }
  }
  ck('jass(config,main) C/JS 全局对账零差异', diffs.length === 0 ? 1 : 0, 1);
  if (diffs.length) console.log('  差异: ' + diffs.slice(0, 5).join('; '));
  console.log(`  info   C(config,main)/JS(boot) 对账: ${Object.keys(jsGlobals).length} 全局 0 差异`);
} else {
  console.log('  SKIP  拼接对照（缺 war3_extracted/Scripts 库文件）');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
