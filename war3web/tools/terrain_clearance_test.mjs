import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Grid } from '../server/pathing.js';
import { World } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';
let checks = 0;
const check = (value, label) => { assert.ok(value, label); checks++; };
const open = (w = 20, h = 12) => new Grid(new Uint8Array(w * h).fill(1), w, h, 0, 0);
{
  const grid = open();
  for (let y = 0; y < grid.h; y++) if (y !== 5) grid.walk[y * grid.w + 10] = 0;
  check(grid.path(80, 176, 560, 176, 20000, null, 8), 'small unit fits one-cell opening');
  check(!grid.path(80, 176, 560, 176, 20000, null, 32), 'large unit cannot fit opening');
  check(!grid.clearFootprint(80, 176, 560, 176, 32), 'swept body cannot fit opening');
  grid.walk[4 * grid.w + 10] = 1; grid.walk[6 * grid.w + 10] = 1;
  const route = grid.path(80, 176, 560, 176, 20000, null, 32);
  check(route, 'wide opening permits hero');
  let p = [80, 176];
  for (const next of route) { check(grid.clearFootprint(...p, ...next, 32), 'smoothed segment clears terrain'); p = next; }
}
{
  const grid = open(); grid.walk[5 * grid.w + 10] = 0;
  check(!grid.clearFootprint(100, 176, 600, 176, 4), 'fast movement cannot tunnel through one blocked cell');
  check(!grid.clearFootprint(300, 140, 340, 140, 24), 'body clips obstacle even when center is clear');
  check(grid.clearFootprint(300, 130, 340, 130, 24), 'body clears obstacle with enough margin');
  check(!grid.clearFootprint(16, 100, 16, 200, 32), 'footprint stays inside map bounds');
  const route = grid.path(80, 176, 560, 176, 20000, null, 32);
  check(route && route.some(p => p[1] !== 176), 'route detours around footprint');
  let p = [80, 176];
  for (const next of route) { check(grid.clearFootprint(...p, ...next, 32), 'detour smoothing preserves clearance'); p = next; }
}
{
  const w = new World(), e = new JassEngine(w);
  const u = w.createUnit(e.players[0], 'ugar', 80, 176, 0);
  const t = w.createUnit(e.players[5], 'hfoo', 160, 176, 0);
  w.grid = open(); w.flyGrid = open();
  Object.assign(u, { x: 80, y: 176, radius: 24, moveSpeed: 30000 });
  Object.assign(t, { x: 160, y: 176, radius: 24 });
  for (let y = 0; y < 12; y++) w.grid.walk[y * 20 + 10] = 0;
  check(w.routeUnit(u, 560, 176), 'flyer routes over ground wall');
  check(w.canAdvance(u, 560, 176, w.movementBlockers(u)), 'flyer crosses ground wall and ground body');
  t.movementType = 'fly';
  check(!w.canAdvance(u, 560, 176, w.movementBlockers(u)), 'air body blocks air movement');
  t.hidden = true;
  for (let y = 0; y < 12; y++) w.flyGrid.walk[y * 20 + 10] = 0;
  check(!w.routeUnit(u, 560, 176), 'no-fly wall blocks flight route');
  u.order = { type: 'move', x: 560, y: 176 }; u.path = [[560, 176]];
  w.stepMove(u); check(u.x === 80, 'stale flight route cannot tunnel through no-fly wall');
  u.movementType = 'foot'; u.flyHeight = 240;
  check(!w.routeUnit(u, 560, 176), 'lifted ground unit still obeys ground terrain');
}
{
  const raw = JSON.parse(fs.readFileSync('data/pathing.json'));
  const fly = fs.readFileSync('public/data/fly.bin');
  const stamps = JSON.parse(fs.readFileSync('public/data/flydestructables.json'));
  const claimed = new Set(stamps.flatMap(s => s.c));
  check(fly.length === raw.width * raw.height, 'flight grid dimensions');
  check([...fly].every((v, i) => v === (!(raw.cells[i] & 4) && !claimed.has(i) ? 1 : 0)), 'flight grid preserves terrain flags and destructable stamps');
  check(claimed.size > 0, 'map includes destructable flight blockers');
}
{
  const w = new World();
  const raw = JSON.parse(fs.readFileSync('data/pathing.json'));
  const stamps = JSON.parse(fs.readFileSync('public/data/flydestructables.json'));
  const stamp = stamps.find(s => s.w.length && s.hp > 0);
  check(stamp, 'destructable flight blocker fixture exists');
  const dest = [...w.dests.values()].find(d => d.index === stamp.d);
  w.killDest(dest, null);
  const claimed = new Set(stamps.flatMap(s => s.d === stamp.d ? s.k || [] : s.c));
  check([...w.fly].every((v, i) => v === (!(raw.cells[i] & 4) && !claimed.has(i) ? 1 : 0)),
    'destroyed flight blocker preserves terrain and overlapping/death footprints');
}
console.log(`${checks} terrain and flight checks passed`);
