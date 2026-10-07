// Three stub natives that a player would notice, and whether they now do it.
//
// All three were `() => {}` and were found by tools/stub_audit.mjs, which ranks
// every empty-bodied native by how many of the map's call sites reach it:
//
//   PanCameraToTimed   39 sites, one per trigger -- every scripted camera move
//   SetUnitTimeScale   36 sites -- hastes, slows, and two that freeze at 0
//   the cine filter     5 displays over 41 setter calls -- the full-screen wash
//
// The camera one carries a trap worth stating. The map never calls the native:
// all 39 go through Blizzard.j's PanCameraToTimedLocForPlayer, whose body is
// wrapped in `if GetLocalPlayer() == whichPlayer`. There is no local player on a
// shared authoritative server -- GetLocalPlayer answers Player(0) -- so that
// gate silently drops 38 of the 39 before the native is reached, and
// implementing the native alone would have looked done and shown nothing. The
// engine overrides the BJ instead, which works because vm.call() checks natives
// before JASS functions.
//
// That is also why this drives everything through vm.call rather than
// vm.runFunction: runFunction goes straight to the JASS body and would miss the
// override, which is exactly the mistake that hid the bug the first time.
//
//   node tools/cosmetic_test.mjs        (no server needed)
import { World } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};

const world = new World();
const eng = new JassEngine(world);
eng.load();
eng.boot();
for (let i = 0; i < 150; i++) eng.update(1000 / 30);
eng.flushClientEvents();

/** The path a `call` in war3map.j takes: natives first, then JASS bodies. */
const run = (name, args) => {
  const g = eng.vm.call(name, args, {});
  let r = g.next();
  while (!r.done) r = g.next();
};
const drain = () => eng.flushClientEvents();

// ------------------------------------------------------------- time scale
const unit = [...world.units.values()].find((u) => u.alive);
// Blizzard.j's SetUnitTimeScalePercent divides by 100, so 50% arrives as 0.5
run('SetUnitTimeScalePercent', [unit, 50]);
const ts = drain().find((e) => e.t === 'timeScale');
check('a hasted unit reports the multiplier, not the percentage',
      !!ts && ts.s === 0.5 && ts.id === unit.id,
      ts ? JSON.stringify(ts) : 'nothing emitted');

run('SetUnitTimeScalePercent', [unit, 0]);
const frozen = drain().find((e) => e.t === 'timeScale');
// two of the map's 36 sites pass 0, and a frozen unit is a state, not a no-op
check('and zero is carried through rather than treated as unset',
      !!frozen && frozen.s === 0, frozen ? JSON.stringify(frozen) : 'nothing emitted');

// ----------------------------------------------------------------- camera
run('PanCameraToTimedLocForPlayer', [eng.players[3], { x: 512, y: -256 }, 1.5]);
const pan = drain().find((e) => e.t === 'panCamera');
check('a camera pan survives Blizzard.j\'s GetLocalPlayer gate',
      !!pan, pan ? JSON.stringify(pan) : 'dropped -- the BJ override is not taking');
check('and keeps the player it was aimed at, so it is not shown to everyone',
      !!pan && pan.player === 3 && pan.x === 512 && pan.y === -256 && pan.dur === 1.5,
      pan ? `player ${pan.player} to ${pan.x},${pan.y} over ${pan.dur}s` : '');

// A second player's pan must differ. Reaching the native directly would give
// both the same answer, because GetLocalPlayer is a constant here.
run('PanCameraToTimedLocForPlayer', [eng.players[6], { x: -900, y: 100 }, 2 ]);
const pan2 = drain().find((e) => e.t === 'panCamera');
check('a pan for a different player is a different pan',
      !!pan2 && pan2.player === 6 && pan2.x === -900,
      pan2 ? `player ${pan2.player} to ${pan2.x},${pan2.y}` : 'nothing emitted');

// ------------------------------------------------------------ cine filter
// CinematicFadeBJ type 2 is FADEOUTIN, which halves the duration and runs the
// fade out first; the colour is 100,30,30 percent and transparency 50.
run('CinematicFadeBJ',
    [2, 0.5, 'ReplaceableTextures\\CameraMasks\\White_mask.blp', 100, 30, 30, 50]);
const cf = drain().find((e) => e.t === 'cineFilter');
check('a cinematic fade is assembled over its setters and sent once',
      !!cf, cf ? '' : 'nothing emitted');
// PercentTo255: 100 -> 255, 30 -> 76. Transparency 50 becomes alpha 127.
check('its colour is the map\'s, through PercentTo255',
      !!cf && JSON.stringify(cf.from.slice(0, 3)) === JSON.stringify([255, 76, 76]),
      cf ? `rgb ${cf.from.slice(0, 3)}` : '');
check('and it runs from clear to the requested transparency',
      !!cf && cf.from[3] === 0 && cf.to[3] === 127,
      cf ? `alpha ${cf.from[3]} -> ${cf.to[3]} over ${cf.dur}s` : '');
check('the texture it names is carried, not dropped',
      !!cf && /White_mask/.test(cf.tex || ''), cf ? cf.tex : '');

run('DisplayCineFilter', [false]);
check('and turning it off retracts it',
      drain().some((e) => e.t === 'cineFilterOff'));

// ------------------------------------------------------- still no-ops, honestly
// The point of stub_audit is that an empty body is invisible, so the things
// still empty are named here rather than left to be rediscovered.
const stillStub = ['SetDayNightModels', 'SetTerrainFogEx', 'TerrainDeformRipple',
                   'SetMapMusic', 'EnableUserUI'];
const nat = eng.vm.natives;
check('the ones not done are still present and callable, not missing',
      stillStub.every((n) => typeof nat.get(n) === 'function'),
      stillStub.filter((n) => typeof nat.get(n) !== 'function').join(', ') || stillStub.join(', '));

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
