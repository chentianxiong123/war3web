// Do critical strikes and evasion happen at all?
//
// ACct, ANdb and AOcr share one field set -- AbilityMetaData's useSpecific
// column names exactly those three against Ocr1..Ocr5, and WorldEditStrings
// reads them Chance to Critical Strike, Damage Multiplier, Damage Bonus,
// Chance to Evade.  The two ranges settle the units without inference: minVal
// 0 / maxVal 100 on the chance, 0 / 1 on the evade.
//
// Ten of the audit's thirteen dead abilities were these bases.  Alucard's five
// hellhounds had no crit, Itachi and Shiki had neither crit nor evade.
//
// Two things this pins that would be easy to get wrong:
//   - A051 블러디 어택 must never proc from the engine.  Its Ocr1 is overridden
//     to 0 because the map runs that proc itself in war3map.j on
//     EVENT_PLAYER_UNIT_ATTACKED, which world.js already fires.  No special
//     case is needed for that -- a chance of zero cannot fire -- but if
//     someone ever "fixes" the zero, this fails.
//   - the multiplier goes on the swing before damage() reads armour, because a
//     crit is struck before armour, not after.
//
//   node tools/proc_test.mjs        (no server needed)
import fs from 'node:fs';
import path from 'node:path';
import { ABILS, attackProcs, levelInfo } from '../server/abilities.js';
import { World } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};

// ---- the labels and the ranges, from Blizzard's files
const meta = fs.readFileSync(path.join(ROOT, 'war3_extracted/Units/AbilityMetaData.slk'), 'latin1');
const wes = fs.readFileSync(path.join(ROOT, 'war3_extracted/UI/WorldEditStrings.txt'), 'latin1');
const blob = (f) => (meta.match(new RegExp(`K"${f}"(.{0,400})`, 's')) || [, ''])[1];
const labelOf = (f) => {
  const ws = blob(f).match(/K"(WESTRING_AEVAL_\w+)"/);
  const t = ws && wes.match(new RegExp(`${ws[1]}=(.*)`));
  return t ? t[1].trim() : '';
};
check('Ocr1 is a crit chance', labelOf('Ocr1') === 'Chance to Critical Strike', labelOf('Ocr1'));
check('Ocr2 is the multiplier', labelOf('Ocr2') === 'Damage Multiplier', labelOf('Ocr2'));
check('Ocr4 is an evade chance', labelOf('Ocr4') === 'Chance to Evade', labelOf('Ocr4'));
check('and the three bases share them',
      /K"AOcr,ACct,ANdb"/.test(blob('Ocr1')), 'useSpecific AOcr,ACct,ANdb');

// ---- the numbers each ability carries
const at = (id, lv = 1) => levelInfo(ABILS[id], lv);
check('the hellhounds run 20% x2 up to 60% x4',
      at('A032').data1 === 20 && at('A032').data2 === 2 &&
      at('A035').data1 === 60 && at('A035').data2 === 4,
      `A032 ${at('A032').data1}%/x${at('A032').data2}, A035 ${at('A035').data1}%/x${at('A035').data2}`);
check('Itachi and Shiki carry crit and evade together',
      at('A02W').data1 === 5 && at('A02W').data4 === 0.07 &&
      at('A066').data1 === 8 && at('A066').data4 === 0.07,
      `A02W ${at('A02W').data1}%/${at('A02W').data4}, A066 ${at('A066').data1}%/${at('A066').data4}`);
check('nothing here uses the flat damage bonus',
      ['A031', 'A032', 'A02W', 'A066', 'A051'].every((id) => !at(id).data3), 'Ocr3 is 0 throughout');

// ---- A051 is the trap
const mapj = fs.readFileSync(path.join(ROOT, 'extracted/war3map.j'), 'utf8');
check('A051\'s engine chance is deliberately zero', at('A051').data1 === 0, `${at('A051').data1}`);
check('because the map procs it itself on ATTACKED',
      mapj.includes("GetUnitTypeId(GetAttacker())=='n012'") &&
      mapj.includes('EVENT_PLAYER_UNIT_ATTACKED'), 'n012 attack trigger present');

// ---- the table
const W = { abilKey: (k) => k };
const procOf = (id) => attackProcs(W, { abilities: new Map([[id, 1]]) });
check('the table reads a hellhound', procOf('A032').chance === 20 && procOf('A032').mult === 2,
      JSON.stringify(procOf('A032')));
