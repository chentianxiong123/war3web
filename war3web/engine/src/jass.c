// jass.c — JASS 脚本解析器（C 移植自 server/jass/parse.js）。
//
// M3 路标第一步：把地图脚本解析从 JS 挪进 WASM 引擎。JASS 语法是简单递归
// 下降文法（or -> and -> cmp -> add -> mul -> unary -> atom），本文件实现
// 词法 + 语法分析，输出与 JS 版 parse() 同构的摘要 JSON（types / globals /
// natives / functions，函数体附带语句计数），供 Node 端对照验证，也为后续
// VM（执行器）进 WASM 铺路。
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
  T_STR,     // v.s (escaped, heap-owned)
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
  int kw;              // keyword id when kind==T_IDENT and it is one
  long long i;         // T_INT value
  double f;            // T_REAL value
  const char* s;       // T_STR / T_OP / T_IDENT text (heap-owned)
  int line;
} Tok;

typedef struct { Tok* t; int n; int cap; } TokBuf;

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

// lex(src, len): 与 parse.js 的 lex() 逐规则对应（含 // 与 /* */ 注释、
// "string" 转义、'fourcc'、$hex / 0x、数字、标识符/关键字、运算符与结构符）。
// 返回 token 数组（调用方逐一 free t->s 后 free 数组），末尾补 T_EOF。
static Tok* jass_lex(const char* src, int len, int* out_n) {
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
    if (c == '/' && i + 1 < len && src[i + 1] == '*') {  // tolerated block comment
      i += 2;
      while (i < len && !(src[i] == '*' && i + 1 < len && src[i + 1] == '/')) {
        if (src[i] == '\n') line++;
        i++;
      }
      i += 2; continue;
    }
    if (c == '"') {  // string with backslash escapes
      size_t n = 0;
      char* s = (char*)malloc(1);
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
      i++;  // closing quote
      s = (char*)realloc(s, n + 1); s[n] = 0;
      tok_push(&L, T_STR, 0, 0, 0, s, line);
      continue;
    }
    if (c == '\'') {  // fourcc / raw code
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
      char* w = (char*)malloc((size_t)(j - i) + 1);
      memcpy(w, src + i, (size_t)(j - i)); w[j - i] = 0;
      tok_push(&L, T_IDENT, kw, 0, 0, w, line);
      i = j; continue;
    }
    if (i + 1 < len) {
      char two[3] = {src[i], src[i + 1], 0};
      if (strcmp(two, "==") == 0 || strcmp(two, "!=") == 0 ||
          strcmp(two, ">=") == 0 || strcmp(two, "<=") == 0) {
        tok_push(&L, T_OP, 0, 0, 0, strdup(two), line);
        i += 2; continue;
      }
    }
    if (strchr("+-*/><=(),[]", c)) {
      char one[2] = {c, 0};
      tok_push(&L, T_OP, 0, 0, 0, strdup(one), line);
      i++; continue;
    }
    i++;  // skip anything unexpected
  }
  tok_push(&L, T_EOF, 0, 0, 0, NULL, line);
  *out_n = L.n;
  return L.t;
}

// ------------------------------------------------------------------ parser

typedef struct {
  Tok* t; int n; int i;
  int error;          // 1 when a syntax error was reported
  char errmsg[256];
  int line;
} P;

static void perr(P* p, const char* msg) {
  if (!p->error) {
    p->error = 1;
    snprintf(p->errmsg, sizeof(p->errmsg), "%s at line %d", msg, p->line);
  }
}

static Tok* peek(P* p, int k) {
  int j = p->i + k;
  return j < p->n ? &p->t[j] : &p->t[p->n - 1];
}
static Tok* cur(P* p) { return peek(p, 0); }
static Tok* next(P* p) { return &p->t[p->i++ < p->n ? p->i - 1 : p->n - 1]; }

static int at_kw(P* p, int kw) { return cur(p)->kind == T_IDENT && cur(p)->kw == kw; }
static int at_op(P* p, const char* s) {
  return cur(p)->kind == T_OP && cur(p)->s && strcmp(cur(p)->s, s) == 0;
}
static int at_type(P* p, int kind) { return cur(p)->kind == kind; }

static void skip_nl(P* p) { while (at_type(p, T_NL)) next(p); }

static void expect_kw(P* p, int kw, const char* what) {
  if (!at_kw(p, kw)) perr(p, what);
  else next(p);
}
static void expect_op(P* p, const char* s) {
  if (!at_op(p, s)) perr(p, "expected operator");
  else next(p);
}
static void expect_ident(P* p) {
  if (cur(p)->kind != T_IDENT) perr(p, "expected identifier");
  else next(p);
}

