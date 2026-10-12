# war3web 解析覆盖审计报告（对照 warsmash Java / WhiteoutLib C++）

> 日期：2026-10（会话内审计）
> 方法：逐行对照 warsmash（`Z:\war3\refs\warsmash-src`，parsers/w3x + units/*.java）与
> WhiteoutLib（`C:\Users\a1\refs_dl\WhiteoutLib\...`，bindings/c/whiteout_mdx.cpp + textures/blp/parser.cpp）
> 三路并行审计：① 地图解析 ② 对象数据/游戏数据 ③ 模型/纹理/音频资产。
> 结论性质：只列覆盖差距（有/无/部分），不含实现方案。

---

## 一、地图解析（对照 warsmash parsers/w3x，34 个类）

| 文件/域 | 现有 Python | warsmash | 差距 |
|---|---|---|---|
| MPQ 容器 | ✅ mpq.py（storm 加密/key 破解/zlib/bz2/implode） | MpqDataSource | 持平 |
| **war3map.w3i** | ⚠️ 仅 5 字段（name/author/desc/players/version） | War3MapW3i 40+ 字段 | **缺 35+ 字段 + 全部 6 大列表块**（players[]/forces[]/upgrade+techAvailability[]/randomUnit+ItemTables[]；相机边界/flags/tileset/loading/prologue/雾/天气） |
| war3map.w3e | ⚠️ 头部齐，corner 7 字节合并读 | Corner 12 子位段拆分 | corner 的 ramp/blight/water/boundary 不可分辨 |
| war3map.wpm | ✅ | 一致 | 无 |
| war3map.doo | ⚠️ 缺 skinId、掉落表跳过、版本门控有错位风险 | Doodad 全字段 | skinId/掉落表 |
| **war3mapUnits.doo** | ❌ **全项目 0 解析**（jass CreateUnit 正则替代，只拿 id/x/y/facing） | Unit 25+ 字段 | **整块最大盲区**：player/hp/mana/背包/掉落/英雄等级三围/技能实例(等级+自动施法)/随机组/自定义队伍色/waygate 全丢 |
| **war3map.w3r（区域）** | ❌ 无 | Region 10 字段 | 刷怪/天气/环境音区全缺（现 jass 正则旁敲） |
| war3map.w3s/w3c/wct | ❌ 无（jass 正则替代） | 核心亦无 | 比参考还弱（参考至少走完整音频/相机源） |
| w3u/w3t/w3a/w3h/w3q | ✅ objdata.py 通用结构 | changeset 同构 | 结构等价；w3h 只消费 buff 美术 |
| **w3d/w3b** | ⚠️ objdata.py 支持但 **pipeline.sh 从未调用** | ✅ 完整 | 装饰物/可破坏物类型定义覆盖缺失 |
| **war3mapSkin.\*/war3campaign.\*** | ❌ 无 | ✅ 并列读取 | 皮肤/战役变体缺失 |

**TOP5**：① war3mapUnits.doo 整块 ② w3i 主体（玩家/队伍/随机表/相机/flag） ③ w3d/w3b pipeline 未跑 ④ w3r 区域 ⑤ skin/campaign 变体 + w3i 尾部（ver>30）

---

## 二、对象数据/游戏数据（对照 warsmash units/StandardObjectData）

| 数据表 | 现有 Python | warsmash | 差距 |
|---|---|---|---|
| 5 张单位 SLK raw | ✅ 220 列进 blz_units.json | 同 | 无（raw 层） |
| **unittypes.json 规范化** | ⚠️ 只留 ~92 键 | CUnitType 消费 ~130 列 | **丢列**：splash AoE 三档/伤害因子/spill/targCount/nsight/fatLOS/修理费/科技树 Requires/deathType/auto/库存 stock —— raw 有但没带进运行时表 |
| UnitMetaData.slk | ⚠️ 仅 itemtypes 用 useItem 列；unittypes **硬编码 W3U_MAP**（未命中静默丢弃、无告警） | ✅ 通用映射(index/repeat/data/changeFlags) | w3u 通用元数据桥缺失 |
| w3u 二进制 | ✅ 结构一致 | ✅ | ✅（但 vt==4 bool 误当字符串；无 "::" 重命名） |
| w3u 多来源 | ❌ 只读单一 war3map.w3u | ✅ map+skin+campaign+mod 四源 | 缺（标准图影响小） |
| AbilityData/AbilityMetaData | ✅ | ✅ | ✅ |
| **AbilityBuffData.slk / AbilityBuffMetaData.slk** | ❌ **完全未解析**（注释还错称"档案无此表"，实际 war3_extracted/Units/ 存在） | ✅ | **缺口**（w3h 仅 6 个硬编码 art 字段） |
| **w3h** | ⚠️ 二进制✅ 只消费 6 art id → buffart.json | ✅ 全字段 | 名称/提示/数值/数据全丢 |
| **UpgradeMetaData.slk** | ❌ | ✅ | **缺口**（w3q 字段映射） |
| **w3q 折叠** | ❌ upgrades.json 不含 w3q 覆盖 | ✅ | **地图改升级不生效** |
| UpgradeData | ⚠️ 只 6 键 | ✅ 全列 | 缺每级 Requires/Requiresamount/inherit |
| **Destructable/Doodad MetaData + w3b/w3d** | ❌ 只有渲染/寻路子集 | ✅ 全字段+meta | object-data 层整块缺 |
| MiscData.txt | ⚠️ 仅 8 text tag | ✅ 全量 | upkeep/fog/light/selection circle 缺 |
| wts/TRIGSTR | ✅ | ✅ | ✅ |

