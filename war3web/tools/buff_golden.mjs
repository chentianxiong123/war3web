// tools/buff_golden.mjs — M4 phase4 收尾增量 4：vampiric/regen/stun buff 效果黄金
//
// 三个简化场景，用 JS world.js 的 w.applyBuff 记录 buff 状态 + 单位行为：
//   vampiric — 攻击者有 vampiric buff，看回血（JS 不实现 vampiric-buff→lifesteal，
//              所以 vampiric 段记录的是 buff 状态 + 攻击事件时序；C 侧用 sim_apply_buff
//              驱动并直接断言回血量 = dmg*pct）。
//   regen    — 英雄单位有 regen buff，看 hp 恢复（JS 实现 u.hpReg += b.regen，
//              但 recalc 只在 isHero 时处理 buff，所以用 Hamg 英雄）。
//   stun     — 单位有 stun buff，看不动（JS 实现 stunned → 跳过 stepMove；
//              注意 stunned 只认 until>now，永久 buff 不生效，所以用 until=now+60000）。
// 输出 goldens/buff_trace.json。
//
// 用法：node tools/buff_golden.mjs

import { World } from '../server/world.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'goldens', 'buff_trace.json');
const DT = 1 / 30;

// ---- 通用 World 设置（最小 player 表 + eventId null 让 JASS 事件桥早退） ----
function makeWorld() {
  const w = new World();
  w.jass = {
    players: Array.from({ length: 12 }, (_, i) => ({ index: i, team: i >= 1 ? 1 : 0, gold: 0, lumber: 0 })),
    eventId: () => null, fire: () => {}, triggers: [],
  };
  return w;
}

// ---- 场景 1: vampiric（吸血）----
// 两个 hfoo 贴身对打，攻击者(u0) 有 vampiric buff（pct 0.5）。
// JS 的 vampiric buff 不接入 lifesteal（abilities.js AURA_BASES 有定义，
// 但 auraEffects 无 vampiric family、recalc 也不读 b.pct 进 lifesteal），
// 所以 JS 侧攻击者不会因 buff 回血。C 侧需在 sim_damage 里加：
//   if (src 有 SIM_BUF_VAMPIRIC buff) heal(src, dmg * pct)。
// golden 记录：buff 状态 + 攻击事件 + HP 曲线，供 C 测试确认攻击时序一致；
// vampiric 效果值 C 侧直接断言（expected = dmg * pct per hit）。
const vampiricScene = (() => {
  const w = makeWorld();
  const p0 = { index: 0, team: 0 };
  const p1 = { index: 1, team: 1 };
  // hfoo: hp 420, atkCd 1.35, dmgBase 11, dmgDice 1, dmgSides 2, atkRange 90
  const a = w.createUnit(p0, 'hfoo', 1300, 1100, 0);   // 攻击者（有 vampiric）
  const t = w.createUnit(p1, 'hfoo', 1400, 1100, 180);  // 目标
  // 初始 hp 拉低到 50，方便观察回血
  a.hp = 50; a.maxHp = 420;
  t.hp = 420; t.maxHp = 420;
  // 施加 vampiric buff：kind 'vampiric', pct 0.5，永久（until=0）
  w.applyBuff(a, { kind: 'vampiric', pct: 0.5, code: -1, until: 0 });
  const ticks = 900;   // 30s @30fps
  const atkEvents = [];
  const hpSamples = [];
  for (let ti = 0; ti < ticks; ti++) {
    const evs = w.step();
    for (const e of evs) if (e.t === 'attack') atkEvents.push([ti, e.id, e.target]);
    if (ti % 30 === 0) hpSamples.push([ti, Math.round(a.hp), Math.round(t.hp)]);
    if (!a.alive && !t.alive) break;
  }
  return {
    name: 'vampiric',
    note: 'JS 不实现 vampiric-buff→lifesteal；C 侧在 sim_damage 加 src buff 检查',
    pct: 0.5,
    ticks,
    a: { hp0: 50, maxHp: 420 },
    t: { hp0: 420, maxHp: 420 },
    atkEvents: atkEvents.slice(0, 60),
    nAtk: atkEvents.length,
    hpSamples,
    aFinalHp: Math.round(a.hp),
    tFinalHp: Math.round(t.hp),
  };
})();