// expression grammar — same precedence chain as parse.js
static void parse_expr(P* p);
static void parse_or(P* p);
static void parse_and(P* p);
static void parse_cmp(P* p);
static void parse_add(P* p);
static void parse_mul(P* p);
static void parse_unary(P* p);
static void parse_atom(P* p);

static void parse_or(P* p) {
  parse_and(p);
  while (!p->error && at_kw(p, K_OR)) { next(p); parse_and(p); }
}
static void parse_and(P* p) {
  parse_cmp(p);
  while (!p->error && at_kw(p, K_AND)) { next(p); parse_cmp(p); }
}
static void parse_cmp(P* p) {
  parse_add(p);
  while (!p->error && cur(p)->kind == T_OP && cur(p)->s &&
         (strcmp(cur(p)->s, "==") == 0 || strcmp(cur(p)->s, "!=") == 0 ||
          strcmp(cur(p)->s, ">") == 0 || strcmp(cur(p)->s, "<") == 0 ||
          strcmp(cur(p)->s, ">=") == 0 || strcmp(cur(p)->s, "<=") == 0)) {
    next(p); parse_add(p);
  }
}
static void parse_add(P* p) {
  parse_mul(p);
  while (!p->error && at_op(p, "+") || (!p->error && at_op(p, "-"))) {
    if (at_op(p, "+") || at_op(p, "-")) { next(p); parse_mul(p); }
  }
}
static void parse_mul(P* p) {
  parse_unary(p);
  while (!p->error && (at_op(p, "*") || at_op(p, "/"))) { next(p); parse_unary(p); }
}
static void parse_unary(P* p) {
  if (at_kw(p, K_NOT)) { next(p); parse_unary(p); return; }
  if (at_op(p, "-")) { next(p); parse_unary(p); return; }
  if (at_op(p, "+")) { next(p); parse_unary(p); return; }
  parse_atom(p);
}
static void parse_atom(P* p) {
  Tok* t = cur(p);
  if (at_op(p, "(")) {
    next(p); parse_expr(p); expect_op(p, ")");
    return;
  }
  if (t->kind == T_INT || t->kind == T_REAL || t->kind == T_STR) { next(p); return; }
  if (at_kw(p, K_TRUE) || at_kw(p, K_FALSE) || at_kw(p, K_NULL)) { next(p); return; }
  if (at_kw(p, K_FUNCTION)) {  // function foo
    next(p);
    if (cur(p)->kind != T_IDENT) perr(p, "expected function name");
    else next(p);
    return;
  }
  if (t->kind == T_IDENT) {
    next(p);
    if (at_op(p, "(")) {  // call
      next(p);
      if (!at_op(p, ")")) {
        do { parse_expr(p); } while (!p->error && at_op(p, ",") && (next(p), 1));
      }
      expect_op(p, ")");
      return;
    }
    if (at_op(p, "[")) {  // array index
      next(p); parse_expr(p); expect_op(p, "]");
      return;
    }
    return;  // variable
  }
  perr(p, "unexpected token in expression");
}

static void parse_expr(P* p) { parse_or(p); }

// statements — count them into *stmts
static void parse_block(P* p, const int* enders, int nenders, int* stmts);
static void parse_stmt(P* p, int* stmts);

static void parse_block(P* p, const int* enders, int nenders, int* stmts) {
  for (;;) {
    skip_nl(p);
    if (at_type(p, T_EOF)) { perr(p, "unterminated block"); return; }
    int stop = 0;
    for (int k = 0; k < nenders; k++)
      if (at_kw(p, enders[k])) { stop = 1; break; }
    if (stop) return;
    parse_stmt(p, stmts);
  }
}

