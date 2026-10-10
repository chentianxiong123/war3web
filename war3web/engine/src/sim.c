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

#define SIM_PCELL 32.0                 // PATH_CELL（shared/const.js）
#define SIM_SQRT2 1.4142135623730951   // Math.SQRT2

static const uint8_t* W;               // walk 数据（0/1）
static int GW, GH;
static double OX, OY;

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

/** 最近可行走格（有界螺旋搜索，pass = 半径足迹检查，对齐 JS pathing pass）。 */
static void nearest_walkable(double x, double y, int maxR, double radius, int* ocx, int* ocy) {
  int cx = (int)floor((x - OX) / SIM_PCELL), cy = (int)floor((y - OY) / SIM_PCELL);
  if (walkable(cx, cy)) {
    double pwx = OX + (cx + 0.5) * SIM_PCELL, pwy = OY + (cy + 0.5) * SIM_PCELL;
    if (clear_footprint(pwx, pwy, pwx, pwy, radius)) { *ocx = cx; *ocy = cy; return; }
  }
  for (int r = 1; r <= maxR; r++)
    for (int dx = -r; dx <= r; dx++)
      for (int dy = -r; dy <= r; dy++) {
        if (fmax(abs(dx), abs(dy)) != r) continue;
        if (walkable(cx + dx, cy + dy)) {
          double pwx = OX + (cx + dx + 0.5) * SIM_PCELL, pwy = OY + (cy + dy + 0.5) * SIM_PCELL;
          if (clear_footprint(pwx, pwy, pwx, pwy, radius)) { *ocx = cx + dx; *ocy = cy + dy; return; }
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
static double* g; static double* f; static int* from;

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
  g = (double*)malloc(sizeof(double) * (size_t)N);
  f = (double*)malloc(sizeof(double) * (size_t)N);
  from = (int*)malloc(sizeof(int) * (size_t)N);
  hpos = (int*)malloc(sizeof(int) * (size_t)N);
  uint8_t* closed = (uint8_t*)calloc((size_t)N, 1);
  heap = NULL; heapLen = 0; heapCap = 0;
  for (int i = 0; i < N; i++) { g[i] = INFINITY; f[i] = INFINITY; from[i] = -1; hpos[i] = -1; }
  g[start] = 0; f[start] = hx(start, t0, t1); heap_push(start);
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
      if (dx && dy && (!walkable(cx + dx, cy) || !walkable(cx, cy + dy))) continue;
      const double pwx0 = OX + (cx + 0.5) * SIM_PCELL, pwy0 = OY + (cy + 0.5) * SIM_PCELL;
      const double pwx1 = OX + (nx + 0.5) * SIM_PCELL, pwy1 = OY + (ny + 0.5) * SIM_PCELL;
      if (!clear_footprint(pwx0, pwy0, pwx1, pwy1, radius)) continue;
      const double ng = g[cur] + (dx && dy ? SIM_SQRT2 : 1);
      if (ng < g[ni]) {
        g[ni] = ng; from[ni] = cur; f[ni] = ng + hx(ni, t0, t1);
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