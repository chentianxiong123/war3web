// The map's win conditions and its game modes, end to end.
//
// Three ways this map ends or changes a game: a team reaching 100 hero kills,
// Boss Mulder dying, and the @-mode chat commands. All three used to be
// printed and none asserted, so a run where nothing happened at all was a
// passing run -- and the file named two heroes ('H004', 'E00T') this map does
// not contain, so nothing did happen. Ids now come from tools/testheroes.mjs.
//
// The kill counters are the map's own globals, not the engine scoreboard: the
// death trigger loops players 1..4 into udg_integer04 and 5..8 into
// udg_integer05, and declares at 'd' -- a JASS character literal, so 100.
//
//   node tools/wincond_test.mjs        (no server needed)
import { World } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';
import { testHeroes } from './testheroes.mjs';

const fails = [];
let pass = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fails.push(name); console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
};
const { caster, target } = testHeroes();

function fresh() {
  const w = new World(); const e = new JassEngine(w);
  e.load();
  const vic = [], def = [];
  e.boot();
  const ov = e.vm.natives.get('CustomVictoryBJ'), od = e.vm.natives.get('CustomDefeatBJ');
  e.vm.registerNative('CustomVictoryBJ', (p) => { vic.push(p && p.index); return ov(p); });
  e.vm.registerNative('CustomDefeatBJ', (p, m) => { def.push(p && p.index); return od(p, m); });
  return { w, e, vic, def,
           tick: (s) => { for (let i = 0; i < Math.round(s * 30); i++) { e.update(1000 / 30); w.step(); } } };
}
const buy = (w, e, id, slot) => w.sellUnit(w.tavernFor(id), e.players[slot], id);

// ---------- path 1: the hundredth hero kill, from team 2's side
console.log('\n-- 100 hero kills');
{
  const { w, e, vic, tick } = fresh();
  tick(1);
  const KILLS = e.vm.globals.get('udg_integer05');       // players 5..8's tally
  check('the map declares a team-2 kill counter', !!KILLS, 'udg_integer05');
  if (KILLS) KILLS.value = 99;
  const A = buy(w, e, caster.id, 0);
  const B = buy(w, e, target.id, 5);
  check('both heroes are seated on opposing teams', !!A && !!B && A.team !== B.team,
        `${caster.id} t${A && A.team} vs ${target.id} t${B && B.team}`);
  w.killUnit(A, B);                                     // team 2's kill #100
  tick(7);
  check('the map counts it', KILLS && KILLS.value === 100, KILLS ? `${KILLS.value}` : '-');
  check('and declares victory', vic.length > 0, vic.join(',') || 'none');
  check('for a player on the killing team',
        vic.some((i) => e.players[i] && e.players[i].team === B.team),
        `won ${vic.join(',')}, killer team ${B && B.team}`);
}

// ---------- the map's chat-driven modes
//
// The old version of this file fired '@duel', '@tome', '@nocool', '@fight' and
// '@ar' and printed the result. This map registers none of them: it has
// exactly two chat commands, both on a '-' prefix, and both are Korean words.
// Those five, along with "Boss Mulder" (unit N007, which appears zero times in
// the script) and the heroes "Saber" and "Goku", belong to whatever map this
// file was written for. They are not in this one.
//
// The literal below looks like nonsense because it is: extracted/war3map.j
// contains ZERO bytes above 127 while war3map.wts contains 151736, so the
// script's every non-ASCII byte became '_' somewhere in extraction. That is a
// real defect and it is recorded in TODO.txt -- a player cannot type the
// command the trigger is waiting for. The trigger plumbing itself is fine, and
// that is what this asserts: fire the literal the map registered and the map
// acts on it.
console.log('\n-- chat-driven modes');
{
  const { w, e, tick } = fresh();
  tick(1);
  const chats = [];
  for (const tr of e.triggers) for (const ev of tr.events) if (ev.kind === 'chat') chats.push(ev.chat);
  const distinct = [...new Set(chats)];
  check('the map registers chat commands', distinct.length > 0, distinct.join(' ') || 'none');
  check('all of them on a - prefix, none on @',
        distinct.every((c) => c.startsWith('-')), distinct.join(' '));

  buy(w, e, caster.id, 0);
  const texts = [];
  const ot = e.vm.natives.get('DisplayTimedTextToPlayer');
  e.vm.registerNative('DisplayTimedTextToPlayer', (p, x, y, d, str) => {
    if (str) texts.push(String(str)); return ot(p, x, y, d, str);
  });
  const errs0 = e.errors.length;
  for (const c of distinct) { w.chat(e.players[0], c); tick(2); }
  // Acted on, not merely tolerated: "no errors" alone would pass on a command
  // the engine dropped on the floor.
  check('firing them is acted on', texts.length > 0, `${texts.length} messages`);
  check('and adds no VM errors', e.errors.length === errs0,
        e.errors.slice(errs0).map((x) => x.split('\n')[0])[0] || '');
}

// The boss-death path the old file tested does not exist here: N007 is absent
// and no CustomVictoryBJ call is gated on a dying unit type. This map does gate
// 14 boss ids -- Hamg, Hblm, Hmkg, Hpal, Obla, Ofar, Oshd, Otch, Edem, Ekee,
// Ucrl, Udea, Udre, Ulic -- but on its own spawn progression, and none of them
// is on the field in the first seconds of a match, so it is not reachable from
// a test that boots and stops. Left uncovered deliberately and noted in
// TODO.txt rather than replaced with an assertion that proves nothing.

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
