import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';
import { entry } from '../server/abilities.js';
let checks = 0;
const near = (a, b, label) => { assert.ok(Math.abs(a - b) < 1e-7, `${label}: ${a} vs ${b}`); checks++; };
const key = s => [...s].reduce((n, c) => (n * 256 + c.charCodeAt(0)) >>> 0, 0);
function fixture(type = 'H00N') {
  const w = new World(), e = new JassEngine(w);
  const source = w.createUnit(e.players[0], 'H00N', 0, 0, 0);
  const target = w.createUnit(e.players[0], type, 100, 0, 0);
  source.abilities.clear(); target.abilities.clear();
  Object.assign(source, { x: 0, y: 0, attacksEnabled: 0 });
  Object.assign(target, { x: 100, y: 0, attacksEnabled: 0 });
  w.recalc(source); w.recalc(target);
  return { w, e, source, target };
}
for (const type of ['H00N', 'hfoo']) {
  const { w, source, target } = fixture(type);
  const armor = target.armorTotal ?? target.armor;
  const sourceArmor = source.armorTotal;
  source.abilities.set(key('AHad'), 1); w.stepAuras();
  near(target.armorTotal, armor + 1.5, `${type}: ally gains devotion armor`);
  near(source.armorTotal, sourceArmor + 1.5, `${type}: aura affects source`);
  for (let i = 0; i < 20; i++) w.stepAuras();
  near(target.armorTotal, armor + 1.5, `${type}: repeated refresh does not compound`);
  w.recalc(target); near(target.armorTotal, armor + 1.5, `${type}: recalc does not double aura`);
  source.abilities.set(key('AHad'), 3); w.stepAuras();
  near(target.armorTotal, armor + entry('AHad').levels[2].data1, `${type}: level changes bonus`);
  target.x = 1000; w.stepAuras(); near(target.armorTotal, armor, `${type}: outside range loses armor`);
  target.x = 100; source.hidden = true; w.stepAuras(); near(target.armorTotal, armor, `${type}: hidden source inactive`);
  source.hidden = false; source.alive = false; w.stepAuras(); near(target.armorTotal, armor, `${type}: dead source inactive`);
}
{
  const { w, e, source, target } = fixture();
  const armor = target.armorTotal;
  source.abilities.set(key('AHad'), 1);
  const other = w.createUnit(e.players[0], 'H00N', 200, 0, 0);
  Object.assign(other, { x: 200, y: 0 }); other.abilities.clear(); other.abilities.set(key('AHad'), 2);
  w.stepAuras(); near(target.armorTotal, armor + 3, 'same aura uses stronger source');
  const item = { abilities: ['AIad'] }; w.giveItem(target, item); w.stepAuras();
  near(target.armorTotal, armor + 3, 'item alias does not stack with hero aura');
  other.alive = false; source.alive = false; w.stepAuras();
  near(target.armorTotal, armor + 1, 'item aura remains when hero sources disappear');
  w.dropItem(target, item); w.stepAuras(); near(target.armorTotal, armor, 'dropping aura item removes bonus');
}
{
  const { w, source, target } = fixture();
  const speed = target.moveSpeed, attack = target.attackSpeedMul, hp = target.hpReg, mana = target.manaReg;
  for (const id of ['AOae', 'AUau', 'AHab']) source.abilities.set(key(id), 1);
  w.stepAuras();
  near(target.moveSpeed, speed * 1.2, 'endurance and unholy move bonuses combine');
  near(target.attackSpeedMul, attack + 0.05, 'endurance gives authored attack speed');
  near(target.hpReg, hp + 0.5, 'unholy gives authored flat life regen');
  near(target.manaReg, mana + 0.75, 'brilliance gives authored flat mana regen');
  target.hp = 100; target.mana = 0;
  w.step(); near(target.hp, 100 + (hp + 0.5) * w.dt, 'aura life regen reaches simulation');
  near(target.mana, (mana + 0.75) * w.dt, 'aura mana regen reaches simulation');
  source.abilities.clear(); w.stepAuras();
  near(target.moveSpeed, speed, 'source removal restores movement');
  near(target.attackSpeedMul, attack, 'source removal restores attack speed');
  near(target.hpReg, hp, 'source removal restores life regen');
  near(target.manaReg, mana, 'source removal restores mana regen');
}
{
  const { w, source, target } = fixture(); const armor = target.armorTotal;
  source.abilities.set(key('AHad'), 1); target.invulnerable = true; w.stepAuras();
  near(target.armorTotal, armor + 1.5, 'friendly invulnerable target allowed by aura flags');
  target.playerIndex = 5; w.stepAuras(); near(target.armorTotal, armor, 'enemy excluded');
  target.playerIndex = 0; target.targetAs = 'structure'; w.stepAuras();
  near(target.armorTotal, armor, 'building category excluded by authored filter');
}
{
  const { w, e, source, target } = fixture(); e.load();
  source.abilities.set(key('AOae'), 1); w.stepAuras();
  e.vm.natives.get('SetUnitMoveSpeed')(target, 400);
  near(target.moveSpeed, 440, 'native speed update applies aura to new base');
  w.stepAuras(); near(target.moveSpeed, 440, 'aura refresh preserves native speed change');
  source.alive = false; w.stepAuras(); near(target.moveSpeed, 400, 'aura removal preserves new base speed');
}
console.log(`${checks} aura stat checks passed`);
