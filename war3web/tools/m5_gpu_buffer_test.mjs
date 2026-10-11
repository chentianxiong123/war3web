// tools/m5_gpu_buffer_test.mjs — M5 GPU buffer 上传路径验证
//
// 验证路径：合成 SOA ArrayBuffer → Renderer.updateFromBinary() →
// InstancedBufferAttribute（常驻 GPU buffer 数据）→ needsUpdate 标记 →
// marker mesh instanceCount。
//
// 门禁：
//   - unitPosData 位置/朝向/存活精确匹配输入
//   - unitColorData 团队色正确映射
//   - unitPosAttr.version > 0（needsUpdate 已触发）
//   - unitMarker.geometry.instanceCount = nUnits
//
// 注意：此测试不依赖 wasm engine（与 m5_zero_copy_test.mjs 不同），
// 直接构造合成 SOA buffer，验证 updateFromBinary 的 buffer 写入逻辑。
// 需要 war3web server 提供 /three/ 和 /js/ 静态资源。
import { spawn } from "node:child_process";
import net from "node:net";
import path from "node:path";
import puppeteer from "puppeteer-core";
import { CHROME } from "./chrome.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const PORT = +(process.env.PORT || 8099);

// ---- 启动 war3web server（提供 /three/ 和 /js/ 静态资源）----
const server = spawn(process.execPath, ["server/index.js"], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), WAR3_DEBUG: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});

/** 轮询端口直到 server 就绪。 */
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

