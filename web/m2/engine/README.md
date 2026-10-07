# 浏览器化 WC3 引擎 (来自 foc-web, 逻辑零改动)

来源: /mnt/shared/war3/foc-web/server/ (第三方 foc-web 项目, 纯 JS 引擎)
浏览器化改造 (只动 import 和路径, 逻辑未改):
- env.js        ← 我们写的: 模拟 Node fs/path, 同步读 window.__DATA 缓存
- bridge.js     ← 我们写的: 数据加载 + boot + tick 驱动
- 其余文件      ← foc-web 源码, import 'node:fs/path' 改 './env.js',
                  import.meta.dirname 改 'engine' (文件位于 foc-web 根下 engine/)

数据文件清单 (bootEngine 从 ./focdata/ 预加载):
  data/unittypes.json, itemtypes, game, soundsets, buffart, gameplay, abilities
  public/data/terrain.json, walk.bin, fly.bin, flydestructables, destructables, heights.bin
  extracted/war3map.wts, war3map.j
  war3_extracted/Scripts/common.j, Blizzard.j

运行: index.html 渲染完成后 -> bootEngine(log) -> startTick(world, eng, log)
验证: "引擎启动 15ms: 60 triggers, 3 timers, 101 单位, 0 errors" (TerenasStand)
