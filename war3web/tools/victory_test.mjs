// Does the map's own victory condition actually fire?
//
// This map declares victory itself, from its own kill counter, five seconds
// after the threshold is crossed. It used to print whether CustomVictoryBJ had
// been called and exit 0 either way -- so "CustomVictoryBJ called for players:
// NONE" was a passing run. It now fails.
//
// Hero ids come from tools/testheroes.mjs rather than being written down here;
// this file named 'H004' and 'E00T', neither of which is in this map.
//
//   node tools/victory_test.mjs        (no server needed)
import { World, id2int } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';
import { seatTwo } from './testheroes.mjs';

const fails = [];
let pass = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fails.push(name); console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
};

const world = new World();
const eng = new JassEngine(world);
eng.load();
const victories = [];
eng.boot();
eng.vm.registerNative('CustomVictoryBJ', (p) => { victories.push(p && p.index); });
const tick = (s) => { for (let i = 0; i < s * 30; i++) { eng.update(1000 / 30); world.step(); } };
tick(1);

// The threshold is the map's own, not a player score: on a hero death its
// trigger loops players 1..4 and bumps udg_integer04 when the killer is one of
// them, then 5..8 into udg_integer05, and declares victory when either reaches
// 'd' -- a JASS character literal, so 100. tools/audit_fidelity.mjs already
// reports that this map keeps its own counters instead of the engine
// scoreboard; the old version of this test set eng.players[0].score and moved
// nothing. Standing the counter at 99 is the same as having played 99 kills.
const KILLS = eng.vm.globals.get('udg_integer04');
check('the map declares its own team-1 kill counter', !!KILLS, 'udg_integer04');
if (KILLS) KILLS.value = 99;
const { A, B, heroA, heroB } = seatTwo(world, eng);
check('both heroes are seated', !!A && !!B, `${heroA.id} vs ${heroB.id}`);
check('and on opposing teams', A.team !== B.team, `${A.team} vs ${B.team}`);

world.moveUnit(A, B.x + 100, B.y);
const before = KILLS ? KILLS.value : -1;
world.killUnit(B, A);
tick(7);                                   // the map's trigger sleeps 5s first
const after = KILLS ? KILLS.value : -1;

check('the map\'s own trigger counts the kill', after === before + 1,
      `${before} -> ${after}`);
check('and that reaches its 100 threshold', after === 100, `${after}`);
check('and the map declares victory', victories.length > 0,
      victories.length ? victories.join(', ') : 'CustomVictoryBJ never called');
check('for a player on the winning team',
      victories.some((i) => eng.players[i] && eng.players[i].team === A.team),
      `won: ${victories.join(', ')}, killer team ${A.team}`);

// A multiboard, not a leaderboard -- the same trigger that bumps the counter
// writes the tally into it with MultiboardSetItemValueBJ, and the score has to
// be visible somewhere or the mode is unplayable.
const board = eng.scoreboard();
check('the map keeps a populated scoreboard', !!board && board.rows.length > 0,
      board ? `${board.rows.length} rows` : 'no multiboard has any cells');
check('and the kill count reached it',
      !!board && board.rows.some((r) => r.some((c) => /(^|\D)100(\D|$)/.test(c))),
      board ? JSON.stringify(board.rows.slice(0, 3)) : '-');

const errs = [...new Set(eng.errors.map((e) => e.split('\n')[0]))];
check('no VM errors along the way', errs.length === 0, errs.slice(0, 3).join(' | '));

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
