// sim.c — M4 阶段 1：server/pathing.js Grid 的 C 移植（A* + 扫掠圆盘碰撞 + 连通）。
//
// 语义与 pathing.js 逐字对齐（并列对照）：同样的代价函数、同样的 string-pull、
// 同样的 clearFootprint 精确距离判断；差异只在一维数组 vs TypedArray。
//
// 导出（emcc EXPORTED_FUNCTIONS 追加）：
//   sim_grid_init(walkPtr, w, h, originX, originY)  设置网格（walk 数据在 wasm heap）
//   sim_find_path(sx, sy, tx, ty, outPtr, maxOut)   输出世界坐标点序列（float2，去起点），返回点数；-1=无路径
//   sim_clear_foot(x0, y0, x1, y1, radius)          扫掠圆盘可行？1/0
//   sim_connected_i(startIdx, goalIdx)              两格连通？1/0（cell 索引）
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <stdio.h>

#define SIM_PCELL 32.0                 // PATH_CELL（shared/const.js）
#define SIM_SQRT2 1.4142135623730951   // Math.SQRT2

static const uint8_t* W;               // walk 数据（0/1）
static int GW, GH;
static double OX, OY;

static int clear_footprint(double x0, double y0, double x1, double y1, double radius);   // 定义在下方

// ---- 实体碰撞 occupancy（JS movementPath 的 circles 桶等价物，全量遍历）----
static double OCX[256], OCY[256], OCR2[256];
static int OCN;
static int occ_clear(double px, double py) {
  for (int i = 0; i < OCN; i++)
    if ((px - OCX[i]) * (px - OCX[i]) + (py - OCY[i]) * (py - OCY[i]) < OCR2[i] - 1e-6) return 0;
  return 1;
}

// ---- 单位表（多单位）----
#define SIM_MAX 1024
#define SIM_ARMOR_KINDS 8   // small/medium/large/fort/normal/hero/divine/none
#define SIM_ATK_KINDS 7     // normal/pierce/siege/magic/chaos/spells/hero
typedef struct {
  double x, y, facing;
  double speed, radius;
  int alive, pathingOff, fly;
  long long bodyRepathAt;
  double goalX, goalY;                 // 当前命令目标（重寻路判据）
  double* path; int nPath, capPath;
  // ---- 战斗（阶段 2）----
  double hp, maxHp, armor;
  int armorTypeIdx, team, atkTypeIdx, weaponKind;
  double dmgBase, dmgDice, dmgSides;
  double atkCd, atkRange, attackPoint, attackBackswing, missileSpeed;
  double atkTimer, attackWindupRemaining;
  int attackWindupTarget;
  long long atkCount, dmgCount, deathCount;
  // ---- AI（阶段 2：stepAI 追击子集）----
  int orderType;             // 0=idle 1=attack（自动获取）
  int orderTargetId;
  double acquisitionRange, homeX, homeY;
  // ---- 经济（阶段 2：stepGathers）----
  int kind;                  // 0=other 1=hpea 2=ngol 3=htow（JS typeKey 判定）
  int playerIndex;
  int gatherPhase;           // 0=none 1=toMine 2=mining 3=toBase
  int mineId, baseId;
  double gatherUntilMs;      // 挖矿完成毫秒
  // ---- 赏金（阶段 3：awardKill）----
  double bounty;             // 击杀赏金（JS type.bountyPlus；0 → 回退 10 + level*4）
  int level;                 // 单位等级（赏金回退公式用）
} SimUnit;
static SimUnit U[SIM_MAX];
static long long SIM_NOW;   // tick 计数（模拟 world.now）
static double DMG_TABLE[SIM_ATK_KINDS][SIM_ARMOR_KINDS];   // 伤害倍率表（gameplay.json damageBonus）

// ---- 导弹表（阶段 2：stepMissiles）----
// JS launchMissile/stepMissiles 语义：homing 追踪（目标死则无伤）、aim 快照(dx,dy) 用于点射、
// deadline 兜底、命中调 onHit=land(sim_damage)。
#define SIM_MISSILE_MAX 256
typedef struct {
  int active, srcId, targetId, fx;
  double x, y, dx, dy, speed, deadlineMs;
  double amount;        // 发射时已 roll 的伤害（JS releaseAttack 先 roll）
  int atkTypeIdx;
} SimMissile;
static SimMissile M[SIM_MISSILE_MAX];
static int FXSEQ;
static int DMG_TABLE_SET;

// ---- 经济（阶段 2）：玩家资源（JS player.gold）----
static double GOLD[16];

// ---- 事件桥（阶段 2 收尾）：JS emit 的 C 侧对等物 ----
// attack（windup 开始）/ missileEnd / death 写入固定环缓冲；JS 侧
// sim_events_reset + sim_events_get 读取（对齐 emit 时序）。
#define SIM_EVENT_MAX 8192
#define SIM_EV_ATTACK 0
#define SIM_EV_MISSILE_END 1
#define SIM_EV_DEATH 2
typedef struct { int tick, type, a, b; } SimEvent;
static SimEvent EV[SIM_EVENT_MAX];
static int EVN;
static void ev_push(int type, int a, int b) {
  // tick 用 0-based 步序（对齐 JS 侧 `for (let t=0) { step(); ... }` 的基准）
  if (EVN < SIM_EVENT_MAX) { EV[EVN].tick = (int)(SIM_NOW - 1); EV[EVN].type = type; EV[EVN].a = a; EV[EVN].b = b; EVN++; }
}
void sim_events_reset(void) { EVN = 0; }
int sim_event_count(void) { return EVN; }

/** 伤害倍率表装载（sim_test 从 gameplay.json 读入；JS 侧 HEAPF32 写 → float* 读）。 */
void sim_set_dmg_table(const float* tbl) {
  for (int a = 0; a < SIM_ATK_KINDS; a++)
    for (int k = 0; k < SIM_ARMOR_KINDS; k++) DMG_TABLE[a][k] = (double)tbl[a * SIM_ARMOR_KINDS + k];
  DMG_TABLE_SET = 1;
}
static double armor_factor(double armor) {   // world.js armorFactor（DEF_ARMOR=0.06）
  return armor >= 0 ? 1 - (0.06 * armor) / (1 + 0.06 * armor)
                    : 2 - pow(1 - 0.06, -armor);
}
static double type_bonus(int atk, int armor) {
  if (!DMG_TABLE_SET) return 1;
  return DMG_TABLE[atk][armor];
}

void sim_spawn(int id, double x, double y, double facing, double speed, double radius, int fly, int pathingOff) {
  if (id < 0 || id >= SIM_MAX) return;
  U[id].x = x; U[id].y = y; U[id].facing = facing;
  U[id].speed = speed; U[id].radius = radius;
  U[id].alive = 1; U[id].fly = fly; U[id].pathingOff = pathingOff;
  U[id].nPath = 0; U[id].goalX = 1e18; U[id].goalY = 1e18;   // 初始目标无效 → 首次必寻路
}
void sim_clear_all(void) {
  // 全字段归零（防跨场景残留：radius/team/playerIndex/hp/gather 等）
  memset(U, 0, sizeof(U));
  memset(M, 0, sizeof(M));
  memset(GOLD, 0, sizeof(GOLD));
  for (int i = 0; i < SIM_MAX; i++) {
    U[i].mineId = -1; U[i].baseId = -1; U[i].orderTargetId = -1; U[i].attackWindupTarget = -1;
  }
  EVN = 0; FXSEQ = 0; SIM_NOW = 0;
  OCN = 0;
}

/** 实体阻挡列表（JS movementBlockers）：同类型 + blocksMovement + 扫掠矩形候选。
 *  x<0 表示全量（路径搜索端点省略场景）。 */
