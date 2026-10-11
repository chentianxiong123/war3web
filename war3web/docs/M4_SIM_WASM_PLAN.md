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

#### 2.6 战斗核心 C 移植进行中（combat_test）
- **`engine/src/sim.c` 战斗扩展（73f7ccb）**：SimUnit 战斗字段（hp/maxHp/armor/
  armorTypeIdx/team/武器参数）+ `sim_spawn_fight`（打包 20 参）+ 攻击状态机
  `step_attack_unit`（stepAttack 子集：atkTimer 冷却 → 自动目标扫描（敌对+距离
  <atkRange+半径+40）→ turnToward → windup 前摇 → releaseAttack 近战）+ 
  `sim_damage`（damage() 纯数值：typeBonus 7×8 表 + armorFactor）+ `sim_combat_step`
  （每单位 移动→攻击）+ `sim_get_fight`。
- **关键根因**：`sim_set_dmg_table` 初版按 `double*` 读参数，JS 侧却用 HEAPF32
  （4 字节）写 → 表数据错位 → 伤害 0.08/击 → 改 `float*` 参数后伤害正确。
- **`tools/combat_test.mjs` 对照**：**melee_close 硬门禁全过**——死亡 Δ41≤45
  （1 击随机容差）、首击 0=0、攻击数 76 vs 78、HP 曲线容差 40 内、首死单位 id 1=1。
  **melee_apart / melee_3v1 标注 pending**：差异根源是 stepAI 层（自动追击移动/
  目标选择遍历序），战斗核心本身已对齐——下一步移植 stepAI 子集。

#### 2.7 stepAI 追击子集 C 移植（2b704a6）——3/3 场景硬门禁全过 ✅
- **`engine/src/sim.c` 新增**：
  - SimUnit AI 字段：`orderType`（0=idle 1=attack）、`orderTargetId`、`acquisitionRange`
    （hfoo 实测 500）、`homeX/homeY`；sim_spawn_fight 初值 idl/nearest。
  - `step_ai_unit`（stepAI 2656-2709 追击子集）：idle → 获取范围(500)内敌对最近 →
    attack；attack → 目标死亡回 idle；距离 > atkRange+radius 则追击，否则停（path 清空原地打）。
  - `sim_route`（= JS routeUnit = movementPath(u,x,y,[])）：**无实体阻挡**的追击寻路，
    与玩家订单的 `sim_order_move`（含实体阻挡）区分开。
  - `sim_combat_step` 顺序补齐为 **stepAI → stepMove → stepAttack**（对齐单位循环）。
- **根因逐轮**：
  1. goalX/goalY 快照判据——追击每 tick 重寻路会重置 path 卡起点（token 记忆）；
  2. 目标选择——JS stepAttack 用 AI 固定目标(order.targetId)，C 每 tick 重扫导致换目标
     （攻击中不换目标）；改为固定目标优先、失效才自动扫描后 3v1 对齐；
  3. 追击路径——仿真期玩家订单走 order_move（含实体），AI 追击走 routeUnit（无实体）
     直连，改用 sim_route 后 melee_apart 首击 19=19。
- **golden 修正**（combat_golden.mjs）：createUnit 参数错序(y 传成 0)致追进死区洒掉一批
  pos；原程序未设 `w.jass` → playerOf 全 undefined → hostile 全真 → 3v1 伪场景。
  注入最小 players 表（同 team 不互攻）+ eventId/fire/triggers stub 后真实语义锁定。
- **`tools/combat_test.mjs` 全场景硬门禁**：死亡 Δ≤45、首击 Δ≤3、攻击数 Δ≤6、HP 曲、
  首死 id——**melee_close 死亡1532/JS1573、melee_apart 1551/1592、melee_3v1 544/511**
  三场景全过。引擎回归 114/114、sim_test 全绿。

#### 2.8 远程武器导弹 C 移植（f63e678）——4/4 场景硬门禁全过 ✅
- **`engine/src/sim.c` 新增 SimMissile 表**（SIM_MISSILE_MAX=256，SOA 平铺）：
  active/srcId/targetId/x/y/dx,dy（aim 快照，JS launchMissile 的 dest）/speed/deadlineMs/
  amount（**发射时已 roll 好**，JS releaseAttack 先 roll 再发弹）/atkTypeIdx。