static void parse_stmt(P* p, int* stmts) {
  (*stmts)++;
  if (at_kw(p, K_DEBUG)) next(p);
  if (at_kw(p, K_LOCAL)) {
    next(p);
    if (cur(p)->kind != T_IDENT) { perr(p, "expected type"); return; }
    next(p);
    if (at_kw(p, K_ARRAY)) next(p);
    if (cur(p)->kind != T_IDENT) { perr(p, "expected variable name"); return; }
    next(p);
    if (at_op(p, "=")) { next(p); parse_expr(p); }
    return;
  }
  if (at_kw(p, K_SET)) {
    next(p);
    if (cur(p)->kind != T_IDENT) { perr(p, "expected variable"); return; }
    next(p);
    if (at_op(p, "[")) { next(p); parse_expr(p); expect_op(p, "]"); }
    expect_op(p, "=");
    parse_expr(p);
    return;
  }
  if (at_kw(p, K_CALL)) {
    next(p);
    if (cur(p)->kind != T_IDENT) { perr(p, "expected function"); return; }
    next(p);
    expect_op(p, "(");
    if (!at_op(p, ")")) {
      do { parse_expr(p); } while (!p->error && at_op(p, ",") && (next(p), 1));
    }
    expect_op(p, ")");
    return;
  }
  if (at_kw(p, K_IF)) {
    next(p);
    parse_expr(p);
    expect_kw(p, K_THEN, "expected then");
    static const int if_end[] = {K_ELSEIF, K_ELSE, K_ENDIF};
    int nested = 0;
    parse_block(p, if_end, 3, &nested);
    for (;;) {
      if (at_kw(p, K_ELSEIF)) {
        next(p); parse_expr(p); expect_kw(p, K_THEN, "expected then");
        nested = 0;
        parse_block(p, if_end, 3, &nested);
      } else if (at_kw(p, K_ELSE)) {
        next(p);
        static const int else_end[] = {K_ENDIF};
        nested = 0;
        parse_block(p, else_end, 1, &nested);
      } else {
        expect_kw(p, K_ENDIF, "expected endif");
        break;
      }
    }
    return;
  }
  if (at_kw(p, K_LOOP)) {
    next(p);
    static const int loop_end[] = {K_ENDLOOP};
    int nested = 0;
    parse_block(p, loop_end, 1, &nested);
    expect_kw(p, K_ENDLOOP, "expected endloop");
    return;
  }
  if (at_kw(p, K_EXITWHEN)) {
    next(p); parse_expr(p);
    return;
  }
  if (at_kw(p, K_RETURN)) {
    next(p);
    if (!at_type(p, T_NL) && !at_type(p, T_EOF)) parse_expr(p);
    return;
  }
  perr(p, "unexpected statement");
}

// ------------------------------------------------------------- JSON output

typedef struct { char* b; size_t n, cap; } Buf;
static void b_put(Buf* b, const char* s) {
  size_t l = strlen(s);
  if (b->n + l + 1 > b->cap) {
    b->cap = b->cap ? b->cap * 2 : 4096;
    while (b->n + l + 1 > b->cap) b->cap *= 2;
    b->b = (char*)realloc(b->b, b->cap);
  }
  memcpy(b->b + b->n, s, l); b->n += l; b->b[b->n] = 0;
}
static void b_json_str(Buf* b, const char* s) {
  b_put(b, "\"");
  for (const char* q = s; *q; q++) {
    char c = *q;
    if (c == '"' || c == '\\') { char e[2] = {'\\', c}; b_put(b, e); }
    else if (c == '\n') b_put(b, "\\n");
    else { char e[2] = {c, 0}; b_put(b, e); }
  }
  b_put(b, "\"");
}

// parse a parameter list "takes ..." (nothing or a/b, c/d ...)
static void parse_params(P* p, Buf* b) {
  if (at_kw(p, K_NOTHING)) { next(p); b_put(b, "[]"); return; }
  b_put(b, "[");
  int first = 1;
  do {
    if (!first) b_put(b, ",");
    first = 0;
    if (cur(p)->kind != T_IDENT) { perr(p, "expected param type"); return; }
    b_put(b, "{\"type\":");
    b_json_str(b, cur(p)->s); next(p);
    b_put(b, ",\"name\":");
    if (cur(p)->kind != T_IDENT) { perr(p, "expected param name"); return; }
    b_json_str(b, cur(p)->s); next(p);
    b_put(b, "}");
  } while (at_op(p, ",") && (next(p), 1));
  b_put(b, "]");
}

