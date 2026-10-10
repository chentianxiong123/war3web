# M4 预研：模拟核心进 WASM（world.js 盘点 + 移植设计）

> roadmap: docs/WEBGPU_WASM_PLAN.md §4 M4「模拟核心进 WASM」。
> 前置：M3 C 引擎（engine/src/jass.c，~2900 行）已达成解析+执行+对账零差异
> （114/114 测试，880 全局 + 18 数组双对账），作为 M4 的共享 C 代码库基础。

## 1. world.js 模拟核心盘点（3257 行，分区结构）

| 分区 | 行段 | 职责 | 移植优先级 |
|---|---|---|---|
| terrain | 390-445 | 地形/高度/阻挡查询 | P2（数据只读，无需搬） |
| unit types | 446-484 | 单位类型静态表 | P2 |
| **units** | 485-1082 | 单位实例：创建/移动/状态/动画 | **P1**（热路径） |
| **combat** | 1083-1133 | 攻击/伤害/弹道结算 | **P1** |
| **orders** | 1134-1270 | 命令队列/寻路目标 | **P1** |
| enumeration | 1271-1340 | 单位枚举/范围查询 | P1 |
| RTS 经济 | 1341-1468 | 采金/伐木/建筑（Terenas 补丁） | P1 |
| items | 1469-1718 | 物品/掉落/拾取 | P2 |
| players | 1719-1750 | 玩家状态 | P2 |
| ability engine glue | 1751-2141 | 能力引擎接口 | P2（调 external ability 引擎） |
| player-driven | 2142-2513 | 玩家交互（移动/施法/建筑） | P1 |
| JASS events | 2514-2574 | JASS 事件桥 | P2 |
| **step** | 2575-3257 | 每 tick 主循环 | **P0**（串起全部） |

**热路径判定**：`step()` 每 tick 遍历全部单位（移动/寻路/碰撞/弹道/攻击/经济），
每 tick 快照 15 次/s 发客户端——这些就是 M4 进 WASM 的标的。

**已有 C 侧基础（M3 产物可复用）**：
- C VM 单位表（VUnit：id/typeId/pi/alive/x/y/facing/life/mana/能力列表）
- C 对象表范式（realloc 扩容/交换删除/幂等 handle）
- 对账基建（jass_run JSON 输出 + Node 端比对脚本）

## 2. 移植策略（分阶段，每阶段独立可验证）

### 阶段 1：移动/寻路/碰撞进 WASM（P1 单位+orders 子集）
- **行为锁定已建立（7ab300f）**：`tools/path_golden.mjs` + `goldens/path_trace.json`——
  真实 Terenas 地图 5 场景单单位移动黄金基准（到达耗时 1.1-2.9s、路径长度、
  终点误差门禁 endErr<=40 全部通过）。C 移植后同场景对照。
- **关键实测发现**：JS 寻路是**轻量直线段 + 碰撞回退**架构（movementPath 返回
  稀疏段，撞障碍 canAdvance 失败即停）；多单位同场实体碰撞会互相阻挡——
  C 移植需复现这两条语义。
- **C 移植完成（ce58fca）**：`engine/src/sim.c`——pathing.js Grid 全量移植
  （A* 二叉堆 + string-pull + clearFootprint 精确扫掠圆盘 + connected BFS +
  nearestWalkable 螺旋 + clearLine），`_sim_grid_init/_sim_find_path/_sim_clear_foot/
  _sim_connected_i` 导出。**`tools/sim_test.mjs` 门禁：5/5 场景 C/JS 寻路一致**
  （段数 + 每段坐标容差 0.5），`npm run sim:test` 独立脚本。
- 输入：单位意图（order 目标/路径点）→ WASM 内寻路（现有 walk.bin/fload.bin 二进制
  数据直接加载进 wasm heap）→ 输出：单位新坐标/朝向
- 交付：`wasm_move(unitId, target, dt)` 导出 + Node 端对照 JS 寻路结果
  （抽样 1000 单位 1 分钟轨迹，位置误差门禁）
- 风险：JS 寻路细节（代价函数/平滑）需逐条对照——先锁行为再换实现

### 阶段 2：弹道/攻击结算进 WASM（combat+经济）
- 弹道表（飞行中投射物：位置/目标/伤害）+ 命中结算 + 采金/伐木 tick 推进
- 交付：`wasm_step(dt)` 完整模拟 tick（单位+弹道+经济），JS 只做 IO（输入事件、
  输出快照）

### 阶段 3：快照序列化进 WASM（SOA）
- **SOA 快照**：把单位属性按列布局（x[]/y[]/life[]/facing[]...）写入 wasm 连续 buffer
- 交付：`wasm_snapshot()` 直接产字节 buffer（对齐 M5 的 wasm heap → WebGPU buffer
  零拷贝链路），Node 端只做协议封装，不再逐对象序列化
- 门禁：快照字节与现有 JS 快照逐字段对账（单位数/坐标/生命/资源）

## 3. SOA 快照布局草案

```
struct SnapHeader { u32 magic; u32 version; u32 tick; u32 nUnits; }
// 单位列（每列 nUnits × f32/i32）：
//   x[], y[], facing[], life[], maxLife[], mana[], maxMana[],
//   typeId[], pi[], flags(alive/visible)[]
// 弹道列、经济列（金/木 per player）
// 结尾：CRC32（或每列 xxhash，供对账定位差异列）
```
固定列布局 = 快照体积稳定（几千单位 × ~30 字节 ≈ 百 KB/tick @15Hz ≈ 1.5MB/s，
远低于 WebSocket 压力线，且 M5 零拷贝后无 JS 序列化开销）。

## 4. 数据流（M4→M5 衔接）

```
server tick
  └─ 输入（玩家命令/事件）→ 导入 wasm heap 的 input buffer
  └─ wasm_step(dt)（C 模拟核心全量推进）
  └─ wasm_snapshot() → 快照 buffer
      └─ (M5) wasm heap 共享 ArrayBuffer → WebGPU 顶点 buffer 零拷贝
      └─ (现在) Node 端协议封装 → WebSocket 推送客户端
```

## 5. 分步排期（对当前推进速度的保守估计）

| 阶段 | 内容 | 预计 |
|---|---|---|
| 1 | 移动/寻路/碰撞进 WASM | 1-2 周 |
| 2 | 弹道/攻击/经济进 WASM | 1-2 周 |
| 3 | SOA 快照 + 对账门禁 | 1 周 |
| 收尾 | 删 JS 双实现/开关切换 | 1 周 |

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| JS 寻路/结算细节差异 | 行为锁定测试（轨迹/结果对账门禁），先对照再换实现 |
| ability 引擎 external 依赖 | 阶段 2 只搬纯结算，能力引擎保持 JS 桥（C 侧只收结果） |
| 事件回传（JASS events） | 阶段 2 定义 wasm→JS 事件队列（事件 push 出 heap，JS 消费） |
| 双实现维护成本 | 每阶段切换后删除 JS 对应实现（roadmap §6 双实现策略） |

## 7. 验证命令（规划）

```bash
npm run engine:test        # M3 对账回归（每阶段保持全绿）
node tools/world_wasm_test.mjs   # 阶段 1：寻路轨迹对账（1000 单位 1 分钟）
node tools/snapshot_diff.mjs     # 阶段 3：快照字节级对账
```
