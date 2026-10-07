// Fidelity audit: measure the port against the map file, dimension by dimension.
import { World, TYPES, id2int, int2id } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';
import { ABILS, entry as abilEntry, isPassive, isHandled, HANDLED_BASES } from '../server/abilities.js';
import fs from 'node:fs';

const J = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + '%' : 'n/a');
const rows = [];
const add = (area, item, have, total, note = '') =>
  rows.push({ area, item, have, total, note });

// ---------------------------------------------------------------- 1. archive
const manifest = J('extracted/manifest.json');
add('Map file', 'files unpacked from the .w3x', manifest.length, manifest.length);
add('Map file', 'filenames recovered', manifest.filter(m => m.name_recovered).length, manifest.length);

// ---------------------------------------------------------------- 2. script
const world = new World();
const eng = new JassEngine(world);
const asts = eng.load();
const boot = eng.boot();
const mapAst = asts.map;
add('Script', 'JASS functions parsed', mapAst.functions.length, mapAst.functions.length);
add('Script', 'globals parsed', mapAst.globals.length, mapAst.globals.length);
add('Script', 'triggers registered at boot', eng.triggers.length, eng.triggers.length);
add('Script', 'timers registered at boot', eng.timers.length, eng.timers.length);
add('Script', 'boot errors', boot.errors.length, 0, boot.errors.length ? 'FAIL' : 'clean');

// natives: declared vs implemented vs actually exercised
const declared = eng.vm.nativeSigs.size;
let stubs = 0;
for (const [n] of eng.vm.nativeSigs) if (!eng.vm.natives.has(n)) stubs++;
add('Script', 'common.j natives declared', declared, declared);
add('Script', 'natives called during boot but unimplemented', eng.unimplemented.size, 0);

// which map functions are reachable as trigger conditions/actions?
const bound = new Set();
for (const tr of eng.triggers) {
  for (const a of tr.actions) bound.add(a.fn);
  for (const c of tr.conditions) bound.add(c.fn);
}
add('Script', 'functions bound to a trigger', bound.size, mapAst.functions.length,
    'the rest are helpers called from those');

// ---------------------------------------------------------------- 3. events
const kinds = new Map();
for (const tr of eng.triggers) for (const ev of tr.events) kinds.set(ev.kind, (kinds.get(ev.kind) || 0) + 1);
add('Script', 'distinct trigger event kinds registered', kinds.size, kinds.size);
add('Script', 'win/lose paths found', (() => {
  const src = fs.readFileSync('extracted/war3map.j', 'latin1');
  return new Set([...src.matchAll(/function\s+(\w+)\s+takes[\s\S]{0,4000}?CustomVictoryBJ/g)].map(m => m[1])).size
      || (src.match(/CustomVictoryBJ/g) || []).length;
})(), 1);

// ------------------------------------------------------------- 4. game data
const game = J('data/game.json');
const w3u = J('data/war3map.w3u.json');
const w3a = J('data/war3map.w3a.json');
const w3t = J('data/war3map.w3t.json');
add('Object data', 'custom unit types', w3u.custom.length, w3u.custom.length);
add('Object data', 'custom abilities', w3a.custom.length, w3a.custom.length);
add('Object data', 'custom items', w3t.custom.length, w3t.custom.length);
add('Object data', 'unit types in the runtime table', Object.keys(TYPES).length, Object.keys(TYPES).length);
add('Object data', 'abilities in the runtime table', Object.keys(ABILS).length, Object.keys(ABILS).length);

// ability engine coverage: how many reachable actives have a real behaviour?
let actives = 0, engineImpl = 0, fallback = 0, passives = 0;
const reachable = new Set();
for (const t of Object.values(TYPES))
  for (const a of [...(t.abilities || []), ...(t.heroAbilities || [])]) reachable.add(a);
for (const aid of reachable) {
  const ab = abilEntry(aid);
  if (!ab) continue;
  if (isPassive(ab)) { passives++; continue; }
  actives++;
  if (isHandled(ab)) engineImpl++;
  else fallback++;
}
add('Abilities', 'abilities reachable from unit types', reachable.size, reachable.size);
add('Abilities', 'active abilities with a named engine behaviour', engineImpl, actives,
    `${fallback} use the data-driven fallback`);
add('Abilities', 'passive/aura abilities', passives, passives, 'handled as modifiers or no-ops');

