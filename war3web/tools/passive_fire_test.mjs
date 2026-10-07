import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';
import { execute, entry } from '../server/abilities.js';
let checks = 0;
const check = (v, label) => { assert.ok(v, label); checks++; };
const near = (a, b, label) => check(Math.abs(a - b) < 1e-7, `${label}: ${a} vs ${b}`);
const key = s => [...s].reduce((n, c) => (n * 256 + c.charCodeAt(0)) >>> 0, 0);
function fixture(type = 'H00N') {
  const w = new World(), e = new JassEngine(w);
  const u = w.createUnit(e.players[0], type, 0, 0, 0);
  Object.assign(u, { x: 0, y: 0, attacksEnabled: 0, hpReg: 0 }); u.abilities.clear();
  const targets = {};
  for (const name of ['ground', 'air', 'hidden', 'invulnerable', 'locust', 'ally', 'outside']) {
    const t = w.createUnit(e.players[name === 'ally' ? 0 : 5], name === 'locust' ? 'hpea' : 'hfoo', 100, 0, 0);
    Object.assign(t, { x: name === 'outside' ? 180 : 100, y: 0, paused: true, hp: 10000, maxHp: 10000, hpReg: 0, armorTotal: 0, armorType: 'none' });
    if (name === 'air') { t.targetAs = 'air'; t.movementType = 'fly'; }
    if (name === 'hidden' || name === 'invulnerable') t[name] = true;
    targets[name] = t;
  }
  return { w, u, targets };
}
for (const type of ['H00N', 'hfoo']) {
  const { w, u, targets } = fixture(type);
  const item = { abilities: ['AIcf'] };
  check(w.giveItem(u, item), `${type}: item granted`);
  check(u.immolation?.area === 160, `${type}: authored item radius`);
  w.step();
  near(10000 - targets.ground.hp, 50 * w.dt, `${type}: authored item damage`);
  for (const name of ['air', 'hidden', 'invulnerable', 'locust', 'ally', 'outside'])
    near(targets[name].hp, 10000, `${type}: excludes ${name}`);
  w.dropItem(u, item); check(!u.immolation, `${type}: drop clears passive burn`);
  const hp = targets.ground.hp; w.step(); near(targets.ground.hp, hp, `${type}: dropped item no longer damages`);
  w.giveItem(u, item); w.removeItem(item);
  check(!u.immolation, `${type}: removing item clears burn`);
}
{
  const { w, u, targets } = fixture();
  u.abilities.set(key('A05Y'), 1); w.recalc(u);
  check(u.immolation?.area === 150, 'carried ability retains radius');
  w.step(); near(10000 - targets.ground.hp, 1000 * w.dt, 'carried ability deals authored damage');
  near(targets.air.hp, 10000, 'carried ability excludes air');
  u.abilities.delete(key('A05Y')); w.recalc(u);
  check(!u.immolation, 'ability removal clears passive burn');
}
{
  const { w, u } = fixture();
  execute(w, u, entry('AEim'), 1);
  const active = u.immolation;
  const item = { abilities: ['AIcf'] }; w.giveItem(u, item); w.dropItem(u, item);
  check(u.immolation === active, 'dropping passive source restores independently activated immolation');
  w.recalc(u); check(u.immolation === active, 'later recalculation preserves active immolation');
}
console.log(`${checks} passive fire checks passed`);
