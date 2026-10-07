// JASS lexer + parser -> AST.  Targets the dialect used by Warcraft III map scripts.

const KEYWORDS = new Set(['globals','endglobals','constant','native','type','extends',
  'function','endfunction','takes','returns','nothing','local','set','call','if','then',
  'elseif','else','endif','loop','endloop','exitwhen','return','array','and','or','not',
  'true','false','null','debug']);

export function lex(src) {
  const toks = [];
  let i = 0, line = 1;
  const n = src.length;
  const push = (type, value) => toks.push({ type, value, line });
  while (i < n) {
    const c = src[i];
    if (c === '\n') { push('nl'); line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') {                     // JASS has no block comments
      i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') line++; i++; }
      i += 2; continue;
    }
    if (c === '"') {
      let s = ''; i++;
      while (i < n && src[i] !== '"') {
        if (src[i] === '\\') {
          const e = src[i + 1];
          s += e === 'n' ? '\n' : e === 'r' ? '\r' : e === 't' ? '\t' : e;
          i += 2;
        } else s += src[i++];
      }
      i++; push('string', s); continue;
    }
    if (c === "'") {                                            // fourcc / raw code
      let s = ''; i++;
      while (i < n && src[i] !== "'") {
        if (src[i] === '\\') { s += src[i + 1]; i += 2; } else s += src[i++];
      }
      i++;
      let v = 0;
      if (s.length === 4) for (let k = 0; k < 4; k++) v = (v * 256 + s.charCodeAt(k)) | 0;
      else v = s.charCodeAt(0) | 0;
      push('int', v); continue;
    }
    if (c === '$' || (c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X'))) {
      const start = c === '$' ? i + 1 : i + 2;
      let j = start;
      while (j < n && /[0-9a-fA-F]/.test(src[j])) j++;
      push('int', parseInt(src.slice(start, j), 16) | 0); i = j; continue;
    }
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
      let j = i, real = false;
      while (j < n && /[0-9]/.test(src[j])) j++;
      if (src[j] === '.') { real = true; j++; while (j < n && /[0-9]/.test(src[j])) j++; }
      const text = src.slice(i, j);
      i = j;
      if (real) push('real', parseFloat(text));
      else push('int', parseInt(text, 10) | 0);
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      const w = src.slice(i, j); i = j;
      push(KEYWORDS.has(w) ? w : 'ident', w);
      continue;
    }
    const two = src.substr(i, 2);
    if (['==', '!=', '>=', '<='].includes(two)) { push('op', two); i += 2; continue; }
    if ('+-*/><=(),[]'.includes(c)) { push(c === '(' || c === ')' || c === ',' || c === '[' || c === ']' ? c : 'op', c); i++; continue; }
    i++;                                                        // skip anything unexpected
  }
  push('eof');
  return toks;
}

// ---------------------------------------------------------------------- parser
class P {
  constructor(toks, name) { this.t = toks; this.i = 0; this.name = name; }
  peek(k = 0) { return this.t[this.i + k]; }
  get type() { return this.t[this.i].type; }
  next() { return this.t[this.i++]; }
  at(type) { return this.t[this.i].type === type; }
  accept(type) { return this.at(type) ? this.next() : null; }
  expect(type) {
    if (!this.at(type)) this.err(`expected ${type}, got ${this.type} '${this.peek().value ?? ''}'`);
    return this.next();
  }
  err(msg) {
    throw new Error(`${this.name}:${this.peek().line}: ${msg}`);
  }
  skipNl() { while (this.at('nl')) this.next(); }
  endLine() { while (this.at('nl')) this.next(); }
}

function parseParams(p) {
  if (p.accept('nothing')) return [];
  const out = [];
  do {
    const type = p.expect('ident').value;
    const name = p.expect('ident').value;
    out.push({ type, name });
  } while (p.accept(','));
  return out;
}

function parseExpr(p) { return parseOr(p); }
function parseOr(p) {
  let l = parseAnd(p);
  while (p.at('or')) { p.next(); l = { k: 'bin', op: 'or', l, r: parseAnd(p) }; }
  return l;
}
function parseAnd(p) {
  let l = parseCmp(p);
  while (p.at('and')) { p.next(); l = { k: 'bin', op: 'and', l, r: parseCmp(p) }; }
  return l;
}
const CMP = new Set(['==', '!=', '>', '<', '>=', '<=']);
function parseCmp(p) {
  let l = parseAdd(p);
  while (p.at('op') && CMP.has(p.peek().value)) {
    const op = p.next().value;
    l = { k: 'bin', op, l, r: parseAdd(p) };
  }
  return l;
}
function parseAdd(p) {
  let l = parseMul(p);
  while (p.at('op') && (p.peek().value === '+' || p.peek().value === '-')) {
    const op = p.next().value;
    l = { k: 'bin', op, l, r: parseMul(p) };
  }
  return l;
}
function parseMul(p) {
  let l = parseUnary(p);
  while (p.at('op') && (p.peek().value === '*' || p.peek().value === '/')) {
    const op = p.next().value;
    l = { k: 'bin', op, l, r: parseUnary(p) };
  }
  return l;
}
function parseUnary(p) {
  if (p.at('not')) { p.next(); return { k: 'not', e: parseUnary(p) }; }
  if (p.at('op') && p.peek().value === '-') { p.next(); return { k: 'neg', e: parseUnary(p) }; }
  if (p.at('op') && p.peek().value === '+') { p.next(); return parseUnary(p); }
  return parseAtom(p);
}
function parseAtom(p) {
  const t = p.peek();
  if (p.accept('(')) { const e = parseExpr(p); p.expect(')'); return e; }
  if (t.type === 'int')    { p.next(); return { k: 'int', v: t.value }; }
  if (t.type === 'real')   { p.next(); return { k: 'real', v: t.value }; }
  if (t.type === 'string') { p.next(); return { k: 'str', v: t.value }; }
  if (t.type === 'true')   { p.next(); return { k: 'bool', v: true }; }
  if (t.type === 'false')  { p.next(); return { k: 'bool', v: false }; }
  if (t.type === 'null')   { p.next(); return { k: 'null' }; }
  if (t.type === 'function') { p.next(); return { k: 'funcref', name: p.expect('ident').value }; }
  if (t.type === 'ident') {
    p.next();
    if (p.at('(')) {
      p.next();
      const args = [];
      if (!p.at(')')) do { args.push(parseExpr(p)); } while (p.accept(','));
      p.expect(')');
      return { k: 'call', name: t.value, args };
    }
    if (p.at('[')) {
      p.next();
      const idx = parseExpr(p);
      p.expect(']');
      return { k: 'index', name: t.value, idx };
    }
    return { k: 'var', name: t.value };
  }
  p.err(`unexpected ${t.type}`);
}

