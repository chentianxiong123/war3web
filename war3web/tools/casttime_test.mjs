// The cast timeline: a spell is an order with phases, not a function call.
//
// Warcraft III's five spell events mark moments the map's own triggers wait
// on: five arm on CHANNEL and spawn ritual dummies, six clean up on ENDCAST,
// A022 hides its caster on FINISH.  Fired back to back, the cleanup landed
// before the ritual and Luffy's 고무고무 바람개비 threw its target for 500 x 0.
// Each check below is one of the map's expectations, read off its script:
//
//   - the effect lands at the unit's cast point (UnitWeapons.slk castpt),
//     and mana and cooldown go with it, not with the order
//   - a target out of range is walked to before anything fires
//   - an ability with a Casting Time fires EFFECT that long after CHANNEL --
//     A01G's own CHANNEL trigger waits BO(3.) against its acas of 3.0 -- and
//     an interrupt before then is ENDCAST alone, with nothing spent
//   - a channelled spell holds ENDCAST until the channel is over, and the
//     map's own spin loop for A04X gets its three turns in
//   - a stun, a new order or death breaks a channel off with ENDCAST
//
//   node tools/casttime_test.mjs        (no server needed)
import { World, id2int, int2id } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';
import { entry, levelInfo } from '../server/abilities.js';
import { testHeroes } from './testheroes.mjs';