**TOP5**：① buff 标准数据+元数据桥（AbilityBuffData/MetaData.slk） ② 升级整链（UpgradeMetaData + w3q 折叠 + Requires 列） ③ w3u 通用元数据映射替代硬编码 ④ 毁灭者/装饰物 object-data 层（w3b/w3d + MetaData） ⑤ unittypes 规范化丢列

---

## 三、模型/纹理/音频资产（对照 warsmash + WhiteoutLib）

> 实测当前资产全集：1023×MDX 全 v800、3679×BLP **全部 BLP1**、无 .mdl/.m3/.dds、无 CORN/FAFX/BPOS/SNDS chunk。
> 即：下两条 TOP1/TOP2 属"潜在缺口"，换 Reforged/自制资产才爆；TOP3/TOP4 是**当前就存在的转出层缺口**。

| 能力项 | Python | warsmash | WhiteoutLib | 差距 |
|---|---|---|---|---|
| MDX 经典 19 chunk（VERS…CLID）+ 40 轨道 tag | ✅ 全 | ✅ | ✅ | 无（解析层） |
| **MDX CAMS 相机** | ❌ **死代码**（dict 预留 cameras 从不填充，注释误导；KCTR/KTTR 轨道表分量数写错） | ✅ 运行层 Camera | ✅ 全套相机轨道 | **明显、零成本可补** |
| CORN/SNDS/SNDE/FAFX/BPOS | ❌ | ✅（CORN/CAMS/FAFX）+ 未知 chunk 保留 | ✅ 全 | 差距（当前资产无） |
| MDL 文本 | ❌（直接 assert 崩） | ✅ 读写 | ✅ 读写 | 格式层缺口 |
| **粒子/ribbon 逐序列动画曲线转出**（KP2S/R/L/N/W/G、KPLN/LT/EE/EG/ES、KRHA/HB/AL/CO/TX） | ⚠️ **解析有，glb 转出只带静态+vis/rate** | Sd 全轨道求值 | 全轨道 | **明显（当前就丢）**：特效"速度/大小/重力随时间变"永久丢 |
| **材质/骨骼转出保真**：multi-UV(coordId>0)/KMTF 纹理替换/KGAC 逐序列颜色/KATV 附件可见性/节点 flags/权重>4 关节 | ⚠️ 解析有，转出折叠（只用 uv0、单层材质、静态 color、等权 1/n 截断） | 全 | 全（含 HD fresnel/emissiveGain/shader/subTextures） | **明显（当前就丢）**：用户"解析不够全面"的最大来源 |
| BLP1（JPEG/调色板） | ✅（无 mip、alpha 深度简化） | 外包 ImageIO | 有（+mip+1/4/8bit alpha） | 部分 |
| **BLP2 / DXT(BC1-5) / BGRA 直存** | ❌（assert 'BLP1'） | 无（插件未知） | ✅ 全编码 | **明显（换图就爆）** |
| M3（SC2）+ Reforged HD 材质 | ❌ | ❌ | 全量+写回+gltf/fbx 转换 | 巨大鸿沟（当前资产不涉及） |
| WAV 音频 | ✅ ffmpeg 转码（PCM/ADPCM/MP3） | 仅 PCM16 | 无 | 无（Python 更广但依赖外部 ffmpeg） |

**TOP5**：① BLP2/DXT/BGRA+mip+alpha 深度 ② MDX CAMS 相机（死代码） ③ 粒子/ribbon 逐序列动画曲线转出 ④ 骨骼/材质动画转出保真（multi-UV/KMTF/KGAC/KATV/flags/权重） ⑤ M3+Reforged HD 与 MDL 读写

---

## 四、结论（跨三路合成，按"当前实际影响"排）

### 当前就爆（现有资产/玩法直接受影响）
1. **转出层信息丢失**（资产路 TOP3/TOP4）：粒子动画曲线、KGAC 颜色、KMTF、multi-UV、节点 flags、权重截断——**"解析不够全面"的第一来源**，改 `tools/mdx2gltf.py` 直接受益当前所有模型特效。
2. **地图内容盲区**（地图路 TOP1/TOP2）：`war3mapUnits.doo` 零解析 + w3i 仅 5 字段——玩家槽位/队伍/随机表/预放置单位（hp/背包/英雄属性/技能实例）是"地图实际内容"，现在靠 jass 正则凑。
3. **对象数据链路断点**（对象路 TOP2/TOP3）：w3q 不折叠（升级覆盖无效）、unittypes 丢列（splash/科技树要求等 raw 有不用）——直接影响玩法数值完整性。

### 潜在（换图/换资产才爆）
4. **BLP2/DXT**（资产路 TOP1）：任何 1.30+/自制 BLP2 纹理整批失败（当前 3679 张侥幸全 BLP1）。
5. **w3d/w3b pipeline 未调用 + skin/campaign 变体 + 区域 w3r**（地图路 TOP3/4/5）：自定义装饰物/可破坏物属性、地图区域无来源。
6. **buff/升级 MetaData.slk 全缺**（对象路 TOP1）：w3h/w3q 的字段桥没有。
7. **MDX CAMS 相机死代码**（资产路 TOP2）：零成本补，对齐 warsmash/WhiteoutLib 即可。
8. **M3/Reforged HD 体系**（资产路 TOP5）：全套缺席，当前资产不触发。

