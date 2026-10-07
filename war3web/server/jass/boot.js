// Loads common.j / Blizzard.j / war3map.j into a VM and reports native coverage.
import fs from 'node:fs';
import path from 'node:path';
import { parse } from './parse.js';
import { VM } from './vm.js';

const ROOT = path.resolve(import.meta.dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'latin1').replace(/\r\n?/g, '\n');

export function loadScripts(vm, { commonJ = 'war3_extracted/Scripts/common.j',
                                  blizzardJ = 'war3_extracted/Scripts/Blizzard.j',
                                  supplementJ = 'auto',
                                  mapJ = 'extracted/war3map.j' } = {}) {
  const common = parse(read(commonJ), 'common.j');
  vm.addTypes(common);
  vm.addNativeSigs(common);
  vm.addGlobals(common);

  const bliz = parse(read(blizzardJ), 'Blizzard.j');
  vm.addGlobals(bliz);
  vm.addFunctions(bliz);

  // Frozen Throne additions, only needed when common.j is the Reign of Chaos one.
  // With War3x.mpq / War3Patch.mpq extracted, the real libraries supply everything.
  let suppPath = supplementJ;
  if (suppPath === 'auto') {
    const isTFT = common.globals.some((g) => g.name === 'EVENT_PLAYER_UNIT_SPELL_EFFECT');
    suppPath = isTFT ? null : 'server/jass/tft_supplement.j';
    vm.tftLibraries = isTFT;
  }
  const supp = suppPath ? parse(read(suppPath), 'tft_supplement.j') : null;
  if (supp) {
    vm.addNativeSigs(supp);
    vm.addGlobals(supp);
    vm.addFunctions(supp);
  }

  const map = parse(read(mapJ), 'war3map.j');
  vm.addGlobals(map);
  vm.addFunctions(map);
  return { common, bliz, supp, map };
}

/** Every external symbol the loaded scripts call, split by whether we implement it. */
export function coverage(vm, asts) {
  const called = new Map();
  const walkExpr = (e) => {
    if (!e || typeof e !== 'object') return;
    if (e.k === 'call') { called.set(e.name, (called.get(e.name) || 0) + 1); e.args.forEach(walkExpr); }
    else if (e.k === 'bin') { walkExpr(e.l); walkExpr(e.r); }
    else if (e.k === 'not' || e.k === 'neg') walkExpr(e.e);
    else if (e.k === 'index') walkExpr(e.idx);
  };
  const walkStmt = (s) => {
    if (!s) return;
    switch (s.k) {
      case 'local': walkExpr(s.init); break;
      case 'set': walkExpr(s.e); walkExpr(s.idx); break;
      case 'callstmt': called.set(s.name, (called.get(s.name) || 0) + 1); s.args.forEach(walkExpr); break;
      case 'if': s.clauses.forEach((c) => { walkExpr(c.cond); c.body.forEach(walkStmt); });
                 (s.els || []).forEach(walkStmt); break;
      case 'loop': s.body.forEach(walkStmt); break;
      case 'exitwhen': case 'return': walkExpr(s.e); break;
    }
  };
  for (const ast of asts) {
    for (const f of ast.functions) f.body.forEach(walkStmt);
    for (const g of ast.globals) walkExpr(g.init);
  }
  const missing = new Map(), declaredOnly = new Map(), ok = new Map();
  for (const [name, n] of called) {
    if (vm.functions.has(name)) continue;                 // JASS-defined
    if (vm.natives.has(name)) ok.set(name, n);
    else if (vm.nativeSigs.has(name)) declaredOnly.set(name, n);
    else missing.set(name, n);
  }
  const sortDesc = (m) => [...m].sort((a, b) => b[1] - a[1]);
  return { implemented: sortDesc(ok), unimplemented: sortDesc(declaredOnly), unknown: sortDesc(missing) };
}
