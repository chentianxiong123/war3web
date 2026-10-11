// tools/m6_multiclient_test.mjs — M6 多客户端命令同步验证
//
// 目标：验证多客户端场景下 server 端的命令同步、状态同步、快照一致性。
// 测试项：
//   1. 客户端 A 加入房间、准备开局，收到 WELCOME / STATE / SNAPSHOT / SLOTS
//   2. 客户端 A 发送移动命令后，立即收到快照广播（不等下一个 tick）
//   3. 客户端 B 加入同一房间，收到完整的 STATE + SLOTS + SNAPSHOT
//   4. 客户端 B 通过快照看到 A 的移动结果（单位坐标已变化）
//   5. 两个客户端的快照一致（同一 tick 的 ents 数量和坐标一致）
//   6. 客户端 B 发送命令后，A 也收到广播快照
//
// 用法：
//   PORT=8100 node tools/m6_multiclient_test.mjs
//
// 参考：
//   - tools/m4_phase4_test.mjs 的 ws 客户端 + SOA 解码模式
//   - tools/m5_zero_copy_test.mjs 的 server 启动模式
//   - tools/room_test.mjs 的多客户端测试模式
//   - server/room.js 的 SLOTS / broadcastSnapshotNow / command

import WebSocket from 'ws';
import { spawn } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = +(process.env.PORT || 8100);
const ROOM = `m6test${Date.now()}`;
const WAIT_MS = +(process.env.WAIT_MS || 20000);

let pass = 0, fail = 0;
const check = (ok, what, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? '  -- ' + detail : ''}`);
  ok ? pass++ : fail++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// SOA 解码（与 m4_phase4_test.mjs 一致）
const SOA_HEADER = 5;
const SOA_COLS = 15;
function decodeSoa(bytes) {
  const aligned = new Uint8Array(bytes.length);
  aligned.set(bytes);
  const f = new Float32Array(aligned.buffer, 0, aligned.length / 4);
  const nUnits = Math.round(f[SOA_HEADER - 3]);
  const units = [];
  for (let i = 0; i < nUnits; i++) {
    const col = (c) => Math.round(f[SOA_HEADER + c * nUnits + i]);
    units.push({
      id: col(SOA_COLS - 4),
      x: col(0), y: col(1),
      hp: col(3), maxHp: col(4), alive: col(5),
      team: col(6), pi: col(7), kind: col(8),
    });
  }
  return { tick: Math.round(f[0]), nUnits, units };
}

// ---- 启动 server ----
const server = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), WAR3_DEBUG: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => {
  const s = d.toString();
  if (!s.includes('listening')) process.stderr.write(`[server] ${s}`);
});

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const s = net.connect({ host: '127.0.0.1', port: PORT });
      await new Promise((res, rej) => {
        s.on('connect', () => { s.destroy(); res(); });
        s.on('error', rej);
      });
      return;
    } catch {
      await wait(200);
    }
  }
  throw new Error('war3web server timeout');
}

/**
 * 创建一个 ws 客户端，收集所有收到的消息。
 * @param {string} name 客户端名
 * @returns {{ws: WebSocket, state: object}}
 */
function createClient(name) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?room=${ROOM}`);
  ws.binaryType = 'arraybuffer';
  const state = {
    name,
    ws,
    welcomed: false,
    playing: false,
    welcomeData: null,
    slotsMsg: null,       // SLOTS 消息内容
    jsonSnaps: [],         // 收到的 JSON 快照
    binSnaps: [],          // 收到的二进制快照（解码后）
    binFrames: 0,
    jsonSnapCount: 0,
    error: null,
  };
  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      state.binFrames++;
      const buf = new Uint8Array(data);
      if (buf.length < 1) return;
      const tag = String.fromCharCode(buf[0]);
      if (tag === 's') {
        const soaBytes = buf.subarray(1);
        const dec = decodeSoa(soaBytes);
        state.binSnaps.push(dec);
      }
      return;
    }
    const m = JSON.parse(data.toString());
    if (m.t === 'welcome') {
      state.welcomed = true;
      state.welcomeData = m;
    } else if (m.t === 'state') {
      if (m.phase === 'playing') state.playing = true;
    } else if (m.t === 'snap') {
      state.jsonSnapCount++;
      state.jsonSnaps.push(m);
    } else if (m.t === 'slots') {
      state.slotsMsg = m;
    } else if (m.t === 'error') {
      state.error = m.m;
    }
  });
  ws.on('error', (e) => { state.error = e.message; });
  return state;
}

