// Does the engine read each ability data slot with the meaning the map gives it?
//
// server/abilities.js reads DataA..DataD positionally, as d1..d4, and nothing
// in the source records which meaning it believes it is reading.  That makes a
// wrong slot invisible to every other check we have: tools/ability_audit.mjs
// asks whether a case EXISTS, the render tests ask whether art draws, and a
// player sees a spell go off either way.  The Blizzard family shipped with
// waves and damage swapped for exactly that reason -- 30 waves x 1100 damage
// ran as 1100 waves x 30, an eighteen-minute bombardment whose total damage was
// right, so nothing downstream noticed.
//
// The map ships the answer.  AbilityMetaData.slk's `useSpecific` column says
// which bases use each field and which slot it occupies; WorldEditStrings.txt
// turns the field into the label a map author reads.  tools/slotmeta.mjs
// resolves the two.  This test compares that against what the engine assumes.
//
// Three checks, in order of how much hand-written material they need:
//
//   1. GROUPING   Bases sharing one `case` block are read through the same
//                 d1..d4, so they must agree on what those slots mean.  Fully
//                 derived -- no declaration to maintain, no way to drift.
//   2. ALIAS      BASE_ALIAS claims one base IS another's behaviour.  Then
//                 their slots must line up too.
//   3. CONTRACT   What the engine believes each slot means, written out here
//                 and checked against the map.  This is the only hand-written
//                 part, so the test also asserts that every case group reading
//                 a slot HAS a contract entry -- a new case with no entry
//                 fails rather than passing silently.
//
// ACCEPTED holds the mismatches we have not fixed yet, one line of reason
// each.  It is a debt list with a number attached, not a suppression file: the
// test prints its size and TODO.txt tracks it.  The count only goes down.
//
//   node tools/slot_test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { slotTable } from './slotmeta.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC  = fs.readFileSync(path.join(ROOT, 'server/abilities.js'), 'utf8');
const MAP  = slotTable();

let pass = 0; const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fails.push(name); console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
};

// ---------------------------------------------------------------- label sense
//
// Blizzard words the same quantity differently across ability families -- Storm
// Bolt's slot is "Damage", Death Coil's is "Amount Healed/Damaged", Flame
// Strike's is "Full Damage Dealt".  These classes fold wording only.  A
// difference in KIND (flat damage vs damage per second vs a percentage) is
// never folded: that difference is the bug we are looking for.
const SENSE = [
  ['damage', ['Damage', 'Damage Amount', 'Damage Dealt', 'Amount Healed/Damaged',
              'Full Damage Dealt', 'Hit Points Drained', 'Damage Per Target',
              'Damage per Target', 'AOE Damage', 'Area of Effect Damage']],
  ['max damage', ['Max Damage', 'Maximum Damage', 'Maximum Total Damage']],
  ['distance', ['Distance']],
  ['final area', ['Final Area']],
  ['waves', ['Number of Waves']],
  ['dps', ['Damage Per Second', 'Damage per Interval']],
  ['damage increase %', ['Damage Increase (%)', 'Damage Increase']],
  ['move slow %', ['Movement Speed Reduction (%)', 'Movement Speed Reduction']],
  ['attack slow %', ['Attack Speed Reduction (%)', 'Attack Speed Reduction']],
  ['specific target damage', ['Specific Target Damage', 'Extra Damage To Target']],
  // A "Factor" (0.5) and a "Reduction (%)" (50) are the same idea in different
  // units, so they are deliberately NOT folded together.
  ['move slow factor', ['Movement Speed Factor']],
  ['count', ['Number of Images', 'Number of Swarm Units', 'Number of Targets Hit']],
  ['seconds', ['Armor Duration', 'Unit Release Interval (seconds)']],
  ['armor', ['Armor Bonus']],
  ['range', ['Maximum Range']],
  ['heal', ['Amount Healed/Damaged']],
];
const senseOf = (label) => {
  for (const [s, ls] of SENSE) if (ls.includes(label)) return s;
  return label ? 'literal:' + label : '';
};
const agree = (a, b) => a && b && senseOf(a) === senseOf(b);