// 顶层入口：解析脚本并输出摘要 JSON。返回 malloc 的 C 字符串（调用方 free）。
const char* jass_parse(const char* src, int len, int* out_err) {
  int n;
  Tok* toks = jass_lex(src, len, &n);
  P p = {toks, n, 0, 0, "", 0};
  Buf out = {0};                // final assembly
  Buf out_t = {0}, out_n = {0}, out_f = {0};  // per-class arrays
  int types = 0, globals = 0, natives = 0, funcs = 0;
  int first_t = 1, first_n = 1, first_f = 1;
  for (;;) {
    skip_nl(&p);
    if (at_type(&p, T_EOF)) break;
    if (at_kw(&p, K_TYPE)) {
      next(&p);
      if (!first_t) b_put(&out_t, ",");
      first_t = 0;
      b_put(&out_t, "{\"name\":");
      if (cur(&p)->kind != T_IDENT) { perr(&p, "expected type name"); break; }
      b_json_str(&out_t, cur(&p)->s); next(&p);
      b_put(&out_t, ",\"base\":");
      expect_kw(&p, K_EXTENDS, "expected extends");
      if (cur(&p)->kind != T_IDENT) { perr(&p, "expected base"); break; }
      b_json_str(&out_t, cur(&p)->s); next(&p);
      b_put(&out_t, "}");
      types++;
      continue;
    }
    if (at_kw(&p, K_GLOBALS)) {
      next(&p);
      for (;;) {
        skip_nl(&p);
        if (at_kw(&p, K_ENDGLOBALS)) { next(&p); break; }
        if (at_type(&p, T_EOF)) { perr(&p, "unterminated globals"); break; }
        if (at_kw(&p, K_CONSTANT)) next(&p);
        if (cur(&p)->kind != T_IDENT) { perr(&p, "expected global type"); break; }
        next(&p);
        if (at_kw(&p, K_ARRAY)) next(&p);
        if (cur(&p)->kind != T_IDENT) { perr(&p, "expected global name"); break; }
        next(&p);
        if (at_op(&p, "=")) { next(&p); parse_expr(&p); }
        globals++;
      }
      continue;
    }
    if (at_kw(&p, K_CONSTANT)) next(&p);
    if (at_kw(&p, K_NATIVE)) {
      next(&p);
      if (!first_n) b_put(&out_n, ",");
      first_n = 0;
      if (cur(&p)->kind != T_IDENT) { perr(&p, "expected native name"); break; }
      b_put(&out_n, "{\"name\":");
      b_json_str(&out_n, cur(&p)->s); next(&p);
      b_put(&out_n, ",\"params\":");
      expect_kw(&p, K_TAKES, "expected takes");
      parse_params(&p, &out_n);
      b_put(&out_n, ",\"ret\":");
      expect_kw(&p, K_RETURNS, "expected returns");
      if (at_kw(&p, K_NOTHING)) { next(&p); b_put(&out_n, "\"nothing\""); }
      else {
        if (cur(&p)->kind != T_IDENT) { perr(&p, "expected return type"); break; }
        b_json_str(&out_n, cur(&p)->s); next(&p);
      }
      b_put(&out_n, "}");
      natives++;
      continue;
    }
    if (at_kw(&p, K_FUNCTION)) {
      next(&p);
      if (!first_f) b_put(&out_f, ",");
      first_f = 0;
      if (cur(&p)->kind != T_IDENT) { perr(&p, "expected function name"); break; }
      b_put(&out_f, "{\"name\":");
      b_json_str(&out_f, cur(&p)->s); next(&p);
      b_put(&out_f, ",\"params\":");
      expect_kw(&p, K_TAKES, "expected takes");
      parse_params(&p, &out_f);
      b_put(&out_f, ",\"ret\":");
      expect_kw(&p, K_RETURNS, "expected returns");
      if (at_kw(&p, K_NOTHING)) { next(&p); b_put(&out_f, "\"nothing\""); }
      else {
        if (cur(&p)->kind != T_IDENT) { perr(&p, "expected return type"); break; }
        b_json_str(&out_f, cur(&p)->s); next(&p);
      }
      b_put(&out_f, ",\"stmts\":");
      int stmts = 0;
      static const int fn_end[] = {K_ENDFUNCTION};
      parse_block(&p, fn_end, 1, &stmts);
      expect_kw(&p, K_ENDFUNCTION, "expected endfunction");
      char num[32];
      snprintf(num, sizeof(num), "%d", stmts);
      b_put(&out_f, num);
      b_put(&out_f, "}");
      funcs++;
      continue;
    }
    perr(&p, "unexpected top-level token");
    break;
  }
  // assemble the three arrays plus per-class counts
  b_put(&out, "{\"types\":[");
  if (out_t.b) b_put(&out, out_t.b);
  b_put(&out, "],\"natives\":[");
  if (out_n.b) b_put(&out, out_n.b);
  b_put(&out, "],\"functions\":[");
  if (out_f.b) b_put(&out, out_f.b);
  b_put(&out, "],\"globals\":");
  char num[32];
  snprintf(num, sizeof(num), "%d", globals);
  b_put(&out, num);
  b_put(&out, ",\"native_count\":");
  snprintf(num, sizeof(num), "%d", natives);
  b_put(&out, num);
  b_put(&out, ",\"function_count\":");
  snprintf(num, sizeof(num), "%d", funcs);
  b_put(&out, num);
  b_put(&out, "}");
  free(out_t.b); free(out_n.b); free(out_f.b);
  if (p.error) {
    if (out_err) *out_err = 1;
  } else if (out_err) {
    *out_err = 0;
  }
  for (int k = 0; k < n; k++) free((void*)toks[k].s);
  free(toks);
  return out.b ? out.b : strdup("{\"error\":\"parse failed\"}");
}
