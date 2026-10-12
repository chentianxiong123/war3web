# Warcraft III 浏览器移植 war3web —— 全项目技术总结

> 版本：2026-10 · master @ b73e62b（M0→M8 全程）
> 定位：知识分享 / 技术文章。覆盖逆向解包、WASM 引擎、WebGPU、JS 全栈、里程碑与踩坑。
> 仓库：`git@github.com:chentianxiong123/war3web.git`（本地 `C:\Users\a1\war3`）
> 配套文档：`docs/` 下 ARCHITECTURE.md、WEBGPU_WASM_PLAN.md、M2_WEBGPU_MIGRATION.md、M4_SIM_WASM_PLAN.md、M5_ZERO_COPY_PLAN.md、M6_PERFORMANCE.md、PROGRESS.md；`docs/archive/` 存有历史三篇（M3 蓝图/解析覆盖审计/工具链沉淀）。

---

## 目录

1. 项目是什么
2. 总体架构
3. 开发环境与工具链
4. 逆向解包全流程（MPQ → 地图 → 对象数据 → 模型 → 纹理 → 音频 → JASS）
5. WASM 引擎核心（w3x.c / math.c / sim.c / jass.c）
6. binary 快照协议与 wasm 桥
7. WebGPU 渲染实验
8. 服务端权威模拟（world.js）
9. 客户端渲染（render.js / main.js）
10. 里程碑回顾 M0 → M8
11. 测试体系与门禁
12. 关键决策、红线与踩坑
13. 总结与后续方向

---

## 1. 项目是什么

把《魔兽争霸 III》的一张官方对战图（Terenas 之战）完整搬进浏览器：

- **权威 Node 服务器**：完整模拟结算（单位属性、寻路、碰撞、战斗、经济、技能、JASS 触发器），并向所有客户端广播游戏状态；
- **浏览器客户端**：Three.js 渲染地形/模型/特效/UI，接收服务器快照；
- **WASM 计算核心**：把服务器里最重的模拟（寻路、战斗、经济、JASS 脚本）用 C 重写并编译成 WebAssembly，服务端调用，前端还支持 WebGPU 渲染。

一句话：**玩法权威在 Node，计算加速在 WASM，表现渲染在浏览器**。两套并存（JS 权威模拟 + WASM 加速通道），通过每 tick 的"镜像/覆盖"机制对齐，是所有难点和后续里程碑的根源。

规模数字（2026-10 实测）：

| 项 | 值 |
|---|---|
| git 提交 | ~180（M0→M8 全程） |
| 单元/门禁测试工具 | tools/ 200 文件（141×.mjs + 49×.py） |
| 引擎 | engine.wasm 541 KB；sim.c 1678 行、jass.c 2907 行、w3x.c 71 行 |
| 服务端 | world.js 3257 行、room.js 790 行、wasm_bridge.js 409 行 |
| 客户端 | render.js 2717 行、main.js 1333 行 + overlay/particles/ribbons/splats 等 |
| 资产 | 模型 996 GLB、纹理 3739、音频 5456、数据 JSON 26 |
| 单位类型 | unittypes.json 839 种（全表进 WASM） |
| 解包原始资产 | 1023×MDX（全 v800）、3679×BLP（全 BLP1） |

---

## 2. 总体架构

### 2.1 进程拓扑

```
┌─────────────────────────────────────────────────────────────┐
│ 浏览器客户端 (Three.js)                                      │
│  render.js 地形/模型/特效  · main.js 状态机/交互/插值        │
│  WebGPU 或 WebGL 渲染器（localStorage.webgpu=1 切换）        │
└───────────────▲───────────────────────────────▲─────────────┘
                │  JSON 快照(低频) + binary SOA(30Hz)          │
                │  ← orders / chat / ready                     │
┌───────────────┴───────────────────────────────┴─────────────┐
│ Node 服务器 (权威)                                           │
│  room.js 房间/步进循环/wasm 桥/快照广播                      │
│  world.js 权威模拟（运动/战斗/经济/技能/JASS 触发器）        │
│  wasm_bridge.js —— 桥接 WASM 引擎（spawn/命令/HP/事件/快照） │
└───────────────▲─────────────────────────────────────────────┘
                │  Emscripten exports（_sim_* / _jass_* / _w3x_*）
┌───────────────┴─────────────────────────────────────────────┐
│ WASM 引擎 (engine.wasm, C 编译)                              │
│  sim.c  寻路/碰撞/战斗/经济/事件   jass.c  JASS 词法~VM       │
│  w3x.c  MPQ 读取             math.c 数学库                   │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 同步模型（关键）

两条快照通道并存：

1. **JSON 快照**（`Msg.SNAPSHOT`）：完整 ents/items/res/clock/quests，低频（客户端确认 binary 就绪后降到 5 tick 一次），由 `world.snapshot()` 生成——客户端用它拿**元数据**（typeKey/模型/技能/选择标记）。
2. **binary SOA 快照**（`Msg.SNAPSHOT_BIN`）：WASM 引擎每 tick（30Hz）产出的结构化数组（SoA）字节流，`wasmSlotOf` 槽位索引 + `slots registry` 还原成实体。**位置/朝向权威**，客户端用它做 30Hz 插值渲染，消除"抽搐"。

**收敛规则（M7 定稿）**：位置/朝向权威在 WASM（binary 通道）；**HP/死亡/命令/经济权威在 world.js**（JS 权威覆盖 WASM，每 tick 追平）。这样既不双倍计数伤害，又能把技能/物品/治疗等全部语义兜住。

### 2.3 每 tick 步进（room.js stepLoop）

```
eng.update(dt)            → JASS 引擎推进
world.step()              → JS 权威模拟，产出 events
if wasmReady:
  _syncWasm()             → 新单位 spawn 进 WASM（含初始 buff）
  _mirrorWorldOrders()    → 命令镜像（order diff → sim_order_*）
  bridge.flushOrders()    → WASM 消费命令队列并自 A*
  _applyWorldPaths()      → world 已算路径整段覆盖 WASM（逐 tick 同轨）
  _syncWorldHp()          → world HP（+mana>0）权威覆盖 WASM
  _syncBuffs()            → buff 新增/变更/过期 diff 同步
  bridge.step(1/30)       → WASM 推进（AI/移动/导弹/建造/经济）
_broadcastWasmSnapshot()  → 30Hz binary SOA 广播
_broadcastSnapshot()      → 低频 JSON 广播（含全部事件）
```

自调节 tick：`setTimeout` 按 `_tickRef` 累计对齐，避免 `setInterval` 在 stepLoop 耗时不均时周期漂移（"掉 tick / 一抽一抽"的根因之一）。

---

## 3. 开发环境与工具链

本机（Windows 原生，非 WSL）实测沉淀，详见 `docs/archive/war3web-工具链与环境沉淀.md`。

### 3.1 工具清单

| 工具 | 版本 | 位置 | 备注 |
|---|---|---|---|
| node | 24.19.0 | `C:\Program Files\nodejs` | 服务器 + 测试 |
| python | 3.14.7 | `C:\Users\a1\AppData\Local\Programs\Python\Python314` | 资产管线（numpy/pillow） |
| Emscripten | 6.0.12 | `C:\Users\a1\emsdk\emsdk-main`（2GB） | emcc 是 exe，不在 PATH；构建脚本用绝对路径 |
| CMake | 4.4.4 | Python Scripts（pip） | 构建系统 |
| Ninja | 1.9.0 | Python Scripts（pip） | 构建驱动 |
| w64devkit gcc | 16.2.0 | `C:\Users\a1\w64devkit\w64devkit\bin` | rust gnu 链接器等原生工具 |
| zig | 0.13.0 | `C:\Users\a1\zig\...` | 早期裸 wasm 保底（已被 Emscripten 主线取代） |
| rust | 1.99.0 | `C:\Users\a1\.cargo\bin` | 项目本身不用，环境备件 |

### 3.2 Emscripten 安装核心经验（重演步骤）

1. emsdk 本体走 gh-proxy 前缀秒下：`https://gh-proxy.com/https://github.com/emscripten-core/emsdk/archive/refs/heads/main.zip`
2. 安装必须带代理（emsdk 的 python 下载器读环境变量）：`$env:HTTP_PROXY/HTTPS_PROXY/ALL_PROXY=http://192.168.31.204:7897`（Clash Verge 默认 7897）
3. `emsdk.bat install latest` → `activate latest`；新版 emcc 是原生 exe：`emsdk-main\upstream\emscripten\emcc.exe`
4. wasm-binaries.zip（~700MB）托管在 storage.googleapis.com，**国内直连被限速 0.04MB/s 且断流**，必须走代理。

