import assert from 'node:assert/strict';
import { World, TYPES } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';
let checks = 0;
const eq = (a, b, label) => { assert.deepEqual(a, b, label); checks++; };
const near = (a, b, label) => { assert.ok(Math.abs(a - b) < 1e-6, `${label}: ${a} vs ${b}`); checks++; };
function fixture(type = 'hfoo', victim = 'ugar') {
  const w = new World(), eng = new JassEngine(w);
  const u = w.createUnit(eng.players[0], type, 0, 0, 0);
  const t = w.createUnit(eng.players[5], victim, 80, 0, 0);
  Object.assign(u, { x: 0, y: 0, controlled: true });
  Object.assign(t, { x: 80, y: 0, paused: true, hp: 10000, maxHp: 10000, armorTotal: 0, armorType: 'none' });
  u.abilities.clear(); t.abilities.clear();
  return { w, eng, u, t };
}
function finish(w, u) {
  for (let n = 0; u.attackWindup && n < 300; n++) w.stepAttack(u);
  eq(!!u.attackWindup, false, 'windup finishes');
}
{
  const { w, u, t } = fixture();
  const prior = u.order;
  eq(w.weaponFor(u, t), null, 'footman cannot attack air');
  eq(w.order(u, { type: 'attack', target: t }), false, 'explicit air attack rejected');
  eq(u.order, prior, 'rejection keeps old order');
  w.stepAI(u); eq(u.order.type, 'idle', 'idle does not acquire air');
  u.order = { type: 'attackMove', x: 500, y: 0 }; w.stepMove(u);
  eq(u.order.targetId, undefined, 'attack-move skips air');
  u.order = { type: 'patrol', x: 500, y: 0, fromX: 0, fromY: 0 }; w.stepMove(u);
  eq(u.order.targetId, undefined, 'patrol skips air');
  u.order = { type: 'hold' }; w.stepAttack(u);
  eq(!!u.attackWindup, false, 'hold skips air');
  t.targetAs = 'ground'; t.movementType = 'foot'; t.flyHeight = 240;
  eq(w.weaponFor(u, t)?.bit, 1, 'visual height does not prevent ground attacks');
}
{
  const { w, u, t } = fixture('ugar', 'hfoo');
  const weapon = w.weaponFor(u, t);
  eq(weapon.bit, 2, 'gargoyle selects ground weapon');
  eq(weapon.atkRange, 300, 'secondary range');
  eq(weapon.atkType, 'pierce', 'secondary attack type');
  eq(weapon.missileSpeed, 900, 'secondary missile inherited');
  u.weapon2.dmgDice = 0; u.dmg = u.dmgBase + 5;
  w.order(u, { type: 'attack', target: t }); w.stepAttack(u);
  near(u.attackWindup.remaining, 0.633, 'secondary damage point');
  near(u.atkTimer, 2.2, 'secondary cooldown');
  finish(w, u);
  eq(w.missiles.length, 1, 'ground attack launches missile');
  eq(t.hp, 10000, 'ground damage waits for impact');
  const options = [];
  const damage = w.damage.bind(w);
  w.damage = (a, b, amount, opts) => { options.push(opts.attackType); return damage(a, b, amount, opts); };
  for (let n = 0; w.missiles.length && n < 300; n++) w.stepMissiles();
  eq(options, [2], 'impact uses pierce attack type');
  eq(t.hp, 9967, 'secondary base damage plus common bonus');
  eq(u.dmgBase, 60, 'selection preserves primary base');
  t.targetAs = 'air'; t.movementType = 'fly';
  u.atkTimer = 0; u.dmgDice = 0;
  w.stepAttack(u);
  near(u.attackWindup.remaining, 0.33, 'air damage point');
  near(u.atkTimer, 1.4, 'air cooldown');
  finish(w, u);
  eq(w.missiles.length, 0, 'air weapon is melee despite inherited missile art');
  eq(t.hp, 9902, 'air weapon uses primary damage');
  u.attacksEnabled = 2;
  eq(w.weaponFor(u, t), null, 'weapon enable mask excludes primary');
  t.targetAs = 'ground';
  eq(w.weaponFor(u, t)?.bit, 2, 'weapon enable mask retains secondary');
  u.attacksEnabled = 1;
  eq(w.weaponFor(u, t), null, 'weapon enable mask excludes secondary');
}
{
  const { w, u, t } = fixture('ugar', 'hfoo');
  w.order(u, { type: 'attack', target: t }); w.stepAttack(u);
  t.targetAs = 'air'; w.stepAttack(u);
  eq(!!u.attackWindup, false, 'target changes weapon category before release');
  eq(w.missiles.length, 0, 'cancelled ground swing releases no missile');
  eq(t.hp, 10000, 'cancelled swing deals no damage');
  const second = u.weapon2;
  w.morph(u, 'hfoo', 10);
  eq(u.atkTargetsAllowed, TYPES.hfoo.atkTargetsAllowed, 'morph updates primary targets');
  eq(w.weaponFor(u, t), null, 'morphed footman cannot attack air');
  w.unmorph(u);
  eq(u.weapon2, second, 'unmorph restores secondary weapon');
  eq(w.weaponFor(u, t)?.bit, 1, 'unmorph restores air attack');
}
{
  const { w, u, t } = fixture('ugar', 'hfoo');
  t.x = 250;
  w.order(u, { type: 'attack', target: t }); w.stepMove(u);
  eq(u.path, null, 'secondary range stops pursuit before primary melee range');
  const before = u.x; w.stepMove(u);
  eq(u.x, before, 'secondary ranged attacker holds its position');
  w.stepAttack(u);
  eq(u.attackWindup?.weapon.bit, 2, 'secondary attack starts at ranged distance');
}
{
  const { w, u, t } = fixture('hmtm', 'hfoo');
  eq(u.attacksEnabled, 0, 'map disables mortar weapons');
  u.attacksEnabled = 3; // Exercise inherited weapons independently of the map's disable override.
  t.isBuilding = true; t.targetAs = 'structure';
  eq(w.weaponFor(u, t)?.bit, 2, 'mortar uses separate structure weapon');
  t.isBuilding = false; t.targetAs = 'ground';
  eq(w.weaponFor(u, t)?.bit, 1, 'mortar uses ground artillery weapon');
}
console.log(`${checks} weapon targeting checks passed`);
