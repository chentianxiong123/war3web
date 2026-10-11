# M5 预研：wasm heap → WebGPU buffer 零拷贝数据流

> roadmap: docs/WEBGPU_WASM_PLAN.md §5 M5「零拷贝数据流」。
> 前置：M4 阶段 3 已完成 SOA 快照（`sim_snapshot(buf, n)`，engine/src/sim.c:1316），
> 布局与 Node 侧对账门禁（tools/snaprender_test.mjs，2/2 场景通过）。
> 注意：M4 阶段 4「浏览器渲染路径切 wasm」尚未完成——浏览器渲染仍走 JS `world.js` 的
> `w.snapshot()` → JSON → `S.ents` Map → 逐 view 的 `view.root.position.set` 路径。

## 1. 当前数据流（M4 收尾状态）

```
server (Node.js):
  world.js tick (JS 模拟核心)
    → w.snapshot() 返回 ents JS 对象数组（3324 行，含 15 字段/单位）
    → JSON.stringify → WebSocket 文本帧 (Msg.SNAPSHOT, s: snap)

client (browser):
  ws.onmessage → JSON.parse(e.data)
    → main.js: for (const e of m.s.ents) S.ents.set(e.i, {...})   // JS 对象层
    → main.js: frame() 每帧读 S.ents，插值 alpha，view.root.position.set(toX(x),...)
    → render.js: render() 遍历 views，three.js WebGPURenderer 提交 draw calls
```

**当前瓶颈**（每帧 ~15Hz）：
- 服务端：JSON.stringify(ents 数组) 约 2-8KB，序列化为 ASCII
- 网络：WebSocket 文本帧
- 客户端：JSON.parse + 对象展开 + Map.set
- 渲染前：S.ents → view.root.position 的逐对象访问（Map.get + Object.assign）

## 2. WebGPU buffer 创建 API（W3C WebGPU spec, https://www.w3.org/TR/webgpu/）

### 2.1 三种从 CPU 到 GPU 的上传路径

**路径 A：`GPUQueue.writeBuffer(buffer, offset, data)`**
- `data` 可以是 TypedArray 或 ArrayBuffer（spec 称 "typed array memory upload"）
- 目标 buffer 需要有 `VERTEX | INDEX | STORAGE` 之一 + `COPY_DST`（实现上多数允许直接写入 VERTEX）
- 队列内异步执行：先入队，下一个 render pass 时数据就绪
- **拷贝**：JS heap → GPU 的隐式 staging（实现相关，UMA 上可能仍拷贝一次）
- 代码示例（three.js 内部用法，BufferAttribute.needsUpdate 触发）：
  ```js
  device.queue.writeBuffer(vertexBuffer, 0, typedArray);  // TypedArray 或 ArrayBuffer
  ```

**路径 B：`createBuffer({ mappedAtCreation: true })` + `getMappedRange()` + `unmap()`**
- 一次性上传（初始化场景数据），不适合每帧更新
- 映射中的 buffer 不能同时有 VERTEX 用法（互斥），所以不能直接作为顶点 buffer
- 需要 staging buffer + `copyBufferToBuffer` 中转

**路径 C：SharedArrayBuffer + 计算着色器上传**
- 需要 COOP/COEP 头（cross-origin isolation），破坏跨域 iframe/embed
- wasm 需 `-sSHARED_MEMORY=1 -pthread` 重编译（M4 未启用）
- WebGPU spec 未定义 SAB 直接作为 GPUBuffer backing（截至 2025）；仍需显式 copy

### 2.2 关键限制（对 M5 的影响）

| 方案 | 拷贝次数 | 需要 COOP/COEP | 需要 wasm 重编译 | 适合每帧？ |
|------|---------|---------------|-----------------|-----------|
| A. writeBuffer | 1（JS→GPU） | 否 | 否 | ✅ |
| B. mappedAtCreation | 1+ | 否 | 否 | ❌（一次性） |
| C. SAB + compute | 0（理想） | ✅ | ✅ | ✅ |