check('and reads evade off Itachi', procOf('A02W').evade === 0.07, JSON.stringify(procOf('A02W')));
check('and gives A051 nothing to fire', procOf('A051').chance === 0, JSON.stringify(procOf('A051')));
// The plain evasion family keeps its chance one slot earlier, and its declared
// range (0..10) does not settle whether 0.25 is a quarter or a quarter of a
// percent.  The author's own tooltip does: A01W reads "피할 확률 25%".
check('Eev1 is an evade chance too', labelOf('Eev1') === 'Chance to Evade', labelOf('Eev1'));
check('and it belongs to the evasion family',
      /K"AEev,AIev,ACev,ACes"/.test(blob('Eev1')), 'useSpecific AEev,AIev,ACev,ACes');
check('Eneru\'s Mantra is a quarter, as its own tooltip says',
      at('A01W').data1 === 0.25, `${at('A01W').data1}`);
check('the table reads it', procOf('A01W').evade === 0.25, JSON.stringify(procOf('A01W')));
check('a unit with none of them is unaffected',
      attackProcs(W, { abilities: new Map() }).chance === 0, 'clean');

// ---- and the damage actually lands harder
const world = new World();
const eng = new JassEngine(world);
eng.load(); eng.boot();
for (let i = 0; i < 30; i++) { eng.update(1000 / 30); world.step(); }
const units = [...world.units.values()].filter((u) => u.alive);
const atk = units.find((u) => u.isHero);
const vic = units.find((u) => u.alive && u !== atk && world.hostile(atk, u));
check('there is an attacker and a victim', !!atk && !!vic, vic ? vic.typeKey : 'none');

if (atk && vic) {
  // Drive the real attack path, not damage() directly -- the crit lives in the
  // `land` closure inside stepAttack, and a test that calls damage() with a
  // pre-multiplied number proves nothing about whether that closure runs.
  //
  // Math.random is stubbed so the roll is a decision rather than a coin: the
  // same stub covers the damage dice, so both runs roll the same swing and the
  // only difference left is the proc.
  const realRandom = Math.random;
  // The stub also feeds the damage dice at stepAttack's `dice` line, so two
  // different rolls would roll two different swings and the ratio below would
  // measure the dice as much as the crit.  Taking the dice out leaves the
  // proc as the only thing that can move the number.
  atk.dmgDice = 0; atk.dmgSides = 1;
  const swingOnce = (attacker, victim, roll) => {
    Math.random = () => roll;
    victim.hp = victim.maxHp;
    attacker.atkTimer = 0;
    attacker.x = victim.x + 10; attacker.y = victim.y;
    attacker.facing = Math.PI; // Isolate proc rolls from turn timing.
    attacker.order = { type: 'attack', targetId: victim.id };
    const before = victim.hp;
    world.stepAttack(attacker);
    // Advance through the authored attack windup before inspecting impact.
    for (let i = 0; attacker.attackWindup && i < 300; i++) world.stepAttack(attacker);
    Math.random = realRandom;
    return before - victim.hp;
  };

  atk.abilities.delete('A035');
  atk.missileSpeed = 0;                    // land() runs inline for a melee swing
  const plainHit = swingOnce(atk, vic, 0.99);
  check('a plain attack lands', plainHit > 0, `${plainHit.toFixed(1)} damage`);

  atk.abilities.set('A035', 1);            // 60% at x4
  const missedRoll = swingOnce(atk, vic, 0.99);   // 0.99*100 = 99 >= 60, no crit
  const critRoll = swingOnce(atk, vic, 0.0);      // 0 < 60, crit
  check('the crit chance is actually rolled, not always taken',
        Math.abs(missedRoll - plainHit) < 1e-6, `${missedRoll.toFixed(1)} vs ${plainHit.toFixed(1)}`);
  check('and a winning roll multiplies the swing',
        critRoll > missedRoll * 3, `${missedRoll.toFixed(1)} -> ${critRoll.toFixed(1)}`);
  check('by the multiplier the ability carries, before armour',
        Math.abs(critRoll / missedRoll - 4) < 0.05,
        `x${(critRoll / missedRoll).toFixed(3)} against x4`);
  atk.abilities.delete('A035');

  // Evade sits on the defender, and has to stop the hit entirely.
  vic.abilities = vic.abilities || new Map();
  vic.abilities.set('A066', 3);            // 21% evade
  const evaded = swingOnce(atk, vic, 0.0);         // 0 < 0.21
  const notEvaded = swingOnce(atk, vic, 0.99);     // 0.99 > 0.21
  check('an evaded attack deals nothing at all', evaded === 0, `${evaded} damage`);
  check('and a failed evade still lands', notEvaded > 0, `${notEvaded.toFixed(1)} damage`);
  vic.abilities.delete('A066');
}

const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} checks passed`);
process.exit(bad ? 1 : 0);
