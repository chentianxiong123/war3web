// The map's own declaration of what every ability data slot means.
//
// Warcraft III does not store "damage" in an ability; it stores DataA..DataF,
// and what each of those means depends on the base ability.  The World Editor
// knows the mapping because it ships it: AbilityMetaData.slk gives, per field
// id, which data slot it occupies (`data`) and which bases use it
// (`useSpecific`), and WorldEditStrings.txt turns the field's WESTRING into the
// label a map author actually reads -- "Number of Waves", "Damage",
// "Chance to Evade".
//
// server/abilities.js necessarily reads those slots positionally, as d1..d4.
// Nothing in the source records which meaning it believes it is reading, so a
// slot read in the wrong order is invisible to every structural check: the case
// exists, it is reached, it deals damage, and a player sees a spell go off.
// That is exactly how the Blizzard family shipped with waves and damage
// swapped.  This module exists so a test can compare the two.
//
// Reads war3_extracted/ directly, as tools/ability_audit.mjs does -- these are
// extracted inputs, not compiled outputs, so there is no staging order to get
// wrong.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'latin1');

/**
 * Minimal SLK reader: `C` records carry a value `K`, a column `X` and a row
 * `Y`, and Y persists across records until it changes.  Returns rows as
 * objects keyed by the header row's column names.
 */
export function readSlk(rel) {
  const rows = new Map();
  let y = 0;
  for (const line of read(rel).split(/\r?\n/)) {
    if (line[0] !== 'C') continue;
    let x = 0, k = null;
    for (const f of line.split(';')) {
      if (f[0] === 'X') x = +f.slice(1);
      else if (f[0] === 'Y') y = +f.slice(1);
      else if (f[0] === 'K') k = f.slice(1);
    }
    if (k === null) continue;
    if (k[0] === '"') k = k.slice(1, -1);
    if (!rows.has(y)) rows.set(y, new Map());
    rows.get(y).set(x, k);
  }
  const head = rows.get(1);
  if (!head) throw new Error(`${rel}: no header row`);
  const out = [];
  for (const [ry, cells] of rows) {
    if (ry === 1) continue;
    const o = {};
    for (const [cx, v] of cells) if (head.has(cx)) o[head.get(cx)] = v;
    out.push(o);
  }
  return out;
}

/** WESTRING_* -> the text the World Editor shows. */
function westrings() {
  const m = new Map();
  for (const line of read('war3_extracted/UI/WorldEditStrings.txt').split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq > 0 && line.startsWith('WESTRING_')) m.set(line.slice(0, eq), line.slice(eq + 1).trim());
  }
  return m;
}

/**
 * base ability code -> { <slot 1..6>: { field, label } }.
 *
 * Only fields that name their bases in `useSpecific` are placed: a field with
 * an empty useSpecific applies to every ability (cooldown, mana, art) and
 * carries no per-base slot meaning, so it is not a slot claim.  A base that
 * appears in no useSpecific simply has no entry -- absence here means the data
 * says nothing, never that the slot is free.
 */
export function slotTable() {
  const wes = westrings();
  const table = new Map();
  for (const r of readSlk('war3_extracted/Units/AbilityMetaData.slk')) {
    const id = r.ID, slot = +r.data, spec = (r.useSpecific || '').trim();
    if (!id || !spot(slot) || !spec) continue;
    const label = wes.get(r.displayName) || r.displayName || '';
    for (const base of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
      if (!table.has(base)) table.set(base, {});
      // A base can legitimately be listed by two fields for one slot only if
      // they agree; keep the first and let the caller see a clash as a clash.
      if (!table.get(base)[slot]) table.get(base)[slot] = { field: id, label };
    }
  }
  return table;
}

const spot = (n) => Number.isFinite(n) && n >= 1 && n <= 6;

/** The label the map gives `base`'s slot `n`, or '' when the data is silent. */
export function labelFor(table, base, n) {
  const e = table.get(base);
  return (e && e[n] && e[n].label) || '';
}

/** The field id behind `base`'s slot `n`, or '' when the data is silent. */
export function fieldFor(table, base, n) {
  const e = table.get(base);
  return (e && e[n] && e[n].field) || '';
}