static int blockers_for(SimUnit* u, double x, double y, int* out) {
  int n = 0;
  for (int i = 0; i < SIM_MAX; i++) {
    SimUnit* t = &U[i];
    if (!t->alive || t->pathingOff || t == u) continue;
    if (t->fly != u->fly) continue;
    const double r = u->radius + t->radius;
    if (x >= 0 && (t->x < fmin(u->x, x) - r || t->x > fmax(u->x, x) + r ||
                   t->y < fmin(u->y, y) - r || t->y > fmax(u->y, y) + r)) continue;
    out[n++] = i;
  }
  return n;
}

/** canAdvance（JS 全量）：地形扫掠 + 实体投影距离。 */
static int can_advance(SimUnit* u, double x, double y, int nb, const int* b) {
  if (!clear_footprint(u->x, u->y, x, y, u->pathingOff ? 0 : u->radius)) return 0;
  const double dx = x - u->x, dy = y - u->y, len2 = dx * dx + dy * dy;
  for (int i = 0; i < nb; i++) {
    const SimUnit* t = &U[b[i]];
    const double ax = t->x - u->x, ay = t->y - u->y;
    const double start2 = ax * ax + ay * ay;
    const double f = len2 ? fmax(0, fmin(1, (ax * dx + ay * dy) / len2)) : 0;
    const double distance2 = (ax - f * dx) * (ax - f * dx) + (ay - f * dy) * (ay - f * dy);
    const double need2 = (u->radius + t->radius) * (u->radius + t->radius);
    if (distance2 < fmin(start2, need2) - 1e-6) return 0;
  }
  return 1;
}

/** 设路径（世界坐标 float2 对）。 */
static void sim_set_path_u(SimUnit* u, const double* pts, int n) {
  if (n > u->capPath) {
    u->capPath = n ? n + 8 : 16;
    u->path = (double*)realloc(u->path, sizeof(double) * 2 * (size_t)u->capPath);
  }
  for (int i = 0; i < n; i++) { u->path[2 * i] = pts[2 * i]; u->path[2 * i + 1] = pts[2 * i + 1]; }
  u->nPath = n;
}

void sim_grid_init(uint8_t* walk, int w, int h, double ox, double oy) {
  W = walk; GW = w; GH = h; OX = ox; OY = oy;
}

static int inside(int cx, int cy) { return cx >= 0 && cy >= 0 && cx < GW && cy < GH; }
static int walkable(int cx, int cy) { return inside(cx, cy) && W[cy * GW + cx] == 1; }
static int walkable_at(double x, double y) {
  int cx = (int)floor((x - OX) / SIM_PCELL), cy = (int)floor((y - OY) / SIM_PCELL);
  return walkable(cx, cy);
}

/** 精确扫掠圆盘对阻挡格/地图边界的可行检测（pathing.js clearFootprint 全量移植）。 */
static int clear_footprint(double x0, double y0, double x1, double y1, double radius) {
  const double r = fmax(0, radius), dx = x1 - x0, dy = y1 - y0;
  if (fmin(x0, x1) - r < OX || fmin(y0, y1) - r < OY ||
      fmax(x0, x1) + r > OX + GW * SIM_PCELL ||
      fmax(y0, y1) + r > OY + GH * SIM_PCELL) return 0;
  int left = (int)floor((fmin(x0, x1) - r - OX) / SIM_PCELL);
  int bottom = (int)floor((fmin(y0, y1) - r - OY) / SIM_PCELL);
  int right = (int)floor((fmax(x0, x1) + r - OX) / SIM_PCELL);
  int top = (int)floor((fmax(y0, y1) + r - OY) / SIM_PCELL);
  const double len2 = dx * dx + dy * dy;
  for (int cy = bottom; cy <= top; cy++) {
    double start = 0, end = 1;
    if (dy != 0) {
      const double a = (OY + cy * SIM_PCELL - r - y0) / dy;
      const double b = (OY + (cy + 1) * SIM_PCELL + r - y0) / dy;
      start = fmax(0, fmin(a, b)); end = fmin(1, fmax(a, b));
      if (start > end) continue;
    }
    const double a2 = x0 + dx * start, b2 = x0 + dx * end;
    int rowLeft = (int)fmax(left, floor((fmin(a2, b2) - r - OX) / SIM_PCELL));
    int rowRight = (int)fmin(right, floor((fmax(a2, b2) + r - OX) / SIM_PCELL));
    for (int cx = rowLeft; cx <= rowRight; cx++) {
      if (walkable(cx, cy)) continue;
      const double ax = OX + cx * SIM_PCELL, ay = OY + cy * SIM_PCELL;
      const double bx = ax + SIM_PCELL, by = ay + SIM_PCELL;
      double lo = 0, hi = 1;
      { const double px[2] = { x0, y0 }, d[2] = { dx, dy }, a3[2] = { ax, ay }, b3[2] = { bx, by };
        for (int k = 0; k < 2; k++) {
          if (d[k] == 0) { if (px[k] < a3[k] || px[k] > b3[k]) hi = -1; }
          else { const double t0 = (a3[k] - px[k]) / d[k], t1 = (b3[k] - px[k]) / d[k];
            lo = fmax(lo, fmin(t0, t1)); hi = fmin(hi, fmax(t0, t1)); }
        }
      }
      if (lo <= hi) return 0;
      double d2 = fmin(
        fmax(fmax(ax - x0, 0.0), x0 - bx) * fmax(fmax(ax - x0, 0.0), x0 - bx) + fmax(fmax(ay - y0, 0.0), y0 - by) * fmax(fmax(ay - y0, 0.0), y0 - by),
        fmax(fmax(ax - x1, 0.0), x1 - bx) * fmax(fmax(ax - x1, 0.0), x1 - bx) + fmax(fmax(ay - y1, 0.0), y1 - by) * fmax(fmax(ay - y1, 0.0), y1 - by));
      { const double px[4] = { ax, ax, bx, bx }, py4[4] = { ay, by, ay, by };
        for (int k = 0; k < 4; k++) {
          const double t = len2 ? fmax(0, fmin(1, ((px[k] - x0) * dx + (py4[k] - y0) * dy) / len2)) : 0;
          const double ex = px[k] - x0 - dx * t, ey = py4[k] - y0 - dy * t;
          d2 = fmin(d2, ex * ex + ey * ey);
        }
      }
      if (d2 < r * r - 1e-6) return 0;
    }
  }
  return 1;
}

/** 最近可行走格（有界螺旋搜索，pass = 半径足迹 + 实体 occupancy，对齐 JS pathing pass）。 */
static void nearest_walkable(double x, double y, int maxR, double radius, int* ocx, int* ocy) {
  int cx = (int)floor((x - OX) / SIM_PCELL), cy = (int)floor((y - OY) / SIM_PCELL);
  if (walkable(cx, cy)) {
    double pwx = OX + (cx + 0.5) * SIM_PCELL, pwy = OY + (cy + 0.5) * SIM_PCELL;
    if (clear_footprint(pwx, pwy, pwx, pwy, radius) && occ_clear(pwx, pwy)) { *ocx = cx; *ocy = cy; return; }
  }
  for (int r = 1; r <= maxR; r++)
    for (int dx = -r; dx <= r; dx++)
      for (int dy = -r; dy <= r; dy++) {
        if (fmax(abs(dx), abs(dy)) != r) continue;
        if (walkable(cx + dx, cy + dy)) {
          double pwx = OX + (cx + dx + 0.5) * SIM_PCELL, pwy = OY + (cy + dy + 0.5) * SIM_PCELL;
          if (clear_footprint(pwx, pwy, pwx, pwy, radius) && occ_clear(pwx, pwy)) { *ocx = cx + dx; *ocy = cy + dy; return; }
        }
      }
  *ocx = -1; *ocy = -1;
}

