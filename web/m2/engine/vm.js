// JASS interpreter. Tree-walking, generator-based so scripts can sleep like real
// JASS threads (TriggerSleepAction / PolledWait) and be resumed by the scheduler.

const INT = 'integer', REAL = 'real', STR = 'string', BOOL = 'boolean', CODE = 'code';
const NUMERIC = new Set([INT, REAL]);
const trunc = (v) => (v < 0 ? Math.ceil(v) : Math.floor(v)) | 0;

/**
 * JASS equality. Warcraft III treats a null handle as false when compared with a
 * boolean, which map scripts rely on (`IsUnitType(u, HERO) != null`).
 */
function jassEq(a, b) {
  if (typeof a === 'boolean' && b == null) return a === false;
  if (typeof b === 'boolean' && a == null) return b === false;
  if (a == null && b == null) return true;
  return a === b;
}

export const SLEEP = Symbol('sleep');       // yielded value: { [SLEEP]: seconds }
const RET = Symbol('ret');

export class Handle {
  constructor(type, props = {}) { this.__type = type; Object.assign(this, props); }
}

class Scope {
  constructor(parent) { this.vars = new Map(); this.parent = parent; }
  lookup(n) {
    let s = this;
    while (s) { const v = s.vars.get(n); if (v) return v; s = s.parent; }
    return null;
  }
}

export class VM {
  constructor() {
    this.functions = new Map();     // name -> {params, ret, body}
    this.natives = new Map();       // name -> {fn, ret, params}
    this.nativeSigs = new Map();    // name -> {params, ret} from common.j
    this.types = new Map();         // handle type -> base
    this.globals = new Map();       // name -> {type, isArr, value}
    this.onError = (e, where) => { throw e; };
    this.opCount = 0;
    this.opLimit = 8_000_000;       // per-thread runaway guard
  }

  // ------------------------------------------------------------------ loading
  addTypes(ast) { for (const t of ast.types) this.types.set(t.name, t.base); }
  addNativeSigs(ast) { for (const n of ast.natives) this.nativeSigs.set(n.name, n); }
  addFunctions(ast) { for (const f of ast.functions) this.functions.set(f.name, f); }

  /** Declare globals; their initialisers run later inside a thread. */
  addGlobals(ast) {
    for (const g of ast.globals) {
      if (this.globals.has(g.name) && g.init === null) continue;
      this.globals.set(g.name, { type: g.type, isArr: g.isArr,
                                 value: g.isArr ? [] : this.defaultFor(g.type), init: g.init });
    }
  }

  defaultFor(type) {
    if (type === INT) return 0;
    if (type === REAL) return 0;
    if (type === BOOL) return false;
    if (type === STR) return null;
    return null;
  }

  registerNative(name, fn) { this.natives.set(name, fn); }
  registerNatives(obj) { for (const k of Object.keys(obj)) this.natives.set(k, obj[k]); }

  /** Run every global initialiser, in declaration order. */
  *initGlobals() {
    for (const [name, g] of this.globals) {
      if (!g.init) continue;
      const scope = new Scope(null);
      const v = yield* this.eval(g.init, scope);
      g.value = this.coerce(v, g.type);
    }
  }

  // ---------------------------------------------------------------- type rules
  typeOf(e, scope) {
    switch (e.k) {
      case 'int': return INT;
      case 'real': return REAL;
      case 'str': return STR;
      case 'bool': return BOOL;
      case 'null': return 'handle';
      case 'funcref': return CODE;
      case 'neg': return this.typeOf(e.e, scope);
      case 'not': return BOOL;
      case 'var': case 'index': {
        const l = scope && scope.lookup(e.name);
        if (l) return l.type;
        const g = this.globals.get(e.name);
        return g ? g.type : 'handle';
      }
      case 'call': {
        const f = this.functions.get(e.name);
        if (f) return f.ret;
        const s = this.nativeSigs.get(e.name);
        return s ? s.ret : 'handle';
      }
      case 'bin': {
        if (['and', 'or', '==', '!=', '<', '>', '<=', '>='].includes(e.op)) return BOOL;
        const lt = this.typeOf(e.l, scope), rt = this.typeOf(e.r, scope);
        if (lt === STR || rt === STR) return STR;
        return lt === INT && rt === INT ? INT : REAL;
      }
    }
    return 'handle';
  }

  coerce(v, type) {
    if (type === INT) return typeof v === 'number' ? trunc(v) : (v ? 1 : 0);
    if (type === REAL) return typeof v === 'number' ? v : 0;
    if (type === BOOL) return !!v;
    if (type === STR) return v === null || v === undefined ? null : String(v);
    return v === undefined ? null : v;
  }

