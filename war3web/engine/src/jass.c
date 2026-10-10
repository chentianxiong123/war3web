// jass.c — JASS 脚本解析器（C 移植自 server/jass/parse.js）。
//
// M3 路标：把地图脚本解析从 JS 挪进 WASM 引擎。本文件实现词法 + 语法分析，
// 构建与 JS 版 parse() 完全同构的 AST（节点键名/形状一致），序列化为 JSON
// 输出，供 Node 端逐节点对照验证；AST 结构同时是后续 C 版 VM 执行器的内存
// 蓝图（M3 第三步直接按此节点布局执行）。
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

// ------------------------------------------------------------------ tokens

enum {
  T_NL,      // newline
  T_IDENT,   // identifier / keyword (kw set when keyword)
  T_INT,     // v.i
  T_REAL,    // v.f
  T_STR,     // v.s (escaped, arena-owned)
  T_OP,      // v.s: operators AND structural chars ( ) , [ ]
  T_EOF
};

enum {
  K_NONE = 0, K_GLOBALS, K_ENDGLOBALS, K_CONSTANT, K_NATIVE, K_TYPE,
  K_EXTENDS, K_FUNCTION, K_ENDFUNCTION, K_TAKES, K_RETURNS, K_NOTHING,
  K_LOCAL, K_SET, K_CALL, K_IF, K_THEN, K_ELSEIF, K_ELSE, K_ENDIF,
  K_LOOP, K_ENDLOOP, K_EXITWHEN, K_RETURN, K_ARRAY, K_AND, K_OR, K_NOT,
  K_TRUE, K_FALSE, K_NULL, K_DEBUG
};

typedef struct {
  int kind;
  int kw;
  long long i;
  double f;
  const char* s;         // arena-owned
  int line;
} Tok;

typedef struct { Tok* t; int n; int cap; } TokBuf;

// --------------------------------------------------------------- arena
//
// 块链表分配器：新块挂在链表头，已分配块永不移动 → 所有返回值（tokens 的
// 字符串、AST 节点）指针在整个解析期间保持稳定。不能用 realloc（单块 realloc
// 会把之前分发的指针全部悬垂——曾导致 war3map.j 解析乱码死循环）。

typedef struct Chunk { struct Chunk* next; size_t used, cap; char data[1]; } Chunk;
typedef struct { Chunk* head; } Arena;

static void* a_alloc(Arena* a, size_t sz) {
  sz = (sz + 15) & ~(size_t)15;
  Chunk* c = a->head;
  if (!c || c->used + sz > c->cap) {
    size_t cap = sz > 65536 ? sz : 65536;
    Chunk* nc = (Chunk*)malloc(sizeof(Chunk) - 1 + cap);
    nc->next = a->head; nc->used = 0; nc->cap = cap;
    a->head = nc;
    c = nc;
  }
  void* out = c->data + c->used;
  c->used += sz;
  memset(out, 0, sz);
  return out;
}
static const char* a_strn(Arena* a, const char* s, size_t len) {
  if (!s) return NULL;
  char* p = (char*)a_alloc(a, len + 1);
  memcpy(p, s, len);
  p[len] = 0;
  return p;
}
static const char* a_str(Arena* a, const char* s) {
  return s ? a_strn(a, s, strlen(s)) : NULL;
}
static void a_free_all(Arena* a) {
  Chunk* c = a->head;
  while (c) { Chunk* nx = c->next; free(c); c = nx; }
  a->head = NULL;
}

// ------------------------------------------------------------------ AST

typedef enum {
  E_INT, E_REAL, E_STR, E_BOOL, E_NULL, E_FUNCREF, E_VAR, E_INDEX,
  E_CALL, E_BIN, E_NOT, E_NEG
} ExprKind;

typedef struct Expr Expr;
typedef struct Stmt Stmt;

struct Expr {
  int k;
  long long i; double f; const char* s; int bv;
  const char* name;      // var / index / call / funcref
  const char* op;        // bin
  Expr* l, *r;           // bin
  Expr* e;               // not / neg
  Expr* idx;             // index
  Expr** args; int nargs; // call
};

typedef struct {
  Expr* cond;
  Stmt* body; int nbody;   // heap value array
} Clause;

struct Stmt {
  int k;  // S_*
  const char* type, *name; int isArr; Expr* init;   // local
  Expr* idx; Expr* e;                                 // set / exitwhen / return
  const char* cname; Expr** args; int nargs;          // callstmt
  Clause* clauses; int nclauses;                      // if
  Stmt* els; int nels;                                // if else branch
  Stmt* body; int nbody;                              // loop
};

enum { S_LOCAL, S_SET, S_CALLSTMT, S_IF, S_LOOP, S_EXITWHEN, S_RETURN };

typedef struct { const char* name; const char* base; } TypeDecl;
typedef struct { const char* type, *name; Expr* init; int isArr, isConst; } GlobalDecl;
typedef struct {
  const char* name;
  const char** ptypes; const char** pnames; int nparams;
  const char* ret; int isConst;
} FuncSig;
typedef struct { FuncSig sig; Stmt* body; int nbody; } FuncDef;

// ------------------------------------------------------------------ lexer

static int is_digit(char c) { return c >= '0' && c <= '9'; }
static int is_hex(char c) {
  return is_digit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
}
static int is_ident(char c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c == '_';
}
static int is_identn(char c) { return is_ident(c) || is_digit(c); }