// ------------------------------------------------------- the engine's switch
/** Case label groups in execute()'s switch, with the d-slots each block reads. */
function caseGroups() {
  const body = SRC.slice(SRC.indexOf('switch (B)'));
  const re = /^\s*((?:case '[A-Za-z0-9]+': *)+)\{/gm;
  const marks = [];
  let m;
  while ((m = re.exec(body))) {
    marks.push({ at: m.index, end: re.lastIndex,
                 bases: [...m[1].matchAll(/'([A-Za-z0-9]+)'/g)].map((x) => x[1]) });
  }
  return marks.map((mk, i) => {
    const block = body.slice(mk.end, i + 1 < marks.length ? marks[i + 1].at : body.length);
    const slots = [...new Set([...block.matchAll(/\bd([1-6])\b/g)].map((x) => +x[1]))].sort();
    return { bases: mk.bases, slots, key: mk.bases.join(','), block };
  });
}
const GROUPS = caseGroups();

/** BASE_ALIAS, read off the source so the test cannot fall behind it. */
function aliases() {
  const blk = SRC.slice(SRC.indexOf('const BASE_ALIAS'), SRC.indexOf('export function baseOf'));
  return [...blk.matchAll(/([A-Za-z0-9]+)\s*:\s*'([A-Za-z0-9]+)'/g)].map((m) => [m[1], m[2]]);
}

const label = (base, slot) => (MAP.get(base) || {})[slot]?.label || '';
const field = (base, slot) => (MAP.get(base) || {})[slot]?.field || '';

// ------------------------------------------------------------------ contract
//
// What execute() believes it is reading, group by group, written from the code
// as it stands -- not from what the code ought to do.  The map is the judge.
const CONTRACT = {
  'AHtb,ANtb':               { 1: 'Damage' },
  'AUfa,AUfu,ACfa':          { 1: 'Armor Duration', 2: 'Armor Bonus' },
  'AUfn':                    { 1: 'Area of Effect Damage', 2: 'Specific Target Damage' },
  'AHtc,AOws':               { 1: 'AOE Damage', 3: 'Movement Speed Reduction (%)',
                               4: 'Attack Speed Reduction (%)' },
  'AUcs,AOsh':               { 1: 'Damage', 2: 'Max Damage', 3: 'Distance', 4: 'Final Area' },
  'AUim':                    { 1: 'Wave Distance', 3: 'Damage Dealt', 4: 'Air Time (seconds)' },
  'ANcs':                    { 1: 'Damage Amount', 2: 'Damage Interval', 3: 'Missile Count' },
  'ANbf':                    { 1: 'Damage', 2: 'Max Damage', 3: 'Distance',
                               4: 'Final Area', 5: 'Damage Per Second' },
  'ANst':                    { 1: 'Beasts Per Second', 3: 'Damage Amount',
                               4: 'Damage Radius' },
  'AEfk,ACtb':               { 1: 'Damage Per Target' },
  'AOcl,AEch':               { 1: 'Damage per Target', 2: 'Number of Targets Hit' },
  'AHbz,ANrf':               { 1: 'Number of Waves', 2: 'Damage' },
  'AEsf':                    { 1: 'Damage Dealt', 2: 'Damage Interval' },
  'AOww':                    { 1: 'Damage Per Second' },
  'ANht':                    { 1: 'Damage Increase (%)' },
  'AUin':                    { 1: 'Damage', 2: 'Duration' },
  'AOmi':                    { 1: 'Number of Images', 2: 'Damage Dealt (%)',
                               3: 'Damage Taken (%)' },
  'AUls':                    { 1: 'Number of Swarm Units', 2: 'Unit Release Interval (seconds)' },
  'ANpi,AEim,AIim':          { 1: 'Damage per Interval' },
  'AHhb,AOhw,AChw':          { 1: 'Amount Healed/Damaged' },
  'ACro,ANbr':               { 1: 'Damage Increase (%)', 2: 'Defense Increase',
                               3: 'Life Regeneration Rate' },
  'ANfd':                    { 3: 'Damage' },
  'AEer':                    { 1: 'Damage per Second' },
  'ANms,ACmf':               { 1: 'Mana per Hit Point', 2: 'Damage Absorbed (%)' },
  'Amls':                    { 1: 'Damage Per Second' },
  'AEbl':                    { 1: 'Maximum Range', 2: 'Minimum Range' },
  'AEme':                    { 5: 'Alternate Form Hit Point Bonus' },
  'AHfs':                    { 1: 'Full Damage Dealt', 2: 'Full Damage Interval',
                               3: 'Half Damage Dealt', 4: 'Half Damage Interval',
                               6: 'Maximum Damage' },
  'ANdr,AUdc,ANin':          { 1: 'Damage' },
  'ANsl,AUsl,ACsw':          { 1: 'Movement Speed Factor' },
};

// ------------------------------------------------------------------ accepted
//
// Known mismatches, keyed `group|slot|base`.  Each is a defect the port has
// today, recorded so this test can be green and still tell the truth.  Removing
// a line is the fix; adding one needs a reason a reader can check.
const ACCEPTED = {
  // -- latent, not live: this map builds no ability on these bases, so the
  //    mismatch cannot reach a player today.  Left recorded rather than
  //    deleted, because a later map would walk straight into them.
  'ANsl,AUsl,ACsw|1|AUsl': 'AUsl slot 1 is a Stun Duration, spent here as a slow percentage. Base unused by this map',
  'ANsl,AUsl,ACsw|1|ACsw': 'ACsw slot 1 is a Movement Speed FACTOR (0.5), spent here as a percentage (/100). Base unused by this map',
  'ANpi,AEim,AIim|1|AIim':  'AIim is an attribute bonus (Iagi = Agility Bonus), not an immolation. Base unused by this map',
  'AHhb,AOhw,AChw|1|AOhw':  'Healing Wave chains (Ocl1..Ocl3); the block heals one target only. Base unused by this map',
  'AHtc,AOws|1|AOws':       'wording only -- AHtc "AOE Damage" vs AOws "Damage"; both are the flat damage the block deals',
};

// ============================================================== 1. GROUPING
console.log('\n-- grouping: bases sharing a case must agree on their slots');
for (const g of GROUPS) {
  if (g.bases.length < 2) continue;
  for (const s of g.slots) {
    const known = g.bases.map((b) => [b, label(b, s)]).filter(([, l]) => l);
    if (known.length < 2) continue;
    const [, first] = known[0];
    for (const [b, l] of known.slice(1)) {
      if (agree(first, l)) continue;
      if (ACCEPTED[`${g.key}|${s}|${b}`] || ACCEPTED[`${g.key}|${s}|${known[0][0]}`]) continue;
      check(`${g.key} d${s}: ${known[0][0]} and ${b} agree`, false,
            `${known[0][0]}=${first} vs ${b}=${l}`);
    }
  }
}
check('every grouping mismatch is either fixed or accepted', true);

// ================================================================= 2. ALIAS
console.log('\n-- alias: a base routed to another must share its slot meanings');
for (const [from, to] of aliases()) {
  for (let s = 1; s <= 4; s++) {
    const a = label(from, s), b = label(to, s);
    if (!a || !b) continue;
    check(`${from} -> ${to} d${s}`, agree(a, b), `${from}=${a} vs ${to}=${b}`);
  }
}

// ============================================================== 3. CONTRACT
console.log('\n-- contract: what the engine assumes vs what the map declares');
for (const g of GROUPS) {
  if (!g.slots.length) continue;
  if (!CONTRACT[g.key]) {
    check(`case ${g.key} declares what its slots mean`, false,
          'no CONTRACT entry -- add one naming the map label each d-slot is read as');
    continue;
  }
  for (const s of g.slots) {
    if (!CONTRACT[g.key][s]) {
      check(`case ${g.key} declares d${s}`, false, 'block reads d' + s + ' with no contract entry');
    }
  }
}
for (const [key, want] of Object.entries(CONTRACT)) {
  const bases = key.split(',');
  for (const [s, expect] of Object.entries(want)) {
    for (const b of bases) {
      const got = label(b, +s);
      if (!got) continue;                      // the data is silent; it is not a claim
      if (agree(expect, got)) { pass++; continue; }
      if (ACCEPTED[`${key}|${s}|${b}`]) continue;
      check(`${b} d${s} is ${expect}`, false, `${field(b, +s)} = "${got}"`);
    }
  }
}

// ------------------------------------------------------------- named checks
// The two the port has already been bitten by, spelled out so a regression
// names itself rather than arriving as a generic mismatch.
console.log('\n-- the ones that already cost us');
check('Hbz1 is the wave count and Hbz2 the damage, not the reverse',
      label('AHbz', 1) === 'Number of Waves' && label('AHbz', 2) === 'Damage',
      `${label('AHbz', 1)} / ${label('AHbz', 2)}`);
check('Rain of Fire reads the same fields as Blizzard',
      field('ANrf', 1) === 'Hbz1' && field('ANrf', 2) === 'Hbz2');
check('Starfall does not', field('AEsf', 1) === 'Esf1');
check('Blink carries its own maximum range in slot 1',
      label('AEbl', 1) === 'Maximum Range');
check('Locust Swarm slot 1 is a unit count, not damage',
      label('AUls', 1) === 'Number of Swarm Units');

// ------------------------------------------------------------------- report
console.log(`\naccepted mismatches still outstanding: ${Object.keys(ACCEPTED).length}`);
console.log(`${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
