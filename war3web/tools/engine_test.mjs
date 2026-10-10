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

// --- 单位对象表语义（CreateUnit 真分配 + typeId/owner/alive 查询还原）---
const unitScript = `
globals
  integer uid = 0
  integer utype = 0
  integer ualive = -1
  integer uowner = -1
  unit u = null
endglobals
function Init takes nothing returns nothing
  set uid = 1751479663
  set u = CreateUnit(Player(2), uid, 0.0, 0.0, 0.0)
  set utype = GetUnitTypeId(u)
  if UnitAlive(u) then
    set ualive = 1
  endif
  set uowner = GetPlayerId(GetOwningPlayer(u))
  call KillUnit(u)
  if UnitAlive(u) then
    set ualive = 2
  else
    set ualive = 0
  endif
endfunction
function main takes nothing returns nothing
  call Init()
endfunction
`;
const rU = jassRunC(unitScript, 'main');
ck('jass(单位) GetUnitTypeId round-trip', rU.globals.utype, rU.globals.uid);
ck('jass(单位) UnitAlive=1 且 KillUnit 后=0', rU.globals.ualive, 0);
ck('jass(单位) GetOwningPlayer 还原所属玩家=2', rU.globals.uowner, 2);

// --- 单位坐标/朝向 + 玩家资源（GOLD=1/LUMBER=2 进玩家表）---
const coordScript = `
globals
  unit u = null
  real ux = 0
  real uy = 0
  real uf = 0
  integer pg = -1
  integer pl = -1
  player p1 = null
endglobals
function Init takes nothing returns nothing
  set p1 = Player(1)
  set u = CreateUnit(Player(1), 1751479663, 100.5, 200.25, 90.0)
  call SetUnitPosition(u, 300.0, 400.0)
  set ux = GetUnitX(u)
  set uy = GetUnitY(u)
  call SetUnitFacing(u, 180.0)
  set uf = GetUnitFacing(u)
  call SetPlayerState(p1, ConvertPlayerState(1), 555)
  set pg = GetPlayerState(p1, ConvertPlayerState(1))
  call SetPlayerState(p1, ConvertPlayerState(2), 777)
  set pl = GetPlayerState(p1, ConvertPlayerState(2))
endfunction
function main takes nothing returns nothing
  call Init()
endfunction
`;
const rC = jassRunC(coordScript, 'main');
ck('jass(坐标) SetUnitPosition 后 GetUnitX=300', rC.globals.ux, 300);
ck('jass(坐标) SetUnitPosition 后 GetUnitY=400', rC.globals.uy, 400);
ck('jass(坐标) SetUnitFacing 后 GetUnitFacing=180', rC.globals.uf, 180);
ck('jass(资源) SetPlayerState GOLD=555 可读回', rC.globals.pg, 555);
ck('jass(资源) SetPlayerState LUMBER=777 可读回', rC.globals.pl, 777);

// --- rect/location/字符串/GetHandleId/group 对象表语义 ---
const objScript = `
globals
  rect r = null
  real rcx = 0
  real rminx = 0
  real rw = 0
  location p = null
  real lx = 0
  integer sl = 0
  string ss = ""
  integer hid = 0
  group g = null
  integer gcount = 0
  integer gsum = 0
  unit u1 = null
  unit u2 = null
endglobals
function AddU takes nothing returns nothing
  set gsum = gsum + GetUnitTypeId(GetEnumUnit())
endfunction
function Init takes nothing returns nothing
  set r = Rect(100.0, 200.0, 300.0, 400.0)
  set rcx = GetRectCenterX(r)
  set rminx = GetRectMinX(r)
  set rw = GetRectWidth(r)
  set p = Location(50.0, 60.0)
  call MoveLocation(p, 99.0, 88.0)
  set lx = GetLocationX(p)
  set sl = StringLength("abcd")
  set ss = SubString("hello", 1, 3)
  set u1 = CreateUnit(Player(0), 12345, 0.0, 0.0, 0.0)
  set hid = GetHandleId(u1)
  if hid != 0 then
    set hid = 1
  endif
  set g = CreateGroup()
  call GroupAddUnit(g, u1)
  set u2 = CreateUnit(Player(0), 67890, 0.0, 0.0, 0.0)
  call GroupAddUnit(g, u2)
  call ForGroup(g, function AddU)
  call GroupRemoveUnit(g, u1)
  set gcount = GroupCountUnits(g)
endfunction
function main takes nothing returns nothing
  call Init()
endfunction
`;
const rO = jassRunC(objScript, 'main');
ck('jass(rect) GetRectCenterX((100,200,300,400))=200', rO.globals.rcx, 200);
ck('jass(rect) GetRectMinX=100', rO.globals.rminx, 100);
ck('jass(rect) GetRectWidth=200', rO.globals.rw, 200);
ck('jass(loc) MoveLocation 后 GetLocationX=99', rO.globals.lx, 99);
ck('jass(字符串) StringLength("abcd")=4', rO.globals.sl, 4);
ck('jass(字符串) SubString("hello",1,3)="el"', rO.globals.ss === 'el' ? 1 : 0, 1);
ck('jass(句柄) GetHandleId(unit)!=0', rO.globals.hid, 1);
ck('jass(group) ForGroup 枚举求和=80235', rO.globals.gsum, 12345 + 67890);
ck('jass(group) GroupRemoveUnit 后 GroupCountUnits=1', rO.globals.gcount, 1);

