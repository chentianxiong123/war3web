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
  Stmt* els; int nels; int hasElse;                   // if else 分支（空 else 也是 [] 非 null）
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
  if (t->kind == T_STR) {
    next(p);
    Expr* e = e_k(p, E_STR);
    e->s = t->s;
#ifdef DBG
    fprintf(stderr, "[atom STR] t->s=%p bytes:", (void*)t->s);
    for (const char* q = t->s; q && *q; q++) fprintf(stderr, "%02X ", (unsigned char)*q);
    fprintf(stderr, "| e->s=%p\n", (void*)e->s);
#endif
    return e;
  }
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
        s.hasElse = 1;
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
// globals 输出用 17 位有效数字（对齐 JS JSON.stringify 的 round-trip 精度）
static void b_real17(Buf* b, double v) {
  char tmp[48];
  snprintf(tmp, sizeof(tmp), "%.17g", v);
  if (strpbrk(tmp, "nNf")) b_put(b, "null");
  else b_put(b, tmp);
}
static void b_str(Buf* b, const char* s) {
  b_put(b, "\"");
  for (const char* q = s ? s : ""; *q; q++) {
    char c = *q;
    if (c == '"' || c == '\\') { char e[3] = {'\\', c, 0}; b_put(b, e); }
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
    case E_STR:
#ifdef DBG
      {
        const unsigned char* qq = (const unsigned char*)e->s;
        fprintf(stderr, "[json STR] %p:", (void*)e->s);
        for (int k = 0; k < 40; k++) fprintf(stderr, "%02X ", qq[k]);
        fprintf(stderr, "\n");
      }
#endif
      b_put(b, "{\"k\":\"str\",\"v\":"); b_str(b, e->s); b_put(b, "}"); break;
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
      if (s->els || s->hasElse) {
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
typedef struct {
  Arena ar;                         // tokens 字符串 + Expr/Stmt 节点存活于此
  TypeDecl* types; int ntypes;      // 堆数组（元素内字符串在 arena）
  GlobalDecl* globals; int nglobals;
  FuncSig* natives; int nnatives;
  FuncDef* funcs; int nfuncs;
  int error;
} Ast;

// 解析脚本 → 内存 AST（arena 随 AST 存活；VM 执行器直接吃这份结构，
// 不经 JSON 往返）。错误不中断：置 ast->error 并返回已解析部分。
static Ast* parse_ast(const char* src, int len, int* out_err) {
  Ast* ast = (Ast*)calloc(1, sizeof(Ast));
  Arena* ar = &ast->ar;
  int n;
  Tok* toks = jass_lex(src, len, &n, ar);
  P p = {toks, n, 0, ar, 0, 0};
#define types ast->types
#define ntypes ast->ntypes
#define globals ast->globals
#define nglobals ast->nglobals
#define natives ast->natives
#define nnatives ast->nnatives
#define funcs ast->funcs
#define nfuncs ast->nfuncs

  int cap_t = 0, cap_g = 0, cap_n = 0, cap_f = 0;   // 各类元素数组容量
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

#undef types
#undef ntypes
#undef globals
#undef nglobals
#undef natives
#undef nnatives
#undef funcs
#undef nfuncs
  if (out_err) *out_err = p.error ? 1 : 0;
  free(toks);
  return ast;
}

// 序列化 AST → JSON（与 JS parse() 输出同构；jass_parse 的出口）。
// 返回 malloc 字符串（调用方 free）。
static char* ast_to_json(const Ast* ast) {
  Buf out = {0};
#define types ast->types
#define ntypes ast->ntypes
#define globals ast->globals
#define nglobals ast->nglobals
#define natives ast->natives
#define nnatives ast->nnatives
#define funcs ast->funcs
#define nfuncs ast->nfuncs
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
#undef types
#undef ntypes
#undef globals
#undef nglobals
#undef natives
#undef nnatives
#undef funcs
#undef nfuncs
  return out.b ? out.b : strdup("{\"parse_failed\":true}");
}

static void free_ast(Ast* ast);

// 入口1：解析脚本并序列化完整 AST 为 JSON（与 JS parse() 输出同构）。
// 返回 malloc 的 C 字符串（调用方 free）。
const char* jass_parse(const char* src, int len, int* out_err) {
  Ast* ast = parse_ast(src, len, out_err);
  char* json = ast_to_json(ast);
  free_ast(ast);
  return json;
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

// 释放整个 AST（arena + 堆数组 + 语句树）。
static void free_ast(Ast* ast) {
  if (!ast) return;
  for (int i = 0; i < ast->nnatives; i++) {
    free((void*)ast->natives[i].ptypes);
    free((void*)ast->natives[i].pnames);
  }
  for (int i = 0; i < ast->nfuncs; i++) {
    free((void*)ast->funcs[i].sig.ptypes);
    free((void*)ast->funcs[i].sig.pnames);
  }
  for (int i = 0; i < ast->nfuncs; i++)
    free_stmts(&ast->funcs[i].body, ast->funcs[i].nbody);
  free(ast->types); free(ast->globals); free(ast->natives); free(ast->funcs);
  a_free_all(&ast->ar);
  free(ast);
}

// ============================================================ VM（M3 第三步）
// 与 server/jass/vm.js 语义对齐的同步执行器（第一版无协程/sleep——先跑通
// 纯计算脚本；sleep 型 native 后续用显式状态机）。树遍历：eval_expr /
// exec_block，函数调用走 C 递归，natives 用内嵌小表，返回值沿调用链上抛。

typedef struct VArr VArr;
enum { V_INT, V_REAL, V_BOOL, V_NULL, V_STR, V_ARR, V_HANDLE, V_CODE };
typedef struct {
  int k;                 // V_INT V_REAL V_BOOL V_NULL V_STR V_ARR
  long long i;
  double f;
  const char* s;         // arena 持有
  VArr* arr;
} Value;

struct VArr {
  Value* items; int n, cap;
};

typedef struct VVar { const char* name; Value v; struct VVar* next; } VVar;
typedef struct VScope { VVar* vars; struct VScope* parent; } VScope;

enum { X_OK = 0, X_RET = 1, X_EXIT = 2 };

typedef struct {
  Ast* ast;
  Value* gvals;                  // 全局值（按 GlobalDecl 下标）
  VScope* scope;                 // 当前作用域（用于 natives 的参数求值上下文）
  long long opCount, opLimit;    // 每线程 runaway 护栏（同 JS 8000000）
  int handles;                   // handle id 分配器（0x100000 起，对齐 JS nextHandleId）
  const char** callNames; int nCalls, capCalls;  // 已实现 native 调用名（去重，trace 证据）
  // 触发器表（同步执行：动作函数按名注册/调用；事件注册暂不存储）
  struct VTrigger { long long id; const char** actions; int nActions, capActions; } * triggers;
  int nTriggers, capTriggers;
  // 玩家表（Player(i) 幂等：同 index 同一 handle；GetPlayerId 由此还原 index）
  struct VPlayer { long long id; int gold, lumber; int color;  // color=-1 未设置（默认 index，对齐 engine.js）
                   struct { int tech; int lvl; int max; } * ts; int nTs, capTs; } players[16];
  // 单位表（CreateUnit 真分配：typeId/所属玩家/存活/坐标/朝向；查询类 natives 由此还原）
  struct VUnit { long long id; int typeId; int pi; int alive; double x, y, facing;
                 int* abils; int nAbils, capAbils; } * units;
  int nUnits, capUnits;
  // region 对象表（区域：矩形/格集合）
  struct VRegion { long long id; long long* rectIds; int nRects, capRects; } * regions;
  int nRegions, capRegions;
  // rect / location / group 对象表（对象工厂真分配 + 查询/枚举）
  struct VRect { long long id; double minx, miny, maxx, maxy; } * rects;
  int nRects, capRects;
  struct VLoc { long long id; double x, y; } * locs;
  int nLocs, capLocs;
  struct VGroup { long long id; long long* items; int nItems, capItems; } * groups;
  int nGroups, capGroups;
  long long enumUnit;   // ForGroup 当前枚举单位（GetEnumUnit 读取）
  // 哈希表（InitHashtable/SaveXxx/LoadXxx：parentKey+childKey 二维条目）
  struct VEntry { long long p, c; int kind; long long i; double f; char* s; };  // kind: 0=int 1=real 2=str 3=handle
  struct VHashtable { long long id; struct VEntry* es; int n, cap; } * htables;
  int nHtables, capHtables;
  // force 对象表（玩家集合，ForForce 枚举）
  struct VForce { long long id; int* pis; int n, cap; } * forces;
  int nForces, capForces;
  long long enumPlayer;  // ForForce 当前枚举玩家（GetEnumPlayer 读取）
  // 物品对象表（typeId/坐标）
  struct VItem { long long id; int typeId; double x, y; } * items;
  int nItems, capItems;
  Buf log;                       // BJDebugMsg 输出
  Value retval;                  // return 传值
  int err;
} Vm;

static Value v_int(long long i) { Value v; memset(&v, 0, sizeof v); v.k = V_INT; v.i = i; return v; }
static Value v_real(double f) { Value v; memset(&v, 0, sizeof v); v.k = V_REAL; v.f = f; return v; }
static Value v_bool(int b) { Value v; memset(&v, 0, sizeof v); v.k = V_BOOL; v.i = b; return v; }
static Value v_null(void) { Value v; memset(&v, 0, sizeof v); v.k = V_NULL; return v; }
static Value v_str(Vm* vm, const char* s) {
  Value v; memset(&v, 0, sizeof v);
  v.k = V_STR; v.s = a_str(&vm->ast->ar, s);
  return v;
}
static Value v_handle(Vm* vm) {
  Value v; memset(&v, 0, sizeof v);
  v.k = V_HANDLE; v.i = 0x100000 + vm->handles++;
  return v;
}
static Value v_code(Vm* vm, const char* name) {
  Value v; memset(&v, 0, sizeof v);
  v.k = V_CODE; v.s = a_str(&vm->ast->ar, name);
  return v;
}

static int truthy(Value v) {
  switch (v.k) {
    case V_INT: return v.i != 0;
    case V_REAL: return v.f != 0;
    case V_BOOL: return v.i != 0;
    case V_STR: return v.s != NULL;
    case V_HANDLE: return 1;
    default: return 0;
  }
}

static void vm_err(Vm* vm, const char* msg) { if (!vm->err) vm->err = 1; (void)msg; }

static Value eval_expr(Vm* vm, const Expr* e, VScope* scope);
static Value eval_call(Vm* vm, const char* name, Expr** args, int nargs, VScope* scope);
static int exec_block(Vm* vm, const Stmt* body, int n, VScope* scope);

// ---- 作用域
static Value* scope_lookup(const VScope* s, const char* name) {
  for (; s; s = s->parent)
    for (VVar* v = s->vars; v; v = v->next)
      if (strcmp(v->name, name) == 0) return &v->v;
  return NULL;
}
static void scope_decl(Vm* vm, VScope* s, const char* name, Value val) {
  VVar* v = (VVar*)a_alloc(&vm->ast->ar, sizeof(VVar));
  v->name = name; v->v = val; v->next = s->vars;
  s->vars = v;
}
static Value* lookup_var_global(Vm* vm, const VScope* scope, const char* name) {
  Value* p = scope_lookup(scope, name);
  if (p) return p;
  for (int i = 0; i < vm->ast->nglobals; i++)
    if (strcmp(vm->ast->globals[i].name, name) == 0) return &vm->gvals[i];
  return NULL;
}

// ---- 数组
static Value* arr_at(VArr* a, long long idx) {
  if (idx < 0 || idx >= a->n) return NULL;   // 越界 → null（JS 数组 undefined）
  return &a->items[idx];
}
static void arr_set(Vm* vm, VArr* a, long long idx, Value val) {
  while (a->n <= idx) {
    if (a->n == a->cap) {
      int nc = a->cap ? a->cap * 2 : 4;
      Value* ni = (Value*)a_alloc(&vm->ast->ar, sizeof(Value) * (size_t)nc);
      if (a->n) memcpy(ni, a->items, sizeof(Value) * (size_t)a->n);
      a->items = ni; a->cap = nc;
    }
    a->items[a->n++] = v_null();
  }
  a->items[idx] = val;
}

// ---- natives（第一版内嵌小表；全量 1506 行 engine.js 移植是后续 3b）
static const char* i2s_buf(Vm* vm, long long i) {
  char tmp[32];
  snprintf(tmp, sizeof tmp, "%lld", i);
  return a_str(&vm->ast->ar, tmp);
}
static const char* r2s_buf(Vm* vm, double f) {
  char tmp[48];
  snprintf(tmp, sizeof tmp, "%.6g", f);
  return a_str(&vm->ast->ar, tmp);
}
typedef Value (*NativeFn)(Vm* vm, Expr** args, int nargs, VScope* scope);
typedef struct { const char* name; NativeFn fn; } NativeEntry;

static Value narg(Vm* vm, Expr** args, int nargs, int idx, VScope* scope) {
  return idx < nargs ? eval_expr(vm, args[idx], scope) : v_null();
}

// 环境/配置 natives：对齐 engine.js 的空实现语义（本轮只记录/丢弃）
static Value n_void(Vm* vm, Expr** a, int n, VScope* s) { (void)vm; (void)a; (void)n; (void)s; return v_null(); }
// handle 工厂：JS 侧返回 Handle 对象，C 侧用递增 id 的非空值
static Value n_handle(Vm* vm, Expr** a, int n, VScope* s) { (void)a; (void)n; (void)s; return v_handle(vm); }
static Value n_0(Vm* vm, Expr** a, int n, VScope* s) { (void)a; (void)n; (void)s; return v_real(0); }

static Value n_log(Vm* vm, Expr** a, int n, VScope* s) {
  Value v = narg(vm, a, n, 0, s);
  if (v.k == V_STR) b_put(&vm->log, v.s);
  else if (v.k == V_INT) b_put(&vm->log, i2s_buf(vm, v.i));
  else if (v.k == V_REAL) b_put(&vm->log, r2s_buf(vm, v.f));
  else b_put(&vm->log, "null");
  b_put(&vm->log, "\n");
  return v_null();
}
static Value n_i2s(Vm* vm, Expr** a, int n, VScope* s) {
  Value v = narg(vm, a, n, 0, s);
  return v_str(vm, i2s_buf(vm, v.k == V_INT ? v.i : (long long)v.f));
}
static Value n_r2i(Vm* vm, Expr** a, int n, VScope* s) {
  Value v = narg(vm, a, n, 0, s);
  double d = v.k == V_REAL ? v.f : (double)v.i;
  return v_int(d < 0 ? (long long)(d - 0.5) : (long long)(d + 0.5));  // trunc 对齐 vm.js
}
static Value n_i2r(Vm* vm, Expr** a, int n, VScope* s) {
  Value v = narg(vm, a, n, 0, s);
  return v_real(v.k == V_INT ? (double)v.i : v.f);
}
static Value n_r2s(Vm* vm, Expr** a, int n, VScope* s) {
  Value v = narg(vm, a, n, 0, s);
  return v_str(vm, r2s_buf(vm, v.k == V_REAL ? v.f : (double)v.i));
}
// GetLocalizedString：engine.js 原样返回（wts 解析在别处）
static Value n_locstr(Vm* vm, Expr** a, int n, VScope* s) {
  Value v = narg(vm, a, n, 0, s);
  return v.k == V_STR ? v : v_null();
}
static Value n_lochotkey(Vm* vm, Expr** a, int n, VScope* s) {
  Value v = narg(vm, a, n, 0, s);
  return v_int(v.k == V_STR && v.s && *v.s ? (unsigned char)v.s[0] : 0);
}
// 确定性 LCG（不对照 JS 的 Math.random；固定种子保证可复现）
static unsigned long long rng = 1;
static unsigned rnd32(void) {
  rng = rng * 6364136223846793005ULL + 1442695040888963407ULL;
  return (unsigned)(rng >> 33);
}
static Value n_randint(Vm* vm, Expr** a, int n, VScope* s) {
  Value lo = narg(vm, a, n, 0, s), hi = narg(vm, a, n, 1, s);
  long long l = lo.k == V_INT ? lo.i : (long long)lo.f;
  long long h = hi.k == V_INT ? hi.i : (long long)hi.f;
  if (h < l) return v_int(l);
  return v_int(l + (long long)(rnd32() % ((unsigned long long)(h - l) + 1)));
}
static Value n_randreal(Vm* vm, Expr** a, int n, VScope* s) {
  Value lo = narg(vm, a, n, 0, s), hi = narg(vm, a, n, 1, s);
  double l = lo.k == V_REAL ? lo.f : (double)lo.i;
  double h = hi.k == V_REAL ? hi.f : (double)hi.i;
  if (h < l) return v_real(l);
  return v_real(l + (rnd32() / 4294967296.0) * (h - l));
}

// ---- 触发器同步执行（第一版：动作按名注册/执行；事件注册暂不存储）----
static Value vm_invoke(Vm* vm, FuncDef* f, Expr** args, int nargs, VScope* caller);

static struct VTrigger* find_trigger(Vm* vm, long long id) {
  for (int i = 0; i < vm->nTriggers; i++)
    if (vm->triggers[i].id == id) return &vm->triggers[i];
  return NULL;
}
static Value n_create_trigger(Vm* vm, Expr** a, int n, VScope* s) {
  (void)a; (void)n; (void)s;
  long long id = 0x100000 + vm->handles++;
  if (vm->nTriggers == vm->capTriggers) {
    vm->capTriggers = vm->capTriggers ? vm->capTriggers * 2 : 16;
    vm->triggers = (struct VTrigger*)realloc(vm->triggers, sizeof(struct VTrigger) * (size_t)vm->capTriggers);
  }
  struct VTrigger* t = &vm->triggers[vm->nTriggers++];
  memset(t, 0, sizeof *t);
  t->id = id;
  Value v; memset(&v, 0, sizeof v); v.k = V_HANDLE; v.i = id;
  return v;
}
static Value n_trigger_add_action(Vm* vm, Expr** a, int n, VScope* s) {
  Value tv = narg(vm, a, n, 0, s);
  Value cv = narg(vm, a, n, 1, s);
  struct VTrigger* t = tv.k == V_HANDLE ? find_trigger(vm, tv.i) : NULL;
  if (t && cv.k == V_CODE) {
    if (t->nActions == t->capActions) {
      t->capActions = t->capActions ? t->capActions * 2 : 4;
      const char** nn = (const char**)realloc(t->actions, sizeof(char*) * (size_t)t->capActions);
      t->actions = nn;
    }
    t->actions[t->nActions++] = cv.s;
  }
  return v_null();
}
static void exec_trigger_actions(Vm* vm, struct VTrigger* t) {
  for (int i = 0; i < t->nActions; i++) {
    FuncDef* f = NULL;
    for (int k = 0; k < vm->ast->nfuncs; k++)
      if (vm->ast->funcs[k].sig.name && strcmp(vm->ast->funcs[k].sig.name, t->actions[i]) == 0) { f = &vm->ast->funcs[k]; break; }
    if (f) vm_invoke(vm, f, NULL, 0, NULL);
    else vm_err(vm, "trigger action not found");
  }
}
// TriggerEvaluate：执行动作并返回 true（引擎返回 action 是否触发）
static Value n_trigger_evaluate(Vm* vm, Expr** a, int n, VScope* s) {
  Value tv = narg(vm, a, n, 0, s);
  if (tv.k == V_HANDLE) { struct VTrigger* t = find_trigger(vm, tv.i); if (t) { exec_trigger_actions(vm, t); return v_bool(1); } }
  return v_bool(0);
}
static Value n_trigger_execute(Vm* vm, Expr** a, int n, VScope* s) {
  Value tv = narg(vm, a, n, 0, s);
  if (tv.k == V_HANDLE) { struct VTrigger* t = find_trigger(vm, tv.i); if (t) exec_trigger_actions(vm, t); }
  return v_null();
}
static Value n_execute_func(Vm* vm, Expr** a, int n, VScope* s) {
  Value cv = narg(vm, a, n, 0, s);
  if (cv.k == V_CODE) {
    for (int k = 0; k < vm->ast->nfuncs; k++)
      if (vm->ast->funcs[k].sig.name && strcmp(vm->ast->funcs[k].sig.name, cv.s) == 0) {
        vm_invoke(vm, &vm->ast->funcs[k], NULL, 0, NULL);
        return v_null();
      }
    vm_err(vm, "ExecuteFunc not found");
  }
  return v_null();
}

// ---- 玩家对象表（Player(i) 幂等，对齐 engine.js P(i) 16 常驻玩家）----
static Value n_player(Vm* vm, Expr** a, int n, VScope* s) {
  Value i = narg(vm, a, n, 0, s);
  int idx = (int)i.i; if (idx < 0) idx = 0; if (idx > 15) idx = 15;
  if (vm->players[idx].id == 0) vm->players[idx].id = 0x100000 + vm->handles++;
  Value v; memset(&v, 0, sizeof v); v.k = V_HANDLE; v.i = vm->players[idx].id;
  return v;
}
static Value n_get_player_id(Vm* vm, Expr** a, int n, VScope* s) {
  Value p = narg(vm, a, n, 0, s);
  if (p.k == V_HANDLE)
    for (int i = 0; i < 16; i++)
      if (vm->players[i].id == p.i) return v_int(i);
  return v_int(0);
}

// ---- 单位对象表（CreateUnit 真分配 + 查询还原）----
static struct VUnit* find_unit(Vm* vm, long long id) {
  for (int i = 0; i < vm->nUnits; i++)
    if (vm->units[i].id == id) return &vm->units[i];
  return NULL;
}
static int player_index_of(Vm* vm, long long pid) {
  for (int i = 0; i < 16; i++)
    if (vm->players[i].id == pid) return i;
  return 0;   // 未登记玩家 handle → Player(0)
}
static Value n_create_unit(Vm* vm, Expr** a, int n, VScope* s) {
  Value p = narg(vm, a, n, 0, s);      // player
  Value ti = narg(vm, a, n, 1, s);     // unittype id
  Value x = narg(vm, a, n, 2, s), y = narg(vm, a, n, 3, s), fc = narg(vm, a, n, 4, s); // x/y/face
  long long id = 0x100000 + vm->handles++;
  if (vm->nUnits == vm->capUnits) {
    vm->capUnits = vm->capUnits ? vm->capUnits * 2 : 64;
    vm->units = (struct VUnit*)realloc(vm->units, sizeof(struct VUnit) * (size_t)vm->capUnits);
  }
  struct VUnit* u = &vm->units[vm->nUnits++];
  memset(u, 0, sizeof *u);
  u->id = id;
  u->typeId = (int)ti.i;
  u->pi = p.k == V_HANDLE ? player_index_of(vm, p.i) : 0;
  u->alive = 1;
  u->x = x.k == V_REAL ? x.f : (double)x.i;
  u->y = y.k == V_REAL ? y.f : (double)y.i;
  u->facing = fc.k == V_REAL ? fc.f * 0.017453292519943295 : (double)fc.i * 0.017453292519943295; // 度→弧度（对齐 GetUnitFacing 输出）
  Value v; memset(&v, 0, sizeof v); v.k = V_HANDLE; v.i = id;
  return v;
}
static Value n_get_unit_type_id(Vm* vm, Expr** a, int n, VScope* s) {
  Value u = narg(vm, a, n, 0, s);
  if (u.k == V_HANDLE) { struct VUnit* p = find_unit(vm, u.i); if (p) return v_int(p->typeId); }
  return v_int(0);
}
static Value n_get_owning_player(Vm* vm, Expr** a, int n, VScope* s) {
  Value u = narg(vm, a, n, 0, s);
  int pi = 0;
  if (u.k == V_HANDLE) { struct VUnit* p = find_unit(vm, u.i); if (p) pi = p->pi; }
  if (vm->players[pi].id == 0) vm->players[pi].id = 0x100000 + vm->handles++;
  Value v; memset(&v, 0, sizeof v); v.k = V_HANDLE; v.i = vm->players[pi].id;
  return v;
}
static Value n_unit_alive(Vm* vm, Expr** a, int n, VScope* s) {
  Value u = narg(vm, a, n, 0, s);
  if (u.k == V_HANDLE) { struct VUnit* p = find_unit(vm, u.i); if (p) return v_bool(p->alive); }
  return v_bool(0);
}
static Value n_kill_unit(Vm* vm, Expr** a, int n, VScope* s) {
  Value u = narg(vm, a, n, 0, s);
  if (u.k == V_HANDLE) { struct VUnit* p = find_unit(vm, u.i); if (p) p->alive = 0; }
  return v_null();
}
static double unit_coord(Vm* vm, Value u, int which) {  // 0=x 1=y 2=facing
  if (u.k == V_HANDLE) {
    struct VUnit* p = find_unit(vm, u.i);
    if (p) return which == 0 ? p->x : which == 1 ? p->y : p->facing;
  }
  return 0;
}
static Value n_get_unit_xy(Vm* vm, Expr** a, int n, VScope* s, int which) {
  Value u = narg(vm, a, n, 0, s);
  return v_real(unit_coord(vm, u, which));
}
static Value n_get_unit_x(Vm* vm, Expr** a, int n, VScope* s) { return n_get_unit_xy(vm, a, n, s, 0); }
static Value n_get_unit_y(Vm* vm, Expr** a, int n, VScope* s) { return n_get_unit_xy(vm, a, n, s, 1); }
static Value n_get_unit_facing(Vm* vm, Expr** a, int n, VScope* s) {
  Value u = narg(vm, a, n, 0, s);
  return v_real(unit_coord(vm, u, 2) * 57.29577951308232);  // 弧度→度
}
static Value n_set_unit_xy(Vm* vm, Expr** a, int n, VScope* s, int which) {
  Value u = narg(vm, a, n, 0, s), v = narg(vm, a, n, 1, s);
  double d = v.k == V_REAL ? v.f : (double)v.i;
  if (u.k == V_HANDLE) { struct VUnit* p = find_unit(vm, u.i); if (p) { if (which == 0) p->x = d; else p->y = d; } }
  return v_null();
}
static Value n_set_unit_x(Vm* vm, Expr** a, int n, VScope* s) { return n_set_unit_xy(vm, a, n, s, 0); }
static Value n_set_unit_y(Vm* vm, Expr** a, int n, VScope* s) { return n_set_unit_xy(vm, a, n, s, 1); }
static Value n_set_unit_position(Vm* vm, Expr** a, int n, VScope* s) {
  Value u = narg(vm, a, n, 0, s), x = narg(vm, a, n, 1, s), y = narg(vm, a, n, 2, s);
  if (u.k == V_HANDLE) { struct VUnit* p = find_unit(vm, u.i); if (p) {
    p->x = x.k == V_REAL ? x.f : (double)x.i; p->y = y.k == V_REAL ? y.f : (double)y.i; } }
  return v_null();
}
static Value n_set_unit_facing(Vm* vm, Expr** a, int n, VScope* s) {
  Value u = narg(vm, a, n, 0, s), d = narg(vm, a, n, 1, s);
  if (u.k == V_HANDLE) { struct VUnit* p = find_unit(vm, u.i); if (p)
    p->facing = (d.k == V_REAL ? d.f : (double)d.i) * 0.017453292519943295; }  // 度→弧度存
  return v_null();
}
// ---- 玩家资源（SetPlayerState/GetPlayerState：GOLD=1/LUMBER=2 进玩家表）----
static Value n_set_player_state(Vm* vm, Expr** a, int n, VScope* s) {
  Value p = narg(vm, a, n, 0, s), st = narg(vm, a, n, 1, s), v = narg(vm, a, n, 2, s);
  if (p.k == V_HANDLE) {
    int pi = player_index_of(vm, p.i);
    int val = (int)v.i;
    if (st.i == 1) vm->players[pi].gold = val;
    else if (st.i == 2) vm->players[pi].lumber = val;
  }
  return v_null();
}
static Value n_get_player_state(Vm* vm, Expr** a, int n, VScope* s) {
  Value p = narg(vm, a, n, 0, s), st = narg(vm, a, n, 1, s);
  if (p.k == V_HANDLE) {
    int pi = player_index_of(vm, p.i);
    if (st.i == 1) return v_int(vm->players[pi].gold);
    if (st.i == 2) return v_int(vm->players[pi].lumber);
  }
  return v_int(0);
}

// ---- 玩家颜色 + 科技（techs 表：level/max 双字段，对齐 engine.js p.techs）----
static void player_tech_set(Vm* vm, int pi, int tech, int lvl, int max) {
  if (pi < 0 || pi >= 16) return;
  struct VPlayer* p = &vm->players[pi];
  for (int i = 0; i < p->nTs; i++)
    if (p->ts[i].tech == tech) { if (lvl >= 0) p->ts[i].lvl = lvl; if (max >= 0) p->ts[i].max = max; return; }
  if (p->nTs == p->capTs) {
    p->capTs = p->capTs ? p->capTs * 2 : 4;
    p->ts = (void*)realloc(p->ts, sizeof(*p->ts) * (size_t)p->capTs);
  }
  p->ts[p->nTs].tech = tech;
  p->ts[p->nTs].lvl = lvl;
  p->ts[p->nTs].max = max;
  p->nTs++;
}
static Value n_set_player_color(Vm* vm, Expr** a, int n, VScope* s) {
  Value p = narg(vm, a, n, 0, s), c = narg(vm, a, n, 1, s);
  if (p.k == V_HANDLE) {
    int pi = player_index_of(vm, p.i);
    int cc = (int)c.i; if (cc < 0) cc = 0; if (cc > 15) cc = 15;
    vm->players[pi].color = cc;
  }
  return v_null();
}
static Value n_get_player_color(Vm* vm, Expr** a, int n, VScope* s) {
  Value p = narg(vm, a, n, 0, s);
  if (p.k == V_HANDLE) {
    int pi = player_index_of(vm, p.i);
    return v_int(vm->players[pi].color == -1 ? pi : vm->players[pi].color);  // 默认=index
  }
  return v_int(0);
}
static Value n_set_tech_researched(Vm* vm, Expr** a, int n, VScope* s) {
  Value p = narg(vm, a, n, 0, s), tech = narg(vm, a, n, 1, s), lv = narg(vm, a, n, 2, s);
  if (p.k == V_HANDLE) player_tech_set(vm, player_index_of(vm, p.i), (int)tech.i, (int)lv.i, -1);
  return v_null();
}
static Value n_get_tech_researched(Vm* vm, Expr** a, int n, VScope* s) {
  Value p = narg(vm, a, n, 0, s), tech = narg(vm, a, n, 1, s);
  (void)narg(vm, a, n, 2, s);  // specifier 忽略（对齐 engine.js）
  if (p.k == V_HANDLE) {
    struct VPlayer* pp = &vm->players[player_index_of(vm, p.i)];
    for (int i = 0; i < pp->nTs; i++)
      if (pp->ts[i].tech == (int)tech.i) return v_bool(pp->ts[i].lvl > 0);
  }
  return v_bool(0);
}
static Value n_set_tech_max(Vm* vm, Expr** a, int n, VScope* s) {
  Value p = narg(vm, a, n, 0, s), tech = narg(vm, a, n, 1, s), mx = narg(vm, a, n, 2, s);
  if (p.k == V_HANDLE) player_tech_set(vm, player_index_of(vm, p.i), (int)tech.i, -1, (int)mx.i);
  return v_null();
}
static Value n_get_tech_max(Vm* vm, Expr** a, int n, VScope* s) {
  Value p = narg(vm, a, n, 0, s), tech = narg(vm, a, n, 1, s);
  if (p.k == V_HANDLE) {
    struct VPlayer* pp = &vm->players[player_index_of(vm, p.i)];
    for (int i = 0; i < pp->nTs; i++)
      if (pp->ts[i].tech == (int)tech.i) return v_int(pp->ts[i].max);
  }
  return v_int(0);
}

// ---- GetHandleId / 字符串工具（对齐 engine.js）----
static Value n_get_handle_id(Vm* vm, Expr** a, int n, VScope* s) {
  Value h = narg(vm, a, n, 0, s);
  return v_int(h.k == V_HANDLE ? (int)h.i : 0);
}
static Value n_string_length(Vm* vm, Expr** a, int n, VScope* s) {
  Value sv = narg(vm, a, n, 0, s);
  return v_int(sv.k == V_STR ? (int)strlen(sv.s) : 0);
}
static Value n_sub_string(Vm* vm, Expr** a, int n, VScope* s) {
  Value sv = narg(vm, a, n, 0, s), av = narg(vm, a, n, 1, s), bv = narg(vm, a, n, 2, s);
  if (sv.k != V_STR) return v_str(vm, "");
  int len = (int)strlen(sv.s);
  int a2 = (int)av.i < 0 ? 0 : (int)av.i; if (a2 > len) a2 = len;
  int b2 = (int)bv.i; if (b2 > len) b2 = len; if (b2 < a2) b2 = a2;
  char* buf = (char*)malloc((size_t)(b2 - a2 + 1));
  memcpy(buf, sv.s + a2, (size_t)(b2 - a2));
  buf[b2 - a2] = 0;
  Value r = v_str(vm, buf);
  free(buf);
  return r;
}

// ---- rect 对象表（Rect(minx,miny,maxx,maxy)，对齐 engine.js H('rect',...)）----
static struct VRect* find_rect(Vm* vm, long long id) {
  for (int i = 0; i < vm->nRects; i++) if (vm->rects[i].id == id) return &vm->rects[i];
  return NULL;
}
static Value n_rect(Vm* vm, Expr** a, int n, VScope* s) {
  Value v0 = narg(vm, a, n, 0, s), v1 = narg(vm, a, n, 1, s);
  Value v2 = narg(vm, a, n, 2, s), v3 = narg(vm, a, n, 3, s);
  double d0 = v0.k == V_REAL ? v0.f : (double)v0.i, d1 = v1.k == V_REAL ? v1.f : (double)v1.i;
  double d2 = v2.k == V_REAL ? v2.f : (double)v2.i, d3 = v3.k == V_REAL ? v3.f : (double)v3.i;
  long long id = 0x100000 + vm->handles++;
  if (vm->nRects == vm->capRects) {
    vm->capRects = vm->capRects ? vm->capRects * 2 : 16;
    vm->rects = (struct VRect*)realloc(vm->rects, sizeof(struct VRect) * (size_t)vm->capRects);
  }
  struct VRect* r = &vm->rects[vm->nRects++];
  memset(r, 0, sizeof *r);
  r->id = id; r->minx = d0; r->miny = d1; r->maxx = d2; r->maxy = d3;
  Value v; memset(&v, 0, sizeof v); v.k = V_HANDLE; v.i = id;
  return v;
}
static Value n_set_rect(Vm* vm, Expr** a, int n, VScope* s) {
  Value rv = narg(vm, a, n, 0, s);
  struct VRect* r = rv.k == V_HANDLE ? find_rect(vm, rv.i) : NULL;
  if (r) {  // SetRect(r, minx, miny, maxx, maxy)
    Value v0 = narg(vm, a, n, 1, s), v1 = narg(vm, a, n, 2, s);
    Value v2 = narg(vm, a, n, 3, s), v3 = narg(vm, a, n, 4, s);
    r->minx = v0.k == V_REAL ? v0.f : (double)v0.i; r->miny = v1.k == V_REAL ? v1.f : (double)v1.i;
    r->maxx = v2.k == V_REAL ? v2.f : (double)v2.i; r->maxy = v3.k == V_REAL ? v3.f : (double)v3.i;
  }
  return v_null();
}
static Value n_rect_prop(Vm* vm, Expr** a, int n, VScope* s, int which) {  // 0=cx 1=cy 2=minx 3=miny 4=maxx 5=maxy 6=w 7=h
  Value rv = narg(vm, a, n, 0, s);
  struct VRect* r = rv.k == V_HANDLE ? find_rect(vm, rv.i) : NULL;
  if (!r) return v_real(0);
  double out = which == 0 ? (r->minx + r->maxx) / 2 : which == 1 ? (r->miny + r->maxy) / 2
    : which == 2 ? r->minx : which == 3 ? r->miny : which == 4 ? r->maxx : which == 5 ? r->maxy
    : which == 6 ? (r->maxx - r->minx) : (r->maxy - r->miny);
  return v_real(out);
}
static Value n_get_rect_cx(Vm* vm, Expr** a, int n, VScope* s) { return n_rect_prop(vm, a, n, s, 0); }
static Value n_get_rect_cy(Vm* vm, Expr** a, int n, VScope* s) { return n_rect_prop(vm, a, n, s, 1); }
static Value n_get_rect_minx(Vm* vm, Expr** a, int n, VScope* s) { return n_rect_prop(vm, a, n, s, 2); }
static Value n_get_rect_miny(Vm* vm, Expr** a, int n, VScope* s) { return n_rect_prop(vm, a, n, s, 3); }
static Value n_get_rect_maxx(Vm* vm, Expr** a, int n, VScope* s) { return n_rect_prop(vm, a, n, s, 4); }
static Value n_get_rect_maxy(Vm* vm, Expr** a, int n, VScope* s) { return n_rect_prop(vm, a, n, s, 5); }
static Value n_get_rect_width(Vm* vm, Expr** a, int n, VScope* s) { return n_rect_prop(vm, a, n, s, 6); }
static Value n_get_rect_height(Vm* vm, Expr** a, int n, VScope* s) { return n_rect_prop(vm, a, n, s, 7); }

// ---- location 对象表 ----
static struct VLoc* find_loc(Vm* vm, long long id) {
  for (int i = 0; i < vm->nLocs; i++) if (vm->locs[i].id == id) return &vm->locs[i];
  return NULL;
}
static Value n_location(Vm* vm, Expr** a, int n, VScope* s) {
  Value x = narg(vm, a, n, 0, s), y = narg(vm, a, n, 1, s);
  double dx = x.k == V_REAL ? x.f : (double)x.i, dy = y.k == V_REAL ? y.f : (double)y.i;
  long long id = 0x100000 + vm->handles++;
  if (vm->nLocs == vm->capLocs) {
    vm->capLocs = vm->capLocs ? vm->capLocs * 2 : 16;
    vm->locs = (struct VLoc*)realloc(vm->locs, sizeof(struct VLoc) * (size_t)vm->capLocs);
  }
  struct VLoc* l = &vm->locs[vm->nLocs++];
  memset(l, 0, sizeof *l);
  l->id = id; l->x = dx; l->y = dy;
  Value v; memset(&v, 0, sizeof v); v.k = V_HANDLE; v.i = id;
  return v;
}
static Value n_move_location(Vm* vm, Expr** a, int n, VScope* s) {
  Value lv = narg(vm, a, n, 0, s), x = narg(vm, a, n, 1, s), y = narg(vm, a, n, 2, s);
  struct VLoc* l = lv.k == V_HANDLE ? find_loc(vm, lv.i) : NULL;
  if (l) { l->x = x.k == V_REAL ? x.f : (double)x.i; l->y = y.k == V_REAL ? y.f : (double)y.i; }
  return v_null();
}
static Value n_get_loc_x(Vm* vm, Expr** a, int n, VScope* s) {
  Value lv = narg(vm, a, n, 0, s);
  struct VLoc* l = lv.k == V_HANDLE ? find_loc(vm, lv.i) : NULL;
  return v_real(l ? l->x : 0);
}
static Value n_get_loc_y(Vm* vm, Expr** a, int n, VScope* s) {
  Value lv = narg(vm, a, n, 0, s);
  struct VLoc* l = lv.k == V_HANDLE ? find_loc(vm, lv.i) : NULL;
  return v_real(l ? l->y : 0);
}

// ---- group 对象表（ForGroup 同步枚举 + GetEnumUnit 上下文）----
static struct VGroup* find_group(Vm* vm, long long id) {
  for (int i = 0; i < vm->nGroups; i++) if (vm->groups[i].id == id) return &vm->groups[i];
  return NULL;
}
static Value n_create_group(Vm* vm, Expr** a, int n, VScope* s) {
  (void)a; (void)n; (void)s;
  long long id = 0x100000 + vm->handles++;
  if (vm->nGroups == vm->capGroups) {
    vm->capGroups = vm->capGroups ? vm->capGroups * 2 : 8;
    vm->groups = (struct VGroup*)realloc(vm->groups, sizeof(struct VGroup) * (size_t)vm->capGroups);
  }
  struct VGroup* g = &vm->groups[vm->nGroups++];
  memset(g, 0, sizeof *g);
  g->id = id;
  Value v; memset(&v, 0, sizeof v); v.k = V_HANDLE; v.i = id;
  return v;
}
static Value n_group_add_unit(Vm* vm, Expr** a, int n, VScope* s) {
  Value gv = narg(vm, a, n, 0, s), uv = narg(vm, a, n, 1, s);
  struct VGroup* g = gv.k == V_HANDLE ? find_group(vm, gv.i) : NULL;
  if (g && uv.k == V_HANDLE) {
    for (int i = 0; i < g->nItems; i++) if (g->items[i] == uv.i) return v_null();  // 去重
    if (g->nItems == g->capItems) {
      g->capItems = g->capItems ? g->capItems * 2 : 4;
      g->items = (long long*)realloc(g->items, sizeof(long long) * (size_t)g->capItems);
    }
    g->items[g->nItems++] = uv.i;
  }
  return v_null();
}
static Value n_group_remove_unit(Vm* vm, Expr** a, int n, VScope* s) {
  Value gv = narg(vm, a, n, 0, s), uv = narg(vm, a, n, 1, s);
  struct VGroup* g = gv.k == V_HANDLE ? find_group(vm, gv.i) : NULL;
  if (g && uv.k == V_HANDLE) {
    for (int i = 0; i < g->nItems; i++)
      if (g->items[i] == uv.i) { g->items[i] = g->items[--g->nItems]; break; }
  }
  return v_null();
}
static Value n_group_clear(Vm* vm, Expr** a, int n, VScope* s) {
  Value gv = narg(vm, a, n, 0, s);
  struct VGroup* g = gv.k == V_HANDLE ? find_group(vm, gv.i) : NULL;
  if (g) g->nItems = 0;
  return v_null();
}
static Value n_group_count(Vm* vm, Expr** a, int n, VScope* s) {
  Value gv = narg(vm, a, n, 0, s);
  struct VGroup* g = gv.k == V_HANDLE ? find_group(vm, gv.i) : NULL;
  return v_int(g ? g->nItems : 0);
}
static Value n_first_of_group(Vm* vm, Expr** a, int n, VScope* s) {
  Value gv = narg(vm, a, n, 0, s);
  struct VGroup* g = gv.k == V_HANDLE ? find_group(vm, gv.i) : NULL;
  if (g && g->nItems > 0) {
    Value v; memset(&v, 0, sizeof v); v.k = V_HANDLE; v.i = g->items[0];
    return v;
  }
  return v_null();
}
static Value n_for_group(Vm* vm, Expr** a, int n, VScope* s) {
  Value gv = narg(vm, a, n, 0, s), cv = narg(vm, a, n, 1, s);
  struct VGroup* g = gv.k == V_HANDLE ? find_group(vm, gv.i) : NULL;
  if (g && cv.k == V_CODE) {
    FuncDef* f = NULL;
    for (int k = 0; k < vm->ast->nfuncs; k++)
      if (vm->ast->funcs[k].sig.name && strcmp(vm->ast->funcs[k].sig.name, cv.s) == 0) { f = &vm->ast->funcs[k]; break; }
    if (f) {
      for (int i = 0; i < g->nItems; i++) {
        vm->enumUnit = g->items[i];
        vm_invoke(vm, f, NULL, 0, NULL);
      }
      vm->enumUnit = 0;
    }
  }
  return v_null();
}
static Value n_get_enum_unit(Vm* vm, Expr** a, int n, VScope* s) {
  (void)a; (void)n; (void)s;
  if (vm->enumUnit != 0) {
    Value v; memset(&v, 0, sizeof v); v.k = V_HANDLE; v.i = vm->enumUnit;
    return v;
  }
  return v_null();
}

// ---- 哈希表（parentKey+childKey 二维存储，4 类型）----
static struct VHashtable* find_htable(Vm* vm, long long id) {
  for (int i = 0; i < vm->nHtables; i++) if (vm->htables[i].id == id) return &vm->htables[i];
  return NULL;
}
static Value n_init_hashtable(Vm* vm, Expr** a, int n, VScope* s) {
  (void)a; (void)n; (void)s;
  long long id = 0x100000 + vm->handles++;
  if (vm->nHtables == vm->capHtables) {
    vm->capHtables = vm->capHtables ? vm->capHtables * 2 : 4;
    vm->htables = (struct VHashtable*)realloc(vm->htables, sizeof(struct VHashtable) * (size_t)vm->capHtables);
  }
  struct VHashtable* h = &vm->htables[vm->nHtables++];
  memset(h, 0, sizeof *h);
  h->id = id;
  Value v; memset(&v, 0, sizeof v); v.k = V_HANDLE; v.i = id;
  return v;
}
static struct VEntry* htable_find(Vm* vm, struct VHashtable* h, long long p, long long c) {
  for (int i = 0; i < h->n; i++) if (h->es[i].p == p && h->es[i].c == c) return &h->es[i];
  return NULL;
}
static struct VEntry* htable_add(Vm* vm, struct VHashtable* h, long long p, long long c) {
  struct VEntry* e = htable_find(vm, h, p, c);
  if (e) return e;
  if (h->n == h->cap) {
    h->cap = h->cap ? h->cap * 2 : 8;
    h->es = (struct VEntry*)realloc(h->es, sizeof(struct VEntry) * (size_t)h->cap);
  }
  struct VEntry* ne = &h->es[h->n++];
  memset(ne, 0, sizeof *ne);
  ne->p = p; ne->c = c;
  return ne;
}
static Value n_save_int(Vm* vm, Expr** a, int n, VScope* s) {
  Value hv = narg(vm, a, n, 0, s), p = narg(vm, a, n, 1, s), c = narg(vm, a, n, 2, s), v = narg(vm, a, n, 3, s);
  struct VHashtable* h = hv.k == V_HANDLE ? find_htable(vm, hv.i) : NULL;
  if (h) { struct VEntry* e = htable_add(vm, h, p.i, c.i); e->kind = 0; e->i = v.i; }
  return v_null();
}
static Value n_save_real(Vm* vm, Expr** a, int n, VScope* s) {
  Value hv = narg(vm, a, n, 0, s), p = narg(vm, a, n, 1, s), c = narg(vm, a, n, 2, s), v = narg(vm, a, n, 3, s);
  struct VHashtable* h = hv.k == V_HANDLE ? find_htable(vm, hv.i) : NULL;
  if (h) { struct VEntry* e = htable_add(vm, h, p.i, c.i); e->kind = 1; e->f = v.k == V_REAL ? v.f : (double)v.i; }
  return v_null();
}
static Value n_save_string(Vm* vm, Expr** a, int n, VScope* s) {
  Value hv = narg(vm, a, n, 0, s), p = narg(vm, a, n, 1, s), c = narg(vm, a, n, 2, s), v = narg(vm, a, n, 3, s);
  struct VHashtable* h = hv.k == V_HANDLE ? find_htable(vm, hv.i) : NULL;
  if (h) { struct VEntry* e = htable_add(vm, h, p.i, c.i); e->kind = 2; e->s = v.k == V_STR ? a_str(&vm->ast->ar, v.s) : a_str(&vm->ast->ar, ""); }
  return v_null();
}
static Value n_save_handle(Vm* vm, Expr** a, int n, VScope* s) {
  Value hv = narg(vm, a, n, 0, s), p = narg(vm, a, n, 1, s), c = narg(vm, a, n, 2, s), v = narg(vm, a, n, 3, s);
  struct VHashtable* h = hv.k == V_HANDLE ? find_htable(vm, hv.i) : NULL;
  if (h) { struct VEntry* e = htable_add(vm, h, p.i, c.i); e->kind = 3; e->i = v.k == V_HANDLE ? v.i : 0; }
  return v_null();
}
static Value n_load_int(Vm* vm, Expr** a, int n, VScope* s) {
  Value hv = narg(vm, a, n, 0, s), p = narg(vm, a, n, 1, s), c = narg(vm, a, n, 2, s);
  struct VHashtable* h = hv.k == V_HANDLE ? find_htable(vm, hv.i) : NULL;
  if (h) { struct VEntry* e = htable_find(vm, h, p.i, c.i); if (e && e->kind == 0) return v_int((int)e->i); }
  return v_int(0);
}
static Value n_load_real(Vm* vm, Expr** a, int n, VScope* s) {
  Value hv = narg(vm, a, n, 0, s), p = narg(vm, a, n, 1, s), c = narg(vm, a, n, 2, s);
  struct VHashtable* h = hv.k == V_HANDLE ? find_htable(vm, hv.i) : NULL;
  if (h) { struct VEntry* e = htable_find(vm, h, p.i, c.i); if (e && e->kind == 1) return v_real(e->f); }
  return v_real(0);
}
static Value n_load_string(Vm* vm, Expr** a, int n, VScope* s) {
  Value hv = narg(vm, a, n, 0, s), p = narg(vm, a, n, 1, s), c = narg(vm, a, n, 2, s);
  struct VHashtable* h = hv.k == V_HANDLE ? find_htable(vm, hv.i) : NULL;
  if (h) { struct VEntry* e = htable_find(vm, h, p.i, c.i); if (e && e->kind == 2 && e->s) return v_str(vm, e->s); }
  return v_null();
}
static Value n_load_handle(Vm* vm, Expr** a, int n, VScope* s) {
  Value hv = narg(vm, a, n, 0, s), p = narg(vm, a, n, 1, s), c = narg(vm, a, n, 2, s);
  struct VHashtable* h = hv.k == V_HANDLE ? find_htable(vm, hv.i) : NULL;
  if (h) { struct VEntry* e = htable_find(vm, h, p.i, c.i);
    if (e && e->kind == 3 && e->i) { Value v; memset(&v, 0, sizeof v); v.k = V_HANDLE; v.i = e->i; return v; } }
  return v_null();
}
static Value n_have_saved(Vm* vm, Expr** a, int n, VScope* s, int kind) {
  Value hv = narg(vm, a, n, 0, s), p = narg(vm, a, n, 1, s), c = narg(vm, a, n, 2, s);
  struct VHashtable* h = hv.k == V_HANDLE ? find_htable(vm, hv.i) : NULL;
  if (h) { struct VEntry* e = htable_find(vm, h, p.i, c.i); if (e && (kind < 0 || e->kind == kind)) return v_bool(1); }
  return v_bool(0);
}
static Value n_have_any(Vm* vm, Expr** a, int n, VScope* s) { return n_have_saved(vm, a, n, s, -1); }
static Value n_have_int(Vm* vm, Expr** a, int n, VScope* s) { return n_have_saved(vm, a, n, s, 0); }
static Value n_have_real(Vm* vm, Expr** a, int n, VScope* s) { return n_have_saved(vm, a, n, s, 1); }
static Value n_have_str(Vm* vm, Expr** a, int n, VScope* s) { return n_have_saved(vm, a, n, s, 2); }
static Value n_have_handle(Vm* vm, Expr** a, int n, VScope* s) { return n_have_saved(vm, a, n, s, 3); }
static Value n_flush_child(Vm* vm, Expr** a, int n, VScope* s) {
  Value hv = narg(vm, a, n, 0, s), p = narg(vm, a, n, 1, s);
  struct VHashtable* h = hv.k == V_HANDLE ? find_htable(vm, hv.i) : NULL;
  if (h) {
    int w = 0;
    for (int i = 0; i < h->n; i++)
      if (h->es[i].p != p.i) h->es[w++] = h->es[i];
    h->n = w;
  }
  return v_null();
}
static Value n_flush_parent(Vm* vm, Expr** a, int n, VScope* s) {
  Value hv = narg(vm, a, n, 0, s);
  struct VHashtable* h = hv.k == V_HANDLE ? find_htable(vm, hv.i) : NULL;
  if (h) h->n = 0;
  return v_null();
}
static Value n_get_player_name(Vm* vm, Expr** a, int n, VScope* s) {
  Value p = narg(vm, a, n, 0, s);
  if (p.k == V_HANDLE) {
    int pi = 0;
    for (int i = 0; i < 16; i++) if (vm->players[i].id == p.i) { pi = i; break; }
    char buf[32];
    snprintf(buf, sizeof buf, "Player %d", pi + 1);  // 对齐 engine.js p.name
    return v_str(vm, buf);
  }
  return v_str(vm, "");  // null → ''
}

// ---- force 对象表（玩家集合，对齐 engine.js H('force',{players:Set})）----
static struct VForce* find_force(Vm* vm, long long id) {
  for (int i = 0; i < vm->nForces; i++) if (vm->forces[i].id == id) return &vm->forces[i];
  return NULL;
}
static Value n_create_force(Vm* vm, Expr** a, int n, VScope* s) {
  (void)a; (void)n; (void)s;
  long long id = 0x100000 + vm->handles++;
  if (vm->nForces == vm->capForces) {
    vm->capForces = vm->capForces ? vm->capForces * 2 : 8;
    vm->forces = (struct VForce*)realloc(vm->forces, sizeof(struct VForce) * (size_t)vm->capForces);
  }
  struct VForce* f = &vm->forces[vm->nForces++];
  memset(f, 0, sizeof *f);
  f->id = id;
  Value v; memset(&v, 0, sizeof v); v.k = V_HANDLE; v.i = id;
  return v;
}
static Value n_force_add_player(Vm* vm, Expr** a, int n, VScope* s) {
  Value fv = narg(vm, a, n, 0, s), pv = narg(vm, a, n, 1, s);
  struct VForce* f = fv.k == V_HANDLE ? find_force(vm, fv.i) : NULL;
  if (f && pv.k == V_HANDLE) {
    int pi = player_index_of(vm, pv.i);
    for (int i = 0; i < f->n; i++) if (f->pis[i] == pi) return v_null();
    if (f->n == f->cap) { f->cap = f->cap ? f->cap * 2 : 4; f->pis = (int*)realloc(f->pis, sizeof(int) * (size_t)f->cap); }
    f->pis[f->n++] = pi;
  }
  return v_null();
}
static Value n_force_remove_player(Vm* vm, Expr** a, int n, VScope* s) {
  Value fv = narg(vm, a, n, 0, s), pv = narg(vm, a, n, 1, s);
  struct VForce* f = fv.k == V_HANDLE ? find_force(vm, fv.i) : NULL;
  if (f && pv.k == V_HANDLE) {
    int pi = player_index_of(vm, pv.i);
    for (int i = 0; i < f->n; i++)
      if (f->pis[i] == pi) { f->pis[i] = f->pis[--f->n]; break; }
  }
  return v_null();
}
static Value n_force_clear(Vm* vm, Expr** a, int n, VScope* s) {
  Value fv = narg(vm, a, n, 0, s);
  struct VForce* f = fv.k == V_HANDLE ? find_force(vm, fv.i) : NULL;
  if (f) f->n = 0;
  return v_null();
}
static Value n_force_has_player(Vm* vm, Expr** a, int n, VScope* s) {
  Value fv = narg(vm, a, n, 0, s), pv = narg(vm, a, n, 1, s);
  struct VForce* f = fv.k == V_HANDLE ? find_force(vm, fv.i) : NULL;
  if (f && pv.k == V_HANDLE) {
    int pi = player_index_of(vm, pv.i);
    for (int i = 0; i < f->n; i++) if (f->pis[i] == pi) return v_bool(1);
  }
  return v_bool(0);
}
static Value n_force_count(Vm* vm, Expr** a, int n, VScope* s) {
  Value fv = narg(vm, a, n, 0, s);
  struct VForce* f = fv.k == V_HANDLE ? find_force(vm, fv.i) : NULL;
  return v_int(f ? f->n : 0);
}
static Value n_for_force(Vm* vm, Expr** a, int n, VScope* s) {
  Value fv = narg(vm, a, n, 0, s), cv = narg(vm, a, n, 1, s);
  struct VForce* f = fv.k == V_HANDLE ? find_force(vm, fv.i) : NULL;
  if (f && cv.k == V_CODE) {
    FuncDef* fn = NULL;
    for (int k = 0; k < vm->ast->nfuncs; k++)
      if (vm->ast->funcs[k].sig.name && strcmp(vm->ast->funcs[k].sig.name, cv.s) == 0) { fn = &vm->ast->funcs[k]; break; }
    if (fn) {
      for (int i = 0; i < f->n; i++) {
        if (vm->players[f->pis[i]].id == 0) vm->players[f->pis[i]].id = 0x100000 + vm->handles++;
        vm->enumPlayer = vm->players[f->pis[i]].id;
        vm_invoke(vm, fn, NULL, 0, NULL);
      }
      vm->enumPlayer = 0;
    }
  }
  return v_null();
}
static Value n_get_enum_player(Vm* vm, Expr** a, int n, VScope* s) {
  (void)a; (void)n; (void)s;
  if (vm->enumPlayer != 0) {
    Value v; memset(&v, 0, sizeof v); v.k = V_HANDLE; v.i = vm->enumPlayer;
    return v;
  }
  if (vm->players[0].id == 0) vm->players[0].id = 0x100000 + vm->handles++;
  Value v; memset(&v, 0, sizeof v); v.k = V_HANDLE; v.i = vm->players[0].id;
  return v;  // 对齐 engine.js: eng.ctx.enumPlayer || P(0)
}

// ---- 物品对象表（CreateItem(typeId,x,y) + 查询）----
static struct VItem* find_item(Vm* vm, long long id) {
  for (int i = 0; i < vm->nItems; i++) if (vm->items[i].id == id) return &vm->items[i];
  return NULL;
}
static Value n_create_item(Vm* vm, Expr** a, int n, VScope* s) {
  Value ti = narg(vm, a, n, 0, s), x = narg(vm, a, n, 1, s), y = narg(vm, a, n, 2, s);
  long long id = 0x100000 + vm->handles++;
  if (vm->nItems == vm->capItems) {
    vm->capItems = vm->capItems ? vm->capItems * 2 : 16;
    vm->items = (struct VItem*)realloc(vm->items, sizeof(struct VItem) * (size_t)vm->capItems);
  }
  struct VItem* it = &vm->items[vm->nItems++];
  memset(it, 0, sizeof *it);
  it->id = id;
  it->typeId = (int)ti.i;
  it->x = x.k == V_REAL ? x.f : (double)x.i;
  it->y = y.k == V_REAL ? y.f : (double)y.i;
  Value v; memset(&v, 0, sizeof v); v.k = V_HANDLE; v.i = id;
  return v;
}
static Value n_get_item_type_id(Vm* vm, Expr** a, int n, VScope* s) {
  Value iv = narg(vm, a, n, 0, s);
  if (iv.k == V_HANDLE) { struct VItem* it = find_item(vm, iv.i); if (it) return v_int(it->typeId); }
  return v_int(0);
}
static Value n_item_coord(Vm* vm, Expr** a, int n, VScope* s, int which) {
  Value iv = narg(vm, a, n, 0, s);
  if (iv.k == V_HANDLE) { struct VItem* it = find_item(vm, iv.i); if (it) return v_real(which == 0 ? it->x : it->y); }
  return v_real(0);
}
static Value n_get_item_x(Vm* vm, Expr** a, int n, VScope* s) { return n_item_coord(vm, a, n, s, 0); }
static Value n_get_item_y(Vm* vm, Expr** a, int n, VScope* s) { return n_item_coord(vm, a, n, s, 1); }
static Value n_set_item_position(Vm* vm, Expr** a, int n, VScope* s) {
  Value iv = narg(vm, a, n, 0, s), x = narg(vm, a, n, 1, s), y = narg(vm, a, n, 2, s);
  if (iv.k == V_HANDLE) { struct VItem* it = find_item(vm, iv.i); if (it) {
    it->x = x.k == V_REAL ? x.f : (double)x.i; it->y = y.k == V_REAL ? y.f : (double)y.i; } }
  return v_null();
}
static Value n_remove_item(Vm* vm, Expr** a, int n, VScope* s) {
  Value iv = narg(vm, a, n, 0, s);
  if (iv.k == V_HANDLE) {
    struct VItem* it = find_item(vm, iv.i);
    if (it) { it->typeId = 0; it->x = 0; it->y = 0; }  // 失效标记
  }
  return v_null();
}

// ---- 单位能力（UnitAddAbility 等存单位表，GetUnitAbilityLevel 查询）----
static Value n_unit_add_ability(Vm* vm, Expr** a, int n, VScope* s) {
  Value uv = narg(vm, a, n, 0, s), av = narg(vm, a, n, 1, s);
  if (uv.k == V_HANDLE) {
    struct VUnit* u = find_unit(vm, uv.i);
    if (u) {
      for (int i = 0; i < u->nAbils; i++) if (u->abils[i] == (int)av.i) return v_bool(0);  // 已有
      if (u->nAbils == u->capAbils) {
        u->capAbils = u->capAbils ? u->capAbils * 2 : 4;
        u->abils = (int*)realloc(u->abils, sizeof(int) * (size_t)u->capAbils);
      }
      u->abils[u->nAbils++] = (int)av.i;
      return v_bool(1);
    }
  }
  return v_bool(0);
}
static Value n_unit_remove_ability(Vm* vm, Expr** a, int n, VScope* s) {
  Value uv = narg(vm, a, n, 0, s), av = narg(vm, a, n, 1, s);
  if (uv.k == V_HANDLE) {
    struct VUnit* u = find_unit(vm, uv.i);
    if (u) {
      for (int i = 0; i < u->nAbils; i++)
        if (u->abils[i] == (int)av.i) { u->abils[i] = u->abils[--u->nAbils]; return v_bool(0); }
    }
  }
  return v_bool(0);
}
static Value n_get_unit_ability_level(Vm* vm, Expr** a, int n, VScope* s) {
  Value uv = narg(vm, a, n, 0, s), av = narg(vm, a, n, 1, s);
  if (uv.k == V_HANDLE) {
    struct VUnit* u = find_unit(vm, uv.i);
    if (u) {
      for (int i = 0; i < u->nAbils; i++) if (u->abils[i] == (int)av.i) return v_int(1);  // 等级 1
    }
  }
  return v_int(0);
}

// ---- region 对象表（CreateRegion + RegionAddRect 等）----
static struct VRegion* find_region(Vm* vm, long long id) {
  for (int i = 0; i < vm->nRegions; i++) if (vm->regions[i].id == id) return &vm->regions[i];
  return NULL;
}
static Value n_create_region(Vm* vm, Expr** a, int n, VScope* s) {
  (void)a; (void)n; (void)s;
  long long id = 0x100000 + vm->handles++;
  if (vm->nRegions == vm->capRegions) {
    vm->capRegions = vm->capRegions ? vm->capRegions * 2 : 8;
    vm->regions = (struct VRegion*)realloc(vm->regions, sizeof(struct VRegion) * (size_t)vm->capRegions);
  }
  struct VRegion* r = &vm->regions[vm->nRegions++];
  memset(r, 0, sizeof *r);
  r->id = id;
  Value v; memset(&v, 0, sizeof v); v.k = V_HANDLE; v.i = id;
  return v;
}
static Value n_region_add_rect(Vm* vm, Expr** a, int n, VScope* s) {
  Value rv = narg(vm, a, n, 0, s), rectv = narg(vm, a, n, 1, s);
  struct VRegion* r = rv.k == V_HANDLE ? find_region(vm, rv.i) : NULL;
  if (r && rectv.k == V_HANDLE) {
    for (int i = 0; i < r->nRects; i++) if (r->rectIds[i] == rectv.i) return v_null();
    if (r->nRects == r->capRects) {
      r->capRects = r->capRects ? r->capRects * 2 : 4;
      r->rectIds = (long long*)realloc(r->rectIds, sizeof(long long) * (size_t)r->capRects);
    }
    r->rectIds[r->nRects++] = rectv.i;
  }
  return v_null();
}

static Value n_convint(Vm* vm, Expr** a, int n, VScope* s) {
  Value v = narg(vm, a, n, 0, s);
  return v_int(v.k == V_INT ? v.i : (long long)v.f);   // ConvertXxx(n) 恒等（对齐 JS C(name)(i) => i）
}
static Value n_i0(Vm* vm, Expr** a, int n, VScope* s) { (void)a; (void)n; (void)s; return v_int(0); }
static Value n_i1(Vm* vm, Expr** a, int n, VScope* s) { (void)a; (void)n; (void)s; return v_int(1); }
static Value n_i2(Vm* vm, Expr** a, int n, VScope* s) { (void)a; (void)n; (void)s; return v_int(2); }
static Value n_r0(Vm* vm, Expr** a, int n, VScope* s) { (void)a; (void)n; (void)s; return v_real(0); }
static Value n_str_empty(Vm* vm, Expr** a, int n, VScope* s) { (void)a; (void)n; (void)s; return v_str(vm, ""); }
static Value n_false(Vm* vm, Expr** a, int n, VScope* s) { (void)a; (void)n; (void)s; return v_bool(0); }

static const NativeEntry NATIVES[] = {
  { "BJDebugMsg", n_log }, { "I2S", n_i2s }, { "R2I", n_r2i }, { "I2R", n_i2r }, { "R2S", n_r2s },
  { "GetRandomInt", n_randint }, { "GetRandomReal", n_randreal },
  { "GetCameraMargin", n_0 },
  { "GetLocalizedString", n_locstr }, { "GetLocalizedHotkey", n_lochotkey },
  { "GetHandleId", n_get_handle_id }, { "StringLength", n_string_length },
  { "SubString", n_sub_string },
  { "GetPlayerName", n_get_player_name },
  { "DisplayTextToPlayer", n_void }, { "DisplayTimedTextToPlayer", n_void }, { "ClearTextMessages", n_void },
  { "InitHashtable", n_init_hashtable }, { "SaveInteger", n_save_int },
  { "SaveReal", n_save_real }, { "SaveString", n_save_string }, { "SaveHandle", n_save_handle },
  { "LoadInteger", n_load_int }, { "LoadReal", n_load_real },
  { "LoadString", n_load_string }, { "LoadHandle", n_load_handle },
  { "HaveSavedInteger", n_have_int }, { "HaveSavedReal", n_have_real },
  { "HaveSavedString", n_have_str }, { "HaveSavedHandle", n_have_handle },
  { "FlushChildHashtable", n_flush_child }, { "FlushParentHashtable", n_flush_parent },
  { "SetRect", n_set_rect },
  { "GetRectCenterX", n_get_rect_cx }, { "GetRectCenterY", n_get_rect_cy },
  { "GetRectMaxX", n_get_rect_maxx }, { "GetRectMaxY", n_get_rect_maxy },
  { "GetRectMinX", n_get_rect_minx }, { "GetRectMinY", n_get_rect_miny },
  { "GetRectWidth", n_get_rect_width }, { "GetRectHeight", n_get_rect_height },
  { "Location", n_location }, { "MoveLocation", n_move_location },
  { "GetLocationX", n_get_loc_x }, { "GetLocationY", n_get_loc_y }, { "RemoveLocation", n_void },
  // handle 工厂（stub：返回非空 id；真实对象待 world/渲染层）
  { "AddWeatherEffect", n_handle }, { "CreateTimer", n_handle },
  { "CreateTrigger", n_create_trigger },
  { "CreateGroup", n_create_group }, { "CreateForce", n_create_force },
  { "ForceAddPlayer", n_force_add_player }, { "ForceRemovePlayer", n_force_remove_player },
  { "ForceClear", n_force_clear }, { "ForceHasPlayer", n_force_has_player },
  { "ForceCountPlayers", n_force_count }, { "ForForce", n_for_force },
  { "GetEnumPlayer", n_get_enum_player },
  { "CreateItem", n_create_item }, { "GetItemTypeId", n_get_item_type_id },
  { "GetItemX", n_get_item_x }, { "GetItemY", n_get_item_y },
  { "SetItemPosition", n_set_item_position }, { "RemoveItem", n_remove_item },
  { "GetLocalPlayer", n_handle }, { "GetTriggerUnit", n_handle }, { "GetOwningPlayer", n_get_owning_player },
  { "GetEnumUnit", n_get_enum_unit }, { "GetChangingUnit", n_handle }, { "GetTriggeringTrigger", n_handle },
  { "GroupAddUnit", n_group_add_unit }, { "GroupRemoveUnit", n_group_remove_unit },
  { "GroupClear", n_group_clear }, { "GroupCountUnits", n_group_count },
  { "FirstOfGroup", n_first_of_group }, { "ForGroup", n_for_group },
  { "DestroyGroup", n_void },
  { "GetExpiredTimer", n_handle },
  // 环境/配置空实现（对齐 engine.js 空实现语义）
  { "SetCameraBounds", n_void }, { "GetCameraBoundMinX", n_r0 },
  { "GetCameraBoundMinY", n_r0 }, { "GetCameraBoundMaxX", n_r0 },
  { "GetCameraBoundMaxY", n_r0 }, { "SetDayNightModels", n_void }, { "SetTerrainFogEx", n_void },
  { "SetWaterBaseColor", n_void }, { "EnableWeatherEffect", n_void }, { "NewSoundEnvironment", n_void },
  { "SetAmbientDaySound", n_void }, { "SetAmbientNightSound", n_void }, { "SetMapMusic", n_void },
  { "SetMapName", n_void }, { "SetMapDescription", n_void }, { "SetPlayers", n_void },
  { "SetTeams", n_void }, { "SetGamePlacement", n_void }, { "DefineStartLocation", n_void },
  { "SetPlayerSlotAvailable", n_void }, { "SetPlayerController", n_void },
  { "SetPlayerRacePreference", n_void }, { "SetPlayerRaceSelectable", n_void },
  { "SetPlayerColor", n_set_player_color }, { "GetPlayerColor", n_get_player_color }, { "DestroyTrigger", n_void }, { "DestroyGroup", n_void },
  { "PauseGame", n_void }, { "SetPlayerState", n_set_player_state }, { "SetPlayerAlliance", n_void },
  { "GetPlayerState", n_get_player_state },
  { "VolumeGroupSetVolume", n_void }, { "PlayCinematic", n_void }, { "StartSound", n_void },
  { "SetDestructableAnimation", n_void }, { "SetUnitState", n_void }, { "SetUnitAcquireRange", n_void },
  { "SetPlayerTechMaxAllowed", n_set_tech_max }, { "SetPlayerTechResearched", n_set_tech_researched },
  // 第二轮：枚举恒等转换（ConvertXxx，JS C(name)(i) => i）
  { "ConvertAIDifficulty", n_convint }, { "ConvertAllianceType", n_convint },
  { "ConvertAttackType", n_convint }, { "ConvertBlendMode", n_convint },
  { "ConvertCameraField", n_convint }, { "ConvertDamageType", n_convint },
  { "ConvertDialogEvent", n_convint }, { "ConvertEffectType", n_convint },
  { "ConvertFGameState", n_convint }, { "ConvertFogState", n_convint },
  { "ConvertGameDifficulty", n_convint }, { "ConvertGameEvent", n_convint },
  { "ConvertGameSpeed", n_convint }, { "ConvertGameType", n_convint },
  { "ConvertIGameState", n_convint }, { "ConvertItemType", n_convint },
  { "ConvertLimitOp", n_convint }, { "ConvertMapControl", n_convint },
  { "ConvertMapDensity", n_convint }, { "ConvertMapFlag", n_convint },
  { "ConvertPathingType", n_convint }, { "ConvertPlacement", n_convint },
  { "ConvertPlayerColor", n_convint }, { "ConvertPlayerEvent", n_convint },
  { "ConvertPlayerGameResult", n_convint }, { "ConvertPlayerScore", n_convint },
  { "ConvertPlayerSlotState", n_convint }, { "ConvertPlayerState", n_convint },
  { "ConvertPlayerUnitEvent", n_convint }, { "ConvertRace", n_convint },
  { "ConvertRacePref", n_convint }, { "ConvertRarityControl", n_convint },
  { "ConvertSoundType", n_convint }, { "ConvertStartLocPrio", n_convint },
  { "ConvertTexMapFlags", n_convint }, { "ConvertUnitEvent", n_convint },
  { "ConvertUnitState", n_convint }, { "ConvertUnitType", n_convint },
  { "ConvertVersion", n_convint }, { "ConvertVolumeGroup", n_convint },
  { "ConvertWeaponType", n_convint }, { "ConvertWidgetEvent", n_convint },
  // 第二轮：handle 工厂 / 枚举与布尔默认值 / 空实现
  { "CreateUnit", n_create_unit }, { "CreateSoundFromLabel", n_handle }, { "CreateMIDISound", n_handle },
  { "GetUnitTypeId", n_get_unit_type_id }, { "UnitAlive", n_unit_alive },
  { "KillUnit", n_kill_unit }, { "RemoveUnit", n_kill_unit }, { "DestroyEffect", n_void },
  { "UnitAddAbility", n_unit_add_ability }, { "UnitRemoveAbility", n_unit_remove_ability },
  { "GetUnitAbilityLevel", n_get_unit_ability_level }, { "GetUnitName", n_str_empty },
  { "CreateRegion", n_create_region }, { "RegionAddRect", n_region_add_rect },
  { "RegionClearRect", n_void }, { "RegionAddCell", n_void }, { "RegionClearCell", n_void },
  { "GetUnitX", n_get_unit_x }, { "GetUnitY", n_get_unit_y },
  { "SetUnitX", n_set_unit_x }, { "SetUnitY", n_set_unit_y },
  { "SetUnitPosition", n_set_unit_position }, { "GetUnitFacing", n_get_unit_facing },
  { "SetUnitFacing", n_set_unit_facing }, { "SetUnitFacingTimed", n_set_unit_facing },
  { "Filter", n_handle }, { "Rect", n_rect }, { "Player", n_player },
  { "GetPlayerId", n_get_player_id },
  { "TriggerAddAction", n_trigger_add_action }, { "TriggerExecute", n_trigger_execute },
  { "ExecuteFunc", n_execute_func },
  { "TriggerRegisterGameEvent", n_handle }, { "GetPlayerTechMaxAllowed", n_get_tech_max },
  { "IsPlayerObserver", n_false }, { "SetFloatGameState", n_void },
  { "Preloader", n_void }, { "CreateTimerDialog", n_handle },
  { "GetGameSpeed", n_i2 }, { "VersionGet", n_i1 }, { "GetFloatGameState", n_r0 },
  { "GetPlayerController", n_i0 }, { "GetPlayerSlotState", n_i0 },
  { "GetPlayerTechResearched", n_get_tech_researched }, { "IsFogEnabled", n_false }, { "IsFogMaskEnabled", n_false },
  { "TriggerEvaluate", n_trigger_evaluate }, { "TriggerRegisterGameStateEvent", n_false },
  { "TriggerRegisterPlayerUnitEvent", n_false }, { "TriggerRegisterTimerExpireEvent", n_false },
  { "TriggerRegisterUnitEvent", n_false },
  { "ForceAddPlayer", n_void }, { "ForceEnumPlayers", n_void }, { "SetAllItemTypeSlots", n_void },
  { "SetAllUnitTypeSlots", n_void }, { "SetResourceAmount", n_void }, { "SetUnitColor", n_void },
  { "TimerStart", n_void },
  // 第三轮（config 链）：GetPlayerId 暂返 0（player 对象表留待深化）
  { "GetPlayerId", n_i0 }, { "GetGameTypeSelected", n_i0 },
  { "SetPlayerStartLocation", n_void }, { "SetStartLocPrio", n_void }, { "SetStartLocPrioCount", n_void },
};

static int vm_call_native(Vm* vm, const char* name, Expr** args, int nargs, VScope* scope, Value* out) {
  for (size_t i = 0; i < sizeof(NATIVES) / sizeof(NATIVES[0]); i++) {
    if (strcmp(NATIVES[i].name, name) == 0) {
      // trace：记录调用名（去重，结果 JSON 的 "calls" 字段）
      int seen = 0;
      for (int k = 0; k < vm->nCalls; k++) if (strcmp(vm->callNames[k], name) == 0) { seen = 1; break; }
      if (!seen) {
        if (vm->nCalls == vm->capCalls) {
          vm->capCalls = vm->capCalls ? vm->capCalls * 2 : 64;
          const char** nn = (const char**)realloc(vm->callNames, sizeof(char*) * (size_t)vm->capCalls);
          vm->callNames = nn;
        }
        vm->callNames[vm->nCalls++] = name;
      }
      *out = NATIVES[i].fn(vm, args, nargs, scope);
      return 1;
    }
  }
  // 未实现：log 记录名字 + 返回 null（迭代式补充：跑 main 看 log 缺什么）
  b_put(&vm->log, "[unimpl:");
  b_put(&vm->log, name);
  b_put(&vm->log, "]\n");
  *out = v_null();
  return 1;
}

// ---- 表达式求值
static int jass_cmp(Value a, Value b, const char* op) {
  // null 特例：JS jassEq 把 null 与 false 相等（地图脚本依赖 `!= null` 判真）
  if ((a.k == V_NULL || b.k == V_NULL) && (a.k == V_BOOL || b.k == V_BOOL)) {
    int ab = a.k == V_NULL ? 0 : truthy(a);
    int bb = b.k == V_NULL ? 0 : truthy(b);
    if (strcmp(op, "==") == 0) return ab == bb;
    if (strcmp(op, "!=") == 0) return ab != bb;
    return 0;
  }
  if (a.k == V_NULL || b.k == V_NULL) {
    int eq = (a.k == V_NULL && b.k == V_NULL);
    if (strcmp(op, "==") == 0) return eq;
    if (strcmp(op, "!=") == 0) return !eq;
    return 0;
  }
  if (a.k == V_STR && b.k == V_STR) {
    int c = strcmp(a.s, b.s);
    if (strcmp(op, "==") == 0) return c == 0;
    if (strcmp(op, "!=") == 0) return c != 0;
    if (strcmp(op, ">") == 0) return c > 0;
    if (strcmp(op, "<") == 0) return c < 0;
    if (strcmp(op, ">=") == 0) return c >= 0;
    return c <= 0;
  }
  if (a.k == V_HANDLE || b.k == V_HANDLE) {
    int eq = (a.k == V_HANDLE && b.k == V_HANDLE) && a.i == b.i;
    if (strcmp(op, "==") == 0) return eq;
    if (strcmp(op, "!=") == 0) return !eq;
    return 0;
  }
  double x = a.k == V_REAL ? a.f : (double)a.i;
  double y = b.k == V_REAL ? b.f : (double)b.i;
  if (strcmp(op, "==") == 0) return x == y;
  if (strcmp(op, "!=") == 0) return x != y;
  if (strcmp(op, ">") == 0) return x > y;
  if (strcmp(op, "<") == 0) return x < y;
  if (strcmp(op, ">=") == 0) return x >= y;
  return x <= y;
}

static Value eval_bin(Vm* vm, const Expr* e, VScope* scope) {
  Value l = eval_expr(vm, e->l, scope);
  Value r = eval_expr(vm, e->r, scope);
  const char* op = e->op;
  if (strcmp(op, "and") == 0) return v_bool(truthy(l) && truthy(r));
  if (strcmp(op, "or") == 0) return v_bool(truthy(l) || truthy(r));
  if (strcmp(op, "==") == 0 || strcmp(op, "!=") == 0 ||
      strcmp(op, ">") == 0 || strcmp(op, "<") == 0 ||
      strcmp(op, ">=") == 0 || strcmp(op, "<=") == 0)
    return v_bool(jass_cmp(l, r, op));
  if (l.k == V_STR && r.k == V_STR && strcmp(op, "+") == 0) {
    size_t nl = strlen(l.s), nr = strlen(r.s);
    char* p = (char*)a_alloc(&vm->ast->ar, nl + nr + 1);
    memcpy(p, l.s, nl); memcpy(p + nl, r.s, nr); p[nl + nr] = 0;
    Value v; memset(&v, 0, sizeof v); v.k = V_STR; v.s = p;
    return v;
  }
  int li = (l.k == V_INT), ri = (r.k == V_INT);
  if (strcmp(op, "+") == 0)
    return li && ri ? v_int(l.i + r.i) : v_real((l.k == V_REAL ? l.f : (double)l.i) + (r.k == V_REAL ? r.f : (double)r.i));
  if (strcmp(op, "-") == 0)
    return li && ri ? v_int(l.i - r.i) : v_real((l.k == V_REAL ? l.f : (double)l.i) - (r.k == V_REAL ? r.f : (double)r.i));
  if (strcmp(op, "*") == 0)
    return li && ri ? v_int(l.i * r.i) : v_real((l.k == V_REAL ? l.f : (double)l.i) * (r.k == V_REAL ? r.f : (double)r.i));
  if (strcmp(op, "/") == 0) {
    double x = (l.k == V_REAL ? l.f : (double)l.i);
    double y = (r.k == V_REAL ? r.f : (double)r.i);
    double q = x / y;
    if (li && ri) { long long t = q < 0 ? (long long)(q - 0.5) : (long long)(q + 0.5); return v_int(t); }
    return v_real(q);
  }
  return v_null();
}

static Value eval_expr(Vm* vm, const Expr* e, VScope* scope) {
  switch (e->k) {
    case E_INT: return v_int(e->i);
    case E_REAL: return v_real(e->f);
    case E_STR: { Value v; memset(&v, 0, sizeof v); v.k = V_STR; v.s = e->s; return v; }
    case E_BOOL: return v_bool(e->bv);
    case E_NULL: return v_null();
    case E_VAR: {
      Value* p = lookup_var_global(vm, scope, e->name);
      return p ? *p : v_null();
    }
    case E_INDEX: {
      Value* p = lookup_var_global(vm, scope, e->name);
      Value iv = eval_expr(vm, e->idx, scope);
      if (p && p->k == V_ARR && iv.k == V_INT) {
        Value* it = arr_at(p->arr, iv.i);
        return it ? *it : v_null();
      }
      return v_null();
    }
    case E_NOT: return v_bool(!truthy(eval_expr(vm, e->e, scope)));
    case E_NEG: {
      Value v = eval_expr(vm, e->e, scope);
      if (v.k == V_INT) return v_int(-v.i);
      if (v.k == V_REAL) return v_real(-v.f);
      return v_null();
    }
    case E_BIN: return eval_bin(vm, e, scope);
    case E_FUNCREF: return v_code(vm, e->name);
    case E_CALL: return eval_call(vm, e->name, e->args, e->nargs, scope);
    default: return v_null();
  }
}

// ---- 语句执行
static int exec_stmt(Vm* vm, const Stmt* s, VScope* scope);

static int exec_block(Vm* vm, const Stmt* body, int n, VScope* scope) {
  for (int i = 0; i < n; i++) {
    int x = exec_stmt(vm, &body[i], scope);
    if (x) return x;
  }
  return X_OK;
}

static Value vm_invoke(Vm* vm, FuncDef* f, Expr** args, int nargs, VScope* caller) {
  if (++vm->opCount > vm->opLimit) { vm_err(vm, "op limit"); return v_null(); }
  VScope s; memset(&s, 0, sizeof s); s.parent = caller;
  for (int i = 0; i < f->sig.nparams && i < nargs; i++)
    scope_decl(vm, &s, f->sig.pnames[i], eval_expr(vm, args[i], caller));
  vm->retval = v_null();
  exec_block(vm, f->body, f->nbody, &s);
  return vm->retval;
}

static Value eval_call(Vm* vm, const char* name, Expr** args, int nargs, VScope* scope) {
  // 用户函数优先（Blizzard.j / war3map.j 定义的符号）
  for (int i = 0; i < vm->ast->nfuncs; i++) {
    FuncDef* f = &vm->ast->funcs[i];
    if (f->sig.name && strcmp(f->sig.name, name) == 0)
      return vm_invoke(vm, f, args, nargs, scope);
  }
  Value r;
  if (vm_call_native(vm, name, args, nargs, scope, &r)) return r;
  vm_err(vm, "call to undefined function");
  return v_null();
}

static int exec_stmt(Vm* vm, const Stmt* s, VScope* scope) {
  if (++vm->opCount > vm->opLimit) { vm_err(vm, "op limit"); return X_RET; }
  switch (s->k) {
    case S_LOCAL: {
      Value v = s->init ? eval_expr(vm, s->init, scope) : v_null();
      if (s->isArr) {
        VArr* a = (VArr*)a_alloc(&vm->ast->ar, sizeof(VArr));
        v.k = V_ARR; v.arr = a;
      }
      scope_decl(vm, scope, s->name, v);
      return X_OK;
    }
    case S_SET: {
      Value* p = lookup_var_global(vm, scope, s->name);
      if (s->idx) {
        Value iv = eval_expr(vm, s->idx, scope);
        Value nv = eval_expr(vm, s->e, scope);
        if (p && p->k == V_ARR && iv.k == V_INT) arr_set(vm, p->arr, iv.i, nv);
      } else if (p) {
        *p = eval_expr(vm, s->e, scope);
      }
      return X_OK;
    }
    case S_CALLSTMT: eval_call(vm, s->cname, s->args, s->nargs, scope); return X_OK;
    case S_IF: {
      for (int c = 0; c < s->nclauses; c++) {
        if (truthy(eval_expr(vm, s->clauses[c].cond, scope))) {
          VScope cs; memset(&cs, 0, sizeof cs); cs.parent = scope;
          return exec_block(vm, s->clauses[c].body, s->clauses[c].nbody, &cs);
        }
      }
      if (s->els) {
        VScope es; memset(&es, 0, sizeof es); es.parent = scope;
        return exec_block(vm, s->els, s->nels, &es);
      }
      return X_OK;
    }
    case S_LOOP: {
      for (;;) {
        if (++vm->opCount > vm->opLimit) { vm_err(vm, "op limit"); return X_RET; }
        VScope ls; memset(&ls, 0, sizeof ls); ls.parent = scope;
        int x = exec_block(vm, s->body, s->nbody, &ls);
        if (x == X_EXIT) return X_OK;
        if (x == X_RET) return X_RET;
      }
    }
    case S_EXITWHEN: return truthy(eval_expr(vm, s->e, scope)) ? X_EXIT : X_OK;
    case S_RETURN:
      if (s->e) vm->retval = eval_expr(vm, s->e, scope);
      return X_RET;
  }
  return X_OK;
}

// ---- 全局初始化（同 vm.js initGlobals：按声明序求值 init）
static void vm_init_globals(Vm* vm) {
  Ast* ast = vm->ast;
  vm->gvals = (Value*)a_alloc(&ast->ar, sizeof(Value) * (size_t)(ast->nglobals ? ast->nglobals : 1));
  for (int i = 0; i < ast->nglobals; i++) {
    GlobalDecl* g = &ast->globals[i];
    Value v = v_null();
    if (g->isArr) {
      VArr* a = (VArr*)a_alloc(&ast->ar, sizeof(VArr));
      v.k = V_ARR; v.arr = a;
    } else if (g->init) {
      v = eval_expr(vm, g->init, NULL);
    } else if (g->type && strcmp(g->type, "integer") == 0) v = v_int(0);
    else if (g->type && strcmp(g->type, "real") == 0) v = v_real(0);
    else if (g->type && strcmp(g->type, "boolean") == 0) v = v_bool(0);
    vm->gvals[i] = v;
  }
}

// 值 → JSON 片段（globals 输出用）
static void json_value(Buf* b, Value v) {
  switch (v.k) {
    case V_INT: b_num(b, v.i); break;
    case V_REAL: b_real17(b, v.f); break;
    case V_BOOL: b_put(b, v.i ? "true" : "false"); break;
    case V_STR: b_str(b, v.s); break;
    default: b_put(b, "null"); break;
  }
}

// 入口2：解析 + 执行 entry 函数 → 结果 JSON。
// 返回 malloc 字符串：{"ok":true,"log":"...","globals":{"name":值,...}}
// 或 {"ok":false,"error":"..."}。调用方 free。
const char* jass_run(const char* src, int len, const char* entry, int* out_err) {
  Ast* ast = parse_ast(src, len, NULL);
  if (!ast || ast->error) {
    if (out_err) *out_err = 1;
    free_ast(ast);
    return strdup("{\"ok\":false,\"error\":\"parse failed\"}");
  }
  Vm vm; memset(&vm, 0, sizeof vm);
  vm.ast = ast;
  vm.opLimit = 8000000;
  for (int i = 0; i < 16; i++) vm.players[i].color = -1;  // 默认 color=index（对齐 engine.js）
  vm_init_globals(&vm);
  FuncDef* target = NULL;
  // entry 支持逗号分隔多入口顺序执行（如 "config,main"，共享同一 VM 状态）
  char entries[128];
  snprintf(entries, sizeof entries, "%s", entry ? entry : "");
  char* save = NULL;
  int found_any = 0;
  for (char* tok = strtok_r(entries, ",", &save); tok; tok = strtok_r(NULL, ",", &save)) {
    target = NULL;
    for (int i = 0; i < ast->nfuncs; i++)
      if (ast->funcs[i].sig.name && strcmp(ast->funcs[i].sig.name, tok) == 0) { target = &ast->funcs[i]; break; }
    if (target) { found_any = 1; vm_invoke(&vm, target, NULL, 0, NULL); }
    else vm_err(&vm, "entry function not found");
  }
  if (!found_any && !vm.err) vm_err(&vm, "no entry function");

  Buf out = {0};
  if (vm.err) {
    b_put(&out, "{\"ok\":false,\"error\":\"vm error\"}");
  } else {
    b_put(&out, "{\"ok\":true,\"log\":");
    b_str(&out, vm.log.b ? vm.log.b : "");
    b_put(&out, ",\"calls\":[");
    for (int i = 0; i < vm.nCalls; i++) {
      if (i) b_put(&out, ",");
      b_str(&out, vm.callNames[i]);
    }
    b_put(&out, "],\"globals\":{");
    int first = 1;
    for (int i = 0; i < ast->nglobals; i++) {
      GlobalDecl* g = &ast->globals[i];
      if (g->isArr) continue;
      if (!first) b_put(&out, ",");
      first = 0;
      b_str(&out, g->name);
      b_put(&out, ":");
      json_value(&out, vm.gvals[i]);
    }
    b_put(&out, "}}");
  }
  if (out_err) *out_err = vm.err ? 1 : 0;
  for (int i = 0; i < 16; i++) free(vm.players[i].ts);
  for (int i = 0; i < vm.nRegions; i++) free(vm.regions[i].rectIds);
  free(vm.regions);
  for (int i = 0; i < vm.nUnits; i++) free(vm.units[i].abils);
  for (int i = 0; i < vm.nForces; i++) free(vm.forces[i].pis);
  free(vm.forces);
  free(vm.items);
  for (int i = 0; i < vm.nHtables; i++) free(vm.htables[i].es);
  free(vm.htables);
  for (int i = 0; i < vm.nGroups; i++) free(vm.groups[i].items);
  free(vm.groups);
  free(vm.rects);
  free(vm.locs);
  free(vm.units);
  for (int i = 0; i < vm.nTriggers; i++) free(vm.triggers[i].actions);
  free(vm.triggers);
  free(vm.callNames);
  free_ast(ast);
  return out.b ? out.b : strdup("{\"ok\":false,\"error\":\"no output\"}");
}