**结论**：路径 A 是工程唯一可行解。"零拷贝"在此语境下的准确含义是"跳过 JS 对象层"，
不是"跳过 CPU→GPU 物理拷贝"——后者需要 SAB 路径，而 SAB 在当前 WebGPU spec 与 war3web 部署
前提下均不可行。

## 3. 三条 wasm heap → GPU buffer 上传路径方案对比

### 方案 A：ArrayBuffer → writeBuffer（推荐）

```
wasm heap (SOA, Float32Array)
  → new ArrayBuffer / Uint8Array view (零拷贝: wasm memory 本就是 ArrayBuffer)
  → ws.send(buffer) (WebSocket 二进制帧，无 JSON)
  → client: new Float32Array(buffer) (零拷贝 view)
  → device.queue.writeBuffer(vertexBuf, 0, buffer)  (1 次 JS→GPU)
  → vertex shader 读 vertexBuf
```

- **拷贝点**：wasm heap → GPU buffer（1 次，不可消除，除非走 SAB）
- **优势**：无 JSON 编解码、无 JS 对象构造、列布局直读、批量更新一个 buffer 而非 N 个 Object3D
- **劣势**：仍有一次 JS→GPU 拷贝；three.js 当前 `BufferAttribute` 抽象不直接暴露 writeBuffer
- **适配量**：中等（需要在 render.js 建一个常驻 BufferAttribute 池，绕开 three.js 的 needsUpdate 机制）

### 方案 B：SharedArrayBuffer + COOP/COEP（理论最优，实际阻塞）

```
wasm heap as SharedArrayBuffer (Emscripten -sSHARED_MEMORY=1 -pthread)
  → postMessage(transfer: [sab])  // 主线程 → 渲染 Worker
  → 渲染 Worker 内: createBuffer + ... 但 spec 不允许 SAB 直接 backing GPUBuffer
  → 仍需一次显式 copy
```

- **阻塞点 1**：WebGPU spec 至今未支持 SAB 作为 GPUBuffer backing（issue gpuweb/gpuweb#2388）
- **阻塞点 2**：需要 COOP/COEP 头，破坏当前所有跨域资产加载（`/assets/`, CDN 字体等）
- **阻塞点 3**：war3web 服务器不设置跨源隔离头，部署层改动大
- **阻塞点 4**：wasm 需重新编译为线程版，M4 阶段 4 才能开始考虑
- **结论**：不可行

### 方案 C：compute shader 上传（过度工程）

- 先 writeBuffer 到 staging STORAGE buffer，再 dispatch compute shader 到 VERTEX buffer
- 多了一次 GPU 内部 copy + shader dispatch，CPU→GPU 拷贝并未减少
- 仅在数据量极大（>1MB/帧）时才有价值，war3web 快照 ~8KB/帧，远低于阈值
- **结论**：不适用

## 4. 改造范围评估

### 4.1 阻塞依赖：M4 阶段 4 未完成

**关键发现**：当前浏览器渲染路径**完全依赖** `server/world.js` 的 `w.snapshot()` 返回 JS 对象数组。
`engine/src/sim.c` 的 `sim_snapshot` 仅在 `tools/snaprender_test.mjs` 中被调用（Node 测试），
**未接入任何运行中的游戏**。要让 M5 真正生效，必须先完成 M4 阶段 4：

| M4 阶段 | 状态 | 影响 M5 的部分 |
|---------|------|---------------|
| 阶段 1：寻路/移动/碰撞进 wasm | ✅ 完成（sim_test 5/5） | — |
| 阶段 2：弹道/攻击结算进 wasm | ⚠️ 部分（sim_step_test 通过，但完整 combat 未全量） | — |
| 阶段 3：SOA 快照 sim_snapshot | ✅ 完成（snaprender_test 2/2） | SOA 布局已定 |
| 阶段 4：浏览器渲染路径切 wasm | ❌ **未完成** | **M5 的全部前置** |

