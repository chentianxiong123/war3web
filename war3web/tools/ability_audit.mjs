// The three static detectors docs/PORTING.md specifies, so a silent gap is a
// printed row instead of a play report:
//
//   1. Dead abilities -- castable by a hero (directly, or granted by a unit
//      type a castable summons or morphs into) yet with no engine case, no
//      mention in the map script, and no data-driven fallback. These do
//      nothing at all. Would have printed Mana Shield.
//   2. Buff seams -- buff ids the script READS (UnitHasBuffBJ /
//      GetUnitAbilityLevel with a literal) against buff codes the engine can
//      APPLY. A code that is read but never appliable is the Ichigo B001
//      class: two mechanisms meeting across a gap.
//   3. Stub natives -- engine natives whose body is empty or a bare constant,
//      intersected with what the script actually reaches, directly or through
//      Blizzard.j. Nothing errors on these; this list is the only way they
//      surface. PORTING.md calls the tier "the real danger".
//
// Static and advisory: no server, no browser, and exit 0 unless an input file
// is missing -- the port is deliberately demand-driven, so a finding here is
// work to schedule, not a broken build. Point FOC_MAP_J at another map's
// extracted war3map.j to size a port before starting it.
//
//   node tools/ability_audit.mjs
import fs from 'node:fs';
import { ABILS, isPassive, levelInfo } from '../server/abilities.js';
import { World } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';

const read = (p) => fs.readFileSync(p, 'utf8');
const GAME    = JSON.parse(read('data/game.json'));
const TYPES   = JSON.parse(read('data/unittypes.json'));
const MAPJ    = read(process.env.FOC_MAP_J || 'extracted/war3map.j');
const BLIZ    = read('war3_extracted/Scripts/Blizzard.j');
const COMMON  = read('war3_extracted/Scripts/common.j');
const SUPP    = fs.existsSync('server/jass/tft_supplement.j')
              ? read('server/jass/tft_supplement.j') : '';
const ABSRC   = read('server/abilities.js');

// ---------------------------------------------------------------- engine facts
// What execute() handles, read off the source: the switch's case labels, and
// the label groups whose block stamps a named buff (`code: i.buff`).
const CASES = new Set([...ABSRC.matchAll(/case '(\w{4})'/g)].map(m => m[1]));
// A base routed through BASE_ALIAS runs the case its target names, so it is
// handled even though its own code never appears as a label -- ANcf reaches
// the breath case that way.  Without this the alias reads as a regression.
for (const [from, to] of [...ABSRC.slice(ABSRC.indexOf('const BASE_ALIAS'),
                                        ABSRC.indexOf('export function baseOf'))
                             .matchAll(/(\w{4})\s*:\s*'(\w{4})'/g)].map(m => [m[1], m[2]]))
  if (CASES.has(to)) CASES.add(from);
const APPLY_BASES = new Set();
for (const m of ABSRC.matchAll(/^ {4}((?:case '\w{4}':\s*)+)\{([\s\S]*?)^ {4}\}/gm))
  // `code: i.buff`, or the shorthand `{ kind: 'stun', code, ... }` after a
  // `const code = i.buff` above it. Matching only the long form reported a
  // seam on A059 that runtime says is closed.
  if (/code:\s*i\.buff/.test(m[2]) || (/\bcode\s*=\s*i\.buff/.test(m[2]) && /\bcode\b\s*[,}]/.test(m[2])))
    for (const c of m[1].matchAll(/'(\w{4})'/g)) APPLY_BASES.add(c[1]);

// Passive handling tables, same way. A passive base in none of these has no
// behaviour anywhere unless a trigger reads it.
const setOf = (name) => {
  const m = ABSRC.match(new RegExp(`const ${name}[^{]*?[{\\[]([\\s\\S]*?)[}\\]];`));
  return new Set(m ? [...m[1].matchAll(/'(\w{4})'|^ {2}(\w{4}):/gm)].map(x => x[1] || x[2]) : []);
};
const ATTR = setOf('ATTR_SKILLS'), AURAS = setOf('AURA_BASES'), ITEMS = setOf('ITEM_BONUS');
// PROC_BASES is read at attack time rather than through recalc, because every
// carrier but two is a summon and recalc returns early on non-heroes -- so it
// is a fourth passive-handling table and has to count as one here.
const PROCS = new Set([...setOf('PROC_BASES'), ...setOf('EVADE_BASES')]);