### 明确不补（参考亦无 / 计划红线）
- war3map.wct/wtg（JASS 触发器二进制）：warsmash 核心亦不解析，维持 jass 正则/文本探针。
- 资产管线 Python 保持现状（WEBGPU_WASM_PLAN 红线"资产管线不迁"）；引擎/wasm 只做运行时能力，不重写解析。
---

## 修复状态（2026-10 会话内完成 A→B→C，按"全推不停"）

> 提交（master）：a8b4448（A）→ d9588e4（B）→ f5c6bba（C1）→ 3a38585（C3）→ c25b4c2（C2）
> 验证：mapdata_test 全过（17 断言）、engine_test 17/17、MDX 转出 16 模型批量验证
> data/ 为 gitignored 产物目录（管线再跑即重建）。

### A · MDX 转出保真（tools/mdx2gltf.py）
- PRE2 粒子动画曲线：speedCurve/variationCurve/gravityCurve/latitudeCurve/lengthCurve/widthCurve（+Step 标志，与静态值并存不冲突）
- PREM 发射器：longitudeCurve/latitudeCurve/gravityCurve/lifespanCurve/speedCurve
- RIBB 飘带：heightAboveCurve/heightBelowCurve/alphaCurve/colorCurve(3d 序列)/textureSlotCurve
- KGAC 每序列颜色曲线（geosetColorCurve）、KMTF 纹理替换（textureSwaps）、multi-UV（TEXCOORD_1）
- 节点 billboard/flags（w3node）、KATV 附件可见性（vis）
- 分裂特效剔除、锚点对齐、Tag（修订版）深度修正的原架构保留不动

### B · 地图内容盲区（tools/w3i.py + tools/unitsdoo.py）
- **w3i 全量 40+ 字段**：此前只落 5 个（版本/名/作者/描述/玩家数）。新增 players（id/type/race/出生点/同盟优先级）、forces（旗帜/掩码/名字）、相机边界 8 值、可玩尺寸、tileset、雾/天气、进出场屏、升级/科技可用性变化、随机单位/物品表（版本门控 + available()|0 守卫，对齐 warsmash）
- **war3mapUnits.doo（预放置单位）此前 0 解析**：25+ 字段逐字节对齐 warsmash Unit.java——id/variation/坐标/朝向/缩放/flags/player/未知 u16/HP/魔力/掉落表/背包(6槽)/技能实例(自动施法+等级)/英雄(等级+三维)/随机旗标(等级/组/表)/队伍色/传送门/创建序号；skingId 按 1.32 版本门控。91 个单位字节级校验 10453==10453
- terenas 实测：2 玩家（人族西北/兽族东南出生点符合官方布局）、1 队伍、84×84 可玩、24 种单位

### C1 · unittypes 丢列补回（92→134 字段）
- 溅射全套：splashFull/Half/Quarter + 因子 + damageLoss/spillDist/spillRadius/targCount/splashTargets（69 个溅射单位：迫击炮 25/150/250+0.4/0.1、战舰半衰 0.5/0.25）
- 视野/经济/行为：nightSight(234 非默认)/fatLOS/minRange/defUp/修理费/repairTime/deathType/autoCast/canFlee/prio/points/propWin/建筑放置约束/dropItems/库存 stock 三件套/武器2 同步
- **科技树 Requires 列为数据源缺失**：war3_extracted 的 UnitData.slk 无 Requires/ureq 系列列（warsmash 注释证实列名 1.30+ 才改为'Requires'），无法凭空补——已记录

### C2 · 升级表补全（tools/upgrades.py）
- **UpgradeMetaData.slk 37 字段映射运行时读入**（ID→列名，不硬编码漂移）：gnam→name、ginh→inherit、greq/grqc→科技树、gef1-4/gba*/gmo*/gco*→效果组、gbpx/gbpy→按钮位、gar1→art
- **w3q 折叠**（base+custom 覆盖名字/费用/效果/科技树），terenas 空表验证输出无回归
- 输出补 tip/ubertip/art/hotkey/buttonpos/global/inherit

### C3 · buff art 修复（tools/abilities.py）
- **修真 bug**：*AbilityFunc.txt 的 buff 条目字段是大写（Buffart/Effectsound），ART_FUNC 是小写键——FUNC 部分长期空转，w3h 覆盖成了唯一来源。新增 BUFF_FUNC_FIELDS 全 21 字段映射（不区分大小写）
- buffart.json 0→117 条：target 模型全有、icon/声音/挂点/导弹参数/Spelldetail 全收
- 澄清：AbilityBuffData.slk 只是 9 列注册表（无 Bufftip/名称列——审计 subagent 判断"全丢"部分过度）；buff 真实字段在 *AbilityFunc.txt，现已全量

### 新增管线步骤
pipeline.sh 第 2 步插入：tools/w3i.py + tools/unitsdoo.py（地图文件解析后）

### 新增/更新测试
- tools/mapdata_test.py（17 断言：w3i 结构 + units.doo 字节精度）
- 资产批量验证（16 模型多样抽测）、engine_test 17/17 回归、mapdata_test 全过

