import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { Grid } from '../server/pathing.js';
import { JassEngine } from '../server/jass/engine.js';

let checks = 0;
const check = (ok, label) => { assert.ok(ok, label); checks++; };
function fixture() {
  const w = new World(), eng = new JassEngine(w);
  const u = w.createUnit(eng.players[0], 'H00N', 0, 0, 0);
  const t = w.createUnit(eng.players[5], 'hfoo', 100, 0, 0);
  w.grid = new Grid(new Uint8Array(40 * 16).fill(1), 40, 16, 0, 0);
  for (const v of [u, t]) {
    v.abilities.clear(); v.controlled = true; v.attacksEnabled = 0;
    v.hp = v.maxHp = 100000; v.hpReg = 0;
    v.order = { type: 'hold' };
  }
  Object.assign(u, { x: 80, y: 160 }); Object.assign(t, { x: 160, y: 160 });
  return { w, eng, u, t };
}
const move = (u, x = 400, y = 160) => {
  u.order = { type: 'move', x, y }; u.path = [[x, y]];
};
for (const state of ['hold', 'paused', 'stunned']) {
  const { w, u, t } = fixture();
  if (state === 'paused') t.paused = true;
  if (state === 'stunned') w.applyBuff(t, { kind: 'stun', until: 10000 });
  move(u);
  let minimum = Infinity, detoured = false;
  for (let i = 0; i < 120; i++) {
    w.step(); minimum = Math.min(minimum, Math.hypot(u.x - t.x, u.y - t.y));
    detoured ||= Math.abs(u.y - 160) > 30;
  }
  check(minimum >= u.radius + t.radius - 1e-6, `${state}: no overlap`);
  check(t.x === 160 && t.y === 160, `${state}: blocker was not pushed`);
  check(u.x >= 390 && detoured, `${state}: mover goes around and reaches destination`);
}
for (const state of ['dead', 'hidden', 'pathingOff']) {
  const { w, u, t } = fixture();
  if (state === 'dead') t.alive = false; else t[state] = true;
  move(u);
  let detoured = false;
  for (let i = 0; i < 60; i++) { w.step(); detoured ||= u.y !== 160; }
  check(u.x === 400 && !detoured, `${state} does not block`);
}
{
  const { w, u, t } = fixture(); u.pathingOff = true; move(u);
  for (let i = 0; i < 60; i++) w.step();
  check(u.x === 400 && u.y === 160, 'pathing-disabled mover passes through units');
}
{
  const { w, u } = fixture(); u.moveSpeed = 30000; move(u);
  w.stepMove(u);
  check(u.x === 80, 'fast movement cannot tunnel through a blocker');
}
{
  const { w, u, t } = fixture();
  u.radius = t.radius = 4; t.x = 90;
  move(u, 100, 160); u.moveSpeed = 3000; w.stepMove(u);
  check(u.x === 80, 'the final waypoint step also checks swept collision');
}
{
  const { w, u, t } = fixture();
  t.x = 600; move(u);
  for (let i = 0; i < 5; i++) w.step();
  t.x = u.x + 80;
  const blockerX = t.x;
  let minimum = Infinity;
  for (let i = 0; i < 120; i++) {
    w.step(); minimum = Math.min(minimum, Math.hypot(u.x - t.x, u.y - t.y));
  }
  check(minimum >= u.radius + t.radius - 1e-6, 'new blocker invalidates old clear path');
  check(u.x >= 390 && t.x === blockerX, 'replans around newly occupied route');
}
{
  const { w, eng, u, t } = fixture();
  u.x = 320; u.y = 256; u.radius = 32;
  const ring = [t];
  for (let i = 0; i < 3; i++) ring.push(w.createUnit(eng.players[5], 'hfoo', 900, 400, 0));
  [[384, 256], [256, 256], [320, 320], [320, 192]].forEach(([x, y], i) =>
    Object.assign(ring[i], { x, y, radius: 32, paused: true, attacksEnabled: 0 }));
  move(u, 700, 256);
  for (let i = 0; i < 60; i++) w.step();
  check(Math.hypot(u.x - 320, u.y - 256) < 1, 'closed surround holds');
  ring[0].alive = false;
  for (let i = 0; i < 120; i++) w.step();
  check(u.x > 650, 'opening the surround lets movement resume');
}
for (const order of ['attack', 'patrol']) {
  const { w, u, t } = fixture(); u.attacksEnabled = 1;
  t.x = 240; t.y = 400; t.paused = true;
  w.order(u, { type: order, x: 800, y: 160 });
  let hits = 0;
  for (let i = 0; i < 120; i++) hits += w.step().filter(e => e.t === 'attack' && e.id === u.id).length;
  check(hits > 0, `${order}: acquires and fights outside initial weapon range`);
  check(u.order.x === 800 && u.order.y === 160, `${order}: preserves destination during chase`);
  t.alive = false;
  for (let i = 0; i < 90; i++) w.step();
  if (order === 'attack') check(u.order.type === 'idle' && Math.hypot(u.x - 800, u.y - 160) < 32,
    'attack-move finishes at its destination');
  else check(u.order.type === 'patrol' && !u.order.targetId,
    'patrol resumes its route after combat');
}
{
  const { w, u, t } = fixture(); u.attacksEnabled = 1; t.invulnerable = true;
  w.order(u, { type: 'attack', x: 800, y: 160 });
  let attacks = 0;
  for (let i = 0; i < 30; i++) attacks += w.step().filter(e => e.t === 'attack' && e.id === u.id).length;
  check(!u.order.targetId && attacks === 0, 'attack-move skips invulnerable enemies');
}
{
  const { w, u, t } = fixture(); u.attacksEnabled = 1;
  w.order(u, { type: 'move', x: 800, y: 160 });
  let attacks = 0;
  for (let i = 0; i < 30; i++) attacks += w.step().filter(e => e.t === 'attack' && e.id === u.id).length;
  check(attacks === 0 && u.order.type === 'move', 'ordinary Move remains non-combat');
}
console.log(`${checks}/${checks} checks passed`);
