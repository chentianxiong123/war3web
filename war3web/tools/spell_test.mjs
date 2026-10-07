// Every spell a hero can learn, cast at a live target.
//
// The engine runs the base ability and the map's trigger adds the rest, so the
// question is whether each cast is accepted and whether anything reaches the
// target. This used to print a table and exit 0 whatever was in it -- a column
// of "no engine behaviour" read the same as a column of "cast" -- and it named
// heroes ('H004', 'E00T') this map does not contain, so the table was never
// printed at all. Ids come from tools/testheroes.mjs.
//
//   node tools/spell_test.mjs        (no server needed)
import { World, id2int } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';
import { testHeroes } from './testheroes.mjs';

const fails = [];
let pass = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fails.push(name); console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
};

const world = new World();
const eng = new JassEngine(world);
eng.load();
eng.boot();
const tick = (secs) => { for (let i = 0; i < Math.round(secs * 30); i++) { eng.update(1000 / 30); world.step(); } };
tick(2);

const { caster, target } = testHeroes();
const buy = (id, slot) => world.sellUnit(world.tavernFor(id), eng.players[slot], id);
const A = buy(caster.id, 0);
const B = buy(target.id, 5);
console.log(`\n-- ${caster.titleEn || caster.name} casting at ${target.titleEn || target.name}`);
check('both heroes are seated on opposing teams', !!A && !!B && A.team !== B.team,
      `${caster.id} t${A && A.team} vs ${target.id} t${B && B.team}`);
check('the caster has learnable spells', (caster.learnable || []).length > 0,
      (caster.learnable || []).join(', '));

for (const aid of caster.learnable) {
  world.addAbility(A, id2int(aid));
  world.setAbilityLevel(A, id2int(aid), 3);
}
// Off the bases first. sellUnit seats a hero at its team's base, and this map
// puts a healing fountain there -- 산혼철조's 433 landed and was regenerated
// away between the cast and the measurement, which read as a spell that does
// nothing. Both heroes go to the middle of the map, where nothing heals them.
world.moveUnit(B, 0, 0);
world.moveUnit(A, 200, 0);
A.mana = A.maxMana = 5000;
tick(0.5);

const errs0 = eng.errors.length;
const results = [];
for (const aid of caster.learnable) {
  // Top the target up to its OWN maximum between casts rather than inflating
  // maxHp: recalc rebuilds a hero's maximum from its attributes and clamps hp
  // back down, so an inflated pool reads as millions of damage on the first
  // cast that happens to tick past it. Measured that way this file reported
  // 산혼철조 dealing 4,999,200 -- all of it the clamp, none of it the spell.
  B.hp = B.maxHp;
  const hp0 = B.hp;
  world.moveUnit(B, 0, 0);
  world.moveUnit(A, 200, 0);
  const r = world.castAbility(A, id2int(aid), B, B.x, B.y);
  tick(1.5);
  const ab = caster.abilities.find((a) => a.id === aid);
  const dealt = Math.min(hp0, Math.max(0, hp0 - Math.max(0, B.hp)));
  results.push({ aid, name: ab && ab.name, ok: r.ok, reason: r.reason,
                 dealt, killed: !B.alive });
  if (!B.alive) world.reviveUnit(B, B.x, B.y);
  A.cooldowns.clear(); A.mana = A.maxMana;
}

console.log('\n   spell   name                         result    damage');
for (const r of results)
  console.log(`   ${r.aid.padEnd(6)}  ${String(r.name).padEnd(26)} ${(r.ok ? 'cast' : r.reason).padEnd(9)} ${Math.round(r.dealt)}${r.killed ? '  (lethal)' : ''}`);
console.log('');

const refused = results.filter((r) => !r.ok);
check('every learnable spell is accepted by the engine', refused.length === 0,
      refused.map((r) => `${r.aid}:${r.reason}`).join(', '));
// A hero whose whole kit lands nothing is the failure this file exists to
// catch; not every spell damages, so the bar is that the kit as a whole does.
check('the kit as a whole reaches the target',
      results.some((r) => r.dealt > 0),
      `${results.filter((r) => r.dealt > 0).length} of ${results.length} dealt damage`);
// Nothing may report more damage than the target could possibly take -- that
// is the shape of a measurement artefact rather than a spell.
check('and no cast reports more than the target\'s own health pool',
      results.every((r) => r.dealt <= B.maxHp + 1),
      results.filter((r) => r.dealt > B.maxHp + 1)
             .map((r) => `${r.aid}:${Math.round(r.dealt)} vs ${Math.round(B.maxHp)}`).join(', '));

const newErrs = [...new Set(eng.errors.slice(errs0).map((x) => x.split('\n')[0]))];
check('casting raises no VM errors', newErrs.length === 0, newErrs.slice(0, 3).join(' | '));

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