static int kw_of(const char* w, int len) {
  static const struct { const char* s; int k; } tab[] = {
    {"globals", K_GLOBALS}, {"endglobals", K_ENDGLOBALS}, {"constant", K_CONSTANT},
    {"native", K_NATIVE}, {"type", K_TYPE}, {"extends", K_EXTENDS},
    {"function", K_FUNCTION}, {"endfunction", K_ENDFUNCTION}, {"takes", K_TAKES},
    {"returns", K_RETURNS}, {"nothing", K_NOTHING}, {"local", K_LOCAL},
    {"set", K_SET}, {"call", K_CALL}, {"if", K_IF}, {"then", K_THEN},
    {"elseif", K_ELSEIF}, {"else", K_ELSE}, {"endif", K_ENDIF}, {"loop", K_LOOP},
    {"endloop", K_ENDLOOP}, {"exitwhen", K_EXITWHEN}, {"return", K_RETURN},
    {"array", K_ARRAY}, {"and", K_AND}, {"or", K_OR}, {"not", K_NOT},
    {"true", K_TRUE}, {"false", K_FALSE}, {"null", K_NULL}, {"debug", K_DEBUG}
  };
  for (size_t j = 0; j < sizeof(tab) / sizeof(tab[0]); j++)
    if ((int)strlen(tab[j].s) == len && strncmp(tab[j].s, w, len) == 0)
      return tab[j].k;
  return K_NONE;
}

static void tok_push(TokBuf* L, int kind, int kw, long long i, double f,
                     const char* s, int line) {
  if (L->n == L->cap) {
    L->cap = L->cap ? L->cap * 2 : 256;
    L->t = (Tok*)realloc(L->t, (size_t)L->cap * sizeof(Tok));
  }
  Tok* t = &L->t[L->n++];
  t->kind = kind; t->kw = kw; t->i = i; t->f = f; t->s = s; t->line = line;
}

// 与 parse.js 的 lex() 逐规则对应。所有字符串经 arena 持有；token 数组本身
// 为 realloc 堆内存，由调用方 free。
static Tok* jass_lex(const char* src, int len, int* out_n, Arena* ar) {
  TokBuf L = {0};
  int line = 1;
  int i = 0;
  while (i < len) {
    char c = src[i];
    if (c == '\n') { tok_push(&L, T_NL, 0, 0, 0, NULL, line); line++; i++; continue; }
    if (c == ' ' || c == '\t' || c == '\r') { i++; continue; }
    if (c == '/' && i + 1 < len && src[i + 1] == '/') {
      while (i < len && src[i] != '\n') i++; continue;
    }
    if (c == '/' && i + 1 < len && src[i + 1] == '*') {
      i += 2;
      while (i < len && !(src[i] == '*' && i + 1 < len && src[i + 1] == '/')) {
        if (src[i] == '\n') line++;
        i++;
      }
      i += 2; continue;
    }
    if (c == '"') {
      char* s = (char*)malloc(1);
      size_t n = 0;
      i++;
      while (i < len && src[i] != '"') {
        if (src[i] == '\\' && i + 1 < len) {
          char e = src[i + 1];
          char ch = e == 'n' ? '\n' : e == 'r' ? '\r' : e == 't' ? '\t' : e;
          s = (char*)realloc(s, n + 2); s[n++] = ch;
          i += 2;
        } else {
          s = (char*)realloc(s, n + 2); s[n++] = src[i++];
        }
      }
      i++;
      s = (char*)realloc(s, n + 1); s[n] = 0;
      tok_push(&L, T_STR, 0, 0, 0, a_str(ar, s), line);
      free(s);
      continue;
    }
    if (c == '\'') {
      char s[8]; int n = 0;
      i++;
      while (i < len && src[i] != '\'') {
        if (src[i] == '\\' && i + 1 < len) { s[n++] = src[i + 1]; i += 2; }
        else s[n++] = src[i++];
      }
      i++;
      long long v = 0;
      if (n == 4) for (int k = 0; k < 4; k++) v = (v << 8) | (unsigned char)s[k];
      else v = (unsigned char)s[0];
      tok_push(&L, T_INT, 0, v, 0, NULL, line);
      continue;
    }
    if (c == '$' || (c == '0' && i + 1 < len && (src[i + 1] == 'x' || src[i + 1] == 'X'))) {
      int start = c == '$' ? i + 1 : i + 2;
      int j = start;
      while (j < len && is_hex(src[j])) j++;
      long long v = 0;
      for (int k = start; k < j; k++) {
        char h = src[k];
        v = v * 16 + (h <= '9' ? h - '0' : (h | 32) - 'a' + 10);
      }
      tok_push(&L, T_INT, 0, v, 0, NULL, line);
      i = j; continue;
    }
    if (is_digit(c) || (c == '.' && i + 1 < len && is_digit(src[i + 1]))) {
      int j = i, real = 0;
      while (j < len && is_digit(src[j])) j++;
      if (j < len && src[j] == '.') { real = 1; j++; while (j < len && is_digit(src[j])) j++; }
      char* text = (char*)malloc((size_t)(j - i) + 1);
      memcpy(text, src + i, (size_t)(j - i)); text[j - i] = 0;
      if (real) tok_push(&L, T_REAL, 0, 0, atof(text), NULL, line);
      else tok_push(&L, T_INT, 0, strtoll(text, NULL, 10), 0, NULL, line);
      free(text);
      i = j; continue;
    }
    if (is_ident(c)) {
      int j = i;
      while (j < len && is_identn(src[j])) j++;
      int kw = kw_of(src + i, j - i);
      tok_push(&L, T_IDENT, kw, 0, 0, a_strn(ar, src + i, (size_t)(j - i)), line);
      i = j; continue;
    }
    if (i + 1 < len) {
      char two[3] = {src[i], src[i + 1], 0};
      if (strcmp(two, "==") == 0 || strcmp(two, "!=") == 0 ||
          strcmp(two, ">=") == 0 || strcmp(two, "<=") == 0) {
        tok_push(&L, T_OP, 0, 0, 0, a_str(ar, two), line);
        i += 2; continue;
      }
    }
    if (strchr("+-*/><=(),[]", c)) {
      char one[2] = {c, 0};
      tok_push(&L, T_OP, 0, 0, 0, a_str(ar, one), line);
      i++; continue;
    }
    i++;
  }
  tok_push(&L, T_EOF, 0, 0, 0, NULL, line);
  *out_n = L.n;
  return L.t;
}

