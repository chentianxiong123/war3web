import { World } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';

const world = new World();
const eng = new JassEngine(world);
eng.load();
eng.boot();
console.log('after boot: %d units, %d triggers, %d timers', world.units.size, eng.triggers.length, eng.timers.length);

const STEP = 1000 / 30;
const counts = [];
for (let sec = 1; sec <= 40; sec++) {
  for (let i = 0; i < 30; i++) { eng.update(STEP); world.step(); }
  if (sec % 5 === 0) counts.push([sec, world.units.size]);
}
console.log('\nunit count over time:');
for (const [s, n] of counts) console.log(`  t=${String(s).padStart(2)}s   ${n} units`);

import { int2id } from '../server/world.js';
const byType = new Map();
for (const u of world.units.values()) {
  const k = u.typeKey;
  byType.set(k, (byType.get(k) || 0) + 1);
}
const types = [...byType].sort((a, b) => b[1] - a[1]);
console.log('\nunit types present (top 20):');
for (const [k, n] of types.slice(0, 20)) {
  const t = world.type(k);
  console.log(`   ${k}  x${String(n).padStart(3)}  ${(t && (t.properName || t.name)) || '?'}  lvl ${t ? t.level : '?'}  ${t && t.race}`);
}
const creeps = [...world.units.values()].filter((u) => String((world.type(u.typeId) || {}).race).toLowerCase() === 'creeps');
console.log(`\ncreeps spawned: ${creeps.length}`);
if (eng.errors.length) {
  console.log(`\nruntime errors: ${eng.errors.length}`);
  for (const e of [...new Set(eng.errors.map((x) => x.split('\n')[0]))].slice(0, 10)) console.log('  !', e);
}
console.log('sleeping threads:', eng.threads.length);
