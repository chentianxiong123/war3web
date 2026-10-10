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
- **移动推进 C 复现完成（1de6e98）**：`sim_run_move` —— world.js stepMove 的 move
  分支全量复现（movementPath 直线快路径 + 慢路径 A*、turnToward 转向预算
  turnRate·dt/0.03、沿 path 推进 stepLen=moveSpeed·dt、canAdvance 扫掠圆盘、
  40 距离到达门禁）。**sim_test 端到端对照 golden：5/5 到达行为一致**
  （到达 tick 差 ≤3、路径长度完全一致、endErr 一致）。
  golden 基准已升级为 **arrive 时刻快照**（arrivePathLen/arriveEndErr）。
- **多单位 + 实体碰撞完成（aa24d4e）**：sim 单位表（sim_spawn/sim_order_move/
  sim_tick/sim_get）+ `canAdvance` 实体投影距离（JS 逐字移植）+ occupancy 绕行
  （快路径含实体检查、慢路径 occupancy 圆集）+ 撞墙 250ms 冷却重寻路。
  **关键发现：JS A* 的 g/f 是 Float32Array——C 用 double 导致 f 相等比较不同、
  堆序不同、路径不同（根因）→ C g/f 改 float32 后完全对齐**。
  **sim_test 碰撞场景（hold 挡路+绕行）完全一致：路径段数 4=4、到达 tick 93=93、
  终位 [1488,1488] 一致**。
- 输入：单位意图（order 目标/路径点）→ WASM 内寻路（现有 walk.bin/fload.bin 二进制
  数据直接加载进 wasm heap）→ 输出：单位新坐标/朝向
- 交付：`wasm_move(unitId, target, dt)` 导出 + Node 端对照 JS 寻路结果
  （抽样 1000 单位 1 分钟轨迹，位置误差门禁）
- 风险：JS 寻路细节（代价函数/平滑）需逐条对照——先锁行为再换实现

### 阶段 2：弹道/攻击结算进 WASM（combat+经济）
- 弹道表（飞行中投射物：位置/目标/伤害）+ 命中结算 + 采金/伐木 tick 推进
- 交付：`wasm_step(dt)` 完整模拟 tick（单位+弹道+经济），JS 只做 IO（输入事件、
  输出快照）

#### 2.1 子系统盘点（world.js 行号实测）
| 子系统 | 行段 | 核心逻辑 | C 移植量 |
|---|---|---|---|
| stepMissiles | 2929-2957 | 导弹推进（homing 追踪/点射、到达判定 destRange 或 距离-目标半径、deadline 超时、onHit 回调） | 小（~30 行） |
| stepAttack | 2991-3044 | atkTimer 冷却 → 目标扫描（hostile + weaponFor + 距离<atkRange+半径+40）→ turnToward → windup 前摇 → releaseAttack | 中（windup/冷却状态机） |
| weaponFor | 2960-2983 | 武器选择：atkTargetsAllowed/classifications/targetAs 集合匹配 + magicImmune + 敌对 + 类型（mechanical/organic/hero）过滤 | 中（元数据依赖） |
| damage | 1084-1133 | 伤害结算（类型/护甲/魔抗/减伤） | 中（需护甲公式） |
| releaseAttack | 3046-3095 | 近战直击 / 远程发射导弹 / cleave 溅射 | 中 |
| stepGathers | 1342-1468 | 农民采金（往返金矿/交付）、伐木 | 中（状态机） |
| hostile/playerOf | 各处 | 玩家关系 → 敌对判定（C 需 team/player 表） | 小 |

#### 2.2 黄金锁定场景设计（行为先锁，C 再对照）
1. **近战对打**：敌对步兵（hfoo）互打——记录攻击事件时序（攻击 tick/伤害值）、
   死亡 tick、HP 曲线——门禁：事件序列逐项一致 + 死亡 tick 差 ≤6
2. **远程对打**：敌对弓箭手（hArcher）——记录发射/命中 tick、导弹飞行耗时、
   命中伤害——门禁：命中 tick 差 ≤6 + 伤害逐项一致
3. **经济**：农民采金——记录金矿储量随时间曲线、农民往返周期——门禁：
   储量曲线采样点差 ≤5%
4. **触发干扰排查**：Terenas 地图有单位自动 AI（空闲农民自动采金/守卫自动攻击），
   黄金场景需用 hold 钉住非主角单位（阶段 1 已验证该手段），或选无 AI 场景

#### 2.5 战斗行为锁定进行中（combat_golden）
- **`tools/combat_golden.mjs`（0f7b38c 后）**：敌对 hfoo 近战对打 3 场景
  （贴身/需走近/3v1 围攻），录制攻击事件时序 + 死亡 tick + HP 曲线 → 
  `goldens/combat_trace.json`。
- **实测数据**：hfoo hp420/dmg11/range90/cd1.35s/attackPoint0.5s；攻击间隔 ≈41 tick
  (1.37s=atkTimer cd 配额)；贴身死亡 1573 tick(52.4s)、需走近 1594、3v1 1574
  （攻方死亡，被围者存活）——C 移植后同场景对照攻击序列/死亡 tick。

#### 2.3 C 移植设计
- sim 单位表扩展：hp/maxHp/atkTimer/attackWindup/weapon 快照（atkCd/attackPoint/
  atkRange/dmg/atkType/atkTargetsAllowed 位集）+ team/playerOf
- 导弹表（SOA 数组）：x/y/speed/dx/dy/targetId/onHit 类型+伤害参数——复用
  launchMissile 快照语义
- 伤害公式：先无 buff 纯数值（护甲减伤/魔法抗性表），buff 依赖留给 ability 桥
- `wasm_step(dt)`：单位循环（移动→攻击→经济）+ 导弹推进 + 事件出队（attack/
  missileEnd/death 事件 push 出 heap，JS 消费——阶段 2 事件桥）

#### 2.4 风险
- weaponFor 元数据依赖（atkTargetsAllowed/classifications 是字符串集合）——
  C 侧用位集/枚举编码预编译，避免字符串匹配
- damage 依赖护甲/buff/敌对链——阶段 2 先无 buff 纯数值对照，buff 挂能力桥
- 地图 AI 干扰黄金场景——hold 钉住或选受控场景（阶段 1 已验证）
- 事件桥（attack/missileEnd/death 时序）——事件 push 出 heap + JS 消费对齐

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
