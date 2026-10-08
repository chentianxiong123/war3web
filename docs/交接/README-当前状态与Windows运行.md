# War3Web · 当前状态总览 + 在 Windows 上运行（交接文档 v2）

> 2026-10-08 写 | 用途：把项目从 Linux 交接过去在 **Windows 上跑**
> Windows 侧同样通过共享文件夹访问 `/mnt/shared/war3/`，本文件交代清楚"现在是什么、怎么跑、东西都在哪"。

---

## 〇、一句话现状

**魔兽争霸3（官方对战图 Terenas Stand）已经真实跑在网页上了。**

- 服务端：Node 权威服务器 + JASS VM（跑官方 war3map.j 地图脚本，54 triggers / 95 units / 0 errors）+ 官方数值世界引擎（world.js）
- 客户端：Three.js WebGL 浏览器客户端，中文 UI，真实模型/贴图/图标
- 数据：**全部来自真实游戏**（war3.mpq 1.27 中文版解包），无占位符、无手画
- 部署地址：Linux 上 `http://192.168.31.204:8080/`

**现在能做的闭环**：进图（城镇大厅+5农+500金）→ 农民自动采矿交金 → 选大厅训练出兵 → 选农民建造建筑（11 种官方建筑，右下角命令卡）→ 训练单位 → 右键移动/攻击 → 人族 7 主动技能可放。

---

## 一、目录在哪（两边是同一个目录）

| 侧 | 路径 |
|---|---|
| Linux | `/mnt/shared/war3/`（git 仓库根） |
| Windows（共享） | 同一个共享文件夹，`war3` 目录内 |
| 实际项目代码 | `war3web/`（仓库的子目录） |
| git 远程 | `https://github.com/chentianxiong123/war3web.git` |

> ⚠️ **git 仓库根是 `/mnt/shared/war3`，不是 `war3web`**。war3web 是它里面的子目录，但 git 会向上找到 `.git`，所以所有提交实际都进 `war3web` 远程仓库。
> gitignore 拦了资源（assets/、mpq/、war3_extracted/、node_modules/ 等），**代码可 clone 重建，资源不可 clone 得到**——所以跨机部署走「共享文件夹」，不要走 clone。

---

## 二、项目结构

```
/mnt/shared/war3/
├── war3web/                  ← 真正的项目代码（这就是全部）
│   ├── server/               Node 权威服务器
│   │   ├── index.js          入口（端口 8080）
│   │   ├── world.js          世界模拟/单位/移动/攻击/技能/经济/建造（5805 行系）
│   │   ├── room.js           房间/玩家/消息
│   │   ├── jass/             JASS VM（跑官方地图脚本）
│   │   └── abilities.js      技能引擎（800 技能数据）
│   ├── client/
│   │   ├── index.html        入口页（中文 UI）
│   │   ├── js/
│   │   │   ├── main.js       游戏主循环/输入/消息
│   │   │   ├── ui.js         命令卡/选卡/建造子页组装
│   │   │   └── hud.js        官方命令卡渲染器（12 格）
│   │   └── style.css
│   ├── public/               发布资产（服务直接读，assets 是软链）
│   │   └── assets/ → ../../assets （裸金属目录）
│   ├── assets/               管线产物：996 glb 模型 / 贴图 / 音频（645M）
│   ├── data/                 官方数据 JSON（unittypes 839 / abilities 800 / icons ...）
│   ├── tools/                数据管线（slk.py/unittypes.py/icons.py/extract_icons.py...）
│   ├── package.json          start: node server/index.js
│   └── node_modules/         已装（three/ws）
├── docs/交接/                ← 本目录（交接文档都在这）
├── mpq/                      WC3 原始数据包
├── wasm/                     前期 WASM 解包栈（阶段性成果，已不参与主链路）
├── archive/                  自写 RTS 废案（勿用）
└── web/m2/                   独立 WebGPU 渲染实验（未合回主 client）
```

---

## 三、在 Windows 上跑起来（3 分钟）

### 前置
1. **Node.js ≥ 20.11**（装 LTS 即可，https://nodejs.org）
2. 共享文件夹可访问 `/mnt/shared/war3/war3web/`

### 启动（Windows 命令提示符 / PowerShell）
```bat
cd \mnt\shared\war3\war3web     （用共享盘符路径替代，如 Z:\war3\war3web）
npm install                     （只需一次；three/ws 两个依赖）
npm start                       （= node server/index.js，默认端口 8080）
```
浏览器开 `http://localhost:8080/` → **填名字 → 加入红方 → 准备 → 进游戏**。

> 若 Linux 侧服务已在跑（8080 占用），可临时换端口：
> ```bat
> set PORT=8090
> npm start
> ```
> 流程不变，浏览器用新端口。多开服务不冲突（房间按玩家 slot 0/1 分）。