- **`release_attack` 分叉**（对齐 3103-3105）：`weaponKind != 0 && missileSpeed > 0`
  → 发射导弹（伤害延迟到命中）；否则近战直击 `sim_damage`。spawn_fight 补存 missileSpeed
  （原第 20 参没存进 SimUnit）。
- **`step_missiles(dt)`**（对齐 2929-2957）：homing 追踪（目标死 → 无伤坠落）、
  aimX/aimY 每 tick 取目标当前位、travel=speed·dt、reach=dist-radius、到达或超 deadline →
  命中调 `sim_damage`（射手已死则空耗）、否则按 dx/dist·travel 推进。
- **`sim_combat_step` 顺序**：先 `step_missiles(dt)` 再单位循环（stepMissiles 在 JS step()
  里本就先于单位循环；发射发生在攻击内，下一 tick 才动——自然对齐）。
- **`sim_spawn_fight` 增至 21 参**（+missileSpeed）。CMakeLists 导出不变（无新导出）。
- **golden 增 ranged_hwat**：hwat（人类哨兵，missile kind + 1300 速度 + 射程 300）vs hfoo。
  探测锁定：hp525/armor large/dmg 17+1d5/atkCd 1.5s/attackPoint 0.4/backswing 0.77/
  pierce/radius 32/moveSpeed 220/acq 500。golden 记录 types 数组供 C 侧按类型加载武器。
- **combat_test 对照 ranged_hwat**：死亡 1056 vs 1101（Δ45=容差边缘，随机 roll 抖动）、
  首击 7=7、攻击数 50 vs 52、HP 曲 OK、首死 id 1=1——**4/4 场景全过**。
- melee_3v1 的 JS deathTick 511→544：hfoo 伤害 11-13 随机，死亡 tick 抖动在 ±45 容差内。

#### 2.9 采集经济 C 移植（f735424）——采集循环硬门禁全过 ✅
- **`engine/src/sim.c` 新增**：
  - SimUnit 增 `kind`（0=other 1=hpea 2=ngol 3=htow）/`playerIndex`/gather 状态
    （gatherPhase 0=none 1=toMine 2=mining 3=toBase、mineId/baseId/gatherUntilMs）。
  - 全局 `GOLD[16]`（JS player.gold）。
  - `sim_spawn_econ(id,x,y,kind,playerIndex,speed,radius)` 放置经济单位。
  - `sim_get_res(playerIndex,out)` 读玩家资源（out[0]=gold）。
  - `walk_spot_near`（JS walkSpotNear 1391-1402：16 固定偏移 clearFootprint 单点探测）。
  - `sim_econ_step(dt)`（stepGathers 1342-1388 子集：hpea 且玩家 0/1）：
    toMine（近矿<140 → mining 1.8s；否则 walkSpotNear 下单 move）→ mining 完成
    → 找 base（kind=htow 且同 player）→ toBase（近基<280 或 idle 无路径 → +10 金回矿）
    → 空闲农民自动找最近 ngol。农民移动推进（step_move_unit 仅经济单位）。
- **CMakeLists** 增导出 `_sim_spawn_econ,_sim_econ_step,_sim_get_res`。
- **golden**（tools/econ_golden.mjs → goldens/econ_trace.json）：htow(1616,1200) +
  ngol(1488,1104) + hpea(1398,1106)，录 gold 事件 tick 全序列 + 农民轨迹抽样。
  首金 t57、周期 ~56.7 tick（挖矿 1.8s=54 tick 主导）。
- **econ_test 对照**：前 8 次交金逐次 Δ≤6（实测 Δ1-3）、末次 Δ≤20、交金次数 Δ≤1、
  农民终位一致——**采集循环硬门禁全过**。
- **节拍差异**：C 恒 56 tick/周期、JS 平均 56.7（浮点毫秒累积 + 移动差）→ 3600 tick
  边界 C 64 次 vs JS 63 次，末次差 17 tick，均在容差内。

#### 2.10 全量 tick + 事件桥（b401159）——4/4 场景全过 ✅
- **`sim_step(dt)`**（wasm_step 落地）：`SIM_NOW++` → `gather_pass()` → `step_missiles()`
  → 单位循环（step_ai_unit → step_move_unit → step_attack_unit）。对齐 JS step()
  顺序：stepGathers（只发单不下移）→ stepMissiles → 单位循环统一 stepMove。
