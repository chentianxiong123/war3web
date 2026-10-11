// tools/m6_gpu_buffer_test.mjs — M6 GPU buffer 容量验证
//
// 目标：验证 client 端 M5_MAX_UNITS=512 GPU buffer 的容量与降级行为。
// 测试项：
//   1. 边界内：512 单位全部写入，unitPosCount = 512，instanceCount = 512
//   2. 边界内：256 / 384 / 511 单位精确写入
//   3. 溢出：600 单位（> 512）截断到 512，不崩溃、不越界、多余单位静默丢弃
//   4. 溢出：1000 单位（远超上限）同样截断，验证不破坏 GPU buffer 内存
//   5. 复用：1 单位 → 512 单位 → 0 单位 → 256 单位循环，buffer 可重复更新
//   6. buffer 更新耗时：100 / 300 / 512 单位的 updateFromBinary 耗时（客户端帧率预算）
//
// 用法：node tools/m6_gpu_buffer_test.mjs
//
// 参考：
//   - tools/m5_gpu_buffer_test.mjs（GPU buffer 上传路径验证，2 单位精确匹配）
//   - tools/m5_gpu_test.html（测试页面模板）
//   - client/js/render.js:121 updateFromBinary + M5_MAX_UNITS=512
//   - client/js/render.js:403-405 unitPosAttr / unitColorAttr 常驻 buffer
//
// 注意：此测试启动 war3web server 提供 /three/ 和 /js/ 静态资源，
// 使用 puppeteer-core + swiftshader（headless WebGPU）。
// 不依赖 wasm engine，直接构造合成 SOA buffer（与 m5_gpu_buffer_test.mjs 一致）。

import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { CHROME } from "./chrome.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = +(process.env.PORT || 8099);

// SOA 布局常量（与 client/js/render.js 一致）
const SOA_HEADER = 5;
const SOA_COLS = 15;
const SOA_COL = {
  X: 0, Y: 1, FACING: 2, HP: 3, MAX_HP: 4, ALIVE: 5, TEAM: 6, PI: 7,
  KIND: 8, MOVING: 9, GATHERING: 10, ID: 11, LEVEL: 12, MANA: 13, MAX_MANA: 14,
};
const M5_MAX_UNITS = 512;

// ---- 启动 war3web server（提供 /three/ 和 /js/ 静态资源）----
const server = spawn(process.execPath, ["server/index.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), FOC_DEBUG: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
server.stderr.on("data", (d) => {
  const s = d.toString();
  if (!s.includes("listening")) process.stderr.write(`[server] ${s}`);
});

async function waitForServer() {
  for (let i = 0; i < 100; i++) {
    try {
      const s = net.connect({ host: "127.0.0.1", port: PORT });
      await new Promise((res, rej) => {
        s.on("connect", () => { s.destroy(); res(); });
        s.on("error", rej);
      });
      return;
    } catch {
      await new Promise(r => setTimeout(r, 200));
    }
  }
  throw new Error("war3web server timeout");
}

/**
 * 构造合成 SOA Float32Array：
 * header(5) tick,nowMs,nUnits,nMissiles,nEvents
 * + 15 列 × nUnits floats
 * 每个单位 i：pos(i*10, i*20) facing=0 hp=100 maxHp=100 alive=1 team=(i%3) pi=(i%4) id=i
 *
 * 单位 i 的 ALIVE 列：i < aliveCount 时 alive=1，否则 alive=0（用于测试混合场景）
 *
 * @param {number} nUnits 单位总数
 * @param {number} [aliveCount=nUnits] 存活单位数（用于部分死亡场景）
 * @returns {ArrayBuffer} 可直接喂给 view.updateFromBinary 的 ArrayBuffer
 */
function buildSOA(nUnits, aliveCount = nUnits) {
  const floats = new Float32Array(5 + SOA_COLS * nUnits);
  floats[0] = 1000;      // tick
  floats[1] = 10000;     // nowMs
  floats[2] = nUnits;    // nUnits
  floats[3] = 0;         // nMissiles
  floats[4] = 0;         // nEvents

  const col = (c, i) => 5 + c * nUnits + i;
  for (let i = 0; i < nUnits; i++) {
    floats[col(SOA_COL.X, i)] = i * 10;
    floats[col(SOA_COL.Y, i)] = i * 20;
    floats[col(SOA_COL.FACING, i)] = 0;
    floats[col(SOA_COL.HP, i)] = 100;
    floats[col(SOA_COL.MAX_HP, i)] = 100;
    floats[col(SOA_COL.ALIVE, i)] = (i < aliveCount) ? 1 : 0;
    floats[col(SOA_COL.TEAM, i)] = i % 3;
    floats[col(SOA_COL.PI, i)] = i % 4;
    floats[col(SOA_COL.KIND, i)] = 1;
    floats[col(SOA_COL.MOVING, i)] = 0;
    floats[col(SOA_COL.GATHERING, i)] = 0;
    floats[col(SOA_COL.ID, i)] = i;
    floats[col(SOA_COL.LEVEL, i)] = 1;
    floats[col(SOA_COL.MANA, i)] = 0;
    floats[col(SOA_COL.MAX_MANA, i)] = 0;
  }
  return floats.buffer;
}

// ---- 检查器 ----
let failed = 0, passed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; console.log(`  ok   ${name}${detail ? "  -- " + detail : ""}`); }
  else { failed++; console.log(`  FAIL ${name}${detail ? "  -- " + detail : ""}`); }
}

