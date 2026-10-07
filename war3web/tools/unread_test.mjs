// Does the engine read every field the map actually filled in?
//
// tools/slot_test.mjs asks whether a slot the engine READS means what the
// engine thinks it means.  This asks the other question, which is the one that
// has cost more: a field the map filled in that NOTHING reads.  Every defect
// fixed on 2026-09-03 had that shape --
//
//   Eme5  "Alternate Form Hit Point Bonus" = 3000, read by nothing, so both
//         Metamorphoses on this map stood 3000 life short.
//   Htc3  "Movement Speed Reduction (%)" = 0.4, read by nothing, and the case
//         applied a hardcoded 0.25 instead.
//   Omi2  "Damage Dealt (%)" and Omi3 "Damage Taken (%)", read by nothing, and
//         a mirror image got a 0.2 life factor that is in no field at all.
//   Nms1  "Mana per Hit Point" and Nms2 "Damage Absorbed (%)", read by nothing,
//         so three Mana Shields did nothing whatever.
//
// None of those was visible to any check we had.  ability_audit asks whether a
// case EXISTS; slot_test asks whether the slots a case reads are named right; a
// player sees the spell go off either way.  This one is mechanical, it covers
// the whole roster rather than the half a sweep reached, and it re-derives its
// answer from the map every run, so it cannot go stale the way a written note
// does.
//
// NON_CASE_READERS is the hand-written part, and it is the same bargain
// slot_test's CONTRACT makes: a base whose fields are read somewhere other than
// the switch has to say so here, or its fields count as unread.
//
//   node tools/unread_test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { slotTable } from './slotmeta.mjs';
import { ABILS, baseOf, isPassive } from '../server/abilities.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'server/abilities.js'), 'utf8');
const WORLD = fs.readFileSync(path.join(ROOT, 'server/world.js'), 'utf8');
const MAP = slotTable();
const GAME = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/game.json'), 'utf8'));
const TYPES = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/unittypes.json'), 'utf8'));

let pass = 0; const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fails.push(name); console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
};

