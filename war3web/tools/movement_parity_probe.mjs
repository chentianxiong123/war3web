// Read-only gameplay diagnostic. Synthetic terrain isolates movement rules;
// unit/ability definitions and simulation methods are the production ones.
import { World, TYPES } from '../server/world.js';
import { Grid } from '../server/pathing.js';
import { JassEngine } from '../server/jass/engine.js';
import { ABILS } from '../server/abilities.js';

const rows = [];
const record = (finding, actual, expected) => rows.push({ finding, actual, expected });
function fixture(type = 'H00N') {
  const w = new World(), eng = new JassEngine(w);
  const u = w.createUnit(eng.players[0], type, 0, 0, 0);
  const t = w.createUnit(eng.players[5], 'hfoo', 100, 0, 0);
  w.grid = new Grid(new Uint8Array(40 * 16).fill(1), 40, 16, 0, 0);
  Object.assign(u, { x: 80, y: 160, facing: 0, controlled: true });
  Object.assign(t, { x: 160, y: 160, controlled: true, attacksEnabled: 0,
    hp: 100000, maxHp: 100000, hpReg: 0, armor: 0, armorTotal: 0, order: { type: 'hold' } });
  u.abilities.clear(); t.abilities.clear();
  return { w, eng, u, t };
}
{
  const samples = [];
  for (const rate of [0.1, 0.9]) {
    const { w, eng, u, t } = fixture(); eng.load(); t.hidden = true;
    eng.vm.natives.get('SetUnitTurnSpeed')(u, rate);
    u.x = 640; u.path = [[320, 160]]; u.order = { type: 'move', x: 320, y: 160 };
    w.stepMove(u);
    samples.push({ requestedRate: rate, facingDegrees: u.facing * 180 / Math.PI,
      distanceMoved: +(640 - u.x).toFixed(3), runtimeTurnRate: u.turnRate ?? null });
  }
  record('Turn speed during a reversal', samples,
    `Use authored turn rate (${TYPES.H00N.turnRate}) and native changes; exact retail timing still needs measurement.`);
}
for (const state of ['paused', 'stunned', 'hold']) {
  const { w, u, t } = fixture(); u.attacksEnabled = 0;
  if (state === 'paused') t.paused = true;
  if (state === 'stunned') w.applyBuff(t, { kind: 'stun', until: 10000 });
  u.path = [[400, 160]]; u.order = { type: 'move', x: 400, y: 160 };
  let minDistance = Infinity;
  for (let i = 0; i < 60; i++) {
    w.step(); minDistance = Math.min(minDistance, Math.hypot(u.x - t.x, u.y - t.y));
  }
  record(`Collision with ${state} blocker`, { moverX: +u.x.toFixed(2), blockerX: +t.x.toFixed(2),
    minimumCenterDistance: +minDistance.toFixed(2), combinedRadius: u.radius + t.radius },
    'Movement must respect the blocker; incapacitation must not remove its pathing footprint.');
}
{
  const walk = new Uint8Array(20 * 9);
  walk.fill(1, 4 * 20, 5 * 20); // corridor only one 32-unit cell wide
  const grid = new Grid(walk, 20, 9, 0, 0);
  record('Radius clearance in a narrow corridor', {
    corridorWidth: 32, heroDiameter: TYPES.H00N.collision * 2,
    route: grid.path(48, 144, 560, 144) },
    'A 64-unit collision diameter cannot fit between blocked cells only 32 units apart.');
}
for (const order of ['attack', 'patrol']) {
  const { w, u, t } = fixture();
  t.x = 240; t.y = 400; t.paused = true;
  w.order(u, { type: order, x: 800, y: 160 });
  let attacks = 0;
  for (let i = 0; i < 120; i++) {
    attacks += w.step().filter(e => e.t === 'attack' && e.id === u.id).length;
  }
  record(`${order === 'attack' ? 'Attack-move' : 'Patrol'} past an enemy within acquisition range`,
    { attacks, order: u.order.type, targetId: u.order.targetId ?? null, enemyId: t.id },
    'Engage the reachable enemy along the route, then resume the route after combat.');
  if (order === 'patrol') {
    t.alive = false;
    for (let i = 0; i < 10; i++) w.step();
    record('Patrol resumes after target death',
      { targetId: u.order.targetId ?? null, destination: [u.order.x, u.order.y], hasPath: !!u.path?.length },
      { targetId: null, destination: [800, 160], hasPath: true });
  }
}
{
  const { w, eng, u } = fixture('hfoo');
  const flyer = w.createUnit(eng.players[5], 'ugar', 200, 160, 0);
  Object.assign(flyer, { x: u.x + 60, y: u.y, hp: 1000, maxHp: 1000, paused: true });
  const spawnHeight = flyer.flyHeight;
  // Even giving the unit its missing flight height doesn't protect it from melee.
  flyer.flyHeight = 240;
  u.dmgDice = 0; // deterministic weapon damage, independent of the audit's outcome
  w.order(u, { type: 'attack', target: flyer }); w.stepAttack(u);
  for (let i = 0; u.attackWindup && i < 120; i++) w.stepAttack(u);
  record('Footman attacking a flying Gargoyle', { spawnHeight,
    damageApplied: +(1000 - flyer.hp).toFixed(3), runtimeAllowedTargets: u.atkTargetsAllowed ?? null },
    'Gargoyle is flying; Footman has no air attack and must not damage it with its weapon.');
}
for (const state of ['allied', 'hidden', 'invulnerable']) {
  const { w, eng, u, t } = fixture(); eng.load();
  if (state === 'allied') { t.playerIndex = u.playerIndex; t.team = u.team; }
  if (state === 'hidden') t.hidden = true;
  if (state === 'invulnerable') t.invulnerable = true;
  t.paused = true;
  w.addAbility(u, 'A011'); const mana = u.mana, hp = t.hp;
  const result = w.castAbility(u, 'A011', t, t.x, t.y);
  for (let i = 0; i < 60; i++) w.step();
  record(`A011 against ${state} target`, { declaredTargets: ABILS.A011.targets,
    accepted: result.ok, damageApplied: +(hp - t.hp).toFixed(3),
    manaDelta: +(mana - u.mana).toFixed(3),
    cooldownActive: [...u.cooldowns.values()].some(until => until > w.now) },
    'Reject an ineligible target before spending resources or applying effects.');
}
console.log(JSON.stringify(rows, null, 2));
