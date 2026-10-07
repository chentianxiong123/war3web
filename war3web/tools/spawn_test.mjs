// Do the creep waves arrive when the map says they should?
//
// The map runs three periodic triggers -- 30s, 60s and 90s -- each creating a
// fixed roster of units for Player 12 across twelve spawn rects. Nothing in
// this port schedules creeps itself; the map's own script does it, so this
// watches the world and checks the waves land on the beat and bring the right
// number of bodies.
//
//   node tools/spawn_test.mjs [minutes]
import { World } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';

const MINUTES = +(process.argv[2] || 5);
const world = new World();
const eng = new JassEngine(world);
eng.load(); eng.boot();

// what the map's own triggers create, read straight out of war3map.j
const EXPECT = {
  30: { units: 4 + 4 + 4 + 2 + 4 + 4 + 4 + 2 + 4 + 4 + 4 + 2, name: 'gnolls, nagas, spiders' },
  60: { units: 5 + 1 + 5 + 1 + 6 + 5 + 1 + 5 + 5 + 5 + 5 + 6 + 5 + 1 + 5 + 1 + 5 + 1,
        name: 'bandits, priests, grunts, footmen, knights' },
  90: { units: null, name: 'bloodfiends, tauren, necromancers, ghosts, doom guards' },
};

const HOSTILE = 12;
let prev = new Set(world.units.keys());
const events = [];
const tick = () => {
  eng.update(1000 / 30);
  world.step();
  const now = new Set(world.units.keys());
  const born = [...now].filter((id) => !prev.has(id))
    .map((id) => world.units.get(id))
    .filter((u) => u && u.playerIndex === HOSTILE);
  if (born.length) events.push({ t: world.now / 1000, n: born.length });
  prev = now;
};

const total = Math.round(MINUTES * 60 * 30);
for (let i = 0; i < total; i++) tick();

// group bursts that land in the same instant
const waves = [];
for (const e of events) {
  const last = waves[waves.length - 1];
  if (last && e.t - last.t < 0.5) { last.n += e.n; continue; }
  waves.push({ t: e.t, n: e.n });
}

console.log(`${MINUTES} minutes of simulation: ${waves.length} creep waves\n`);
console.log('   at        bodies   gap    expected beat');
let prevT = 0;
const beats = { 30: 0, 60: 0, 90: 0 };
for (const w of waves) {
  const gap = w.t - prevT;
  const beat = [30, 60, 90].filter((b) => Math.abs(w.t % b) < 0.6 || Math.abs((w.t % b) - b) < 0.6);
  for (const b of beat) beats[b]++;
  console.log('  %s  %s  %s  %s',
    (w.t.toFixed(1) + 's').padStart(8), String(w.n).padStart(6),
    (gap.toFixed(1) + 's').padStart(6), beat.length ? beat.join(' + ') : '(off-beat)');
  prevT = w.t;
}
// The waves do not stack -- the map hands over from one to the next -- so what
// to expect is a function of how far into the game we are, not a division.
const T = MINUTES * 60;
const spanA = Math.min(T, 300);                       // 30s wave, until 5 minutes
const spanB = Math.max(0, Math.min(T, 1200) - 300);   // 60s wave, until 20 minutes
const spanC = Math.max(0, T - 1200);                  // 90s wave thereafter
console.log('\nexpected, given the map hands over at 5 and 20 minutes:');
console.log('   30s wave x%d, then 60s wave x%d, then 90s wave x%d',
            Math.floor(spanA / 30), Math.floor(spanB / 60), Math.floor(spanC / 90));
const early = waves.filter((w) => w.t <= 300).map((w) => w.n);
const late = waves.filter((w) => w.t > 300).map((w) => w.n);
console.log('observed body counts: before the handover %s, after %s',
            JSON.stringify([...new Set(early)]), JSON.stringify([...new Set(late)]));
console.log('waves landing on each beat:', JSON.stringify(beats));
console.log('roster sizes from the script: 30s -> %d units, 60s -> %d units',
            EXPECT[30].units, EXPECT[60].units);
