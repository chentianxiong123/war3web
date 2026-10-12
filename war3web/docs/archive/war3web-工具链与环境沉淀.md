# war3web 工具链与环境沉淀（2026-10 实战记录）

> 这份文档沉淀了本轮"装齐开发工具链 + 打通 Emscripten 主线"的全部经验：
> 环境清单、Emscripten 安装攻略（含代理方法）、国内镜像速查、踩坑与解法。

## 一、当前开发环境清单

| 工具 | 版本 | 位置 | PATH |
|---|---|---|---|
| node | 24.19.0 | `C:\Program Files\nodejs` | ✅ |
| python | 3.14.7 | `C:\Users\a1\AppData\Local\Programs\Python\Python314` | ✅ |
| **zig** | 0.13.0 | `C:\Users\a1\zig\zig-windows-x86_64-0.13.0\zig.exe` | 用户 PATH ✅（万能 C 交叉编译器） |
| **rust** | 1.99.0 (rustc/cargo) | `C:\Users\a1\.cargo\bin`（rustup 在 `.rustup`） | 用户 PATH ✅ |
| **gcc** | 16.2.0 (mingw-w64) | `C:\Users\a1\w64devkit\w64devkit\bin` | 用户 PATH ✅（rust 的 gnu 链接器） |
| **cmake** | 4.4.4 | Python Scripts（pip 装的 wheel） | 用户 PATH ✅ |
| **ninja** | 1.9.0 | Python Scripts（pip 装的 wheel） | 用户 PATH ✅ |
| **Emscripten** | 6.0.12 | `C:\Users\a1\emsdk\emsdk-main`（2GB：LLVM 1.8G + node + python） | 未加 PATH，用绝对路径或 `emsdk_env` |
| git | — | — | ✅ gh CLI 已登录（chentianxiong123） |
| scoop | — | 真身 `C:\Users\a1\scoop\bin\scoop.ps1`；shim 是 bash 脚本（见踩坑） | — |

**rust 配置**（`C:\Users\a1\.cargo\config.toml`）：
- crates.io 走 rsproxy 国内源（sparse）
- gnu 工具链链接器 = w64devkit gcc（无需 VS Build Tools）

## 二、Emscripten 安装攻略（核心经验）

**问题根源**：wasm-binaries.zip（新版约 700MB）托管在 `storage.googleapis.com`，这台机器直连被限速（0.04~0.1 MB/s 且断流），国内镜像全部没有 Windows 版，WSL1 跑不了 node。

**解法：Clash 代理**。别处一台设备跑 Clash（Verge），本机用它的 HTTP 代理端口：
```
代理: http://192.168.31.204:7897   (Clash Verge 默认 7897；Clash for Windows 默认 7890)
```

安装步骤（Windows 原生）：
```
1. 下载 emsdk（走 gh-proxy 前缀，秒下）:
   curl -L -o emsdk.zip "https://gh-proxy.com/https://github.com/emscripten-core/emsdk/archive/refs/heads/main.zip"
   解压到 C:\Users\a1\emsdk\emsdk-main

2. 设代理环境变量并安装（关键！emsdk 的 python 下载器读这些变量）:
   $env:HTTP_PROXY='http://192.168.31.204:7897'
   $env:HTTPS_PROXY='http://192.168.31.204:7897'
   $env:ALL_PROXY='http://192.168.31.204:7897'
   emsdk.bat install latest      # 下载 node + python + wasm-binaries(700MB)，代理下几分钟完成

3. 激活:
   emsdk.bat activate latest

4. 验证（新版 emcc 是原生 exe，不是 .bat）:
   C:\Users\a1\emsdk\emsdk-main\upstream\emscripten\emcc.exe --version
```

**编译命令（本项目 core.c，MODULARIZE 导出）**：
```powershell
emcc.exe wasm/src/core.c -O2 --no-entry -sEXPORTED_FUNCTIONS=_add,_multiply,_fib `
  -sMODULARIZE -sEXPORT_NAME=createWar3Core -sENVIRONMENT=node,web -o wasm/out/war3core.mjs
