# foc-web 热修复脚本归档 (2026-10-07/08)
> foc-web/ 代码改动被 .gitignore 拦(不进 git), 这些脚本是"每次改动的可复现记录"。
> 全部已执行生效, 数据/代码改动已落地 foc-web (data/*.json, public/, client/, server/, tools/)。保留仅做交接回溯。

## 编码/乱码 (数据管线)
- fix_encoding.py   latin-1→utf-8 还原修复脚本(内联版逻辑, 治标)
- fix_manual.py     手工映射 15 个缺尾字节乱码字段(勇气勋章/重生十字章等, game.json/itemtypes.json)
- patch5.py         补充修复(物品/技能名)
- 治本: tools/slk.py 两处读改 encoding='utf-8' (中文版 slk/UnitFunc.txt 实际是 UTF-8)

## UI 中文化
- patch_cn.py       index.html 10处 + main.js 2处 + hud.js 2处 + ui.js 5处 (加入红方/蓝方/准备/你的名字等; 剩 1 处 gameover 文本聚合模式未匹配)

## 引擎接线 (server/world.js room.js shared/const.js)
- patch_room.py     room start 去 heroId, slot 0-1, buyHero 跳过
- patch_gather.py   stepGathers 采矿经济(农民挖矿→交金)
- patch_spot.py     walkSpotNear 可走点探测(寻路空路径卡死修复)
- patch_train.py    训练队列 stepTraining + TRAIN 表
- patch_ui_btn.py   TRAIN_BUTTONS 移到 ui.js 顶部(模块访问修复)
- patch_sel.py      (点选相关)
- patch_view.py     window.__view 诊断
- patch2/3/4.py     早期补丁(诊断/中间态)

## 渲染/小地图
- patch_mm.py       #minimap 容器固定尺寸 248x150 (console slots 空导致 0 尺寸黑屏)
- del_diag.py       SetUnitOwner 诊断日志清理

## 其他
- 白模根因: textures.json 索引不全(844→1861) → mdx2gltf --force 全量重转(2026-10-08, 无脚本文件, 命令直接执行)