// ---- 场景 2: regen（生命回复）----
// 英雄单位 u0 有 regen buff（regen: 5 hp/s），初始 hp=100/maxHp。
// JS: recalc 里 u.hpReg += b.regen（仅 isHero），step 里 u.hp += u.hpReg * dt。
// C: sim_step 里对有 SIM_BUF_REGEN buff 的单位，hp += flat * dt。
const regenScene = (() => {
  const w = makeWorld();
  const p0 = { index: 0, team: 0 };
  // 用英雄 Hamg（hpReg 0.25 基础，recalc 处理 buff）
  const u = w.createUnit(p0, 'Hamg', 1300, 1100, 0);
  u.hp = 100;
  // 清零基础回复，只靠 buff
  u.hpReg = 0;
  // 施加 regen buff：kind 'regen', regen 5，until=now+60000（10s 后过期不影响 300 tick）
  w.applyBuff(u, { kind: 'regen', regen: 5, code: -1, until: w.now + 60000 });
  const effectiveHpReg = u.hpReg;   // 英雄 recalc 含基础回复 + buff 加成
  const ticks = 300;   // 10s @30fps
  const hpSamples = [];
  for (let ti = 0; ti < ticks; ti++) {
    w.step();
    if (ti % 30 === 0) hpSamples.push([ti, Math.round(u.hp)]);
    if (u.hp >= u.maxHp) break;
  }
  return {
    name: 'regen',
    typeKey: 'Hamg',
    regen: 5,
    effectiveHpReg,   // 英雄基础回复 + buff 加成（C 测试用此值作 flat）
    ticks,
    hp0: 100,
    maxHp: Math.round(u.maxHp),
    hpSamples,
    hpFinal: Math.round(u.hp),
    dt: DT,
  };
})();

// ---- 场景 3: stun（定身）----
// 单位 u0 有 stun buff，给移动命令后跑 N tick，位置不应变。
// JS: stunned(u) → 跳过 stepMove，但 stepAttack 仍执行。
// 注意：JS 的 stunned 只认 until>now，永久 buff (until=0) 不生效，所以用 until=now+60000。
// C: step_move_unit 里检查 SIM_BUF_STUN，有则 return。
const stunScene = (() => {
  const w = makeWorld();
  const p0 = { index: 0, team: 0 };
  const u = w.createUnit(p0, 'hfoo', 1300, 1100, 0);
  // 给移动命令（目标在走通格内）
  w.order(u, { type: 'move', x: 1700, y: 1100 });
  w.step();   // 一 tick 让 path 生成
  const posBefore = [Math.round(u.x), Math.round(u.y)];
  // 施加 stun buff（until=now+60000，10s 内有效）
  w.applyBuff(u, { kind: 'stun', code: -1, until: w.now + 60000 });
  const ticks = 300;
  const posSamples = [];
  for (let ti = 0; ti < ticks; ti++) {
    w.step();
    if (ti % 30 === 0) posSamples.push([ti, Math.round(u.x), Math.round(u.y)]);
  }
  return {
    name: 'stun',
    ticks,
    posBefore,
    posSamples,
    posFinal: [Math.round(u.x), Math.round(u.y)],
    stunned: true,
  };
})();

const out = {
  world: 'terenas', dt: DT,
  vampiric: vampiricScene,
  regen: regenScene,
  stun: stunScene,
};
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log('buff golden 已存档:', OUT);
console.log('vampiric: 攻击', vampiricScene.nAtk, '次, 攻击者 hp', vampiricScene.aFinalHp, '(初始 50, JS 不回血)');
console.log('regen: hp', regenScene.hp0, '→', regenScene.hpFinal, '(每 tick +', (5 * DT).toFixed(3), ')');
console.log('stun: pos', JSON.stringify(stunScene.posBefore), '→', JSON.stringify(stunScene.posFinal), '(应不动)');
