// Two bases that were in no routing table, and the shapes they were losing.
//
// AbilityData.slk's `code` column is the map editor's own answer to "whose
// fields does this row use". Where `code` differs from `alias`, the row IS the
// other ability -- that is what justified the existing ANcf -> ANbf line, and
// these two are the same shape:
//
//   ACca  code AUcs, "Carrion Swarm (creep)"  -- Uryu's A04L
//   ANsb  code AHtb, "Rexxar - Storm Bolt"    -- Shiki's A05H
//
// Neither was in BASE_ALIAS or HANDLED_BASES, so both fell to the generic
// fallback: one damage number, once, in a disc. Asserted on the SHAPE, since
// the per-unit damage was never the thing that differed.
//
//   node tools/aliasfix_test.mjs        (no server needed)
import fs from 'node:fs';
import path from 'node:path';
import { World } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';
import { baseOf, entry as abilEntry } from '../server/abilities.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};

// ------------------------------------------------------- the map's own claim
const slk = fs.readFileSync(path.join(ROOT, 'war3_extracted/Units/AbilityData.slk'), 'latin1');
const rows = {};
let cur = 0;
for (const line of slk.split('\n')) {
  if (!line.startsWith('C;')) continue;
  const y = /;Y(\d+)/.exec(line), x = /;X(\d+)/.exec(line), k = /;K(.*)$/.exec(line.trim());
  if (y) cur = +y[1];
  if (x && k) (rows[cur] ||= {})[+x[1]] = k[1].replace(/^"|"$/g, '');
}
const hdr = rows[1] || {};
const colOf = (n) => Object.keys(hdr).find((i) => hdr[i] === n);
const cAlias = colOf('alias'), cCode = colOf('code');
const codeFor = (a) => Object.values(rows).find((r) => r[cAlias] === a)?.[cCode];
check('the map says ACca uses Carrion Swarm\'s fields', codeFor('ACca') === 'AUcs', `code=${codeFor('ACca')}`);
check('and that ANsb uses Storm Bolt\'s', codeFor('ANsb') === 'AHtb', `code=${codeFor('ANsb')}`);
check('both are routed there now', baseOf({ base: 'ACca' }) === 'AUcs' && baseOf({ base: 'ANsb' }) === 'AHtb',
      `${baseOf({ base: 'ACca' })} / ${baseOf({ base: 'ANsb' })}`);

const world = new World();
const eng = new JassEngine(world);
eng.load(); eng.boot();
const P = eng.players[0], E = eng.players[6];
const creep = [...world.units.values()].find((u) => u.alive && !u.isHero && !u.isBuilding && u.typeKey);
const spawn = (x, y) => world.createUnit(E, creep.typeKey, x, y, 0);
const int = (s) => s.split('').reduce((a, c) => (a << 8) | c.charCodeAt(0), 0) >>> 0;

// ------------------------------------------------- ACca: a line, not a disc
// A04L: data3 = 800 distance, data4 = 125 half-width. A row of targets down
// the line and one off to the side settles the shape by itself.
const a04l = abilEntry('A04L');
check('A04L carries a distance and a width to be read', !!a04l && a04l.levels[0].data3 === 800 && a04l.levels[0].data4 === 125,
      `d3=${a04l?.levels[0].data3} d4=${a04l?.levels[0].data4}`);
const caster = world.createUnit(P, creep.typeKey, 0, 0, 0);
caster.invulnerable = true;
const far = spawn(600, 0);        // down the line, far beyond any 100-radius disc
const near = spawn(150, 0);       // down the line, close
const side = spawn(150, 400);     // well outside the 125 half-width
for (const u of [far, near, side]) u.hp = u.maxHp = 100000;
world.runAbility(caster, int('A04L'), { x: 800, y: 0 });
check('ACca hits a target 600 units down the line', far.hp < 100000, `${(100000 - far.hp).toFixed(0)} damage`);
check('and one close in', near.hp < 100000, `${(100000 - near.hp).toFixed(0)} damage`);
check('but not one 400 units off to the side', side.hp === 100000,
      side.hp === 100000 ? 'untouched' : `${(100000 - side.hp).toFixed(0)} damage`);

// ------------------------------------------------- ANsb: the stun it dropped
const a05h = abilEntry('A05H');
check('A05H declares a stun the map kept', !!a05h && a05h.levels[0].heroDuration === 3 && a05h.levels[0].duration === 5,
      `hero ${a05h?.levels[0].heroDuration}s / unit ${a05h?.levels[0].duration}s`);
const hero = [...world.units.values()].find((u) => u.isHero && u.alive)
          || world.createUnit(E, 'H00M', 900, 900, 0);
const target = spawn(300, 300);
target.hp = target.maxHp = 500000;
check('the target is not stunned to begin with', !world.stunned(target));
world.runAbility(caster, int('A05H'), { target });
check('ANsb deals its damage', target.hp < 500000, `${(500000 - target.hp).toFixed(0)} of 7000`);
check('and now applies the stun the fallback dropped', world.stunned(target), 'stunned');
const buffs = (target.buffs || []).map((b) => b.code).filter(Boolean);
check('stamped with the buff the map names', buffs.includes('B00R'), buffs.join(',') || 'none');

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