// ------------------------------------------------------------------ parser

typedef struct {
  Tok* t; int n; int i;
  Arena* ar;
  int error;
  int line;
} P;

static Tok* peek(P* p, int k) {
  int j = p->i + k;
  return j < p->n ? &p->t[j] : &p->t[p->n - 1];
}
static Tok* cur(P* p) { return peek(p, 0); }
static Tok* next(P* p) { return &p->t[p->i++ < p->n ? p->i - 1 : p->n - 1]; }
static int cur_line(P* p) { return cur(p)->line; }

static int at_kw(P* p, int kw) { return cur(p)->kind == T_IDENT && cur(p)->kw == kw; }
static int at_op(P* p, const char* s) {
  return cur(p)->kind == T_OP && cur(p)->s && strcmp(cur(p)->s, s) == 0;
}
static int at_type(P* p, int kind) { return cur(p)->kind == kind; }
static int at_ident(P* p) { return cur(p)->kind == T_IDENT; }

static void skip_nl(P* p) { while (at_type(p, T_NL)) next(p); }

static void expect_kw(P* p, int kw) {
  if (!at_kw(p, kw)) p->error = 1;
  else next(p);
}
static void expect_op(P* p, const char* s) {
  if (!at_op(p, s)) p->error = 1;
  else next(p);
}

static void set_err(P* p) { if (!p->error) p->error = 1; }

// ---- expression nodes
static Expr* e_k(P* p, int k) {
  Expr* e = (Expr*)a_alloc(p->ar, sizeof(Expr));
  e->k = k;
  return e;
}

static Expr* parse_expr(P* p);
static Expr* parse_or(P* p);
static Expr* parse_and(P* p);
static Expr* parse_cmp(P* p);
static Expr* parse_add(P* p);
static Expr* parse_mul(P* p);
static Expr* parse_unary(P* p);
static Expr* parse_atom(P* p);

