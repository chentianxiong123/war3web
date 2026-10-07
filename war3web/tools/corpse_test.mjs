// Does a dead unit leave a corpse, and does the corpse age and then clear?
//
// Warcraft III plays the unit's death animation for its own death time, decays
// the flesh, and leaves bones for the bone-decay time before removing the body.
// This client hid every dead non-hero the instant it died, and nothing ever
// removed a corpse server-side -- so a spider vanished mid-animation while its
// entity accumulated in the world forever.
//
//   node server/index.js &        # port 8077
//   node tools/corpse_test.mjs
import { World } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};

const world = new World();
const eng = new JassEngine(world);
eng.load();
eng.boot();

// find something ordinary to kill
const victim = [...world.units.values()].find((u) => u.alive && !u.isHero && !u.isBuilding);
if (!victim) { console.log('no unit to kill'); process.exit(1); }
const id = victim.id, typeKey = victim.typeKey, deathTime = victim.deathTime;
console.log('killing %s (%s), death time %ss', typeKey, id, deathTime);

const before = world.units.size;
world.killUnit(victim, null);
const corpse = world.units.get(id);
// node's console.log has no %.1f; format the number before handing it over
console.log('corpse kept: %s   decays in %ss', !!corpse,
            corpse ? ((corpse.corpseUntil - world.now) / 1000).toFixed(1) : '-');

check('the body is not removed on death', !!corpse && !corpse.alive);
check('the corpse is given a decay deadline',
      !!corpse?.corpseUntil, corpse?.corpseUntil ? 'yes' : 'none');

// it must still be on the wire, or the client cannot draw it
const snapHas = (uid) => (world.snapshot().ents || []).some((e) => e.i === uid);
check('the corpse is still sent to clients', snapHas(id));

// run past the decay deadline and confirm it clears
const until = corpse.corpseUntil;
let removedAt = null;
for (let i = 0; i < 60 * 60 && removedAt === null; i++) {
  world.step();
  if (!world.units.has(id)) removedAt = world.now;
}
const expected = (until - 0) / 1000;
console.log('removed at %ss (deadline was %ss)',
            (removedAt / 1000).toFixed(1), expected.toFixed(1));
check('the corpse is removed once its decay runs out', removedAt !== null,
      removedAt === null ? 'still there after 60s' : `${(removedAt / 1000).toFixed(1)}s`);
check('...and not before', removedAt === null || removedAt >= until,
      removedAt === null ? '' : `${((removedAt - until) / 1000).toFixed(2)}s late`);
check('the world does not grow', world.units.size <= before);

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