- **重构**：`sim_econ_step` 的采集状态机提取为 `gather_pass()`（不含 SIM_NOW/移动推进），
  供 `sim_econ_step`（采集状态机 + 农民移动，供 econ_test）与 `sim_step`（全量）复用。
  `sim_combat_step` 保持不动（combat_test 用）。
- **事件桥**（JS emit 的 C 侧对等物）：固定环缓冲 `EV[SIM_EVENT_MAX=8192]`，每条
  `{tick,type,a,b}` 4 int32；导出 `sim_events_reset` / `sim_event_count` /
  `sim_events_get(out,maxN)`（float4 对读回）。
  - `SIM_EV_ATTACK(0)`：windup 设起时 push(a=srcId,b=targetId)——对齐 emit 3035。
  - `SIM_EV_MISSILE_END(1)`：导弹移除时 push(a=fx)——`SimMissile` 增 `fx` 字段 +
    全局 `FXSEQ` 计数器（launch 时 `++FXSEQ`）。
  - `SIM_EV_DEATH(2)`：`sim_damage` 里 `t->alive=0` 时 push(a=tgtId)。
- **tick 基准对齐**：golden 用 0-based 循环计数，C 的 `SIM_NOW` 在步内已自增
  （= t+1）→ `ev_push` 用 `SIM_NOW - 1` 写 tick，C/JS 事件 tick **精确相等**（首击 Δ0）。
- **`sim_clear_all` 增 reset**：`EVN=0`、`FXSEQ=0`、`SIM_NOW=0`——跨场景独立计数
  （原 bug：SIM_NOW 不重置导致第 2 场景起事件 tick 整体偏移 ~3600）。
- **CMakeLists** 增导出 `_sim_step,_sim_events_reset,_sim_event_count,_sim_events_get`。
- **新测试 tools/sim_step_test.mjs**：用 `sim_step` 跑 4 战斗场景，事件桥读回对照
  golden 的 atkEvents/deaths。结果：死亡 Δ41/41/0/45、**attack 首击全部 Δ0**、
  攻击数 76/76/55/50 vs JS 78/78/55/52、missileEnd 24 vs JS 25、death 事件 tick
  精确等于 deathTick——**4/4 全过**。
- **回归**：combat 4/4、econ 全过、engine 114/114、sim_test 全绿（零回归）。

#### 2.11 SOA 快照序列化进 WASM（阶段 3）——2/2 场景逐字段对账全过 ✅
- **`sim_snapshot(buf, maxN)`**：单位属性按列写入 wasm 连续 buffer，为 M5
  「wasm heap → GPU buffer」零拷贝链路与收尾「删 JS 双实现」准备。
  布局（全 f32，int 直接位塞）：`header(5) = tick, nowMs, nUnits, nMissiles, nEvents`
  + 单位列（`nUnits × 11`，列序 `x, y, facing, hp, maxHp, alive, team, playerIndex,
  kind, moving, gathering`）+ 玩家资源（`gold[16]`）+ 导弹列（`nMissiles × 2`，x,y）
  + 事件列（`nEvents × 4`，tick/type/a/b）。
  调用方先传 maxN，`need > maxN` 时不写只返回需要量（按需分配）。
- **活/死单位口径对齐**：JS `snapshot()` 收全部未 removed 单位（死亡单位带 `a:0`），
  故 C 用 `radius > 0` 作「曾放置」标记（`sim_spawn` 恒置 radius>0），而非 `alive`——
  死单位保留最后坐标，nUnits 两侧精确相等。
- **`sim_clear_all` 全字段重置**（原实现只清 alive/nPath）：`memset(U,M,GOLD)` +
  sentinel 补 `mineId/baseId/orderTargetId/attackWindupTarget = -1`。
  原实现让前一场景的 radius/team/gold 残留到下一场景，快照对账直接暴露。
- **`sim_spawn_econ` 增 facing/hp**：JS createUnit 传朝向、经济单位也有 HP
  （hpea 220 / ngol 1500 / htow 150000），快照要比对就得带进来。
- **赏金移植（门禁抓出的真实缺口）**：JS `awardKill`（world.js 884-889）击杀即向
  杀害者所属玩家发 `victim.bounty || 10 + level*4`（hfoo 20 / hwat 25）。
  C 侧 `SimUnit` 增 `bounty`/`level`，`sim_damage` 击杀分支结算
  `GOLD[src.playerIndex] += bounty || 10 + 4*level`，新增 `sim_set_meta(id, playerIndex,
  bounty, level)` 承载这三个 spawn 签名外的字段。**只结算金、不发事件**——JS 的
  `bounty` 浮字事件另受 `owner.givesBounty` 门控，那是地图 init 给 Player 0..7 开启的
  玩家槽状态，尚未移植。