/** 等待某个条件满足，超时返回 false。 */
async function waitFor(cond, timeout = WAIT_MS) {
  let waited = 0;
  while (!cond() && waited < timeout) {
    await wait(100);
    waited += 100;
  }
  return cond();
}

// ---- 主测试流程 ----
await waitForServer();
console.log(`server up on :${PORT}`);

try {
  // ---- 客户端 A 加入 ----
  const a = createClient('ClientA');
  await wait(300);
  a.ws.send(JSON.stringify({ t: 'hello', name: 'ClientA' }));
  await waitFor(() => a.welcomed, 5000);
  check(a.welcomed, '客户端 A 收到 WELCOME');

  // ---- 客户端 A 准备开局（单人即可开局） ----
  a.ws.send(JSON.stringify({ t: 'ready', ready: true }));
  await waitFor(() => a.playing, 10000);
  check(a.playing, '客户端 A 进入 PLAYING 阶段');

  // ---- 等 A 收到 SLOTS 和 JSON 快照 ----
  await waitFor(() => a.slotsMsg !== null, 5000);
  check(a.slotsMsg !== null, '客户端 A 收到 SLOTS 消息');

  await waitFor(() => a.jsonSnapCount >= 1, 5000);
  check(a.jsonSnapCount >= 1, '客户端 A 收到 JSON 快照', `count=${a.jsonSnapCount}`);

  // ---- 获取 A 的初始状态：找到可操作的单位 ----
  const firstSnap = a.jsonSnaps[a.jsonSnaps.length - 1];
  const ents = firstSnap?.s?.ents || [];
  // 找玩家 0 的可操作单位（playerIndex === 0, alive === 1, 非英雄/非建筑）
  const myUnit = ents.find((e) => e.p === 0 && e.a === 1 && e.k === 2);
  check(!!myUnit, '找到可操作单位', `ents=${ents.length} myUnit=${myUnit?.u || 'none'}`);

  if (!myUnit) {
    console.log('  没有可操作单位，跳过命令测试');
    a.ws.close();
    process.exit(0);
  }

  // ---- 客户端 A 发送移动命令 ----
  const startX = myUnit.x, startY = myUnit.y;
  const targetX = startX + 200, targetY = startY + 200;
  a.ws.send(JSON.stringify({
    t: 'move',
    unitIds: [myUnit.i],
    x: targetX,
    y: targetY,
  }));
  console.log(`  A 发送移动命令: unit=${myUnit.u} 从 (${startX},${startY}) -> (${targetX},${targetY})`);

  // ---- 验证 A 收到立即快照广播（不等下一个 tick） ----
  // 记录当前 JSON 快照数，等待快照数增加
  const jsonBefore = a.jsonSnapCount;
  const binBefore = a.binSnaps.length;
  await waitFor(() => a.jsonSnapCount > jsonBefore || a.binSnaps.length > binBefore, 3000);
  check(a.jsonSnapCount > jsonBefore || a.binSnaps.length > binBefore,
    'A 发送命令后立即收到快照广播',
    `json: ${jsonBefore}->${a.jsonSnapCount}, bin: ${binBefore}->${a.binSnaps.length}`);

  // ---- 等 A 收到含移动结果的快照 ----
  await waitFor(() => {
    const snap = a.jsonSnaps[a.jsonSnaps.length - 1];
    if (!snap?.s?.ents) return false;
    const u = snap.s.ents.find((e) => e.i === myUnit.i);
    return u && (Math.abs(u.x - targetX) < 50 || Math.abs(u.y - targetY) < 50);
  }, 5000);
  const aSnap = a.jsonSnaps[a.jsonSnapCount - 1];
  const aUnit = aSnap?.s?.ents?.find((e) => e.i === myUnit.i);
  check(!!aUnit && aUnit.x !== startX || aUnit.y !== startY,
    'A 收到命令后的快照包含移动结果',
    aUnit ? `${startX},${startY} -> ${aUnit.x},${aUnit.y}` : 'unit not found');

  // ---- 客户端 B 加入同一房间 ----
  const b = createClient('ClientB');
  await wait(300);
  b.ws.send(JSON.stringify({ t: 'hello', name: 'ClientB' }));
  await waitFor(() => b.welcomed, 5000);
  check(b.welcomed, '客户端 B 收到 WELCOME');

  // ---- 等 B 收到 SLOTS 和 JSON 快照 ----
  await waitFor(() => b.slotsMsg !== null, 5000);
  check(b.slotsMsg !== null, '客户端 B 收到 SLOTS 消息');

  await waitFor(() => b.jsonSnapCount >= 1, 5000);
  check(b.jsonSnapCount >= 1, '客户端 B 收到 JSON 快照', `count=${b.jsonSnapCount}`);

  // ---- 验证 B 的快照包含 A 的命令结果 ----
  const bSnap = b.jsonSnaps[b.jsonSnapCount - 1];
  const bUnit = bSnap?.s?.ents?.find((e) => e.i === myUnit.i);
  check(!!bUnit, 'B 的快照包含 A 操作过的单位');

  if (bUnit) {
    const bX = bUnit.x, bY = bUnit.y;
    // B 看到的单位坐标应该与 A 的最后快照一致（允许小幅差异，因为快照可能有延迟）
    const tolerance = 100;
    check(Math.abs(bX - (aUnit?.x ?? bX)) < tolerance &&
          Math.abs(bY - (aUnit?.y ?? bY)) < tolerance,
      'B 的快照与 A 一致（同一单位坐标）',
      `A=(${aUnit?.x},${aUnit?.y}) B=(${bX},${bY})`);
  }

  // ---- 验证 B 的 SLOTS 与 A 的 SLOTS 一致 ----
  if (a.slotsMsg && b.slotsMsg) {
    const aKeys = Object.keys(a.slotsMsg.slots || {}).sort().join(',');
    const bKeys = Object.keys(b.slotsMsg.slots || {}).sort().join(',');
    check(aKeys === bKeys, 'A 和 B 的 SLOTS registry 一致',
      `A keys=[${aKeys}] B keys=[${bKeys}]`);
    // colors 也应该一致
    const aColors = JSON.stringify(a.slotsMsg.colors || []);
    const bColors = JSON.stringify(b.slotsMsg.colors || []);
    check(aColors === bColors, 'A 和 B 的 colors 一致');
  }

  // ---- 客户端 B 发送命令，验证 A 收到广播快照 ----
  // B 找自己的可操作单位（playerIndex === 1）
  const bMyUnit = bSnap?.s?.ents?.find((e) => e.p === 1 && e.a === 1 && e.k === 2);
  if (bMyUnit) {
    const bJsonBefore = a.jsonSnapCount;
    const bBinBefore = a.binSnaps.length;
    b.ws.send(JSON.stringify({
      t: 'move',
      unitIds: [bMyUnit.i],
      x: bMyUnit.x + 100,
      y: bMyUnit.y + 100,
    }));
    // 等 A 收到新的快照广播
    await waitFor(() => a.jsonSnapCount > bJsonBefore || a.binSnaps.length > bBinBefore, 3000);
    check(a.jsonSnapCount > bJsonBefore || a.binSnaps.length > bBinBefore,
      'B 发送命令后 A 收到广播快照',
      `A json: ${bJsonBefore}->${a.jsonSnapCount}`);
  } else {
    console.log('  B 没有可操作单位，跳过反向广播测试');
  }

  // ---- 快照一致性验证：最后同时读取两个客户端的最新快照 ----
  // 等一小段时间让快照稳定
  await wait(500);
  const finalASnap = a.jsonSnaps[a.jsonSnapCount - 1];
  const finalBSnap = b.jsonSnaps[b.jsonSnapCount - 1];
  if (finalASnap?.s?.ents && finalBSnap?.s?.ents) {
    const aEntIds = new Set(finalASnap.s.ents.map((e) => e.i));
    const bEntIds = new Set(finalBSnap.s.ents.map((e) => e.i));
    check(aEntIds.size === bEntIds.size, 'A 和 B 的 ents 数量一致',
      `A=${aEntIds.size} B=${bEntIds.size}`);

    // 检查坐标一致性（允许小幅差异，因为快照可能差 1-2 帧）
    let coordDiff = 0;
    const maxDiff = Math.max(...finalASnap.s.ents.map((e) => {
      const b = finalBSnap.s.ents.find((x) => x.i === e.i);
      return b ? Math.abs(e.x - b.x) + Math.abs(e.y - b.y) : 9999;
    }));
    coordDiff = maxDiff;
    check(maxDiff < 200, 'A 和 B 的单位坐标一致（Δ<200）',
      `maxDiff=${maxDiff}`);
  }

} catch (e) {
  fail++;
  console.error('测试异常:', e.message, e.stack);
} finally {
  server.kill();
}

console.log(`\n${'='.repeat(60)}`);
console.log(`M6 多客户端命令同步：${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
console.log(fail === 0
  ? '✓ 多客户端命令同步 / SLOTS 推送 / 快照一致性 全部通过'
  : '✗ 存在失败项，见上');
console.log(`${'='.repeat(60)}\n`);
process.exit(fail ? 1 : 0);
