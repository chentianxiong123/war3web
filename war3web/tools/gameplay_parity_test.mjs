// Shared Warcraft III rules using real engine methods and this map's data.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { World, TYPES } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';

const gp = JSON.parse(fs.readFileSync(new URL('../data/gameplay.json', import.meta.url)));
let checks = 0;
const equal = (a, b, label) => { assert.deepEqual(a, b, label); checks++; };
const near = (a, b, label) => { assert.ok(Math.abs(a - b) < 1e-6, `${label}: ${a} vs ${b}`); checks++; };
function fixture() {
  const w = new World(), eng = new JassEngine(w);
  const u = w.createUnit(eng.players[0], 'H00N', 0, 0, 0);
  const t = w.createUnit(eng.players[5], 'hfoo', 100, 0, 0);
  Object.assign(u, { x: 0, y: 0, controlled: true, missileSpeed: 0 });
  Object.assign(t, { x: 60, y: 0, controlled: true, paused: true,
    hp: 100000, maxHp: 100000, armor: 0, armorTotal: 0, armorType: 'none', hpReg: 0 });
  u.abilities.clear(); t.abilities.clear();
  return { w, eng, u, t };
}
const finish = (w, u) => {
  for (let i = 0; u.attackWindup && i < 300; i++) w.stepAttack(u);
  equal(!!u.attackWindup, false, 'windup finishes');
};
const start = (w, u, t) => { w.order(u, { type: 'attack', target: t }); w.stepAttack(u); };

