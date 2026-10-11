// tools/m4_phase4_test.mjs — M4 阶段 4：验证 server 端 wasm 集成激活
//
// 场景：单玩家开局，验证：
//   1. server 正常发 WELCOME / STATE / SNAPSHOT (JSON)
//   2. 开局后 server 额外推送 SNAPSHOT_BIN 二进制帧（tag 首字节 's'）
//   3. 二进制帧可按 SOA 布局解码：header 5 float + nUnits × 15 列 + gold16 + ...
//   4. 至少收到 1 帧 binary 快照，tick 字段随时间推进
//   5. 二进制快照里的 nUnits 与 JSON 快照 ents 数对比（wasm 是子集）
//
// 用法：
//   node server/index.js                 # 先启动 server（默认 PORT=8080）
//   PORT=8080 node tools/m4_phase4_test.mjs
//
// 参考：
//   - server/room.js 的 broadcastBinary + _broadcastWasmSnapshot
//   - server/wasm_bridge.js snapshot() 的 SOA 布局
//   - tools/m4_wasm_server_poc.mjs 的 SOA 解码逻辑

import WebSocket from 'ws';

const PORT = process.env.PORT || 8080;
const ROOM = `m4p4test${Date.now()}`;
const WAIT_MS = +(process.env.WAIT_MS || 15000);

let pass = 0, fail = 0;
const check = (ok, what, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? '  -- ' + detail : ''}`);
  ok ? pass++ : fail++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// SOA 布局（与 engine/src/sim.c:1316 一致）：
//   header(5): tick, nowMs, nUnits, nMissiles, nEvents
//   units: nUnits × 15 列（x y facing hp maxHp alive team pi kind mv ga id lvl mana maxMana）
//   gold16
//   missiles × 2
//   events × 4
const SOA_HEADER = 5;
const SOA_COLS = 15;

function decodeSoa(bytes) {
  // tag 1 字节后 SOA 未 4 字节对齐，复制到独立 buffer 再读 Float32Array
  const aligned = new Uint8Array(bytes.length);
  aligned.set(bytes);
  const f = new Float32Array(aligned.buffer, 0, aligned.length / 4);
  const tick = Math.round(f[0]);
  const nowMs = Math.round(f[1]);
  const nUnits = Math.round(f[2]);
  const nMissiles = Math.round(f[3]);
  const nEvents = Math.round(f[4]);
  const units = [];
  for (let i = 0; i < nUnits; i++) {
    const col = (c) => Math.round(f[SOA_HEADER + c * nUnits + i]);
    units.push({
      id: col(SOA_COLS - 4),  // id 列
      x: col(0), y: col(1), facing: f[SOA_HEADER + 2 * nUnits + i],
      hp: col(3), maxHp: col(4), alive: col(5),
      team: col(6), pi: col(7), kind: col(8),
    });
  }
  return { tick, nowMs, nUnits, nMissiles, nEvents, units };
}

// ---- 建连 ----
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?room=${ROOM}`);
ws.binaryType = 'arraybuffer';

let welcomed = false;
let playing = false;
let jsonSnapCount = 0;
let jsonEntsLen = -1;
let binSnapCount = 0;
let binFramesCount = 0;
let lastBin = null;
let firstTick = -1, lastTick = -1;

ws.on('open', () => {
  ws.send(JSON.stringify({ t: 'hello', name: 'P4Test' }));
});

ws.on('message', (data, isBinary) => {
  if (isBinary) {
    binFramesCount++;
    const buf = new Uint8Array(data);
    if (buf.length < 1) return;
    const tag = String.fromCharCode(buf[0]);
    // tag 's' 对应 Msg.SNAPSHOT_BIN
    if (tag === 's') {
      binSnapCount++;
      const soaBytes = buf.subarray(1);
      const dec = decodeSoa(soaBytes);
      if (firstTick < 0) firstTick = dec.tick;
      lastTick = dec.tick;
      lastBin = dec;
    }
    return;
  }
  const m = JSON.parse(data.toString());
  if (m.t === 'welcome') {
    welcomed = true;
    // 单玩家就绪即开局
    setTimeout(() => ws.send(JSON.stringify({ t: 'ready', ready: true })), 100);
  } else if (m.t === 'state' && m.phase === 'playing') {
    playing = true;
  } else if (m.t === 'snap') {
    jsonSnapCount++;
    jsonEntsLen = (m.s?.ents || []).length;
  }
});

// ---- 等 welcome ----
let waited = 0;
while (!welcomed && waited < 5000) { await wait(100); waited += 100; }
check(welcomed, '收到 WELCOME');

// ---- 等 playing ----
waited = 0;
while (!playing && waited < 10000) { await wait(100); waited += 100; }
check(playing, '进入 PLAYING 阶段');

// ---- 等 binary 快照 ----
waited = 0;
while (binSnapCount === 0 && waited < WAIT_MS) { await wait(100); waited += 100; }
check(binSnapCount > 0, '收到至少 1 帧 binary 快照', `count=${binSnapCount} frames=${binFramesCount}`);

// ---- 等若干 JSON 快照做对照 ----
waited = 0;
while (jsonSnapCount < 3 && waited < 5000) { await wait(100); waited += 100; }
check(jsonSnapCount > 0, '同时收到 JSON 快照', `json=${jsonSnapCount} bin=${binSnapCount}`);

// ---- 校验解码 ----
if (lastBin) {
  check(lastBin.nUnits >= 0, 'binary 快照 nUnits 合法', `nUnits=${lastBin.nUnits}`);
  check(lastBin.tick > 0, 'binary 快照 tick 已推进', `tick=${lastBin.tick}`);
  if (lastBin.units.length > 0) {
    const u = lastBin.units[0];
    check(Number.isFinite(u.x) && Number.isFinite(u.y), '单位坐标可解码', `id=${u.id} x=${u.x} y=${u.y} hp=${u.hp}/${u.maxHp}`);
  }
  // wasm 快照是 JSON 快照的子集（wasm 只认识 hfoo/hwat/hpea/建筑等）
  if (jsonEntsLen >= 0 && lastBin.nUnits >= 0) {
    check(lastBin.nUnits <= jsonEntsLen + 5, 'wasm nUnits ≤ JSON ents（允许小幅偏差）',
      `wasm=${lastBin.nUnits} json=${jsonEntsLen}`);
  }
}

// ---- tick 推进检查（再等一拍，看 tick 是否增加）----
if (lastBin && lastTick >= 0) {
  const t0 = lastTick;
  await wait(500);
  check(lastTick > t0 || lastBin.tick > t0, 'binary 快照 tick 持续推进',
    `t0=${t0} t1=${lastTick}`);
}

ws.close();

console.log(`\n${'='.repeat(60)}`);
console.log(`M4 phase4 汇总：${pass} passed, ${fail} failed`);
console.log(`  binary frames: ${binFramesCount}, snapshots: ${binSnapCount}, json: ${jsonSnapCount}`);
console.log(`  first tick: ${firstTick}, last tick: ${lastTick}`);
if (lastBin && lastBin.units.length) {
  console.log(`  sample unit: id=${lastBin.units[0].id} kind=${lastBin.units[0].kind} team=${lastBin.units[0].team}`);
}
console.log(`  json ents: ${jsonEntsLen}`);
console.log(`${'='.repeat(60)}`);
process.exit(fail ? 1 : 0);