### 第二轮（D/E 组，master ecbf617/ff0e2ed/007b3e2/41884e8/57a8be1）
> 回归：mapdata_test 0 failed、engine_test 17/17、MDX 全量 1023 模型 0 失败

- **D1 · MDX CAMS 相机破死代码**（41884e8）：CAMS 块此前整体跳过（相机 0 解析），现按 MdlxCamera.readMdx 全量解析；TRACK_SPEC 修正 KCTR/KTTR (1,f)→(3,f)、KCRL (1,i)→(1,f)（对齐 warsmash getVectorValue——旧规格会吞数据错位）；**238 模型 240 相机落位**，glb asset.extras 带出
- **D2 · w3d/w3b 接入管线**（007b3e2）：objdata 支持但管线未传；补传 + 缺文件跳过（地图只有自己编辑的表）
- **D3 · TRACK_SPEC 全量对齐**（ff0e2ed）：对照 AnimationMap.java 补 9 个官方轨道（Fresnel KFC3/KFCA/KFTC + Popcorn KPP*，1.30+ 新格式），52 条规格全部对齐
- **D4 · w3r 区域解析**（ecbf617）：对照 Region.java 逐字段，空文件防御，合成 2 区域字节级验证；terenas v5 空表
- **E1 · BLP2 解码器**（57a8be1）：资产路 TOP1 关闭——任何 BLP2 纹理此前直接崩整条管线；支持 JPEG/未压缩(BGRA+调色板)/DXT1/DXT3/DXT5，手算样本全套验证（插值色 170,0,85、DXT5 alpha 梯子 36/255、BGRA 翻转、3 色透明），BLP1 路径零改动回归
- 环境：系统 Python314 补装 numpy 2.5.3 + pillow 12.3.0（aliyun 镜像）

### 第三轮（F1 · MDL 文本 IO，master 6586c42）
> 回归：mapdata_test 全 0 failed、engine_test 17/17、MDX 全量 1023 模型 0 失败

- **F1 · MDL 文本模型解析器**（tools/mdl.py 新增，~670 行）：
  - 游戏只加载 MDX 二进制，但编辑器/建模工具/大量自定义模型以 .mdl 文本分发——此前管线对 .mdl 完全零触发（静默不可见）
  - Tokens 移植 warsmash MdlTokenInputStream（空白/逗号/冒号分隔、{} 独立 token、引号字符串、// 行注释、块标题可选）
  - 块集合：Version / Model / Sequences / GlobalSequences / Textures / TextureAnims / Materials(Layer 全字段) / Geoset(顶点/法线/UV/Face/Triangles/Groups/MatrixGroup/Matrix/Extent) / GeosetAnim / Bone / Helper / Attachment / EventObject / ParticleEmitter2(全参+轨道) / Camera(位置/视场/远近裁剪/目标) / Light / CollisionShape / PivotPoints；未知块 token 级跳过
  - 轨道：MDL 名字（Translation/Rotation/Scaling/Visibility/Alpha/Color + PRE2 的 Speed/Variation/Latitude/Gravity/EmissionRate/Length/Width）映射 MDX id（KGTR/KGRT/KGSC/KATV/KGAO/KGAC/KMTA/KP2S…）；多帧时间线（`{0,{v},1000,{v}}`）、块级 Interpolation/GlobalSeqId 应用到节点全部轨道、interp/globalSeq 落在每个轨道 dict 内（与 mdx 轨道头同构）
  - MatrixGroup 按“每组矩阵数量”解析（MDX 偏移语义），Matrix 块展平 id
  - Camera 键与 mdx 对齐：position/targetPosition/fieldOfView/nearClippingPlane/farClippingPlane
  - mdx2gltf：输入接受 .mdl；重建 mtime 纳入 mdl.py；父节点 id 缺失回退 root（MDL 自由度）
- 验证：sample.mdl（三角+骨骼+序列+轨道）与 sample2.mdl（PRE2 多帧 speed 轨道 + globalSeq visibility + 相机 + 事件）双样本解析字段全对、转 GLB 干净（节点/网格/动画落位）
- 剩余防御项：M3（Reforged HD 二进制）无 warsmash 参考 + 无资产样本，仅当资产出现时再做

### 第四轮（JASS 引擎进 WASM · M3，master 458805b→2c0069c + 待提交 hasElse）
> 回归：engine_test 31/31 全绿（含新增 JASS 对照）；MDX 全量 1023 模型 0 失败不受影响

- **3.1 词法+语法解析**（458805b/db8af6a/d9aad40/2457994，jass.c 摘要版）：
  C 移植 server/jass/parse.js——lex 逐规则对应（// 与 /* */ 注释、字符串转义、
  fourcc、$hex/0x、数字、标识符/关键字、运算符、行号），递归下降全套语句 +
  顶层 types/globals/natives/functions；摘要 JSON 与 JS 计数全等
  **实测暴露并修复 3 个 C 内存缺陷**（51KB war3map.j 真脚本，SAFE_HEAP/guard 定位）：
  ① realloc 新元素未清零 → takes nothing 不写 nparams → json_params 按垃圾长度越界读
  ② **arena 单块 realloc 移动 → 已分发指针（tokens 字符串/AST 节点）全部悬垂**，
    解析 war3map.j 乱码死循环（C 内 guard 抓到 20 万次迭代不推进）→ 改块链表分配器
  ③ call 实参数组每次循环重新分配 → 旧元素丢失（NULL 序列化成 int 0）→ 临时数组收集
  另加 parse_block 20 万次迭代 guard（防真实脚本死循环挂死引擎）