static Expr* parse_or(P* p) {
  Expr* l = parse_and(p);
  while (!p->error && at_kw(p, K_OR)) {
    next(p);
    Expr* r = parse_and(p);
    Expr* n = e_k(p, E_BIN);
    n->op = "or"; n->l = l; n->r = r;
    l = n;
  }
  return l;
}
static Expr* parse_and(P* p) {
  Expr* l = parse_cmp(p);
  while (!p->error && at_kw(p, K_AND)) {
    next(p);
    Expr* r = parse_cmp(p);
    Expr* n = e_k(p, E_BIN);
    n->op = "and"; n->l = l; n->r = r;
    l = n;
  }
  return l;
}
static int is_cmp_op(const char* s) {
  return s && (strcmp(s, "==") == 0 || strcmp(s, "!=") == 0 || strcmp(s, ">") == 0 ||
               strcmp(s, "<") == 0 || strcmp(s, ">=") == 0 || strcmp(s, "<=") == 0);
}
static Expr* parse_cmp(P* p) {
  Expr* l = parse_add(p);
  while (!p->error && cur(p)->kind == T_OP && cur(p)->s && is_cmp_op(cur(p)->s)) {
    const char* op = next(p)->s;
    Expr* r = parse_add(p);
    Expr* n = e_k(p, E_BIN);
    n->op = op; n->l = l; n->r = r;
    l = n;
  }
  return l;
}
static Expr* parse_add(P* p) {
  Expr* l = parse_mul(p);
  while (!p->error && (at_op(p, "+") || at_op(p, "-"))) {
    const char* op = next(p)->s;
    Expr* r = parse_mul(p);
    Expr* n = e_k(p, E_BIN);
    n->op = op; n->l = l; n->r = r;
    l = n;
  }
  return l;
}
static Expr* parse_mul(P* p) {
  Expr* l = parse_unary(p);
  while (!p->error && (at_op(p, "*") || at_op(p, "/"))) {
    const char* op = next(p)->s;
    Expr* r = parse_unary(p);
    Expr* n = e_k(p, E_BIN);
    n->op = op; n->l = l; n->r = r;
    l = n;
  }
  return l;
}
static Expr* parse_unary(P* p) {
  if (at_kw(p, K_NOT)) {
    next(p);
    Expr* n = e_k(p, E_NOT);
    n->e = parse_unary(p);
    return n;
  }
  if (at_op(p, "-")) {
    next(p);
    Expr* n = e_k(p, E_NEG);
    n->e = parse_unary(p);
    return n;
  }
  if (at_op(p, "+")) { next(p); return parse_unary(p); }
  return parse_atom(p);
}
static Expr* parse_atom(P* p) {
  Tok* t = cur(p);
  if (at_op(p, "(")) {
    next(p);
    Expr* e = parse_expr(p);
    expect_op(p, ")");
    return e;
  }
  if (t->kind == T_INT) { next(p); Expr* e = e_k(p, E_INT); e->i = t->i; return e; }
  if (t->kind == T_REAL) { next(p); Expr* e = e_k(p, E_REAL); e->f = t->f; return e; }
  if (t->kind == T_STR) { next(p); Expr* e = e_k(p, E_STR); e->s = t->s; return e; }
  if (at_kw(p, K_TRUE)) { next(p); Expr* e = e_k(p, E_BOOL); e->bv = 1; return e; }
  if (at_kw(p, K_FALSE)) { next(p); Expr* e = e_k(p, E_BOOL); e->bv = 0; return e; }
  if (at_kw(p, K_NULL)) { next(p); Expr* e = e_k(p, E_NULL); return e; }
  if (at_kw(p, K_FUNCTION)) {
    next(p);
    Expr* e = e_k(p, E_FUNCREF);
    if (!at_ident(p)) { set_err(p); return e; }
    e->name = next(p)->s;
    return e;
  }
  if (t->kind == T_IDENT) {
    const char* name = next(p)->s;
    if (at_op(p, "(")) {
      next(p);
      Expr* e = e_k(p, E_CALL);
      e->name = name;
      if (!at_op(p, ")")) {
        Expr** tmp = NULL; int ntmp = 0, ctmp = 0;
        do {
          if (ntmp == ctmp) { ctmp = ctmp ? ctmp * 2 : 4; tmp = (Expr**)realloc(tmp, sizeof(Expr*) * (size_t)ctmp); }
          tmp[ntmp++] = parse_expr(p);
        } while (!p->error && at_op(p, ",") && (next(p), 1));
        // 一次性拷入 arena（每次 a_alloc 新数组会丢之前的元素）
        e->args = (Expr**)a_alloc(p->ar, sizeof(Expr*) * (size_t)(ntmp ? ntmp : 1));
        if (ntmp) memcpy(e->args, tmp, sizeof(Expr*) * (size_t)ntmp);
        e->nargs = ntmp;
        free(tmp);
      }
      expect_op(p, ")");
      return e;
    }
    if (at_op(p, "[")) {
      next(p);
      Expr* e = e_k(p, E_INDEX);
      e->name = name;
      e->idx = parse_expr(p);
      expect_op(p, "]");
      return e;
    }
    Expr* e = e_k(p, E_VAR);
    e->name = name;
    return e;
  }
  set_err(p);
  return e_k(p, E_NULL);
}

static Expr* parse_expr(P* p) { return parse_or(p); }

// ---- statements: value arrays on the heap (growable), freed after use

typedef struct { Stmt* v; int n, cap; } SArr;

static void sarr_push(SArr* a, Stmt s) {
  if (a->n == a->cap) {
    a->cap = a->cap ? a->cap * 2 : 16;
    a->v = (Stmt*)realloc(a->v, sizeof(Stmt) * (size_t)a->cap);
  }
  a->v[a->n++] = s;
}

static void parse_block(P* p, const int* enders, int nenders, SArr* out);
static void parse_stmt(P* p, SArr* out);

static void parse_block(P* p, const int* enders, int nenders, SArr* out) {
  int guard = 0;
  for (;;) {
    if (++guard > 200000) {
      // 防御：解析不得推进时强制退出（否则 51KB 真实脚本内死循环挂死整个引擎）
      fprintf(stderr, "[jass] guard: i=%d line=%d ctx:", p->i, cur(p)->line);
      for (int kk = p->i - 3; kk <= p->i; kk++) {
        if (kk < 0) continue;
        if (kk >= p->n) break;
        fprintf(stderr, " [%d:%s/%d]", p->t[kk].kind, p->t[kk].s ? p->t[kk].s : "-", p->t[kk].kw);
      }
      fprintf(stderr, "\n");
      set_err(p);
      return;
    }
    skip_nl(p);
    if (at_type(p, T_EOF)) { set_err(p); return; }
    int stop = 0;
    for (int k = 0; k < nenders; k++)
      if (at_kw(p, enders[k])) { stop = 1; break; }
    if (stop) return;
    parse_stmt(p, out);
  }
}

