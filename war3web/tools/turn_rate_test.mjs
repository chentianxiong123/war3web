import assert from 'node:assert/strict';
import { World, TYPES } from '../server/world.js';
import { Grid } from '../server/pathing.js';
import { JassEngine } from '../server/jass/engine.js';
let checks = 0;
const check = (v, label) => { assert.ok(v, label); checks++; };
const near = (a, b, label) => check(Math.abs(a - b) < 1e-8, `${label}: ${a} vs ${b}`);
const key = s => [...s].reduce((n, c) => (n * 256 + c.charCodeAt(0)) >>> 0, 0);
function fixture() {
  const w = new World(), e = new JassEngine(w);
  const u = w.createUnit(e.players[0], 'H00N', 400, 200, 0);
  const t = w.createUnit(e.players[5], 'hfoo', 340, 200, 0);
  w.grid = new Grid(new Uint8Array(40 * 20).fill(1), 40, 20, 0, 0);
  Object.assign(u, { x: 400, y: 200, facing: 0, controlled: true });
  Object.assign(t, { x: 340, y: 200, paused: true, hp: 10000, maxHp: 10000 });
  u.abilities.clear(); t.abilities.clear();
  return { w, e, u, t };
}
{
  const { w, u } = fixture();
  near(u.turnRate, TYPES.H00N.turnRate, 'authored rate retained');
  u.turnRate = 0.1;
  w.turnToward(u, 300, 200);
  near(u.facing, 0.1 * w.dt / 0.03, 'rate converted to simulation step');
  const facing = u.facing;
  w.turnToward(u, 300, 200); near(u.facing, facing, 'repeated calls share angular budget');
  w.now += w.dt * 1000;
  w.turnToward(u, 300, 200); near(u.facing, facing * 2, 'next tick grants new budget');
  u.facing = 179 * Math.PI / 180; w.now += 100;
  check(w.turnToward(u, u.x + Math.cos(-179 * Math.PI / 180), u.y + Math.sin(-179 * Math.PI / 180)), 'shortest turn crosses wrap');
  near(u.facing, -179 * Math.PI / 180, 'wrapped facing reaches target without overshoot');
}
{
  const times = [];
  for (const rate of [0.1, 0.9]) {
    const { w, u, t } = fixture(); t.hidden = true; u.turnRate = rate;
    u.path = [[100, 200]]; u.order = { type: 'move', x: 100, y: 200 };
    let ticks = 0;
    while (u.x === 400 && ticks < 100) { w.now += w.dt * 1000; w.stepMove(u); ticks++; }
    check(u.x < 400, 'movement resumes after turning');
    near(Math.abs(u.facing), Math.PI, 'movement faces its route');
    times.push(ticks);
  }
  check(times[0] > times[1], 'slow rate delays reversal more than fast rate');
}
{
  const { w, u, t } = fixture(); u.turnRate = 0.1;
  w.order(u, { type: 'attack', target: t }); w.stepAttack(u);
  check(!u.attackWindup && u.atkTimer === 0, 'attack does not start behind caster');
  for (let n = 0; n < 40 && !u.attackWindup; n++) { w.now += w.dt * 1000; w.stepAttack(u); }
  check(u.attackWindup, 'attack begins after facing target');
  near(t.hp, 10000, 'turning does not deliver damage');
}
{
  const { w, u, t } = fixture(); u.turnRate = 0.1;
  u.abilities.set(key('AHtb'), 1); u.mana = 500;
  check(w.castAbility(u, 'AHtb', t).ok, 'spell order accepted behind caster');
  check(u.cast.phase === 'approach', 'spell waits for facing before cast point');
  near(u.mana, 500, 'turning does not spend mana');
  check(!u.cooldowns.size, 'turning does not start cooldown');
  for (let n = 0; n < 40 && u.cast.phase === 'approach'; n++) { w.now += w.dt * 1000; w.stepCast(u); }
  check(u.cast.phase === 'casting', 'cast point begins after facing');
  near(u.cast.effectAt - w.now, u.castPoint * 1000, 'full cast point follows turn');
}
{
  const { w, e, u } = fixture(); e.load();
  const native = n => e.vm.natives.get(n);
  native('SetUnitTurnSpeed')(u, 0.2); near(native('GetUnitTurnSpeed')(u), 0.2, 'native reads and writes rate');
  native('SetUnitTurnSpeed')(u, NaN); near(u.turnRate, 0.2, 'invalid input does not poison facing');
  w.morph(u, 'O000', 10); near(u.turnRate, TYPES.O000.turnRate, 'morph uses alternate rate');
  w.unmorph(u); near(u.turnRate, 0.2, 'unmorph restores native-modified rate');
  u.paused = true; check(!w.turnToward(u, 300, 200), 'paused unit cannot turn'); near(u.facing, 0, 'paused facing stable');
  u.paused = false; w.applyBuff(u, { kind: 'stun', until: w.now + 1000 });
  check(!w.turnToward(u, 300, 200), 'stunned unit cannot turn');
  u.buffs = []; native('SetUnitTurnSpeed')(u, 0);
  check(!w.turnToward(u, 300, 200), 'zero rate does not snap');
  native('SetUnitFacing')(u, 180); near(u.facing, Math.PI, 'existing explicit facing native remains independent');
}
console.log(`${checks} turn-rate checks passed`);