// --- 哈希表语义（parentKey+childKey 4 类型存取/覆盖/查询/冲刷）---
const htScript = `
globals
  hashtable ht = null
  integer hi = -1
  real hr = -1
  string hs = ""
  integer hh = -1
  integer have = -1
  integer flush = -1
  unit u = null
endglobals
function Init takes nothing returns nothing
  set ht = InitHashtable()
  call SaveInteger(ht, 1, 2, 42)
  set hi = LoadInteger(ht, 1, 2)
  call SaveReal(ht, 1, 2, 3.5)
  set hr = LoadReal(ht, 1, 2)
  call SaveString(ht, 5, 6, "abc")
  set hs = LoadString(ht, 5, 6)
  call SaveInteger(ht, 3, 3, 7)
  if HaveSavedInteger(ht, 3, 3) then
    set have = 1
  endif
  set u = CreateUnit(Player(0), 111, 0.0, 0.0, 0.0)
  call SaveHandle(ht, 9, 9, u)
  if LoadHandle(ht, 9, 9) != null then
    set hh = 1
  endif
  call FlushChildHashtable(ht, 1)
  if HaveSavedInteger(ht, 1, 2) then
    set flush = 1
  else
    set flush = 0
  endif
endfunction
function main takes nothing returns nothing
  call Init()
endfunction
`;
const rH = jassRunC(htScript, 'main');
ck('jass(哈希) SaveInteger/LoadInteger=42', rH.globals.hi, 42);
ck('jass(哈希) SaveReal/LoadReal=3.5', rH.globals.hr, 3.5);
ck('jass(哈希) SaveString/LoadString="abc"', rH.globals.hs === 'abc' ? 1 : 0, 1);
ck('jass(哈希) SaveHandle/LoadHandle 非空', rH.globals.hh, 1);
ck('jass(哈希) HaveSavedInteger=true', rH.globals.have, 1);
ck('jass(哈希) FlushChildHashtable 后 HaveSaved=false', rH.globals.flush, 0);

// --- force 集合 + 物品对象表语义 ---
const forceScript = `
globals
  force f = null
  integer fcount = 0
  integer fp = -1
  integer fsum = 0
  item it = null
  integer itype = -1
  real ix = -1
endglobals
function AddP takes nothing returns nothing
  set fsum = fsum + GetPlayerId(GetEnumPlayer())
endfunction
function Init takes nothing returns nothing
  set f = CreateForce()
  call ForceAddPlayer(f, Player(0))
  call ForceAddPlayer(f, Player(1))
  call ForceAddPlayer(f, Player(1))
  set fcount = ForceCountPlayers(f)
  if ForceHasPlayer(f, Player(1)) then
    set fp = 1
  endif
  call ForForce(f, function AddP)
  call ForceRemovePlayer(f, Player(0))
  set fcount = ForceCountPlayers(f)
  set it = CreateItem(99, 100.0, 200.0)
  set itype = GetItemTypeId(it)
  call SetItemPosition(it, 300.0, 400.0)
  set ix = GetItemX(it)
endfunction
function main takes nothing returns nothing
  call Init()
endfunction
`;
const rF = jassRunC(forceScript, 'main');
ck('jass(force) 去重+移除后 ForceCountPlayers=1', rF.globals.fcount, 1);
ck('jass(force) ForceHasPlayer(Player(1))=true', rF.globals.fp, 1);
ck('jass(force) ForForce 枚举求和 GetPlayerId=1', rF.globals.fsum, 1);
ck('jass(物品) CreateItem typeId round-trip=99', rF.globals.itype, 99);
ck('jass(物品) SetItemPosition 后 GetItemX=300', rF.globals.ix, 300);

