// Do the map's walls and gates actually stop anything?
//
// war3map.wpm is the *terrain's* pathing, and the World Editor bakes ordinary
// doodads into it -- the city low walls read 202, no-walk, straight from the
// file. Destructables are not baked in, because Warcraft III stamps their
// footprint at runtime and lifts it again when they die. So the 58 stone walls,
// all six gates and the trees read 64 or 72 -- walkable -- and were walked
// straight through.
//
// The footprint is a TGA named per type in pathTex, one pixel per 32-unit
// pathing cell, flags in the colour channels: red unwalkable, green unflyable,
// blue unbuildable. StoneWall1Path is a 10x2 bar, Gate2Path a 22x22 diagonal.
//
// Two things are asserted, and the second matters as much as the first: the
// walls block, and the map is still connected. Stamping too much would seal a
// base or a lane and there would be no game.
//
//   node tools/pathblock_test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { Grid } from '../server/pathing.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const terr = read('data/terrain.json');
const pathing = read('data/pathing.json');
const doodads = read('public/data/doodads.json');
const game = read('data/game.json');
const W = pathing.width, H = pathing.height;
const walk = new Uint8Array(fs.readFileSync(path.join(ROOT, 'public/data/walk.bin')));
const raw = pathing.cells;                    // the terrain's own pathing, unstamped
const OX = terr.offsetX, OY = terr.offsetY, PC = 32;

const grid = new Grid(walk, W, H, terr.offsetX, terr.offsetY);

const cellOf = (x, y) => [Math.floor((x - OX) / PC), Math.floor((y - OY) / PC)];
const walkable = (x, y) => {
  const [cx, cy] = cellOf(x, y);
  return cx >= 0 && cy >= 0 && cx < W && cy < H ? walk[cy * W + cx] === 1 : null;
};
const rawWalkable = (x, y) => {
  const [cx, cy] = cellOf(x, y);
  return cx >= 0 && cy >= 0 && cx < W && cy < H ? (raw[cy * W + cx] & 0x02) === 0 : null;
};

check('walk.bin matches the pathing grid', walk.length === W * H, `${walk.length} vs ${W * H}`);

// ---- the walls and every gate must block
const GATES = ['YTcx', 'LTe4', 'DTg6', 'LTg2', 'ATg4'];
const WALLS = ['LTw0', 'LTw1', 'LTw2', 'LTw3'];
const centresOf = (ids) => doodads.filter((d) => ids.includes(d.id));

const gates = centresOf(GATES);
check('all six gates are placed', gates.length === 6, `${gates.length}`);
check('every gate blocks', gates.every((d) => walkable(d.x, d.y) === false),
      gates.map((d) => `${d.id}:${walkable(d.x, d.y) === false ? 'blocked' : 'OPEN'}`).join(' '));

const walls = centresOf(WALLS);
check('the stone walls are placed', walls.length > 40, `${walls.length}`);
check('every stone wall blocks', walls.every((d) => walkable(d.x, d.y) === false),
      `${walls.filter((d) => walkable(d.x, d.y) === false).length}/${walls.length}`);

// the terrain alone did NOT block them -- this is what the stamping added
const wasOpen = [...gates, ...walls].filter((d) => rawWalkable(d.x, d.y) === true);
check('the map file alone left them walkable', wasOpen.length > 0,
      `${wasOpen.length} of ${gates.length + walls.length} were open in war3map.wpm`);

// ---- and the map is still one connected space
const start = game.spawns.find((s) => typeof s.x === 'number');
const [sx0, sy0] = cellOf(start.x, start.y);
function flood(grid) {
  const seen = new Uint8Array(W * H);
  let sx = sx0, sy = sy0;
  if (!grid(sx, sy)) {
    outer: for (let r = 1; r < 24; r++)
      for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        if (grid(sx + dx, sy + dy)) { sx += dx; sy += dy; break outer; }
      }
  }
  const q = [[sx, sy]]; seen[sy * W + sx] = 1;
  let n = 1;
  while (q.length) {
    const [cx, cy] = q.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      if (seen[ny * W + nx] || !grid(nx, ny)) continue;
      seen[ny * W + nx] = 1; n++; q.push([nx, ny]);
    }
  }
  return { seen, n };
}
const idx = (cx, cy) => (cx >= 0 && cy >= 0 && cx < W && cy < H);

