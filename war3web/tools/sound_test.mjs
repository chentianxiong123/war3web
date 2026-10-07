// Do the map's spell sounds reach the client, and is there a file behind them?
//
// This project has been burnt here before: a sound test once passed 15/15
// while the game was silent, because it asserted that a function had been
// called rather than that any audio existed. So this checks both halves -- the
// map emits a sound event, AND the file it names is on disk and is not a
// zero-length stub.
//
// It also used to name two heroes ('H004', 'E00T') that are not in this map,
// so it died during setup and was skipped from the suite. Ids come from
// tools/testheroes.mjs now.
//
//   node tools/sound_test.mjs        (no server needed)
import fs from 'node:fs';
import path from 'node:path';
import { World, id2int } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';
import { testHeroes } from './testheroes.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const fails = [];
let pass = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fails.push(name); console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
};

const w = new World(); const e = new JassEngine(w);
e.load(); e.boot();
// The two queues are not the same queue, and this file was reading the wrong
// one for melee. A sound the map's SCRIPT starts goes through the StartSound
// native onto the engine's list; a sound the SIMULATION makes -- a weapon
// landing -- is emitted by the world and comes back from w.step(). Reading only
// the engine's is how "thirty seconds of swinging is silent" got written down.
const worldEvents = [];
const tick = (s) => {
  for (let i = 0; i < Math.round(s * 30); i++) {
    e.update(1000 / 30);
    const ev = w.step();
    if (ev && ev.length) worldEvents.push(...ev);
  }
};
tick(2);

const { caster, target } = testHeroes();
const A = w.sellUnit(w.tavernFor(caster.id), e.players[0], caster.id);
// Player 6, not 5: this map allies 0-5 against 6-11, so a target on player 5 is
// a TEAMMATE and the melee below was two heroes politely not hitting each other.
const B = w.sellUnit(w.tavernFor(target.id), e.players[6], target.id);
check('both heroes are seated', !!A && !!B, `${caster.id} / ${target.id}`);
for (const a of caster.learnable) { w.addAbility(A, id2int(a)); w.setAbilityLevel(A, id2int(a), 3); }
A.mana = A.maxMana = 9999;
// Off the team base, where this map's fountain would keep the target topped up
// and end the fight before there is anything to listen to.
w.moveUnit(B, 0, 0); w.moveUnit(A, 120, 0);
B.hp = B.maxHp;
e.clientEvents.length = 0;

console.log(`\n-- ${caster.titleEn || caster.name}'s spells`);
const heard = [];
for (const a of caster.learnable) {
  w.moveUnit(B, 0, 0); w.moveUnit(A, 120, 0);
  if (!B.alive) w.reviveUnit(B, 0, 0);
  B.hp = B.maxHp;
  w.castAbility(A, id2int(a), B, B.x, B.y);
  tick(1.5);
  const snd = e.flushClientEvents().filter((x) => x.t === 'sound');
  const name = (caster.abilities.find((z) => z.id === a) || {}).name;
  heard.push([a, name, snd.map((s) => s.path)]);
  A.cooldowns.clear(); A.mana = A.maxMana;
}
for (const [id, name, paths] of heard)
  console.log(`   ${id}  ${String(name).padEnd(22)} -> ${paths.join(', ') || '(none)'}`);

const withSound = heard.filter(([, , p]) => p.length);
check('at least one spell plays a sound the map imported', withSound.length > 0,
      `${withSound.length} of ${heard.length} spells`);

// ---- and there is real audio behind the names
//
// The files are checked against the sounds the SPELLS produced, because those
// are the ones this map imports and ships. A melee exchange is measured too but
// not asserted on: combat sounds come from the unit's soundset via
// unitSound(u, 'hit'), and these heroes carry custom models whose soundsets the
// map does not supply, so thirty seconds of swinging is silent. That is
// recorded in TODO.txt rather than failed here.
console.log('\n-- the files behind the names');
e.clientEvents.length = 0;
worldEvents.length = 0;
A.order = { type: 'attack', targetId: B.id };
B.order = { type: 'attack', targetId: A.id };
B.hp = B.maxHp = 5_000_000;
tick(30);
const melee = worldEvents.filter((x) => x.t === 'sound');
const swings = worldEvents.filter((x) => x.t === 'attack').length;
console.log(`   melee over 30s: ${swings} swings, ${melee.length} sound events`);
// Warcraft III picks the impact from the ATTACKER's combat sound and the
// material of what it hit -- MetalHeavyChopFlesh, WoodHeavyBashFlesh. The map
// sets that field (ucs1) on 42 of its unit types and the extractor was reading
// ua1w, the weapon's BEHAVIOUR, over the top of it, which left 16 of the 26
// heroes with "normal" where a sound name belongs and no row to find.
// Other things die within earshot while this runs -- a creep somewhere on the
// map is a sound event too -- so the check is that the impacts are there and
// are most of what is heard, not that nothing else makes a noise.
const impacts = melee.filter((m) => /units\/combat\//.test(m.path));
check('two heroes trading blows are not silent', impacts.length > 0,
      `${impacts.length} impacts over ${swings} swings`);
check('and the impact is a combat sound, not a voice line',
      impacts.length > melee.length / 2,
      `${impacts.length} of ${melee.length} sounds`);

const uniq = [...new Set([...heard.flatMap(([, , p]) => p), ...melee.map((s) => s.path)])];
// Guard against the shape of failure this file is named for: if nothing was
// collected, the two file checks below would both pass on an empty set and the
// run would look clean while the game was silent.
check('there is a non-empty set of sounds to check files for', uniq.length > 0,
      `${uniq.length} distinct paths`);

const served = [], missing = [], empty = [];
for (const p of uniq) {
  if (p.includes('/')) continue;                     // a War3local.mpq path, not ours
  const local = path.join(ROOT, 'public/assets/sounds', p);
  if (!fs.existsSync(local)) { missing.push(p); continue; }
  const size = fs.statSync(local).size;
  if (size < 512) empty.push(`${p} (${size}B)`); else served.push(p);
}
console.log(`   ${served.length} served from the map, ${missing.length} need War3local.mpq`);
check('every sound the map imported has a file on disk', missing.length === 0,
      missing.slice(0, 4).join(', '));
// A path that resolves to a zero-length file is the same silence as no file at
// all, and asserting only that the event fired would not see it.
check('and none of those files is an empty stub', empty.length === 0, empty.slice(0, 4).join(', '));
check('at least one is genuinely served locally', served.length > 0, `${served.length}`);

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