/** 连通区域 BFS（pathing.js connected，每次重算；path 只调一次）。 */
static int connected_idx(int start, int goal) {
  if (start == goal) return 1;
  const int size = GW * GH;
  uint8_t* regions = (uint8_t*)calloc((size_t)size, 1);
  int* queue = (int*)malloc(sizeof(int) * (size_t)size);
  int found = 0;
  int head = 0, tail = 0;
  queue[tail++] = start; regions[start] = 1;
  while (head < tail && !found) {
    const int cur = queue[head++], x = cur % GW;
    const int n[4] = { cur - 1, cur + 1, cur - GW, cur + GW };
    for (int k = 0; k < 4; k++) {
      int nc = n[k];
      if (k == 0 && x <= 0) continue;
      if (k == 1 && x + 1 >= GW) continue;
      if (nc < 0 || nc >= size || regions[nc] || W[nc] != 1) continue;
      regions[nc] = 1; queue[tail++] = nc;
      if (nc == goal) { found = 1; break; }
    }
  }
  free(regions); free(queue);
  return found;
}

/** A* 寻路（pathing.js path 全量移植：二叉堆 + g/f/from + string-pull）。 */
static double* heap;      // open 堆（存格索引）
static int heapLen, heapCap;
static int* hpos;         // 格索引 → 堆位置
static float* g; static float* f; static int* from;   // float32 对齐 JS Float32Array（f 相等性影响堆序）

static int less_f(int a, int b) { return f[a] < f[b] || (f[a] == f[b] && a < b); }
static void heap_rise(int i) {
  const int node = (int)heap[i];
  while (i > 0) {
    const int parent = (i - 1) >> 1;
    if (!less_f(node, (int)heap[parent])) break;
    heap[i] = heap[parent]; hpos[(int)heap[i]] = i; i = parent;
  }
  heap[i] = node; hpos[node] = i;
}
static void heap_push(int node) {
  if (heapLen == heapCap) { heapCap = heapCap ? heapCap * 2 : 256; heap = (double*)realloc(heap, sizeof(double) * (size_t)heapCap); }
  hpos[node] = heapLen; heap[heapLen++] = node; heap_rise(hpos[node]);
}
static int heap_pop(void) {
  const int first = (int)heap[0], last = (int)heap[--heapLen];
  hpos[first] = -1;
  if (heapLen) {
    int i = 0;
    while (i * 2 + 1 < heapLen) {
      int child = i * 2 + 1;
      if (child + 1 < heapLen && less_f((int)heap[child + 1], (int)heap[child])) child++;
      if (!less_f((int)heap[child], last)) break;
      heap[i] = heap[child]; hpos[(int)heap[i]] = i; i = child;
    }
    heap[i] = last; hpos[last] = i;
  }
  return first;
}

static double hx(int i, int t0, int t1) {
  const int x = i % GW, y = (i - x) / GW;
  const double dx = fabs(x - t0), dy = fabs(y - t1);
  return (dx + dy) + (SIM_SQRT2 - 2) * fmin(dx, dy);
}

static int clear_line(double x0, double y0, double x1, double y1, double radius) {
  if (!clear_footprint(x0, y0, x1, y1, radius)) return 0;
  const double d = hypot(x1 - x0, y1 - y0);
  const int steps = (int)ceil(d / (SIM_PCELL * 0.5));
  for (int i = 0; i <= steps; i++) {
    const double t = steps ? (double)i / steps : 0;
    const double x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
    if (!walkable_at(x, y)) return 0;
    if (!occ_clear(x, y)) return 0;   // JS _trace 把 occupancy 原函数传给 clearLine（无 clear 单点）
  }
  return 1;
}

/** 世界坐标点序列写入 out（float2 对），返回点数（不含起点）；-1=无路径。
 *  radius>0 时按 pathing.js Grid.path 的 pass 语义检查（含半径足迹）。 */
int sim_find_path_r(double sx, double sy, double tx, double ty, float* out, int maxOut, double radius) {
  int s0, s1, t0, t1;
  nearest_walkable(sx, sy, 24, radius, &s0, &s1);
  nearest_walkable(tx, ty, 24, radius, &t0, &t1);
  if (s0 < 0 || t0 < 0) return -1;
  if (s0 == t0 && s1 == t1) {
    if (maxOut < 1) return -1;
    out[0] = (float)(OX + (t0 + 0.5) * SIM_PCELL);
    out[1] = (float)(OY + (t1 + 0.5) * SIM_PCELL);
    return 1;
  }
  const int start = s1 * GW + s0, goal = t1 * GW + t0;
  if (!connected_idx(start, goal)) return -1;
  const int N = GW * GH;
  g = (float*)malloc(sizeof(float) * (size_t)N);
  f = (float*)malloc(sizeof(float) * (size_t)N);
  from = (int*)malloc(sizeof(int) * (size_t)N);
  hpos = (int*)malloc(sizeof(int) * (size_t)N);
  uint8_t* closed = (uint8_t*)calloc((size_t)N, 1);
  heap = NULL; heapLen = 0; heapCap = 0;
  for (int i = 0; i < N; i++) { g[i] = INFINITY; f[i] = INFINITY; from[i] = -1; hpos[i] = -1; }
  g[start] = 0; f[start] = (float)hx(start, t0, t1); heap_push(start);
  int expanded = 0, found = 0;
  while (heapLen) {
    const int cur = heap_pop();
    if (cur == goal) { found = 1; break; }
    closed[cur] = 1;
    if (++expanded > 20000) break;
    const int cx = cur % GW, cy = (cur - cx) / GW;
    for (int dy = -1; dy <= 1; dy++) for (int dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const int nx = cx + dx, ny = cy + dy;
      if (!inside(nx, ny)) continue;
      const int ni = ny * GW + nx;
      if (closed[ni] || !walkable(nx, ny)) continue;
      const double pwx0 = OX + (cx + 0.5) * SIM_PCELL, pwy0 = OY + (cy + 0.5) * SIM_PCELL;
      const double pwx1 = OX + (nx + 0.5) * SIM_PCELL, pwy1 = OY + (ny + 0.5) * SIM_PCELL;
      // passable（JS pathing）：格中心 clear 单点 + occupancy
      if (!clear_footprint(pwx1, pwy1, pwx1, pwy1, radius)) continue;
      if (!occ_clear(pwx1, pwy1)) continue;
      if (dx && dy) {
        if (!walkable(cx + dx, cy) || !walkable(cx, cy + dy)) continue;   // JS 对角 walkable
        const double pxc = OX + (cx + dx + 0.5) * SIM_PCELL, pyc = OY + (cy + 0.5) * SIM_PCELL;
        const double pxc2 = OX + (cx + 0.5) * SIM_PCELL, pyc2 = OY + (cy + dy + 0.5) * SIM_PCELL;
        if (!clear_footprint(pxc, pyc, pxc, pyc, radius) || !occ_clear(pxc, pyc)) continue;
        if (!clear_footprint(pxc2, pyc2, pxc2, pyc2, radius) || !occ_clear(pxc2, pyc2)) continue;
      }
      if (!clear_footprint(pwx0, pwy0, pwx1, pwy1, radius)) continue;   // 段扫掠（JS 无 occupancy）
      const double ngd = (double)g[cur] + (dx && dy ? SIM_SQRT2 : 1);   // JS: float+double → double 比较
      if (ngd < (double)g[ni]) {
        g[ni] = (float)ngd; from[ni] = cur; f[ni] = (float)(ngd + hx(ni, t0, t1));
        if (hpos[ni] < 0) heap_push(ni); else heap_rise(hpos[ni]);
      }
    }
  }
  if (!found) { free(g); free(f); free(from); free(hpos); free(closed); free(heap); return -1; }
  // 回溯 + string-pull（_trace 全量移植：drop 共线/直达点）
  int* cells = (int*)malloc(sizeof(int) * (size_t)N);
  int n = 0, cur = goal;
  while (cur != -1) { cells[n++] = cur; cur = from[cur]; }
  for (int i = 0; i < n / 2; i++) { int t = cells[i]; cells[i] = cells[n - 1 - i]; cells[n - 1 - i] = t; }
  double* pts = (double*)malloc(sizeof(double) * 2 * (size_t)n);
  for (int i = 0; i < n; i++) {
    const int x = cells[i] % GW, y = (cells[i] - x) / GW;
    pts[2 * i] = OX + (x + 0.5) * SIM_PCELL; pts[2 * i + 1] = OY + (y + 0.5) * SIM_PCELL;
  }
  double* res = (double*)malloc(sizeof(double) * 2 * (size_t)n);
  int m = 0;
  res[0] = pts[0]; res[1] = pts[1]; m = 1;
  int anchor = 0;
  for (int i = 2; i < n; i++) {
    if (!clear_line(pts[2 * anchor], pts[2 * anchor + 1], pts[2 * i], pts[2 * i + 1], radius)) {
      res[2 * m] = pts[2 * (i - 1)]; res[2 * m + 1] = pts[2 * (i - 1) + 1]; m++;
      anchor = i - 1;
    }
  }
  res[2 * m] = pts[2 * (n - 1)]; res[2 * m + 1] = pts[2 * (n - 1) + 1]; m++;
  // 去起点（对齐 JS out.slice(1)）
  const int outN = m - 1;
  for (int i = 0; i < outN && i * 2 + 1 < maxOut * 2; i++) {
    out[2 * i] = (float)res[2 * (i + 1)]; out[2 * i + 1] = (float)res[2 * (i + 1) + 1];
  }
  free(cells); free(pts); free(res);
  free(g); free(f); free(from); free(hpos); free(closed); free(heap);
  return outN;
}

