// A declared-but-unimplemented native answered false forever, and a JASS
// condition that is always false fails closed without a word.
//
// IsUnitIllusion is declared in common.j, wrapped by Blizzard.j, and was
// implemented nowhere. Itachi's 사륜안 (A03Y) is built entirely on it: its
// trigger enumerates units near the target point through a filter that is
// "enemy AND illusion", and marks each one. With the native false for every
// unit the group was always empty, so a 30-second-cooldown ability marked
// nothing and did nothing but play a puff of art.
//
// The answer needed nothing from the archives: this engine creates illusions
// itself. world.summon takes { image: true } for the Mirror Image family and
// stamps the flag there, with the damage-dealt and damage-taken factors that
// are the only difference between an image and the hero.
//
//   node tools/illusion_test.mjs        (no server needed)
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

// the premise: the map really does gate this ability on the native
const src = fs.readFileSync(path.join(ROOT, 'extracted/war3map.formatted.j'), 'utf8');
check('the map calls IsUnitIllusion at all', /IsUnitIllusion/.test(src),
      `${(src.match(/IsUnitIllusion/g) || []).length} call(s)`);
check('and the engine no longer leaves it unimplemented',
      /IsUnitIllusion/.test(fs.readFileSync(path.join(ROOT, 'server/jass/engine.js'), 'utf8')));

const world = new World();
const eng = new JassEngine(world);
eng.load(); eng.boot();
const N = (n) => eng.vm.natives.get(n);
check('the native is registered', typeof N('IsUnitIllusion') === 'function');

// the interpreter reports what it could not implement; this must not be on it
check('and is no longer counted as unimplemented',
      !(eng.unimplemented && [...(eng.unimplemented.keys ? eng.unimplemented.keys() : eng.unimplemented)]
        .some((k) => String(k) === 'IsUnitIllusion')),
      'not in eng.unimplemented');

const creep = [...world.units.values()].find((u) => u.alive && !u.isHero && !u.isBuilding && u.typeKey);
const owner = eng.players[0];
const plain = world.createUnit(owner, creep.typeKey, 0, 0, 0);
check('an ordinary unit is not an illusion', N('IsUnitIllusion')(plain) === false);
check('and neither is null', N('IsUnitIllusion')(null) === false);

// an image, made the way the Mirror Image case makes one
const hero = world.createUnit(owner, 'H02A', 100, 0, 0);        // Kisame, whose A06A is AOmi
const image = world.summon(hero, hero.typeKey, 120, 0, 20, { image: true, dealt: 1, taken: 1.5 });
check('the engine can make an illusion', !!image, image ? image.typeKey : 'none');
check('and the native now says so', N('IsUnitIllusion')(image) === true);
check('the image carries the factors that define it',
      image && image.damageTakenMul === 1.5, `takes x${image?.damageTakenMul}`);
check('the hero it copied is still not an illusion', N('IsUnitIllusion')(hero) === false);

// the shape the map's filter needs: enemy AND illusion
const foe = eng.players[6];
const enemyHero = world.createUnit(foe, 'H02A', 400, 0, 0);
const enemyImage = world.summon(enemyHero, enemyHero.typeKey, 420, 0, 20, { image: true, dealt: 1, taken: 1.5 });
const itachi = world.createUnit(owner, 'H00K', 380, 0, 0);
check('an enemy illusion is both enemy and illusion',
      N('IsUnitIllusion')(enemyImage) === true && world.hostile(itachi, enemyImage));
check('an enemy that is NOT an illusion fails the same filter',
      N('IsUnitIllusion')(enemyHero) === false && world.hostile(itachi, enemyHero));

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
