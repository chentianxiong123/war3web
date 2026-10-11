# M4 阶段 4：server 端 wasm 集成 PoC + 剩余工作规划

> 前置阅读：docs/M4_SIM_WASM_PLAN.md（阶段 1-3 + 收尾总计划）
> 本文档定位：阶段 4 剩余工作的规划 + server wasm 集成 PoC 结果 + 方案选型
> 更新时间：2026-10-11

## 1. 当前状态总结

### 1.1 M4 阶段 1-3 ✅ 已完成

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 | 移动/寻路/碰撞（A* + 扫掠圆盘 + string-pull） | ✅ `tools/sim_test.mjs` 5/5 |
| 2 | 近战/导弹/经济/赏金 + 事件桥 | ✅ `combat_test` 4/4 + `sim_step_test` 4/4 |
| 3 | SOA 快照 15 列 + 对账门禁 | ✅ `snapshot_test` + `snaprender_test` 2/2 |

### 1.2 阶段 4 收尾进行中（🔄）

| 子项 | 状态 | 参考 |
|---|---|---|
| 命令输入通道 | ✅ 2.12 | `tools/order_test.mjs` |
| 快照驱动渲染 | ✅ 2.13 | `tools/snaprender_test.mjs` |
| buff 效果桥（armor/slow/rage/defend/manashield/vampiric/regen/stun） | ✅ 2.14 | `tools/buff_test.mjs` 3/3 场景 |
| **invis/silence buff** | 🔄 另一个子任务在做 | — |
| **建筑建造进度** | ⏳ 未开始 | — |
| **物品系统** | ⏳ 未开始 | — |

### 1.3 本文档交付（阶段 4 PoC）

| 交付物 | 路径 | 状态 |
|---|---|---|
| server wasm 集成 PoC | `tools/m4_wasm_server_poc.mjs` | ✅ 15/15 检查通过 |
| wasm 桥模块 | `server/wasm_bridge.js` | ✅ 冒烟测试通过 |
| 阶段 4 规划 | `docs/M4_PHASE4_PLAN.md`（本文档） | ✅ |

---

## 2. server wasm 集成方案

### 2.1 背景

当前架构：
- `server/world.js`（~3200 行）：JS 模拟核心，`w.step()` 推进游戏
- `server/room.js`：WebSocket 服务，广播 `w.snapshot()` 的 JSON 结果
- `engine/out/engine.mjs`：WASM 模块，包含 `sim_step`/`sim_snapshot` 等 C 函数
- 目前 wasm 仅在 Node 测试中调用，未接入任何运行中的游戏

用户明确说**两套共存**（不删 JS），所以不是替换 world.js，而是：
- world.js 继续跑能力/触发器/物品等 JS 独占系统
- wasm 跑模拟核心（移动/攻击/经济/buff 效果）
- 两者通过 API 桥接（如 `sim_apply_buff` 让 JS 能力给 C 单位加 buff）

### 2.2 方案 A：server 同时跑 world.js + wasm，两套数据同步

```
[world.js step] ←→ [wasm sim_step]
     ↓                   ↓
[双套 snapshot]    [SOA buffer]
     ↓                   ↓
[JSON 广播]       [二进制广播]
```

- **做法**：每个 tick 都跑两套；world.js 保留全部逻辑（含能力/触发器/物品），
  wasm 跑模拟核心，两者共享单位表，通过 `sim_apply_buff` 等桥接 API 让 JS 能力影响 C 单位
- **优点**：world.js 完整保留（能力/触发器/物品零损失）；wasm 与 JS 可对账
- **缺点**：CPU 双份；两套状态可能不一致（JS 走 A* 寻路，wasm 走自己的 A*，路径可能不同步）；
  snapshot 需要合并两份数据

### 2.3 方案 B：server 跑 wasm，JS 能力通过 API 桥注入（✅ 推荐）

```
[client input] → [server]
                    ↓
              [wasm sim_step]  ← 移动/攻击/经济/buff 效果
                    ↑
              [JS 能力引擎]    ← world.js 的能力/触发器/物品
                    ↓
              [wasm sim_apply_buff]  ← JS 能力给 C 单位加 buff
                    ↓
              [wasm sim_snapshot] → [JSON 广播]
```

- **做法**：
  - 模拟核心（移动/攻击/经济/buff 效果/寻路）全部由 wasm 负责
  - JS 仅保留：能力系统、触发器、物品、资产加载、网络层
  - JS 能力每 tick 检查触发条件，命中则调 `br.applyBuff(id, kind, code, ...)` 给 C 单位加 buff
  - 命令输入直接调 wasm 的 `sim_order_push`
