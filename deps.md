# War3 项目依赖 (原 /home/a1/war3_demo/node_modules)

工具链:
- three 0.186.1  (WebGPU 渲染, 需 npm install three@0.186.1)
- mdx-m3-viewer 5.12.0  (MDX/BLP 解析参考, npm install mdx-m3-viewer)
- smpq 1.6  (MPQ 解包, apt install smpq)
- emscripten 3.1.69  (C→WASM, apt install emscripten)
- StormLib 源码: wasm/StormLib-src/  (C MPQ 库, 已编译 wasm/libstorm_wasm.a)

原项目位置已删除, 需要时按此重建:
- 服务器: scripts/server.js (http 服务)
- BLP 解码: scripts/blp2png.js, blp2png2.js
- 渲染 demo 骨架: three WebGPURenderer (r186)