static void parse_stmt(P* p, SArr* out) {
  if (at_kw(p, K_DEBUG)) next(p);
  Stmt s;
  memset(&s, 0, sizeof(s));
#ifdef DBG
  fprintf(stderr, "[parse_stmt] kw=%d kind=%d line=%d s=%s\n", cur(p)->kw, cur(p)->kind, cur(p)->line, cur(p)->s ? cur(p)->s : "-");
#endif
  if (at_kw(p, K_LOCAL)) {
    next(p);
    s.k = S_LOCAL;
    if (!at_ident(p)) { set_err(p); return; }
    s.type = next(p)->s;
    if (at_kw(p, K_ARRAY)) { s.isArr = 1; next(p); }
    if (!at_ident(p)) { set_err(p); return; }
    s.name = next(p)->s;
    if (at_op(p, "=")) { next(p); s.init = parse_expr(p); }
    sarr_push(out, s);
    return;
  }
  if (at_kw(p, K_SET)) {
#ifdef DBG
    printf("[set] enter, i=%d n=%d\n", p->i, p->n);
#endif
    next(p);
#ifdef DBG
    printf("[set] after next, cur kind=%d s=%p\n", cur(p)->kind, cur(p)->s);
#endif
    s.k = S_SET;
    if (!at_ident(p)) { set_err(p); return; }
    s.name = next(p)->s;
#ifdef DBG
    printf("[set] name=%s, i=%d\n", s.name, p->i);
#endif
    if (at_op(p, "[")) { next(p); s.idx = parse_expr(p); expect_op(p, "]"); }
    expect_op(p, "=");
#ifdef DBG
    printf("[set] after =, expr start i=%d\n", p->i);
#endif
    s.e = parse_expr(p);
#ifdef DBG
    printf("[set] expr done\n");
#endif
    sarr_push(out, s);
    return;
  }
  if (at_kw(p, K_CALL)) {
    next(p);
    s.k = S_CALLSTMT;
    if (!at_ident(p)) { set_err(p); return; }
    s.cname = next(p)->s;
    expect_op(p, "(");
    if (!at_op(p, ")")) {
      Expr** tmp = NULL; int ntmp = 0, ctmp = 0;
      do {
        if (ntmp == ctmp) { ctmp = ctmp ? ctmp * 2 : 4; tmp = (Expr**)realloc(tmp, sizeof(Expr*) * (size_t)ctmp); }
        tmp[ntmp++] = parse_expr(p);
      } while (!p->error && at_op(p, ",") && (next(p), 1));
      s.args = (Expr**)a_alloc(p->ar, sizeof(Expr*) * (size_t)(ntmp ? ntmp : 1));
      if (ntmp) memcpy(s.args, tmp, sizeof(Expr*) * (size_t)ntmp);
      s.nargs = ntmp;
      free(tmp);
    }
    expect_op(p, ")");
    sarr_push(out, s);
    return;
  }
  if (at_kw(p, K_IF)) {
    next(p);
    s.k = S_IF;
    s.clauses = (Clause*)malloc(sizeof(Clause) * 4);
    s.nclauses = 1;
    Clause* c0 = &s.clauses[0];
    c0->cond = parse_expr(p);
    expect_kw(p, K_THEN);
    static const int if_end[] = {K_ELSEIF, K_ELSE, K_ENDIF};
    SArr body0 = {0};
    parse_block(p, if_end, 3, &body0);
    c0->body = body0.v; c0->nbody = body0.n;
    for (;;) {
      if (at_kw(p, K_ELSEIF)) {
        next(p);
        s.clauses = (Clause*)realloc(s.clauses, sizeof(Clause) * (size_t)(s.nclauses + 1));
        Clause* c = &s.clauses[s.nclauses++];
        c->cond = parse_expr(p);
        expect_kw(p, K_THEN);
        SArr b = {0};
        parse_block(p, if_end, 3, &b);
        c->body = b.v; c->nbody = b.n;
      } else if (at_kw(p, K_ELSE)) {
        next(p);
        static const int else_end[] = {K_ENDIF};
        SArr eb = {0};
        parse_block(p, else_end, 1, &eb);
        s.els = eb.v; s.nels = eb.n;
      } else {
        expect_kw(p, K_ENDIF);
        break;
      }
    }
    sarr_push(out, s);
    return;
  }
  if (at_kw(p, K_LOOP)) {
    next(p);
    s.k = S_LOOP;
    static const int loop_end[] = {K_ENDLOOP};
    SArr b = {0};
    parse_block(p, loop_end, 1, &b);
    s.body = b.v; s.nbody = b.n;
    expect_kw(p, K_ENDLOOP);
    sarr_push(out, s);
    return;
  }
  if (at_kw(p, K_EXITWHEN)) {
    next(p);
    s.k = S_EXITWHEN;
    s.e = parse_expr(p);
    sarr_push(out, s);
    return;
  }
  if (at_kw(p, K_RETURN)) {
    next(p);
    s.k = S_RETURN;
    if (!at_type(p, T_NL) && !at_type(p, T_EOF)) s.e = parse_expr(p);
    sarr_push(out, s);
    return;
  }
  set_err(p);
}

// ------------------------------------------------------------- JSON output

