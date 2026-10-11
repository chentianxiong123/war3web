# War3Web · 当前状态总览 + 在 Windows 上运行（交接文档 v3）

> 2026-10-11 更新（v2 为 2026-10-08）| 用途：交代"现在是什么、怎么跑、东西都在哪、哪些没通"。
> 项目在 Windows 上跑：Node 直接起服务即可，无需 Linux。

---

## 〇、一句话现状

**魔兽争霸3（官方对战图 Terenas Stand）已经真实跑在网页上，本轮收尾已提交。**

- 服务端：Node 权威服务器 + JASS VM（跑官方 `war3map.j`）+ 官方数值世界引擎（`world.js`）
- 客户端：Three.js 浏览器客户端（默认 WebGL，**WebGPU 已合回主 client**），中文 UI
- 数据：全部来自真实游戏（war3.mpq 1.27 中文版 + terenas.w3x 解包），无占位符

**能玩的闭环**：进图（城镇大厅 + 5 农民 + 500 金）→ 农民自动采矿交金 → 大厅训练出兵 →
农民建造建筑 → 右键移动/攻击。同房间红蓝双人可同局（同一个 server 下两个浏览器）。

**必须知道的三件事（不夸张版）**：

| # | 事实 | 影响 |
|---|---|---|
| 1 | **JS world 是唯一权威**，JSON 快照全速；**WASM binary 通道已停用**（客户端忽略） | 显示正常、不闪烁；wasm 不参与当前对局 |
| 2 | **WASM 引擎（sim.c）已实现寻路/战斗/经济/建造/buff/SOA 快照，但没接命令流** | 它是"镜像"，空转；接命令是下一步（约 1 天） |
| 3 | **"无权威服务器的对等联机"（lockstep）未完成** | 当前只能同一服务器内双人；跨机对等联机是 wasm 引擎的最终用途 |

---

## 一、目录在哪（git 仓库根是上层）

| 路径 | 说明 |
|---|---|
| `C:\Users\a1\war3\` | **git 仓库根**（`.git` 在这层，不是 war3web 里） |
| `C:\Users\a1\war3\war3web\` | 主项目代码（server/client/engine/tools/docs…） |
| git remote | `git@github.com:chentianxiong123/war3web.git`（分支 master） |

> ⚠️ gitignore 拦了资源（`assets/`、`mpq/`、`war3_extracted/`、`extracted/`、`data/`、
> `public/`、`node_modules/`、所有 `*.wasm`/`*.w3x` 产物）。**代码可 clone 重建，资源不可**。
> 跨机部署走共享文件夹/拷贝整目录，不要 clone 了再问为什么跑不起来。

---

## 二、项目结构

```
war3/ (git 仓库根)
├── war3web/                  ← 真正的项目代码
│   ├── server/
│   │   ├── index.js          入口（端口 8080；PORT 环境变量可换）
│   │   ├── world.js          权威世界模拟（移动/A*/战斗/经济/建造/技能）
│   │   ├── room.js           房间/座位/消息路由/快照广播
│   │   ├── jass/             JASS VM（跑官方地图脚本）
│   │   ├── wasm_bridge.js    WASM sim 桥（spawn+step+buff，【无命令】）
│   │   └── abilities.js      技能引擎（数据驱动）
│   ├── client/               Three.js 客户端（main.js / render.js / ui.js / hud.js）
│   ├── engine/src/           C 引擎：sim.c（RTS 模拟核心 78KB）、jass.c（JASS VM）、
│   │                         w3x.c、math.c —— Emscripten 构建（npm run engine）
│   ├── engine/out/           engine.mjs（已入库）；engine.wasm（产物，gitignore，需构建）
│   ├── tools/                数据管线（Python）+ 全部测试（*_test.mjs）
│   ├── docs/                 ARCHITECTURE.md / PROGRESS.md / M2-M6 计划文档 / 审计文档
│   ├── public/ assets/ data/ extracted/ war3_extracted/   ← 管线产物（gitignore）
│   └── package.json          start / dev / engine / engine:test / sim:test / wasm:test / test
├── wasm/                     C 解包栈（StormLib 源码 + mpq_reader.c，已入库）
├── docs/                     中文交接文档（本目录）
├── scripts/                  杂项工具（blp2png 等）
└── deps.md                   工具链依赖（node/three/smpq/emscripten/StormLib）
```

---

## 三、在 Windows 上跑起来（3 分钟）

前置：**Node.js ≥ 20.11**。

```bat
cd C:\Users\a1\war3\war3web
npm install          （只需一次）
npm start            （= node server/index.js，端口 8080）
```

浏览器开 `http://localhost:8080/` → 填名字 → 加入红/蓝 → 准备 → 进游戏。