### 3.3 本项目 WASM 构建链

```
npm run engine
  → engine/CMakeLists.txt（86 行）
    · Emscripten 工具链（emcmake + cmake -G Ninja）
    · 源：src/sim.c src/jass.c src/w3x.c src/math.c + extern/stormlib（MPQ 读取）
    · -sEXPORTED_FUNCTIONS 列出全部 C 导出（_sim_* / _jass_* / _w3x_* / _malloc / _free）
  → engine/out/engine.mjs（62 KB 胶水）+ engine/out/engine.wasm（541 KB）
```

服务端 `wasm_bridge.js` 用 `MODULARIZE` 产出的 `createEngine()` 异步初始化，失败静默降级纯 JS 模拟（打开游戏不受影响）。

### 3.4 国内镜像 / 网络速查

| 用途 | 地址 | 状态 |
|---|---|---|
| crates.io（rust） | `sparse+https://rsproxy.cn/index/` | ✅ 快 |
| PyPI（pip） | `https://mirrors.aliyun.com/pypi/simple/` | ✅ 快 |
| GitHub 大文件 | 临时前缀 `https://gh-proxy.com/<原URL>` | ✅ 只按需拼，勿全局配置 |
| storage.googleapis.com（emsdk） | 直连死 | ❌ 必须代理 |
| TUNA/USTC/aliyun msys2、Emscripten 国内镜像 | — | ❌ 本机实测 403/404/不存在 |

**铁律**：gh-proxy 是 URL 前缀服务不是 HTTP 代理——`pip config set global.proxy https://gh-proxy.com` 是错误用法（隧道 400），已删。

---

## 4. 逆向解包全流程

从正版《魔兽争霸 III》客户端/地图文件一路解到浏览器可用的 GLB/PNG/JSON。全程离线 Python 管线（`tools/*.py`），一次解包、产物入库、浏览器只消费成品。

### 4.1 MPQ 容器（StormLib）

- 地图 `.w3x/.w3m` 本质是**带魔数头的 MPQ 归档**（`W3X!` / `W3M!`，偏移 4 是版本号）。
- 引擎侧 `engine/src/w3x.c` 直接链接 **StormLib v9.31**（`engine/extern/stormlib/`，上游 ladislav-zezula/StormLib）：
  - `w3x_check_header` / `w3x_get_version`：不依赖 StormLib 的轻量头部校验（前端先看魔数再进完整库）；
  - `w3x_open / w3x_close / w3x_has_file / w3x_read`：打开归档、读内部文件，适配 Emscripten 虚拟文件系统（JS 先 `FS.writeFile` 写入，StormLib 按路径打开）。
- 服务端启动时还直接读本地解包目录（`war3_extracted/`）、`mpq/`（原始归档）与 `public/data/*.bin`（walk/height/fly 网格），不依赖运行时解包。

### 4.2 地图文件解析（对照 warsmash Java 参考，34 个类逐一核对）

原始地图内部文件 → 结构化 JSON 的解析器在 `tools/`（Python）。

| 文件 | 内容 | 现状 |
|---|---|---|
| war3map.w3i | 地图信息 | ✅ 全量 **40+ 字段**（版本/名/作者/描述/玩家数 + 玩家数组/队伍/相机边界 8 值/可玩尺寸/tileset/雾/天气/升级科技可用性/随机单位与物品表，版本门控） |
| war3map.w3e | 地形 | ✅ 头部 + corner 7 字节合并读（tileset 纹理编号体系） |
| war3map.wpm | 路径网格 | ✅ 384² = 147456 字节，导出 walk.bin |
| war3map.doo | 装饰物 | ✅ 全字段（含版本门控错位修复） |
| **war3mapUnits.doo** | **预放置单位** | ✅ **25+ 字段逐字节对齐 warsmash Unit.java**（id/variation/坐标/朝向/缩放/flags/player/HP/魔力/掉落表/背包 6 槽/技能实例/英雄等级三维/随机旗标/队伍色/传送门；91 单位字节级校验 10453==10453） |
| war3map.w3r | 区域 | ✅ 对照 Region.java（terenas v5 空表防御） |
| war3map.w3u/w3t/w3a/w3h/w3q/w3d/w3b | 对象覆盖 | ✅ objdata.py 通用结构（w3h 消费 buff 美术、w3q 折叠进 upgrades） |
| war3map.j | JASS 触发器文本 | ✅ 解包 + 引擎 C 解析（详见 §5.4） |

管线入口 `pipeline.sh`（/等价 mjs）按顺序跑：解包 → w3i → units.doo → 地形 → 对象数据 → 模型 → 纹理 → 音频 → 汇总 JSON。

### 4.3 对象数据（6 张 SLK + 自定义表）

正版 WC3 的对象数据在 `Units/` 下的制表符分隔 SLK 里，另有 `war3map.w3u` 等地图级覆盖：

- **UnitData.slk**：220+ 列原始数据 → `unittypes.json` 规范化，**134 字段**进运行时表（涵盖溅射三档 + 伤害因子 + 科技树/视野/经济/行为/库存，69 个溅射单位：迫击炮 25/150/250+0.4/0.1、战舰半衰 0.5/0.25）。注意：`Requires` 科技树列在旧版 SLK 不存在（1.30+ 才改名，数据源缺失，已记录）。
- **AbilityData / AbilityMetaData**：技能表 + 元数据桥 → `ability_meta.json`。
- **AbilityFunc.txt 的 buff 条目**：**大写字段名**（Buffart/Effectsound），`ART_FUNC` 小写键——曾长期空转，修正为不区分大小写全 21 字段映射后 `buffart.json` 0→117 条。
- **UpgradeMetaData.slk**：37 字段映射运行时读入（名称/继承/科技树/效果组/按钮位），`w3q` 折叠进 `upgrades.json`。
- **Destructable/Doodad MetaData + w3b/w3d**：渲染/寻路子集（树木/可破坏物纹理由类型表给出）。

输出：`public/data/` 26 个 JSON —— unittypes.json（839 种）、ability_icons/ability_meta、animsounds、buffart、btn_icons、cliffs、commands、console、daynight、destructables、doodadmeta、doodads、fly/flydestructables、game、heights、hud、icons、item_icons、upgrades、unit_abilities 等。

### 4.4 模型 MDX → GLB（tools/mdx2gltf.py）