// ---------------------------------------------- what the switch itself reads
function caseReads() {
  const body = SRC.slice(SRC.indexOf('switch (B)'));
  const re = /^\s*((?:case '[A-Za-z0-9]+': *)+)\{/gm;
  const marks = []; let m;
  while ((m = re.exec(body))) {
    marks.push({ at: m.index, end: re.lastIndex,
                 bases: [...m[1].matchAll(/'([A-Za-z0-9]+)'/g)].map((x) => x[1]) });
  }
  const out = new Map();
  marks.forEach((mk, i) => {
    const block = body.slice(mk.end, i + 1 < marks.length ? marks[i + 1].at : body.length);
    const slots = new Set([...block.matchAll(/\bd([1-6])\b/g)].map((x) => +x[1]));
    for (const b of mk.bases) out.set(b, slots);
  });
  return out;
}

// ------------------------------------------ what is read outside the switch
//
// Each entry names the slots that base's fields are read through, and where.
// A base that is genuinely engine behaviour with no fields of its own says so
// with an empty list and a reason.
const NON_CASE_READERS = {
  // attack-time procs, server/abilities.js attackProcs
  ACct: [1, 2, 3, 4], ANdb: [1, 2, 3, 4], AOcr: [1, 2, 3, 4],
  AHbh: [1, 2, 3], ACbh: [1, 2, 3],
  AEev: [1], AIev: [1], ACev: [1], ACes: [1],
  // the summon count, server/abilities.js summonFrom via SUMMON_COUNT_BASES
  AHwe: [1], AEst: [1], ANsg: [1], ANsq: [1], ANsw: [1], ANwm: [1],
  AOsw: [1], AOwd: [1], Anwm: [1], ACwe: [1], AHpx: [1], ACtn: [1], ANlm: [1],
  // Spirit Wolves keeps its count in slot 2, not slot 1
  AOsf: [2],
  // carried burn, server/abilities.js carriedImmolation and ITEM_BONUS
  AIcf: [1],
  // attribute skills, server/abilities.js abilityBonuses / ATTR_SKILLS
  Aamk: [1, 2, 3], AIab: [1, 2, 3], AIx1: [1, 2, 3], AIx2: [1, 2, 3],
  AIx5: [1, 2, 3], AIxm: [1, 2, 3], AIam: [1, 2, 3], AIgm: [1, 2, 3],
  AIsm: [1, 2, 3], AItm: [1, 2, 3], AInm: [1, 2, 3],
  AIa1: [1, 2, 3], AIa3: [1, 2, 3], AIa4: [1, 2, 3], AIa6: [1, 2, 3],
  AIs1: [1, 2, 3], AIs3: [1, 2, 3], AIs4: [1, 2, 3], AIs6: [1, 2, 3],
  AIi1: [1, 2, 3], AIi3: [1, 2, 3], AIi4: [1, 2, 3], AIi6: [1, 2, 3],
  AIim: [1, 2, 3],
  // Warcraft III engine behaviour with no number for us to spend
  AInv: 'the inventory itself -- capacity and the can-use/get/drop flags are the engine\'s, and six slots is what the client draws',
  Aloc: 'locust: unselectable, and the flag is not a data slot',
  Avul: 'invulnerability', Aneu: 'neutral building behaviour',
};

const READS = caseReads();
const readsOf = (base) => {
  const nc = NON_CASE_READERS[base];
  if (typeof nc === 'string') return null;             // declared as fieldless
  const s = new Set(READS.get(base) || []);
  for (const k of (nc || [])) s.add(k);
  return s;
};

// --------------------------------------------- every ability a player reaches
function reachable() {
  const out = new Map();
  for (const h of GAME.heroes) {
    const pool = new Set(h.castable || []);
    // a hero also holds its base abilities, which the command card now offers
    for (const a of (h.abilityIds || [])) pool.add(a);
    let grew = true;
    while (grew) {
      grew = false;
      for (const id of [...pool]) {
        const ab = ABILS[id];
        for (const l of (ab && ab.levels) || []) {
          const t = l.unit && TYPES[l.unit];
          for (const g of (t && t.abilities) || []) if (!pool.has(g)) { pool.add(g); grew = true; }
        }
      }
    }
    for (const id of pool) if (!out.has(id)) out.set(id, h.name);
  }
  return out;
}

// A slot counts as filled when the map gives it a non-zero number at some level.
// A zero is the map saying "this does nothing here", which is a decision rather
// than a gap -- 27 abilities write one deliberately.
function filledSlots(ab) {
  const out = new Map();
  for (const L of ab.levels || []) {
    for (let k = 1; k <= 6; k++) {
      const v = L['data' + k];
      if (typeof v === 'number' && v !== 0 && !out.has(k)) out.set(k, v);
    }
  }
  return out;
}

console.log('\n-- every field the map filled in should be read by something');
const rows = [];
for (const [id, hero] of reachable()) {
  const ab = ABILS[id];
  if (!ab) continue;
  const base = baseOf(ab);
  const declared = MAP.get(base) || {};
  const read = readsOf(base);
  const filled = filledSlots(ab);
  if (!filled.size) continue;
  if (read === null) continue;                          // declared fieldless
  const unread = [...filled].filter(([k]) => declared[k] && !read.has(k));
  if (unread.length) {
    rows.push({ hero, id, base, name: ab.name, passive: isPassive(ab),
                unread: unread.map(([k, v]) => `${k}:${declared[k].label}=${v}`) });
  }
}
rows.sort((a, b) => a.hero.localeCompare(b.hero) || a.id.localeCompare(b.id));
for (const r of rows) {
  console.log(`  ${r.hero.slice(0, 18).padEnd(19)}${r.id} ${r.base.padEnd(5)}` +
              `${(r.name || '').slice(0, 14).padEnd(15)}${r.unread.join('; ')}`);
}
console.log(`\n${rows.length} abilities a player can reach declare a field nothing reads.`);

// ------------------------------------------------------------------ the gate
//
// ACCEPTED is the debt list, keyed `ability|slot`, one reason each.  The count
// only goes down.  Anything not on it fails.
const ACCEPTED = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/unread_accepted.json'), 'utf8'));
let unexplained = 0;
for (const r of rows) {
  for (const u of r.unread) {
    const key = `${r.id}|${u.split(':')[0]}`;
    if (!ACCEPTED[key]) { unexplained++; console.log(`  FAIL  ${key} (${r.hero} ${r.name}) ${u}`); }
  }
}
check('every unread field is either fixed or written down with a reason',
      unexplained === 0, `${unexplained} with no entry in tools/unread_accepted.json`);
console.log(`\naccepted unread fields still outstanding: ${Object.keys(ACCEPTED).length}`);

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
