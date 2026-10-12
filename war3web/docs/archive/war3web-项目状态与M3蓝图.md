# war3web 项目状态与 M3 蓝图（2026-10）

> 项目：war3web——Warcraft 3 浏览器移植（权威 Node 服务器 + 浏览器客户端）。
> 仓库：`Z:\war3`（git 根），remote `git@github.com:chentianxiong123/war3web.git`（SSH over 443）。
> 参考项目在 `Z:\war3\refs\`。

## 一、当前里程碑（已提交推送）

| 阶段 | 内容 | commit |
|---|---|---|
| M0 | 仓库整理：内层仓库删除、外层 `Z:\war3` 统一、4 提交、push | — |
| M1 | WebGPU+WASM 骨架：`zig cc` 编 `core.c`（add/multiply/fib）为裸 wasm，Node/浏览器 5/5 验证 | `31d3a70` |
| M2 | **Emscripten 主线落地**：emcc 编译（MODULARIZE），Node/浏览器双端 Emscripten 模式 5/5 验证，zig 降为保底 | `5dd8b91` |

**当前构建链**：
```
npm run wasm        # tools/build_wasm.mjs：emcc 优先（war3core.mjs+wasm），zig 保底（裸 wasm）
npm run wasm:test   # tools/wasm_test.mjs（Node）+ tools/wasm_browser_test.mjs（无头 Chrome，端口 8078）
```

**关键文件**：
- `wasm/src/core.c`：导出 add/multiply/fib（Emscripten 符号 `_add` 等；裸 wasm exports 无下划线）
- `tools/build_wasm.mjs`：双模式构建（emcc 主线 / zig 保底）
- `tools/wasm_test.mjs`、`wasm/test_page.html`：双模式测试
- `tools/wasm_browser_test.mjs`：MIME 已含 `.mjs`
- `tools/build_wasm.sh` + `wasm/CMakeLists.txt`：Emscripten 时代遗留（可用但已被 .mjs 取代）

## 二、参考项目调研结论（Z:\war3\refs\）

### 1. upstream_tmp（foc-web，本项目上游）
- 技术栈：纯 Node.js（ESM）+ Three.js 0.185 + ws；JASS 用 JS 解释执行（vm.js）
- 构建链路：**零构建**，`node server/index.js` 直接跑

### 2. warsmash-src（Java 模拟器）
- 技术栈：Java + libGDX 1.12.1 + ANTLR 4.7（JASS/FDF 解析器生成）+ Box2D/freetype
- 构建链路：Gradle 多模块（server/desktop/core/shared/fdfparser/jassparser）

### 3. WhiteoutFlakes-src（C++ WASM——M3 蓝图）
- 技术栈：C++20 + CMake + **WebGPU（emdawnwebgpu port）** + Vulkan/Metal；WhiteoutLib（CASC/MPQ 解析）、Wc3Shaders、imgui、glfw、cubeb、tracy
- **wasm 构建链**：**Emscripten 5.0.7** → `emcmake cmake -G Ninja` → `wf_web` target → `wf-core.{js,wasm}` + JS 模块
- 四平台矩阵：windows=MSVC+Vulkan / linux=GCC15+Vulkan / macos=AppleClang+Metal / wasm=Emscripten

**M3 必须记住的细节（WhiteoutFlakes 踩过的坑）**：
1. Emscripten 版本钉 **5.0.7**（不是最新！emdawnwebgpu port 的 API 在 4.0.10→5.0.7 间变过）
2. 用 **`--use-port=emdawnwebgpu`**（Emscripten 官方 WebGPU 后端）
3. wasm 编译参数：`-fno-exceptions -O2(编译)/-Oz(链接) -fno-lto -fno-inline-functions`——**规避 Chrome V8 wasm 编译冻结**（大函数卡 60s+）
4. CASC/MPQ 读盘在 web 版禁用（JS 喂字节流）；embind 绑定关掉（性能）；自定义 `wf_*` C 门面

## 三、下一步方向（M3+ 候选）

1. **M3：C++ 引擎核心起步**——按 WhiteoutFlakes 蓝图：Emscripten 5.0.7 + CMake/Ninja + emdawnwebgpu port，从 map/模型加载或渲染骨架开始
2. **回手账主线**（未竟项）：
   - 双人匹配联机（未经多轮测试）
   - 被动技能未接线（狮鹫连锁闪电/对空/飞机炸弹）
   - WebGPU 渲染器未合并到主客户端
   - APK 打包受阻
   - 接受流卡点：客户端就绪但无对局画面（疑似连接过期）
3. 资产在 gitignore，单 clone 无法跑游戏——部署要考虑资产分发

## 四、环境依赖备忘

- Emscripten 6.0.12：`C:\Users\a1\emsdk\emsdk-main`（emcc 是 exe，不在 PATH；构建脚本已内置绝对路径）
- 代理：`http://192.168.31.204:7897`（Clash Verge；下载 storage.googleapis.com 必用）
- 下载 GitHub 大文件：gh-proxy 前缀按需拼（勿全局配置）