// ------------------------------------------------------- what the map reaches
// Every identifier the map script calls, then the transitive closure through
// Blizzard.j (and the supplement): SetUnitTimeScalePercent is Blizzard.j
// calling SetUnitTimeScale, and only the closure sees that.
const calls = (src) => new Set([...src.matchAll(/\b([A-Za-z_]\w{2,})\s*\(/g)].map(m => m[1]));
const bjFns = new Map();
for (const src of [BLIZ, SUPP])
  for (const m of src.matchAll(/function\s+(\w+)\s+takes[\s\S]*?\bendfunction/g))
    bjFns.set(m[1], calls(m[0]));
const direct = calls(MAPJ);
const reached = new Set(direct);
for (let grew = true; grew; ) {
  grew = false;
  for (const [fn, callees] of bjFns) if (reached.has(fn))
    for (const c of callees) if (!reached.has(c)) { reached.add(c); grew = true; }
}

// ----------------------------------------------------------- 1. dead abilities
// The pool is every hero's castables plus, transitively, the abilities of any
// unit type those name in `unit` -- which is both the morph forms and the
// summons, and is exactly what world.morph and world.summon hand out.
const pool = new Map();               // id -> how it is reachable
for (const h of GAME.heroes)
  for (const a of h.castable || [])
    pool.set(typeof a === 'string' ? a : a.id, h.id);
for (const [id] of [...pool]) {
  const ab = ABILS[id];
  if (!ab) continue;
  for (const lv of ab.levels || []) {
    const t = lv.unit && TYPES[lv.unit];
    for (const g of (t && t.abilities) || [])
      if (!pool.has(g)) pool.set(g, `${lv.unit} via ${id}`);
  }
}

// Handled by the engine outside the ability layer, so not gaps: Aloc marks a
// dummy off the unit type's own list (world.js "includes('Aloc')"), and AInv
// only opens inventory slots -- every unit here carries its items intrinsically
// and morph keeps the unit.
const ENGINE_ELSEWHERE = new Set(['Aloc', 'AInv']);

const dead = [], approx = [], undefined_ = [];
for (const [id, via] of [...pool].sort()) {
  if (ENGINE_ELSEWHERE.has(id)) continue;
  const ab = ABILS[id];
  if (!ab) { undefined_.push([id, via]); continue; }
  const base = ab.base, i = levelInfo(ab, 1);
  const inTrigger = MAPJ.includes(`'${id}'`);
  const passive = isPassive(ab);
  const summon  = !!(i.unit && TYPES[i.unit]);
  const damage  = !passive && (i.data1 || 0) > 0;
  const handledPassive = ATTR.has(base) || AURAS.has(base) || ITEMS.has(base) || PROCS.has(base);
  const name = (ab.name || '').trim();
  if (!CASES.has(base) && !inTrigger) {
    if (summon || damage || handledPassive)
      approx.push([id, base, via, name,
                   summon ? 'summon fallback' : damage ? 'damage fallback'
                          : PROCS.has(base) ? 'on-attack proc table' : 'attribute/aura table']);
    else dead.push([id, base, via, name, passive ? 'passive nothing reads' : 'active, no data hook']);
  }
}

// --------------------------------------------------------------- 2. buff seams
// The buff literal has to sit in the call's own argument slot -- a loose
// window around the name also catches the 'BTLF' of a neighbouring
// UnitApplyTimedLifeBJ, which is the script APPLYING a buff, not reading one.
// The unit argument nests one call deep at most (GetTriggerUnit()).
const ARG = String.raw`(?:[^()]|\([^()]*\))*?`;
const readsBuff = new Set();
for (const re of [new RegExp(String.raw`UnitHasBuffBJ\(${ARG},\s*'(B\w{3})'\)`, 'g'),
                  /GetUnitAbilityLevelSwapped\(\s*'(B\w{3})'/g,
                  new RegExp(String.raw`GetUnitAbilityLevel\(${ARG},\s*'(B\w{3})'\)`, 'g')])
  for (const m of MAPJ.matchAll(re)) readsBuff.add(m[1]);
const applies = new Map();            // buff code -> ability that stamps it
for (const [id, ab] of Object.entries(ABILS))
  if (APPLY_BASES.has(ab.base))
    for (const lv of ab.levels || []) if (lv.buff) applies.set(lv.buff, id);
const seams = [...readsBuff].filter(b => !applies.has(b)).sort();

// -------------------------------------------------------------- 3. stub natives
const declared = new Set();
for (const src of [COMMON, SUPP])
  for (const m of src.matchAll(/native\s+(\w+)\s+takes/g)) declared.add(m[1]);
// The installed table itself, not a regex over the source: construct the
// engine and load(). The table then also holds load()'s counting no-ops for
// declared-but-unwritten natives, but those bodies call this.unimplemented,
// so the bare-constant test below never mistakes one for a hand-written stub.
const eng = new JassEngine(new World());
if (!eng.vm.natives.size) eng.load();
const entries = new Set(eng.vm.natives.keys());
const stubs = new Set();
for (const [name, fn] of eng.vm.natives)
  if (/^\((?:[^)]*)\)\s*=>\s*(\{\s*\}|null|0|false|true|'')$/.test(String(fn).trim()))
    stubs.add(name);
// Stubs are NOT filtered to declared natives: the engine also stubs
// overrides of Blizzard.j functions (CinematicModeBJ, the ambient sounds),
// which shadow the real BJ body -- same silence, different route.
const stubHit = [...reached].filter(n => stubs.has(n)).sort();
const missing = [...reached].filter(n => declared.has(n) && !entries.has(n)).sort();

// -------------------------------------------------------------------- report
const nDirect = (n) => (MAPJ.match(new RegExp(`\\b${n}\\s*\\(`, 'g')) || []).length;
console.log(`ability_audit -- ${GAME.heroes.length} heroes, ${pool.size} reachable abilities,`
          + ` ${reached.size} identifiers reached in the script\n`);

console.log(`DEAD ABILITIES (no engine case, no trigger, no fallback): ${dead.length}`);
for (const [id, base, via, name, why] of dead)
  console.log(`  ${id} (${base})  ${name}  [${via}]  -- ${why}`);

console.log(`\nSURVIVING ON A FALLBACK (approximation, not the base's real mechanic): ${approx.length}`);
for (const [id, base, via, name, how] of approx)
  console.log(`  ${id} (${base})  ${name}  [${via}]  -- ${how}`);

if (undefined_.length) {
  console.log(`\nREACHABLE BUT UNDEFINED (no ability table entry): ${undefined_.length}`);
  for (const [id, via] of undefined_) console.log(`  ${id}  [${via}]`);
}

console.log(`\nBUFF SEAMS (script reads it, nothing can apply it): ${seams.length}`
          + `   (reads ${readsBuff.size}, appliable ${applies.size})`);
for (const b of seams) console.log(`  ${b}`);

console.log(`\nSTUB NATIVES THE SCRIPT REACHES: ${stubHit.length}`);
for (const n of stubHit) {
  const d = nDirect(n);
  console.log(`  ${n.padEnd(28)} ${d ? d + 'x direct' : 'via Blizzard.j'}`);
}

console.log(`\nNATIVES REACHED WITH NO HAND-WRITTEN ENTRY: ${missing.length}`
          + `   (a BJ name here runs its Blizzard.j body; a true native falls to`
          + ` the declared default -- silent either way)`);
for (const n of missing) console.log(`  ${n.padEnd(28)} ${nDirect(n) ? nDirect(n) + 'x direct' : 'via Blizzard.j'}`);