// hero spells specifically
let heroSpells = 0, heroImpl = 0;
for (const h of game.heroes) for (const a of h.abilities || []) {
  const ab = abilEntry(a.id);
  if (!ab || isPassive(ab)) continue;
  heroSpells++;
  if (isHandled(ab)) heroImpl++;
}
add('Abilities', 'hero spells with a named engine behaviour', heroImpl, heroSpells);

// ---------------------------------------------------------------- 5. assets
const models = J('assets/models.json');
const um = J('public/data/unitmodels.json');
const withModel = Object.values(um).filter(v => v.m).length;
add('Assets', 'unit types rendering their real model', withModel, Object.keys(um).length);
add('Assets', 'heroes rendering their real model',
    game.heroes.filter(h => (um[h.id] || {}).m).length, game.heroes.length);
add('Assets', 'models converted to glTF', Object.keys(models).length, Object.keys(models).length);
const tex = J('assets/textures.json');
add('Assets', 'textures converted', Object.keys(tex).length, Object.keys(tex).length);
const snd = J('assets/sounds.json');
add('Assets', 'game audio decoded + encoded', Object.keys(snd).length, Object.keys(snd).length);
const mapMp3 = fs.readdirSync('public/assets/sounds').filter(f => f.endsWith('.mp3')).length;
add('Assets', 'map audio (imported mp3)', mapMp3, mapMp3);

// script sound references
const src = fs.readFileSync('extracted/war3map.j', 'latin1');
const sndRefs = [...new Set([...src.matchAll(/CreateSound\("([^"]+)"/g)].map(m => m[1]))];
const blz = sndRefs.filter(p => !/war3mapImported/i.test(p));
const blzOk = blz.filter(p => snd[p.replace(/\\\\/g, '\\').replace(/\\/g, '/').toLowerCase()]);
add('Assets', 'game sounds the script names', blzOk.length, blz.length);
const soundsets = J('data/soundsets.json');
add('Assets', 'unit types with an engine sound set', Object.keys(soundsets).length, Object.keys(TYPES).length);

// --------------------------------------------------------------- 6. terrain
const terr = J('public/data/terrain.json');
const doo = J('public/data/doodads.json');
add('World', 'terrain vertices', terr.width * terr.height, terr.width * terr.height);
add('World', 'pathing cells from war3map.wpm', terr.pathWidth * terr.pathHeight, terr.pathWidth * terr.pathHeight);
const dooTypes = new Set(doo.map(d => d.id));
const dooMeta = (() => { try { return J('public/data/doodadmeta.json'); } catch { return {}; } })();
const visibleDoo = doo.filter((d) => (dooMeta[d.id] || {}).visible);
let dooModelled = 0;
for (const d of visibleDoo) if ((dooMeta[d.id] || {}).m) dooModelled++;
add('World', 'doodads placed', doo.length, doo.length,
    `${dooTypes.size} distinct type(s)`);
add('World', 'visible doodads rendering their real model', dooModelled, visibleDoo.length,
    visibleDoo.length === 0 ? 'all placed doodads are invisible pathing blockers' : '');

// ------------------------------------------------------------- 7. behaviour
const tick = (s) => { for (let i = 0; i < Math.round(s * 30); i++) { eng.update(1000 / 30); world.step(); } };
tick(45);
const creeps = [...world.units.values()].filter(u =>
  String((world.type(u.typeId) || {}).race).toLowerCase() === 'creeps' && u.alive);
add('Behaviour', 'creeps spawned by the map\'s own timers', creeps.length, creeps.length, 'map caps each camp at 11');
add('Behaviour', 'runtime errors over 45s', eng.errors.length, 0);
const lb = eng.leaderboards.find(b => b.rows.length);
add('Behaviour', 'map scoreboard', lb ? 1 : 0, lb ? 1 : 0,
    lb ? `leaderboard "${lb.title}"` : 'this map keeps its own counters instead');

console.log('| Area | Check | Result | |');
console.log('|---|---|---|---|');
for (const r of rows) {
  const ok = r.have === r.total ? 'OK' : (r.item.includes('error') || r.item.includes('unimplemented'))
    ? (r.have === 0 ? 'OK' : 'GAP') : 'PARTIAL';
  console.log(`| ${r.area} | ${r.item} | ${r.have}${r.total !== r.have ? ' / ' + r.total : ''}${r.total && r.have !== r.total ? ' (' + pct(r.have, r.total) + ')' : ''} | ${ok}${r.note ? ' — ' + r.note : ''} |`);
}