int sim_find_path(double sx, double sy, double tx, double ty, float* out, int maxOut) {
  return sim_find_path_r(sx, sy, tx, ty, out, maxOut, 0);   // 壳：radius 0（Grid.path 默认对照）
}

int sim_clear_foot(double x0, double y0, double x1, double y1, double radius) {
  return clear_footprint(x0, y0, x1, y1, radius);
}
int sim_connected_i(int start, int goal) { return connected_idx(start, goal); }

// ------------------------------------------------------------------ 单位移动推进
// 对齐 world.js stepMove 的 move 分支（单单位、无实体阻挡）+ movementPath 快路径：
//   1) 直线可达（canAdvance 通过）→ 单段直达目标；
//   2) 否则 nearestWalkable 入口 → Grid.path A*；
//   3) 逐 tick：turnToward 转向（预算 turnRate·dt/0.03）→ 沿 path[0] 推进
//      stepLen = speed·dt → canAdvance(扫掠圆盘 radius) → 到达则 path 耗尽。

static double U_X, U_Y, U_FACING;       // 单位状态（单单位场景）
static double* UP; int UN, UCAP;        // 当前路径（世界坐标 float2 对）

void sim_set_unit(double x, double y, double facing) {
  U_X = x; U_Y = y; U_FACING = facing; UN = 0;
}
int sim_set_path(const float* pts, int n) {
  if (n < 0) return 0;
  if (n > UCAP) { UCAP = n ? n : 8; UP = (double*)realloc(UP, sizeof(double) * 2 * (size_t)UCAP); }
  for (int i = 0; i < n; i++) { UP[2 * i] = pts[2 * i]; UP[2 * i + 1] = pts[2 * i + 1]; }
  UN = n;
  return 1;
}

/** movementPath（快路径优先）+ 单位逐 tick 推进；输出 outState[6] =
 *  [arriveTick, pathLen, endX, endY, endErr, segCount]；返回 1 到达 / 0 未达 /
 *  -1 无路径。 */
int sim_run_move(double sx, double sy, double tx, double ty,
                 double radius, double speed, double turnRate, double dt,
                 int maxTicks, float* outState) {
  // movementPath：快路径（直线可达 → 单段）
  if (clear_footprint(sx, sy, tx, ty, radius)) {
    U_X = sx; U_Y = sy; UN = 1;
    if (UP == NULL) { UCAP = 8; UP = (double*)malloc(sizeof(double) * 2 * (size_t)UCAP); }
    UP[0] = tx; UP[1] = ty;
  } else {
    // 慢路径：nearestWalkable 入口 + A*
    int s0, s1, t0, t1;
    nearest_walkable(sx, sy, 24, radius, &s0, &s1);
    nearest_walkable(tx, ty, 24, radius, &t0, &t1);
    if (s0 < 0 || t0 < 0) return -1;
    const double ex = OX + (s0 + 0.5) * SIM_PCELL, ey = OY + (s1 + 0.5) * SIM_PCELL;
    if (!clear_footprint(sx, sy, ex, ey, radius)) return -1;
    float buf[512];
    const int n = sim_find_path_r(ex, ey, tx, ty, buf, 256, radius);
    if (n < 0) return -1;
    U_X = sx; U_Y = sy; UN = n + 1;
    if (UN > UCAP) { UCAP = UN + 8; UP = (double*)realloc(UP, sizeof(double) * 2 * (size_t)UCAP); }
    UP[0] = ex; UP[1] = ey;
    for (int i = 0; i < n; i++) { UP[2 * (i + 1)] = buf[2 * i]; UP[2 * (i + 1) + 1] = buf[2 * i + 1]; }
  }
  double pathLen = 0, px = sx, py = sy;
  int arrive = -1;
  for (int t = 0; t < maxTicks && UN > 0; t++) {
    const double gx = UP[0], gy = UP[1];
    // turnToward
    double angle = atan2(gy - U_Y, gx - U_X);
    double delta = atan2(sin(angle - U_FACING), cos(angle - U_FACING));
    if (fabs(delta) >= 1e-9) {
      double budget = fmax(0, turnRate) * dt / 0.03;
      double amount = fmin(fabs(delta), budget);
      U_FACING += (delta > 0 ? 1 : -1) * amount;
      U_FACING = atan2(sin(U_FACING), cos(U_FACING));
      if (fabs(delta) - amount >= 1e-9) { pathLen += hypot(U_X - px, U_Y - py); px = U_X; py = U_Y; continue; }
    }
    const double dx = gx - U_X, dy = gy - U_Y, d = hypot(dx, dy);
    const double stepLen = speed * dt;
    const double fraction = d > 0 ? fmin(1, stepLen / d) : 0;
    const double nx = U_X + dx * fraction, ny = U_Y + dy * fraction;
    if (!clear_footprint(U_X, U_Y, nx, ny, radius)) {   // canAdvance（无实体）
      pathLen += hypot(U_X - px, U_Y - py); px = U_X; py = U_Y;
      continue;   // 撞墙停（不推进，等重寻路由上层处理）
    }
    U_X = nx; U_Y = ny;
    pathLen += hypot(U_X - px, U_Y - py); px = U_X; py = U_Y;
    if (hypot(U_X - tx, U_Y - ty) < 40) { arrive = t; break; }   // golden 到达判定（0-based，距目标 40 内）
    if (d <= stepLen) {
      // path.shift()
      for (int i = 1; i < UN; i++) { UP[2 * (i - 1)] = UP[2 * i]; UP[2 * (i - 1) + 1] = UP[2 * i + 1]; }
      UN--;
      if (UN == 0) { arrive = t; break; }
    }
  }
  outState[0] = (float)arrive;                     // arriveTick（-1 未达）
  outState[1] = (float)pathLen;
  outState[2] = (float)U_X; outState[3] = (float)U_Y;
  outState[4] = (float)hypot(U_X - tx, U_Y - ty);  // endErr
  outState[5] = arrive >= 0 ? 1 : 0;
  return arrive >= 0 ? 1 : 0;
}