### 局域网联机（可选）
- Linux 服务在 `http://192.168.31.204:8080/`，Windows 直接开这个地址就能玩。
- 同一个 server 下两浏览器分加入红/蓝方（slot 0/1），即双人对战。

---

## 四、现在做到什么程度（信任清单）

### ✅ 数据（全官方，非手画）
- unittypes 839 / abilities 800 / upgrades 89 / items 273 / gameplay 44
- 图标：按钮图全量提取（CommandButtons 1092 + Passive 58 + Disabled 1149 → png）
- 命令卡关系表：commands.json（15 官方命令）+ unit_card.json（839 单位×卡面）
- 汉化：官方中文名（829 字符串）已并入 hud，乱码 0

### ✅ 游戏系统
- JASS VM 跑 Terenas 官方 war3map.j（采金/造兵/商店/野怪/胜负全在脚本）
- 伤害核心 = 官方 GameplayConstants（攻防相克 7×8 公开公式）
- 技能引擎：800 技能数据 + 7 个人族主动技能 case（治疗/心灵之火/驱散/减速/隐身/变羊/防御，官方 AbilityData 数值）
- 建造端到端：农民→选建造子页（11 官方建筑）→放置→进度→建成→扣费/人口(foodMade)
- 训练通用化：官方建筑表（步兵/弓箭手/牧师/女巫/迫击炮/狮鹫/飞机）
- 修理、砍树+木、人口官方 foodMade（城镇大厅12+农场6）

### ✅ 渲染
- 真实地形/装饰物/单位模型：**996 glb 模型 99% 带贴图**，0 占位符
- 命令卡 = 上游官方 renderCard（12 格、图标无文字、官方 Buttonpos 落格、冷却/热键）
- 中文化 UI、小地图、资源读数（金/木/人口）

### 🧪 已回归测试
- `card_test.mjs` 7/7 通过（命令卡 12 格布局）
- 已知"失败但不用管"：`icon_test` 4 个 FAIL 是 FOC 专属技能（本图无英雄）；`hud_test`/`topbar_test` 超时是等 FOC 英雄消息（本图无英雄）

---

## 五、服务端 / 端口 / 重启

| 用途 | 端口 | 说明 |
|---|---|---|
| 主服务 | 8080 | 正式对外（Linux 正在跑） |
| 测试服务 | 8077 | tools/*_test.mjs 用 |

**Linux 侧重启**（当前环境新服务已非 systemd managed，直接后台拉）：
```bash
pkill -f "node server/index.js"
cd /mnt/shared/war3/war3web
setsid nohup env PORT=8080 node server/index.js > /tmp/war3web.log 2>&1 < /dev/null &
```

---

## 六、路径后缀现状（转接文档 v1 遗留问题，重新核实）

| 遗留项 | 现在状态 |
|---|---|
| 命令卡图标 | ✅ 已收敛到官方渲染器 + 官方命令表（15 命令真实图标） |
| 技能按钮图标 | ✅ 已接官方关系表（ability_icons.json 687 / commands.json 15），837+ 单位全量覆盖 |
| 数据管线 | ✅ 已入库（be3687a），可按 tools/ 重建 |
| 双人对战 | ⚠️ 未实测（代码支持 slot 0/1，需双端真机验证） |
| 被动技能接攻击引擎 | ⚠️ 未接（狮鹫链锤/防空/飞机炸弹） |
| WebGPU 渲染回主 client | ⚠️ 未合（web/m2/ 是实验栈） |
| APK 打包 | ⚠️ 受阻（Node 权威 server 架构，需 NodeJS-mobile 或连 server） |

---

## 七、给 Windows 接手者的提醒

1. **别自己造轮子**（用户铁律）：游戏逻辑/UI/数据能抄上游官方就抄，数据改动走 `tools/*.py` 管线重生成 JSON，不要手改 `data/*.json`。
2. **资源只能靠共享文件夹**：git 里没有 assets/mpq 等，clone 下来是跑不起来的，必须从共享目录拿全 `war3web/`。
3. **改代码后强制刷新浏览器**（缓存 JS，服务不会自动重载——除非 `npm run dev` 的 --watch）。
4. 需要数据重建时看 Linux 侧工具链（Python3 + numpy/pillow；Windows 上 Win10+ 也能跑 Python 管线，重提取需 mpq 原件在 `mpq/`）。
5. 交接文档 v1 两份：
   - `docs/交接/交接文档.md`（流水帐，每天改了什么，看时间线）
   - `docs/交接/转接文档.md`（v1 问题声明，多数已解决）

---

*本文件由 opencode 于 2026-10-08 依据实测（服务运行/端口/目录/资产数）撰写，内容与 git 状态对齐。*