- **优点**：CPU 单份；行为一致（wasm 是唯一权威）；与 M5 零拷贝衔接自然
- **缺点**：JS 能力系统需要重写为"查询 + 触发"模式；world.js 需拆分（保留能力/触发器/物品，移除模拟核心）

### 2.4 方案 C：server 只跑 wasm，JS 仅做资产加载和网络（最激进）

- **做法**：所有游戏逻辑（含能力/触发器/物品）都写进 wasm C
- **优点**：性能极致；无 JS/wasm 同步问题
- **缺点**：触发器/能力是 JASS 脚本，移植到 C 工作量巨大（M3 已移植 JASS VM，但 JASS → wasm 能力系统仍需大量工作）；不符合"两套共存"原则

### 2.5 推荐：方案 B

理由：
1. **符合用户"两套共存"要求**：world.js 保留能力/触发器/物品系统，wasm 跑模拟核心
2. **CPU 单份**：wasm 是唯一权威，JS 仅做 IO 和能力触发
3. **与 M5 衔接自然**：M5 的 zero-copy 数据流（wasm SOA → GPU buffer）已经在 `tools/m5_zero_copy_test.mjs` 验证通过
4. **渐进式迁移**：可以一个子系统一个子系统切（先切移动/攻击，再切经济，再切能力桥）

---

## 3. 阶段 4 剩余项分步计划

### 3.1 短期（1-2 天）：阶段 4 收尾

| 子项 | 工作量 | 依赖 | 状态 |
|---|---|---|---|
| invis/silence buff 效果深化 | 2-3h | sim.c buff 系统 | 🔄 另一个子任务在做 |
| 建筑建造进度（htow/hcoc 等） | 1-2 天 | sim_spawn_econ + 建造状态机 | ⏳ |
| 物品系统（掉落/拾取/使用） | 1-2 天 | item 表 + 单位携带槽 | ⏳ |
| server wasm 集成 PoC 验证 | ✅ 本文档 | — | ✅ |

### 3.2 中期（3-5 天）：方案 B 落地

| 步骤 | 内容 | 交付 |
|---|---|---|
| 1 | 拆分 `server/world.js`：保留能力/触发器/物品，移除模拟核心 | `server/abilities.js` + `server/items.js` + `server/world.js`（薄壳） |
| 2 | `server/room.js` 改用 `WasmBridge`：step + snapshot + applyBuff | `server/room.js`（wasm 驱动） |
| 3 | 能力系统每 tick 调 `br.applyBuff`：注入 armor/slow/rage 等 | `server/abilities.js` |
| 4 | 命令输入走 `sim_order_push` | `server/room.js` |
| 5 | 快照广播：SOA → JSON（或二进制，M5） | `server/room.js` |
| 6 | 端到端测试：浏览器渲染 + 对账 | `tools/m4_phase4_e2e.mjs` |

### 3.3 长期（1 周+）：M5 衔接 + 性能优化

| 子项 | 说明 |
|---|---|
| M5 zero-copy 数据流 | wasm SOA → GPU buffer 零拷贝上传（已在 `tools/m5_zero_copy_test.mjs` 验证） |
| 大规模场景性能测试 | 100+ 单位、多房间并发 |
| 能力系统 wasm 化（可选） | 把高频能力（如 aura）也搬进 wasm |

---

## 4. PoC 结果

### 4.1 场景 A：2 敌对 hfoo + 1 中立金矿，100 tick

```
首帧 nUnits=3, tick=0, nEvents=0
最终 tick=100, nUnits=3, nEvents=6
单位状态：
  id=0 kind=0 team=0  x=1300 y=1100  hp=399/420
  id=1 kind=0 team=1  x=1400 y=1100  hp=387/420
  id=2 kind=2 team=2  x=1350 y=1300  hp=50/50  (金矿)
事件：6 attack, 0 death
对账：首击 Δ≤3，100 tick 攻击数 Δ≤2（C=6 / JS=6）
```

### 4.2 场景 B：sim_apply_buff regen

```
初始 hp=100，施加 regen buff（flat=2 HP/s，永久）
60 tick 后：hp=104（Δhp=4.00，期望≈4）
```

### 4.3 场景 C：农民采集 + 金收入账

```
300 tick 后：玩家 0 金=50
（农民 2-3 次往返，每次交付 10 金）
```

