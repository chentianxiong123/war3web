import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';
import { entry } from '../server/abilities.js';
const key = s => [...s].reduce((n, c) => (n * 256 + c.charCodeAt(0)) >>> 0, 0);
let checks = 0;
const check = (value, expected, label) => { assert.deepEqual(value, expected, label); checks++; };
function fixture() {
  const w = new World(), e = new JassEngine(w);
  const u = w.createUnit(e.players[0], 'H00N', 0, 0, 0);
  const t = w.createUnit(e.players[5], 'hfoo', 80, 0, 0);
  Object.assign(u, { x: 0, y: 0, mana: 500, castPoint: 0.3 });
  Object.assign(t, { x: 80, y: 0, paused: true });
  u.abilities.set(key('AHtb'), 1);
  u.abilities.set(key('A011'), 1);
  return { w, e, u, t };
}
check(entry('AHtb').targets, 'air,ground,debris,enemy,neutral,organic', 'stock SLK filter retained');
for (const [label, mutate] of [
  ['ally', (t, u) => { t.playerIndex = u.playerIndex; }],
  ['hidden', t => { t.hidden = true; }],
  ['invulnerable', t => { t.invulnerable = true; }],
  ['dead', t => { t.alive = false; }],
  ['mechanical', t => { t.classifications = 'mechanical'; }],
  ['structure', t => { t.targetAs = 'structure'; t.isBuilding = true; }],
]) {
  const { w, u, t } = fixture(); mutate(t, u);
  const prior = u.order;
  check(w.castAbility(u, 'AHtb', t).ok, false, `${label} rejected`);
  check(u.mana, 500, `${label} costs no mana`);
  check(u.cooldowns.size, 0, `${label} starts no cooldown`);
  check(u.order, prior, `${label} preserves order`);
}
for (const spell of ['AHtb', 'A011']) {
  const { w, u, t } = fixture();
  check(w.castAbility(u, spell, t).ok, true, `${spell} accepts enemy`);
  t.invulnerable = true;
  w.now = 500; w.stepCast(u);
  check(!!u.cast, false, `${spell} cancels newly invalid target`);
  check(u.mana, 500, `${spell} cancellation costs no mana`);
  check(u.cooldowns.size, 0, `${spell} cancellation starts no cooldown`);
}
{
  const { w, e, u, t } = fixture();
  const flyer = w.createUnit(e.players[5], 'ugar', 80, 0, 0);
  check(flyer.flyHeight, 240, 'inherits flying height');
  check(w.isUnitType(flyer, 3), true, 'native flying classification');
  t.flyHeight = 240;
  check(w.isUnitType(t, 3), false, 'lifted footman remains ground');
  const ground = { targets: 'ground,enemies,organic', levels: [{}, { targets: 'air,enemies,organic' }] };
  check(w.validSpellTarget(u, t, ground, 1), true, 'lifted ground unit allowed');
  check(w.validSpellTarget(u, flyer, ground, 1), false, 'ground spell rejects flyer');
  check(w.validSpellTarget(u, flyer, ground, 2), true, 'level-specific air filter used');
  check(w.validSpellTarget(u, t, ground, 2), false, 'level-specific filter replaces base');
  check(w.castAbility(u, 'AHtb', flyer).ok, true, 'Storm Bolt accepts air');
  w.interruptCast(u);
  const special = { targets: 'ground,enemy,invulnerable', levels: [{}] };
  t.invulnerable = true;
  check(w.validSpellTarget(u, t, special, 1), true, 'explicit invulnerable filter allowed');
  t.invulnerable = false;
  special.targets = 'ground,enemy,dead'; t.alive = false;
  check(w.validSpellTarget(u, t, special, 1), true, 'explicit corpse filter allowed');
  t.alive = true;
  const before = t.hp;
  t.playerIndex = u.playerIndex;
  w.damage(u, t, 10, { raw: true });
  check(t.hp, before - 10, 'script damage does not use order target restrictions');
}
console.log(`${checks} spell targeting checks passed`);
