import { World } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';
const w = new World(); const e = new JassEngine(w);
e.load(); e.boot();
const msgs = [], sounds = [];
for (const n of ['DisplayTextToForce','DisplayTimedTextToForce','DisplayTextToPlayer','DisplayTimedTextToPlayer']) {
  const o = e.vm.natives.get(n);
  if (o) e.vm.registerNative(n, (...a) => { const s = a.find(x => typeof x === 'string'); if (s) msgs.push(s); return o(...a); });
}
let cinematic = 0;
const oc = e.vm.natives.get('CinematicModeBJ');
e.vm.registerNative('CinematicModeBJ', (...a) => { cinematic++; return oc && oc(...a); });
const tick = (s) => { for (let i = 0; i < Math.round(s * 30); i++) { e.update(1000 / 30); w.step(); } };
tick(2);
const A = w.sellUnit(null, e.players[0], 'H01D'); A.controlled = true;
const B = w.sellUnit(null, e.players[4], 'H00B'); B.controlled = true;
const p0 = [Math.round(A.x), Math.round(A.y)], p1 = [Math.round(B.x), Math.round(B.y)];
console.log('timers registered:', e.timers.length);
const t0 = Date.now();
tick(330);
console.log(`simulated 330s in ${((Date.now()-t0)/1000).toFixed(0)}s wall clock`);
console.log('CinematicModeBJ called:', cinematic, cinematic ? '(duel fired)' : '(duel did NOT fire)');
console.log('hero A moved:', p0, '->', [Math.round(A.x), Math.round(A.y)], ' paused:', A.paused);
console.log('hero B moved:', p1, '->', [Math.round(B.x), Math.round(B.y)], ' paused:', B.paused);
console.log('map messages:', [...new Set(msgs)].slice(0, 6));
console.log('units:', w.units.size, ' errors:', [...new Set(e.errors.map(x => x.split('\n')[0]))].length);