- 现网资产 **1023 个 MDX，全 v800**。解析层：**19 个经典 chunk（VERS…CLID）+ 40 条轨道 tag** 全覆盖，对照 warsmash `AnimationMap.java` 逐条核对（曾补 9 个 1.30+ 官方轨道：Fresnel KFC3/KFCA/KFTC + Popcorn KPP*，共 52 条规格全部对齐）。
- 转出层（最初丢信息的重灾区，A 轮修复）：
  - PRE2 粒子：speedCurve/variationCurve/gravityCurve/latitudeCurve/lengthCurve/widthCurve（+Step 标志）；
  - PREM 发射器 / RIBB 飘带：全套动画曲线（heightAbove/heightBelow/alpha/color 3d/textureSlot）；
  - KGAC 逐序列颜色、KMTF 纹理替换、multi-UV（TEXCOORD_1）；
  - 节点 billboard/flags、KATV 附件可见性；分裂特效剔除、锚点对齐。
- **CAMS 相机**（D 轮）：此前整块跳过（死代码），按 `MdlxCamera.readMdx` 全量解析，修正 KCTR/KTTR (1,f)→(3,f)、KCRL (1,i)→(1,f)——238 模型 240 相机落位，glb `asset.extras` 带出。
- **MDL 文本模型**（F 轮）：`tools/mdl.py` ~670 行解析器（编辑器/工具生态分发 .mdl 文本），token 流移植 warsmash `MdlTokenInputStream`，全套块 + 轨道映射到 MDX id，mdx2gltf 输入直接吃 .mdl。
- 产物：`assets/models/*.glb`（996 个）+ 同名 `.json`（meta：bounds/纹理动画等，客户端 `cullBoundsOf` 用）。

### 4.5 纹理 BLP → PNG（tools/blp.py）

- 现网 **3679 个 BLP 全 BLP1**（JPEG 分量 + 调色板）。
- **BLP2 解码器**（E 轮，之前 BLP2 直接 assert 崩管线）：支持 JPEG / 未压缩(BGRA+调色板) / **DXT1/DXT3/DXT5**（BC1/3/5），手算样本全套验证（插值色 170,0,85、DXT5 alpha 梯子 36/255、BGRA 翻转、3 色透明），BLP1 路径零回归。
- 产物：`assets/textures/*.png`（3739），客户端 `THREE.TextureLoader` 直接加载。

### 4.6 音频 WAV/MP3（ffmpeg）

- 解包 `war3_extracted/Sound/`（Dialogue 145MB / Music 95MB / …），`ffmpeg` 转码成浏览器可播格式 → `assets/sounds/`（5456 文件）。
- 服务启动时 `tools/sound_test.mjs` 校验哪些由地图自带、哪些缺 War3local.mpq。

### 4.7 路径/高度/飞行网格（.bin）

- `public/data/walk.bin`（147456 字节 = 384² 单字节 0/1 阻挡）、`heights.bin`、`fly.bin`——由地图 wpm/w3e 导出，服务端和 WASM 引擎共用（Grid 结构在 sim.c 与 pathing.js 两侧同构，保证 C/JS 寻路逐 tick 同轨）。

---

## 5. WASM 引擎核心

`engine/` 是纯 C 代码库（`-fno-exceptions -O2`），Emscripten 编译为 `engine.wasm`（541KB）。四个源文件各司其职：

### 5.1 w3x.c（71 行）—— MPQ 读取

四个导出函数 + StormLib 集成（见 §4.1）。浏览器/wasm 场景：JS 先 `FS.writeFile` 写入虚拟文件系统，StormLib 按路径打开。

### 5.2 math.c —— 数学库

`vec3` 数学 + 基础运算（服务端 world.js 与客户端 share 语义），头部校验/版本读取等轻量工具。

### 5.3 sim.c（1678 行）—— 模拟核心（M4→M8 主线）

服务端 world.js 的 C 移植，**行为锁定**方式演进（每阶段先录 golden 基准，再移植，逐位对账）：

**M4 阶段 1 · 寻路与碰撞**
- A* + string-pull + 扫掠碰撞 + 连通性（移植 `pathing.js` Grid）；
- `sim_run_move`：movementPath 快路径 + 慢路径 A*、turnToward 转向预算、stepLen 推进、canAdvance 扫掠；
- 多单位实体碰撞（occupancy 绕行 + 250ms 撞墙重寻路）；
- 关键对齐：JS A* 用 Float32Array、C 用 double → f 相等性/堆序不同导致路径不同，**改 float32 后碰撞场景段数/到达 tick/终位完全一致（93=93）**；
- golden：`path_golden.mjs` 5 场景（到达门禁）全过。

**M4 阶段 2 · 战斗**
- SimUnit 战斗字段 + `sim_spawn_fight` + 攻击状态机（atkTimer/目标扫描/转向/windup）;
- `sim_damage` 纯数值（typeBonus 7×8 + armorFactor 护甲系数）;
- stepAI 追击：idle→acquisitionRange 内敌对最近→attack；攻击→目标死回 idle/超射程追击/在射程停打；`sim_route`（无实体阻挡，与玩家 order_move 语义区分）;
- 远程导弹：SimMissile 表（256 槽）、homing 追踪、deadline 兜底、命中调 sim_damage（射手死则空耗）；weaponKind!=0 && missileSpeed>0 → 发射（延迟伤害），否则近战直击;
- 战斗 4/4 场景硬门禁（melee_close/melee_apart/melee_3v1/ranged_hwat），死亡 tick Δ≤45、首击全 Δ0。

**M4 阶段 2 · 经济**
- 采集状态机 `gather_pass`（自动找矿 → 挖 1.8s → 回基地交金 +10 → 循环）；`sim_spawn_econ` 放置经济单位；GOLD[16] 玩家金矿读取；
- econ 8 次交金 Δ1-3（≤6）、末次 Δ17（≤20）、次数 64 vs 63。

**M4 阶段 3 · 全量 tick + 事件桥**
- `sim_step(dt)`：SIM_NOW 自增 → gather_pass → step_missiles → 单位循环（AI/move/attack）；
- 事件桥 EV[8192] 环缓冲 {tick,type,a,b}，attack/missileEnd/death 三处 push；
- 导出 `sim_step / sim_events_reset / sim_event_count / sim_events_get`；
- 关键修正：SIM_NOW 必须在 `sim_clear_all` 重置（否则第 2 场景起事件 tick 整体偏移 ~3600）。

**M5 → M8 · 服务端接线**
- `sim_command_path`：world 已算路径整段覆盖 WASM 自 A* 结果，实现逐 tick 同轨；
- `sim_set_hp / sim_set_mana / sim_kill`：world 权威 HP/mana/死亡 覆盖通道；
- `sim_apply_buff / sim_get_buffs`：buff 注入与读取；
- `sim_set_dmg_table`：伤害表（float* 修复——曾用 HEAPF32 写错位 double*）；
- `sim_spawn_fight / sim_spawn_econ`：战斗/经济单位 spawn（全 839 类型表由 room.js `buildSimUnitTypes()` 从 unittypes.json 推导：isBuilding→kind 4（ngol=2/htow=3）、isHero/attacks>0+hasDmg→kind 0、其余 kind 1；weaponKind: Missile→1、Metal/Chop/Slice→0）。

### 5.4 jass.c（2907 行）—— JASS 脚本引擎（M3）

把 `server/jass/parse.js` + `vm.js` 完整移植进 C，作为共享代码库（M3 达标）：