// ------------------------------------------------------------------ 多单位世界
// 单位表已定义于头部（SimUnit U[SIM_MAX]）。sim_order_move：movementPath 含实体
// （快路径 canAdvance 含实体 + 慢路径 occupancy）；sim_tick：全单位 stepMove
// move 分支（turnToward 预算 + canAdvance 实体段 + 撞墙 250ms 冷却重寻路）。

/** movementPath（含实体阻挡）→ 设路径；返回 1 成功 / -1 无路径。 */
int sim_order_move(int id, double tx, double ty) {
  SimUnit* u = &U[id];
  if (!u->alive) return -1;
  const double radius = u->pathingOff ? 0 : u->radius;
  int b[SIM_MAX], nb = blockers_for(u, -1, -1, b);
  // occupancy 快照（circles：r2 = min(半径和², 当前距离²)）
  OCN = 0;
  for (int i = 0; i < nb && OCN < 256; i++) {
    const SimUnit* t = &U[b[i]];
    double r2 = (u->radius + t->radius) * (u->radius + t->radius);
    const double d2 = (u->x - t->x) * (u->x - t->x) + (u->y - t->y) * (u->y - t->y);
    if (d2 < r2) r2 = d2;
    OCX[OCN] = t->x; OCY[OCN] = t->y; OCR2[OCN] = r2; OCN++;
  }
  // 快路径：直线可达（含实体）
  if (can_advance(u, tx, ty, nb, b)) {
    double p[2] = { tx, ty };
    sim_set_path_u(u, p, 1);
    OCN = 0;
    return 1;
  }
  // 慢路径：入口 + A*（occupancy 全局生效）
  int s0, s1, t0, t1;
  nearest_walkable(u->x, u->y, 24, radius, &s0, &s1);
  nearest_walkable(tx, ty, 24, radius, &t0, &t1);
  if (s0 < 0 || t0 < 0) { OCN = 0; return -1; }
  const double ex = OX + (s0 + 0.5) * SIM_PCELL, ey = OY + (s1 + 0.5) * SIM_PCELL;
  if (!can_advance(u, ex, ey, nb, b)) { OCN = 0; return -1; }
  float buf[1024];
  const int n = sim_find_path_r(ex, ey, tx, ty, buf, 512, radius);
  OCN = 0;
  if (n < 0) return -1;
  double* pts = (double*)malloc(sizeof(double) * 2 * (size_t)(n + 1));
  pts[0] = ex; pts[1] = ey;
  for (int i = 0; i < n; i++) { pts[2 * (i + 1)] = buf[2 * i]; pts[2 * (i + 1) + 1] = buf[2 * i + 1]; }
  sim_set_path_u(u, pts, n + 1);
  free(pts);
  return 1;
}

/** routeUnit = movementPath(u, tx, ty, [])：空 blockers（无实体阻挡）。
 *  AI 追击（stepAI 发包后 stepMove 2814-2832 requestMovementPath body=false → routeUnit）。
 *  返回 1 成功 / -1 无路径。 */
static int sim_route(SimUnit* u, int id, double tx, double ty) {
  if (!u->alive) return -1;
  const double radius = u->pathingOff ? 0 : u->radius;
  if (clear_footprint(u->x, u->y, tx, ty, radius)) {   // 快路径：直线（无实体）
    double p[2] = { tx, ty };
    sim_set_path_u(u, p, 1);
    return 1;
  }
  // 慢路径：入口（起点格）+ A*（无 occupancy；OCN=0 时不查实体）
  int s0, s1, t0, t1;
  nearest_walkable(u->x, u->y, 24, radius, &s0, &s1);
  nearest_walkable(tx, ty, 24, radius, &t0, &t1);
  if (s0 < 0 || t0 < 0) return -1;
  const double ex = OX + (s0 + 0.5) * SIM_PCELL, ey = OY + (s1 + 0.5) * SIM_PCELL;
  if (!clear_footprint(u->x, u->y, ex, ey, radius)) return -1;   // canAdvance(entry, [])
  OCN = 0;
  float buf[1024];
  const int n = sim_find_path_r(ex, ey, tx, ty, buf, 512, radius);
  if (n < 0) return -1;
  double* pts = (double*)malloc(sizeof(double) * 2 * (size_t)(n + 1));
  pts[0] = ex; pts[1] = ey;
  for (int i = 0; i < n; i++) { pts[2 * (i + 1)] = buf[2 * i]; pts[2 * (i + 1) + 1] = buf[2 * i + 1]; }
  sim_set_path_u(u, pts, n + 1);
  free(pts);
  return 1;
}

/** 单单位 move 分支推进一步（对齐 stepMove 2834-2855；sim_tick 与 sim_move 共用）。 */
static void step_move_unit(SimUnit* u, int id, double dt) {
  if (!u->alive || u->nPath == 0) return;
  const double gx = u->path[0], gy = u->path[1];
  // turnToward（预算 turnRate·dt/0.03）
  const double angle = atan2(gy - u->y, gx - u->x);
  double delta = atan2(sin(angle - u->facing), cos(angle - u->facing));
  if (fabs(delta) >= 1e-9) {
    const double budget = 0.6 * dt / 0.03;
    const double amount = fmin(fabs(delta), budget);
    u->facing += (delta > 0 ? 1 : -1) * amount;
    u->facing = atan2(sin(u->facing), cos(u->facing));
    if (fabs(delta) - amount >= 1e-9) return;   // 转向未到位，本 tick 不动
  }
  const double dx = gx - u->x, dy = gy - u->y, d = hypot(dx, dy);
  const double stepLen = u->speed * dt;
  const double fraction = d > 0 ? fmin(1, stepLen / d) : 0;
  const double nx = u->x + dx * fraction, ny = u->y + dy * fraction;
  int b2[SIM_MAX], nb2 = blockers_for(u, nx, ny, b2);   // step 扫掠矩形候选
  if (!can_advance(u, nx, ny, nb2, b2)) {
    // 撞墙：250ms 冷却后重寻路到 path 终点（bodyRepathAt）
    if (u->bodyRepathAt <= SIM_NOW) {
      const double ggx = u->path[2 * (u->nPath - 1)], ggy = u->path[2 * (u->nPath - 1) + 1];
      sim_order_move(id, ggx, ggy);
      u->bodyRepathAt = SIM_NOW + (long long)(0.25 / dt);
    }
    return;
  }
  u->x = nx; u->y = ny;
  if (d <= stepLen) {
    for (int i = 1; i < u->nPath; i++) { u->path[2 * (i - 1)] = u->path[2 * i]; u->path[2 * (i - 1) + 1] = u->path[2 * i + 1]; }
    u->nPath--;
    if (u->nPath == 0) { /* 到达 → idle（path 空即停） */ }
  }
}

/** 全单位推进一个 tick（move 分支；对齐 stepMove 2834-2855）。 */
void sim_tick(double dt) {
  SIM_NOW++;
  for (int id = 0; id < SIM_MAX; id++) step_move_unit(&U[id], id, dt);
}

/** 读单位状态：out[4] = x, y, facing, nPath。 */
void sim_get(int id, float* out) {
  if (id < 0 || id >= SIM_MAX || !U[id].alive) { for (int i = 0; i < 4; i++) out[i] = 0; return; }
  out[0] = (float)U[id].x; out[1] = (float)U[id].y; out[2] = (float)U[id].facing; out[3] = (float)U[id].nPath;
}

/** 读单位路径点：out 为 float2 对（世界坐标）；返回段数。-1 无效。 */
int sim_get_path(int id, float* out, int maxOut) {
  if (id < 0 || id >= SIM_MAX || !U[id].alive) return -1;
  const int n = U[id].nPath < maxOut ? U[id].nPath : maxOut;
  for (int i = 0; i < n; i++) { out[2 * i] = (float)U[id].path[2 * i]; out[2 * i + 1] = (float)U[id].path[2 * i + 1]; }
  return n;
}

