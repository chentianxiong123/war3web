// Which natives are present, called, and do nothing?
//
// There are two ways a native can fail to do its job and only one of them is
// reported. A native the engine has never heard of is counted -- boot_test
// prints the list. A native that exists with an empty body is not: it accepts
// the call, returns, and nothing anywhere says a word. That is the shape the
// text tags had. CreateTextTag returned a handle and every setter on it was
// `() => {}`, so the map configured 48 tags into nothing at all and every
// instrument in the project stayed green.
//
// This walks the other way round: it reads server/jass/engine.js for natives
// whose body is empty or a bare constant, then counts how many of the map's own
// call sites reach each one -- directly, or through the Blizzard.j wrapper the
// map actually calls, since war3map.j almost never names a native itself.
//
// Ranked by call sites, because "how much of this map runs into it" is the
// question, not how hard it looks.
//
//   node tools/stub_audit.mjs
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const ENGINE = read('server/jass/engine.js');
const MAPJ = read('extracted/war3map.j');
const BLIZ = read('war3_extracted/Scripts/Blizzard.j');
const COMMON = read('war3_extracted/Scripts/common.j');

// ---------------------------------------------------------------- the stubs
// A stub is an arrow function whose body is empty or a single literal. Written
// against the shapes engine.js actually uses -- `() => {}`, `() => true`,
// `(a, b) => 0`, `() => ''` -- rather than a general parse, and anything it is
// unsure of is left out, so this under-reports rather than invents.
const STUB_BODY = /^(\{\s*\}|true|false|0|1|-1|''|""|null|undefined|\[\]|\{\})$/;
const stubs = new Map();
const named = new Set();
for (const m of ENGINE.matchAll(/(\w+):\s*\(([^)]*)\)\s*=>\s*([^,\n]+?)(?=,\s*\n|,\s*\w+:|\n)/g)) {
  const [, name, , body] = m;
  named.add(name);
  const b = body.trim().replace(/\s*\/\/.*$/, '').trim();
  if (STUB_BODY.test(b)) stubs.set(name, b);
}

// ------------------------------------------------- what reaches what, in JASS
// Every function in common.j and Blizzard.j, so a map call to a BJ can be
// followed down to the native it bottoms out at.
const bodies = new Map();
for (const src of [COMMON, BLIZ]) {
  for (const m of src.matchAll(/^function\s+(\w+)\b([\s\S]*?)^endfunction/gm)) {
    bodies.set(m[1], m[2]);
  }
}
const callsIn = (text) => new Set([...text.matchAll(/\b(\w+)\s*\(/g)].map((m) => m[1]));

const reachCache = new Map();
function reach(fn, seen = new Set()) {
  if (reachCache.has(fn)) return reachCache.get(fn);
  if (seen.has(fn)) return new Set();
  seen.add(fn);
  const out = new Set();
  const body = bodies.get(fn);
  if (body) {
    for (const c of callsIn(body)) {
      out.add(c);
      for (const d of reach(c, seen)) out.add(d);
    }
  }
  if (seen.size <= 1) reachCache.set(fn, out);
  return out;
}

// ------------------------------------------------ how often the map calls what
const mapCalls = new Map();
for (const m of MAPJ.matchAll(/\b(\w+)\s*\(/g)) {
  mapCalls.set(m[1], (mapCalls.get(m[1]) || 0) + 1);
}

/** Map call sites that end at `native`, and the wrappers they go through. */
function sitesFor(native) {
  let n = mapCalls.get(native) || 0;
  const via = [];
  for (const [fn, count] of mapCalls) {
    if (fn === native || !bodies.has(fn)) continue;
    if (reach(fn).has(native)) { n += count; via.push(`${fn} x${count}`); }
  }
  return { n, via };
}

const rows = [];
for (const [name, body] of stubs) {
  const { n, via } = sitesFor(name);
  if (n > 0) rows.push({ name, body, n, via });
}
rows.sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));

const total = rows.reduce((s, r) => s + r.n, 0);
console.log(`${stubs.size} of ${named.size} natives in engine.js are a stub body.`);
console.log(`${rows.length} of those are reached by this map, across ${total} call sites.\n`);
console.log('sites  native                          returns   reached through');
for (const r of rows) {
  console.log(`${String(r.n).padStart(5)}  ${r.name.padEnd(31)} ${r.body.padEnd(9)} ` +
              (r.via.slice(0, 2).join(', ') || 'called directly') +
              (r.via.length > 2 ? ` +${r.via.length - 2} more` : ''));
}