**3.1 词法+语法**：lex 逐规则对应（注释、字符串转义、fourcc、$hex/0x、数字、运算符、行号），递归下降全套语句 + 顶层 types/globals/natives/functions；摘要 JSON 与 JS 计数全等。
**3.2 完整 AST**：与 JS parse() 同构（111603 字节逐字节相等，含 hasElse 空 else 块 "els":[]）。
**3.3 拼接全量解析**：common.j(167KB)+Blizzard.j(452KB)+war3map.j(51KB) 拼接 655900 字节 → **C 解析 36ms**，964 函数/1160 natives/898 globals/91 types。
**3.4 C 版 VM 执行器**：jass_parse 拆 parse_ast/ast_to_json/free_ast，VM 直接吃内存 AST；同步树遍历 + 作用域链 + 全语句（local/set 数组/if-elseif-else/loop/exitwhen/return）+ 全表达式 + opLimit 800 万防止死循环。
**3.5 natives 分发表**：~140 个（数学/字符串/ConvertXxx 恒等/handle 工厂/查询默认值），未实现打 `[unimpl:Name]` 返回默认值，迭代补充归零；用户函数优先于 natives。
**第五轮深化**（3.6→3.24，19 个功能 commit，natives 累计 **~115 个真语义**）：
- 触发器（TriggerEvaluate/TriggerExecute 同步执行、事件注册表 8 类、GetTriggeringTrigger）；
- 玩家（Player 幂等 16 常驻、GetPlayerId、玩家属性、联盟矩阵 IsPlayerAlly/Enemy、SetPlayerTeam、玩家颜色）；
- 单位（CreateUnit 真分配、GetUnitTypeId/OwningPlayer/UnitAlive/KillUnit、坐标/朝向/范围/状态）；
- 对象表（GetHandleId、字符串、rect 8 查询、location/group ForGroup 枚举、force ForForce/GetEnumPlayer、item、region、hashtable 4 类型存取/HaveSaved/Flush、timer）；
- 数学族 11 natives、GetLocalPlayer、科技 researched/max、出生点坐标表、玩家金木资源、金矿资源量、GameState 事件、Destroy 真回收、RemoveLocation 回收。
**常驻断言**：C(config,main) vs JS boot() 全局强对照——**880 全局 0 差异**（365 值一致 / 56 null / 459 handle 存在性对账）。

### 5.5 Emscripten 导出面（CMakeLists 86 行）

`-sEXPORTED_FUNCTIONS` 列出：`_sim_*`（spawn/order/step/move/path/damage/hp/mana/kill/buff/res/events）、`_jass_*`（parse/run/ast/json/free）、`_w3x_*`（open/read/header）、`_malloc/_free`。全部走 ccall/cwrap，避免 embind（性能 + ABI 稳定）。

---

## 6. binary 快照协议与 wasm 桥

### 6.1 wasm_bridge.js（409 行）

服务端 <-> engine.wasm 的唯一通道，职责：

- **生命周期**：`init()`（MODULARIZE createEngine 异步加载）、`maxUnits` 槽位上限；
- **spawn**：`spawn(slot, x, y, typeKey, opts)` → 按类型分发 `sim_spawn_fight` / `sim_spawn_econ`（unitTypes 表查 typeKey）；
- **命令**：`pushOrder(slot, op, x, y, targetSlot?)` 进队列 + `flushOrders()`（sim 消费并自 A*）；`commandPath(slot, path, mode)` 覆盖路径（`sim_command_path`）；`orderBuild(slot, typeKey, x, y)`（`sim_order_build` 即时调用）；
- **状态**：`setHp / setMana / kill / applyBuff / getBuffs / getBuild`；
- **步进**：`step(dt)`（`sim_step`）；
- **快照**：WASM 侧产出 SoA buffer（地址 + 字节数），`_broadcastWasmSnapshot` 从 heap 拷贝成 `Uint8Array` 广播——**零 JSON 序列化**（M5 零拷贝方向）；
- **事件**：`flushClientEvents` 读事件桥。

### 6.2 slots registry 协议（M5）

```
SLOTS 消息：{ t: 4, slots: { slot: { id, u, k, sel } }, colors: [16] }
```

- `wasmSlotOf`（worldId→slot）/ `wasmWorldOf`（slot→worldId）/ `wasmSlots`（slot→meta）；
- 客户端用它把 SOA 数字 slot 还原成 typeKey/模型/可选标记；
- 建号后首帧即推（sendSlots），后续 `wasmSlotsDirty` 时广播；**空 registry 不推送**（M7 修复：避免客户端收到 `{}` 误判已就绪导致测试提前 break / 快照缺失）。

### 6.3 binary 快照（SnapShot_BIN）

- 每 tick 广播（30Hz，`TICK_HZ=30`），tag 字节 + SoA 数据；
- 客户端 `snapshotFromBinary(buf, slots, colors)` 直读，重置插值节拍 `snapDt=1000/30`；
- 首次收到 binary → 客户端发 `BINARY_READY` → 服务端将 JSON 快照从每 tick 降为 5 tick 一次（省带宽）；
- 删除逻辑：slots 注册过但本帧未出现的单位 → 从 S.ents 移除（wasm 已确认死亡/移除）。

### 6.4 命令/路径/状态镜像（M6-M8 总结）

**命令单源**：玩家命令只写 `u.order`（world.order()），下一 tick `_mirrorWorldOrders` 统一 diff 镜像（`${o.type}|${o.x}|${o.y}|${o.targetId}` key）：idle/stop→stop、hold→hold、move→move、attackMove/patrol→attackMove、attack→attack(目标有槽位)/attackMove、follow→move、**build→orderBuild 直调**。train/cast 无 wasm 语义跳过（设计边界）。

**路径整段覆盖**：`_applyWorldPaths` 对比 `u.path` 引用（stepMove shift 只改内容不改引用），变化时 `commandPath` 覆盖，让 wasm 单位沿 world 同一条路径走。

**HP/死亡/mana 权威在 world**：`_syncWorldHp` 每 tick `setHp`（+ `mana>0` 时 `setMana`）；world `death` 事件 → `bridge.kill(slot)` → 下一 tick binary 帧单位消失。

**buff 持续同步**：`_syncBuffs` 每 tick diff world buff 快照（`kind:code` → `{untilMs,pct,atkPct,flat}`），新增/变更 `applyBuff`，过期/移除 `applyBuff(untilMs=0)` 清除。

**为什么 HP 覆盖而不是同步 dmg 事件**：world.damage() 是全部伤害的出口（普攻/技能/物品/毒伤/治疗/触发），若逐个同步 dmg 事件会与 wasm 自身普攻结算双倍计数；改为 world HP 每 tick 权威覆盖，天然兜住所有语义且逻辑最简。

---

## 7. WebGPU 渲染实验（M2）

`docs/M2_WEBGPU_MIGRATION.md` + `docs/WEBGPU_WASM_PLAN.md`。

- **目标**：把 render.js（WebGL）迁到 WebGPU（three r185 内建 WebGPURenderer，经 importmap 补映射 + 动态 import）。
- **开关**：`localStorage.webgpu=1` 启用试点；默认 WebGL 保底行为不变。异步 init 等待 boot/首帧；anisotropy fallback。
- **步骤 A 落地（35fb526）**：WebGPURenderer 试点开关 + 异步加载；playwright 验证地形加载、渲染循环 0 错误、WebGL 回退正常。
- **步骤 B 对局实测（42e92eb）**：驱动进 playing 相位——WebGPU 后端 **95 单位模型渲染**，累计 43754 draw calls / 47824 tris；粒子 ShaderMaterial 不兼容风险确认（NodeBuilder 错误，不影响主场景）；截图 docs/m2_webgpu_playing.png 留档。
- **教训**：r185 默认构建不含 WebGPURenderer，需 importmap 显式映射 + 动态 import；`frustumCulled=false` 保模型不被裁剪；GLB 材质在 WebGPU 下统一换 MeshLambertMaterial 确保可见。

---

## 8. 服务端权威模拟（world.js，3257 行）