/** 统一命令接口（wasm_move 收口）：给单位下移动命令并立即推进一个 tick。
 *  目标变化或路径耗尽时重新寻路；out[3] = x, y, facing, nPath。返回 1 有效。 */
int sim_move(int id, double tx, double ty, double dt, float* out) {
  SimUnit* u = &U[id];
  if (!u->alive) return -1;
  if (u->nPath == 0 || u->goalX != tx || u->goalY != ty) {
    if (sim_order_move(id, tx, ty) < 0) return -1;   // 寻路失败（不可达）
    u->goalX = tx; u->goalY = ty;
  }
  SIM_NOW++;
  step_move_unit(u, id, dt);
  if (out) { out[0] = (float)u->x; out[1] = (float)u->y; out[2] = (float)u->facing; out[3] = (float)u->nPath; }
  return 1;
}

// ------------------------------------------------------------------ 战斗（阶段 2）
// 攻击状态机对齐 stepAttack（2991-3044）子集：无 buff/无特殊 order——
// atkTimer 冷却 → 自动目标扫描（敌对+距离）→ 转向 → windup 前摇 → releaseAttack
// （近战直接结算；远程导弹阶段 2b 再进）。伤害对齐 damage()（1084-1132）纯数值部分：
// armorFactor + typeBonus 表 + hp 扣减 + 死亡。

static unsigned long long RNG = 0x9E3779B97F4A7C15ULL;   // xorshift（伤害 roll；对照用分布等价）
static double rng_next(void) {
  RNG ^= RNG << 13; RNG ^= RNG >> 7; RNG ^= RNG << 17;
  return (double)((RNG >> 32) & 0xFFFFFFFF) / 4294967296.0;
}

void sim_spawn_fight(int id, double x, double y, double facing, double speed, double radius,
                     double hp, double maxHp, double armor, int armorTypeIdx, int team,
                     double dmgBase, double dmgDice, double dmgSides,
                     double atkCd, double atkRange, double attackPoint, double attackBackswing,
                     int atkTypeIdx, int weaponKind, double missileSpeed) {
  sim_spawn(id, x, y, facing, speed, radius, 0, 0);
  SimUnit* u = &U[id];
  u->hp = hp; u->maxHp = maxHp; u->armor = armor;
  u->armorTypeIdx = armorTypeIdx; u->team = team;
  u->dmgBase = dmgBase; u->dmgDice = dmgDice; u->dmgSides = dmgSides;
  u->atkCd = atkCd; u->atkRange = atkRange;
  u->attackPoint = attackPoint; u->attackBackswing = attackBackswing;
  u->atkTypeIdx = atkTypeIdx; u->weaponKind = weaponKind;
  u->missileSpeed = missileSpeed;
  u->atkTimer = 0; u->attackWindupRemaining = 0; u->attackWindupTarget = -1;
  u->atkCount = 0; u->dmgCount = 0; u->deathCount = 0;
  // AI 初始：idle、acquisitionRange 500（hfoo 实测）、home = spawn
  u->orderType = 0; u->orderTargetId = -1;
  u->acquisitionRange = 500; u->homeX = x; u->homeY = y;
}

/** 单位元数据（不在 spawn_fight 签名里的部分）：所属玩家槽 + 赏金 + 等级。
 *  awardKill 用 playerIndex 记账、用 bounty/level 定金额（见 sim_damage）。 */
void sim_set_meta(int id, int playerIndex, double bounty, int level) {
  if (id < 0 || id >= SIM_MAX) return;
  U[id].playerIndex = playerIndex; U[id].bounty = bounty; U[id].level = level;
}

/** 伤害结算（damage() 纯数值子集）。返回实际伤害。 */
static double sim_damage(int srcId, int tgtId, double amount, int atkTypeIdx) {
  SimUnit* t = &U[tgtId];
  if (!t->alive) return 0;
  double dmg = amount;
  dmg *= type_bonus(atkTypeIdx, t->armorTypeIdx);
  dmg *= armor_factor(t->armor);
  t->hp -= dmg;
  t->dmgCount++;
  if (t->hp <= 0) {
    t->alive = 0; t->deathCount = 1;
    // awardKill（world.js 884-889）：击杀赏金归杀害者所属玩家。
    // 金额 = victim.bounty（bountyPlus）非零则用它，否则 10 + level*4。
    // JS 的 bounty *事件*（浮字）另受 owner.givesBounty 门控——那是地图/玩家槽
    // 状态（map init 给 Player 0..7 开启），尚未移植，故此处只结算金、不发事件。
    if (srcId >= 0 && srcId < SIM_MAX && srcId != tgtId) {
      const SimUnit* src = &U[srcId];
      if (src->playerIndex >= 0 && src->playerIndex < 16)
        GOLD[src->playerIndex] += (t->bounty > 0 ? t->bounty : 10.0 + 4.0 * (double)t->level);
    }
    ev_push(SIM_EV_DEATH, (int)(t - U), 0);
  }
  return dmg;
}

/** 攻击释放（releaseAttack 3046-3106：roll + 近战直击 / 远程发导弹延迟伤害）。 */
static void release_attack(SimUnit* u, SimUnit* t) {
  const int slot = (int)(u - U), tgt = (int)(t - U);
  double amount = u->dmgBase;
  const int dice = (int)u->dmgDice;
  for (int i = 0; i < dice; i++) amount += floor(rng_next() * fmax(1, u->dmgSides)) + 1;
  u->atkCount++;
  // 远程：非 normal 武器 + 有导弹速度 → 发射导弹（伤害延迟到命中，对齐 releaseAttack 3103-3104）
  if (u->weaponKind != 0 && u->missileSpeed > 0) {
    for (int i = 0; i < SIM_MISSILE_MAX; i++) {
      if (M[i].active) continue;
      const double dist = hypot(t->x - u->x, t->y - u->y);
      M[i].active = 1; M[i].srcId = slot; M[i].targetId = tgt; M[i].fx = ++FXSEQ;
      M[i].x = u->x; M[i].y = u->y; M[i].dx = t->x; M[i].dy = t->y;
      M[i].speed = u->missileSpeed;
      M[i].deadlineMs = SIM_NOW * (1000.0 / 30.0) + fmax(1500.0, (dist / u->missileSpeed) * 3000.0);
      M[i].amount = amount; M[i].atkTypeIdx = u->atkTypeIdx;
      return;
    }
    return;   // 槽满：本次攻击放弃命中（不常见，保表简单）
  }
  sim_damage(slot, tgt, amount, u->atkTypeIdx);
}

