// Does Senbonzakura spawn petals, or just deal a number?
//
// A00T is base AUls, Crypt Lord's Locust Swarm, and the swarm IS the spell.
// AbilityMetaData's Uls1..Uls5 resolve through WorldEditStrings to Number of
// Swarm Units, Unit Release Interval, Max Swarm Units Per Target, Damage
// Return Factor and Damage Return Threshold -- so data1 is the count and data3
// is the per-target cap.  AbilityAudit.txt had those two the wrong way round,
// and the engine had it worse: the AUls case passed data1 to w.damage, dealing
// the petal COUNT as damage in one invisible pulse.
//
// The assertion that matters is that units exist and carry their own attack --
// the damage has to come from the petals' unit type, not from a figure of
// ours, or this is the same bug with more steps.
//
//   node tools/swarm_test.mjs        (no server needed)
import fs from 'node:fs';
import path from 'node:path';
import { ABILS, execute, levelInfo } from '../server/abilities.js';
import { World } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

// ---- the fields, against Blizzard's own labels rather than a comment
const meta = fs.readFileSync(path.join(ROOT, 'war3_extracted/Units/AbilityMetaData.slk'), 'latin1');
const wes = fs.readFileSync(path.join(ROOT, 'war3_extracted/UI/WorldEditStrings.txt'), 'latin1');
const labelOf = (field) => {
  const m = meta.match(new RegExp(`K"${field}"(.{0,400})`, 's'));
  const ws = m && m[1].match(/K"(WESTRING_AEVAL_\w+)"/);
  const t = ws && wes.match(new RegExp(`${ws[1]}=(.*)`));
  return t ? t[1].trim() : '';
};
check('data1 is the number of swarm units', labelOf('Uls1') === 'Number of Swarm Units', labelOf('Uls1'));
check('data2 is the release interval', /Release Interval/.test(labelOf('Uls2')), labelOf('Uls2'));
check('data3 is the per-target cap, not the count',
      labelOf('Uls3') === 'Max Swarm Units Per Target', labelOf('Uls3'));

const A = ABILS.A00T;
check('A00T is a Locust Swarm with ten ranks', A.base === 'AUls' && A.levels.length === 10,
      `${A.base}, ${A.levels.length} levels`);
const L1 = levelInfo(A, 1), L6 = levelInfo(A, 6);
check('rank 1 releases 50 uloc, rank 6 releases 100 u000',
      L1.data1 === 50 && L1.unit === 'uloc' && L6.data1 === 100 && L6.unit === 'u000',
      `${L1.data1} ${L1.unit} / ${L6.data1} ${L6.unit}`);
check('one every 0.05 seconds at both', L1.data2 === 0.05 && L6.data2 === 0.05, `${L1.data2}s`);
check('the per-target cap is 12', L1.data3 === 12 && L6.data3 === 12, `${L1.data3}`);

// the petals' own attack is where the damage comes from
const types = read('data/unittypes.json');
check('both petal types exist and carry an attack',
      !!types.uloc && !!types.u000 && (types.uloc.dmgBase > 0) && (types.u000.dmgBase > 0),
      `uloc ${types.uloc?.dmgBase}, u000 ${types.u000?.dmgBase}`);
check('and they are locusts', (types.uloc.abilities || []).includes('Aloc') &&
      (types.u000.abilities || []).includes('Aloc'), 'Aloc on both');

// the map does not touch any of this itself
const mapj = fs.readFileSync(path.join(ROOT, 'extracted/war3map.j'), 'utf8');
check('the script never spawns the petals', !mapj.includes('uloc') && !mapj.includes('u000'),
      '0 references');

// ---- the behaviour
const world = new World();
const eng = new JassEngine(world);
eng.load(); eng.boot();
const STEP = 1000 / 30;
for (let i = 0; i < 30; i++) { eng.update(STEP); world.step(); }
const hero = [...world.units.values()].find((u) => u.isHero && u.alive);
check('there is a caster', !!hero, hero ? hero.typeKey : 'none');

const alive = () => [...world.units.values()].filter((u) => u.typeKey === 'uloc' && u.alive);
const hpBefore = new Map([...world.units.values()].filter((u) => u.alive).map((u) => [u.id, u.hp]));
const r = execute(world, hero, A, 1, { x: hero.x, y: hero.y });
check('casting it reports a swarm rather than a damage pulse',
      r.ok === true && r.summoned === 50, JSON.stringify(r));
check('and nothing was damaged on the instant',
      [...world.units.values()].every((u) => !hpBefore.has(u.id) || u.hp >= hpBefore.get(u.id)),
      'no instant pulse');

let peak = 0, peakAt = 0;
for (let i = 0; i < 260; i++) {
  eng.update(STEP); world.step();
  const n = alive().length;
  if (n > peak) { peak = n; peakAt = i / 30; }
}
check('all fifty petals are released', peak === 50, `${peak} at ${peakAt.toFixed(2)}s`);
check('over the interval the data gives', Math.abs(peakAt - 50 * 0.05) < 0.5,
      `${peakAt.toFixed(2)}s against 2.50s`);
check('and they are gone when the duration runs out', alive().length === 0,
      `${alive().length} left after 8.6s`);

// A locust must not pull the lane onto itself -- the one piece of this taken
// on engine knowledge rather than from the files, so it is asserted explicitly.
const world2 = new World();
const eng2 = new JassEngine(world2); eng2.load(); eng2.boot();
for (let i = 0; i < 30; i++) { eng2.update(STEP); world2.step(); }
const h2 = [...world2.units.values()].find((u) => u.isHero && u.alive);
execute(world2, h2, A, 1, { x: h2.x, y: h2.y });
for (let i = 0; i < 120; i++) { eng2.update(STEP); world2.step(); }
const petal = [...world2.units.values()].find((u) => u.typeKey === 'uloc' && u.alive);
check('a petal is marked a locust', !!petal && world2.isLocust(petal), petal ? 'yes' : 'no petal');
const hunting = [...world2.units.values()].filter((u) => u.alive && u.order &&
  u.order.type === 'attack' && world2.isLocust(world2.target(u.order.targetId)));
check('and nothing has acquired one', hunting.length === 0, `${hunting.length} units targeting petals`);

const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} checks passed`);
process.exit(bad ? 1 : 0);