- **实体模型**：`W.units`（Map<id, unit>），单位携带 hp/mana/buffs/order/orderQueue/path/controlled/returning 等；`W.items`、`W.dest` 等；
- **伤害唯一出口**：`this.damage()`（L1126 `emit({t:'dmg', id, src, amt})`），普攻也走这里（L3090）——全游戏伤害/治疗/毒伤/技能/触发都收敛于此，是 HP 覆盖同步的前提；
- **死亡出口**：`emit({t:'death', id, killer})`（L701）；
- **AI**：`stepAI(u)`（L2656）自动索敌——与 sim.c `step_ai_unit` 对齐（acquisitionRange 语义）；野怪无槽位不镜像（不参与 wasm，JS 兜底）；
- **经济**：stepGathers 采矿/交金权威（WASM gather_pass 已移植但以 world 为准）；
- **JASS 触发器**：`server/jass/engine.js` 在 world 之上执行地图脚本（CreateUnit/触发器/计时器/玩家对象），`JassEngine` 的 boot() 创建 95 初始单位（terenas：人族西北/兽族东南基地）；
- **命令入口**：`W.order(unit, order)` 全部命令的统一入口（玩家 + 内部自动命令），是命令镜像的单源。

### 8.1 room.js（790 行）—— 房间与步进

- 房间：座位（10 席 + 观战）、加入/准备/开局、断线重连（rejoin 宽限）、对局生命周期；
- `stepLoop`：§2.3 的每 tick 链路；
- 快照广播：`broadcast()` JSON + `broadcastBinary()`；`broadcastSnapshotNow()` 命令处理后立即发（降输入延迟）；
- 事件桥：world events + wasm scriptEvents 合并 → 客户端 EVENT 消息（dmg/death/victory/texttag/…）；
- `buildSimUnitTypes()`：从 unittypes.json 全 839 种推导 wasm 类型表（M7）；
- 客户端协议（main.js）：MOVE/STOP/hold/ATTACK/smart/BUILD/TRAIN/READY/BINARY_READY/SLOTS/SNAPSHOT/SNAPSHOT_BIN/EVENT/CHAT 等。

---

## 9. 客户端渲染（render.js 2717 行 + main.js 1333 行）

### 9.1 render.js

- **地形**：GLB 地形 + heights.bin 取高（`heightAt`）、水/悬崖/纹理动画（cliffs.json/water frames）；
- **单位视图**：`spawnView(ent)` → GLB 克隆 + 材质归一（MeshLambert）+ 动画（mixer/actions，MDX 序列映射）+ 血条/选择环/头顶文字；Locust 幽灵单位不给 stand-in 灰胶囊（消除"鬼兽人"）；
- **模型加载**：`loadModel` Promise 缓存 + pending 去重，404 记忆防 respawn 重试涌现；
- **特效**：粒子（particles.js）/ 飘带（ribbons.js）/ 血迹 splats / 纹理动画 stepTexAnims；
- **选择与交互**：`screenPosition`/拾取/框选/subgroups/alt 显示血条；
- **WebGPU 开关**：见 §7。

### 9.2 main.js —— 状态机与插值

- 双快照融合：JSON 元数据（model/typeKey）由 SNAPSHOT 维护；位置/HP/朝向由 binary 30Hz 更新，`S.prev` 记录上一帧位置做线性插值（消除抽搐的核心：插值节拍重置 + 30Hz 目标位移）；
- `snapDt/lastSnap` 管理：binary 每 tick 到达时重置，alpha 按 33ms 节拍插值，避免按 JSON 166ms 节拍"满 1 跳变"的 30Hz 步进感；
- 命令发出 → `broadcastSnapshotNow` 服务端口即时广播；客户端 selection/subgroups/命令 UI（hud.js/ui.js/overlay.js/console.js）；
- 输入：鼠标/键盘/热键（WC3_CONTROLS_AUDIT.md 审计对齐）/框选编队/编队召回；
- 英雄面板（heroview.js）：技能卡、状态、revive 计时。

---

## 10. 里程碑回顾 M0 → M8

| 里程碑 | 内容 | 关键 commit |
|---|---|---|
| M0 | 仓库整理：内层仓库合并、外层统一、push | — |
| M1 | WebGPU+WASM 骨架（zig cc 裸 wasm）加/乘/斐波那契 5/5 验证 | 31d3a70 |
| M2 | Emscripten 主线落地（MODULARIZE），双端验证，zig 降为保底；WebGPU 试点（localStorage.webgpu=1 步骤 A/B） | 5dd8b91 / 35fb526 / 42e92eb |
| M3 | JASS 进 WASM：词法→AST→VM→natives 分发表→真实 war3map.j 全链执行；880 全局强对照 0 差异；MDL 文本解析器 | 458805b→2c0069c… |
| M4 | 模拟核心进 WASM：寻路（A*/碰撞/string-pull）→ 战斗（近战/追击/导弹）→ 经济（采集）→ 全量 sim_step + 事件桥；每阶段 golden 行为锁定 | 2b704a6 / f63e678 / f735424 / b401159 |
| M5 | SOA 快照 + slots registry + zero-copy 预研（M5_ZERO_COPY_PLAN.md） | — |
| M6 | 命令+路径全镜像进 WASM；binary 30Hz 位置主通道（修复 snapAcc 误门槛 15Hz）；自调节 tick 替代 setInterval；JSON 降频（binaryReady） | b2fc244 |
| M7 | **全对接**：unitTypes 全表（11→839），HP 权威覆盖 + 死亡同步；sendSlots 空表修复 | 06d2dfa |
| M8 | 增强：buff 持续同步 + mana 同步 + 建造进度同步（并发 3 agent 开发） | 468c7c8 |

### 里程碑贯穿主线

1. **行为锁定先行**：每个移植阶段先写 golden 基准（path_golden/combat_golden/econ_golden/sim_step），C 实现逐位对账，容差内通过才合入；
2. **两套并存收敛**：JS 权威模拟 + WASM 加速通道，通过"命令单源镜像 / 路径整段覆盖 / HP 权威覆盖"三招对齐，避免双写打架；
3. **先修体验再全接**：M6 修抽搐（binary 30Hz + 插值），M7 全类型 + HP/死亡，M8 增强三件套——核心通道通了再谈增强。

---

## 11. 测试体系与门禁

tools/ 200 个脚本（141×.mjs 门禁 + 49×.py 管线），按层分：

### 11.1 核心门禁（每轮提交必跑）

| 测试 | 命令 | 覆盖 |
|---|---|---|
| 引擎 | `npm run engine:test` | JASS/C 引擎（87→109→114→…→100+，含 main 全链、880 全局对账） |
| WASM 接线 | `node tools/wasm_wire_test.mjs` | spawn 接线 / 农民收到命令移动 / binary 与 JSON 位置逐帧一致（3/3） |
| 寻路 | `npm run sim:test` | path 5/5 + golden 5/5 + 碰撞 + sim_move（C/JS 逐位一致） |
| 战斗 | `node tools/combat_test.mjs` | 4/4 场景硬门禁（死亡 tick Δ≤45、首击 Δ0、HP 曲线） |
| 经济 | `node tools/econ_test.mjs` | 交金序列/次数/终位 |
| 步进+事件桥 | `node tools/sim_step_test.mjs` | sim_step 4 场景 + 事件 tick 精确相等 |
| 地图数据 | `node tools/mapdata_test.py` | w3i 结构 + units.doo 字节精度（17 断言） |

### 11.2 资产回归（管线产物校验）

- `render_test.mjs` / `fps_test.mjs`（浏览器渲染回归，禁改）；
- 批量模型校验：1023 MDX 全量 0 失败；16 模型多样抽测（blend/geoset/texanim 等）；
- `pathblock_test`（walk.bin 与网格一致）、`doodadtex_test`（树有纹理由类型给）、`sound_test`（音频服务覆盖）等一批小门禁。

### 11.3 测试方法论

