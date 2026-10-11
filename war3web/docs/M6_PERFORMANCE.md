# M6 性能基准测试报告

> 状态：模板（`node tools/m6_perf_bench.mjs` 与 `node tools/m6_gpu_buffer_test.mjs` 跑完后回填表格）。

## 1. 测试目标

M5 已完成 GPU buffer 上传（512 单位常驻 buffer）。M6 验证三件事：

1. **wasm 模拟性能**：100 / 200 / 500 单位场景下 tick 耗时是否在 30 fps 预算内（33.33 ms/tick）
2. **GPU buffer 容量**：M5_MAX_UNITS = 512（`client/js/render.js:122`）是否覆盖实际战场规模；超过 512 时的降级行为是否安全（截断不崩溃、不越界）
3. **端到端帧率**：tick + snapshot + binary 序列化 + GPU buffer 上传的总耗时是否达标

对应工具：

| 工具 | 测什么 |
| --- | --- |
| `tools/m6_perf_bench.mjs` | Node 侧 wasm 模拟 + 快照 + 序列化耗时与内存 |
| `tools/m6_gpu_buffer_test.mjs` | 浏览器端 GPU buffer 容量、溢出降级、更新耗时 |

## 2. 测试环境

> 跑完 `node tools/m6_perf_bench.mjs` 后，把首部输出粘贴到这里。

| 项 | 值 |
| --- | --- |
| CPU | _（示例：Intel i7-12700K / 20 线程）_ |
| GPU | _（示例：RTX 4070 / swiftshader 兜底）_ |
| 浏览器 | _（示例：Chromium 130.0.6723.91）_ |
| Node | _（示例：v20.11.0）_ |
| wasm 内存初始 | _（示例：16.00 MB，emscripten 默认 16KB 步进）_ |
| 测试脚本参数 | `TICKS=300 WARMUP=30 REPEAT=5` |
| 30 fps 预算 | 33.33 ms / tick |

> 跑法：`NODE_OPTIONS="--expose-gc" node tools/m6_perf_bench.mjs`（内存数字更稳定）。
> GPU buffer 测试需 war3web server 启动：`node tools/m6_gpu_buffer_test.mjs`。

## 3. 基准测试结果

### 3.1 wasm 模拟性能（`tools/m6_perf_bench.mjs`）

> 字段说明：F/E = 战斗单位数 / 经济单位数；spawn = 场景布置耗时；tick 均/ms = TICKS 次连续 sim_step 平均；每 tick = 单次 tick 平均；预算 % = 每 tick 占 33.33 ms 的百分比；snapms = sim_snapshot 耗时；serms = HEAPU8.slice 拷贝耗时；snapKB = 快照字节数；nU/nM/nE = 快照里的单位/导弹/事件数。

| 规模 | F/E | spawn | tick 均 | tick min | 每 tick | 预算 % | snap ms | ser ms | snap KB | nU/nM/nE |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 100 | 80/20 | — | — | — | — | — | — | — | — | — |
| 200 | 160/40 | — | — | — | — | — | — | — | — | — |
| 500 | 400/100 | — | — | — | — | — | — | — | — | — |

**判定线**：

- 500 单位场景 每 tick < 33.33 ms（预算 100%）：✓ 达标
- 500 单位场景 每 tick < 23.33 ms（预算 70%）：✓ 余量充足
- 500 单位场景 每 tick < 16.67 ms（预算 50%）：✓✓ 可支持多房间

### 3.2 内存占用

> memBefore / memAfter = 场景开始前/后快照；Δ = 增量。wasm 列为 emscripten 管理的线性内存，随 `HEAPU8.buffer` 增长（16KB 步进），与 JS heap 独立。

| 规模 | RSS 前 | RSS 后 | Δ | heap 前 | heap 后 | Δ | arrbuf 前 | arrbuf 后 | Δ | wasm 前 | wasm 后 | Δ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 100 | — | — | — | — | — | — | — | — | — | — | — | — |
| 200 | — | — | — | — | — | — | — | — | — | — | — | — |
| 500 | — | — | — | — | — | — | — | — | — | — | — | — |

