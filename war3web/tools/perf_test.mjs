// Where the simulation's time goes, and how it scales with unit count.
//
// The complaint is that a lot of mobs tanks the game. Guessing which loop is
// responsible is how you optimise the wrong one, so this boots the real map,
// runs real ticks, and counts the work rather than reasoning about it.
//
//   node tools/perf_test.mjs            # current roster
//   MOBS=400 node tools/perf_test.mjs   # with extra mobs spawned in
import { World } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';
import { TICK_HZ } from '../shared/const.js';

const TICKS = +(process.env.TICKS || 300);
const MOBS = +(process.env.MOBS || 0);

const world = new World();
const eng = new JassEngine(world);
eng.load();
eng.boot();

// instrument the range query, which every unit's AI runs every tick
let calls = 0, returned = 0;
const origEnum = world.enumInRange.bind(world);
world.enumInRange = (x, y, r) => {
  calls++;
  const out = origEnum(x, y, r);
  returned += out.length;
  return out;
};

// let the map settle: creeps spawn, triggers arm
for (let i = 0; i < 60; i++) world.step(1 / TICK_HZ);

if (MOBS) {
  const types = [...new Set([...world.units.values()].filter((u) => u.alive && !u.isHero
    && !u.isBuilding).map((u) => u.typeKey))];
  const p = world.jass.players[12];
  for (let i = 0; i < MOBS && types.length; i++) {
    const t = types[i % types.length];
    world.createUnit(p, t, -2000 + (i % 40) * 90, -1500 + Math.floor(i / 40) * 90, 0);
  }
}

const live = () => [...world.units.values()].filter((u) => u.alive).length;
calls = returned = 0;
const t0 = process.hrtime.bigint();
for (let i = 0; i < TICKS; i++) world.step(1 / TICK_HZ);
const ms = Number(process.hrtime.bigint() - t0) / 1e6;

const budget = 1000 / TICK_HZ;
const f = (n, d = 1) => n.toFixed(d);
console.log(`units in world      ${world.units.size}  (${live()} alive)`);
console.log(`ticks               ${TICKS}`);
console.log(`total               ${f(ms, 0)} ms`);
console.log(`per tick            ${f(ms / TICKS, 2)} ms   (budget ${f(budget)} ms at ${TICK_HZ} Hz)`);
console.log(`headroom            ${f((ms / TICKS) / budget * 100, 0)}% of budget used`);
console.log();
console.log(`enumInRange calls   ${calls}  (${f(calls / TICKS)} per tick)`);
console.log(`  units returned    ${returned}  (${f(returned / calls)} per call)`);