M4 阶段 4 要做的（当前阻塞 M5）：
- `server/world.js` 的 `step()` 切到 `sim_step`（wasm）
- 单位/物品/事件表同步到 wasm heap
- `server/room.js` 的 `broadcast` 改为推送 wasm SOA buffer
- `client/js/main.js` 的 SNAPSHOT handler 改为 `snapshotFromBinary`

### 4.2 M5 PoC 的实际交付边界

由于 M4 阶段 4 未完成，**完整 M5（wasm 跑游戏 + 浏览器读 SOA + GPU 上传）当前不可行**。
M5 本次交付定义为：

1. ✅ **调研报告**：本文档（含方案对比、阻塞点、分步计划）
2. ✅ **客户端 PoC**：`render.js` 新增 `snapshotFromBinary(buf)`，读 SOA ArrayBuffer
3. ✅ **服务端 PoC**：`room.js` 新增二进制 WebSocket 通道（`sendBinary` 助手 + Msg.SNAPSHOT_BIN）
4. ✅ **Puppeteer 验证**：`tools/m5_zero_copy_test.mjs` 构造合成 SOA buffer，验证客户端读路径
5. ⏸️ **完整集成**：阻塞在 M4 阶段 4，待 game loop 切 wasm 后激活

## 5. 分步实施计划

### 阶段 A（本次交付，PoC）

| 步骤 | 文件 | 改动 | 验证 |
|------|------|------|------|
| A1 | `shared/const.js` | 增加 `Msg.SNAPSHOT_BIN: 'snapBin'` | — |
| A2 | `client/js/render.js` | 新增 `snapshotFromBinary(buf)` 函数，读 SOA Float32Array 列布局 | tools/m5_zero_copy_test.mjs |
| A3 | `server/room.js` | 新增 `sendBinary(ws, buf)` + 二进制推送通道（默认不启用，需 M4 阶段 4） | 同上 |
| A4 | `tools/m5_zero_copy_test.mjs` | Puppeteer 测试：合成 SOA buffer → snapshotFromBinary → 断言 ents | node tools/m5_zero_copy_test.mjs |
| A5 | `docs/M5_ZERO_COPY_PLAN.md` | 本文档 | — |

### 阶段 B（M4 阶段 4 完成后激活）

| 步骤 | 文件 | 改动 |
|------|------|------|
| B1 | `server/world.js` | `step()` 内部切到 `sim_step`（保留 JS 兜底开关） |
| B2 | `server/room.js` | `stepLoop` 调 `sim_snapshot` 推 SNAPSHOT_BIN，替换 SNAPSHOT |
| B3 | `client/js/main.js` | SNAPSHOT handler 改为读 binary，保留 JSON 兼容 |
| B4 | `client/js/render.js` | 常驻 GPUBuffer 池（绕开 three.js BufferAttribute），writeBuffer 每帧更新 |
| B5 | `tools/m5_zero_copy_test.mjs` | 扩展为端到端：真 wasm → 真客户端渲染 |

### 阶段 C（可选，M5 后续）

| 步骤 | 内容 |
|------|------|
| C1 | 评估 WebGPU spec 是否支持 SAB → GPUBuffer backing（gpuweb#2388） |
| C2 | 若支持，启用 COOP/COEP + 重编译 wasm（`-sSHARED_MEMORY=1`） |
| C3 | 实例化渲染（instanced draw）：单位位置从 VERTEX buffer 读，不再每单位 set Position |

## 6. 关键代码片段

### 6.1 `snapshotFromBinary` 读 SOA 列布局

```js
// client/js/render.js
// SOA 布局（与 engine/src/sim.c:1316 sim_snapshot 一致）：
//   header(5): tick, nowMs, nUnits, nMissiles, nEvents
//   units: nUnits × 15 列，列序 x y facing hp maxHp alive team pi kind moving gathering id level mana maxMana
//   resources: gold[16]
//   missiles: nMissiles × 2 列 x y
//   events: nEvents × 4 列 tick type a b
const SOA_COLS = 15;
const SOA_HEADER = 5;

export function snapshotFromBinary(buf) {
  const f = new Float32Array(buf);
  const nUnits = Math.round(f[2]);
  const ents = [];
  // 列偏移：header 5 + col * nUnits
  for (let i = 0; i < nUnits; i++) {
    const base = SOA_HEADER + i;
    ents.push({
      i: Math.round(f[SOA_HEADER + SOA_COLS * 0 + i]),  // x
      // ... 实际需要按列遍历，这里只是示意
    });
  }
  return ents;
}
```