- **新 golden tools/snapshot_golden.mjs** → `goldens/snapshot_trace.json`：经济采集
  （htow+ngol+hpea）与远程战斗（hwat vs hfoo）两场景，5 个检查点（t1/60/180/360/600）
  各录 `units[x,y,facing,hp,maxHp,team,pi,alive,mv]` + `gold[12]` + `nMissiles`。
  重跑字节级对比确认：经济场景完全确定，仅战斗场景 HP 因伤害 roll 抖动 ±1-4。
- **新测试 tools/snapshot_test.mjs（阶段 3 门禁）**：C 侧跑同场景 `sim_step` 到各检查点，
  `sim_snapshot` 解码后逐字段对账。门禁：单位数精确、Δx/Δy ≤2、Δfacing ≤0.1、
  team/pi/alive 精确、mv 不匹配 ≤1、经济 ΔHP/gold ≤0/10、战斗 ΔHP/gold ≤40/30
  （击杀时刻受 RNG 影响，允许差一次赏金）、导弹数 Δ≤1。
  **结果 2/2 全过**：单位数 3/3、2/2 精确；Δx0 Δy0 Δf0.00；经济 ΔHP0 Δgold0；
  战斗 ΔHP ≤15（≤40 门禁）；meta/mv 全 0。
- **门禁价值**：这一轮对账抓出三类真实问题——`sim_clear_all` 跨场景残留、
  快照列序与 JS 9 字段顺序错位（alive/team/pi 三列互换）、击杀赏金未移植。
  前两者属对账工具与快照接口的口径问题，第三者是 C 模拟的实质缺口。
- **回归**：combat 4/4、econ 全过、sim_step 4/4、sim_test 全绿、engine 114/114（零回归）。
  `npm test` 的 73 个失败均为环境性（Puppeteer 无法启动浏览器 Code 21）或
  server 侧预存断言，与本 diff 无关——`git status` 确认未触碰 `server/`，
  唯一改动的共享产物 `goldens/econ_trace.json` 只被通过的 `econ_test` 读取。

#### 2.12 命令输入通道（阶段 4 收尾第一步）——3/3 场景全过 ✅
- **动机**：阶段 3 做完后 wasm 只有输出（`sim_step` 推进 + `sim_snapshot`/事件桥
  出队），没有输入——玩家命令无法进 C 模拟，「删 JS 双实现」无从下手。
  本阶段补上对偶的输入环，落在 master plan M5「输入（玩家命令/事件）→ 导入 wasm
  heap 的 input buffer」的位置。
- **`sim_order_push(unitId, op, x, y, targetId)` / `sim_order_count` /
  `sim_order_clear` / `sim_flush_orders`**：固定命令环 `ORDS[SIM_ORD_MAX=256]`，
  JS 侧把命令入队，`sim_flush_orders` 在 `sim_step` 之前一次性应用
  （对齐 JS：命令到达即生效，不跨 tick 排队）。满环丢弃返回 0。
- **op 枚举**：`SIM_ORD_STOP=0` `HOLD=1` `MOVE=2` `ATTACK_MOVE=3` `ATTACK=4`，
  语义逐条对齐 `world.js order()`（1135-1232）：stop/hold（1181-1182）清路径回
  idle 并取消攻击 windup；move/attackMove（1222-1230）走 `sim_order_move` 含实体
  寻路、不可达则退回 idle；attack（1212-1220）固定目标，目标无效或同队拒绝
  （`weaponFor` 的可打性子集）。
- **`orderType` 扩展**：0=idle（自动获取）1=attack 3=move 4=attackMove。
  `step_ai_unit` 对 3/4 不做 `acquisitionRange` 全距追猎——显式移动命令不离开
  目标点，射程内敌人由 `step_attack_unit` 在 `atkRange+40` 内接战，路径走空
  才回 idle(0)（对齐 JS stepMove 2799-2810：move 只在到达点停下）。
  stop/hold 归并到 0：JS 里两者在 stepMove 分支下同为「无路径」，行为等价。