// ---- 浏览器端测试脚本（内联在 evaluate 里）----
// 暴露给主进程的测试钩子：构造 SOA、调用 updateFromBinary、读回 buffer 状态。
async function runTests(page) {
  console.log("\n=== 1. 容量边界内测试（1 / 256 / 384 / 511 / 512） ===");
  for (const nUnits of [1, 256, 384, 511, 512]) {
    const b64 = Buffer.from(buildSOA(nUnits)).toString("base64");
    const res = await page.evaluate(async ({ b64, nUnits }) => {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const buf = bytes.buffer;
      const view = window.view;
      const ret = view.updateFromBinary(buf, {}, []);
      // 采样几个位置验证
      const posAt = (i) => [
        view.unitPosData[i * 4 + 0],
        view.unitPosData[i * 4 + 1],
        view.unitPosData[i * 4 + 2],
        view.unitPosData[i * 4 + 3],
      ];
      const colorAt = (i) => [
        view.unitColorData[i * 3 + 0],
        view.unitColorData[i * 3 + 1],
        view.unitColorData[i * 3 + 2],
      ];
      return {
        nUnits: ret.nUnits,
        n: ret.n,
        unitPosCount: view.unitPosCount,
        instanceCount: view.unitMarker?.geometry?.instanceCount,
        posVersion: view.unitPosAttr.version,
        colorVersion: view.unitColorAttr.version,
        posAt0: posAt(0),
        posAtLast: posAt(nUnits - 1),
        colorAt0: colorAt(0),
        colorAtLast: colorAt(nUnits - 1),
      };
    }, { b64, nUnits });

    check(`${nUnits} 单位: ret.nUnits = ${nUnits}`, res.nUnits === nUnits, `got ${res.nUnits}`);
    check(`${nUnits} 单位: ret.n = ${nUnits}`, res.n === nUnits, `got ${res.n}`);
    check(`${nUnits} 单位: unitPosCount = ${nUnits}`, res.unitPosCount === nUnits, `got ${res.unitPosCount}`);
    check(`${nUnits} 单位: instanceCount = ${nUnits}`, res.instanceCount === nUnits, `got ${res.instanceCount}`);
    check(`${nUnits} 单位: unitPosAttr.version > 0`, res.posVersion > 0, `version=${res.posVersion}`);
    check(`${nUnits} 单位: unitColorAttr.version > 0`, res.colorVersion > 0, `version=${res.colorVersion}`);

    // 边界内：pos[0] 应为 (0, 0, 0, 1)（i=0 时 X=0, Y=0, FACING=0, ALIVE=1）
    const eps = 0.01;
    check(`${nUnits} 单位: pos[0] = (0, 0, 0, 1)`,
      Math.abs(res.posAt0[0]) < eps && Math.abs(res.posAt0[1]) < eps &&
      Math.abs(res.posAt0[2]) < eps && Math.abs(res.posAt0[3] - 1) < eps,
      `got (${res.posAt0.map(v => v.toFixed(2))})`);

    // pos[nUnits-1]：X = (nUnits-1)*10, Y = (nUnits-1)*20
    const expX = (nUnits - 1) * 10;
    const expY = (nUnits - 1) * 20;
    check(`${nUnits} 单位: pos[${nUnits-1}] = (${expX}, ${expY}, 0, 1)`,
      Math.abs(res.posAtLast[0] - expX) < eps &&
      Math.abs(res.posAtLast[1] - expY) < eps &&
      Math.abs(res.posAtLast[2]) < eps &&
      Math.abs(res.posAtLast[3] - 1) < eps,
      `got (${res.posAtLast.map(v => v.toFixed(2))})`);
  }

  console.log("\n=== 2. 溢出测试（600 / 1000 单位 → 截断到 512） ===");
  for (const nUnits of [600, 1000]) {
    const b64 = Buffer.from(buildSOA(nUnits)).toString("base64");
    const res = await page.evaluate(async ({ b64 }) => {
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      const buf = bytes.buffer;
      const view = window.view;
      // 记录调用前的 buffer 状态，验证不越界写入
      const posDataLen = view.unitPosData.length;   // 应为 512*4 = 2048
      const colorDataLen = view.unitColorData.length;  // 应为 512*3 = 1536
      const ret = view.updateFromBinary(buf, {}, []);
      // 采样边界前后
      const posAt = (i) => [
        view.unitPosData[i * 4 + 0], view.unitPosData[i * 4 + 1],
        view.unitPosData[i * 4 + 2], view.unitPosData[i * 4 + 3],
      ];
      // posData 长度不应因溢出调用而改变
      return {
        nUnits: ret.nUnits,
        n: ret.n,
        unitPosCount: view.unitPosCount,
        instanceCount: view.unitMarker?.geometry?.instanceCount,
        posAt511: posAt(511),   // 最后一个有效单位
        posDataLen,
        colorDataLen,
      };
    }, { b64 });

    check(`${nUnits} 单位: ret.nUnits = ${nUnits}`, res.nUnits === nUnits, `got ${res.nUnits}`);
    check(`${nUnits} 单位: ret.n 截断到 512`, res.n === 512, `got ${res.n}`);
    check(`${nUnits} 单位: unitPosCount = 512`, res.unitPosCount === 512, `got ${res.unitPosCount}`);
    check(`${nUnits} 单位: instanceCount = 512`, res.instanceCount === 512, `got ${res.instanceCount}`);
    check(`${nUnits} 单位: unitPosData 长度保持 2048`, res.posDataLen === 2048, `got ${res.posDataLen}`);
    check(`${nUnits} 单位: unitColorData 长度保持 1536`, res.colorDataLen === 1536, `got ${res.colorDataLen}`);

    // pos[511]：X=5110, Y=10220
    const eps = 0.01;
    check(`${nUnits} 单位: pos[511] = (5110, 10220, 0, 1)`,
      Math.abs(res.posAt511[0] - 5110) < eps &&
      Math.abs(res.posAt511[1] - 10220) < eps &&
      Math.abs(res.posAt511[2]) < eps &&
      Math.abs(res.posAt511[3] - 1) < eps,
      `got (${res.posAt511.map(v => v.toFixed(2))})`);
  }

  console.log("\n=== 3. buffer 复用测试（1 → 512 → 0 → 256 循环） ===");
  const cycle = await page.evaluate(() => {
    const view = window.view;
    const out = [];
    // 步骤 1: 1 单位
    const buf1 = new Float32Array(5 + 15 * 1);
    buf1[0] = 2000; buf1[1] = 20000; buf1[2] = 1; buf1[3] = 0; buf1[4] = 0;
    buf1[5] = 100; buf1[6] = 200; buf1[7] = 1.0; buf1[10] = 1; buf1[12] = 0; buf1[13] = 50;
    view.updateFromBinary(buf1.buffer, {}, []);
    out.push({ step: "1 单位", n: view.unitPosCount, inst: view.unitMarker?.geometry?.instanceCount,
      pos0: [view.unitPosData[0], view.unitPosData[1], view.unitPosData[2], view.unitPosData[3]] });

    // 步骤 2: 512 单位
    const buf2 = new Float32Array(5 + 15 * 512);
    buf2[0] = 3000; buf2[1] = 30000; buf2[2] = 512; buf2[3] = 0; buf2[4] = 0;
    for (let i = 0; i < 512; i++) {
      buf2[5 + 0 * 512 + i] = i;        // X
      buf2[5 + 1 * 512 + i] = i * 2;   // Y
      buf2[5 + 2 * 512 + i] = 0;       // FACING
      buf2[5 + 5 * 512 + i] = 1;       // ALIVE
      buf2[5 + 11 * 512 + i] = i;      // ID
    }
    view.updateFromBinary(buf2.buffer, {}, []);
    out.push({ step: "512 单位", n: view.unitPosCount, inst: view.unitMarker?.geometry?.instanceCount,
      pos0: [view.unitPosData[0], view.unitPosData[1], view.unitPosData[2], view.unitPosData[3]],
      pos511: [view.unitPosData[511*4], view.unitPosData[511*4+1], view.unitPosData[511*4+2], view.unitPosData[511*4+3]] });

    // 步骤 3: 0 单位（清空）
    const buf3 = new Float32Array(5);
    buf3[0] = 4000; buf3[1] = 40000; buf3[2] = 0; buf3[3] = 0; buf3[4] = 0;
    view.updateFromBinary(buf3.buffer, {}, []);
    out.push({ step: "0 单位", n: view.unitPosCount, inst: view.unitMarker?.geometry?.instanceCount });

    // 步骤 4: 256 单位
    const buf4 = new Float32Array(5 + 15 * 256);
    buf4[0] = 5000; buf4[1] = 50000; buf4[2] = 256; buf4[3] = 0; buf4[4] = 0;
    for (let i = 0; i < 256; i++) {
      buf4[5 + 0 * 256 + i] = 1000 + i;   // X
      buf4[5 + 1 * 256 + i] = 2000 + i;   // Y
      buf4[5 + 2 * 256 + i] = 0;
      buf4[5 + 5 * 256 + i] = 1;
      buf4[5 + 11 * 256 + i] = i;
    }
    view.updateFromBinary(buf4.buffer, {}, []);
    out.push({ step: "256 单位", n: view.unitPosCount, inst: view.unitMarker?.geometry?.instanceCount,
      pos0: [view.unitPosData[0], view.unitPosData[1], view.unitPosData[2], view.unitPosData[3]] });

    return out;
  });

  check("循环 1→512→0→256: 1 单位 n=1", cycle[0].n === 1, `n=${cycle[0].n}`);
  check("循环 1→512→0→256: 1 单位 inst=1", cycle[0].inst === 1, `inst=${cycle[0].inst}`);
  check("循环 1→512→0→256: 512 单位 n=512", cycle[1].n === 512, `n=${cycle[1].n}`);
  check("循环 1→512→0→256: 512 单位 inst=512", cycle[1].inst === 512, `inst=${cycle[1].inst}`);
  check("循环 1→512→0→256: 512 单位 pos[511] = (511, 1022, 0, 1)",
    Math.abs(cycle[1].pos511[0] - 511) < 0.01 &&
    Math.abs(cycle[1].pos511[1] - 1022) < 0.01 &&
    Math.abs(cycle[1].pos511[2]) < 0.01 &&
    Math.abs(cycle[1].pos511[3] - 1) < 0.01,
    `got (${cycle[1].pos511.map(v => v.toFixed(2))})`);
  check("循环 1→512→0→256: 0 单位 n=0", cycle[2].n === 0, `n=${cycle[2].n}`);
  check("循环 1→512→0→256: 0 单位 inst=0", cycle[2].inst === 0, `inst=${cycle[2].inst}`);
  check("循环 1→512→0→256: 256 单位 n=256", cycle[3].n === 256, `n=${cycle[3].n}`);
  check("循环 1→512→0→256: 256 单位 inst=256", cycle[3].inst === 256, `inst=${cycle[3].inst}`);
  check("循环 1→512→0→256: 256 单位 pos[0] = (1000, 2000, 0, 1)",
    Math.abs(cycle[3].pos0[0] - 1000) < 0.01 &&
    Math.abs(cycle[3].pos0[1] - 2000) < 0.01 &&
    Math.abs(cycle[3].pos0[3] - 1) < 0.01,
    `got (${cycle[3].pos0.map(v => v.toFixed(2))})`);

  console.log("\n=== 4. buffer 更新耗时（客户端帧率预算：33.33ms @ 30 fps） ===");
  const timing = await page.evaluate(() => {
    const view = window.view;
    const out = [];
    // 对每个规模，测量 updateFromBinary 的耗时（重复 10 次取平均）
    for (const nUnits of [100, 300, 512]) {
      const floats = new Float32Array(5 + 15 * nUnits);
      floats[0] = 6000; floats[1] = 60000; floats[2] = nUnits; floats[3] = 0; floats[4] = 0;
      for (let i = 0; i < nUnits; i++) {
        floats[5 + 0 * nUnits + i] = i * 10;
        floats[5 + 1 * nUnits + i] = i * 20;
        floats[5 + 5 * nUnits + i] = 1;
        floats[5 + 6 * nUnits + i] = i % 3;
        floats[5 + 11 * nUnits + i] = i;
      }
      const buf = floats.buffer;
      // 预热
      for (let i = 0; i < 5; i++) view.updateFromBinary(buf, {}, []);
      // 测量
      let best = Infinity, total = 0;
      for (let i = 0; i < 10; i++) {
        const t0 = performance.now();
        view.updateFromBinary(buf, {}, []);
        const t1 = performance.now();
        const ms = t1 - t0;
        if (ms < best) best = ms;
        total += ms;
      }
      out.push({
        nUnits,
        minMs: best,
        avgMs: total / 10,
        posBytes: view.unitPosData.byteLength,
        colorBytes: view.unitColorData.byteLength,
      });
    }
    return out;
  });

  const FRAME_BUDGET = 1000 / 30;
  for (const t of timing) {
    const pct = (t.avgMs / FRAME_BUDGET * 100).toFixed(1);
    const status = t.avgMs < FRAME_BUDGET ? "ok" : "FAIL";
    console.log(`  ${status}  ${String(t.nUnits).padStart(3)} 单位: ` +
      `avg ${t.avgMs.toFixed(3)}ms  min ${t.minMs.toFixed(3)}ms  ` +
      `(${pct}% of ${FRAME_BUDGET.toFixed(2)}ms budget)  ` +
      `pos ${t.posBytes}B + color ${t.colorBytes}B`);
  }

  console.log("\n=== 5. 溢出后 buffer 状态完整性（1000 单位溢出后回读 512 单位） ===");
  const integrity = await page.evaluate(() => {
    const view = window.view;
    // 先喂 1000 单位（溢出）
    const big = new Float32Array(5 + 15 * 1000);
    big[0] = 7000; big[1] = 70000; big[2] = 1000; big[3] = 0; big[4] = 0;
    for (let i = 0; i < 1000; i++) {
      big[5 + 0 * 1000 + i] = i;
      big[5 + 1 * 1000 + i] = i * 2;
      big[5 + 5 * 1000 + i] = 1;
      big[5 + 6 * 1000 + i] = i % 3;
      big[5 + 11 * 1000 + i] = i;
    }
    view.updateFromBinary(big.buffer, {}, []);

    // 再喂 100 单位，验证 buffer 不被溢出污染
    const small = new Float32Array(5 + 15 * 100);
    small[0] = 8000; small[1] = 80000; small[2] = 100; small[3] = 0; small[4] = 0;
    for (let i = 0; i < 100; i++) {
      small[5 + 0 * 100 + i] = 1000 + i * 10;
      small[5 + 1 * 100 + i] = 2000 + i * 20;
      small[5 + 5 * 100 + i] = 1;
      small[5 + 11 * 100 + i] = i;
    }
    view.updateFromBinary(small.buffer, {}, []);

    // 读回前 5 个单位
    const posAt = (i) => [view.unitPosData[i*4], view.unitPosData[i*4+1],
      view.unitPosData[i*4+2], view.unitPosData[i*4+3]];
    return {
      n: view.unitPosCount,
      inst: view.unitMarker?.geometry?.instanceCount,
      pos0: posAt(0),
      pos1: posAt(1),
      pos99: posAt(99),
      // pos[100] 及以后应保持上一次 512 单位的值（未被小 buffer 覆盖）
      pos100: posAt(100),
    };
  });

  check("溢出→恢复: unitPosCount = 100", integrity.n === 100, `n=${integrity.n}`);
  check("溢出→恢复: instanceCount = 100", integrity.inst === 100, `inst=${integrity.inst}`);
  const eps = 0.01;
  check("溢出→恢复: pos[0] = (1000, 2000, 0, 1)",
    Math.abs(integrity.pos0[0] - 1000) < eps &&
    Math.abs(integrity.pos0[1] - 2000) < eps &&
    Math.abs(integrity.pos0[3] - 1) < eps,
    `got (${integrity.pos0.map(v => v.toFixed(2))})`);
  check("溢出→恢复: pos[99] = (1000+990, 2000+1980, 0, 1)",
    Math.abs(integrity.pos99[0] - 2010) < eps &&
    Math.abs(integrity.pos99[1] - 4020) < eps &&
    Math.abs(integrity.pos99[3] - 1) < eps,
    `got (${integrity.pos99.map(v => v.toFixed(2))})`);
  // pos[100] 应保持上一次 1000 单位写入的值（100, 200, 0, 1），证明小 buffer 未越界覆盖
  check("溢出→恢复: pos[100] 未被小 buffer 越界覆盖 (100, 200, 0, 1)",
    Math.abs(integrity.pos100[0] - 100) < eps &&
    Math.abs(integrity.pos100[1] - 200) < eps &&
    Math.abs(integrity.pos100[3] - 1) < eps,
    `got (${integrity.pos100.map(v => v.toFixed(2))})`);

  console.log("\n=== 6. 部分存活（500 单位，250 死） ===");
  const mixed = await page.evaluate(() => {
    const view = window.view;
    // 构造 500 单位 SOA，前 250 个 alive=1，后 250 个 alive=0
    const floats = new Float32Array(5 + 15 * 500);
    floats[0] = 9000; floats[1] = 90000; floats[2] = 500; floats[3] = 0; floats[4] = 0;
    for (let i = 0; i < 500; i++) {
      floats[5 + 0 * 500 + i] = i;
      floats[5 + 1 * 500 + i] = i * 2;
      floats[5 + 5 * 500 + i] = (i < 250) ? 1 : 0;   // ALIVE
      floats[5 + 11 * 500 + i] = i;
    }
    view.updateFromBinary(floats.buffer, {}, []);
    // 读 alive 列
    const aliveCount = (n) => {
      let c = 0;
      for (let i = 0; i < n; i++) if (view.unitPosData[i*4+3] > 0.5) c++;
      return c;
    };
    return {
      n: view.unitPosCount,
      inst: view.unitMarker?.geometry?.instanceCount,
      aliveCountIn250: aliveCount(250),
      aliveCountIn500: aliveCount(500),
      posAlive249: view.unitPosData[249*4+3],
      posAlive250: view.unitPosData[250*4+3],
    };
  });
  check("混合存活: unitPosCount = 500", mixed.n === 500, `n=${mixed.n}`);
  check("混合存活: instanceCount = 500", mixed.inst === 500, `inst=${mixed.inst}`);
  check("混合存活: 前 250 单位 alive=1", mixed.aliveCountIn250 === 250, `got ${mixed.aliveCountIn250}`);
  check("混合存活: 全 500 单位 alive 数 = 250", mixed.aliveCountIn500 === 250, `got ${mixed.aliveCountIn500}`);
  check("混合存活: pos[249] alive=1", mixed.posAlive249 === 1, `got ${mixed.posAlive249}`);
  check("混合存活: pos[250] alive=0", mixed.posAlive250 === 0, `got ${mixed.posAlive250}`);
}