**判定线**：

- 500 单位 wasm 内存 Δ 稳定（不随测量循环增长）：✓ 无泄漏
- 500 单位 heap Δ < 10 MB：✓ GC 正常
- 500 单位 arrbuf Δ 接近 serialize 拷贝大小 × REPEAT：✓ 切片被 GC

### 3.3 GPU buffer 容量（`tools/m6_gpu_buffer_test.mjs`）

> 跑 `node tools/m6_gpu_buffer_test.mjs` 后，把控制台输出粘到这里。工具自动判定 passed/failed。

| 测试组 | 场景 | 期望 | 结果 |
| --- | --- | --- | --- |
| 1. 容量边界内 | 1 / 256 / 384 / 511 / 512 单位 | `ret.n = nUnits`，`instanceCount = nUnits` | — |
| 2. 溢出截断 | 600 / 1000 单位 | `ret.n = 512`，`unitPosData.length = 2048`（不被拉长） | — |
| 3. buffer 复用 | 1 → 512 → 0 → 256 循环 | 每步 `instanceCount` 精确匹配 | — |
| 4. 更新耗时 | 100 / 300 / 512 单位 | `updateFromBinary` 平均 < 33.33 ms | — |
| 5. 溢出后完整性 | 1000 单位溢出 → 100 单位恢复 | 溢出未污染 buffer，恢复后 `pos[0]` 精确 | — |
| 6. 部分存活 | 500 单位中 250 死 | alive 列 250/500 精确 | — |

## 4. 瓶颈分析

> 回填基准测试输出后，按以下清单分析：

### 4.1 wasm 模拟侧

- **单位数线性度**：500 / 100 单位 = 5×，实际每 tick 耗时倍数是否接近 5？
  - ≤ 5.5×：线性良好
  - 5.5–8×：轻微超线性，可能空间网格查询或 body 冲突检测开销上升
  - > 8×：显著超线性，瓶颈在 O(n²) 路径（如全局范围查询、事件广播）
- **tick 预算占用**：500 单位场景每 tick 是否 < 33.33 ms？
- **导弹数量**：nMissiles 是否随规模线性增长（hwat 远程单位每 atkCd 生成 1 个导弹）？
- **事件数量**：nEvents 是否随 combat 强度增长（attack + death + bounty）？

### 4.2 快照与序列化侧

- **sim_snapshot 耗时**：内部 O(SIM_MAX=1024)，但与单位数无关（未放置单位跳过）。是否接近常数？
- **HEAPU8.slice 吞吐**：serialize KB / serialize ms = MB/s。是否 < 1 GB/s（说明拷贝不是瓶颈）？
- **快照大小**：500 单位场景 snap KB 是否 < 100 KB？（影响 WS 传输帧率）

### 4.3 GPU buffer 侧

- **M5_MAX_UNITS = 512**：是否覆盖实际战场？（参考 `docs/WC3_GAMEPLAY_AUDIT.md` 的 max 单位数）
- **溢出降级**：> 512 单位静默截断到 512，无崩溃、无越界。但**丢失的单位不会渲染**——若实际地图可能 > 512 单位，需扩大 buffer 或分块上传。
- **updateFromBinary 耗时**：100 / 300 / 512 单位是否 < 33.33 ms？

### 4.4 端到端

单帧端到端预算分解（500 单位场景）：

| 阶段 | 耗时 | 占比 |
| --- | --- | --- |
| wasm tick | _X_ ms | _X_% |
| snapshot | _X_ ms | _X_% |
| binary 序列化 | _X_ ms | _X_% |
| WS 传输（估算） | _X_ ms | _X_% |
| GPU buffer 上传 | _X_ ms | _X_% |
| **合计** | _X_ ms | 100% |

**判定**：合计 < 33.33 ms = 30 fps 达标。

## 5. 优化建议

> 按瓶颈优先级排序。每条建议注明预计收益与风险。

### 5.1 若 wasm tick 超预算