let failed = 0;
try {
  await waitForServer();
  console.log(`server up on :${PORT}`);

  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: true,
    args: [
      "--no-sandbox", "--enable-unsafe-swiftshader", "--use-gl=swiftshader",
      "--disable-dev-shm-usage", "--disable-crash-reporter", "--disable-breakpad",
      "--no-first-run", `--user-data-dir=${path.join(ROOT, ".tmp", "chrome-m5-" + process.pid)}`,
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

  // ---- 合成 SOA buffer（2 单位，已知位置/朝向/存活）----
  const result = await page.evaluate(() => {
    const nUnits = 2;
    // header(5 floats) + 15 columns × nUnits floats
    const floats = new Float32Array(5 + 15 * nUnits);
    floats[0] = 100;    // tick
    floats[1] = 1000;   // nowMs
    floats[2] = nUnits; // nUnits
    floats[3] = 0;      // nMissiles
    floats[4] = 0;      // nEvents

    const col = (c, i) => 5 + c * nUnits + i;

    // unit 0: pos(100, 200), facing=1.57, hp=100, maxHp=100, alive=1, team=0, pi=0, kind=1, moving=0, gathering=0, id=42, level=1, mana=0, maxMana=0
    floats[col(0, 0)] = 100;    // X
    floats[col(1, 0)] = 200;    // Y
    floats[col(2, 0)] = 1.57;   // FACING
    floats[col(3, 0)] = 100;    // HP
    floats[col(4, 0)] = 100;    // MAX_HP
    floats[col(5, 0)] = 1;      // ALIVE
    floats[col(6, 0)] = 0;      // TEAM
    floats[col(7, 0)] = 0;      // PI
    floats[col(8, 0)] = 1;      // KIND
    floats[col(9, 0)] = 0;      // MOVING
    floats[col(10, 0)] = 0;     // GATHERING
    floats[col(11, 0)] = 42;    // ID
    floats[col(12, 0)] = 1;     // LEVEL
    floats[col(13, 0)] = 0;     // MANA
    floats[col(14, 0)] = 0;     // MAX_MANA

    // unit 1: pos(300, 400), facing=3.14, hp=200, maxHp=200, alive=1, team=1, pi=1, kind=1, moving=1, gathering=0, id=43, level=2, mana=50, maxMana=50
    floats[col(0, 1)] = 300;    // X
    floats[col(1, 1)] = 400;    // Y
    floats[col(2, 1)] = 3.14;   // FACING
    floats[col(3, 1)] = 200;    // HP
    floats[col(4, 1)] = 200;    // MAX_HP
    floats[col(5, 1)] = 1;      // ALIVE
    floats[col(6, 1)] = 1;      // TEAM
    floats[col(7, 1)] = 1;      // PI
    floats[col(8, 1)] = 1;      // KIND
    floats[col(9, 1)] = 1;      // MOVING
    floats[col(10, 1)] = 0;     // GATHERING
    floats[col(11, 1)] = 43;    // ID
    floats[col(12, 1)] = 2;     // LEVEL
    floats[col(13, 1)] = 50;    // MANA
    floats[col(14, 1)] = 50;    // MAX_MANA

    const view = window.view;
    const ret = view.updateFromBinary(floats.buffer, {}, []);

    return {
      nUnits: ret.nUnits,
      n: ret.n,
      unitPosCount: view.unitPosCount,
      // 位置/朝向/存活 (x, y, f, alive)
      pos0: [view.unitPosData[0], view.unitPosData[1], view.unitPosData[2], view.unitPosData[3]],
      pos1: [view.unitPosData[4], view.unitPosData[5], view.unitPosData[6], view.unitPosData[7]],
      // 颜色 (r, g, b) — team 0 蓝色, team 1 红色
      color0: [view.unitColorData[0], view.unitColorData[1], view.unitColorData[2]],
      color1: [view.unitColorData[3], view.unitColorData[4], view.unitColorData[5]],
      // GPU buffer 上传标记
      posVersion: view.unitPosAttr.version,
      colorVersion: view.unitColorAttr.version,
      posUsage: view.unitPosAttr.usage,
      // marker mesh
      instanceCount: view.unitMarker?.geometry?.instanceCount,
      markerExists: !!view.unitMarker,
      markerVisible: view.unitMarker?.visible,
    };
  });

  // ---- 断言 ----
  const check = (name, cond, detail = "") => {
    if (!cond) failed++;
    console.log(`  ${cond ? "ok  " : "FAIL"}  ${name}${detail ? "  -- " + detail : ""}`);
  };

  check("nUnits === 2", result.nUnits === 2);
  check("n === 2", result.n === 2);
  check("unitPosCount === 2", result.unitPosCount === 2);

  // 位置/朝向/存活精确匹配
  const eps = 0.01;
  check("pos0 = (100, 200, 1.57, 1)",
    Math.abs(result.pos0[0] - 100) < eps &&
    Math.abs(result.pos0[1] - 200) < eps &&
    Math.abs(result.pos0[2] - 1.57) < eps &&
    Math.abs(result.pos0[3] - 1) < eps,
    `got (${result.pos0.map(v => v.toFixed(2))})`);

  check("pos1 = (300, 400, 3.14, 1)",
    Math.abs(result.pos1[0] - 300) < eps &&
    Math.abs(result.pos1[1] - 400) < eps &&
    Math.abs(result.pos1[2] - 3.14) < eps &&
    Math.abs(result.pos1[3] - 1) < eps,
    `got (${result.pos1.map(v => v.toFixed(2))})`);

  // 颜色：team 0 蓝色 (0x4f8fe0), team 1 红色 (0xe05050)
  check("color0 = blue (team 0)",
    result.color0[0] > 0.2 && result.color0[0] < 0.4 &&  // R ~0.31
    result.color0[1] > 0.5 && result.color0[1] < 0.6 &&  // G ~0.56
    result.color0[2] > 0.8 && result.color0[2] < 1.0,     // B ~0.88
    `got (${result.color0.map(v => v.toFixed(3))})`);

  check("color1 = red (team 1)",
    result.color1[0] > 0.8 && result.color1[0] < 1.0 &&  // R ~0.88
    result.color1[1] > 0.2 && result.color1[1] < 0.4 &&  // G ~0.31
    result.color1[2] > 0.2 && result.color1[2] < 0.4,     // B ~0.31
    `got (${result.color1.map(v => v.toFixed(3))})`);

  // GPU buffer 上传标记
  check("unitPosAttr.version > 0 (needsUpdate triggered)", result.posVersion > 0,
    `version=${result.posVersion}`);
  check("unitColorAttr.version > 0 (needsUpdate triggered)", result.colorVersion > 0,
    `version=${result.colorVersion}`);
  check("unitPosAttr.usage = DynamicDrawUsage (35048)", result.posUsage === 35048,
    `usage=${result.posUsage}`);

  // marker mesh
  check("unitMarker exists", result.markerExists);
  check("unitMarker.visible = false (default hidden)", result.markerVisible === false);
  check("unitMarker.instanceCount = 2", result.instanceCount === 2,
    `instanceCount=${result.instanceCount}`);

  // ---- 第二次调用：验证 buffer 可重复更新 ----
  const result2 = await page.evaluate(() => {
    const nUnits = 1;
    const floats = new Float32Array(5 + 15 * nUnits);
    floats[0] = 200; floats[1] = 2000; floats[2] = nUnits; floats[3] = 0; floats[4] = 0;
    floats[5 + 0 * nUnits + 0] = 500;   // X
    floats[5 + 1 * nUnits + 0] = 600;   // Y
    floats[5 + 2 * nUnits + 0] = 0.79;  // FACING
    floats[5 + 5 * nUnits + 0] = 0;     // ALIVE = 0 (dead)
    floats[5 + 6 * nUnits + 0] = 2;     // TEAM = 2 (neutral)
    floats[5 + 11 * nUnits + 0] = 99;   // ID

    const view = window.view;
    const ret = view.updateFromBinary(floats.buffer, {}, []);
    return {
      nUnits: ret.nUnits,
      pos0: [view.unitPosData[0], view.unitPosData[1], view.unitPosData[2], view.unitPosData[3]],
      color0: [view.unitColorData[0], view.unitColorData[1], view.unitColorData[2]],
      posVersion: view.unitPosAttr.version,
      instanceCount: view.unitMarker?.geometry?.instanceCount,
    };
  });

  check("second call: nUnits === 1", result2.nUnits === 1);
  check("second call: pos0 = (500, 600, 0.79, 0)",
    Math.abs(result2.pos0[0] - 500) < eps &&
    Math.abs(result2.pos0[1] - 600) < eps &&
    Math.abs(result2.pos0[2] - 0.79) < eps &&
    Math.abs(result2.pos0[3] - 0) < eps);
  check("second call: color0 = grey (team 2)",
    Math.abs(result2.color0[0] - 0x9a / 255) < 0.02 &&
    Math.abs(result2.color0[1] - 0x9a / 255) < 0.02 &&
    Math.abs(result2.color0[2] - 0x9a / 255) < 0.02);
  check("second call: instanceCount = 1", result2.instanceCount === 1);

  await browser.close();
} catch (e) {
  failed++;
  console.error("测试失败:", e.message);
} finally {
  server.kill();
}

console.log(failed ? `\n${failed} check(s) failed` : "\nM5 GPU buffer 上传: 全部检查通过 ✅");
process.exit(failed ? 1 : 0);