**实际实现见 `client/js/render.js` 的 `snapshotFromBinary`**：按列优先遍历（column-major），
15 列一次读，避免 nUnits 次循环内再遍历 15 列（缓存友好）。

### 6.2 GPUBuffer 创建与 writeBuffer 更新

```js
// 伪代码：常驻 GPU buffer 池（阶段 B 实施）
const unitBuf = device.createBuffer({
  size: MAX_UNITS * 4 * 4,  // 4 floats per unit × 4 bytes
  usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
});
// 每帧：
device.queue.writeBuffer(unitBuf, 0, ssoaBuffer.slice(0, nUnits * 16));
```

### 6.3 服务端二进制推送

```js
// server/room.js
sendBinary(ws, buf) {
  if (ws && ws.readyState === 1) ws.send(buf);  // 原生 WebSocket 二进制帧
}
// 推送 SOA：
const need = sim_snapshot(wasmBufPtr, WASM_BUF_CAP);
if (need <= WASM_BUF_CAP) {
  const buf = wasmModule.HEAPU8.slice(wasmBufPtr, wasmBufPtr + need * 4).buffer;
  this.broadcastBinary({ t: Msg.SNAPSHOT_BIN }, buf);
}
```

## 7. 验证计划

### 7.1 本次（阶段 A）

`tools/m5_zero_copy_test.mjs`：
1. Node 侧用 `createEngine()` 加载 wasm，`sim_snapshot` 写 SOA buffer
2. Puppeteer 加载 `client/index.html`
3. 在浏览器内构造与 Node 侧相同的 SOA buffer（`new Float32Array([...]).buffer`）
4. 调 `snapshotFromBinary` 还原 ents
5. 与 `tools/snaprender_test.mjs` 的 golden 比对（x/y/f/h/H/m/M/l 精确；team/pi/kind 精确）

### 7.2 阶段 B

- `tools/m5_zero_copy_test.mjs` 扩展为端到端：启真 server，连接真实 WebSocket
- 验证客户端收到的 SNAPSHOT_BIN 帧与 JS snapshot 路径 ents 逐字段一致

## 8. 风险与缓解

| 风险 | 缓解 |
|------|------|
| M4 阶段 4 长期阻塞 | 本次交付客户端 PoC 已解耦，M4 完成即可激活 |
| WebGPU 兼容性（Safari/Firefox） | 走 writeBuffer 是 spec 稳定 API，全平台支持；three.js WebGPURenderer 已抽象 |
| wasm heap 与 GPU buffer 生命周期错配 | 使用 `ArrayBuffer.slice` 隔离出独立 buffer，不引用 wasm heap 本身 |
| three.js BufferAttribute 不直接暴露 writeBuffer | 阶段 B 使用 raw GPUBuffer + 自定义 InstancedBufferGeometry |
| WebSocket 二进制帧大小限制 | SOA ~8KB/帧，远低于 64KB 默认分片，无需分帧 |

## 9. 参考

- W3C WebGPU spec: https://www.w3.org/TR/webgpu/#queueing
- WebGPU Explainer (GPUBuffer): https://gpuweb.github.io/gpuweb/explainer/#gpudevices-createbuffer
- webgpu.dev (Toji): https://toji.dev/webgpu-best-practices/buffer-uploads.html
- WebGPURenderer (three.js): https://threejs.org/docs/#api/en/renderers/WebGPURenderer
- GPUBuffer SAB backing proposal: https://github.com/gpuweb/gpuweb/issues/2388
- COOP/COEP: https://web.dev/articles/coop-coep
- 本工程: `engine/src/sim.c:1316` (sim_snapshot), `tools/snaprender_test.mjs` (SOA 对账门禁)