- **3.2 完整 AST**（5ed5802/de3d32a）：与 JS parse() 同构完整 AST（表达式/语句树），
  mini + 真实 war3map.j（51KB）**AST 逐字节相等（111603 字节）**；后补 hasElse
  （空 else 块 → "els":[] 非 null）
- **3.3 拼接全量解析**（进行中）：common.j(167KB)+Blizzard.j(452KB)+war3map.j(51KB)
  拼接 655900 字节 → C 解析 **36ms**，964 函数/1160 natives/898 globals/91 types，
  与 JS 拼接 parse 逐字节对照仅剩 1 项：个别字符串出现 4 字节乱码
  （`"scripts\OrcMelee.pld"` → `scripts\mlbHOrcMelee.pld`），最小复现已锁定，定位中
- **3.4 C 版 VM 执行器**（6f82610/b4c2b6c/7cf00a7/2c0069c）：jass_parse 拆
  parse_ast+ast_to_json+free_ast（VM 直接吃内存 AST 不经 JSON）；VM 对齐 vm.js
  同步树遍历：值(int/real/bool/null/str/动态数组)+作用域链+全语句
  (local/set 含数组/if-elseif-else/loop/exitwhen/return, X_OK/X_RET/X_EXIT 状态码链,
  C 递归调用)+全表达式(int/real 混算, string 拼接, 全比较符, jassEq null==false 特例,
  数组越界→null)；natives 第一版内嵌表 BJDebugMsg/I2S/R2I/I2R/R2S；opLimit 800 万
  新入口 _jass_run → {"ok",log,globals}
  **验证**：迷你脚本（全局/数组/递归 Fact/loop/数组下标/字符串拼接/native 输出）
  C log 与 JS 权威 vm.js **完全一致**（fact5=120/x=5/s0=5/i=3）、counter=120 一致
- 证据文档：新增 docs/PROGRESS.md（成果日志：功能/验证/提交哈希/验证命令）
- **3.5 natives 分发表 + 真实地图 main 全链**（a76ec1d/607e874）：
  value 加 V_HANDLE（handle id 0x100000 起）；natives 改分发表（~140 个）：
  环境/配置空实现（对齐 engine.js () => {}）、数学/字符串真实现（I2S/R2I/I2R/R2S/
  GetRandomInt/Real 固定 LCG）、42 个 ConvertXxx 恒等转换、handle 工厂、查询默认值；
  未实现 native 打 [unimpl:Name] log 返回默认值——迭代式补充两次归零；用户函数
  优先于 natives 查找（修正 Add/Fact 短路）；结果 JSON 加 "calls" 调用序证据
  **验证：war3map.j main 全链 C VM 完整执行（41ms），87 个 natives 被调用、
  无未实现**，测试 35/35 全绿（新增 main 执行完成/无未实现/调用序完整断言）
- 证据文档：docs/PROGRESS.md 持续更新（3.1→3.5 全记录）

> 路径迁移（2026-10-10）：仓库已从 NFS 盘 Z:\war3 整体迁移至 C:\Users\a1\war3
> （robocopy /MOVE，33895 文件 0 失败；CMake 缓存已重建；本地构建+38 项测试全绿）。
> 本报告中所有 Z:\war3 路径现指向 C:\Users\a1\war3。

## 第五轮 · JASS 引擎 natives 语义深化①：触发器同步执行 + C/JS 全局强对照（2026-10-10，本地 C:\Users\a1\war3）

- V_CODE 类型 + E_FUNCREF 求值（function Xxx 实参 → 动作函数名）
- 触发器对象表：CreateTrigger 真 handle + TriggerAddAction 存动作 +
  TriggerEvaluate/TriggerExecute 同步执行 + ExecuteFunc 按名调用
- 效果：war3map.j 触发器链真实执行（RunInitializationTriggers →
  ConditionalTriggerExecute(gg_trg_Melee_Initialization) → Trig_Melee_Initialization_Actions
  → MeleeStarting* 8 函数链）
- jass_run 多入口顺序执行（"config,main"，对齐 engine.js boot()）
- b_real17：globals real 17 位精度（AST 序列化保持 15 位）
- **C(config,main) vs JS boot() 全局强对照：880 全局 0 差异**
  （365 值一致 / 56 null / 459 handle 存在性对账）——常驻断言
- 验证：npm run engine:test 38/38 全绿；提交 ccf1333 + 3aa86da 已推送
- 遗留：main 链 stub natives 610 次调用（Melee 系，深化②按 unimpl 清单逐项实现）

### 第五轮续（3.6 stub 归零 + 玩家表 + 单位表，2026-10-10）

- main 链 stub 610 次调用 = 仅 6 种 natives（GetPlayerTechMaxAllowed/IsPlayerObserver/
  SetFloatGameState/Preloader/CreateTimerDialog/TriggerRegisterGameEvent）→ 全部补齐，
  main+config 全链 unimpl 归零（51e4ee6）
- 玩家对象表：Player(i) 幂等（16 常驻，同 index 同 handle）+ GetPlayerId 真实现
  （5807c53）
