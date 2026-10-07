// Diagnostic for docs/WC3_GAMEPLAY_AUDIT.md. Reports parity differences;
// deliberately outside *_test.mjs until the underlying defects are fixed.
// No server, browser, or running match is required.
import fs from 'node:fs';
import { World, TYPES } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';

const read = p => JSON.parse(fs.readFileSync(new URL('../' + p, import.meta.url), 'utf8'));
const gp = read('data/gameplay.json');
const game = read('data/game.json');
const w3u = read('data/war3map.w3u.json');
const results = [];
const record = (finding, actual, expected) => results.push({ finding, actual, expected });
function fixture() {
  const w = new World();
  const eng = new JassEngine(w);
  const hero = w.createUnit(eng.players[0], 'H00N', 0, 0, 0);
  hero.controlled = true;
  return { w, eng, hero };
}
function target(w, eng, hero) {
  const t = w.createUnit(eng.players[5], 'hfoo', 100, 0, 0);
  // Controlled, inert target on flat nearby coordinates. Isolate combat rules
  // from terrain, retaliation, passives, and lethal damage.
  Object.assign(t, { x: hero.x + 60, y: hero.y, controlled: true,
    paused: true, hp: 10000, maxHp: 10000, armor: 0, armorTotal: 0,
    armorType: 'none', hpReg: 0 });
  t.abilities.clear();
  return t;
}

{
  const { w, eng, hero } = fixture();
  eng.load(); // Register the real native; do not boot map triggers or fountains.
  const t = target(w, eng, hero);
  t.armorType = 'fort';
  const damage = eng.vm.natives.get('UnitDamageTarget');
  const measure = attackType => {
    t.hp = 10000;
    damage(hero, t, 100, true, false, attackType, 4, null);
    return 10000 - t.hp;
  };
  record('Explicit CHAOS versus HERO attack type at zero armor',
    { chaos: measure(5), hero: measure(6) },
    { chaos: 100 * gp.damageBonus.chaos.fort, hero: 100 * gp.damageBonus.hero.fort });
}
{
  const { w, hero } = fixture();
  hero.hp = 100; hero.mana = 0;
  for (let i = 0; i < 30; i++) w.step();
  record('Byakuya regeneration over one second without items/buffs',
    { hp: +(hero.hp - 100).toFixed(6), mana: +hero.mana.toFixed(6) },
    { hp: TYPES.H00N.hpReg + hero.strTotal * gp.strRegenBonus,
      mana: TYPES.H00N.manaReg + hero.intTotal * gp.intRegenBonus });
}
{
  const { w, eng, hero } = fixture();
  const t = target(w, eng, hero);
  hero.abilities.clear();
  hero.missileSpeed = 0;
  hero.order = { type: 'attack', targetId: t.id };
  const originalRandom = Math.random;
  const rolls = [];
  try {
    for (const r of [0, 0.999999]) {
      Math.random = () => r;
      hero.atkTimer = 0; t.hp = 10000;
      w.stepAttack(hero);
      for (let i = 0; hero.attackWindup && i < 300; i++) w.stepAttack(hero);
      rolls.push(10000 - t.hp);
    }
  } finally { Math.random = originalRandom; }
  record('Byakuya minimum/maximum basic attack before armor', rolls,
    [hero.dmg + hero.dmgDice, hero.dmg + hero.dmgDice * hero.dmgSides]);
  record('Roster heroes declaring more than one damage die',
    game.heroes.filter(h => TYPES[h.id].dmgDice > 1).length, game.heroes.length);
  hero.atkTimer = 0; t.hp = 10000;
  const before = w.now;
  w.stepAttack(hero);
  w.order(hero, { type: 'stop' });
  const authored = w3u.custom.find(u => u.id === 'H00N').mods.udp1;
  record('Damage before any time elapses, then immediate Stop',
    { elapsedMs: w.now - before, damageAlreadyApplied: t.hp < 10000 },
    { damageAlreadyApplied: false, authoredDamagePointSeconds: authored });
}
{
  const { w, hero } = fixture();
  const originalSpeed = hero.moveSpeed;
  w.applyBuff(hero, { kind: 'slow', pct: 0.5, until: w.now + 100 });
  const slowedSpeed = hero.moveSpeed;
  for (let i = 0; i < 6; i++) w.step();
  record('Movement slow after its duration expires',
    { originalSpeed, slowedSpeed, remainingBuffs: hero.buffs.length, speedAfterExpiry: hero.moveSpeed },
    { remainingBuffs: 0, speedAfterExpiry: originalSpeed });
}
{
  const { w, eng, hero } = fixture();
  const t = target(w, eng, hero);
  hero.abilities.clear(); hero.missileSpeed = 0;
  w.order(hero, { type: 'stop' });
  let events = [];
  for (let i = 0; i < 60; i++) events.push(...w.step());
  const stopped = events.filter(e => e.t === 'attack' && e.id === hero.id).length;
  w.order(hero, { type: 'hold' });
  events = [];
  for (let i = 0; i < 60; i++) events.push(...w.step());
  record('Controlled hero: nearby enemy after Stop versus Hold',
    { attacksAfterStop: stopped,
      attacksAfterHold: events.filter(e => e.t === 'attack' && e.id === hero.id).length },
    'Both commands should allow attacking this in-range enemy; Stop permits acquisition/chase.');
}
console.log(JSON.stringify(results, null, 2));
