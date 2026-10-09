# WebGPU + WASM (C++) 迁移规划

> 目标：把本项目的渲染与游戏逻辑整体迁移到 **WebGPU 渲染 + C++/WASM 计算核心**，
> 为 RTS 级别的模拟规模（大量单位、寻路、碰撞、弹道、粒子）铺路。
> 语言约束：**不用 Rust**，逻辑核心用 C/C++（Emscripten 编译到 wasm32）。

## 1. 现状盘点

| 子系统 | 现状 | 位置 |
|---|---|---|
| 渲染 | three.js 0.185（WebGL 渲染器） | `client/js/render.js`、`overlay.js`、`particles.js` |
| 游戏逻辑 | Node 端 JASS VM + 模拟（JS） | `server/jass/`、`server/world.js`、`server/room.js` |
| 地图/资产解析 | Python 管线（mdx→glb、blp→png、wav→ogg、slk→json） | `tools/mdx2gltf.py`、`tools/*.py` |
| 测试 | Node 无头浏览器验收（tools/*_test.mjs）+ 服务端单测 | `tools/run_tests.mjs` |
| 上游参考 | WarsmashModEngine（Java 模拟器）的 simulation 层与 jass 解析器 | `C:\Users\a1\warsmash-src` |

## 2. 目标架构

```
浏览器
┌─────────────────────────────────────────────┐
│  JS 壳（thin）                                │
│   - three.js WebGPURenderer（渲染，TSL 材质）   │
│   - 输入/UI/网络（ws）/资产加载                  │
│                                              │
│  ┌───────────────────────────────────────┐   │
│  │  WASM 核心（C++，Emscripten，pthreads）│   │
│  │  - JASS VM（移植 server/jass）          │   │
│  │  - 模拟层（移植 warsmash simulation）    │   │
│  │  - 寻路 / 碰撞 / 弹道 / 粒子计算          │   │
│  │  - 确定性固定步长 tick                    │   │
│  └──────────────┬────────────────────────┘   │
│                 │ shared memory (wasm heap)  │
│                 ▼                           │
│         WebGPU buffer 直传（零拷贝上传）        │
└─────────────────────────────────────────────┘
```

- **WASM 核心**同时供浏览器与 Node（测试/服务端逻辑复用同一个 wasm 模块，保持
  "authoritative server" 的架构，server 逻辑跑在 Node 里加载同一 wasm）。
- **共享内存 + 线程**：单位/实体数据以 SOA 布局放在 wasm 堆，主线程跑模拟，
  worker 线程跑寻路/碰撞/烘焙，JS 侧只做 readback + 上传 GPU。
- **渲染**：three.js WebGPURenderer 从 WebGL 渐进替换；TSL 材质；WebGPU 计算
  着色器承接粒子和水；单位实例化渲染读 wasm 输出的变换 buffer。

## 3. 从 warsmash (Java) 搬什么

warsmash `viewer5/handlers/w3x/simulation/` 是完整 RTS 模拟蓝本，逐类移植到 C++：

| 域 | Java 源（warsmash） | 备注 |
|---|---|---|
| 单位 | CUnit / CUnitType / CUnitClassification / CUnitTypeRequirement | 属性、分类、科技树需求 |
| 能力 | abilities/（36 类：autocast/blight/build/cargohold/combat/harvest/hero/inventory/item/mine/nightelf/queue/skills/upgrade…） | 与 `server/abilities.js` 现有行为对照 |
| 行为/指令 | behaviors/、orders/、abilitybuilder/ | 指令队列、施法流程 |
| 寻路/碰撞 | pathing/、CWorldCollision | 移动、阻挡、区域 |
| 物品 | CItem / CItemType / item/ | |
| AI | ai/ | 简单 AI（RTS 扩展点） |
| 玩家/经济 | players/、CPlayerStateListener、combat/ | 资源、状态 |
| JASS | jassparser（Java 版 JASS AST/执行器） | 我们已有 `server/jass` JS 实现，直接 C++ 重写即可，jassparser 做行为对照 |

> 原则：warsmash 的 MIT 许可允许移植；文档记录来源（TERRAIN_PROVENANCE 模式）。
> 不追求逐行翻译——以**行为等价**为准，用现有 `tools/*_test.mjs` 验收。

## 4. 分阶段里程碑

- **M0 基线（本次提交）**：从 foc-web 上游补回 18 个测试；无头浏览器复用支持；
  本规划文档。现有测试全绿为基线。
- **M1 WASM 骨架**：CMake + Emscripten 构建链；最小 wasm 模块（C++ 写 add/hello 级
  内核）在浏览器与 Node 双端加载成功；pthreads worker 跑通；CI 命令封装
  （`tools/build_wasm.sh` / `npm run wasm`）。
- **M2 渲染迁 WebGPU**：three.js WebGPURenderer 替换 WebGLRenderer；跑通主场景
  （地形/模型/粒子/水）；用 `tools/fps_test.mjs`、`tools/render_test.mjs` 出迁移
  前后性能对比基线。**渲染迁移与 WASM 逻辑并行，不互相阻塞。**
- **M3 JASS VM 进 WASM**：`server/jass` 翻译为 C++，导出与 JS 版同构的 API
  （load / execute tick / get state / set state）；Node 端测试以同一 wasm 跑
  `tools/boot_test.mjs`、`spell_audit` 系列，逐项对齐。
- **M4 模拟核心进 WASM**：单位/寻路/碰撞/弹道搬入；实体状态快照在 wasm 内存
  （SOA 数组）；JS 侧改为读 wasm 快照渲染；`match_test`、`duel_test`、`duo_test`
  全绿。
- **M5 数据流打通**：wasm 堆 → WebGPU buffer 零拷贝路径（变换矩阵、实例化、
  粒子参数）；移除中间 JS 对象层。
- **M6 全量 + 规模验证**：全部 `tools/*_test.mjs` 在 wasm 后端下通过；压测单位
  规模（目标 ≥1000 单位寻路/交战稳定）；清理双实现，JS 模拟层删除。

## 5. 确定性

- 固定时间步（如 30Hz 逻辑 tick），与渲染帧解耦。
- RNG 种子统一（warsmash 的 Random 语义对齐），跨平台/跨运行一致。
- 浮点：关键判定用整数/定点化路径，避免 C++ 与 JS 舍入差异（现有 JS 版已经是
  authoritative，wasm 版需与它行为等价——先按 JS 版数值对齐，再优化）。

## 6. 测试策略

- 现有验收全部保留：wasm 版必须通过同一套 `tools/run_tests.mjs`。
- 新增：wasm 模块单测（C++ 侧）+ Node 双实现差分测试（JS vs WASM 输出一致性）。
- 性能门禁：`fps_test` / `render_test` 结果存档，迁移不倒退。

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| Emscripten 构建链复杂、CI 难配 | M1 就把构建封装进 npm 脚本，文档写清 Windows/网络盘注意事项 |
| pthreads 在浏览器需要 SharedArrayBuffer（跨域隔离） | 服务器端与页面加 COOP/COEP 头；Node 端单线程 fallback |
| 三个 WebGPURenderer 迁移成本（材质/光照 API 差异） | M2 先行试点，保留 WebGL 渲染器开关回退 |
| Java→C++ 翻译量大 | 按模块分批，行为等价 + 差分测试兜底；不改行为只搬语义 |
| 网络盘（Z:）构建/符号链接坑 | 构建产物与临时目录放本地盘；文档记录 |

## 8. 明确不做

- 不用 Rust / 不引入 .NET / 不引入 Zig。
- 资产管线（Python mdx/blp/wav/slk 转换）保持现状，不迁。
- 不追求逐行移植 warsmash——行为等价优先。
