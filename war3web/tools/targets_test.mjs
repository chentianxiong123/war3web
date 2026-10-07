// The compiled `targets` field read a column that does not exist.
//
// tools/abilities.py fell back to the SLK's `targs`, and the column is
// targs1..targs4 -- one per level. So the fallback never fired and `targets`
// came out empty for 971 of the 1046 abilities.
//
// That is not cosmetic. isPassive falls through to `targets` when an ability
// declares no order string, and Blizzard writes Order= for only some abilities,
// so an ability with neither was read as PASSIVE and its execute() returned
// before doing anything. Zoro's A03H is the one a player meets: alone among the
// map's three Awfb abilities it sets no atar:1 of its own, so it was the only
// one that never reached the damage fallback its two siblings do.
//
//   node tools/targets_test.mjs        (no server needed)
import fs from 'node:fs';
import path from 'node:path';
import { entry as abilEntry, isPassive } from '../server/abilities.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};

// --------------------------------------------- the column really is targs1
const slk = fs.readFileSync(path.join(ROOT, 'war3_extracted/Units/AbilityData.slk'), 'latin1');
const hdr = {};
for (const line of slk.split('\n')) {
  if (!line.startswith?.call) { /* noop */ }
  if (!line.startsWith('C;')) continue;
  const y = /;Y(\d+)/.exec(line);
  if (y && +y[1] > 1) break;
  const x = /;X(\d+)/.exec(line), k = /;K(.*)/.exec(line.trim());
  if (x && k) hdr[+x[1]] = k[1].replace(/^"|"$/g, '');
}
const cols = Object.values(hdr).filter((c) => /^targs/.test(c));
check('the source has targs1..targs4 and no bare targs', cols.length === 4 && !cols.includes('targs'),
      cols.join(', '));

// --------------------------------------------- the table is populated now
const ab = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/abilities.json'), 'utf8'));
const ids = Object.keys(ab);
const withTargets = ids.filter((k) => (ab[k].targets || '').length);
check('the field is populated rather than empty for nearly everything',
      withTargets.length >= 190, `${withTargets.length} of ${ids.length} carry a target list`);
// '-' and '_' are Blizzard's empty markers in this column. They must never
// survive as if they were a list, or every passive in the file turns castable.
const blanks = ids.filter((k) => ['-', '_'].includes((ab[k].targets || '').trim()));
check('no empty marker is stored as a target list', blanks.length === 0, blanks.slice(0, 5).join(','));
// 'none' is different: it is a value the map WRITES. A06D, the captured Monster
// Ball, sets atar:1 = none itself, and it is not blank -- it says the ability
// targets nothing. It keeps its order string, so it stays castable either way.
const a06d = abilEntry('A06D');
check('an explicit "none" the map wrote is kept, not scrubbed', (a06d.targets || '') === 'none', `"${a06d.targets}"`);
check('and it is still castable, because its order string decides first',
      isPassive(a06d) === false, `order "${a06d.order}"`);

// --------------------------------------------- the ability a player meets
const a03h = abilEntry('A03H');
check('A03H now carries the targets its SLK row states',
      /organic/.test(a03h.targets || ''), `"${a03h.targets}"`);
check('and is no longer read as passive', isPassive(a03h) === false);
// its two siblings were always right, and must stay right
for (const id of ['A00V', 'A00H']) {
  const e = abilEntry(id);
  check(`${id}, which always had targets, is still active`, isPassive(e) === false);
}
// and a real passive must not have become castable
for (const id of ['AInv', 'Aloc']) {
  const e = abilEntry(id);
  check(`${id} is still passive`, isPassive(e) === true);
}

// --------------------------------------------- it delivers its own damage
const { World } = await import('../server/world.js');
const { JassEngine } = await import('../server/jass/engine.js');
const world = new World();
const eng = new JassEngine(world);
eng.load(); eng.boot();
const int = (s) => s.split('').reduce((a, c) => (a << 8) | c.charCodeAt(0), 0) >>> 0;
const creep = [...world.units.values()].find((u) => u.alive && !u.isHero && !u.isBuilding && u.typeKey);
const caster = world.createUnit(eng.players[0], 'H00L', 0, 0, 0);     // Zoro
const victim = world.createUnit(eng.players[6], creep.typeKey, 80, 0, 0);
victim.hp = victim.maxHp = 100000;
const KEY = int('A03H');
world.addAbility(caster, KEY); world.setAbilityLevel(caster, KEY, 2);  // rank 2: Htb1 = 100
const res = world.runAbility(caster, KEY, { target: victim });
check('A03H reaches the damage fallback instead of returning passive',
      !(res && res.reason === 'passive'), JSON.stringify(res));
check('and its own base damage lands', victim.hp < 100000, `${(100000 - victim.hp).toFixed(0)} damage`);

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