```
产出 `war3core.mjs`（默认导出 createWar3Core）+ `war3core.wasm`。

**两个关键事实（验证过）**：
1. emcc 的 wasm **可被裸 `WebAssembly.instantiate` 加载**（纯计算函数无 runtime imports），导出名**不带下划线**（`add` 而非 `_add`）
2. JS 层 Module API 用 `_add`（Node 端）；裸 wasm exports 用 `add`（浏览器回退端）——测试要双模式兼容

## 三、国内镜像速查表（这台机器实测）

| 用途 | 地址 | 状态 |
|---|---|---|
| crates.io（rust） | `sparse+https://rsproxy.cn/index/`（字节跳动） | ✅ 快 |
| rustup 工具链 | `RUSTUP_DIST_SERVER=https://rsproxy.cn` | ✅ 快 |
| PyPI（pip） | `https://mirrors.aliyun.com/pypi/simple/` | ✅ 快 |
| GitHub 文件加速 | 临时 URL 前缀 `https://gh-proxy.com/<原URL>` | ✅ 快（**只按需拼，勿写全局配置**） |
| GitHub API | gh CLI（已登录）或 api.github.com | 时好时坏 |
| emsdk/LLVM 官方 | `storage.googleapis.com`（被限速） | ❌ 直连死，走代理 |
| TUNA/USTC/aliyun msys2、TUNA archlinux、华为云 SWR | — | ❌ 403/404/空响应（本机实测） |
| Emscripten 国内镜像（Windows 版） | — | ❌ 全部不存在 |

## 四、关键踩坑与解法

1. **pip 全局配置 `proxy=https://gh-proxy.com` 是坏的**（gh-proxy 是 URL 前缀服务，不是 HTTP 代理；pip 把它当代理用 → 隧道 400）。已删（`pip config unset global.proxy`）。**教训：gh-proxy 只能给 git/URL 用，不能当通用代理**。
2. **scoop shim**（`C:\Users\a1\.local\bin\scoop`）是 `#!/bin/bash` 脚本——pwsh 里直接调会报 "Cannot run a document in the middle of a pipeline"。**正确用法：`& 'C:\Users\a1\scoop\bin\scoop.ps1' <cmd>`**。
3. **TOML 路径转义**：cargo config 的 linker 路径用单引号字面串（`linker = 'C:\...'`），双反斜杠或四反斜杠都会写坏路径。
4. **rust gnu 链接器**：w64devkit 没有 `libgcc_eh.a`，rust 链接报 `cannot find -lgcc_eh`。解法：复制 `libgcc.a` → `libgcc_eh.a` 到 `w64devkit\lib\gcc\x86_64-w64-mingw32\16.2.0\`。
5. **rust msvc 工具链**需要 `link.exe`（VS Build Tools 未装）→ 编译失败。解法：**用 gnu 工具链 + mingw gcc**（`rustup toolchain install stable-x86_64-pc-windows-gnu`）。
6. **zig 当 rust 链接器失败**（`/NOLOGO`、`--disable-auto-image-base` 参数不兼容）——不如真 gcc。
7. **WSL1 无法运行任何 node**（apt node 12.22 也 Exec format error）——WSL 路线死，Windows 原生是正解。
8. **WSL2 代价**：默认装在 C 盘（本机是机械盘）= VHDX IO 灾难；SSD 被其他项目占用，未采用。
9. **浏览器静态服务器 MIME**：`.mjs` 必须给 `text/javascript`，否则浏览器拒绝执行模块（回退到裸 wasm）。
10. **下载通道顺序经验**：直连慢/断 → **gh-proxy 前缀**（快）→ gh CLI（时好时坏）。判断成功以文件大小 >0 为准，0 字节残留要删。

## 五、github-download skill（已写，下个会话生效）

位置：`C:\Users\a1\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai\dsh-sandbox-windows-acl\assets\github-download\SKILL.md`

设计：按需下载 GitHub 资源，三通道（直连 → gh-proxy 前缀 → gh CLI），**绝不改全局配置**。注意：skill catalog 在会话启动时加载，新开会话才可见；放在 npm 包 assets 里，dsh 升级可能覆盖，长期要固化成独立 skill 包。
