// Two heroes fighting: does a match actually progress?
//
// Spells cast, a hero dies, the kill is counted, XP and gold move, and the
// engine stays quiet. This used to print all of that and exit 0 regardless --
// "died 0 times" was a passing run -- and it named two heroes ('H004',
// 'E00T') that are not in this map, so it never got as far as printing
// anything. Ids come from tools/testheroes.mjs now.
//
//   node tools/match_test.mjs        (no server needed)
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
const { caster, target } = testHeroes();

function buy(hero, slot) {
  const u = world.sellUnit(world.tavernFor(hero.id), eng.players[slot], hero.id);
  for (const aid of hero.learnable) { world.addAbility(u, id2int(aid)); world.setAbilityLevel(u, id2int(aid), 4); }
  u.mana = u.maxMana = 20000;
  return u;
}
const A = buy(caster, 0);
const B = buy(target, 5);
console.log(`\n-- ${caster.titleEn || caster.name} vs ${target.titleEn || target.name}`);
check('both heroes are seated', !!A && !!B, `${caster.id} / ${target.id}`);
check('on opposing teams', A.team !== B.team, `${A.team} vs ${B.team}`);
check('carrying their learnable spells',
      A.abilities.size >= caster.learnable.length, `${A.abilities.size} abilities`);

const KILLS = eng.vm.globals.get('udg_integer04');   // the map's team-1 tally
const kills0 = KILLS ? KILLS.value : -1;
const xp0 = A.xp || 0, gold0 = eng.players[0].gold || 0;

let deaths = 0;
for (let round = 1; round <= 6; round++) {
  world.moveUnit(A, B.x + 150, B.y);
  A.order = { type: 'attack', targetId: B.id };
  B.order = { type: 'attack', targetId: A.id };
  // One cast at a time: a spell takes the caster's cast point to land, and a
  // second order before then breaks the first off, as it does in the game.
  for (const aid of caster.learnable) if (B.alive) { world.castAbility(A, id2int(aid), B, B.x, B.y); tick(1); }
  tick(3);
  if (!B.alive) { deaths++; world.reviveUnit(B, B.x + 400, B.y); B.mana = B.maxMana; }
  A.cooldowns.clear(); A.mana = A.maxMana; A.hp = A.maxHp;
}

console.log('');
check('the target dies at least once over six rounds', deaths > 0, `${deaths} deaths`);
check('and the map counts the hero kills itself',
      KILLS && KILLS.value >= kills0 + deaths, KILLS ? `${kills0} -> ${KILLS.value}` : '-');
check('the killer gains experience', (A.xp || 0) > xp0, `${Math.round(xp0)} -> ${Math.round(A.xp || 0)}`);
check('and the map pays out gold', (eng.players[0].gold || 0) > gold0,
      `${Math.round(gold0)} -> ${Math.round(eng.players[0].gold || 0)}`);

const creeps = [...world.units.values()]
  .filter((u) => String((world.type(u.typeId) || {}).race).toLowerCase() === 'creeps');
check('the map keeps its creep waves running', creeps.length > 0, `${creeps.length} alive`);

const errs = [...new Set(eng.errors.map((x) => x.split('\n')[0]))];
check('no runtime errors over the whole match', errs.length === 0, errs.slice(0, 3).join(' | '));
console.log(`\n   hero level ${A.level}, ${world.units.size} units in the world, ` +
            `${eng.unimplemented.size} unimplemented natives touched`);

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
