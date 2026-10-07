// With two players, one per team, does the duel actually pair them?
//
// The map gates its duel on which of players 0-7 report PLAYING, picks a
// duellist from each side, drops them in the arena and sends everyone else to
// the stands. If every slot claims to be occupied the map picks from empty
// ones, so nobody reaches the arena and the two real players watch an empty
// ring from the stands.
//
//   node tools/duel_test.mjs [slotA] [slotB]
import { World } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';

const A = +(process.argv[2] ?? 0);          // team 1 occupies 0-3
const B = +(process.argv[3] ?? 4);          // team 2 occupies 4-7

const world = new World();
const eng = new JassEngine(world);
eng.load();

// FAKE_FULL=1 reproduces the old behaviour: every slot claims to be occupied,
// which is what the engine used to report before anyone had joined.
if (process.env.FAKE_FULL) {
  for (let i = 0; i < 12; i++) eng.players[i].slotState = 1;
}
// seat exactly two players, as a two-person lobby would
for (const slot of [A, B]) {
  const p = eng.players[slot];
  p.slotState = 1; p.controller = 1; p.name = 'P' + slot;
}
eng.boot();

const playing = eng.players.slice(0, 8).map((p) => p.slotState).join(',');
console.log('slots 0-7 reporting PLAYING: %s   (seated: %d and %d)', playing, A, B);

// give each of them a hero, the way buyHero does
const HEROES = ['H00N', 'H00B'];
const heroes = [];
[A, B].forEach((slot, i) => {
  const u = world.createUnit(eng.players[slot], HEROES[i] || HEROES[0], 0, 0, 0);
  if (u) { heroes.push({ slot, u, from: { x: u.x, y: u.y } }); }
});
console.log('heroes created: %d', heroes.length);

// the duel fires on a 290-310s timer; run past it
// Watch the whole window rather than one snapshot: the map duels repeatedly,
// and "not paused" on its own is not evidence of duelling -- a hero that never
// moved is not paused either, it simply was never picked.
const MINUTES = +(process.env.MINUTES || 6);
const tick = () => { eng.update(1000 / 30); world.step(); };
const events = [];
let inArena = false;
for (let i = 0; i < MINUTES * 60 * 30; i++) {
  tick();
  const far = heroes.filter((h) => Math.hypot(h.u.x - h.from.x, h.u.y - h.from.y) > 800).length;
  const paused = heroes.filter((h) => h.u.paused).length;
  const now = far === heroes.length;
  if (now !== inArena) {
    inArena = now;
    events.push({ t: Math.round(world.now / 1000), inArena: now, far, paused });
  }
}
console.log('\nduel events over %d minutes:', MINUTES);
for (const e of events) {
  // node's format has no width modifier: '%4d' is not a specifier, so it is
  // printed literally and every argument after it lands one place to the left.
  console.log('  %ss  %s   (%d of %d far from spawn, %d paused)',
    String(e.t).padStart(4), e.inArena ? 'both in the arena' : 'back out       ',
    e.far, heroes.length, e.paused);
}
if (!events.length) console.log('  none -- nobody was ever moved into the arena');

console.log('\nafter %ds:', Math.round(world.now / 1000));
for (const h of heroes) {
  const d = Math.round(Math.hypot(h.u.x - h.from.x, h.u.y - h.from.y));
  console.log('  slot %d hero at (%d, %d)  moved %d units  paused=%s invulnerable=%s',
    h.slot, Math.round(h.u.x), Math.round(h.u.y), d, !!h.u.paused, !!h.u.invulnerable);
}
// duellists fight; spectators are paused and made invulnerable in the stands
const duelled = events.some((e) => e.inArena);
console.log(duelled
  ? '\nboth players reached the arena at least once'
  : '\nPROBLEM: neither player was ever moved into the arena');
process.exit(duelled ? 0 : 1);
