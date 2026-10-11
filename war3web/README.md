# War3Web — 魔兽争霸3（Terenas 官方对战图）浏览器版

War3Web 把 Warcraft III 官方对战图 **Terenas Stand** 跑在网页上：Node 权威服务器 +
JASS 虚拟机（跑地图自带的 `war3map.j` 脚本）+ 真实数值世界引擎（`world.js`）+ Three.js
客户端（WebGL，可切 WebGPU）。所有数据——单位、建筑、技能、地形、模型、命令卡——都
**提取自真实游戏**（war3.mpq + terenas.w3x），没有任何手画/拍脑袋的数字。

> 仓库根是 `C:\Users\a1\war3`，`war3web/` 是其中的主项目目录（git 仓库根在上层）。
> 资源文件全部被 gitignore，**clone 下来不能直接跑**——见[快速开始](#快速开始)。

---

## ⚠️ 当前状态（一句话，2026-10 收尾）

| 通道 | 状态 | 说明 |
|---|---|---|
| **JS world（JSON 快照）** | ✅ **唯一权威，全速** | 服务器 `world.js` 收全部玩家命令并模拟，客户端位置/HP 全部来自 JSON 快照 |
| **WASM sim（binary 快照）** | ⛔ **已停用** | 客户端不再启用 binary 通道；服务器照发但被忽略 |
| **WASM 引擎本体** | 🔌 **未接线（空转）** | `engine/src/sim.c` 实现了寻路/战斗/经济/建造/buff/SOA 快照，但**收不到玩家命令**，与 JS 世界是"镜像"关系（JS ⊇ wasm） |
| **联机** | 🚧 **未完成** | 房间支持双人同房对局（同服务器双浏览器），但"无权威服务器的对等联机"（lockstep）未实现 |

历史遗留：曾同时广播 JSON（JS 位置）和 binary（wasm 冻结位置）两条快照，客户端每 10 tick
互相覆盖 → 单位来回闪烁、建筑像被拖动。修复：停用 binary 通道，JSON 全速唯一权威（`4282efc`）。

---

## 快速开始

```bash
cd war3web
npm install          # 依赖：three、ws（+ dev 用 puppeteer-core）
npm start            # = node server/index.js，默认 http://localhost:8080
# 换端口：PORT=8090 npm start
```

浏览器开 `http://localhost:8080/` → 填名字 → 加入红/蓝方 → 准备 → 进游戏
（城镇大厅 + 5 农民 + 500 金，农民自动采矿 → 训练/建造/右键移动攻击）。

**资源从哪里来**：git 里没有 `terenas.w3x`、`extracted/`（解包地图脚本）、`war3_extracted/`
（解包魔兽）、`assets/`（模型贴图）、`data/`（数据表）、`public/`（产物）、`node_modules/`。
它们由 `tools/` 管线从你自己的 MPQ/w3x 生成（约 1.4 GB），当前工作机从共享文件夹直接拿整
个 `war3web/` 目录，不走 clone。

---

## 架构

```
浏览器 (Three.js client)
   │  命令: MOVE / ATTACK / BUILD / TRAIN ...（WebSocket JSON）
   ▼
server/index.js  ── room.js（房间/座位/广播）
   │                handleMessage：命令 → world.order()
   ▼
server/world.js  = 权威世界模拟（移动/A*寻路/自动攻击/伤害/经济/建造/技能）
server/jass/    = JASS VM（跑官方 war3map.j：开局/野怪/胜负/商店…）
server/wasm_bridge.js = WASM sim 桥（spawn + step + buff，【不含命令】）
   │
   └─► 快照广播：JSON（权威，15Hz+） + binary SOA（客户端已忽略）
```

| 目录 | 职责 |
|---|---|
| `server/index.js` | HTTP + WebSocket 入口（8080） |
| `server/world.js` | 引擎级模拟：移动、寻路、自动攻击、伤害、经济、建造（**权威**） |
| `server/room.js` | 房间、座位分配、消息路由、快照广播（`jsonInterval`、`clientBinaryReady`） |
| `server/jass/` | JASS lexer/parser/VM/engine/boot，`war3map.j` 原样运行 |
| `server/wasm_bridge.js` | 加载 `engine/out/engine.mjs`，把 spawn/step/buff 喂给 WASM sim |
| `client/js/main.js` | 主循环、输入、消息、实体视图；WebGPU 开关 |
| `client/js/render.js` | Three.js 渲染；`WebGPURenderer` 接线 |
| `engine/src/` | C 源码：`sim.c`（RTS 模拟）、`jass.c`（JASS VM）、`w3x.c`、`math.c` |
| `tools/` | 数据管线（Python）+ 全部测试（`*_test.mjs`） |

## WASM C 引擎（engine/src/sim.c）

用 Emscripten 构建（`npm run engine` → `engine/out/engine.mjs` + `.wasm`）。已实现：

- **A\* 寻路 + 碰撞**（对齐 `world.js` 行为）
- **战斗**：前摇/攻击导弹/伤害/buff 减伤/魔盾/吸血
- **经济**：采矿交金循环
- **建造**、**buff 系统**、**`sim_snapshot` SOA 快照**（按列零拷贝，供 GPU 直读）

关系：**wasm 是 JS 世界的功能子集镜像**（逐项对齐 `world.js` 的语义），但**命令输入流没有
接入**（`room.js` 的 MOVE/ATTACK/BUILD/TRAIN 只调 `world.order()`，没有同步喂给
`sim_order_push`），所以它当前空转、不产出权威状态。这是下一步联机（lockstep）的地基：
同一份 `sim.c` 可在任何端跑，命令小包 + hash 对账 = RTS 对等联机的正统做法。

验证：`npm run engine:test`（引擎对照测试）、`npm run sim:test`（模拟对账）、
`npm run wasm:test`。全套 `npm test` 走 `tools/run_tests.mjs`，跑得久，日常用上面的单项。

## WebGPU 渲染

默认 WebGL；**开 WebGPU**：F12 控制台执行 `localStorage.webgpu='1'` 后刷新（`render.js`
检测到开关会 `import('three/webgpu')` 并异步初始化 `WebGPURenderer`，`rendererReady` 就绪后
渲染循环才会走 GPU 后端；`backend.device` 存在即已接通）。实测 `WebGPUBackend` + device
正常就绪，95+ 单位模型下 draw call 显著下降。回退：`forceWebGL` 开关保留，WebGPU 异常自动
跳过渲染帧而非白屏。

## 已修复的关键问题（本次收尾）

| 问题 | 根因 | 修复 |
|---|---|---|
| 农民移动疯狂闪烁 / 大厅像被拖动 | JSON（JS 真位置）与 binary（wasm 冻结位置）双通道互相覆盖 | 停用 binary 通道，JSON 唯一权威（`4282efc`） |
| 基地建在地图中心 | 玩家 engine index=5 的 start location 未预置 → 默认 `[0,0]` → `freeSpotNear` 落到 (16,16) | `room.js` 开局前按队伍预置 `[-4032,2112]`/`[3968,-2560]`（`027ea0f`） |
| 单位绕圈颤抖 | spawn 朝向未归一化到 `[-π,π]` | `sim.c` facing 归一化（`1fdcfa3`） |
| 客户端认不出自己的单位（nOwn=0、相机不居中） | `e.t === S.slot` 拿队伍号比玩家索引 | 新增 `S.team`，按 `e.t === S.team` 判断（`027ea0f`） |

## 数据与版权

仓库只含代码与文档（管线、服务器、客户端、C 引擎，约 1 MB 源文件），**不含**魔兽争霸3
档案（`war3.mpq` 等）、地图（`terenas.w3x`）、以及任何派生素材——它们全部由构建从你自己
的副本生成（`tools/` 管线），因此被 gitignore。`LICENSE`（MIT）只覆盖机器部分；Blizzard
的数据与地图版权归各自权利方。`THIRD_PARTY_NOTICES.md` 记录引用的三方库
（three.js、StormLib 等）。

## 仓库结构（git 根 `C:\Users\a1\war3`）

```
war3/  (git 仓库根)
├── war3web/           ← 主项目（本 README）
├── wasm/              C 解包栈（StormLib 源码 + mpq_reader.c，已入库）
├── docs/              中文交接文档（探索/结构解析、交接/当前状态）
├── scripts/           杂项工具（blp2png 等）
├── extracted/ mpq/ refs/   本地参考数据（全部 gitignore，不入库）
└── deps.md            工具链依赖清单（three / smpq / emscripten / StormLib）
```

## 当前缺口 / 下一步

1. **命令接线**（M6 核心缺口）：`room.js` 的 MOVE/ATTACK/BUILD/TRAIN 分支同步调
   `sim_order_push` / `sim_order_build`，客户端恢复 binary handler 与 `BINARY_READY`。
   约一天工作量。
2. **对等联机（lockstep）**：命令带 tick 序列号、各端本地跑同一份 wasm、N tick 对 hash；
   服务器降级为撮合/中转。这是 wasm 引擎唯一真正发光的地方。
3. 相机自动居中等小项（本会话未复测）。

---

*文档与 git 状态对齐：HEAD = `027ea0f`（2026-10 收尾），分支 `master`，remote
`git@github.com:chentianxiong123/war3web.git`。*