- **`sim_set_gives_bounty(pi, on)` + `SIM_EV_BOUNTY`**：阶段 3 只结算金不发事件，
  原因是 bounty 浮字受 `owner.givesBounty` 门控（地图 init 给 Player 0..7 开启）。
  本阶段把该玩家槽状态显式建模为 `GIVES_BOUNTY[16]`，条件满足时 push
  `{a=killer 玩家槽, b=gold}`，补齐 awardKill（world.js 901-903）最后一环。
- **`sim_clear_all` 增 `ORN=0`**：命令环与事件环、经济资源、单位哨兵字段一起
  归零，跨场景不残留。
- **CMakeLists** 增导出 `_sim_set_gives_bounty,_sim_order_push,_sim_order_count,
  _sim_order_clear,_sim_flush_orders`。
- **新 golden tools/order_golden.mjs** → `goldens/order_trace.json`：三场景
  ×多检查点（`move` 单 hfoo 走 400 单位；`attack` hwat/hfoo 显式 attack 指定
  目标而非自动获取；`stop` 追击途中给 hfoo 下 stop），录 units[x,y,facing,hp,
  alive,mv] + 累计 attack/death/bounty 事件 + `unitBounty`/`level`/`pl`。
- **新测试 tools/order_test.mjs（阶段 4 门禁）**：C 侧按 golden 的命令时刻表
  `sim_order_push` + `sim_flush_orders` 回放，`sim_snapshot` 逐检查点对账。
  **结果 3/3 全过**：`move` Δx0 Δy0 Δf0.00 ΔHP0；`attack` ΔHP≤10、50/50 攻击、
  首击 Δ1、死亡 Δ1、bounty [1055,0,20] 金额精确；`stop` ΔHP≤5、死亡 Δ45（=容差）、
  bounty 金额精确。
- **门禁抓出的问题**：① golden 里 `bounty` 字段名双用（每单位赏金与赏金事件
  数组同名，后者覆盖前者）导致 C 侧拿到 0 走了 `10+level*4` 回退（18≠20）——
  改名 `unitBounty`；② 事件环是**全量非消费式**（`sim_events_get` 每次从 0 读到
  EVN），在检查点循环里读会重复累积出 3 万条——改为循环内只比单位、末次统一读。
  两者都是对账工具的口径问题，非 C 模拟缺口。
- **回归**：combat 4/4、econ 全过、sim_step 4/4、snapshot 2/2、sim_test 全绿、
  engine 114/114（零回归）。

#### 2.13 快照驱动渲染（阶段 4 收尾第二步）——2/2 场景全过 ✅
- **动机**：master plan M4 的第三条交付是「JS 侧改为读 wasm 快照渲染」。此前 SOA
  快照只有运动/战斗字段，缺**单位标识**——客户端 `findMeta(e)` 靠 `e.u`（typeKey）
  查模型/名称/英雄判定，快照里没有，渲染无从下手。本步补上读路径。
- **快照增 4 列（`SIM_SNAP_COLS` 11 → 15）**：`id`（wasm 槽位索引）、`level`、
  `mana`、`maxMana`。**追加在末尾**，前 11 列偏移不变，旧解码器无需改。
  `id` 是读路径的关键：JS 侧按槽位回查 `typeKey`/模型/英雄标记，等价于客户端的
  `findMeta`；`level`/`mana`/`maxMana` 是英雄条。
- **`sim_spawn_econ` 增 `team` 参数**：原先硬编码 `team=0`，中立金矿属中立玩家
  时（team 1）与 JS 不一致——门禁直接抓出（`t:0` vs `t:1`）。签名变为
  `(id,x,y,kind,playerIndex,team,speed,radius,facing,hp)`，econ_golden 同步补
  `team` 字段。
- **新 golden tools/render_golden.mjs** → `goldens/render_trace.json`：econ 与
  ranged_hwat 两场景，录 JS `world.snapshot()` 的 ents 全字段（i/k/u/x/y/f/t/p/c/
  a/sel/h/H/m/M/l/mv）+ **槽位注册表 `slots`**（id/u/k/sel，供 JS 侧回查）+
  `colors`（每玩家槽颜色）+ `pos`/`kinds`/`pl`/`team`/`hp`/`face`/`unitBounty`/
  `level`/`mana`。
- **新测试 tools/snaprender_test.mjs（阶段 4 门禁）**：内置适配层
  `snapshotToRender(units, slots, colors)` 把 SOA 快照转成 ents 形状，按单位 id
  对齐逐字段比对。**结果 2/2 全过**：econ Δx0 Δy0 Δf0.00 Δh0 meta0（精确）；
  ranged_hwat Δh≤15（RNG 容差 40 内）、其余精确。