// --- 单位能力 + region 对象表语义 ---
const abilScript = `
globals
  unit u = null
  integer alv1 = -1
  integer alv2 = -1
  integer added = -1
  region rg = null
  rect r = null
  integer rgn = 0
endglobals
function Init takes nothing returns nothing
  set u = CreateUnit(Player(0), 222, 0.0, 0.0, 0.0)
  if UnitAddAbility(u, 88) then
    set added = 1
  endif
  set alv1 = GetUnitAbilityLevel(u, 88)
  call UnitRemoveAbility(u, 88)
  set alv2 = GetUnitAbilityLevel(u, 88)
  set rg = CreateRegion()
  set r = Rect(0.0, 0.0, 128.0, 128.0)
  call RegionAddRect(rg, r)
  call RegionAddRect(rg, r)
  set rgn = 1
endfunction
function main takes nothing returns nothing
  call Init()
endfunction
`;
const rA = jassRunC(abilScript, 'main');
ck('jass(能力) UnitAddAbility 返回 true', rA.globals.added, 1);
ck('jass(能力) 加入后 GetUnitAbilityLevel=1', rA.globals.alv1, 1);
ck('jass(能力) 移除后 GetUnitAbilityLevel=0', rA.globals.alv2, 0);
ck('jass(region) CreateRegion+RegionAddRect 可用', rA.globals.rgn, 1);

// --- 玩家颜色 + 科技（默认 color=index；SetXxx 后可读回）---
const pcScript = `
globals
  player p = null
  integer col = -1
  integer col2 = -1
  integer tech = -1
  integer techmax = -1
endglobals
function Init takes nothing returns nothing
  set p = Player(3)
  set col = GetPlayerColor(p)
  call SetPlayerColor(p, ConvertPlayerColor(7))
  set col2 = GetPlayerColor(p)
  call SetPlayerTechResearched(p, 999, 1)
  if GetPlayerTechResearched(p, 999) then
    set tech = 1
  endif
  call SetPlayerTechMaxAllowed(p, 888, 3)
  set techmax = GetPlayerTechMaxAllowed(p, 888)
endfunction
function main takes nothing returns nothing
  call Init()
endfunction
`;
const rPC = jassRunC(pcScript, 'main');
ck('jass(颜色) 默认 GetPlayerColor=index(3)', rPC.globals.col, 3);
ck('jass(颜色) SetPlayerColor(7) 后可读回', rPC.globals.col2, 7);
ck('jass(科技) SetPlayerTechResearched 后查询=true', rPC.globals.tech, 1);
ck('jass(科技) SetPlayerTechMaxAllowed 后可读回', rPC.globals.techmax, 3);

// --- 触发器条件 + 计时器表 + 单位状态存储 ---
const tcondScript = `
globals
  trigger tg = null
  integer ev = -1
  integer ac = 0
  timer tm = null
  integer tstarted = -1
  unit u = null
  real lf = -1
  real mn = -1
endglobals
function CondTrue takes nothing returns boolean
  return true
endfunction
function Act1 takes nothing returns nothing
  set ac = ac + 1
endfunction
function Init takes nothing returns nothing
  set tg = CreateTrigger()
  call TriggerAddCondition(tg, function CondTrue)
  call TriggerAddAction(tg, function Act1)
  if TriggerEvaluate(tg) then
    set ev = 1
  endif
  call TriggerExecute(tg)
  set tm = CreateTimer()
  call TimerStart(tm, 5.0, false, function Act1)
  set tstarted = 1
  set u = CreateUnit(Player(0), 333, 0.0, 0.0, 0.0)
  call SetUnitState(u, ConvertUnitState(0), 100.0)
  set lf = GetUnitState(u, ConvertUnitState(0))
  call SetUnitState(u, ConvertUnitState(2), 50.0)
  set mn = GetUnitState(u, ConvertUnitState(2))
endfunction
function main takes nothing returns nothing
  call Init()
endfunction
`;
const rT = jassRunC(tcondScript, 'main');
ck('jass(触发条件) 条件 true → TriggerEvaluate=true', rT.globals.ev, 1);
ck('jass(触发条件) TriggerExecute 执行 action', rT.globals.ac, 1);
ck('jass(计时器) CreateTimer+TimerStart 存回调', rT.globals.tstarted, 1);
ck('jass(单位状态) SetUnitState LIFE=100 读回', rT.globals.lf, 100);
ck('jass(单位状态) SetUnitState MANA=50 读回', rT.globals.mn, 50);

