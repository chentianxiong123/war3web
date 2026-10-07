import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';
import { execute } from '../server/abilities.js';
let checks = 0;
const check = (v, label) => { assert.ok(v, label); checks++; };
function fixture() {
  const w = new World(), e = new JassEngine(w);
  const u = w.createUnit(e.players[0], 'H00N', 0, 0, 0);
  Object.assign(u, { x: 0, y: 0 }); u.abilities.clear();
  const targets = {};
  for (const name of ['ground', 'air', 'mechanical', 'hidden', 'invulnerable', 'ally', 'structure', 'locust']) {
    const t = w.createUnit(e.players[name === 'ally' ? 0 : 5], name === 'locust' ? 'hpea' : 'hfoo', 100, 0, 0);
    Object.assign(t, { x: 100, y: 0, hp: 10000, maxHp: 10000, armorTotal: 0, armorType: 'none' });
    t.abilities.clear();
    if (name === 'air') { t.targetAs = 'air'; t.movementType = 'fly'; }
    if (name === 'structure') { t.targetAs = 'structure'; t.isBuilding = true; }
    if (name === 'mechanical') t.classifications = 'mechanical';
    if (name === 'hidden' || name === 'invulnerable') t[name] = true;
    targets[name] = t;
  }
  w.rebuildBins();
  return { w, u, targets };
}
const ability = (base, targets = 'ground,enemy,organic') => ({ id: base, base, targets,
  levels: [{ targets, area: 300, range: 600, duration: 3, heroDuration: 3,
    data1: 100, data2: 500, data3: 400, data4: 100 }] });
for (const base of ['AHtc', 'AUim', 'ANbf', 'AOcl']) {
  const { w, u, targets } = fixture();
  const ab = ability(base);
  if (base === 'AOcl') ab.levels[0].data2 = 4;
  execute(w, u, ab, 1, { x: 200, y: 0, target: targets.ground });
  check(targets.ground.hp < 10000, `${base}: eligible ground target takes damage`);
  for (const name of ['air', 'mechanical', 'hidden', 'invulnerable', 'ally', 'structure', 'locust']) {
    check(targets[name].hp === 10000 && targets[name].buffs.length === 0,
      `${base}: ${name} receives no damage or secondary buff`);
  }
}
{
  const { w, u, targets } = fixture();
  const ab = ability('AHtc', 'air,ground,structure,organic');
  execute(w, u, ab, 1);
  check(targets.ally.hp < 10000, 'authored list without relationship restriction permits friendly fire');
  check(targets.structure.hp < 10000, 'explicit structure category permits building damage');
  check(targets.air.hp < 10000, 'explicit air category permits air damage');
  check(targets.mechanical.hp === 10000, 'organic restriction still applies');
}
{
  const { w, u, targets } = fixture();
  const ab = ability('AHbz'); ab.levels[0].data1 = 3; ab.levels[0].data2 = 50;
  execute(w, u, ab, 1, { x: 100, y: 0 }); w.stepChannels();
  const hp = targets.ground.hp;
  check(hp < 10000 && targets.air.hp === 10000, 'channel first wave uses filters');
  targets.ground.targetAs = 'air'; targets.air.targetAs = 'ground';
  w.now += 1000; w.stepChannels();
  check(targets.ground.hp === hp, 'later wave skips newly ineligible target');
  check(targets.air.hp < 10000, 'later wave accepts newly eligible target');
}
{
  const { w, u, targets } = fixture();
  execute(w, u, ability('AHfs'), 1, { x: 100, y: 0 }); w.stepBurns();
  check(targets.ground.hp < 10000 && targets.air.hp === 10000, 'burning ground applies target filters');
  const hp = targets.ground.hp; targets.ground.hidden = true;
  w.now += 1000; w.stepBurns();
  check(targets.ground.hp === hp, 'burning ground rechecks hidden state');
}
{
  const { w, u, targets } = fixture();
  const ab = ability('AHtc');
  ab.levels.push({ ...ab.levels[0], targets: 'air,enemy,organic' });
  execute(w, u, ab, 2);
  check(targets.air.hp < 10000 && targets.ground.hp === 10000, 'area effects honor per-level replacement filters');
  const hp = targets.ally.hp; w.damage(u, targets.ally, 10, { raw: true });
  check(targets.ally.hp === hp - 10, 'direct script damage remains independent');
}
console.log(`${checks} area targeting checks passed`);