1. **golden 行为锁定**：先录 JS 权威轨迹（JSON 快照），C 移植后逐位对账；
2. **双端对照**：C(config,main) vs JS boot() 880 全局 0 差异常驻断言；
3. **字节级校验**：units.doo 91 单位 10453==10453、AST 111603 字节逐字节相等；
4. **浏览器实测**：playwright 驱动进对局，验证 WebGPU 渲染/命令/血条/二进制通道。

---

## 12. 关键决策、红线与踩坑

### 12.1 关键决策

| 决策 | 理由 |
|---|---|
| 权威在 Node，WASM 加速 | 浏览器小、服务器权威单源，前端只管表现 |
| 两套并存 + 每 tick 对齐 | 渐进迁移风险最小；M7 前曾用"wasm 权威位置 + js 权威 HP"的混合 |
| HP 覆盖而非 dmg 同步 | 全伤害出口在 world.damage()，逐个同步会双倍计数 |
| 命令单源（u.order）镜像 | 玩家 + 自动命令统一入口，无双写 |
| 路径整段覆盖替代 wasm 自 A* | 让 wasm 与 world 逐 tick 同轨，位置偏差 <12 |
| binary 30Hz 位置主通道 | 消除 JSON 166ms 快照造成的"30Hz 步进抽搐" |
| 资产管线留 Python | 红线：不迁；wasm 只做运行时能力 |
| 不解析 wct/wtg 触发器二进制 | warsmash 核心亦不解析，维持 jass 正则/文本探针 |

### 12.2 铁律（红线）

1. **不修改 `server/world.js`**（权威核心，改必须走完整回归）；
2. **不修改 `tools/render_test.mjs`**（渲染回归基准）；
3. **不跑全量 `npm test`**（太多历史测试，跑核心门禁即可）；
4. **world.js 的 `damage()` 是全伤害唯一出口**——任何新增伤害都必须走它，否则 HP 覆盖失效；
5. **wasm 引擎改动后必须重建 + 重启服务器**才生效。

### 12.3 踩坑清单（精选）

**WASM/构建类**
- sim.c `u->windup` 字段不存在 → `u->attackWindupRemaining`（编译错即修）；
- CMakeLists 字符串匹配失败：用短唯一子串 `_sim_command_path,_malloc` 而非整行；
- HEAPF64 未导出 → 改 float 输出（寻路坐标）；`walkPtr` 提前 free 悬空；
- A* 精度：C double vs JS Float32Array 导致路径不同 → 统一 float32；
- `sim_set_dmg_table` double* vs HEAPF32 写错位 → float* 修复；
- SIM_NOW 未随 sim_clear_all 重置 → 事件 tick 整体偏移；
- 追击每 tick 重寻路卡起点 → goalX/goalY 快照判据；
- C 每 tick 重扫目标换目标 → 固定 AI 目标优先、失效才扫描。

**JASS/C 内存**
- realloc 新元素未清零 → nparams 垃圾长度越界读；
- arena 单块 realloc 移动 → 已分发指针全悬垂，乱码死循环 → 块链表分配器；
- call 实参数组每次循环重新分配 → 旧元素丢失 → 临时数组收集；
- parse_block 20 万次迭代 guard（防真实脚本死循环挂死引擎）。

**同步/协议类**
- snapAcc 误挡 binary 广播（15Hz 而非 30Hz）→ 移出 snapAcc 块；
- 客户端 `S.slots={}`（空对象 truthy）→ 测试/客户端误判已就绪 → sendSlots 空表不推送；
- binary 每 tick 到达必须重置插值节拍，否则按 JSON 166ms 节拍"满 1 跳变"；
- 模型加载 404 记忆，防 respawn 反复请求。

**环境类**
- pip 全局 proxy 设成 gh-proxy → 隧道 400（gh-proxy 不是 HTTP 代理）；
- scoop shim 是 bash 脚本 → 用 `scoop.ps1`；
- rust gnu 链接缺 `libgcc_eh.a` → 复制 libgcc.a；
- WSL1 跑不了 node、WSL2 机械盘 VHDX IO 灾难 → Windows 原生；
- `.mjs` 必须给 `text/javascript` MIME，否则浏览器拒执行。

---

## 13. 总结与后续方向

### 13.1 完成度

- ✅ 逆向解包全覆盖：MPQ → 地图 6 大类 → 对象数据（839 单位/技能/升级/buff）→ MDX/MDL → BLP1/BLP2 → 音频 → JASS 全链；
- ✅ WASM 引擎：寻路/碰撞/战斗/导弹/经济/事件桥 + JASS VM（115 真语义 natives）全部 C 化并有 golden 门禁；
- ✅ 服务端接线：命令单源镜像、路径整段覆盖、HP/mana/死亡权威覆盖、buff 持续同步、建造进度同步；
- ✅ 体验：binary 30Hz 位置主通道 + 客户端插值，抽搐消失；自调节 tick；
- ✅ WebGPU：试点可跑（95 单位、43754 draw calls），WebGL 保底；
- ✅ 测试：核心门禁全绿（engine 100+/wire 3/3/sim 5+5/combat 4/4/econ/sim_step 4/4/mapdata 17）。

### 13.2 已知边界（设计如此，非 bug）

- train/cast（训练/技能）无 wasm 语义，由 world.js 权威处理；
- wct/wtg 触发器二进制不解析（参考项目亦不解析）；
- 资产管线保持 Python（红线）；
- 浏览器首包体积（引擎 541KB + 资产）与加载优化未做专门 M 阶段。

### 13.3 后续方向（候选）

1. **WebGPU 正式化**：粒子 ShaderMaterial 兼容 + 默认开 + 移除 WebGL 保底；
2. **M9 性能**：30Hz binary 吞吐压测、wasm heap → WebGPU 零拷贝（M5_ZERO_COPY_PLAN 落地）；
3. **资产分发**：gitignore 资产导致单 clone 无法跑游戏 → 考虑 CDN/发布产物（M3 蓝图遗留）；
4. **双人匹配联机多轮测试**、被动技能接线（狮鹫连锁闪电/对空/飞机炸弹）；
5. **APK 打包**（WebView + wasm 路径打通）。

---

*本文档由项目全程开发记录归纳而成，配套 `docs/` 下的 PLAN/PROGRESS/MIGRATION 文档可查细节；历史三篇（M3 蓝图 / 解析覆盖审计 / 工具链沉淀）见 `docs/archive/`。*

---

## 附录 A · 完整文件树（关键路径）

```
C:\Users\a1\war3\war3web\
├─ server\
│  ├─ index.js            HTTP 静态 + WebSocket(/ws) 入口，MIME 表
│  ├─ room.js             房间/步进循环/wasm 桥/快照广播（790 行）
│  ├─ world.js            权威模拟（3257 行，红线勿改）
│  ├─ wasm_bridge.js      engine.wasm 桥（409 行）
│  └─ jass\
│     ├─ engine.js        JASS 引擎（JS 侧参考实现/触发器）
│     └─ parse.js / vm.js JS 权威实现（C 移植的对照基准）
├─ client\
│  └─ js\
│     ├─ main.js          状态机/插值/输入/选择（1333 行）
│     ├─ render.js        地形/模型/特效渲染（2717 行）
│     ├─ overlay.js       血条/文本/纹理动画
│     ├─ particles.js / ribbons.js / splats.js / heroview.js
│     └─ ui.js / hud.js / console.js
├─ engine\
│  ├─ CMakeLists.txt      Emscripten 构建（86 行）
│  ├─ src\
│  │  ├─ sim.c            模拟核心（1678 行）
│  │  ├─ jass.c           JASS C 引擎（2907 行）
│  │  ├─ w3x.c            MPQ 读取（71 行）
│  │  ├─ math.c           数学库
│  │  └─ t_lex.wasm / t_str.wasm  词法测试小模块
│  ├─ extern\stormlib\    StormLib v9.31（MPQ）
│  └─ out\                engine.mjs + engine.wasm（构建产物）
├─ tools\                 200 文件：141×.mjs 门禁 + 49×.py 管线
│  ├─ mdx2gltf.py / mdl.py / blp.py / w3i.py / unitsdoo.py
│  ├─ objdata.py / abilities.py / upgrades.py / cliffs.py
│  ├─ pipeline.sh         资产管线入口（解包→解析→转出→汇总）
│  └─ *golden.mjs / *_test.mjs / *_test.py  门禁
├─ public\
│  ├─ data\               26 个 JSON + walk/bin/heights/fly cliffs 等
│  └─ index.html / css
├─ assets\                models(996 GLB) / textures(3739 PNG) / sounds(5456)
├─ docs\                  PLAN/PROGRESS/MIGRATION/AUDIT + archive/
└─ mpq\  war3_extracted\  原始归档 / 解包目录（gitignore）
```