/** 单单位攻击 tick（stepAttack 子集，对齐 2991-3044）。 */
static void step_attack_unit(SimUnit* u, double dt) {
  if (u->atkTimer > 0) u->atkTimer = fmax(0, u->atkTimer - dt);
  if (!u->alive) return;
  // windup 推进
  if (u->attackWindupRemaining > 0) {
    SimUnit* t = (u->attackWindupTarget >= 0) ? &U[u->attackWindupTarget] : NULL;
    if (!t || !t->alive) { u->attackWindupRemaining = 0; return; }
    const double d = hypot(t->x - u->x, t->y - u->y) - t->radius;
    if (d > u->atkRange) { u->attackWindupRemaining = 0; return; }   // 目标脱出射程 → 取消
    u->attackWindupRemaining -= dt;
    if (u->attackWindupRemaining <= 1e-9) {
      u->attackWindupRemaining = 0;
      release_attack(u, t);
    }
    return;
  }
  // 目标选择（JS stepAttack 3012-3024）：AI 固定目标（order.targetId）优先，
  // 目标失效才自动扫描（攻击中不换目标）
  int tgt = -1;
  if (u->orderTargetId >= 0 && U[u->orderTargetId].alive && U[u->orderTargetId].team != u->team)
    tgt = u->orderTargetId;
  if (tgt < 0) {
    double bd = 1e18;
    for (int i = 0; i < SIM_MAX; i++) {
      SimUnit* o = &U[i];
      if (!o->alive || o == u || o->team == u->team) continue;
      const double d = hypot(o->x - u->x, o->y - u->y);
      if (d < u->atkRange + o->radius + 40 && d < bd) { bd = d; tgt = i; }
    }
  }
  if (tgt < 0) return;
  SimUnit* t = &U[tgt];
  const double d = hypot(t->x - u->x, t->y - u->y) - t->radius;
  if (d > u->atkRange) return;
  // turnToward（攻击前转向）
  const double angle = atan2(t->y - u->y, t->x - u->x);
  double delta = atan2(sin(angle - u->facing), cos(angle - u->facing));
  if (fabs(delta) >= 1e-9) {
    const double budget = 0.6 * dt / 0.03;
    const double amount = fmin(fabs(delta), budget);
    u->facing += (delta > 0 ? 1 : -1) * amount;
    u->facing = atan2(sin(u->facing), cos(u->facing));
    if (fabs(delta) - amount >= 1e-9) return;   // 转向未到位
  }
  if (u->atkTimer > 0) return;
  u->atkTimer = fmax(u->atkCd, u->attackPoint + u->attackBackswing);   // speed mul 1
  u->attackWindupRemaining = u->attackPoint;
  u->attackWindupTarget = tgt;
  ev_push(SIM_EV_ATTACK, (int)(u - U), tgt);   // JS emit({t:'attack', id:u, target:t})
}

/** 单单位 AI tick（stepAI 2656-2709 追击子集）：
 *  idle → 获取范围内扫描敌对最近 → attack；
 *  attack → 目标死亡回 idle；距离 > atkRange+radius 追击（目标记忆判据自动冷却），
 *  否则停（path 清空，原地打）。leash 跳过（战斗场景 home 附近）。 */
static void step_ai_unit(SimUnit* u, int id) {
  if (u->orderType == 0) {
    int best = -1; double bd = 1e18;
    for (int i = 0; i < SIM_MAX; i++) {
      SimUnit* o = &U[i];
      if (!o->alive || o == u || o->team == u->team) continue;
      const double d = hypot(o->x - u->x, o->y - u->y);
      if (d <= u->acquisitionRange && d < bd) { bd = d; best = i; }
    }
    if (best >= 0) { u->orderType = 1; u->orderTargetId = best; }
    return;
  }
  // attack
  SimUnit* t = &U[u->orderTargetId];
  if (u->orderTargetId < 0 || !t->alive) { u->orderType = 0; u->orderTargetId = -1; u->nPath = 0; return; }
  const double d = hypot(t->x - u->x, t->y - u->y);
  if (d > u->atkRange + t->radius) {
    // 追击：JS stepMove 用 routeUnit（无实体阻挡）；目标移动才重寻路（goalX 快照）
    if (u->goalX != t->x || u->goalY != t->y || u->nPath == 0) {
      if (sim_route(u, id, t->x, t->y) >= 0) { u->goalX = t->x; u->goalY = t->y; }
    }
  } else {
    u->nPath = 0;   // 在射程内：停（stepMove 2814-2832）
  }
}

/** 导弹推进（stepMissiles 2929-2957：homing 追踪、deadline 兜底、命中调 land=sim_damage）。 */
static void step_missiles(double dt) {
  const double nowMs = SIM_NOW * (1000.0 / 30.0);
  for (int i = 0; i < SIM_MISSILE_MAX; i++) {
    SimMissile* m = &M[i];
    if (!m->active) continue;
    const SimUnit* t = m->targetId >= 0 ? &U[m->targetId] : NULL;
    // 目标死亡/消失 → 无效坠落（无伤害）
    if (m->targetId >= 0 && (!t || !t->alive)) { m->active = 0; continue; }
    const double aimX = t ? t->x : m->dx, aimY = t ? t->y : m->dy;
    const double dx = aimX - m->x, dy = aimY - m->y;
    const double dist = hypot(dx, dy);
    const double travel = m->speed * dt;
    const double reach = dist - (t ? t->radius : 0);
    if (reach <= travel || nowMs > m->deadlineMs) {
      m->x = aimX; m->y = aimY;
      m->active = 0;
      ev_push(SIM_EV_MISSILE_END, m->fx, 0);   // JS emit({t:'missileEnd', fx})
      // onHit：射手存活才结算（src 阵亡则导弹空耗）
      const SimUnit* s = &U[m->srcId];
      if (s->alive && t && t->alive) sim_damage(m->srcId, m->targetId, m->amount, m->atkTypeIdx);
      continue;
    }
    m->x += (dx / dist) * travel;
    m->y += (dy / dist) * travel;
  }
}

/** 战斗 tick：导弹推进 → 每单位 AI → 移动 → 攻击（对齐 step 顺序：stepMissiles 在单位循环前）。 */
void sim_combat_step(double dt) {
  SIM_NOW++;
  step_missiles(dt);   // stepMissiles（发射发生在单位循环内，下一 tick 才动）
  for (int id = 0; id < SIM_MAX; id++) {
    SimUnit* u = &U[id];
    if (!u->alive) continue;
    step_ai_unit(u, id);         // stepAI
    step_move_unit(u, id, dt);   // stepMove
    step_attack_unit(u, dt);     // stepAttack
  }
}

/** 读战斗状态：out[6] = hp, atkTimer, attackWindupRemaining, atkCount, dmgCount, alive。 */
void sim_get_fight(int id, float* out) {
  if (id < 0 || id >= SIM_MAX) { for (int i = 0; i < 6; i++) out[i] = 0; return; }
  SimUnit* u = &U[id];
  out[0] = (float)u->hp; out[1] = (float)u->atkTimer; out[2] = (float)u->attackWindupRemaining;
  out[3] = (float)u->atkCount; out[4] = (float)u->dmgCount; out[5] = (float)u->alive;
}

// ------------------------------------------------------------------ 经济（阶段 2：stepGathers）
/** 放置经济单位：kind 0=other 1=hpea(农民) 2=ngol(金矿) 3=htow(基地)。
 *  facing/hp 供快照对账（JS 侧 hpea 420 / ngol 1250 / htow 4500，朝向随 createUnit 传入）。 */
void sim_spawn_econ(int id, double x, double y, int kind, int playerIndex, double speed, double radius,
                    double facing, double hp) {
  sim_spawn(id, x, y, facing, speed, radius, 0, 0);
  SimUnit* u = &U[id];
  u->kind = kind; u->playerIndex = playerIndex;
  u->hp = hp; u->maxHp = hp; u->team = 0;
  u->gatherPhase = 0; u->mineId = -1; u->baseId = -1; u->gatherUntilMs = 0;
}

/** 读玩家资源：gold = out[0]。 */
void sim_get_res(int playerIndex, float* out) {
  out[0] = (float)(playerIndex >= 0 && playerIndex < 16 ? GOLD[playerIndex] : 0);
}

/** 找 (cx,cy) 附近第一个可走点（JS walkSpotNear 1391-1402：16 个固定偏移探测）。 */
static int walk_spot_near(double cx, double cy, SimUnit* u, double* ox, double* oy) {
  const double offs[16][2] = {
    {-80,-80},{80,-80},{-80,80},{80,80},{0,-120},{0,120},{-120,0},{120,0},
    {-130,-130},{130,-130},{-130,130},{130,130},{0,-160},{0,160},{-160,0},{160,0},
  };
  for (int i = 0; i < 16; i++) {
    const double x = cx + offs[i][0], y = cy + offs[i][1];
    if (clear_footprint(x, y, x, y, u->radius)) { *ox = x; *oy = y; return 1; }
  }
  return 0;
}

/** 农民采集状态机（stepGathers 1342-1388 子集：hpea 且玩家 0/1；不含 SIM_NOW/移动推进，
 *  供 sim_econ_step 与 sim_step 复用）。 */