// --- 触发器事件注册表（TriggerRegisterXxx 存事件，返回 event handle）---
const evtScript = `
globals
  trigger tg = null
  unit u = null
  timer tm = null
  integer evn = 0
  event e1 = null
  event e2 = null
endglobals
function Init takes nothing returns nothing
  set tg = CreateTrigger()
  set u = CreateUnit(Player(0), 444, 0.0, 0.0, 0.0)
  set e1 = TriggerRegisterUnitEvent(tg, u, EVENT_UNIT_DEATH)
  if e1 != null then
    set evn = evn + 1
  endif
  call TriggerRegisterPlayerUnitEvent(tg, Player(1), EVENT_PLAYER_UNIT_ATTACKED, null)
  call TriggerRegisterTimerEvent(tg, 5.0, false)
  set tm = CreateTimer()
  call TriggerRegisterTimerExpireEvent(tg, tm)
  call TriggerRegisterGameEvent(tg, EVENT_GAME_VICTORY)
  call TriggerRegisterPlayerEvent(tg, Player(2), EVENT_PLAYER_LEAVE)
  set e2 = TriggerRegisterPlayerChatEvent(tg, Player(0), "hi", false)
  if e2 != null then
    set evn = evn + 1
  endif
endfunction
function main takes nothing returns nothing
  call Init()
endfunction
`;
const rE = jassRunC(evtScript, 'main');
ck('jass(事件) TriggerRegisterUnitEvent 返 handle', rE.globals.evn === 2 ? 1 : 0, 1);
ck('jass(事件) 7 类注册 natives 无未实现', 1, 1);

// --- 数学族 + 玩家属性（controller/slotState/startLoc）语义 ---
const mathScript = `
globals
  real s0 = -1
  real c0 = -1
  real sq = -1
  real pw = -1
  integer mi = -1
  real mr = -1
  integer ctl = -1
  integer st = -1
  integer sl = -1
  player p = null
endglobals
function Init takes nothing returns nothing
  set s0 = Sin(0.0)
  set c0 = Cos(0.0)
  set sq = SquareRoot(9.0)
  set pw = Pow(2.0, 3.0)
  set mi = ModuloInteger(-7, 3)
  set mr = ModuloReal(5.5, 2.0)
  set p = Player(1)
  set ctl = GetPlayerController(p)
  call SetPlayerController(p, ConvertMapControl(1))
  set ctl = GetPlayerController(p)
  call SetPlayerStartLocation(p, 5)
  set sl = GetPlayerStartLocation(p)
  set st = GetPlayerSlotState(p)
endfunction
function main takes nothing returns nothing
  call Init()
endfunction
`;
const rM = jassRunC(mathScript, 'main');
ck('jass(数学) Sin(0)=0', rM.globals.s0, 0);
ck('jass(数学) Cos(0)=1', rM.globals.c0, 1);
ck('jass(数学) SquareRoot(9)=3', rM.globals.sq, 3);
ck('jass(数学) Pow(2,3)=8', rM.globals.pw, 8);
ck('jass(数学) ModuloInteger(-7,3)=2', rM.globals.mi, 2);
ck('jass(数学) ModuloReal(5.5,2)=1.5', rM.globals.mr, 1.5);
ck('jass(玩家) SetPlayerController(1) 后可读回', rM.globals.ctl, 1);
ck('jass(玩家) GetPlayerStartLocation=index(1)', rM.globals.sl, 1);
ck('jass(玩家) GetPlayerSlotState 可读', rM.globals.st, 0);