---

## 附录 B · 客户端协议消息全表（Msg.*）

| 方向 | 消息 | 载荷 | 说明 |
|---|---|---|---|
| client→server | JOIN | name, team | 加入座位（红/蓝） |
| client→server | READY | — | 准备/取消准备；全员 ready 开局 |
| client→server | MOVE/STOP/hold/ATTACK/smart | x,y / targetId / queue / patrol | 命令只写 u.order |
| client→server | BUILD / TRAIN | buildType,x,y / typeKey | 建造/训练（build 镜像进 wasm） |
| client→server | BINARY_READY | — | 收到首帧 binary → JSON 降频 |
| client→server | CHAT | text | 聊天 |
| server→client | SNAPSHOT | s:{ents,items,res,clock,quests,board} | 低频元数据快照 |
| server→client | SNAPSHOT_BIN | Uint8Array(SOA) | 30Hz 位置/HP 主通道 |
| server→client | SLOTS | slots:{slot:{id,u,k,sel}}, colors[16] | 槽位 registry |
| server→client | EVENT | ev:[{t:dmg/death/victory/texttag/…}] | 事件流 |
| server→client | CHATMSG/ERROR/STATE/BOARD | — | 杂项 |

---

## 附录 C · 数据流示例

### C.1 一次右键移动（农民走一条路）

```
客户端 point 命令 → main.js selection → net.send({t:MOVE,x,y})
  → room.onMessage → W.order(u,{type:'move',x,y})
  → world 权威：u.order 更新，下一 tick requestMovementPath → u.path 数组
  → stepLoop._mirrorWorldOrders：order key 变化 → bridge.pushOrder(slot, OP.move, x, y)
  → bridge.flushOrders()：wasm sim_order_move 自 A*（结果将被覆盖）
  → _applyWorldPaths：u.path 引用变化 → bridge.commandPath(slot, u.path, OP.move)
  → bridge.step()：wasm 沿 world 同一路径推进
  → _broadcastWasmSnapshot：30Hz binary 广播位置
  → 客户端 snapshotFromBinary → S.prev 记录 → 每帧按 snapDt 插值渲染
```

### C.2 一次攻击到死亡（HP/死亡同步链路）

```
world.step()：stepAI 索敌 → u.attack → this.damage()（唯一出口，emit dmg）
  → stepLoop._syncWorldHp：bridge.setHp(slot, w.hp) 每 tick 覆盖 → 血条逐帧正确
  → 当 w.hp≤0：world.damage 死亡路径 → emit({t:'death'})
  → stepLoop death 同步循环：bridge.kill(slot)（sim_kill：alive=0, deathCount=1, 清攻击态, 推 DEATH 事件）
  → 下一 tick binary 帧不含该 slot → 客户端 S.ents 删除该单位 → 视图移除 + 血迹/死亡特效
```

### C.3 一次采矿到交金（经济权威在 world）

```
world.stepGathers：农民 toMine→mining(1.8s)→toBase→交金 +10 → player.gold 权威
  → wasm gather_pass 同步跑（移植自 JS）但以 world 为准（不双写金矿）
  → JSON 快照带 res 变化；binary 通道仅位置/HP
```

---

## 附录 D · 参考项目对比（M3 调研结论）

| 项目 | 技术栈 | 对本项目的作用 |
|---|---|---|
| **foc-web**（upstream_tmp，本项目上游） | Node ESM + Three.js 0.185 + ws，JASS JS 解释执行 | 起点：架构/协议/客户端框架继承 |
| **warsmash-src**（Java 模拟器） | Java + libGDX + ANTLR（JASS/FDF parser）+ Box2D | **格式解析参考**：w3x 34 类 / 对象数据 / 动画轨道全部以它为准对账 |
| **WhiteoutFlakes-src**（C++ WASM） | C++20 + CMake + WebGPU(emdawnwebgpu port) + WhiteoutLib | **WASM/WebGPU 蓝图**：Emscripten 5.0.7 宝石、`--use-port=emdawnwebgpu`、防 V8 编译冻结参数；M3 蓝图来源（后改走 C sim 路径） |
| **WhiteoutLib** | C++20 纯新实现（BLP2/MDX/CASC 全格式） | 白皮书参考：**BLP2 解码器**语义对照 |

**M3 蓝图关键教训（曾记入文档，后路线变更仍有价值）**：
1. Emscripten 版本钉特定版（emdawnwebgpu port API 在 4.0.10→5.0.7 间变过）；
2. 编译参数 `-fno-exceptions -O2/-Oz -fno-lto -fno-inline-functions` 规避 Chrome V8 wasm 编译冻结（大函数卡 60s+）；
3. CASC/MPQ 读盘在 web 版禁用（JS 喂字节流）；embind 绑定关闭（性能）；自定义 C 门面。

---

## 附录 E · 常用命令速查

```bash
# 构建 WASM 引擎（Emscripten + CMake + Ninja；改 sim.c/jass.c 后必跑）
cd war3web && npm run engine

# 启动服务器（改 server/*.js 后重启）
PORT=8080 node server/index.js

# 调试单个单位命令/路径镜像
WAR3_TRACE_MIRROR=<unitId> PORT=8080 node server/index.js

# 核心门禁（每轮必跑）
node tools/wasm_wire_test.mjs        # WASM 接线 3/3
npm run engine:test                  # JASS/C 引擎 100+
npm run sim:test                     # 寻路 5/5 + golden 5/5
node tools/combat_test.mjs           # 战斗 4/4
node tools/econ_test.mjs             # 经济
node tools/sim_step_test.mjs         # sim_step + 事件桥 4/4
python tools/mapdata_test.py         # 地图数据 17 断言

# 资产管线（解包→解析→转出→汇总）
bash tools/pipeline.sh               # 或等价 mjs 入口

# 浏览器验证（本地 + playwright）
# 加入红/蓝 → 准备 → window.WAR3.S 检查 phase/slots/ents/binaryReady

# git 规范
# 提交信息中文 + 根因标题，例："M8 增强: buff 持续同步 + mana 同步 + 建造进度同步"
```

---

## 附录 F · 里程碑提交映射（全部已推送 origin/master）