// A closed gate is *supposed* to seal what is behind it -- that is what a gate
// is, and this map's script never opens one, so the six of them cut the creep
// ground off from the arena until something destroys them. The invariant that
// still has to hold is about the walls: they may not seal anything. Flood with
// the gates' own footprints lifted, which is exactly what their death will do.
const stamps = read('public/data/destructables.json');
const open = new Uint8Array(walk);
// exactly what killing them frees: the cells the bare terrain allows, less the
// posts pathTexDeath leaves standing, less anything another destructable still
// claims -- the same arithmetic World.killDest does
const gateCells = new Set();
for (const st of stamps) {
  if (!GATES.includes(st.id)) continue;
  const posts = new Set(st.k || []);
  for (const c of st.w) if (!posts.has(c)) gateCells.add(c);
}
for (const st of stamps) if (!GATES.includes(st.id)) for (const c of st.c) gateCells.delete(c);
for (const c of gateCells) open[c] = 1;

const before = flood((cx, cy) => idx(cx, cy) && (raw[cy * W + cx] & 0x02) === 0);
const gatesOpen = flood((cx, cy) => idx(cx, cy) && open[cy * W + cx] === 1);
const now = flood((cx, cy) => idx(cx, cy) && walk[cy * W + cx] === 1);

check('the walls seal nothing once the gates are down',
      gatesOpen.n > before.n * 0.95,
      `${gatesOpen.n} reachable of ${before.n} on the terrain alone ` +
      `(${(100 * gatesOpen.n / before.n).toFixed(1)}%)`);

// and the arena itself -- the fountain at the centre and the shops at either
// edge -- must stay reachable with every gate shut, or there is no game to play
const landmarks = game.spawns.filter((s) => typeof s.x === 'number' &&
  (s.id === 'nfoh' || Math.abs(s.x) > 3900));
const cut = landmarks.filter((s) => {
  const [cx, cy] = cellOf(s.x, s.y);
  return !(idx(cx, cy) && now.seen[cy * W + cx]);
});
check('the fountain and the shops stay reachable with the gates shut',
      landmarks.length > 4 && cut.length === 0,
      `${landmarks.length - cut.length}/${landmarks.length} reachable`);

check('the closed gates do cut something off', now.n < gatesOpen.n * 0.95,
      `${gatesOpen.n} reachable open, ${now.n} shut`);

// ---- and a wall has to be a wall, not a row of stubs
//
// Blocking a placement's centre is not the same as blocking the wall: the
// footprint is stamped at the doodad's rotation, and measured from the wrong
// zero every bar came out a quarter turn off -- an east-west bar through a
// north-south wall. Each centre blocked, so the checks above passed, and there
// was an eight-cell hole between every wall and the next one to walk through.
//
// Measured, not asserted from the shape: at each placement, take the first open
// cell either side, skip the pairs that are not separated at all, and path
// between the rest. Going round a real wall is a long way; slipping through a
// hole between two of them is barely a detour. The bad data gave 17 crossings
// under 3x, most of them 1.2x.
const BLOCKERS = [...GATES, ...WALLS];
let crossings = 0;
const shortcuts = [];
for (const d of doodads) {
  if (!BLOCKERS.includes(d.id)) continue;
  for (const [ux, uy] of [[1, 0], [0, 1]]) {
    let a = null, b = null;
    for (let o = 64; o <= 512; o += 32)
      if (walkable(d.x - ux * o, d.y - uy * o)) { a = [d.x - ux * o, d.y - uy * o]; break; }
    for (let o = 64; o <= 512; o += 32)
      if (walkable(d.x + ux * o, d.y + uy * o)) { b = [d.x + ux * o, d.y + uy * o]; break; }
    if (!a || !b || grid.clearLine(a[0], a[1], b[0], b[1])) continue;
    crossings++;
    const route = grid.path(a[0], a[1], b[0], b[1]);
    const straight = Math.hypot(b[0] - a[0], b[1] - a[1]);
    let len = 0, px = a[0], py = a[1];
    for (const [x, y] of route || []) { len += Math.hypot(x - px, y - py); px = x; py = y; }
    const ratio = route ? len / straight : Infinity;
    if (ratio < 3) shortcuts.push(`${d.id} ${d.x},${d.y} x${ratio.toFixed(1)}`);
  }
}
check('there are crossings to measure', crossings > 40, `${crossings}`);
check('no wall can be slipped through', shortcuts.length === 0,
      shortcuts.slice(0, 6).join(' ') || `${crossings} crossings, none under 3x`);

const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} checks passed`);
process.exit(bad ? 1 : 0);