- 单位对象表：CreateUnit 真分配（typeId/owner/alive）+ GetUnitTypeId/GetOwningPlayer/
  UnitAlive/KillUnit 查询还原（d803b8c）
- 验证：npm run engine:test 42/42 全绿；C(config,main) vs JS boot() 880 全局
  强对照持续 0 差异；提交 51e4ee6→5d57537 已推送

### 第五轮续2（3.9 批量 natives：单位坐标/朝向 + 玩家金木资源，b9460eb；47/47 全绿，对账 880 零差异保持）


### 第五轮续3（3.9 坐标/朝向+玩家金木 b9460eb；3.10 对象表批量：GetHandleId/字符串/rect 8 查询/location/group ForGroup 枚举 58bc737；56/56 全绿，880 对账保持）


### 第五轮续4（3.11 哈希表族 4 类型存取/HaveSaved/Flush + GetPlayerName + 文本显示 e676948；62/62 全绿，880 对账保持）


### 第五轮续5（3.12 force 集合 ForForce/GetEnumPlayer + 物品对象表 c2c7e9c；67/67 全绿，880 对账保持）


### 第五轮续6（3.13 单位能力 + region 表 9d1f986；71/71 全绿，880 对账保持；深化累计 ~70 个真语义 natives：player/unit/trigger/rect/loc/group/force/item/hashtable/region）


### 第五轮续7（3.14 玩家颜色默认=index + 科技 researched/max 存储 1881e2e；75/75 全绿，880 对账保持；本轮 3.6→3.14 共 9 个 commit 全推送）


### 第五轮续8（3.15 数组对账 c8ad98e：C 输出 arrays 段 + JS 提取对齐，18 数组非默认元素零差异；发现 Convert 系 JS=Handle vs C=int 的存储形态差异并归一；80 commit 里程碑达成；76/76 全绿）


### 第五轮续9（3.16 触发器条件 TriggerEvaluate 拆分 + 计时器表 + 单位状态存储 a09d7e1；81/81 全绿；本轮 3.6→3.16 共 11 个功能 commit 全推送）


### 第五轮续10（3.17 触发器事件注册表 8 类 1e82dca；83/83 全绿；本轮 3.6→3.17 共 12 个功能 commit 全推送）


### 第五轮续11（3.18 数学族 11 natives + 玩家属性存储 46f8455；92/92 全绿；本轮 3.6→3.18 共 13 个功能 commit）


### 第五轮续12（3.19 单位范围/颜色 + GetLocalPlayer + Destroy 真回收 8343b60；97/97 全绿；本轮 3.6→3.19 共 14 个功能 commit）


### 第五轮续13（3.20 触发上下文 GetTriggeringTrigger + 金矿资源量 + GameState 事件 1a7a1ab；**100/100 全绿 测试破百里程碑**；本轮 3.6→3.20 共 15 个功能 commit 全推送）


### 第五轮续14（3.21 联盟矩阵 IsPlayerAlly/Enemy + SetPlayerTeam + RemoveLocation 回收 f603977；105/105 全绿；本轮 3.6→3.21 共 16 个功能 commit）


### 第五轮续15（3.22 出生点坐标表 + ForceEnumPlayers 8895b9e；109/109 全绿；本轮 3.6→3.22 共 17 个功能 commit 全推送）


### 第五轮续16（3.23 触发器清空/移除 + region 格存储 ac69e3b；112/112 全绿；本轮 3.6→3.23 共 18 个功能 commit 全推送）


### 第五轮续17（3.24 natives 收尾批 73682a0；114/114 全绿；natives 深化收尾：累计 ~115 个真语义 natives，剩余仅环境/音频/UI 类合理空操作；本轮 3.6→3.24 共 19 个功能 commit 全推送）


### 第五轮续18（M2 调研：WebGPURenderer 迁移要点文档 docs/M2_WEBGPU_MIGRATION.md；render.js 现状盘点 + 官方迁移差异点 + 分步试点计划 + 风险对策；M2 与 WASM 并行推进确认）


### 第五轮续19（M2 步骤A 落地 35fb526：WebGPURenderer 试点开关 localStorage.webgpu=1 + 异步 init 等待 boot/首帧 + anisotropy fallback；默认 WebGL 保底行为不变；render.js/main.js ESM 语法检查通过 + 引擎 114/114）


### 第五轮续20（M2 步骤A 浏览器实测 42e92eb：playwright 验证 WebGPURenderer 激活成功——地形加载、渲染循环 0 错误、WebGL 回退正常；修复 r185 默认构建不含 WebGPURenderer → importmap 补映射 + 动态 import + resize 延时）


### 第五轮续21（M2 步骤B 对局实测：playwright 驱动进对局 playing 相位——WebGPU 后端 95 单位模型渲染、累计 43754 draw calls/47824 tris；粒子 ShaderMaterial 不兼容风险确认（NodeBuilder 错误，不影响主场景）；截图 docs/m2_webgpu_playing.png 留档）


### 第五轮续22（M4 预研：docs/M4_SIM_WASM_PLAN.md 模拟核心进 WASM 设计——world.js 分区盘点/移动寻路碰撞/弹道攻击经济三阶段移植/SOA 快照草案/wasm heap 到 WebGPU 零拷贝数据流；M3 已达标作为共享代码库）


