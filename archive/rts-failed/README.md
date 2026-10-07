# 失败案例归档：自写 RTS 逻辑（2026-10-07 废弃）

## 现场
- `index.html.rts-自写废案.html`（605 行）——渲染 + 自写游戏逻辑 + UI 混一文件
- 自写内容：简化移动/战斗/采矿/造兵/胜负（tickGame/train/makeUnit 等）
- 状态：**废弃，不再维护**

## 为什么废（用户判定）
1. **自写全部游戏逻辑 = 费劲费力做出来还不好**：野怪 hp/攻击/护甲全是拍脑袋的
   假数字，规则不真（不是 WC3 的真实数值）
2. **代码组织混乱**：渲染 + 逻辑 + UI 三层混在一个 index.html，导致深陷无头
   浏览器逐行调试的泥潭
3. **违背用户铁律**："别自己造轮子，学别人的"——foc-web 有现成引擎

## 教训
- 游戏逻辑**永远不要自己写**——用现成引擎（foc-web 的 world.js + JASS VM）
- 规则必须来自游戏数据（unittypes.json 837 单位真实数值），不是自定义假数字
- 程序结构要分层：渲染壳 / 游戏逻辑 / UI 分开文件

## 正确路线（已拍板）
- 逻辑：foc-web `server/world.js`(144K) + `server/jass/engine.js`(80K JASS VM)
  ——纯 JS 可搬浏览器，Node 依赖只有数据加载（改 fetch）
- 渲染：我们的 WebGPU 壳（foc-web 是 WebGL，我们的 WebGPU 是独有技术点）
- 技术点：WASM 读图（蹭 WASM）+ WebGPU 渲染（蹭 WebGPU）
- 详见 `交接文档.md` M3b 复盘
