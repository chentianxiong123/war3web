import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';
import { execute, entry } from '../server/abilities.js';
let checks = 0;
const check = (v, label) => { assert.ok(v, label); checks++; };
const near = (a, b, label) => check(Math.abs(a - b) < 1e-7, `${label}: ${a} vs ${b}`);
const key = s => [...s].reduce((n, c) => (n * 256 + c.charCodeAt(0)) >>> 0, 0);
function fixture() {
  const w = new World(), e = new JassEngine(w);
  const u = w.createUnit(e.players[0], 'H00N', 0, 0, 0);
  const t = w.createUnit(e.players[5], 'hfoo', 60, 0, 0);
  Object.assign(u, { x: 0, y: 0, mana: 500 });
  Object.assign(t, { x: 60, y: 0, hp: 10000, maxHp: 10000, armorTotal: 0, armorType: 'none' });
  u.abilities.clear(); t.abilities.clear();
  t.abilities.set(key('ACmi'), 1);
  return { w, e, u, t };
}
{
  const { w, e, u, t } = fixture(); e.load();
  const n = name => e.vm.natives.get(name);
  check(n('IsUnitType')(t, n('ConvertUnitType')(26)), 'native classifies immunity');
  n('UnitRemoveAbility')(t, key('ACmi')); check(!w.magicImmune(t), 'native removal immediately clears immunity');
  for (const id of ['Amim', 'ACmi', 'ACm2', 'ACm3', 'AImx']) {
    n('UnitAddAbility')(t, key(id)); check(w.magicImmune(t), `${id} grants immunity`);
    n('UnitRemoveAbility')(t, key(id));
  }
  n('UnitAddAbility')(t, key('ACmi'));
  const damage = (at, dt) => {
    const before = t.hp;
    n('UnitDamageTarget')(u, t, 100, true, false, n('ConvertAttackType')(at), n('ConvertDamageType')(dt), null);
    return before - t.hp;
  };
  near(damage(5, 14), 0, 'magic damage blocked even with chaos attack type');
  near(damage(4, 4), 0, 'magic weapon damage blocked');
  check(damage(1, 4) > 0, 'physical weapon damage allowed');
  check(damage(0, 4) > 0, 'spell attack type alone does not imply magical damage');
  check(damage(4, 26) > 0, 'explicit universal damage bypasses immunity');
  near(w.damage(u, t, 100, { raw: true }), 100, 'raw script damage unchanged');
  t.invulnerable = true;
  near(damage(5, 26), 0, 'universal damage does not bypass invulnerability');
}
{
  const { w, u, t } = fixture();
  u.abilities.set(key('AHtb'), 1);
  check(!w.castAbility(u, 'AHtb', t).ok, 'Storm Bolt rejects immune target');
  near(u.mana, 500, 'rejection spends no mana'); check(!u.cooldowns.size, 'rejection starts no cooldown');
  check(!execute(w, u, entry('AHtb'), 1, { target: t }).ok, 'direct base execution also rejects immune target');
  near(t.hp, 10000, 'rejected bolt does no damage'); check(!t.buffs.length, 'rejected bolt does not stun');
  t.abilities.clear(); check(w.castAbility(u, 'AHtb', t).ok, 'nonimmune bolt accepted');
  t.abilities.set(key('ACmi'), 1); w.now += 1000; w.stepCast(u);
  check(!u.cast, 'gaining immunity interrupts pending magical cast'); near(u.mana, 500, 'interruption spends no mana');
}
{
  const { w, u, t } = fixture();
  u.atkType = 'magic'; check(!w.weaponFor(u, t), 'magic weapon cannot select immune target');
  u.atkType = 'normal'; check(w.weaponFor(u, t), 'physical weapon remains eligible');
  const aoe = { id: 'test', base: 'AHtc', targets: 'ground,enemy', levels: [{ targets: 'ground,enemy', area: 300, data1: 100, duration: 2 }] };
  w.rebuildBins(); execute(w, u, aoe, 1);
  near(t.hp, 10000, 'magical area damage excluded'); check(!t.buffs.length, 'magical area slow excluded');
  t.playerIndex = 0; u.abilities.set(key('AHad'), 1); w.stepAuras();
  near(t.armorTotal, 1.5, 'friendly aura still affects magic immune unit');
  const hp = t.hp; t.hp -= 100; w.heal(t, 50); near(t.hp, hp - 50, 'healing is not globally blocked');
}
{
  const { w, u, t } = fixture();
  const ab = { id: 'test', base: 'AOww', targets: 'ground,enemy', levels: [{ targets: 'ground,enemy', area: 300, data1: 75, duration: 3 }] };
  w.rebuildBins(); execute(w, u, ab, 1); w.stepChannels();
  check(t.hp < 10000, 'universal ultimate channel damage bypasses immunity');
}
{
  const { w, e, u, t } = fixture();
  const other = w.createUnit(e.players[5], 'hfoo', 80, 0, 0);
  Object.assign(other, { x: 80, y: 0, hp: 10000, maxHp: 10000 }); other.abilities.clear();
  const aoe = { id: 'test', base: 'AHtc', targets: 'ground,enemy', levels: [{ targets: 'ground,enemy', area: 300, data1: 100 }] };
  w.rebuildBins(); execute(w, u, aoe, 1, { target: t });
  check(other.hp < 10000, 'immune unit under cursor does not cancel an area effect');
  near(t.hp, 10000, 'area effect still excludes immune unit under cursor');
}
console.log(`${checks} magic immunity checks passed`);
