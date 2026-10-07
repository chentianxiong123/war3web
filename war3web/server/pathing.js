// Grid pathing over the map's own war3map.wpm walkability data.
import { PATH_CELL } from '../shared/const.js';

export class Grid {
  constructor(walk, w, h, originX, originY) {
    this.walk = walk; this.w = w; this.h = h;
    this.originX = originX; this.originY = originY;
  }
  toCell(x, y) {
    return [Math.floor((x - this.originX) / PATH_CELL),
            Math.floor((y - this.originY) / PATH_CELL)];
  }
  toWorld(cx, cy) {
    return [this.originX + (cx + 0.5) * PATH_CELL,
            this.originY + (cy + 0.5) * PATH_CELL];
  }
  inside(cx, cy) { return cx >= 0 && cy >= 0 && cx < this.w && cy < this.h; }
  walkable(cx, cy) { return this.inside(cx, cy) && this.walk[cy * this.w + cx] === 1; }
  walkableAt(x, y) { const [cx, cy] = this.toCell(x, y); return this.walkable(cx, cy); }

  /** Terrain regions ignore bodies and radii: different regions prove that no
   * route exists; the normal clearance search still decides same-region paths.
   * Call invalidate() after changing walkability (for example, a destroyed gate). */
  invalidate() { this.regions = null; }
  connected(start, goal) {
    if (!this.regions) {
      const size = this.w * this.h, regions = new Int32Array(size), queue = new Int32Array(size);
      let region = 0;
      for (let i = 0; i < size; i++) {
        if (regions[i] || this.walk[i] !== 1) continue;
        let head = 0, tail = 0; queue[tail++] = i; regions[i] = ++region;
        while (head < tail) {
          const cur = queue[head++], x = cur % this.w;
          const visit = next => {
            if (next < 0 || next >= size || regions[next] || this.walk[next] !== 1) return;
            regions[next] = region; queue[tail++] = next;
          };
          if (x > 0) visit(cur - 1);
          if (x + 1 < this.w) visit(cur + 1);
          visit(cur - this.w); visit(cur + this.w);
        }
      }
      this.regions = regions;
    }
    return this.regions[start] === this.regions[goal];
  }

