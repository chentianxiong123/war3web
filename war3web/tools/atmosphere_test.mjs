// The stub natives that a player would have noticed: music, fog, and three
// that are not cosmetic at all.
//
// A native the engine has never heard of is reported -- boot_test prints that
// list and it is empty.  A native that EXISTS with an empty body is not: it
// takes the call, returns, and nothing says a word.  tools/stub_audit.mjs ranks
// them; this asserts the ones taken off that list.
//
//   node tools/atmosphere_test.mjs        (no server needed)
import fs from 'node:fs';
import path from 'node:path';
import { World } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';

const ROOT = path.resolve(import.meta.dirname, '..');
let pass = 0; const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fails.push(name); console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
};

const world = new World();
const eng = new JassEngine(world);
// The natives push onto the engine's own client-event queue, which the room
// drains once a tick; config() and main() run inside boot(), so the events are
// already there before the first tick.
const seen = [];
const realEmit = eng.emit.bind(eng);
eng.emit = (e) => { seen.push(e); return realEmit(e); };
eng.load(); eng.boot();
const STEP = 1000 / 30;
for (let i = 0; i < 60; i++) { eng.update(STEP); world.step(); }

// ------------------------------------------------------------------- music
console.log('\n-- SetMapMusic("Music") plays the standard playlist');
{
  const GP = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/gameplay.json'), 'utf8'));
  check('the playlist is compiled out of UI\\WorldEditData.txt', (GP.music || []).length > 20,
        `${(GP.music || []).length} tracks`);
  const ev = seen.filter((e) => e.t === 'music');
  check('booting the map asks for music at all', ev.length > 0, `${ev.length} events`);
  const play = ev.find((e) => e.list && e.list.length);
  check('the label "Music" resolves to a list, not to one file',
        play && play.list.length > 1, play ? `${play.list.length}` : 'none');
  check('and the map asked for it at random, which is what it wrote',
        play && play.random === true, play ? String(play.random) : '-');
  // Reported from play as two songs at once. SetMapMusic SETS the list; this
  // map runs its own score through the sound system and Blizzard's playlist on
  // top of it is a second stream.
  check('SetMapMusic sets the list rather than starting it',
        ev.every((e) => e.set === true), JSON.stringify(ev[0] || {}).slice(0, 80));
  // every track has to be a file the archives actually supplied
  const idx = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/sounds.json'), 'utf8'));
  const served = new Set(Object.values(idx));
  const bad = (play ? play.list : []).filter((f) => !served.has(f));
  check('every track named is one the conversion produced', bad.length === 0, bad.slice(0, 3).join(','));
  // and the files are on disk, non-empty
  let missing = 0, empty = 0;
  for (const f of (play ? play.list : []).slice(0, 8)) {
    const p = path.join(ROOT, 'public/assets', f);
    const q = path.join(ROOT, 'assets', f);
    const hit = fs.existsSync(p) ? p : fs.existsSync(q) ? q : null;
    if (!hit) { missing++; continue; }
    if (fs.statSync(hit).size < 1024) empty++;
  }
  check('the tracks are on disk and are not empty', missing === 0 && empty === 0,
        `${missing} missing, ${empty} empty`);
}