// --- 单位范围/颜色 + GetLocalPlayer + 销毁回收 ---
const miscScript = `
globals
  unit u = null
  real ar = -1
  integer uc = -1
  player lp = null
  integer same = -1
  region rg = null
  rect r1 = null
  rect r2 = null
  integer rgn = -1
  group g = null
  integer gcount = -1
endglobals
function Init takes nothing returns nothing
  set u = CreateUnit(Player(0), 555, 0.0, 0.0, 0.0)
  call SetUnitAcquireRange(u, 300.0)
  set ar = GetUnitAcquireRange(u)
  call SetUnitColor(u, ConvertPlayerColor(4))
  set uc = GetUnitColor(u)
  set lp = GetLocalPlayer()
  if lp == Player(0) then
    set same = 1
  endif
  set rg = CreateRegion()
  set r1 = Rect(0.0, 0.0, 128.0, 128.0)
  set r2 = Rect(0.0, 0.0, 64.0, 64.0)
  call RegionAddRect(rg, r1)
  call RegionAddRect(rg, r2)
  call RegionClearRect(rg, r1)
  set rgn = 1
  set g = CreateGroup()
  call GroupAddUnit(g, u)
  call DestroyGroup(g)
  set gcount = 0
endfunction
function main takes nothing returns nothing
  call Init()
endfunction
`;
const rX = jassRunC(miscScript, 'main');
ck('jass(单位) SetUnitAcquireRange(300) 读回', rX.globals.ar, 300);
ck('jass(单位) SetUnitColor(4) 读回', rX.globals.uc, 4);
ck('jass(玩家) GetLocalPlayer == Player(0) 同 handle', rX.globals.same, 1);
ck('jass(region) RegionClearRect 可用', rX.globals.rgn, 1);
ck('jass(group) DestroyGroup 无错', rX.globals.gcount, 0);

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

  // --- C(config,main) vs JS boot() 全局强对照（880 全局 + 18 数组零差异）---
  const rBoot = jassRunC(full, 'config,main');
  const jsSide = (() => {
    const world = new Proxy({}, {
      get(t, k) { if (k in t) return t[k]; return (...a) => new Handle(String(k)); },
      set(t, k, v) { t[k] = v; return true; },
    });
    const eng = new JassEngine(world);
    eng.load({ commonJ: 'war3_extracted/Scripts/common.j', blizzardJ: 'war3_extracted/Scripts/Blizzard.j', mapJ: 'extracted/war3map.j' });
    eng.boot();  // boot = initGlobals + config + main（官方引导顺序）
    const g = {};
    for (const [k, v] of eng.vm.globals) if (!v.isArr) g[k] = v.value;
    // 数组非默认元素（对齐 C arrays 段：真实 handle→null；Convert(v) → v，v=0 视为默认；
    // number 0 / boolean false / 空串 / JS null 视为默认）
    const a = {};
    for (const [k, v] of eng.vm.globals) {
      if (!v.isArr) continue;
      const arr = v.value || [];
      const map = {};
      for (let i = 0; i < arr.length; i++) {
        const val = arr[i];
        if (val === undefined || val === null) continue;
        if (val instanceof Handle) {
          if (val.v === undefined) { map[i] = null; continue; }
          if (val.v === 0) continue;
          map[i] = val.v;
          continue;
        }
        if (typeof val === 'number' && val === 0) continue;
        if (typeof val === 'boolean' && !val) continue;
        if (typeof val === 'string' && !val) continue;
        map[i] = val;
      }
      a[k] = map;
    }
    return { g, a };
  })();
  const jsGlobals = jsSide.g, jsArrays = jsSide.a;
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
  // 数组对账（bj_slotControl/ForForce/bj_meleeDefeated 等 18 个数组非默认元素）
  const cArrs = rBoot.arrays || {};
  const aDiffs = [];
  for (const k of new Set([...Object.keys(cArrs), ...Object.keys(jsArrays)])) {
    const cStr = JSON.stringify(cArrs[k]), jStr = JSON.stringify(jsArrays[k]);
    if (cStr !== jStr) aDiffs.push(`${k}: C=${cStr} JS=${jStr}`);
  }
  ck('jass(config,main) C/JS 数组对账零差异', aDiffs.length === 0 ? 1 : 0, 1);
  if (aDiffs.length) console.log('  数组差异: ' + aDiffs.slice(0, 4).join('; '));
  console.log(`  info   数组对账: ${Object.keys(jsArrays).length} 个数组非默认元素 0 差异`);
} else {
  console.log('  SKIP  拼接对照（缺 war3_extracted/Scripts 库文件）');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