const fails = [];
let pass = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok    ${name}${detail ? '  -- ' + detail : ''}`); }
  else { fails.push(name); console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
};

const world = new World();
const eng = new JassEngine(world);
eng.load();
eng.boot();
const STEP = 1000 / 30;
const tick = (secs) => { for (let i = 0; i < Math.round(secs * 30); i++) { eng.update(STEP); world.step(); } };
tick(2);

const { caster, target } = testHeroes();
const A = world.sellUnit(world.tavernFor(caster.id), eng.players[0], caster.id);
const B = world.sellUnit(world.tavernFor(target.id), eng.players[5], target.id);
if (!A || !B) { console.log('  FAIL  could not seat two heroes'); process.exit(1); }
B.maxHp = B.hp = 1e6;
A.mana = A.maxMana = 5000;

// every spell event the world fires, in order, with the time it fired at
const log = [];
const fire = world.fireSpellEvent.bind(world);
world.fireSpellEvent = (name, ctx) => {
  log.push({ ev: name.replace('EVENT_PLAYER_UNIT_SPELL_', ''), t: world.now, id: int2id(ctx.spellId) });
  fire(name, ctx);
};
const since = (n) => log.slice(n).map((e) => e.ev);
const gv = (n) => { const g = eng.vm.globals.get(n); const v = g && g.value; return v && typeof v === 'object' ? v.v : v; };
const give = (id) => { world.addAbility(A, id2int(id)); world.setAbilityLevel(A, id2int(id), 1); };
const reset = () => {
  world.interruptCast(A);
  A.cooldowns = new Map(); A.mana = A.maxMana; A.buffs = []; B.buffs = [];
  world.moveUnit(B, 0, 0); world.moveUnit(A, 200, 0);
  if (!A.alive) world.reviveUnit(A, 200, 0);
  if (!B.alive) world.reviveUnit(B, 0, 0);
  B.hp = B.maxHp;
  // Isolate cast timing from the separately tested approach/turn delay.
  A.facing = Math.atan2(B.y - A.y, B.x - A.x);
  world.rebuildBins();
};
const dummies = (type) => [...world.units.values()].filter((u) => u.typeKey === type && u.alive && !u.removed).length;

// ------------------------------------------------------------ the cast point
console.log('\n-- the effect lands at the cast point, and that is when mana goes');
check('the caster\'s unit type carries a cast point from UnitWeapons.slk',
      A.castPoint > 0 && A.castPoint < 2, `${caster.id} castpt=${A.castPoint} castbsw=${A.castBackswing}`);
{
  const BOLT = 'AHtb';                                   // Storm Bolt itself: 75 mana, 9s, range 600
  give(BOLT);
  reset();
  const info = world.abilityInfo(id2int(BOLT), 1);
  check('the bolt costs mana and has a cooldown, so both can be seen to move',
        info.mana > 0 && info.cooldown > 0, `mana ${info.mana} cd ${info.cooldown}`);
  const n = log.length, mana0 = A.mana, t0 = world.now;
  const r = world.castAbility(A, id2int(BOLT), B, B.x, B.y);
  check('the order is accepted', r.ok === true, r.reason || '');
  check('CHANNEL and CAST fire on the tick it is ordered, and nothing else does',
        since(n).join(' ') === 'CHANNEL CAST', since(n).join(' '));
  check('nothing is spent yet', A.mana === mana0 && !(A.cooldowns.get(id2int(BOLT)) > 0),
        `mana ${A.mana} of ${mana0}`);
  check('the unit is casting, and its order says so',
        A.cast && A.cast.phase === 'casting' && A.order.type === 'cast', A.cast && A.cast.phase);
  tick(1);
  const eff = log.slice(n).find((e) => e.ev === 'EFFECT');
  check('EFFECT fires at the cast point', !!eff && Math.abs((eff.t - t0) / 1000 - A.castPoint) <= STEP / 1000 + 1e-6,
        eff ? `${((eff.t - t0) / 1000).toFixed(3)}s against castpt ${A.castPoint}` : 'never fired');
  // a hero regenerates a little mana over the second that follows
  check('mana and cooldown go with the effect',
        Math.abs((mana0 - A.mana) - info.mana) < 10 && A.cooldowns.get(id2int(BOLT)) > world.now,
        `mana ${A.mana.toFixed(0)} of ${mana0}, cd until ${A.cooldowns.get(id2int(BOLT))}`);
  check('the five events run CHANNEL CAST EFFECT FINISH ENDCAST, once each',
        since(n).join(' ') === 'CHANNEL CAST EFFECT FINISH ENDCAST', since(n).join(' '));
  const fin = log.slice(n).find((e) => e.ev === 'FINISH'), end = log.slice(n).find((e) => e.ev === 'ENDCAST');
  check('an instant spell finishes and ends on the effect\'s own tick',
        fin && end && fin.t === eff.t && end.t === eff.t, `${eff && eff.t} ${fin && fin.t} ${end && end.t}`);
  check('and the caster resumes combat through idle acquisition',
        !A.cast && A.order.type === 'attack' && world.hostile(A, world.target(A.order.targetId)), A.order.type);
  // cast mid-fight: the attack the cast displaced is picked back up
  reset();
  world.order(A, { type: 'attack', target: B });
  world.castAbility(A, id2int(BOLT), B, B.x, B.y);
  check('a cast replaces an attack order while it runs', A.order.type === 'cast', A.order.type);
  tick(1);
  check('and hands the attack back when it is over',
        !A.cast && A.order.type === 'attack' && A.order.targetId === B.id, JSON.stringify(A.order));
}

// ------------------------------------------------------------------- range
console.log('\n-- a target out of range is walked to first');
{
  const BOLT = 'AHtb';
  reset();
  const range = world.abilityInfo(id2int(BOLT), 1).range;
  world.moveUnit(A, 1600, 0); world.rebuildBins();
  const n = log.length;
  const r = world.castAbility(A, id2int(BOLT), B, B.x, B.y);
  check(`the order is accepted from ${1600 - Math.round(range)} beyond its ${range} range`, r.ok === true, r.reason || '');
  check('no event fires while the caster is still on its way', since(n).length === 0 && A.cast.phase === 'approach',
        since(n).join(' '));
  tick(1);
  check('the caster is walking toward the target', A.x < 1550 && A.order.type === 'cast', `x=${A.x.toFixed(0)}`);
  tick(6);
  const chan = log.slice(n).find((e) => e.ev === 'CHANNEL');
  const eff = log.slice(n).find((e) => e.ev === 'EFFECT');
  check('the cast begins once in range, and lands', !!chan && !!eff, since(n).join(' '));
  check('within the ability\'s own range of the target',
        Math.hypot(A.x - B.x, A.y - B.y) <= range + A.radius + B.radius + 1,
        `${Math.hypot(A.x - B.x, A.y - B.y).toFixed(0)} <= ${range} + radii`);
}

// ------------------------------------------------------- a casting time
console.log('\n-- 원기옥 (A00L, AUin): a five-second ritual the map builds on CHANNEL');
{
  const RITUAL = 'A00L';
  give(RITUAL);
  reset();
  world.moveUnit(A, 300, 0); world.rebuildBins();
  const castTime = levelInfo(entry(RITUAL), 1).castTime;
  check('the ability carries a Casting Time of 5.0 in the data', castTime === 5.0, `acas=${castTime}`);
  const n = log.length, t0 = world.now, mana0 = A.mana, h0 = dummies('h009');
  const r = world.castAbility(A, id2int(RITUAL), B, B.x, B.y);
  check('the order is accepted', r.ok === true, r.reason || '');
  check('CHANNEL fires at once', since(n)[0] === 'CHANNEL', since(n).join(' '));
  check('and the map\'s own CHANNEL trigger raises the ring of h009 dummies',
        dummies('h009') > h0, `${dummies('h009')} h009 up`);
  tick(1);
  check('a second in, EFFECT has not fired and nothing is spent',
        !log.slice(n).some((e) => e.ev === 'EFFECT') && A.mana === mana0, since(n).join(' '));
  // a move order breaks it off
  world.order(A, { type: 'move', x: A.x + 100, y: A.y });
  check('a move order ends it with ENDCAST alone -- no EFFECT, no FINISH',
        since(n).join(' ') === 'CHANNEL CAST ENDCAST', since(n).join(' '));
  check('nothing was spent', A.mana === mana0 && !(A.cooldowns.get(id2int(RITUAL)) > 0), `mana ${A.mana}`);
  tick(0.2);
  check('and the map\'s ENDCAST trigger has taken the dummies down',
        dummies('h009') === h0, `${dummies('h009')} h009 left`);
  // left alone, it lands after its casting time
  reset();
  world.moveUnit(A, 300, 0); world.rebuildBins();
  const n2 = log.length, t2 = world.now;
  world.castAbility(A, id2int(RITUAL), B, B.x, B.y);
  tick(6);
  const eff = log.slice(n2).find((e) => e.ev === 'EFFECT');
  check('left alone, EFFECT fires after the casting time, not the cast point',
        !!eff && Math.abs((eff.t - t2) / 1000 - 5.0) <= STEP / 1000 + 1e-6,
        eff ? `${((eff.t - t2) / 1000).toFixed(3)}s` : 'never fired');
  check('then FINISH and ENDCAST', since(n2).join(' ') === 'CHANNEL CAST EFFECT FINISH ENDCAST', since(n2).join(' '));
}

// ------------------------------------------------------------- a channel
console.log('\n-- 고무고무 바람개비 (A04X, Amls): ENDCAST waits for the channel');
{
  const SPIN = 'A04X';
  give(SPIN);
  reset();
  world.moveUnit(A, 300, 0); world.rebuildBins();
  // every hit the world lands, because the target dies of the throw and comes
  // back at full life, which reads as no damage at all
  const hits = [];
  const dmg = world.damage.bind(world);
  world.damage = (src, tgt, amt, o) => { hits.push({ t: world.now, src, tgt, amt }); return dmg(src, tgt, amt, o); };
  const n = log.length;
  const r = world.castAbility(A, id2int(SPIN), B, B.x, B.y);
  check('the order is accepted', r.ok === true, r.reason || '');
  tick(1);
  check('EFFECT has fired and ENDCAST has not',
        log.slice(n).some((e) => e.ev === 'EFFECT') && !log.slice(n).some((e) => e.ev === 'ENDCAST'),
        since(n).join(' '));
  check('the caster is channelling', A.cast && A.cast.phase === 'channel' && !!A.cast.hold, A.cast && A.cast.phase);
  check('the map\'s spin has started and its stop flag is down', gv('udg_integer11') === 0,
        `integer11=${gv('udg_integer11')}`);
  tick(8);
  check('the spin got its three turns in', gv('udg_integer12') === 3, `integer12=${gv('udg_integer12')}`);
  check('the map let go itself, and ENDCAST followed',
        log.slice(n).some((e) => e.ev === 'ENDCAST') && !A.cast, since(n).join(' '));
  const end = log.slice(n).find((e) => e.ev === 'ENDCAST');
  const burns = hits.filter((h) => h.src === A && h.tgt === B && h.amt === 300 && h.t < end.t);
  check('the engine burned the held target for Mls1 = 300 a second while it hung there',
        burns.length >= 3, `${burns.length} ticks of 300 before ENDCAST`);
  const throwHit = hits.find((h) => h.src === A && h.tgt === B && h.t > end.t && h.amt === 600);
  check('and the throw did its 200 x 3 turns', !!throwHit,
        hits.filter((h) => h.t > end.t).map((h) => h.amt).join(' ') || 'no hit after ENDCAST');
  check('and the target is free to walk', !(B.buffs || []).some((b) => b.kind === 'slow' && b.pct >= 1),
        JSON.stringify(B.buffs));
  // a stun breaks a channel
  reset();
  world.moveUnit(A, 300, 0); world.rebuildBins();
  const n2 = log.length;
  world.castAbility(A, id2int(SPIN), B, B.x, B.y);
  tick(1);
  world.applyBuff(A, { kind: 'stun', until: world.now + 1000 });
  tick(0.1);
  check('a stun on the caster ends the channel with ENDCAST',
        since(n2).join(' ') === 'CHANNEL CAST EFFECT ENDCAST' && !A.cast, since(n2).join(' '));
  check('and lets the target go', !(B.buffs || []).some((b) => b.kind === 'slow' && b.pct >= 1), JSON.stringify(B.buffs));
  // so does death
  reset();
  world.moveUnit(A, 300, 0); world.rebuildBins();
  const n3 = log.length;
  world.castAbility(A, id2int(SPIN), B, B.x, B.y);
  tick(1);
  world.killUnit(A, B);
  check('the caster dying ends the channel with ENDCAST',
        since(n3).join(' ') === 'CHANNEL CAST EFFECT ENDCAST' && !A.cast, since(n3).join(' '));
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (eng.errors.length) console.log('vm errors:', eng.errors.slice(0, 3));
process.exit(fails.length ? 1 : 0);