  // --------------------------------------------------------------- evaluation
  *eval(e, scope) {
    if (++this.opCount > this.opLimit) throw new Error('JASS op limit exceeded');
    switch (e.k) {
      case 'int': case 'real': return e.v;
      case 'str': return e.v;
      case 'bool': return e.v;
      case 'null': return null;
      case 'funcref': return new Handle(CODE, { fn: e.name });
      case 'var': {
        const l = scope.lookup(e.name);
        if (l) return l.value;
        const g = this.globals.get(e.name);
        if (!g) return null;
        return g.value;
      }
      case 'index': {
        const idx = trunc(yield* this.eval(e.idx, scope));
        const l = scope.lookup(e.name);
        const holder = l || this.globals.get(e.name);
        if (!holder) return null;
        const arr = holder.value;
        const v = arr ? arr[idx] : undefined;
        return v === undefined ? this.defaultFor(holder.type) : v;
      }
      case 'neg': return -(yield* this.eval(e.e, scope));
      case 'not': return !(yield* this.eval(e.e, scope));
      case 'bin': {
        const op = e.op;
        if (op === 'and') return (yield* this.eval(e.l, scope)) ? !!(yield* this.eval(e.r, scope)) : false;
        if (op === 'or')  return (yield* this.eval(e.l, scope)) ? true : !!(yield* this.eval(e.r, scope));
        const a = yield* this.eval(e.l, scope);
        const b = yield* this.eval(e.r, scope);
        switch (op) {
          case '==': return jassEq(a, b);
          case '!=': return !jassEq(a, b);
          case '<': return a < b; case '>': return a > b;
          case '<=': return a <= b; case '>=': return a >= b;
          case '+': {
            if (typeof a === 'string' || typeof b === 'string')
              return (a === null ? '' : a) + (b === null ? '' : b);
            const t = this.typeOf(e, scope);
            return t === INT ? trunc(a + b) : a + b;
          }
          case '-': { const t = this.typeOf(e, scope); return t === INT ? trunc(a - b) : a - b; }
          case '*': { const t = this.typeOf(e, scope); return t === INT ? trunc(a * b) : a * b; }
          case '/': {
            const t = this.typeOf(e, scope);
            if (t === INT) return b === 0 ? 0 : trunc(a / b);
            return b === 0 ? 0 : a / b;
          }
        }
        return null;
      }
      case 'call': return yield* this.call(e.name, yield* this.args(e.args, scope), scope);
    }
    return null;
  }

  *args(list, scope) {
    const out = [];
    for (const a of list) out.push(yield* this.eval(a, scope));
    return out;
  }

  *call(name, argv, scope) {
    const nat = this.natives.get(name);
    if (nat) {
      const r = nat(...argv);
      // natives may return a generator when they need to sleep
      if (r && typeof r.next === 'function' && typeof r[Symbol.iterator] === 'function')
        return yield* r;
      const sig = this.nativeSigs.get(name);
      return sig ? this.coerce(r, sig.ret) : (r === undefined ? null : r);
    }
    const fn = this.functions.get(name);
    if (!fn) {
      const sig = this.nativeSigs.get(name);
      if (sig) return this.defaultFor(sig.ret);          // declared but unimplemented
      throw new Error(`undefined function ${name}`);
    }
    return yield* this.invoke(fn, argv);
  }

  *invoke(fn, argv) {
    const scope = new Scope(null);
    fn.params.forEach((p, i) => {
      scope.vars.set(p.name, { type: p.type, value: this.coerce(argv[i], p.type) });
    });
    const r = yield* this.block(fn.body, scope);
    if (r && r.t === RET) return this.coerce(r.v, fn.ret);
    return this.defaultFor(fn.ret);
  }

  /** Execute a statement list. Returns {t:RET,v} or 'exit' or undefined. */
  *block(stmts, scope) {
    for (const s of stmts) {
      const r = yield* this.exec(s, scope);
      if (r) return r;
    }
    return undefined;
  }

  *exec(s, scope) {
    if (++this.opCount > this.opLimit) throw new Error('JASS op limit exceeded');
    switch (s.k) {
      case 'local': {
        const slot = { type: s.type, isArr: s.isArr,
                       value: s.isArr ? [] : this.defaultFor(s.type) };
        scope.vars.set(s.name, slot);
        if (s.init) slot.value = this.coerce(yield* this.eval(s.init, scope), s.type);
        return;
      }
      case 'set': {
        const l = scope.lookup(s.name);
        const holder = l || this.globals.get(s.name);
        if (!holder) return;
        const v = yield* this.eval(s.e, scope);
        if (s.idx !== null && s.idx !== undefined) {
          const i = trunc(yield* this.eval(s.idx, scope));
          if (!holder.value || !Array.isArray(holder.value)) holder.value = [];
          holder.value[i] = this.coerce(v, holder.type);
        } else holder.value = this.coerce(v, holder.type);
        return;
      }
      case 'callstmt': {
        yield* this.call(s.name, yield* this.args(s.args, scope), scope);
        return;
      }
      case 'if': {
        for (const c of s.clauses) {
          if (yield* this.eval(c.cond, scope)) {
            return yield* this.block(c.body, new Scope(scope));
          }
        }
        if (s.els) return yield* this.block(s.els, new Scope(scope));
        return;
      }
      case 'loop': {
        for (;;) {
          const r = yield* this.block(s.body, new Scope(scope));
          if (r === 'exit') return;
          if (r) return r;
          if (++this.opCount > this.opLimit) throw new Error('JASS loop limit exceeded');
        }
      }
      case 'exitwhen': {
        if (yield* this.eval(s.e, scope)) return 'exit';
        return;
      }
      case 'return': {
        return { t: RET, v: s.e ? yield* this.eval(s.e, scope) : null };
      }
    }
  }

  /** Start a JASS thread for a function name. Returns a generator. */
  *runFunction(name, argv = []) {
    const fn = this.functions.get(name);
    if (!fn) return null;
    return yield* this.invoke(fn, argv);
  }
}