| 提交 | 内容 |
|---|---|
| 31d3a70 | M1 WebGPU+WASM 骨架（zig 裸 wasm 5/5） |
| 5dd8b91 | M2 Emscripten 主线（MODULARIZE） |
| 35fb526 / 42e92eb | M2 步骤A/B WebGPU 试点 |
| 458805b→2c0069c | M3 JASS C 引擎（词法→AST→VM） |
| 2b704a6 | M4 追击移植（战斗 3/3） |
| f63e678 | M4 导弹移植（4/4） |
| f735424 | M4 经济移植 |
| b401159 | M4 sim_step + 事件桥 |
| b2fc244 | **M6 收尾：命令+路径全镜像, binary 30Hz 主通道** |
| 06d2dfa | **M7 全对接：unitTypes 全表 + HP/死亡同步** |
| 468c7c8 | **M8 增强：buff 持续 + mana + 建造进度** |
| 后续若干 | 文档归档（本文档）等 |

*（M0-M2 之前更早的历史提交与中间过程提交未逐一列出，见 `git log` 与 docs/PROGRESS.md。）*

---

## 附录 G · 关键代码片段速览（同步链路核心，注释版）

> 以下摘录自当前 master，标注行号为理解用，改代码以仓库为准。

### G.1 stepLoop 每 tick 同步序列（room.js）

```js
stepLoop() {
  const dt = 1000 / TICK_HZ;
  this.eng.update(dt);                  // JASS 引擎推进
  const events = this.world.step();     // JS 权威模拟 → events
  if (this.wasmReady) {
    this._syncWasm();                   // 新单位 spawn 进 WASM（含初始 buff）
    this._mirrorWorldOrders();          // 命令 diff 镜像 → pushOrder / orderBuild
    this.bridge.flushOrders();          // WASM 消费订单（自 A*，稍后被覆盖）
    this._applyWorldPaths();            // world 路径整段覆盖 → 逐 tick 同轨
    this._syncWorldHp();                // world HP 覆盖（mana>0 也同步）
    this._syncBuffs();                  // buff 新增/变更/过期 diff
    this.bridge.step(1 / TICK_HZ);      // WASM 推进（AI/移动/导弹/建造/经济）
  }
  // ... 事件合并、victory 判定、快照广播
}
```

### G.2 命令镜像（单源原则，room.js）

```js
_mirrorWorldOrders() {
  const key = `${o.type}|${o.x ?? ''}|${o.y ?? ''}|${o.targetId ?? ''}`;
  if (this._mirrored.get(wuId) === key) continue;   // diff：未变不重发
  this._mirrored.set(wuId, key);
  if (t === 'idle' || t === 'stop')       B.pushOrder(slot, OP.stop, 0, 0);
  else if (t === 'hold')                  B.pushOrder(slot, OP.hold, 0, 0);
  else if (t === 'move')                  B.pushOrder(slot, OP.move, o.x, o.y);
  else if (t === 'attackMove'||t==='patrol') B.pushOrder(slot, OP.attackMove, o.x??0, o.y??0);
  else if (t === 'attack' || t === 'follow') { /* 目标有槽位→attack(slot)，否则 move/attackMove */ }
  else if (t === 'build')                 B.orderBuild(slot, o.typeKey||o.buildType, o.x, o.y);
  // train/cast：wasm 无语义，跳过（设计边界）
}
```

### G.3 HP 权威覆盖（room.js，M7 核心）

```js
_syncWorldHp() {           // world.damage() 是唯一伤害出口（普攻也走）
  for (const [id, slot] of this.wasmSlotOf) {
    const w = W.units.get(id);
    if (!w || !w.alive) continue;
    if (Number.isFinite(w.hp)) this.bridge.setHp(slot, w.hp);
    if (w.mana > 0) this.bridge.setMana(slot, w.mana);   // 英雄蓝条
  }
}
// 避免「wasm 已算普攻伤害 + 再同步同一 dmg 事件」双倍扣血的解法：
// 不做 dmg 事件同步，只做 HP 终态覆盖，自动兜住技能/物品/毒伤/治疗/触发。
```

### G.4 buff 持续同步（room.js，M8）

```js
_syncBuffs() {
  const now = W.now || 0;
  for (const [wuId, slot] of this.wasmSlotOf) {
    const current = new Map();                    // "kind:code" → info
    for (const b of (u.buffs || [])) {
      const key = `${b.kind}:${b.code ?? -1}`;
      current.set(key, { b, untilMs: b.until ? Math.max(0, b.until-now) : 0,
                         pct: b.pct??0, atkPct: b.atkPct??0, flat: b.flat??0 });
    }
    const prev = this._syncedBuffs.get(wuId) || new Map();
    for (const [k, info] of current)             // 新增/变更 → 推入
      if (!prev.get(k) || 有差异) this._syncBuffToWasm(u, info.b);
    for (const [k] of prev)                      // 过期/移除 → 清除
      if (!current.has(k)) this.bridge.applyBuff(slot, kind, code, BigInt(0), 0, 0, 0);
    this._syncedBuffs.set(wuId, current);
  }
}
```

### G.5 死亡同步（room.js，M7）

```js
// world.step() 的 death 事件集合：
for (const ev of events) if (ev.t === 'death')
  bridge.kill(wasmSlotOf.get(ev.id));   // sim_kill：alive=0, 清攻击态, 推 DEATH
// 下一 tick binary 帧不含该 slot → 客户端 S.ents 删除 → 视图移除
```

### G.6 sim_kill / sim_set_hp / sim_set_mana（sim.c）

```c
void sim_kill(int id) {                 // world 主动死亡同步
  SimUnit* u = U + id; if (!u->alive) return;
  u->alive = 0; u->deathCount = 1;
  u->attackWindupRemaining = 0; u->atkTimer = 0;
  ev_push(SIM_EV_DEATH, ...);
}
void sim_set_hp(int id, double hp) {
  if (hp <= 0) sim_kill(id);
  else { clamp to [0, maxHp]; u->hp = hp; }
}
void sim_set_mana(int id, double mana) { clamp to [0, maxMana]; u->mana = mana; }
```

### G.7 binary 快照读取（客户端 main.js）

```js
net.on(Msg.SNAPSHOT_BIN, (m) => {
  // binary 每 tick 到达：重置插值节拍（否则按 JSON 166ms 节拍"满1跳变"→30Hz 步进抽搐）
  S.snapDt = 1000 / TICK_HZ;
  S.lastSnap = performance.now();
  const ents = snapshotFromBinary(buf, S.slots || {}, S.colors || []);
  // S.prev 记录上一帧位置 → 渲染每帧线性插值
  for (const e of ents) { /* 更新 x/y/f/h/a/mv */ }
  // slots 注册过但本帧未出现 → 删除（wasm 已确认死亡/移除）
  if (!S.binaryReadySent) { S.binaryReadySent = true; net.send({ t: Msg.BINARY_READY }); }
});
```

### G.8 自调节 tick（room.js，替代 setInterval）

```js
_tickLoop() {
  this.stepLoop();
  this._tickRef += 1000 / TICK_HZ;          // 基准时间累计
  const delay = Math.max(0, this._tickRef - performance.now());  // 补偿耗时波动
  this.loop = setTimeout(() => this._tickLoop(), delay);
}
// 效果：stepLoop 耗时不累积漂移，binary 帧到达间隔稳定 33ms，消除"掉 tick/一抽一抽"
```

### G.9 wasm 类型表推导（room.js，M7 全对接）

```js
buildSimUnitTypes() {   // 从 unittypes.json 全 839 种推导，替代早期 11 种硬编码
  for (const t of TYPES) {
    const isBuilding = t.isBuilding;
    simType.kind = isBuilding ? (t.typeKey==='ngol'?2 : t.typeKey==='htow'?3 : 4)
                  : (t.isHero || (t.attacks>0 && t.dmg)) ? 0 : 1;
    simType.weaponKind = t.weaponType==='Missile' ? 1
                       : (t.weaponType==='Metal'||'Chop'||'Slice') ? 0 : -1;
    // + hp/maxHp/mana/maxMana/moveSpeed/range 等全量字段
  }
}
```

---