换端口 / 双开测试：`set PORT=8090` 再 `npm start`，另一个浏览器开 `localhost:8090`，
两个房间互不干扰（同 server 内支持多房间）。

### 双人对战（同服务器）

同一个 server 下两个浏览器分别加入红方/蓝方（座位 slot 0/1），即双人对战。
局域网内另一台机器浏览器直接开服务器 IP:8080 也能加入。

---

## 四、现在做到什么程度（信任清单 · 2026-10-11）

### ✅ 已通（实测）
- 数据全官方：unittypes / abilities / icons / commands / 命令卡关系表，全部提取自游戏
- JASS VM 跑 Terenas 官方 `war3map.j`；伤害 = 官方 GameplayConstants（攻防克 7×8 公式）
- 闭环：进图（大厅+5农+500金）→ 自动采矿 → 训练（步兵/弓箭手/牧师/女巫/迫击炮/狮鹫/飞机）
  → 建造（11 种官方建筑，右下角命令卡）→ 右键移动/攻击
- 修复：基地位置（按队伍预置出生点 `027ea0f`）、单位闪烁（停 binary 通道 `4282efc`）、
  朝向抖动（归一化 `1fdcfa3`）、单位归属判断（`S.team`）
- WebGPU：`localStorage.webgpu='1'` 后刷新即用 WebGPURenderer（实测 WebGPUBackend+device 就绪）

### 🔧 已实现但未通电（WASM 引擎，engine/src/sim.c）
- A* 寻路/碰撞、战斗（前摇/导弹/伤害/buff 减伤/魔盾/吸血）、经济（采矿交金）、建造、buff、
  SOA 快照（按列零拷贝）
- **卡点**：房间的 MOVE/ATTACK/BUILD/TRAIN 只喂了 `world.order()`，没喂 `sim_order_push`
  → wasm 空转、位置冻结。功能是 JS world 的"子集镜像"（JS ⊇ wasm）

### 🚧 未完成
- wasm 命令接线（约 1 天）：`room.js` 命令分支同步调 sim 命令 API + 客户端恢复 binary
- 对等联机 lockstep（命令带 tick、各端跑同一份 wasm、N tick 对 hash；服务器降级为中转）
- 相机自动居中等小项（本会话未复测）

### 🧪 测试
- `npm run engine:test`（引擎对照）、`npm run sim:test`（模拟对账）、`npm run wasm:test`
- 全套 `npm test` = `tools/run_tests.mjs`（跑得久，日常用单项测试而非全量）

---

## 五、服务端 / 端口 / 重启

| 用途 | 端口 | 说明 |
|---|---|---|
| 主服务 | 8080 | `npm start` 默认 |

重启：停掉 `node server/index.js` 进程 → 再 `npm start`。
（本机无 systemd；开发时可用 `npm run dev` = `node --watch`，改代码自动重启）

---

## 六、历史遗留（v1/v2 转接问题核实）

| 遗留项 | 状态 |
|---|---|
| 命令卡/技能按钮图标 | ✅ 官方渲染器 + 官方命令表 + ability_icons 全量覆盖 |
| 数据管线 | ✅ 已入库（be3687a），可按 tools/ 重建 |
| WebGPU 渲染回主 client | ✅ 已合（localStorage.webgpu='1'，render.js/render.js 接线） |
| 双人对战 | ✅ 同服务器双浏览器实测可行；跨机对等联机未做 |
| 被动技能接攻击引擎 | ⚠️ 未接（狮鹫链锤/防空/飞机炸弹） |
| APK 打包 | ⚠️ 受阻（Node 权威 server 架构） |
| web/m2 实验栈 / RTS 废案 / 一次性 hotfix 补丁 | ✅ 已移除（2026-10-11 历史产物清理） |

---

## 七、给接手者的提醒

1. **别自己造轮子**（用户铁律）：游戏逻辑/UI/数据能抄上游官方就抄，数据改动走
   `tools/*.py` 管线重生成 JSON，不要手改 `data/*.json`。
2. **资源只能靠拷贝/共享目录**：git 里没有 assets/mpq/terenas.w3x 等，clone 下来跑不起来。
3. **改代码后强制刷新浏览器**（缓存 JS；`npm run dev` 有 --watch 自动重启服务）。
4. 【重要】wasm 命令接线 = `room.js` handleMessage 的命令分支 + `wasm_bridge.js`
   命令 API + 客户端 binary handler/BINARY_READY，三者是闭环，只做一半会回到"双快照互盖闪烁"。
5. 更早的交接文档（v1 流水账、转接问题清单）已随历史产物一并清理，以本 v3 为准。

---

*本文件 2026-10-11 依据实测（服务运行/端口/目录/commit 027ea0f）更新，与 git 状态对齐。*