typedef struct { char* b; size_t n, cap; } Buf;
static void b_put(Buf* b, const char* s) {
  size_t l = strlen(s);
  if (b->n + l + 1 > b->cap) {
    size_t nc = b->cap ? b->cap : 4096;
    while (b->n + l + 1 > nc) nc *= 2;
    b->b = (char*)realloc(b->b, nc);
    b->cap = nc;
  }
  memcpy(b->b + b->n, s, l);
  b->n += l;
  b->b[b->n] = 0;
}
static void b_num(Buf* b, long long v) {
  char tmp[32];
  snprintf(tmp, sizeof(tmp), "%lld", v);
  b_put(b, tmp);
}
static void b_real(Buf* b, double v) {
  char tmp[48];
  snprintf(tmp, sizeof(tmp), "%.15g", v);
  if (strpbrk(tmp, "nNf")) b_put(b, "null");   // NaN / inf -> null
  else b_put(b, tmp);
}
static void b_str(Buf* b, const char* s) {
  b_put(b, "\"");
  for (const char* q = s ? s : ""; *q; q++) {
    char c = *q;
    if (c == '"' || c == '\\') { char e[2] = {'\\', c}; b_put(b, e); }
    else if (c == '\n') b_put(b, "\\n");
    else if (c == '\r') b_put(b, "\\r");
    else if (c == '\t') b_put(b, "\\t");
    else { char e[2] = {c, 0}; b_put(b, e); }
  }
  b_put(b, "\"");
}

static void json_expr(Buf* b, const Expr* e) {
  switch (e->k) {
    case E_INT: b_put(b, "{\"k\":\"int\",\"v\":"); b_num(b, e->i); b_put(b, "}"); break;
    case E_REAL: b_put(b, "{\"k\":\"real\",\"v\":"); b_real(b, e->f); b_put(b, "}"); break;
    case E_STR: b_put(b, "{\"k\":\"str\",\"v\":"); b_str(b, e->s); b_put(b, "}"); break;
    case E_BOOL: b_put(b, e->bv ? "{\"k\":\"bool\",\"v\":true}" : "{\"k\":\"bool\",\"v\":false}"); break;
    case E_NULL: b_put(b, "{\"k\":\"null\"}"); break;
    case E_FUNCREF: b_put(b, "{\"k\":\"funcref\",\"name\":"); b_str(b, e->name); b_put(b, "}"); break;
    case E_VAR: b_put(b, "{\"k\":\"var\",\"name\":"); b_str(b, e->name); b_put(b, "}"); break;
    case E_INDEX:
      b_put(b, "{\"k\":\"index\",\"name\":"); b_str(b, e->name);
      b_put(b, ",\"idx\":"); json_expr(b, e->idx); b_put(b, "}");
      break;
    case E_NOT: b_put(b, "{\"k\":\"not\",\"e\":"); json_expr(b, e->e); b_put(b, "}"); break;
    case E_NEG: b_put(b, "{\"k\":\"neg\",\"e\":"); json_expr(b, e->e); b_put(b, "}"); break;
    case E_BIN:
      b_put(b, "{\"k\":\"bin\",\"op\":"); b_str(b, e->op);
      b_put(b, ",\"l\":"); json_expr(b, e->l);
      b_put(b, ",\"r\":"); json_expr(b, e->r); b_put(b, "}");
      break;
    case E_CALL:
      b_put(b, "{\"k\":\"call\",\"name\":"); b_str(b, e->name);
      b_put(b, ",\"args\":[");
      for (int i = 0; i < e->nargs; i++) {
        if (i) b_put(b, ",");
        json_expr(b, e->args[i]);
      }
      b_put(b, "]}");
      break;
  }
}

static void json_stmts(Buf* b, const Stmt* stmts, int n);

static void json_stmt(Buf* b, const Stmt* s) {
  switch (s->k) {
    case S_LOCAL:
      b_put(b, "{\"k\":\"local\",\"type\":"); b_str(b, s->type);
      b_put(b, ",\"name\":"); b_str(b, s->name);
      b_put(b, ",\"isArr\":"); b_put(b, s->isArr ? "true" : "false");
      b_put(b, ",\"init\":");
      if (s->init) json_expr(b, s->init); else b_put(b, "null");
      b_put(b, "}");
      break;
    case S_SET:
      b_put(b, "{\"k\":\"set\",\"name\":"); b_str(b, s->name);
      b_put(b, ",\"idx\":");
      if (s->idx) json_expr(b, s->idx); else b_put(b, "null");
      b_put(b, ",\"e\":"); json_expr(b, s->e); b_put(b, "}");
      break;
    case S_CALLSTMT:
      b_put(b, "{\"k\":\"callstmt\",\"name\":"); b_str(b, s->cname);
      b_put(b, ",\"args\":[");
      for (int i = 0; i < s->nargs; i++) {
        if (i) b_put(b, ",");
        json_expr(b, s->args[i]);
      }
      b_put(b, "]}");
      break;
    case S_IF:
      b_put(b, "{\"k\":\"if\",\"clauses\":[");
      for (int i = 0; i < s->nclauses; i++) {
        if (i) b_put(b, ",");
        b_put(b, "{\"cond\":");
        json_expr(b, s->clauses[i].cond);
        b_put(b, ",\"body\":[");
        json_stmts(b, s->clauses[i].body, s->clauses[i].nbody);
        b_put(b, "]}");
      }
      b_put(b, "],\"els\":");
      if (s->els) {
        b_put(b, "[");
        json_stmts(b, s->els, s->nels);
        b_put(b, "]");
      } else b_put(b, "null");
      b_put(b, "}");
      break;
    case S_LOOP:
      b_put(b, "{\"k\":\"loop\",\"body\":[");
      json_stmts(b, s->body, s->nbody);
      b_put(b, "]}");
      break;
    case S_EXITWHEN:
      b_put(b, "{\"k\":\"exitwhen\",\"e\":"); json_expr(b, s->e); b_put(b, "}"); break;
    case S_RETURN:
      b_put(b, "{\"k\":\"return\",\"e\":");
      if (s->e) json_expr(b, s->e); else b_put(b, "null");
      b_put(b, "}");
      break;
  }
}

