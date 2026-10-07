import { World } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';

const world = new World();
const eng = new JassEngine(world);
console.log('loading scripts…');
eng.load();
console.log('natives implemented:', eng.vm.natives.size);
const t0 = Date.now();
const r = eng.boot();
console.log(`boot in ${Date.now() - t0}ms`);
console.log('units created during boot:', world.units.size);
console.log('triggers registered:', eng.triggers.length);
console.log('timers registered:', eng.timers.length);
console.log('sleeping threads:', eng.threads.length);
console.log('spell event id:', eng.eventId('EVENT_PLAYER_UNIT_SPELL_EFFECT'),
            ' death:', eng.eventId('EVENT_PLAYER_UNIT_DEATH'),
            ' sell:', eng.eventId('EVENT_PLAYER_UNIT_SELL'));
if (r.errors.length) {
  console.log(`\n${r.errors.length} runtime errors (first 12):`);
  for (const e of r.errors.slice(0, 12)) console.log('  !', e);
}
if (r.unimplemented.length) {
  console.log(`\n${r.unimplemented.length} unimplemented natives were called:`);
  for (const [n, c] of r.unimplemented.slice(0, 20)) console.log('   ' + n.padEnd(34) + c);
}
// The pipeline's verify stage used to be green over a broken boot: this printed
// the count and exited 0 whatever it was. An unimplemented native is not a
// failure -- the port is deliberately partial and each one is a listed no-op --
// but a runtime error in the map's own script is what this exists to catch.
process.exit(r.errors.length ? 1 : 0);