// ---- 主流程 ----
let failed_total = 0;
try {
  await waitForServer();
  console.log(`server up on :${PORT}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: [
      "--no-sandbox", "--enable-unsafe-swiftshader", "--use-gl=swiftshader",
      "--disable-dev-shm-usage", "--disable-crash-reporter", "--disable-breakpad",
      "--no-first-run", `--user-data-dir=${path.join(ROOT, ".tmp", "chrome-m6-" + process.pid)}`,
    ],
    defaultViewport: { width: 800, height: 600 },
  });

  const page = await browser.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") console.error("PAGE ERR:", m.text().slice(0, 200));
  });
  page.on("pageerror", (e) => console.error("PAGEERROR:", e.message));

  await page.goto(
    `http://127.0.0.1:${PORT}/tools/m5_gpu_test.html`,
    { waitUntil: "domcontentloaded", timeout: 30000 }
  );
  await page.waitForFunction(() => window.ready === true, { timeout: 30000 });
  console.log("Renderer ready");

  await runTests(page);

  await browser.close();
} catch (e) {
  failed_total++;
  console.error("测试失败:", e.message, e.stack);
} finally {
  server.kill();
}

console.log(`\n${"=".repeat(60)}`);
console.log(`M6 GPU buffer 容量验证：${passed} passed, ${failed} failed`);
console.log(failed + failed_total === 0
  ? "✓ 512 单位容量 / 溢出截断 / 复用 / 更新耗时 全部通过"
  : `✗ 存在 ${failed + failed_total} 项失败`);
console.log(`${"=".repeat(60)}\n`);
process.exit(failed + failed_total > 0 ? 1 : 0);