### 第五轮续23（M4 阶段1 行为锁定：tools/path_golden.mjs + goldens/path_trace.json 黄金基准——真实地图 5 场景全部到达门禁通过；实测结论：JS 寻路=轻量直线段+碰撞回退、多单位实体碰撞互挡——C 移植需复现这两语义）


### 第五轮续24（M4 阶段1 C 移植：engine/src/sim.c 全量移植 pathing.js Grid——A*+string-pull+扫掠碰撞+连通；tools/sim_test.mjs 门禁 5/5 场景 C/JS 寻路段数+坐标完全一致；npm run sim:test 已挂脚本）


### 第五轮续25（M4 阶段1 端到端 C 复现完成：sim_run_move (movementPath 快路径+慢路径A*、turnToward 转向预算、stepLen 推进、canAdvance 扫掠、40 到达门禁)；sim_test 5/5 到达行为与 golden 完全一致 (tick 差<=3、路径长度逐位一致)；golden 升级 arrive 时刻快照；排查耗点：HEAPF64 未导出改 float 输出、walkPtr 提前 free 致悬空、golden 字段语义不一致)）


### 第五轮续26（M4 阶段1 多单位+实体碰撞：sim 单位表 (spawn/order_move/tick/get/get_path) + canAdvance 实体投影 + occupancy 绕行 + 250ms 撞墙重寻路；根因排查：JS A* g/f=Float32Array vs C double → f 相等性/堆序不同 → 路径不同，改 float32 后碰撞场景段数/到达tick/终位完全一致 (93=93)）


### 第五轮续27（M4 阶段1 收口 + 阶段2 预研启动：wasm_move 统一接口 sim_move（目标记忆判据，修复 A* 格中心终点 vs 原始目标致每 tick 重寻路卡起点；smoke 86=86）；阶段2 预研文档（子系统盘点/黄金场景/C 设计/风险）；combat_golden.mjs 敌对 hfoo 近战 3 场景行为锁定——攻击间隔实测 41tick=atkTimer cd 配额、死亡 1573/1594/1574 tick、hfoo hp420/dmg11/range90/cd1.35/point0.5）


### 第五轮续28（M4 阶段2 战斗核心 C 移植：SimUnit 战斗字段 + sim_spawn_fight + 攻击状态机 (stepAttack 子集: atkTimer/目标扫描/转向/windup) + damage 纯数值 (typeBonus 7x8 + armorFactor) + combat_test 对照 melee_close 硬门禁全过 (死亡 Δ41≤45 随机1击、首击 0=0、攻击 76vs78、HP曲 OK、首死id 1=1)；根因: sim_set_dmg_table double* vs HEAPF32 写错位 → float* 修复；melee_apart/3v1 标注 pending=stepAI 追击/目标选择未移植）


# 续29：M4 phase2 stepAI 追击移植 —— 战斗 3/3 场景硬门禁全过（commit 2b704a6）

## 本轮成果
- **C 侧完成 stepAI 追击子集移植**（engine/src/sim.c）：
  1. SimUnit 增 AI 字段（orderType/orderTargetId/acquisitionRange=500 实测/homeX/homeY）
  2. step_ai_unit：idle→acquisitionRange 内敌对最近→attack；attack→目标死回 idle/
     超射程追击/在射程停打
  3. sim_route（= JS routeUnit，**无实体阻挡**追击寻路）——与玩家订单 order_move
     （含实体阻挡）语义区分开，是 melee_apart 首击对齐关键
  4. sim_combat_step 顺序补齐 stepAI→stepMove→stepAttack
- **golden 真实性修正**（combat_golden.mjs）：createUnit 参数错序(y 传 0)曾污染 pos；
  原 golden 未设 w.jass → playerOf 全 undefined → hostile 全真 → 3v1 是伪场景。
  注入最小 players 表+eventId/fire/triggers stub 后真实敌对语义锁定。

## 验证（全部通过）
- combat_test 3/3 场景硬门禁：
  - melee_close 死亡 1532 vs JS1573 (Δ41≤45) | 首击0=0 | 攻76/78 | HP曲OK | 首死id1=1
  - melee_apart 死亡 1551 vs JS1592 (Δ41) | 首击19=19 | 攻76/78 | HP曲OK | 首死id1=1
  - melee_3v1   死亡 544 vs JS511  (Δ33) | 首击1=1  | 攻55/51 | HP曲OK | 首死id0=0
- engine:test 114/114 零回归；sim_test（path 5/5 + golden 5/5 + 碰撞 + sim_move）全绿

## 关键根因日志
1. 追击每 tick 重寻路卡起点 → goalX/goalY 快照判据修复
2. C 每 tick 重扫目标换目标 → 固定 AI 目标优先、失效才扫描修复（3v1 对齐）
3. 追击寻路带实体阻挡走慢路径 → sim_route 无实体直连修复（melee_apart 首击 36→19）

## 证据
- commit 2b704a6（4 files: sim.c/combat_golden/combat_test/combat_trace.json）+ 文档 2f9cd79
- 已 push 到 origin/master
- docs/M4_SIM_WASM_PLAN.md §2.7 记录

# 续30：M4 phase2 远程武器导弹移植 —— 4/4 场景硬门禁全过（commit f63e678）