{
  const { w, eng, u, t } = fixture();
  eng.load();
  const native = n => eng.vm.natives.get(n);
  const at = n => native('ConvertAttackType')(n), dt = n => native('ConvertDamageType')(n);
  t.armorType = 'fort'; t.armorTotal = 10;
  for (const [type, row] of ['spells', 'normal', 'pierce', 'siege', 'magic', 'chaos', 'hero'].entries()) {
    for (const damageType of [4, 8, 26]) {
      const before = t.hp;
      native('UnitDamageTarget')(u, t, 100, true, false, at(type), dt(damageType), null);
      const factor = damageType === 4 ? 1 / (1 + gp.defenseArmor * 10) : 1;
      near(before - t.hp, 100 * gp.damageBonus[row].fort * factor,
        `native enum handles: ${row}, damage type ${damageType}`);
    }
  }
  t.armorType = 'hero';
  near(w.damage(u, t, 100, { spell: true }), 100 * gp.damageBonus.spells.hero,
    'engine spell damage uses map resistance, not numeric armor');
  near(w.damage(u, t, 100), 100 / (1 + gp.defenseArmor * 10), 'weapon damage retains numeric armor');
  near(w.damage(u, t, 100, { raw: true }), 100, 'raw damage remains raw');
  t.invulnerable = true;
  near(w.damage(u, t, 100, { attackType: at(5), damageType: dt(26) }), 0,
    'damage routing does not bypass invulnerability');
}
{
  const { w, u, t } = fixture();
  t.hidden = true;
  u.hp = 100; u.mana = 0;
  for (let i = 0; i < 30; i++) w.step();
  near(u.hp - 100, 2.25, 'map strength regen per second');
  near(u.mana, 2.01, 'map intelligence regen per second');
  u.str += 10; u.intel += 10; w.recalc(u);
  near(u.hpReg, 3.25, 'gained strength affects regeneration');
  near(u.manaReg, 3.01, 'gained intelligence affects regeneration');
  u.items = [{ abilities: ['AImz'] }]; w.recalc(u);
  near(u.manaReg, 3.01, 'extra maximum mana does not multiply regeneration');
  u.items = [{ abilities: ['AIrm'] }]; w.recalc(u);
  near(u.manaReg, 9.03, 'map AIrm +200% multiplies base plus intelligence regeneration');
  u.items = []; w.recalc(u);
  u.hpReg = 0; u.manaReg = 0;
  const hp = u.hp, mana = u.mana; w.step();
  near(u.hp, hp, 'explicit zero HP regeneration'); near(u.mana, mana, 'explicit zero mana regeneration');
  t.mana = 0; t.maxMana = 100; t.manaReg = 2;
  for (let i = 0; i < 30; i++) w.step();
  near(t.mana, 2, 'non-hero mana rate is per second too');
  u.hp = u.maxHp; u.mana = u.maxMana; u.hpReg = 100; u.manaReg = 100;
  w.step(); near(u.hp, u.maxHp, 'HP cap'); near(u.mana, u.maxMana, 'mana cap');
}
{
  const { w, u, t } = fixture(); t.hidden = true;
  const speed = u.moveSpeed, armor = u.armorTotal, damage = u.dmg;
  w.applyBuff(u, { code: 'armor', kind: 'armor', armor: 10, until: 1000 });
  w.applyBuff(u, { code: 'slow', kind: 'slow', pct: 0.5, atkPct: 0.25, until: 100 });
  w.applyBuff(u, { code: 'rage', kind: 'rage', pct: 0.5, until: 100 });
  near(u.moveSpeed, speed / 2, 'slow applied'); near(u.dmg, damage * 1.5, 'rage applied');
  for (let i = 0; i < 6; i++) w.step();
  near(u.moveSpeed, speed, 'slow expires'); near(u.dmg, damage, 'rage expires');
  near(u.attackSpeedMul, 1 + u.agiTotal * gp.agiAttackSpeedBonus, 'attack slow expires');
  near(u.armorTotal, armor + 10, 'longer armor buff survives other expiry');
  for (let i = 0; i < 30; i++) w.step();
  near(u.armorTotal, armor, 'armor expires');
}
{
  const { w, u, t } = fixture();
  equal(TYPES.H00N.attackPoint, 0.3, 'map weapon damage point extracted');
  equal(TYPES.Hpal.attackPoint, 0.433, 'stock weapon damage point inherited');
  const original = Math.random;
  try {
    for (const [rolls, expected] of [[[0, 0], 62], [[0.999999, 0.999999], 72], [[0, 0.999999], 67]]) {
      let i = 0; Math.random = () => rolls[i++] ?? 0.99;
      u.atkTimer = 0;
      const before = t.hp; start(w, u, t);
      near(t.hp, before, 'no damage on attack start');
      finish(w, u);
      near(before - t.hp, expected, 'independent damage dice');
    }
  } finally { Math.random = original; }
}
for (const cancel of ['stop', 'move', 'stun', 'death', 'targetDeath', 'targetLeavesRange']) {
  const { w, u, t } = fixture();
  const hp = t.hp; start(w, u, t);
  if (cancel === 'stop') w.order(u, { type: 'stop' });
  if (cancel === 'move') w.order(u, { type: 'move', x: 300, y: 0 });
  if (cancel === 'stun') w.applyBuff(u, { kind: 'stun', until: 10000 });
  if (cancel === 'death') w.killUnit(u, null);
  if (cancel === 'targetDeath') t.alive = false;
  if (cancel === 'targetLeavesRange') t.x = 2000;
  // Advance just the attack subsystem; Stop may acquire a NEW attack on a later world tick.
  if (u.attackWindup) w.stepAttack(u);
  equal(!!u.attackWindup, false, `${cancel} cancels pending impact`);
  near(t.hp, hp, `${cancel} prevents pending damage`);
}
{
  const { w, eng, u, t } = fixture();
  eng.load(); w.addAbility(u, 'A02F');
  start(w, u, t);
  const hp = t.hp;
  equal(w.castAbility(u, 'A02F', null, u.x + 50, u.y).ok, true, 'valid cast accepted during attack');
  equal(!!u.attackWindup, false, 'casting cancels the pending weapon hit');
  near(t.hp, hp, 'casting did not release the weapon hit');
}
{
  const { w, u, t } = fixture();
  w.fireUnitEvent = name => {
    if (name === 'EVENT_PLAYER_UNIT_ATTACKED') w.order(u, { type: 'stop' });
  };
  start(w, u, t);
  equal(!!u.attackWindup, false, 'ATTACKED trigger can cancel before release');
  near(t.hp, t.maxHp, 'ATTACKED cancellation deals no weapon damage');
}
{
  const { w, u, t } = fixture();
  const point = u.attackPoint, backswing = u.attackBackswing;
  start(w, u, t); w.morph(u, 'O000', 10);
  equal(!!u.attackWindup, false, 'morph cancels old weapon windup');
  near(u.attackPoint, TYPES.O000.attackPoint, 'morph changes damage point');
  w.unmorph(u);
  near(u.attackPoint, point, 'unmorph restores damage point');
  near(u.attackBackswing, backswing, 'unmorph restores backswing');
}
{
  const { w, u, t } = fixture();
  u.missileSpeed = 100; u.weaponKind = 'missile';
  start(w, u, t); equal(w.missiles.length, 0, 'projectile not released at attack start');
  finish(w, u); equal(w.missiles.length, 1, 'projectile released at damage point');
  const cooldown = u.atkTimer;
  w.order(u, { type: 'move', x: 300, y: 0 });
  equal(w.missiles.length, 1, 'moving after release keeps projectile');
  near(u.atkTimer, cooldown, 'moving after release preserves attack cooldown');
  const hp = t.hp;
  for (let i = 0; i < 60; i++) w.stepMissiles();
  equal(t.hp < hp, true, 'released projectile still hits');
}
{
  const { w, u, t } = fixture();
  start(w, u, t); const normalPoint = u.attackWindup.remaining;
  w.order(u, { type: 'stop' }); u.attackSpeedMul *= 2;
  start(w, u, t); near(u.attackWindup.remaining, normalPoint / 2, 'attack speed scales windup');
  finish(w, u); const hp = t.hp;
  w.stepAttack(u); near(t.hp, hp, 'no extra hit during recovery');
  equal(!!u.attackWindup, false, 'cooldown prevents another swing');
}
{
  const { w, u, t } = fixture();
  w.order(u, { type: 'stop' });
  let attacks = [];
  for (let i = 0; i < 60; i++) attacks.push(...w.step());
  equal(attacks.some(e => e.t === 'attack' && e.id === u.id), true, 'Stop permits auto-attack');
  t.x = u.x + 300; w.order(u, { type: 'hold' });
  const pos = [u.x, u.y];
  for (let i = 0; i < 30; i++) w.step();
  equal([u.x, u.y], pos, 'Hold does not chase an out-of-range enemy');
  w.order(u, { type: 'move', x: 1000, y: 0 });
  w.stepAI(u); equal(u.order.type, 'move', 'Move is not replaced by acquisition');
  u.path = [[u.x + 1, u.y]]; w.stepMove(u); w.stepAI(u);
  equal(u.order.targetId, t.id, 'finishing Move restores target acquisition');
  u.x = 4000; u.y = 0; t.x = 4060; t.y = 0;
  w.order(u, { type: 'stop' }); w.tick++; w.stepAI(u);
  equal(u.order.targetId, t.id, 'player hero can acquire far from its spawn');
  equal(!!u.returning, false, 'player hero does not inherit guard leash');
  t.isBuilding = true; w.order(u, { type: 'stop' }); w.stepAI(u);
  equal(u.order.targetId, t.id, 'idle hero can acquire enemy buildings');
}
console.log(`${checks}/${checks} checks passed`);