- **空间网格加速**：`sim.c` 的全局范围查询（attack target 选择、aura 触发）改为按网格分桶查询。预计收益：O(n²) → O(n)。风险：低，已有 `sim_grid_init` 基础设施。
- **A* 路径软预算**：参考 `docs/PATHING_PERFORMANCE.md`，400 单位场景 A* 最坏 23.7 ms/tick。已在 `world.js` 用 FIFO 队列 + 6ms 软预算控制；wasm 侧需对应实现。
- **单位裁剪**：视野外的静止单位降为 5 Hz tick。预计收益：减少 ~70% 单位的工作量。风险：中，需保证可见单位正常 tick。
- **SIM_MAX 下调**：`engine/src/sim.c:36` 当前 SIM_MAX=1024，但 client GPU buffer 只 512。下调到 600 可减少未使用槽位的循环开销。风险：低，需确认 `sim.c` 无对 SIM_MAX 的依赖。

### 5.2 若 snapshot / 序列化超预算

- **增量快照**：只发送变化的字段（如 alive 变 0、HP 变化）。预计收益：减少 80%+ 传输量。风险：中，需维护脏标记。
- **Binary WebSocket**：已在 M4 阶段 4 实现（`server/room.js` SNAPSHOT_BIN handler）。确认 client 侧走 binary 而非 JSON。
- **压缩**：对 > 50 KB 的快照用 pako.zlib 压缩。预计收益：减少 ~60% 传输量。风险：CPU 开销 ~0.5 ms/tick。

### 5.3 若 GPU buffer 容量不足

- **扩大 M5_MAX_UNITS**：`client/js/render.js:122` 当前 512。改到 1024（对齐 wasm SIM_MAX）需重新分配 `unitPosData` (4 KB → 8 KB) 与 `unitColorData` (6 KB → 12 KB)。预计收益：覆盖所有战场规模。风险：低，纯容量调整。
- **分块上传**：512 单位分 2 块上传（每块 256），shader 端合并。风险：中，需改 shader。
- **LOD 降级**：距离相机 > X 的单位渲染为简化模型。风险：低，已有 viewport 裁剪基础。

### 5.4 若内存增长异常

- **wasm 内存泄漏**：wasm 列 Δ 应稳定（sim 状态重置不清 wasm 内存）。若持续增长，检查 `sim_spawn_*` 是否有未释放的 malloc。
- **ArrayBuffer 泄漏**：arrbuf Δ 应 ≈ serialize 拷贝大小 × REPEAT（切片被 GC 回收）。若显著偏高，可能是 `updateFromBinary` 或 `slice` 创建的临时 buffer 被意外持有。
- **heap 增长**：heap Δ 应 < 10 MB（GC 正常回收）。若持续增长，检查是否有闭包/循环引用持有 wasm 引用。

## 6. 回归门禁

> 后续 PR 若触及 `engine/src/sim.c` / `client/js/render.js` / `server/room.js`，需跑以下命令并把结果与本报告对比：

```bash
# wasm 性能基准
NODE_OPTIONS="--expose-gc" node tools/m6_perf_bench.mjs

# GPU buffer 容量与降级
node tools/m6_gpu_buffer_test.mjs

# M5 上传路径（回归保护）
node tools/m5_gpu_buffer_test.mjs
node tools/m5_zero_copy_test.mjs
```

**门禁线**：

- wasm 500 单位 每 tick Δ ≤ 5%（相对本报告基线）
- GPU buffer 溢出测试全通过（截断行为不变）
- M5 全部测试通过（回归保护）

## 7. 参考

- `docs/PATHING_PERFORMANCE.md`：A* 性能回归（400 单位场景最坏 23.7 ms/tick）
- `docs/M4_PHASE4_PLAN.md`：wasm 集成 + binary WebSocket 计划
- `docs/M5_ZERO_COPY_PLAN.md`：M5 零拷贝数据流计划
- `docs/WEBGPU_WASM_PLAN.md`：WebGPU + wasm 总体架构
- `engine/src/sim.c:1424`：sim_snapshot SOA 布局
- `client/js/render.js:121`：M5_MAX_UNITS = 512
- `client/js/render.js:1210`：updateFromBinary 实现