function parseBlock(p, enders) {
  const out = [];
  for (;;) {
    p.skipNl();
    if (enders.has(p.type) || p.at('eof')) return out;
    out.push(parseStmt(p));
  }
}

function parseStmt(p) {
  p.accept('debug');
  if (p.accept('local')) {
    const type = p.expect('ident').value;
    const isArr = !!p.accept('array');
    const name = p.expect('ident').value;
    let init = null;
    if (p.at('op') && p.peek().value === '=') { p.next(); init = parseExpr(p); }
    return { k: 'local', type, name, isArr, init };
  }
  if (p.accept('set')) {
    const name = p.expect('ident').value;
    let idx = null;
    if (p.accept('[')) { idx = parseExpr(p); p.expect(']'); }
    if (!(p.at('op') && p.peek().value === '=')) p.err('expected = in set');
    p.next();
    return { k: 'set', name, idx, e: parseExpr(p) };
  }
  if (p.accept('call')) {
    const name = p.expect('ident').value;
    p.expect('(');
    const args = [];
    if (!p.at(')')) do { args.push(parseExpr(p)); } while (p.accept(','));
    p.expect(')');
    return { k: 'callstmt', name, args };
  }
  if (p.accept('if')) {
    const cond = parseExpr(p);
    p.expect('then');
    const then = parseBlock(p, new Set(['elseif', 'else', 'endif']));
    const clauses = [{ cond, body: then }];
    let els = null;
    for (;;) {
      if (p.accept('elseif')) {
        const c = parseExpr(p); p.expect('then');
        clauses.push({ cond: c, body: parseBlock(p, new Set(['elseif', 'else', 'endif'])) });
      } else if (p.accept('else')) {
        els = parseBlock(p, new Set(['endif']));
      } else { p.expect('endif'); break; }
    }
    return { k: 'if', clauses, els };
  }
  if (p.accept('loop')) {
    const body = parseBlock(p, new Set(['endloop']));
    p.expect('endloop');
    return { k: 'loop', body };
  }
  if (p.accept('exitwhen')) return { k: 'exitwhen', e: parseExpr(p) };
  if (p.accept('return')) {
    if (p.at('nl') || p.at('eof')) return { k: 'return', e: null };
    return { k: 'return', e: parseExpr(p) };
  }
  p.err(`unexpected statement '${p.peek().value ?? p.type}'`);
}

export function parse(src, name = 'script') {
  const p = new P(lex(src), name);
  const out = { types: [], globals: [], natives: [], functions: [] };
  for (;;) {
    p.skipNl();
    if (p.at('eof')) break;
    if (p.accept('type')) {
      const t = p.expect('ident').value;
      p.expect('extends');
      out.types.push({ name: t, base: p.expect('ident').value });
      continue;
    }
    if (p.accept('globals')) {
      for (;;) {
        p.skipNl();
        if (p.accept('endglobals')) break;
        if (p.at('eof')) p.err('unterminated globals');
        const isConst = !!p.accept('constant');
        const type = p.expect('ident').value;
        const isArr = !!p.accept('array');
        const name = p.expect('ident').value;
        let init = null;
        if (p.at('op') && p.peek().value === '=') { p.next(); init = parseExpr(p); }
        out.globals.push({ type, name, isArr, init, isConst });
      }
      continue;
    }
    const isConst = !!p.accept('constant');
    if (p.accept('native')) {
      const name = p.expect('ident').value;
      p.expect('takes');
      const params = parseParams(p);
      p.expect('returns');
      const ret = p.at('nothing') ? (p.next(), 'nothing') : p.expect('ident').value;
      out.natives.push({ name, params, ret, isConst });
      continue;
    }
    if (p.accept('function')) {
      const name = p.expect('ident').value;
      p.expect('takes');
      const params = parseParams(p);
      p.expect('returns');
      const ret = p.at('nothing') ? (p.next(), 'nothing') : p.expect('ident').value;
      const body = parseBlock(p, new Set(['endfunction']));
      p.expect('endfunction');
      out.functions.push({ name, params, ret, body });
      continue;
    }
    p.err(`unexpected top-level '${p.peek().value ?? p.type}'`);
  }
  return out;
}