## 本轮成果
- **C 侧完成 stepMissiles 移植**（engine/src/sim.c）：
  1. SimMissile 表（256 槽）：active/srcId/targetId/aim快照(sx,sy,dx,dy)/speed/deadlineMs/
     amount(发射时已 roll)/atkTypeIdx
  2. release_attack 分叉：weaponKind!=0 && missileSpeed>0 → 发射导弹（延迟伤害），否则近战直击
  3. step_missiles：homing 追踪（目标死无伤坠落）、deadline 兜底、命中调 sim_damage
     （射手死则空耗）
  4. sim_combat_step 顺序：先 step_missiles 再单位循环（对齐 step()）
  5. sim_spawn_fight 增第 21 参 missileSpeed
- **golden 增 ranged_hwat 场景**：人类哨兵（missile/1300速/射程300）vs hfoo。
  探测锁定完整战斗参数；golden 记录 types 数组。

## 验证（全部通过）
- combat_test 4/4 场景硬门禁：
  - melee_close/melee_apart/melee_3v1 全过（同前）
  - ranged_hwat 死亡 1056 vs JS1101 (Δ45) | 首击7=7 | 攻50/52 | HP曲OK | 首死id1=1
- engine:test 114/114 零回归；sim_test 全绿
- melee_3v1 JS deathTick 511→544：随机伤害抖动（±45 容差内）

## 关键根因
1. spawn_fight 原本没把 missileSpeed 存进 SimUnit → 补存
2. 导弹必须发射时 roll 好伤害（JS releaseAttack 先 roll 再 launchMissile），命中时不再 roll

## 证据
- commit f63e678（4 files: sim.c/combat_golden/combat_test/combat_trace.json）
- 已 push 到 origin/master；docs/M4_SIM_WASM_PLAN.md §2.8 记录

# 续31：M4 phase2 采集经济移植 —— 采集循环硬门禁全过（commit f735424）

## 本轮成果
- **C 侧完成 stepGathers 移植**（engine/src/sim.c）：
  1. SimUnit 增 kind（hpea/ngol/htow）/playerIndex/gather 状态（toMine/mining/toBase）
  2. 全局 GOLD[16]（JS player.gold）+ sim_get_res 读取
  3. sim_spawn_econ 放置经济单位；walk_spot_near（16 偏移）对齐 JS
  4. sim_econ_step：自动找矿 → 挖 1.8s → 回基地交金 +10 → 循环；农民移动推进
- **新 golden**（econ_golden.mjs → econ_trace.json）：htow+ngol+hpea 三单位，
  录 gold 事件全序列；首金 t57、周期 ~56.7 tick（挖矿 54 tick 主导）

## 验证（全部通过）
- econ_test：前 8 次交金 Δ1-3（≤6）、末次 Δ17（≤20）、次数 64 vs 63（Δ≤1）、
  农民终位一致——采集循环硬门禁全过
- combat 4/4、engine 114/114、sim_test 全绿（零回归）

## 关键根因
1. playerOf 依赖 jass.players（gold 挂玩家对象）——econ golden 注入最小 players 表
2. 挖矿 1800ms = 54 tick，其余 tick 是往返移动；C 恒 56/周期 vs JS 56.7（浮点毫秒）
   → 3600 边界差 1 次交金，末次 Δ17 在容差内

## 证据
- commit f735424（sim.c/CMakeLists/econ_golden/econ_test/econ_trace.json）
- 已 push 到 origin/master；docs/M4_SIM_WASM_PLAN.md §2.9 记录

# 续32：M4 phase2 全量 tick + 事件桥 —— 4/4 场景全过（commit b401159）

## 本轮成果
- **C 侧完成 wasm_step 落地**（engine/src/sim.c）：
  1. sim_step(dt) = SIM_NOW++ → gather_pass → step_missiles → 单位循环（AI/move/attack）
     对齐 JS step()：stepGathers 只发单、stepMissiles 先于单位循环、移动统一在循环内
  2. 重构：采集状态机提取为 gather_pass() 供 sim_econ_step 与 sim_step 复用；
     sim_combat_step 保持不动
  3. 事件桥：EV[8192] 环缓冲 {tick,type,a,b}，attack/missileEnd/death 三处 push；
     SimMissile 增 fx 字段 + 全局 FXSEQ 计数器
  4. 导出 sim_step / sim_events_reset / sim_event_count / sim_events_get
- **新测试 tools/sim_step_test.mjs**：sim_step 跑 4 战斗场景 + 事件桥读回对照 golden

## 验证（全部通过）
- sim_step 4/4：死亡 Δ41/41/0/45、attack 首击全 Δ0、攻击数 76/76/55/50 vs 78/78/55/52、
  missileEnd 24 vs 25、death 事件 tick 精确等于 deathTick
- combat 4/4、econ 全过、engine 114/114、sim_test 全绿（零回归）

## 关键根因
1. SIM_NOW 不在 sim_clear_all 重置 → 第 2 场景起事件 tick 整体偏移 ~3600（已修）
2. tick 基准：golden 用 0-based 循环计数，SIM_NOW 在步内已自增（=t+1）→
   ev_push 写 SIM_NOW-1，C/JS 事件 tick 精确相等

## 证据
- commit b401159（sim.c/CMakeLists/sim_step_test.mjs）
- 已 push 到 origin/master；docs/M4_SIM_WASM_PLAN.md §2.10 记录