// ------------------------------------------------- the score the map runs
console.log('\n-- the map runs its own score, and can stop it');
{
  // udg_sound41 is Sound\Music\mp3Music\HumanX1.mp3, created LOOPING at
  // 4 minutes 44, played when a mode starts and stopped when a team wins.
  const src = fs.readFileSync(path.join(ROOT, 'extracted/war3map.j'), 'latin1');
  const at = src.indexOf('HumanX1.mp3');
  check('the map creates its score as a looping sound', at > 0
        && /CreateSound\("Sound\\\\Music\\\\mp3Music\\\\HumanX1\.mp3",true/.test(src.slice(at - 60, at + 40)),
        src.slice(at - 40, at + 30));
  check('and it stops that sound somewhere', src.includes('StopSoundBJ(udg_sound41'));
  // every sound handle carries an id, or StopSound has nothing to name
  const sounds = seen.filter((e) => e.t === 'sound');
  check('a sound the map starts reaches the client with an id',
        sounds.length === 0 || sounds.every((e) => e.snd), `${sounds.length} sounds`);
  const loops = sounds.filter((e) => e.loop);
  check('and a looping one says so', loops.length === 0 || loops.every((e) => e.snd),
        `${loops.length} looping`);
}

// --------------------------------------------------------------------- fog
console.log('\n-- SetTerrainFogEx gives the renderer the map\'s own fog');
{
  const fog = seen.filter((e) => e.t === 'fog');
  check('the map sets its fog during init', fog.length > 0, `${fog.length} events`);
  const f = fog[0];
  // the script asks for SetTerrainFogEx(0, 3000., 5000., .5, .0, .0, .0)
  check('it is the map\'s own 3000 to 5000, not the renderer\'s 4200 to 9000',
        f && f.start === 3000 && f.end === 5000, f ? `${f.start}..${f.end}` : '-');
  check('and its own black, not the renderer\'s 0x0b1018',
        f && f.color && f.color.every((c) => c === 0), f ? JSON.stringify(f.color) : '-');
}

// ------------------------------------------------------------- day and night
console.log('\n-- SetDayNightModels lights the world from the map\'s own model');
{
  const curves = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/daynight.json'), 'utf8'));
  check('the DNC curves are compiled', Object.keys(curves).length >= 4,
        `${Object.keys(curves).length} models`);
  const ev = seen.find((e) => e.t === 'daynight');
  check('the map names its day/night models', !!ev, JSON.stringify(ev || {}));
  check('and the terrain model it names has a curve',
        ev && !!curves[ev.terrain], ev ? ev.terrain : '-');
  check('and so does the unit model', ev && !!curves[ev.unit], ev ? ev.unit : '-');
  const c = ev && curves[ev.terrain];
  check('the curve is the light\'s own colour track, not one key',
        c && c.color.length >= 8 && c.ambient.length >= 8,
        c ? `${c.color.length} / ${c.ambient.length}` : '-');
  // hour 0 is night and hour 12 is day, which is the check that the sequence
  // was mapped onto the day the right way round
  if (c) {
    const at = (h) => {
      let a = c.color[0], b = c.color[c.color.length - 1];
      for (let i = 0; i < c.color.length - 1; i++)
        if (h >= c.color[i][0] && h <= c.color[i + 1][0]) { a = c.color[i]; b = c.color[i + 1]; break; }
      const span = b[0] - a[0], k = span > 0 ? (h - a[0]) / span : 0;
      return [1, 2, 3].map((j) => a[j] + (b[j] - a[j]) * k);
    };
    const night = at(0), noon = at(12);
    check('midnight is darker than noon', night[2] < noon[2],
          `${night.map((v) => v.toFixed(2))} vs ${noon.map((v) => v.toFixed(2))}`);
    check('and midnight is warm rather than white', night[0] - night[2] > 0.2,
          `${night.map((v) => v.toFixed(2))}`);
    check('noon is near white', noon.every((v) => v > 0.9), `${noon.map((v) => v.toFixed(2))}`);
  }
  // the clock: the map never touches it, so it stays where a melee map starts
  // the natives themselves, not through the VM: vm.call returns a generator
  // because a JASS thread can sleep mid-call
  const nat = eng.vm.natives;
  check('GetTimeOfDay answers a real hour', nat.get('GetTimeOfDay')() === 12,
        String(nat.get('GetTimeOfDay')()));
  nat.get('SetTimeOfDay')(7.5);
  check('SetTimeOfDay moves it', nat.get('GetTimeOfDay')() === 7.5,
        String(nat.get('GetTimeOfDay')()));
  check('SuspendTimeOfDay and the scale are real too',
        (nat.get('SetTimeOfDayScale')(0.5), nat.get('GetTimeOfDayScale')() === 0.5),
        String(nat.get('GetTimeOfDayScale')()));
  nat.get('SetTimeOfDay')(12);
  nat.get('SetTimeOfDayScale')(1);
}

// ---------------------------------------------------------- the ambience
console.log('\n-- the ambient themes, rendered from the game\'s own MIDI and bank');
{
  const tbl = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/ambience.json'), 'utf8'));
  // the day theme is set first and the night one second, so each call sends the
  // state so far and the last one carries both
  const evs = seen.filter((e) => e.t === 'ambient');
  const ev = evs[evs.length - 1];
  check('the map names a day and a night theme', !!(ev && ev.day && ev.night),
        `${evs.length} events, last ${JSON.stringify(ev || {}).slice(0, 70)}`);
  check('and both were rendered', Object.keys(tbl).length === 2, Object.keys(tbl).join(','));
  // the row is a MIDI score and a DLS bank, which is why nothing could play it
  for (const [label, row] of Object.entries(tbl)) {
    check(`${label} came from a MIDI and a bank in the archives`,
          /\.mid \(/.test(row.source) && /\.dls \(/.test(row.source), row.source);
    const f = path.join(ROOT, 'assets', row.file);
    const pub = path.join(ROOT, 'public/assets', row.file);
    const hit = fs.existsSync(pub) ? pub : fs.existsSync(f) ? f : null;
    check(`${label} is on disk and is not a stub`, hit && fs.statSync(hit).size > 500_000,
          hit ? `${(fs.statSync(hit).size / 1e6).toFixed(1)} MB` : 'missing');
    check(`${label} carries its row's own volume`, Math.abs(row.volume - 80 / 127) < 0.01,
          String(row.volume));
  }
  check('the theme the client is told to play is one of them',
        !!(ev && ev.day && ev.night && tbl[ev.day.label] && tbl[ev.night.label]),
        ev && ev.day && ev.night ? `${ev.day.label} / ${ev.night.label}` : '-');
}

// ------------------------------------------------ a client that joins late
console.log('\n-- the standing atmosphere is replayed to a client that joins late');
{
  const ev = eng.atmosphereEvents();
  const kinds = new Set(ev.map((e) => e.t));
  check('it carries the fog', kinds.has('fog'), [...kinds].join(','));
  check('it carries the music list', kinds.has('music'), [...kinds].join(','));
  check('it carries the day/night models', kinds.has('daynight'), [...kinds].join(','));
  check('it carries the ambient themes', kinds.has('ambient'), [...kinds].join(','));
  check('and none of it is a one-shot event', ev.every((e) => e && e.t),
        String(ev.length));
}

// ------------------------------------------- three that are not cosmetic
console.log('\n-- and three the audit called "not cosmetic, worth a look"');
{
  const P = (n) => world.jass.players[n];
  const hero = [...world.units.values()].find((u) => u.isHero);
  const type = hero ? hero.typeKey : null;
  const u = type ? world.createUnit(P(0), type, 100, 100, 0) : null;
  if (!u) check('a hero could be built', false);
  else {
    world.setHeroLevel(u, 5);
    const before = u.level, sp = u.skillPoints;
    const ok = world.stripHeroLevel(u, 2);
    check('UnitStripHeroLevel takes the levels back off', ok && u.level === before - 2,
          `${before} -> ${u.level}`);
    check('and the skill points with them', u.skillPoints === Math.max(0, sp - 2),
          `${sp} -> ${u.skillPoints}`);
    check('it never drops below level 1', (world.stripHeroLevel(u, 99), u.level === 1),
          String(u.level));
    // SetUnitPathing(u, false) takes a unit out of collision
    u.pathingOff = true;
    const other = world.createUnit(P(0), type, 100, 100, 0);
    if (other) {
      u.x = 0; u.y = 0; other.x = 1; other.y = 0;
      world.separate([u, other]);
      check('SetUnitPathing(false) leaves a unit where it stands',
            u.x === 0 && u.y === 0, `${u.x},${u.y}`);
      other.alive = false;
    }
    u.pathingOff = false;
    u.alive = false;
  }
  // SetPlayerHandicapXP scales what a hero gains
  const h2 = type ? world.createUnit(P(0), type, 300, 300, 0) : null;
  if (h2) {
    h2.xp = 0; h2.level = 1;
    world.addXp(h2, 100);
    const full = h2.xp;
    world.setHandicapXP(world.jass.players[0], 0.5);
    h2.xp = 0;
    world.addXp(h2, 100);
    check('SetPlayerHandicapXP halves what the hero gains', Math.abs(h2.xp - full * 0.5) < 1e-6,
          `${full} -> ${h2.xp}`);
    world.setHandicapXP(world.jass.players[0], 1);
    h2.alive = false;
  }
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
