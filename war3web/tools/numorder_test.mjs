// A numeric order used to force-cast a hero's first ability.
//
// The script orders by raw id and OrderId() here is a hash of ours, so the port
// cannot tell one numeric order from another -- TODO.txt records that the table
// which would settle it is not in the MPQs. castDummy is the standing answer:
// run whatever ability the unit holds. Right for a dummy, wrong for a hero.
//
// The map makes the distinction itself, and this test measures it rather than
// asserting it: every numeric order meant to cast is issued to a unit the
// trigger created a line or two above. The only ones aimed elsewhere are the
// aborts. So the gate is "not a hero", derived, not invented.
//
//   node tools/numorder_test.mjs        (no server needed)
import fs from 'node:fs';
import path from 'node:path';
import { World } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};

// ------------------------------------------------- the map's own usage
const src = fs.readFileSync(path.join(ROOT, 'extracted/war3map.formatted.j'), 'utf8').split('\n');
const ord = /Issue(?:Immediate|Target|Point)OrderBy(?:Id|IdLoc)\(([^,]+),\s*(\d+)/g;
const made = /CreateNUnitsAtLoc\w*\([^,]+,'([^']+)'/;
let created = 0, other = 0;
const otherIds = new Set();
for (let i = 0; i < src.length; i++) {
  for (const m of src[i].matchAll(ord)) {
    const who = m[1].trim();
    // "a unit the trigger just made": bj_lastCreatedUnit, or a variable that
    // was assigned from it, with a CreateNUnits above
    let fresh = who === 'bj_lastCreatedUnit';
    if (!fresh && /^udg_unit/.test(who)) {
      const set = new RegExp(`set ${who.replace(/[[\]]/g, '\\$&')}=bj_lastCreatedUnit`);
      fresh = src.some((l) => set.test(l));
    }
    if (fresh) created++; else { other++; otherIds.add(+m[2]); }
  }
}
check('most numeric orders go to a unit the trigger just made', created > 150, `${created} of ${created + other}`);
check('and the rest use only a couple of distinct ids', otherIds.size <= 3,
      [...otherIds].sort().join(', '));
check('851972, the abort, is among them and is never used on a fresh unit',
      otherIds.has(851972), [...otherIds].join(','));

// ------------------------------------------------- a hero is not force-cast
const world = new World();
const eng = new JassEngine(world);
eng.load(); eng.boot();
const hero = world.createUnit(eng.players[0], 'H00N', 0, 0, 0);   // Byakuya: A02F granted at creation
check('the hero carries a castable ability from creation', hero.abilities.size > 0,
      [...hero.abilities.keys()].length + ' abilities');
const at = { x: hero.x, y: hero.y };
hero.mana = hero.maxMana = 1000;
const moved = () => Math.hypot(hero.x - at.x, hero.y - at.y);
const r = world.order(hero, { type: 851972 });
check('the abort order is accepted', r === true);
check('and the hero did NOT teleport', moved() < 1, `${moved().toFixed(0)} units`);
check('it stopped him instead', hero.order && hero.order.type === 'idle', JSON.stringify(hero.order));
check('and left him no path', !hero.path);

// a cast in progress is still broken off, which interruptCast always did
const KEY = [...hero.abilities.keys()][0];
world.castAbility(hero, KEY, null, 200, 0);
const casting = !!hero.cast;
world.order(hero, { type: 851972 });
check('a cast in progress is still interrupted', casting && !hero.cast);

// ------------------------------------------------- a dummy still casts
const dummy = world.createUnit(eng.players[0], 'h016', 300, 300, 0);
const int = (s) => s.split('').reduce((a, c) => (a << 8) | c.charCodeAt(0), 0) >>> 0;
const A03W = int('A03W');                       // AHtb, 2000 damage, what the map adds
world.addAbility(dummy, A03W); world.setAbilityLevel(dummy, A03W, 1);
const creep = [...world.units.values()].find((u) => u.alive && !u.isHero && !u.isBuilding
                                                 && world.hostile(dummy, u));
check('a victim exists for the dummy', !!creep);
const hp0 = creep.hp;
const dr = world.order(dummy, { type: 852095, target: creep });
check('the dummy still casts on a numeric order', dr === true);
check('and its payload lands', creep.hp < hp0, `${hp0.toFixed(0)} -> ${creep.hp.toFixed(0)}`);

const failed = results.filter((x) => !x.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
