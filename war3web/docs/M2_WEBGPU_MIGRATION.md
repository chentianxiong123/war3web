# M2 迁移要点：WebGLRenderer → WebGPURenderer（调研笔记）

> roadmap: docs/WEBGPU_WASM_PLAN.md §4 M2「渲染迁 WebGPU」。
> 结论先行：**M2 与 WASM 逻辑并行、互不阻塞**；本项目只需替换 one renderer +
> 处理少量 API 差异，即可跑通 WebGPU 主场景，并用 `fps_test/render_test`
> 对比迁移前后性能基线（迁移后不倒退为门禁）。

## 1. 现状盘点（web 客户端渲染侧）

| 文件 | 职责 | 关键 three.js API |
|---|---|---|
| `client/js/render.js` | 主渲染器/场景/相机/地形/实体 Mesh | `WebGLRenderer`、`Scene/Fog/Color`、`PerspectiveCamera`、`HemisphereLight/DirectionalLight`、`MeshLambertMaterial`（aggressive 使用）、`MeshBasicMaterial`（透明/文字/剪影）、`TextureLoader`、`BufferGeometry`、`Frustum/Matrix4/Sphere` |
| `client/js/particles.js` | 粒子系统 | 自绘 `ShaderMaterial` + buffer 属性（非 Points 类） |
| `client/js/overlay.js` | 地面箭头/装饰 | `MeshBasicMaterial` 透明 |
| `client/js/main.js` | 入口 | 初始化 render + 输入 + 网络 + 循环 |

render.js 具体使用点：
- `renderer.setPixelRatio(min(devicePixelRatio, 2))`；`outputColorSpace = SRGBColorSpace`（已设 ✓）
- `shadowMap.enabled = false`（阴影关闭 ✓，WebGPU 下无阴影路径负担）
- 每帧 `renderer.render(scene, camera)`（无 setAnimationLoop，自驱 rAF）
- 纹理 `anisotropy = renderer.capabilities.getMaxAnisotropy()`（**WebGPU 下无此 API → 迁移差异点**）

## 2. WebGPURenderer 官方要点（three.js r185+，2025-10 更新）

- **构造**：`new THREE.WebGPURenderer({ antialias: true, ... })`；
  **必须 `await renderer.init()`**（异步初始化，与 WebGL 同步创建不同）
- **回退**：默认 WebGPU，浏览器不支持时**自动回退 WebGL2**；`forceWebGL: true` 可强制
- **输出**：`outputColorSpace = SRGBColorSpace` 同样适用；
  `outputBufferType` 默认 `HalfFloatType`（与 WebGL 的默认差异注意）
- **材质**：老式 `MeshLambertMaterial/MeshBasicMaterial` 在 WebGPU 后端经
  compatibility 路径渲染（基本可用）；新能力（compute/TSL 节点）才需要
  `MeshStandardNodeMaterial` + three/tsl
- **纹理**：`Texture.colorSpace` 必须 `SRGBColorSpace`（video 类纹理尤其）
- **TSL**：新着色器用 `three/tsl`（`color/positionLocal/sin/time` 节点），
  粒子等自定义 ShaderMaterial → 建议迁 TSL（webgpu 后端 GLSL 支持有限）
- **importmap**：WebGPU 需要 `three.webgpu.js` 构建（非默认的 three.min.js）

## 3. 本项目迁移差异点清单（试点时逐个处理）

1. `renderer.init()` 异步等待（改 main.js 启动流程）
2. `capabilities.getMaxAnisotropy()` → WebGPU 无；改固定值或 feature 探测
3. 粒子 `ShaderMaterial` → 评估：保留 compatibility 或转 TSL（试点先保留，
   性能对比后决定）
4. `MeshLambertMaterial` 全兼容路径验证（地形/单位主体，数量大，性能敏感）
5. 阴影已关、SRGB 已设——无额外成本
6. `renderer.setPixelRatio` WebGPU 支持（多倍率注意 devicePixelRatio 上限）

## 4. 分步试点计划（M2）

1. **步骤 A（已完成 35fb526）**：`renderer` 构造切换 + `init()` 异步化 + 通道开关
   （`localStorage.webgpu=1` 切 WebGPURenderer，默认仍 WebGL 保底）+
   anisotropy 兼容 fallback（WebGPU 无 capabilities.getMaxAnisotropy → 固定 8）
2. **步骤 B（待做）**：跑通主场景（地形+单位+粒子），记录 `fps_test`、`render_test`
   基线（WebGL vs WebGPU 双跑存档）
3. **步骤 C**：性能敏感点（Lambert 材质批量/粒子 buffer）换 TSL 试点，
   对比后再推广
4. **步骤 D**：移除 WebGL 渲染器开关（或长期保留 `forceWebGL` 回退，
   随 `render_test` 全绿决定）

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| WebGPU 浏览器覆盖不足 | `WebGPURenderer` 自动回退 WebGL2；或保留开关 |
| 材质兼容路径性能差异 | fps_test 对比基线，必要时转 TSL |
| 粒子 ShaderMaterial 不兼容 | 粒子先保留 WebGL 渲染路径或 TSL 重写（试点对比） |
| 纹理 colorSpace 异常（偏灰/偏暗） | 统一 `texture.colorSpace = SRGBColorSpace` |

## 6. 验证命令

```bash
npm run engine:test        # 引擎回归（与渲染无关，保底）
tools/fps_test.mjs         # 性能基线（迁移前后对比存档）
tools/render_test.mjs      # 渲染正确性
```

> 关联：M3（JASS VM 进 WASM，C 引擎）已基本完成（114/114 全绿 + 880 全局 +
> 18 数组双对账零差异），与 M2 并行推进无冲突。