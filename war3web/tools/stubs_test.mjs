// The stub natives that were reached and did nothing: the ones now answered.
//
// tools/stub_audit.mjs ranks natives whose body is empty by how many of the
// map's call sites reach them. This covers the four that a player could see
// and the one that only a raw caller could: the match-start cinematic, the map
// handing a player a swapped hero, a queued animation, a sound's own row
// volume, and the game-state clock. Each is asserted at the layer that can
// fail -- the event the engine emits, the room re-pointing a player, the row
// value on the sound handle -- with the map's own call sites checked first so
// a fix cannot pass against a premise that is not in the script.
//
//   node tools/stubs_test.mjs        (no server needed)
import fs from 'node:fs';
import path from 'node:path';
import { World } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';
import { Room } from '../server/room.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};
const count = (src, re) => (src.match(re) || []).length;

// ------------------------------------------------------------ the premise
const mapj = fs.readFileSync(path.join(ROOT, 'extracted/war3map.j'), 'utf8');
check('the map selects a unit for a player four times',
      count(mapj, /call SelectUnitForPlayerSingle\(/g) === 4);
check('and opens and closes cinematic mode once each',
      count(mapj, /call CinematicModeBJ\(true,/g) === 1 && count(mapj, /call CinematicModeBJ\(false,/g) === 1);
check('queues "stand" after a scripted "spell" twice',
      count(mapj, /call QueueUnitAnimation\([^,]+,"stand"\)/g) === 2);
check('and names three sound labels',
      count(mapj, /call SetSoundParamsFromLabel\(/g) === 3
      && /"ChatroomTimerTick"/.test(mapj) && /"QuestNew"/.test(mapj) && /"CreditsMusic"/.test(mapj));

// ------------------------------------------------------------ the natives
const world = new World();
const eng = new JassEngine(world);
eng.load(); eng.boot();
eng.flushClientEvents();
const N = (n) => eng.vm.natives.get(n);
const drain = (t) => eng.flushClientEvents().filter((e) => e.t === t);

// the clock has one answer whichever native asks
const TOD = N('ConvertFGameState')(2);
check('GetFloatGameState reads the same clock as GetTimeOfDay',
      N('GetFloatGameState')(TOD) === N('GetTimeOfDay')(), `${N('GetFloatGameState')(TOD)}`);
N('SetFloatGameState')(TOD, 6.5);
check('and SetFloatGameState turns it', N('GetTimeOfDay')() === 6.5, `${N('GetTimeOfDay')()}`);
check('other game states stay at zero', N('GetFloatGameState')(N('ConvertFGameState')(1)) === 0);

// a sound's row volume
const snd = N('CreateSound')('Sound\\Interface\\BattleNetTick.wav', false, false, false, 10, 10, '');
check('a fresh sound plays at full volume', snd.volume === 127 && snd.pitch === 1);
N('SetSoundParamsFromLabel')(snd, 'ChatroomTimerTick');
check('ChatroomTimerTick sets the row\'s 80 of 127', snd.volume === 80 && snd.pitch === 1, `${snd.volume}`);
const cred = N('CreateSound')('Sound\\Music\\mp3Music\\Credits.mp3', false, false, false, 10, 10, '');
N('SetSoundParamsFromLabel')(cred, 'CreditsMusic');
check('CreditsMusic, from DialogSounds rather than UISounds, sets 120', cred.volume === 120, `${cred.volume}`);
const unk = N('CreateSound')('x.wav', false, false, false, 10, 10, '');
N('SetSoundParamsFromLabel')(unk, 'NoSuchLabel');
check('an unknown label leaves the sound alone', unk.volume === 127);
N('StartSound')(snd);
const played = drain('sound');
check('and the row volume reaches the client scaled to 0..1',
      played.length === 1 && Math.abs(played[0].vol - 80 / 127) < 1e-9, `${played[0]?.vol}`);

// a queued animation
const anyUnit = [...world.units.values()].find((u) => u.alive);
N('QueueUnitAnimation')(anyUnit, 'stand');
const q = drain('animQueue');
check('QueueUnitAnimation reaches the client with the unit and the name',
      q.length === 1 && q[0].id === anyUnit.id && q[0].name === 'stand');

// cinematic mode, for the force it names
const force = N('CreateForce')();
N('ForceEnumPlayers')(force, null);
N('CinematicModeBJ')(true, force);
const on = drain('cinematic');
check('CinematicModeBJ(true) opens it for every player in the force',
      on.length === 1 && on[0].on === true && on[0].fade === 0.5
      && Array.isArray(on[0].players) && on[0].players.length === 12 && on[0].players.includes(0),
      JSON.stringify(on[0]));
N('CinematicModeBJ')(false, force);
const off = drain('cinematic');
check('and (false) closes it', off.length === 1 && off[0].on === false);

// the map handing a player a unit
const p0 = eng.players[0];
N('SelectUnitForPlayerSingle')(anyUnit, p0);
const sel = drain('select');
check('SelectUnitForPlayerSingle names the player and the unit',
      sel.length === 1 && sel[0].player === 0 && sel[0].id === anyUnit.id);

// ------------------------------------------------------------ the room
// Yusuke's transformation makes a NEW unit and removes the old one. Warcraft
// III's SelectUnit is the moment the player is handed the new one; here it is
// the moment the room re-points the player's hero.
const room = new Room('stubs');
const ws = () => ({ readyState: 1, out: [], send(s) { this.out.push(JSON.parse(s)); } });
const wa = ws(), wb = ws();
const pa = room.join(wa, 'Alpha');
const pb = room.join(wb, 'Bravo');
const heroId = pa.heroId || (JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/game.json'), 'utf8')).heroes[0].id);
room.handle(pa, { t: 'pickHero', heroId });
room.handle(pb, { t: 'pickHero', heroId });
room.handle(pa, { t: 'ready', ready: true });
room.handle(pb, { t: 'ready', ready: true });
clearInterval(room.loop); room.loop = null;
check('the room started and seated both heroes',
      room.phase === 'playing' && pa.entId != null && pb.entId != null, `${room.phase} ${pa.entId} ${pb.entId}`);
const W = room.world, R = room.eng;
const ha = W.units.get(pa.entId), hb = W.units.get(pb.entId);
const own = R.players[pa.slot];
// the new form, as the script makes it: the same owner, a hero type
const demon = W.createUnit(own, 'Eidm', ha.x + 64, ha.y, 0);
check('a new hero unit exists for the same player', !!demon && demon.isHero && demon.playerIndex === pa.slot);
R.vm.natives.get('SelectUnitForPlayerSingle')(demon, own);
room.stepLoop();
check('selecting it for the player re-points the player at it', pa.entId === demon.id, `${pa.entId} vs ${demon.id}`);
check('and the hero card follows', wa.out.some((m) => m.t === 'hero' && m.h && m.h.id === demon.id));
// what it must not do
R.vm.natives.get('SelectUnitForPlayerSingle')(hb, own);
room.stepLoop();
check('another player\'s hero is never handed across', pa.entId === demon.id);
const creep = [...W.units.values()].find((u) => u.alive && !u.isHero && u.playerIndex === pa.slot)
           || W.createUnit(own, [...W.units.values()].find((u) => !u.isHero && !u.isBuilding).typeKey, ha.x, ha.y + 64, 0);
R.vm.natives.get('SelectUnitForPlayerSingle')(creep, own);
room.stepLoop();
check('nor a unit that is not a hero', pa.entId === demon.id);
R.vm.natives.get('SelectUnitForPlayerSingle')(ha, own);
room.stepLoop();
check('selecting the old form again hands it back', pa.entId === ha.id);
clearTimeout(room.resetTimer);

// ------------------------------------------------------------ the countdown, as the map runs it
// The duel fires on a 290-310 s timer (tools/duel_test.mjs) and opens with
// CinematicModeBJ(true), three ticks, "Fight !!" and CinematicModeBJ(false).
// Stepped in-process rather than watched in a browser, which is what makes a
// five-minute wait affordable, and asserted on what the engine hands the
// client: the mode, the ticks at the row's 80 of 127, the close.
{
  const w2 = new World();
  const e2 = new JassEngine(w2);
  e2.load();
  for (const slot of [0, 4]) { const p = e2.players[slot]; p.slotState = 1; p.controller = 0; p.name = 'P' + slot; }
  e2.boot();
  w2.createUnit(e2.players[0], 'H00N', 0, 0, 0);
  w2.createUnit(e2.players[4], 'H00B', 0, 0, 0);
  const log = [];
  let opened = null;
  for (let i = 0; i < 330 * 30 && (opened == null || w2.now < opened + 12000); i++) {
    e2.update(1000 / 30); w2.step();
    for (const ev of e2.flushClientEvents()) {
      if (ev.t === 'cinematic' || ev.t === 'sound') log.push({ at: w2.now, ...ev });
      if (ev.t === 'cinematic' && ev.on && opened == null) opened = w2.now;
    }
  }
  const cine = log.filter((e) => e.t === 'cinematic');
  check('the duel opens in cinematic mode within the timer',
        opened != null && cine[0].on === true && cine[0].players.includes(0) && cine[0].players.includes(4),
        opened == null ? 'never opened in 330 s' : `at ${(opened / 1000).toFixed(0)} s`);
  const closed = cine.find((e) => !e.on && e.at > opened);
  check('and closes it after the countdown',
        !!closed && closed.at - opened > 4000 && closed.at - opened < 12000,
        closed ? `${((closed.at - opened) / 1000).toFixed(1)} s later` : 'never closed');
  const inside = log.filter((e) => e.t === 'sound' && e.at >= opened && closed && e.at <= closed.at);
  const ticks = inside.filter((e) => /battlenettick/i.test(e.path));
  const sting = inside.filter((e) => /questnew/i.test(e.path));
  check('the three countdown ticks play at the row\'s 80 of 127',
        ticks.length === 3 && ticks.every((e) => Math.abs(e.vol - 80 / 127) < 1e-9),
        `${ticks.length} ticks, vol ${ticks.map((e) => e.vol.toFixed(3)).join('/')}`);
  check('and so does the "Fight !!" sting',
        sting.length === 1 && Math.abs(sting[0].vol - 80 / 127) < 1e-9, `${sting.length} at ${sting[0]?.vol?.toFixed(3)}`);
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