static void json_stmts(Buf* b, const Stmt* stmts, int n) {
  for (int i = 0; i < n; i++) {
    if (i) b_put(b, ",");
    json_stmt(b, &stmts[i]);
  }
}

static void json_params(Buf* b, const FuncSig* sig) {
  b_put(b, "[");
  for (int i = 0; i < sig->nparams; i++) {
    if (i) b_put(b, ",");
    b_put(b, "{\"type\":"); b_str(b, sig->ptypes[i]);
    b_put(b, ",\"name\":"); b_str(b, sig->pnames[i]); b_put(b, "}");
  }
  b_put(b, "]");
}

static void free_stmts(Stmt** arr, int n);

// 入口：解析脚本并序列化完整 AST 为 JSON（与 JS parse() 输出同构）。
// 返回 malloc 的 C 字符串（调用方 free）。
const char* jass_parse(const char* src, int len, int* out_err) {
  Arena ar = {0};
  int n;
  Tok* toks = jass_lex(src, len, &n, &ar);
  P p = {toks, n, 0, &ar, 0, 0};
  Buf out = {0};

  TypeDecl* types = NULL; int ntypes = 0, cap_t = 0;
  GlobalDecl* globals = NULL; int nglobals = 0, cap_g = 0;
  FuncSig* natives = NULL; int nnatives = 0, cap_n = 0;
  FuncDef* funcs = NULL; int nfuncs = 0, cap_f = 0;
#ifdef DBG
  fprintf(stderr, "[jass_parse] lex: %d tokens\n", n);
#endif

  for (;;) {
    skip_nl(&p);
    if (at_type(&p, T_EOF)) break;
    int was_const = 0;
    if (at_kw(&p, K_TYPE)) {
      next(&p);
      if (ntypes == cap_t) { cap_t = cap_t ? cap_t * 2 : 8; types = (TypeDecl*)realloc(types, sizeof(TypeDecl) * (size_t)cap_t); }
      TypeDecl* td = &types[ntypes++];
      memset(td, 0, sizeof(*td));   // realloc 不清零：新元素必须显式初始化
      if (!at_ident(&p)) { set_err(&p); break; }
      td->name = next(&p)->s;
      expect_kw(&p, K_EXTENDS);
      if (!at_ident(&p)) { set_err(&p); break; }
      td->base = next(&p)->s;
      continue;
    }
    if (at_kw(&p, K_GLOBALS)) {
      next(&p);
      for (;;) {
        skip_nl(&p);
        if (at_kw(&p, K_ENDGLOBALS)) { next(&p); break; }
        if (at_type(&p, T_EOF)) { set_err(&p); break; }
        if (nglobals == cap_g) { cap_g = cap_g ? cap_g * 2 : 8; globals = (GlobalDecl*)realloc(globals, sizeof(GlobalDecl) * (size_t)cap_g); }
        GlobalDecl* g = &globals[nglobals++];
        memset(g, 0, sizeof(*g));
        if (at_kw(&p, K_CONSTANT)) { g->isConst = 1; next(&p); }
        if (!at_ident(&p)) { set_err(&p); break; }
        g->type = next(&p)->s;
        if (at_kw(&p, K_ARRAY)) { g->isArr = 1; next(&p); }
        if (!at_ident(&p)) { set_err(&p); break; }
        g->name = next(&p)->s;
        if (at_op(&p, "=")) { next(&p); g->init = parse_expr(&p); }
      }
      continue;
    }
    if (at_kw(&p, K_CONSTANT)) { was_const = 1; next(&p); }
    if (at_kw(&p, K_NATIVE)) {
      next(&p);
      if (nnatives == cap_n) { cap_n = cap_n ? cap_n * 2 : 8; natives = (FuncSig*)realloc(natives, sizeof(FuncSig) * (size_t)cap_n); }
      FuncSig* f = &natives[nnatives++];
      memset(f, 0, sizeof(*f));
      f->isConst = was_const;
      if (!at_ident(&p)) { set_err(&p); break; }
      f->name = next(&p)->s;
      expect_kw(&p, K_TAKES);
      if (at_kw(&p, K_NOTHING)) { next(&p); }
      else {
        do {
          f->ptypes = (const char**)realloc(f->ptypes, sizeof(char*) * (size_t)(f->nparams + 1));
          f->pnames = (const char**)realloc(f->pnames, sizeof(char*) * (size_t)(f->nparams + 1));
          if (!at_ident(&p)) { set_err(&p); break; }
          f->ptypes[f->nparams] = next(&p)->s;
          if (!at_ident(&p)) { set_err(&p); break; }
          f->pnames[f->nparams] = next(&p)->s;
          f->nparams++;
        } while (at_op(&p, ",") && (next(&p), 1));
      }
      expect_kw(&p, K_RETURNS);
      if (at_kw(&p, K_NOTHING)) { next(&p); f->ret = "nothing"; }
      else {
        if (!at_ident(&p)) { set_err(&p); break; }
        f->ret = next(&p)->s;
      }
      continue;
    }
    if (at_kw(&p, K_FUNCTION)) {
      next(&p);
      if (nfuncs == cap_f) { cap_f = cap_f ? cap_f * 2 : 8; funcs = (FuncDef*)realloc(funcs, sizeof(FuncDef) * (size_t)cap_f); }
      FuncDef* f = &funcs[nfuncs++];
      memset(f, 0, sizeof(*f));   // 关键：takes nothing 不写 nparams, 不清零会读垃圾长度
      if (!at_ident(&p)) { set_err(&p); break; }
      f->sig.name = next(&p)->s;
      expect_kw(&p, K_TAKES);
      if (at_kw(&p, K_NOTHING)) { next(&p); }
      else {
        do {
          f->sig.ptypes = (const char**)realloc(f->sig.ptypes, sizeof(char*) * (size_t)(f->sig.nparams + 1));
          f->sig.pnames = (const char**)realloc(f->sig.pnames, sizeof(char*) * (size_t)(f->sig.nparams + 1));
          if (!at_ident(&p)) { set_err(&p); break; }
          f->sig.ptypes[f->sig.nparams] = next(&p)->s;
          if (!at_ident(&p)) { set_err(&p); break; }
          f->sig.pnames[f->sig.nparams] = next(&p)->s;
          f->sig.nparams++;
        } while (at_op(&p, ",") && (next(&p), 1));
      }
      expect_kw(&p, K_RETURNS);
      if (at_kw(&p, K_NOTHING)) { next(&p); f->sig.ret = "nothing"; }
      else {
        if (!at_ident(&p)) { set_err(&p); break; }
        f->sig.ret = next(&p)->s;
      }
      static const int fn_end[] = {K_ENDFUNCTION};
      SArr body = {0};
      parse_block(&p, fn_end, 1, &body);
      expect_kw(&p, K_ENDFUNCTION);
      f->body = body.v; f->nbody = body.n;
      continue;
    }
    set_err(&p);
    break;
  }

  b_put(&out, "{\"types\":[");
  for (int i = 0; i < ntypes; i++) {
    if (i) b_put(&out, ",");
    b_put(&out, "{\"name\":"); b_str(&out, types[i].name);
    b_put(&out, ",\"base\":"); b_str(&out, types[i].base); b_put(&out, "}");
  }
  b_put(&out, "],\"globals\":[");
  for (int i = 0; i < nglobals; i++) {
    if (i) b_put(&out, ",");
    GlobalDecl* g = &globals[i];
    b_put(&out, "{\"type\":"); b_str(&out, g->type);
    b_put(&out, ",\"name\":"); b_str(&out, g->name);
    b_put(&out, ",\"isArr\":"); b_put(&out, g->isArr ? "true" : "false");
    b_put(&out, ",\"init\":");
    if (g->init) json_expr(&out, g->init); else b_put(&out, "null");
    b_put(&out, ",\"isConst\":"); b_put(&out, g->isConst ? "true" : "false");
    b_put(&out, "}");
  }
  b_put(&out, "],\"natives\":[");
  for (int i = 0; i < nnatives; i++) {
    if (i) b_put(&out, ",");
    const FuncSig* f = &natives[i];
    b_put(&out, "{\"name\":"); b_str(&out, f->name);
    b_put(&out, ",\"params\":"); json_params(&out, f);
    b_put(&out, ",\"ret\":"); b_str(&out, f->ret);
    b_put(&out, ",\"isConst\":"); b_put(&out, f->isConst ? "true" : "false");
    b_put(&out, "}");
  }
  b_put(&out, "],\"functions\":[");
  for (int i = 0; i < nfuncs; i++) {
    if (i) b_put(&out, ",");
    const FuncDef* f = &funcs[i];
    b_put(&out, "{\"name\":"); b_str(&out, f->sig.name);
    b_put(&out, ",\"params\":"); json_params(&out, &f->sig);
    b_put(&out, ",\"ret\":"); b_str(&out, f->sig.ret);
    b_put(&out, ",\"body\":[");
    json_stmts(&out, f->body, f->nbody);
    b_put(&out, "]}");
  }
  b_put(&out, "]}");

  if (out_err) *out_err = p.error ? 1 : 0;
  free(toks);
  for (int i = 0; i < nnatives; i++) { free((void*)natives[i].ptypes); free((void*)natives[i].pnames); }
  for (int i = 0; i < nfuncs; i++) { free((void*)funcs[i].sig.ptypes); free((void*)funcs[i].sig.pnames); }
  for (int i = 0; i < nfuncs; i++) free_stmts(&funcs[i].body, funcs[i].nbody);
  free(types); free(globals); free(natives); free(funcs);
  a_free_all(&ar);
  return out.b ? out.b : strdup("{\"parse_failed\":true}");
}

// 递归释放语句值数组（body/els/loop 子数组，clauses 数组）。
static void free_stmts(Stmt** arr, int n) {
  if (!*arr) return;
  for (int i = 0; i < n; i++) {
    Stmt* s = &(*arr)[i];
    if (s->k == S_IF) {
      for (int c = 0; c < s->nclauses; c++) free_stmts(&s->clauses[c].body, s->clauses[c].nbody);
      free(s->clauses);
      free_stmts(&s->els, s->nels);
    } else if (s->k == S_LOOP) {
      free_stmts(&s->body, s->nbody);
    }
  }
  free(*arr);
  *arr = NULL;
}