**15/15 检查通过**：wasm 在 Node server 环境可跑完整 tick（step/snapshot/events/buff/econ 全通）。

---

## 5. wasm_bridge.js API

```js
import WasmBridge, { DEFAULT_UNIT_TYPES } from './server/wasm_bridge.js';

const br = new WasmBridge({
  walkBin: 'public/data/walk.bin',     // 默认值
  dmgTable: { normal: { large: 1.0 }, ... },  // 或从 gameplay.json 自动读
  unitTypes: { ...DEFAULT_UNIT_TYPES },
  maxUnits: 512,
  snapBufSize: 65536,
});

await br.init();               // 加载 wasm + grid + damage table
br.spawn(0, 1300, 1100, 'hfoo', { team: 0, playerIndex: 0 });
br.spawn(1, 1400, 1100, 'hwat', { team: 1, playerIndex: 1 });
br.step(1 / 30);               // 推进 1 tick
const snap = br.snapshot();    // SOA 快照（解码后返回）
br.applyBuff(0, 'regen', -1, 0, 0, 0, 2.0);  // JS 能力施加 buff
br.applyBuff(1, 'slow', 42, 3000, 0.5, 0.3, 0);  // 减速 buff
const buffs = br.getBuffs(0);  // 读取 buff 列表
const fight = br.getFight(0);  // { hp, atkTimer, windup, atkCount, dmgCount, alive }
const gold = br.getGold(0);    // 玩家 0 金
const events = br.getEvents(); // 事件队列
br.destroy();                  // 释放 wasm 内存
```

**关键 API**：
- `init()`：加载 wasm，初始化 grid 和 damage table（幂等）
- `step(dt)`：调用 `sim_step`
- `snapshot()`：返回 SOA buffer + header（解码后的对象）
- `applyBuff(id, kind, code, until, pct, atkPct, flat)`：转发到 `sim_apply_buff`
- `spawn(id, x, y, typeKey, meta)`：按 typeKey 查表 spawn 单位（isFight 走 `sim_spawn_fight`，否则 `sim_spawn_econ`）
- `clearAll()`：清所有单位 + 事件
- `eventsReset()`：清事件队列
- `getBuffs(id)` / `getFight(id)` / `getGold(playerIndex)` / `getEvents()`：查询接口

**注意**：
- `applyBuff` 的 `until` 参数是 tick（秒单位，`ms/1000*30`），0 = 永久
- `kind` 支持字符串名（`"regen"`/`"stun"`/`"slow"`/...）或数值枚举
- `typeKey` 查表得到战斗/经济单位参数；缺表返回 false
- 每个房间/World 创建独立 WasmBridge 实例（wasm 内存不共享）

---

## 6. 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| JS 能力系统与 wasm 状态不一致 | 中 | 高 | 每次能力触发后强制刷新 wasm 状态；对账测试覆盖主要能力 |
| 建筑/物品系统 wasm 移植工作量 | 中 | 中 | 先方案 B 落地移动/攻击/经济，建筑/物品可暂留 JS 侧 |
| 性能瓶颈（多房间并发） | 低 | 高 | 每房间独立 wasm 实例；M5 零拷贝减少 snapshot 开销 |
| 事件时序与 JS 不一致 | 低 | 中 | 事件桥已在 sim_step_test 验证，阶段 4 收尾对账 |
| 浏览器渲染路径切换 wasm 失败 | 低 | 中 | `tools/m5_zero_copy_test.mjs` 已验证客户端解码；灰度开关 |

---

## 7. 验证命令

```bash
# 阶段 4 PoC
node tools/m4_wasm_server_poc.mjs

# 阶段 4 收尾（已有测试）
node tools/combat_test.mjs      # 近战 3 + 远程导弹 1
node tools/econ_test.mjs        # 采集循环
node tools/sim_step_test.mjs    # 全量 tick + 事件桥
node tools/snapshot_test.mjs    # SOA 快照字段级对账
node tools/order_test.mjs       # 命令输入通道
node tools/snaprender_test.mjs  # 快照驱动渲染
node tools/buff_test.mjs        # buff 效果对账
```

---

## 8. 后续工作

1. **阶段 4 收尾**：invis/silence buff + 建筑 + 物品（3 个子任务并行）
2. **方案 B 落地**：拆分 world.js + room.js 切 wasm + 能力桥
3. **M5 衔接**：浏览器渲染路径切 wasm（zero-copy 上传）
4. **端到端测试**：浏览器完整游戏对账