- **门禁抓出的问题**：① golden 的 `pos` 在检查循环**之后**捕获，记成了终态而非
  初态（Δx224）——移到步进前；② `sim_spawn_econ` 缺 `team`（见上）；③
  snapshot_test 的 gold 偏移硬编码 `5 + 11*nU`，增列后读到 `id` 列——改为 15；
  ④ 两个 golden 的金矿 team 设置不一致（0 vs 1）造成朝向分歧 0.64 rad——统一为
  snapshot_golden 的 team 0 场景。**四者全是对账口径/场景一致性问题，非 C 模拟缺口。**
- **渲染缺口（C 快照拿不到、由 JS 侧保留）**：`b`（buff 模型）、`bld`（建造
  进度）、`q`（命令队列长度）、`ab`（可施法列表）、`items`/`clock`/`quests`/`res`
  （世界级字段）。这些依赖 buff/建筑/能力系统，尚未移植进 C——见 M6。
- **回归**：combat 4/4、econ 全过、sim_step 4/4、snapshot 2/2、order 3/3、
  sim_test 全绿、engine 114/114（零回归）。

#### 2.3 C 移植设计
- sim 单位表扩展：hp/maxHp/atkTimer/attackWindup/weapon 快照（atkCd/attackPoint/
  atkRange/dmg/atkType/atkTargetsAllowed 位集）+ team/playerOf
- 导弹表（SOA 数组）：x/y/speed/dx/dy/targetId/onHit 类型+伤害参数——复用
  launchMissile 快照语义
- 伤害公式：先无 buff 纯数值（护甲减伤/魔法抗性表），buff 依赖留给 ability 桥
- `wasm_step(dt)` **（b401159 已落地为 `sim_step`）**：gather → 导弹 → 单位循环（移动→
  攻击）+ 事件出队（attack/missileEnd/death push 出 heap，JS 消费——阶段 2 事件桥 ✅）

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

## 3. SOA 快照布局（阶段 3 落地，阶段 4 增列，见 2.11/2.13）

原草案（magic/version/CRC32/mana/typeId）按实际需要对齐为：

```
// 全 f32 连续 buffer；int 直接位塞（tick/team/pi/kind 值域小，f32 无损）
f32 header[5]  = tick, nowMs, nUnits, nMissiles, nEvents
f32 单位列[nUnits × 15]，列序：
      x, y, facing, hp, maxHp, alive, team, playerIndex, kind, moving, gathering,
      id, level, mana, maxMana
f32 gold[16]                          // 玩家资源（经济列）
f32 导弹列[nMissiles × 2]             // x, y
f32 事件列[nEvents × 4]               // tick, type, a, b
```
- 前 11 列是阶段 3 的原始布局；`id`/`level`/`mana`/`maxMana` 是阶段 4 为
  「JS 侧读 wasm 快照渲染」追加的，**放末尾所以旧解码器无需改**。
  `id` 是 wasm 槽位索引——JS 侧按它回查 `typeKey`/模型/英雄判定
  （客户端 `findMeta` 的等价物），是快照能驱动渲染的关键一环。
- **未做 magic/version/CRC32**：对账门禁直接逐字段比对，比列哈希更直接定位差异；
  跨版本兼容待多实现并存时再加。
- **未做 typeId 字符串**：C 侧不存 `typeKey`，靠 `id` + JS 侧注册表回查（客户端
  本来就自己从 data/abilities.json 读名与图标）。`kind` 保留供经济分支判定。
- **体积**：单位 15 × 4 = 60 B/单位（阶段 3 为 44 B，草案估 ~30 B），几千单位
  ≈ 百 KB/tick，量级不变，仍远低于 WebSocket 压力线。

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

| 阶段 | 内容 | 预计 | 状态 |
|---|---|---|---|
| 1 | 移动/寻路/碰撞进 WASM | 1-2 周 | ✅ |
| 2 | 弹道/攻击/经济进 WASM | 1-2 周 | ✅（全量 tick + 事件桥） |
| 3 | SOA 快照 + 对账门禁 | 1 周 | ✅（见 2.11） |
| 收尾 | 删 JS 双实现/开关切换 | 1 周 | 进行中（命令输入通道 ✅，见 2.12） |

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
