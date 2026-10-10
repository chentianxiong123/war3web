# war3web 成果日志（PROGRESS）

> 本文件记录已交付成果：功能、验证证据、提交哈希、验证命令。新增成果必须
> 追加记录并随提交更新——"成果必须有文档证据"。
>
> 仓库 `C:\Users\a1\war3`（2026-10-10 从 NFS `Z:\war3` 迁入本地），项目 `war3web\`。
> 完整解析覆盖审计在
> `C:\Users\a1\Desktop\war3web-解析覆盖审计-2026.md`（每轮追加）。

## 验证命令（所有成果的可复现入口）

```bash
# 引擎（WASM）单元 + 对照测试：当前 38 项全绿
npm run engine          # Emscripten + CMake + Ninja 构建 → engine/out/
npm run engine:test     # vec3/w3x/MPQ(StormLib) + JASS AST 逐字节对照 + VM 执行对照 + C/JS 全局强对照

# 资产管线（tools/*.py，系统 Python314 + numpy + pillow）
python tools/mapdata_test.py          # 地图数据解析回归
python tools/mdx2gltf.py --all        # 模型全量转 GLB（1023 模型 0 失败）
```

---

## 一、WASM 引擎骨架（M1，master 摘要对照起点）

- **Emscripten + StormLib 打通**：`engine/src/w3x.c`（头/版本/打开/读）+
  `math.c`（vec3 长度/点积/叉积），CMake 构建链（emcmake + ninja）
- 验证：`engine_test` 17/17（vec3 3 项 + w3x 头/版本 4 项 + MPQ 开/读 6 项 + w3i 抽查）
- 构建产物：`engine/out/engine.mjs` + `.wasm`（wasm 为 gitignore，部署时重新构建）

## 二、解析保真系列（资产管线，tools/）

| 项 | 提交 | 内容 | 验证 |
|---|---|---|---|
| D3 · TRACK_SPEC 全量对齐 | ff0e2ed | 对照 warsmash AnimationMap.java 补 9 个官方轨道（Fresnel KFC3/KFCA/KFTC、Popcorn KPP*，1.30+ 新格式），52 条规格全对齐 | 1023 模型全量 0 失败 |
| D4 · war3map.w3r 区域 | ecbf617 | 对照 Region.java 逐字段（left/bottom/right/top/名字/creationNumber/weatherId/ambientId/color），空文件防御 | 合成 2 区域字节级 + terenas v5 空表 |
| E1 · BLP2 解码器 | 57a8be1 | 资产路 TOP1 关闭：任何 BLP2 纹理此前直接崩管线；JPEG/未压缩(BGRA+调色板)/DXT1/DXT3/DXT5 | 手算样本全套（插值色 170,0,85 / DXT5 alpha 36/255 / BGRA 翻转 / 3 色透明） |
| F1 · MDL 文本解析 | 6586c42 + 6fc3c9a | tools/mdl.py（~670 行）：warsmash MdlTokenInputStream 移植，全套块（模型/序列/纹理/材质/几何/骨骼/辅助/附着/事件/PRE2/相机/光源/碰撞/枢轴），MDL 轨道名→MDX id，mdx2gltf 接受 .mdl | sample.mdl / sample2.mdl 双样本解析+GLB 干净 |

## 三、JASS 引擎进 WASM（M3，engine/src/jass.c 现 ~2000 行）

权威实现 `server/jass/`（JS 侧 oracle）：parse.js 285 行 / vm.js 285 行 /
engine.js 1506 行（natives）/ boot.js 73 行。C 版逐模块对照移植，**AST 与
执行结果均与 JS 逐字节/逐值一致**。

### 3.1 词法 + 语法解析（提交 db8af6a→2457994 段，摘要版；5ed5802 完成 AST 版）
- lex 与 parse.js 逐规则对应（// 与 /* */ 注释、字符串转义、'fourcc'→uint32、
  $hex/0x、real/int、标识符/关键字、运算符与结构符，带行号）
- 递归下降全套语句 + 顶层 types/globals/natives/functions
- **修复 3 个 C 内存缺陷**（真实 51KB 地图脚本实测暴露，SAFE_HEAP/guard 定位）：
  1. `realloc` 新元素未清零 → `takes nothing` 不写 nparams → json_params 按垃圾长度越界读
  2. **arena 单块 realloc 移动 → 已分发指针全部悬垂**（tokens 字符串/AST 节点），
     解析 war3map.j 乱码死循环 → 改块链表分配器（块永不移动，指针稳定）
  3. call 实参数组每次循环重新分配 → 旧元素丢失（NULL 序列化成 int 0）→
     临时数组收集后一次性拷入 arena
- 另加 parse_block 20 万次迭代 guard（解析不得推进时打印卡住 token 并退出，
  真实脚本内死循环不再挂死引擎）

### 3.2 完整 AST 输出（提交 5ed5802 + de3d32a）
- 与 JS parse() **同构**的完整 AST（表达式/语句树，节点键名/形状一致）
- 验证：mini 脚本 + 真实 war3map.j（51KB）**AST 逐字节相等**（111603 字节）
- 后补修复：空 else 块 → `"els":[]`（非 null），hasElse 标志

### 3.3 拼接全量解析（common.j + Blizzard.j + war3map.j，655900 字节）
- 与 JS 拼接 parse **逐字节对照一致**：C 端 36ms 解析，**1007915 字节 AST 完全相等**
- 规模：964 函数 / 1160 natives / 898 globals / 91 types
- 修复 2 个对照差异（ASAN 定位）：
  1. 空 else 块 → `"els":[]` 非 null（hasElse 标志）
  2. **b_str 转义分支 `char e[2] = {'\\', c}` 缺 '\0'** → strlen 越界读栈内存
     （乱码每次运行不同，源自未初始化栈数据）→ `char e[3]`

### 3.4 C 版 VM 执行器（提交 6f82610 + b4c2b6c + 7cf00a7 + 2c0069c）
- **重构**：jass_parse 拆 parse_ast（内存 AST，arena 随 AST 存活）+ ast_to_json
  + free_ast；VM 直接吃内存 AST 不经 JSON 往返（序列化出口行为不变，回归 28 绿）
- **VM**（对齐 vm.js，同步树遍历）：值（int/real/bool/null/str/动态数组）、
  作用域链、全语句（local/set 含数组/if-elseif-else/loop/exitwhen/return，
  X_OK/X_RET/X_EXIT 状态码链，C 递归调用）、全表达式（int/real 混算、
  string 拼接、全比较符、jassEq 的 null==false 特例、数组越界→null）
- natives 第一版内嵌表：BJDebugMsg/I2S/R2I/I2R/R2S；opLimit 800 万护栏
- 新入口 `_jass_run(src, entry)` → `{"ok", log, globals}` JSON
- 验证：**迷你脚本（全局/数组/递归 Fact/loop/数组下标/字符串拼接/native 输出）
  C log 与 JS 权威 vm.js 完全一致**（fact5=120/x=5/s0=5/i=3）、counter=120 一致

### 3.5 natives 分发表 + 真实地图 main 全链执行
- value 加 **V_HANDLE**（handle id 0x100000 起，对齐 engine.js nextHandleId；
  `!= null` 判定、handle==handle 按 id 比较）
- natives 改**分发表**（名字→实现，static NATIVES 表）：已实现 **~140 个**——
  环境/配置空实现（SetCameraBounds/SetDayNightModels/SetMapMusic/SetPlayers 等，
  对齐 engine.js `() => {}` 语义）、数学/字符串真实现（I2S/R2I/I2R/R2S/
  GetRandomInt/GetRandomReal 固定 LCG 种子可复现）、枚举恒等转换（42 个
  ConvertXxx，对齐 JS `C(name)(i) => i`）、handle 工厂（CreateUnit/CreateTrigger/
  Player/Rect/Filter/AddWeatherEffect 等）、查询默认值（GetGameSpeed=2/
  VersionGet=1/IsFogEnabled=false 等）
- **未实现 natives 打 `[unimpl:Name]` log 返回默认值**（迭代式：跑 main 收集
  缺失 → 按需实现 → 再跑），两次迭代归零
- 调用 trace：结果 JSON 新增 `"calls":[去重 native 名]`（调用序证据）
- **验证：war3map.j `main` 全链在 C VM 完整执行**（41ms，35/35 测试全绿）：
  main → 环境 natives → CreateAllUnits → InitBlizzard → InitGlobals →
  InitCustomTriggers → RunInitializationTriggers，**无未实现 natives，87 个
  natives 被调用**；main 全链调用序断言常驻测试
- **config 配置链执行**：SetMapName/SetPlayers/SetTeams/DefineStartLocation/
  Player + InitCustomPlayerSlots 等 Blizzard 函数（51ms，**60 个 natives 被调用、
  无未实现**）；补 5 个（GetPlayerId 暂返 0 待 player 对象表深化、
  GetGameTypeSelected/SetPlayerStartLocation/SetStartLocPrio/SetStartLocPrioCount）；
  config 调用序断言常驻（38/38 全绿）

### 3.6 natives 语义深化①：触发器同步执行 + C/JS 全局强对照
- **V_CODE 类型 + E_FUNCREF 求值**：`function Xxx` 实参 → 动作函数名
  （TriggerAddAction/ExecuteFunc 的 code 参数）
- **触发器对象表**（Vm.triggers）：`CreateTrigger` 真分配 handle + 动作表；
  `TriggerAddAction` 存动作函数名；`TriggerEvaluate`/`TriggerExecute`
  同步执行动作（Evaluate 返回 true）；`ExecuteFunc` 按名调用
- **效果**：war3map.j 触发器链真实执行——`RunInitializationTriggers`
  → `ConditionalTriggerExecute(gg_trg_Melee_Initialization)`
  → `Trig_Melee_Initialization_Actions` → MeleeStartingVisibility/HeroLimit/
  GrantHeroItems/Resources/ClearExcessUnits/StartingUnits/StartingAI/
  InitVictoryDefeat（8 函数链，bj_meleeGrantHeroItems 等被正确 set）
- **jass_run 多入口顺序执行**：entry 支持逗号分隔（`"config,main"`，
  同一 VM 状态连续跑——对齐 engine.js `boot()` = initGlobals+config+main）
- **b_real17**：globals 的 real 输出 17 位有效数字（对齐 JS JSON.stringify
  round-trip；AST 序列化保持 15 位 → 与 JS 最短表示逐字节一致，二者分开）
- **验证：C(config,main) vs JS boot() 全局强对照——880 全局 0 差异**
  （365 值一致 / 56 null / 459 handle 存在性对账）；对账断言常驻测试
- 遗留：main 链 stub natives 610 次调用 → **已全部补齐**（仅 6 种：
  GetPlayerTechMaxAllowed/IsPlayerObserver/SetFloatGameState/Preloader/
  CreateTimerDialog/TriggerRegisterGameEvent，64e0 提交 51e4ee6 后
  main+config 全链 **unimpl 归零**）→ 深化② = natives 真语义
  （玩家对象表/单位表，stub 假 handle → 可查询对象）

## 四、测试资产与工具

- 引擎测试：tools/engine_test.mjs（38 项：vec3 3 + w3x/MPQ 14 + JASS AST 6 +
  AST 逐字节 2 + VM 3 + main/config 调用序 2 + 全局强对照 1），最终一行
  `N passed, M failed`，失败退出码 1
- JASS 对照：C 版（engine.mjs 导出 `_jass_parse`/`_jass_run`）vs JS 版
  （server/jass/parse.js + vm.js）——**计数、AST 字符串、执行 log 三重视角**

## 五、路线图位置（docs/WEBGPU_WASM_PLAN.md）

- M0/M1（WASM 骨架）✅；解析保真（D/E/F 系列）✅
- **M3（JASS 引擎）：3.1 词法语法 ✅ → 3.2 完整 AST ✅ → 3.3 拼接全量解析 ✅
  （670KB 逐字节一致）→ 3.4 VM 执行器 ✅ → 3.5 natives 分发表 ✅
  （~140 个，war3map.j main 全链跑通）→ 3.6 触发器同步执行 + C/JS 全局强对照 ✅
  （880 全局 0 差异）→ 剩余：natives 语义深化②（Melee 系 610 次 stub：
  CreateUnits 序列化/玩家对象表/事件注册）
- M2（WebGPU 渲染）/ M5（zero-copy）：未开始