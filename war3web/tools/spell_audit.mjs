// Cast every hero ability once and report whether anything actually happened.
//
// The map's own triggers play a spell's sound, animation and effects whether or
// not the payload lands, so a spell that does nothing still looks like it fired.
// This drives each ability against a punching bag and watches for the three
// things a spell can do to the world -- summon, damage, buff -- so "the effects
// played" cannot be mistaken for "it worked".
//
//   node tools/spell_audit.mjs            every hero
//   node tools/spell_audit.mjs U001       one hero, ability by ability
//
// Abilities that only affect the caster (Metamorphosis, Blink, Mana Shield) are
// reported against the caster too, so they are not miscounted as dead.
import fs from 'node:fs';
import { JassEngine } from '../server/jass/engine.js';
import { World, id2int } from '../server/world.js';
import * as A from '../server/abilities.js';

const world = new World();
const eng = new JassEngine(world);
eng.load({ mapJ: 'extracted/war3map.j' });
const tick = (s) => { for (let i = 0; i < Math.round(s * 30); i++) { eng.update(1000 / 30); world.step(); } };
tick(3);

const GAME = JSON.parse(fs.readFileSync('data/game.json', 'utf8'));
const only = process.argv[2];
const heroes = only ? GAME.heroes.filter((h) => h.id === only) : GAME.heroes;
const tally = { summon: 0, damage: 0, buff: 0, caster: 0, nothing: 0 };
const dead = [];

for (const hero of heroes) {
  const A_ = world.sellUnit(world.tavernFor(hero.id), eng.players[0], hero.id);
  if (!A_) { console.log('%s: could not spawn', hero.name); continue; }
  for (const a of hero.abilities) { world.addAbility(A_, id2int(a.id)); world.learnSkill(A_, id2int(a.id)); }
  A_.mana = A_.maxMana = 99999;
  const foe = world.createUnit(eng.players[5], 'hfoo', A_.x + 150, A_.y, 0);
  if (foe) { foe.maxHp = foe.hp = 1e7; }
  if (only) console.log('\n%s (%s)', hero.name, hero.id);
  for (const a of hero.abilities) {
    const ab = A.entry(a.id);
    if (!ab || A.isPassive(ab)) continue;
    const before = new Set([...world.units.values()].filter((u) => u.summonedBy === A_.id).map((u) => u.id));
    const hp0 = foe ? foe.hp : 0;
    const fb0 = foe ? (foe.buffs || []).length : 0;
    const cb0 = (A_.buffs || []).length;
    const cx = A_.x, cy = A_.y, ct = A_.typeKey;
    const r = world.castAbility(A_, a.id, foe, foe ? foe.x : A_.x, foe ? foe.y : A_.y);
    tick(1.5);
    const sums = [...world.units.values()].filter((u) => u.summonedBy === A_.id && !before.has(u.id)).length;
    const dmg = foe ? Math.round(hp0 - foe.hp) : 0;
    const fbuf = foe ? (foe.buffs || []).length - fb0 : 0;
    const cbuf = (A_.buffs || []).length - cb0;
    const moved = Math.round(Math.hypot(A_.x - cx, A_.y - cy));
    let verdict;
    if (sums) { verdict = `summon x${sums}`; tally.summon++; }
    else if (dmg > 0) { verdict = `damage ${dmg}`; tally.damage++; }
    else if (fbuf > 0) { verdict = 'debuff on target'; tally.buff++; }
    else if (cbuf > 0 || moved > 8 || A_.typeKey !== ct) {
      verdict = cbuf > 0 ? 'caster buff' : (moved > 8 ? `caster moved ${moved}` : 'caster morph');
      tally.caster++;
    } else {
      verdict = 'NOTHING';
      tally.nothing++;
      dead.push(`${hero.name} / ${a.name || a.id} (${a.id}) base=${A.baseOf(ab)} cast=${r.ok ? 'ok' : r.reason}`);
    }
    if (only) console.log('   %s  %s -> %s', a.id, (a.name || '').padEnd(22), verdict);
    if (foe) { foe.hp = foe.maxHp; foe.buffs = []; }
    A_.buffs = [];
  }
  world.removeUnit(A_);
  if (foe) world.removeUnit(foe);
}

if (!only) {
  const acted = tally.summon + tally.damage + tally.buff + tally.caster;
  console.log('\nactive hero abilities that changed the world: %d of %d', acted, acted + tally.nothing);
  console.log('   summon %d   damage %d   debuff %d   caster-only %d   NOTHING %d',
    tally.summon, tally.damage, tally.buff, tally.caster, tally.nothing);
  if (dead.length) {
    console.log('\ndoing nothing:');
    for (const d of dead) console.log('   ' + d);
  }
}