  /** Exact swept disk clearance against blocked cells and map bounds. */
  clearFootprint(x0, y0, x1, y1, radius = 0) {
    const r = Math.max(0, radius), dx = x1 - x0, dy = y1 - y0;
    if (Math.min(x0, x1) - r < this.originX || Math.min(y0, y1) - r < this.originY ||
        Math.max(x0, x1) + r > this.originX + this.w * PATH_CELL ||
        Math.max(y0, y1) + r > this.originY + this.h * PATH_CELL) return false;
    const [left, bottom] = this.toCell(Math.min(x0, x1) - r, Math.min(y0, y1) - r);
    const [right, top] = this.toCell(Math.max(x0, x1) + r, Math.max(y0, y1) + r);
    const len2 = dx * dx + dy * dy;
    // Scan the swept segment's band, not its entire bounding rectangle.
    // A long diagonal used to visit O(length²) cells even in open terrain.
    for (let cy = bottom; cy <= top; cy++) {
      let start = 0, end = 1;
      if (dy !== 0) {
        const a = (this.originY + cy * PATH_CELL - r - y0) / dy;
        const b = (this.originY + (cy + 1) * PATH_CELL + r - y0) / dy;
        start = Math.max(0, Math.min(a, b)); end = Math.min(1, Math.max(a, b));
        if (start > end) continue;
      }
      const a = x0 + dx * start, b = x0 + dx * end;
      const rowLeft = Math.max(left, Math.floor((Math.min(a, b) - r - this.originX) / PATH_CELL));
      const rowRight = Math.min(right, Math.floor((Math.max(a, b) + r - this.originX) / PATH_CELL));
      for (let cx = rowLeft; cx <= rowRight; cx++) {
        if (this.walkable(cx, cy)) continue;
        const ax = this.originX + cx * PATH_CELL, ay = this.originY + cy * PATH_CELL;
        const bx = ax + PATH_CELL, by = ay + PATH_CELL;
        let lo = 0, hi = 1;
        for (const [p, d, a, b] of [[x0, dx, ax, bx], [y0, dy, ay, by]]) {
          if (d === 0) { if (p < a || p > b) hi = -1; }
          else { const t0 = (a - p) / d, t1 = (b - p) / d;
            lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1)); }
        }
        if (lo <= hi) return false;
        const pointRect = (x, y) => Math.max(ax - x, 0, x - bx) ** 2 + Math.max(ay - y, 0, y - by) ** 2;
        let distance2 = Math.min(pointRect(x0, y0), pointRect(x1, y1));
        for (const [x, y] of [[ax, ay], [ax, by], [bx, ay], [bx, by]]) {
          const t = len2 ? Math.max(0, Math.min(1, ((x - x0) * dx + (y - y0) * dy) / len2)) : 0;
          distance2 = Math.min(distance2, (x - x0 - dx * t) ** 2 + (y - y0 - dy * t) ** 2);
        }
        if (distance2 < r * r - 1e-6) return false;
      }
    }
    return true;
  }

  /** Nearest walkable cell to a world point (bounded spiral search). */
  nearestWalkable(x, y, maxR = 24, pass = null) {
    const passable = (cx, cy) => this.walkable(cx, cy) && (!pass || pass(...this.toWorld(cx, cy)));
    let [cx, cy] = this.toCell(x, y);
    if (passable(cx, cy)) return [cx, cy];
    for (let r = 1; r <= maxR; r++) {
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (passable(cx + dx, cy + dy)) return [cx + dx, cy + dy];
      }
    }
    return null;
  }

  /** A* returning a list of world-space waypoints, or null. */
  path(sx, sy, tx, ty, limit = 20000, pass = null, radius = 0) {
    const occupancy = pass;
    pass = (x, y) => this.clearFootprint(x, y, x, y, radius) && (!occupancy || occupancy(x, y));
    // Clearance and dynamic occupancy are immutable during a synchronous search.
    const checked = new Uint8Array(this.w * this.h);
    const passable = (cx, cy) => {
      if (!this.walkable(cx, cy)) return false;
      const i = cy * this.w + cx;
      if (!checked[i]) checked[i] = pass(...this.toWorld(cx, cy)) ? 1 : 2;
      return checked[i] === 1;
    };
    const s = this.nearestWalkable(sx, sy, 24, pass), t = this.nearestWalkable(tx, ty, 24, pass);
    if (!s || !t) return null;
    const [s0, s1] = s, [t0, t1] = t;
    if (s0 === t0 && s1 === t1) return [this.toWorld(t0, t1)];
    const W = this.w, N = W * this.h;
    const start = s1 * W + s0, goal = t1 * W + t0;
    if (!this.connected(start, goal)) return null;
    const g = new Float32Array(N).fill(Infinity);
    const f = new Float32Array(N).fill(Infinity);
    const from = new Int32Array(N).fill(-1);
    const open = [];
    const positions = new Int32Array(N).fill(-1);
    const less = (a, b) => f[a] < f[b] || (f[a] === f[b] && a < b);
    const rise = i => {
      const node = open[i];
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (!less(node, open[parent])) break;
        open[i] = open[parent]; positions[open[i]] = i; i = parent;
      }
      open[i] = node; positions[node] = i;
    };
    const pop = () => {
      const first = open[0], last = open.pop(); positions[first] = -1;
      if (open.length) {
        let i = 0;
        while (i * 2 + 1 < open.length) {
          let child = i * 2 + 1;
          if (child + 1 < open.length && less(open[child + 1], open[child])) child++;
          if (!less(open[child], last)) break;
          open[i] = open[child]; positions[open[i]] = i; i = child;
        }
        open[i] = last; positions[last] = i;
      }
      return first;
    };
    const closed = new Uint8Array(N);
    const hx = (i) => { const x = i % W, y = (i - x) / W;
      const dx = Math.abs(x - t0), dy = Math.abs(y - t1);
      return (dx + dy) + (Math.SQRT2 - 2) * Math.min(dx, dy); };
    g[start] = 0; f[start] = hx(start); open.push(start); positions[start] = 0;
    let expanded = 0;
    while (open.length) {
      const cur = pop();
      if (cur === goal) return this._trace(from, cur, occupancy, radius);
      closed[cur] = 1;
      if (++expanded > limit) break;
      const cx = cur % W, cy = (cur - cx) / W;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = cx + dx, ny = cy + dy;
        if (!this.inside(nx, ny)) continue;
        const ni = ny * W + nx;
        if (closed[ni] || !passable(nx, ny)) continue;
        if (dx && dy && (!passable(cx + dx, cy) || !passable(cx, cy + dy))) continue;
        if (!this.clearFootprint(...this.toWorld(cx, cy), ...this.toWorld(nx, ny), radius)) continue;
        const ng = g[cur] + (dx && dy ? Math.SQRT2 : 1);
        if (ng < g[ni]) {
          g[ni] = ng; from[ni] = cur; f[ni] = ng + hx(ni);
          if (positions[ni] < 0) { positions[ni] = open.length; open.push(ni); }
          rise(positions[ni]);
        }
      }
    }
    return null;
  }
  _trace(from, cur, pass = null, radius = 0) {
    const cells = [];
    while (cur !== -1) { cells.push(cur); cur = from[cur]; }
    cells.reverse();
    // string-pull: drop waypoints that are collinear / directly reachable
    const W = this.w;
    const pts = cells.map((i) => { const x = i % W; return this.toWorld(x, (i - x) / W); });
    const out = [pts[0]];
    let anchor = 0;
    for (let i = 2; i < pts.length; i++) {
      if (!this.clearLine(pts[anchor][0], pts[anchor][1], pts[i][0], pts[i][1], pass, radius)) {
        out.push(pts[i - 1]); anchor = i - 1;
      }
    }
    out.push(pts[pts.length - 1]);
    return out.slice(1);
  }
  clearLine(x0, y0, x1, y1, pass = null, radius = 0) {
    if (!this.clearFootprint(x0, y0, x1, y1, radius)) return false;
    const d = Math.hypot(x1 - x0, y1 - y0);
    const steps = Math.ceil(d / (PATH_CELL * 0.5));
    for (let i = 0; i <= steps; i++) {
      const t = steps ? i / steps : 0;
      const x = x0 + (x1 - x0) * t, y = y0 + (y1 - y0) * t;
      if (!this.walkableAt(x, y) || (pass && !pass(x, y))) return false;
    }
    return true;
  }
}
