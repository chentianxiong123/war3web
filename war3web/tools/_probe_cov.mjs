import { JassEngine } from '../server/jass/engine.js';
import { World } from '../server/world.js';
import { coverage } from '../server/jass/boot.js';

const which = process.argv[2] || 'extracted/war3map.j';
const world = new World();
const eng = new JassEngine(world);
let asts;
try { asts = eng.load({ mapJ: which }); } catch (e) { console.log('PARSE FAILED:', e.message); process.exit(1); }
console.log('script:', which);
console.log('functions in map script:', eng.vm.functions.size);
const cov = coverage(eng.vm, [asts.map]);
console.log('natives called by map: implemented=%d declaredOnly=%d unknown=%d',
  cov.implemented.length, cov.unimplemented.length, cov.unknown.length);
console.log('--- declared but unimplemented (stub) ---');
for (const [n,c] of cov.unimplemented) console.log('   ' + n.padEnd(36) + c);
console.log('--- unknown (not in common.j at all) ---');
for (const [n,c] of cov.unknown.slice(0,40)) console.log('   ' + n.padEnd(36) + c);