static void gather_pass(void) {
  const double nowMs = SIM_NOW * (1000.0 / 30.0);
  for (int id = 0; id < SIM_MAX; id++) {
    SimUnit* u = &U[id];
    if (!u->alive || u->kind != 1 || u->playerIndex > 1) continue;   // hpea 且玩家 0/1
    if (u->mineId >= 0) {
      const SimUnit* mine = &U[u->mineId];
      if (!mine->alive) { u->mineId = -1; u->gatherPhase = 0; continue; }
      if (u->gatherPhase == 1) {   // toMine
        if (hypot(u->x - mine->x, u->y - mine->y) < 140) {
          u->gatherPhase = 2; u->gatherUntilMs = nowMs + 1800;   // 挖矿 1.8s
          u->nPath = 0; u->orderType = 0;
        } else if (u->nPath == 0 && u->orderType == 0) {
          double sx, sy;
          if (walk_spot_near(mine->x, mine->y, u, &sx, &sy)) sim_route(u, id, sx, sy);
        }
      } else if (u->gatherPhase == 2) {   // mining
        if (nowMs >= u->gatherUntilMs) {
          int baseId = -1;
          for (int i = 0; i < SIM_MAX; i++) {
            const SimUnit* b = &U[i];
            if (b->alive && b->kind == 3 && b->playerIndex == u->playerIndex) { baseId = i; break; }
          }
          if (baseId < 0) { u->mineId = -1; u->gatherPhase = 0; continue; }
          u->gatherPhase = 3; u->baseId = baseId;
          const SimUnit* base = &U[baseId];
          double sx, sy;
          if (walk_spot_near(base->x, base->y, u, &sx, &sy)) sim_route(u, id, sx, sy);
          else u->mineId = -1;
        }
      } else if (u->gatherPhase == 3) {   // toBase
        const SimUnit* base = u->baseId >= 0 ? &U[u->baseId] : NULL;
        const int arrived = base && (hypot(u->x - base->x, u->y - base->y) < 280
          || (u->orderType == 0 && u->nPath == 0));
        if (arrived) {
          if (u->playerIndex >= 0 && u->playerIndex < 16) GOLD[u->playerIndex] += 10;
          u->gatherPhase = 1;   // 回矿继续（JS: gather = { mineId, phase: 'toMine' }）
        }
      }
    } else if (u->orderType == 0 && u->nPath == 0) {
      // 空闲农民自动找最近金矿（WC3 默认行为）
      int best = -1; double bd = 1e18;
      for (int i = 0; i < SIM_MAX; i++) {
        const SimUnit* m = &U[i];
        if (!m->alive || m->kind != 2) continue;
        const double d = hypot(m->x - u->x, m->y - u->y);
        if (d < bd) { bd = d; best = i; }
      }
      if (best >= 0) {
        u->mineId = best; u->gatherPhase = 1;
        sim_route(u, id, U[best].x, U[best].y);
      }
    }
  }
}

/** 农民采集 tick（独立入口，供 econ_test：采集状态机 + 农民移动推进）。 */
void sim_econ_step(double dt) {
  SIM_NOW++;
  gather_pass();
  for (int id = 0; id < SIM_MAX; id++) {
    SimUnit* u = &U[id];
    if (!u->alive || u->kind != 1) continue;
    step_move_unit(u, id, dt);
  }
}

/** 读事件到 out（float4 对：tick,type,a,b），返回条数。 */
int sim_events_get(float* out, int maxN) {
  const int n = EVN < maxN ? EVN : maxN;
  for (int i = 0; i < n; i++) {
    out[4 * i] = (float)EV[i].tick; out[4 * i + 1] = (float)EV[i].type;
    out[4 * i + 2] = (float)EV[i].a; out[4 * i + 3] = (float)EV[i].b;
  }
  return n;
}

// ------------------------------------------------------------------ SOA 快照（阶段 3）
// 单位属性按列布局写入 wasm 连续 buffer，供 M5「wasm heap → GPU buffer」零拷贝链路
// 与 M4 收尾「删 JS 双实现」的对账门禁。布局（全部 f32，int 直接位塞）：
//   header(5)：tick, nowMs, nUnits, nMissiles, nEvents
//   单位列（nUnits × 11，列序固定）：
//     x, y, facing, hp, maxHp, alive, team, playerIndex, kind, moving, gathering
//   玩家资源（16）：gold[0..15]
//   导弹列（nMissiles × 2）：x, y
//   事件列（nEvents × 4）：tick, type, a, b
// 返回需要的 float 总数；maxN 不足则只返回需要量、不写（调用方按返回量分配）。
#define SIM_SNAP_COLS 11
int sim_snapshot(float* buf, int maxN) {
  int nU = 0;
  for (int i = 0; i < SIM_MAX; i++) if (U[i].radius > 0) nU++;   // radius>0 = 曾放置（含死亡，对齐 JS ents 含 a:0）
  int nM = 0;
  for (int i = 0; i < SIM_MISSILE_MAX; i++) if (M[i].active) nM++;
  const int need = 5 + nU * SIM_SNAP_COLS + 16 + nM * 2 + EVN * 4;
  if (maxN < need) return need;
  int p = 0;
  // header
  buf[p++] = (float)SIM_NOW;
  buf[p++] = (float)(SIM_NOW * (1000.0 / 30.0));
  buf[p++] = (float)nU;
  buf[p++] = (float)nM;
  buf[p++] = (float)EVN;
  // 单位列（列序：x y facing hp maxHp alive team pi kind moving gathering）
  for (int c = 0; c < SIM_SNAP_COLS; c++) {
    int idx = 0;
    for (int i = 0; i < SIM_MAX; i++) {
      const SimUnit* u = &U[i];
      if (u->radius <= 0) continue;
      float v = 0;
      switch (c) {
        case 0: v = (float)u->x; break;
        case 1: v = (float)u->y; break;
        case 2: v = (float)u->facing; break;
        case 3: v = (float)u->hp; break;
        case 4: v = (float)u->maxHp; break;
        case 5: v = u->alive ? 1 : 0; break;
        case 6: v = (float)u->team; break;
        case 7: v = (float)u->playerIndex; break;
        case 8: v = (float)u->kind; break;
        case 9: v = (u->nPath > 0) ? 1 : 0; break;  // moving（有路径即在动）
        case 10: v = (u->gatherPhase != 0) ? 1 : 0; break;  // gathering
      }
      buf[p++] = v; idx++;
    }
  }
  // 玩家资源：gold[16]
  for (int i = 0; i < 16; i++) buf[p++] = (float)GOLD[i];
  // 导弹列
  for (int c = 0; c < 2; c++) {
    for (int i = 0; i < SIM_MISSILE_MAX; i++) {
      if (!M[i].active) continue;
      buf[p++] = (float)((c == 0) ? M[i].x : M[i].y);
    }
  }
  // 事件列
  for (int c = 0; c < 4; c++) {
    for (int i = 0; i < EVN; i++) {
      float v = 0;
      if (c == 0) v = (float)EV[i].tick;
      else if (c == 1) v = (float)EV[i].type;
      else if (c == 2) v = (float)EV[i].a;
      else v = (float)EV[i].b;
      buf[p++] = v;
    }
  }
  return need;
}

/** 全量 tick（M4 目标 wasm_step）：gather → missiles → 单位循环（AI/move/attack）。
 *  对齐 JS step()：stepGathers(发单) → stepMissiles → 单位循环。 */
void sim_step(double dt) {
  SIM_NOW++;
  gather_pass();
  step_missiles(dt);
  for (int id = 0; id < SIM_MAX; id++) {
    SimUnit* u = &U[id];
    if (!u->alive) continue;
    step_ai_unit(u, id);         // stepAI
    step_move_unit(u, id, dt);   // stepMove
    step_attack_unit(u, dt);     // stepAttack
  }
}