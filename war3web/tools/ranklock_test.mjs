// Two defects the hero sweep measured, asserted where they can fail.
//
// 1. RANK LOCK. 'alev' is what a map author writes when they want a level
//    count of their own; when it is absent Warcraft III falls back to the BASE
//    ability's count, and tools/abilities.py has always done that. The game
//    table did not, so it stamped maxLvl 1 on every ability whose author left
//    the field alone -- and server/room.js gates skill points on THAT number.
//    34 abilities across 20 of the 26 heroes, 11 of them ultimates, could
//    never be raised past rank 1. Asserted by driving the real LEARN handler
//    through a real room, not by reading the table.
//
// 2. A CARRIED BURN ON A NON-HERO. Cloak of Flames is not a hero ability;
//    Warcraft III burns whatever holds it. The only path to a carried burn ran
//    through recalc, which returned for non-heroes, so Ace's 불의장벽 -- twelve
//    fire emitters whose whole payload is a carried AIcf -- dealt nothing.
//    Asserted by standing an enemy in the fire and watching its life fall.
//
//   node tools/ranklock_test.mjs        (no server needed)
import fs from 'node:fs';
import path from 'node:path';
import { World } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';
import { Room } from '../server/room.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};
const J = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));

// ---------------------------------------------------------------- the tables
const w3a = J('data/war3map.w3a.json');
const abils = J('data/abilities.json');
const game = J('public/data/game.json');
const mods = {};
for (const o of [...w3a.custom, ...w3a.base]) mods[o.id] = o.mods || {};

// every castable that names no alev, with a base that really has more levels
const silent = [], explicit = [];
for (const h of game.heroes) {
  for (const a of (h.abilities || [])) {
    const m = mods[a.id] || {};
    const hasAlev = Object.keys(m).some((k) => k.startsWith('alev'));
    const real = (abils[a.id]?.levels || []).length;
    (hasAlev ? explicit : silent).push({ hero: h.id, id: a.id, maxLvl: a.maxLvl, real, hasAlev });
  }
}
const stillLocked = silent.filter((x) => x.real > 1 && x.maxLvl < x.real);
check('no ability that omits alev is still capped below its base level count',
      stillLocked.length === 0,
      stillLocked.length ? stillLocked.map((x) => `${x.hero}/${x.id} ${x.maxLvl}<${x.real}`).join(' ') : '0 of ' + silent.length);
// the premise, restated as an assertion: an author who wants one rank says so
const oneRankOnPurpose = explicit.filter((x) => x.maxLvl === 1);
check('an author who wants a single rank writes alev, and those stay at 1',
      oneRankOnPurpose.length > 0 && oneRankOnPurpose.every((x) => x.real === 1),
      oneRankOnPurpose.map((x) => x.id).join(', ') || 'none found');
check('and no ability was pushed ABOVE its own compiled level count',
      [...silent, ...explicit].every((x) => x.maxLvl <= Math.max(1, x.real)));

// ---------------------------------------------------------------- the gate
// The table is only half of it: room.js must actually let the point be spent.
const room = new Room('ranklock');
const ws = () => ({ readyState: 1, out: [], send(s) { this.out.push(JSON.parse(s)); } });
const wa = ws();
const p = room.join(wa, 'Kimimaro');
// H01A: A047 and A04P are two of the 34; A04P is his ultimate at reqLevel 20
room.handle(p, { t: 'pickHero', heroId: 'H01A' });
room.handle(p, { t: 'ready', ready: true });
clearInterval(room.loop); room.loop = null;
check('a match started with the hero seated', room.phase === 'playing' && p.entId != null);
const W = room.world, u = W.units.get(p.entId);
const int = (s2) => s2.split('').reduce((a, c) => (a << 8) | c.charCodeAt(0), 0) >>> 0;
// Level him past every gate so the skip table cannot be what refuses the point,
// and hand him the points to spend. The cap under test is maxLvl, not the level.
while (u.level < 30) W.setHeroLevel(u, u.level + 1);
u.skillPoints = 20;
const slots = room.cardSlots(p, u);
const lvlOf = (id) => W.abilityLevel(u, int(id));
for (const id of ['A047', 'A04P']) {
  const slot = slots.indexOf(id);
  if (slot < 0) { check(`${id} is on the command card`, false, slots.join(',')); continue; }
  const before = lvlOf(id);
  for (let i = 0; i < 4; i++) room.handle(p, { t: 'learn', slot });
  const after = lvlOf(id);
  check(`${id} can be raised past rank 1 through the real LEARN handler`,
        after > 1, `rank ${before} -> ${after}`);
}
// the ultimate is the one that matters most: it should reach its full 3
check('A04P, his ultimate, reaches its full rank', lvlOf('A04P') === 3, `rank ${lvlOf('A04P')}`);
clearTimeout(room.resetTimer);

// ---------------------------------------------------------------- the burn
// Ace's fire wall: the map creates o007 units carrying A05Y (AIcf). Stand an
// enemy next to one and its life must fall.
const world = new World();
const eng = new JassEngine(world);
eng.load(); eng.boot();
const wall = world.createUnit(eng.players[0], 'o007', 0, 0, 0);
check('a fire-wall unit exists and is not a hero', !!wall && !wall.isHero);
check('and it carries the Cloak of Flames ability', !!wall && wall.abilities.size > 0);
check('a non-hero carrying AIcf is given a burn', !!(wall && wall.immolation),
      wall?.immolation ? `${wall.immolation.dps.toFixed(0)} dps in ${wall.immolation.area}` : 'none');
const victim = world.createUnit(eng.players[6], [...world.units.values()]
  .find((x) => x.alive && !x.isHero && !x.isBuilding && x.typeKey !== 'o007').typeKey, 60, 0, 0);
check('an enemy stands inside the wall', !!victim && world.hostile(wall, victim));
const hp0 = victim.hp;
for (let i = 0; i < 60; i++) world.step();
check('and its life falls', victim.hp < hp0, `${hp0.toFixed(0)} -> ${victim.hp.toFixed(0)}`);
// and the narrow scope: a non-hero with no such ability gets nothing
const plain = [...world.units.values()].find((x) => x.alive && !x.isHero && x.typeKey !== 'o007');
check('a non-hero with no carried burn still has none', !plain.immolation);

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
