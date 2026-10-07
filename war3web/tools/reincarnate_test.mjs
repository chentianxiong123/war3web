// Does Orochimaru get back up?
//
// A01K, 금술-불로불사의 술법, is his level-10 skill: one level, no hotkey,
// origin AOre. Its whole trigger in war3map.j is one line -- PlaySoundBJ on
// EVENT_PLAYER_UNIT_SPELL_EFFECT -- because in Warcraft III the revive is the
// *engine's* job, not the map's. Nothing in server/ implemented AOre, so the
// death path never looked for it and he simply died.
//
// The numbers come from the ability, not from a guess: AbilityData gives
// DataA 3 and Cool 120, and AbilityMetaData names the Ore1 field for AOre,
// ACrn and ANrn -- "Reincarnation Delay" in WorldEditStrings. Blizzard's own
// AOre carries 7; this map's carries 3.
//
// The second death is the half worth asserting. The cooldown starts when the
// ability fires and not when the body rises, so dying twice inside two minutes
// has to be fatal the second time -- otherwise he is simply immortal.
//
//   node tools/reincarnate_test.mjs        (no server needed)
import fs from 'node:fs';
import path from 'node:path';
import { World, id2int } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

// ---- the data the behaviour is taken from
const abils = read('data/abilities.json');
const game = read('data/game.json');
const A = abils.A01K;
check('the ability is a Reincarnation', !!A && A.base === 'AOre', A ? A.base : 'missing');
const L = A && A.levels && A.levels[0];
check('it carries its own delay and cooldown', !!L && L.data1 === 3 && L.cooldown === 120,
      L ? `delay ${L.data1}s, cooldown ${L.cooldown}s (Blizzard's AOre is 7 / 240)` : 'no levels');
const oro = (game.heroes || []).find((h) => h.id === 'U001');
const slot = oro && (oro.abilities || []).find((x) => x.id === 'A01K');
check('Orochimaru learns it at 10 and it has one level',
      !!slot && slot.reqLevel === 10 && slot.maxLvl === 1 && !slot.hotkey,
      slot ? `reqLevel ${slot.reqLevel}, maxLvl ${slot.maxLvl}, hotkey ${slot.hotkey || 'none'}` : 'not on him');

// ---- and the behaviour itself
const world = new World();
const eng = new JassEngine(world);
eng.load(); eng.boot();
const STEP = 1000 / 30;
for (let i = 0; i < 30; i++) { eng.update(STEP); world.step(); }
const heroes = [...world.units.values()].filter((u) => u.isHero && u.alive);
check('there are heroes in the world', heroes.length > 1, `${heroes.length}`);
const hero = heroes[0], other = heroes[1];
const KEY = id2int('A01K');

check('an unlearned Reincarnation is not ready', !world.reincarnation(hero), 'none held');
hero.abilities.set(KEY, 1);                    // as learning it would
check('a learned one is', !!world.reincarnation(hero), 'A01K held at level 1');

const x0 = hero.x, y0 = hero.y, maxHp = hero.maxHp;
const killer = [...world.units.values()].find((u) => u.alive && world.hostile(u, hero));
const scoreBefore = killer ? world.score?.(world.playerOf(killer)) : null;
const errs0 = eng.errors.length;
world.clientEvents = [];
world.killUnit(hero, killer || null);
const ev = world.flushEvents();
const script = eng.flushClientEvents ? eng.flushClientEvents() : [];

check('he still dies, and the map is still told', hero.alive === false &&
      ev.some((e) => e.t === 'death'), ev.map((e) => e.t).join(' '));
check('the delay and the cooldown come off the ability',
      Math.round((hero.reincarnateAt - world.now) / 1000) === 3 &&
      Math.round((hero.cooldowns.get(KEY) - world.now) / 1000) === 120,
      `${((hero.reincarnateAt - world.now) / 1000).toFixed(1)}s delay, ` +
      `${((hero.cooldowns.get(KEY) - world.now) / 1000).toFixed(0)}s cooldown`);
// the map's own line: its trigger answers SPELL_EFFECT, so the events have to
// reach the script or nothing is heard
check('the map\'s trigger for it is reached', script.some((e) => e.t === 'sound'),
      script.map((e) => e.t).join(' ') || 'nothing fired');
check('and the script did not error', eng.errors.length === errs0,
      `${eng.errors.length - errs0} new`);

let t = 0;
while (!hero.alive && t < 30 * 10) { eng.update(STEP); world.step(); t++; }
check('he gets back up', hero.alive, `${(t / 30).toFixed(1)}s`);
check('after his own three seconds', Math.abs(t / 30 - 3) < 0.2, `${(t / 30).toFixed(1)}s`);
check('where he fell, whole', Math.hypot(hero.x - x0, hero.y - y0) < 40 &&
      Math.round(hero.hp) === Math.round(maxHp),
      `${Math.hypot(hero.x - x0, hero.y - y0).toFixed(0)} units, ` +
      `${Math.round(hero.hp)}/${Math.round(maxHp)} hp`);

// ---- the second death, inside the cooldown, is the end of him
world.killUnit(hero, null);
check('a second death inside the cooldown does not fire it', !hero.reincarnateAt,
      `reincarnateAt ${hero.reincarnateAt || 0}`);
for (let i = 0; i < 30 * 6; i++) { eng.update(STEP); world.step(); }
check('and he stays down', !hero.alive, hero.alive ? 'he got up again' : 'still dead');

// ---- nothing else changed
world.killUnit(other, null);
check('a hero without it dies as before', !other.alive && !other.reincarnateAt, 'no delay set');

// ---- and the map cannot drag a revived hero to the altar
//
// The map revives its heroes at their altar on a timer. ReviveHero on a hero
// who is not dead does nothing in Warcraft III, and reviveUnit had no such
// guard, so a hero who had already got up on his own would have been moved
// there and healed a second time.
const living = [...world.units.values()].find((u) => u.alive && u.isHero);
const lx = living.x, ly = living.y;
living.hp = living.maxHp * 0.5;
const took = world.reviveUnit(living, lx + 4000, ly + 4000);
check('reviving a living hero does nothing', took === false &&
      living.x === lx && living.y === ly && living.hp < living.maxHp,
      `returned ${took}, moved ${Math.hypot(living.x - lx, living.y - ly).toFixed(0)} units`);

const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} checks passed`);
process.exit(bad ? 1 : 0);
