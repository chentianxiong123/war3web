// Does anything reach the client that it cannot draw?
//
// Warcraft III maps cast through invisible dummy units, and a dummy that gets
// sent to a client which then draws a stand-in mesh for it is the "ghost orc":
// a grey capsule wandering the battlefield. This casts every hero ability and
// checks whether any unit lands in the snapshot without a model the client can
// resolve.
//
//   node tools/ghost_test.mjs
import fs from 'node:fs';
import { World } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';

const GAME = JSON.parse(fs.readFileSync('data/game.json', 'utf8'));
const TYPES = JSON.parse(fs.readFileSync('data/unittypes.json', 'utf8'));
const UM = JSON.parse(fs.readFileSync('public/data/unitmodels.json', 'utf8'));

const world = new World();
const eng = new JassEngine(world);
eng.load(); eng.boot();
const tick = () => { eng.update(1000 / 30); world.step(); };
for (let i = 0; i < 60; i++) tick();

const [X, Y] = (() => {
  const b = world.bounds();
  for (let y = b.miny + 800; y < b.maxy - 800; y += 128)
    for (let x = b.minx + 800; x < b.maxx - 800; x += 128)
      if (world.walkable(x, y) && world.walkable(x + 300, y)) return [x, y];
  return [0, 0];
})();

const RESIDENT = new Set(world.units.keys());
const offenders = new Map();

for (const hero of GAME.heroes) {
  const caster = world.createUnit(eng.players[0], hero.id, X, Y, 0);
  if (!caster) continue;
  caster.mana = caster.maxMana = 999999;
  const foe = world.createUnit(eng.players[5], 'hfoo', X + 250, Y, 0);
  if (foe) { foe.maxHp = foe.hp = 1e7; foe.moveSpeed = 0; }
  for (const a of hero.abilities) {
    world.addAbility(caster, a.id);
    world.learnSkill(caster, a.id);
    caster.cooldowns = new Map();
    caster.mana = caster.maxMana;
    world.castAbility(caster, a.id, foe, foe.x, foe.y);
    for (let i = 0; i < 20; i++) tick();
    // what would the client be handed, and could it draw it?
    for (const e of world.snapshot().ents) {
      if (RESIDENT.has(e.i)) continue;
      const meta = UM[e.u];
      if (meta && meta.m) continue;                 // has a model: drawable
      if (meta && meta.l) continue;                 // locust dummy: never drawn
      const t = TYPES[e.u] || {};
      const key = e.u + '|' + (t.model || '(none)');
      if (!offenders.has(key)) {
        offenders.set(key, { type: e.u, model: t.model || '(none)',
                             locust: (t.abilities || []).includes('Aloc'),
                             from: hero.nameEn || hero.name, ability: a.id, n: 0 });
      }
      offenders.get(key).n++;
    }
  }
  for (const u of [...world.units.values()]) if (!RESIDENT.has(u.id)) world.removeUnit(u);
}

console.log('cast every hero ability; units sent to the client with nothing to draw:');
if (!offenders.size) {
  console.log('  none');
} else {
  for (const o of offenders.values()) {
    // console.log understands %s and %d but none of printf's width flags, so
    // '%-6s' printed itself and shifted every argument after it by one.
    console.log('  %s locust=%s  model=%s  first seen: %s %s  x%d',
      String(o.type).padEnd(6), String(o.locust).padEnd(5),
      String(o.model).slice(0, 24).padEnd(24), o.from, o.ability, o.n);
  }
}
process.exit(offenders.size ? 1 : 0);
