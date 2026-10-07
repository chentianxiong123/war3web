// Do the repaired spells deliver the shape the map's own fields describe?
//
// tools/slot_test.mjs proves the engine names each data slot the way
// AbilityMetaData does.  That is a claim about the source, and this project has
// been bitten three times by a test that asserted the claim instead of the
// outcome -- a sound suite once passed 15/15 while the game was silent.  So
// this one casts the spells and reads what actually happened: how many waves
// are queued and how hard each one hits, how long the damage line is, whether
// a roar buffs allies or damages enemies.
//
// Every expected number below is the map's own, quoted with the field it comes
// from.  Nothing here is a constant of ours.
//
//   node tools/spellshape_test.mjs        (no server needed)
import fs from 'node:fs';
import path from 'node:path';
import { ABILS, execute, levelInfo, baseOf } from '../server/abilities.js';
import { World } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const fails = [];
let pass = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fails.push(name); console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
};

// The five shop building types, two of each, one pair per base.
const SHOP_TYPES = new Set(['n000', 'n001', 'n00H', 'n00N', 'n013']);

const world = new World();
const eng = new JassEngine(world);
eng.load(); eng.boot();
const STEP = 1000 / 30;
for (let i = 0; i < 30; i++) { eng.update(STEP); world.step(); }

// The heroes standing about after boot are the tavern's picker copies, on
// players 12 and 15 -- neutral hostile and neutral passive, which world.hostile
// refuses to make enemies of anything.  So the test builds its own pair, and on
// players 0 and 6: this map allies 0-5 against 6-11, so a dummy on player 1
// would be a teammate and every spell below would report a clean zero.
const TYPES = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/unittypes.json'), 'utf8'));
const P = (n) => world.jass.players[n];
const CASTER_TYPE = [...world.units.values()].find((u) => u.isHero)?.typeKey
                 || Object.keys(TYPES).find((k) => TYPES[k].isHero);
const hero = world.createUnit(P(0), CASTER_TYPE, 0, 0, 0);
if (!hero) { console.log('  FAIL  no caster could be built'); process.exit(1); }
hero.x = 0; hero.y = 0;

// Use an organic ground unit: the first h-prefixed type may be mechanical.
const DUMMY = 'hfoo';
const foes = [];
/** A hostile dummy at an exact point, so a line or a cone has something to hit. */
function foe(dx, dy) {
  const u = world.createUnit(P(6), DUMMY, hero.x + dx, hero.y + dy, 0);
  if (!u) return null;
  // freeSpotNear slides a new unit off the spot; the geometry is the thing
  // under test, so put it back.
  u.x = hero.x + dx; u.y = hero.y + dy;
  u.hp = u.maxHp = 1e9;
  u.armor = 0;
  foes.push(u);
  // The spatial bins are rebuilt once a tick and these units are created and
  // moved between ticks, so anything reached through enumInRange -- every AoE
  // here -- would miss them.
  world.binTick = -1;
  world.rebuildBins();
  return u;
}
const clearFoes = () => { for (const f of foes.splice(0)) f.alive = false; };
const cast = (id, lvl, at) => {
  world.channels = [];
  return execute(world, hero, ABILS[id], lvl, at || { x: hero.x + 400, y: hero.y });
};

// ---------------------------------------------------------- Blizzard family
console.log('\n-- Blizzard and Rain of Fire: Hbz1 waves, Hbz2 damage');
{
  const L = levelInfo(ABILS.A027, 3);            // 보구의 비, Gilgamesh
  check('A027 rank 3 carries 5 waves and 180 damage in the data',
        L.data1 === 5 && L.data2 === 180 && L.duration === 10,
        `d1=${L.data1} d2=${L.data2} adur=${L.duration}`);
  cast('A027', 3);
  const c = world.channels[0];
  check('the cast queues 5 waves, not 180', c && c.left === 5, c ? `left=${c.left}` : 'no channel');
  check('each wave carries 180 damage, not 5', c && c.perWave === 180, c ? `per=${c.perWave}` : '-');
  check('and they are spread over the ability\'s own 10s duration',
        c && Math.abs(c.interval - 2000) < 1, c ? `${c.interval}ms` : '-');
}
{
  const L = levelInfo(ABILS.A06R, 3);            // 시엔플루르, Nico Robin
  check('A06R rank 3 carries 30 waves and 1100 damage',
        L.data1 === 30 && L.data2 === 1100, `d1=${L.data1} d2=${L.data2}`);
  cast('A06R', 3);
  const c = world.channels[0];
  check('30 waves of 1100, not 1100 waves of 30',
        c && c.left === 30 && c.perWave === 1100,
        c ? `${c.left} x ${c.perWave}` : 'no channel');
  // The eighteen-minute bombardment is the thing this test exists to stop.
  check('the channel cannot outlive the match',
        c && (c.left * c.interval) < 60_000,
        c ? `${Math.round(c.left * c.interval / 1000)}s` : '-');
}

// ------------------------------------------------------------ Cluster Rockets
console.log('\n-- Cluster Rockets: an area barrage, not a line');
{
  const L = levelInfo(ABILS.A00R, 1);            // 숏건, Yusuke
  check('A00R carries 30 damage, 0.3s interval, 10 missiles',
        L.data1 === 30 && L.data2 === 0.3 && L.data3 === 10,
        `${L.data1} / ${L.data2} / ${L.data3}`);
  cast('A00R', 1);
  const c = world.channels[0];
  check('it fires 10 rockets of 30 into its own area',
        c && c.left === 10 && c.perWave === 30 && c.radius === L.area,
        c ? `${c.left} x ${c.perWave} r${c.radius}` : 'no channel');
  // Read as a Carrion Swarm, Ncs2 became a total damage cap of 0.3 and the
  // spell stopped after one unit.
  check('the 0.3 is an interval, not a damage cap',
        c && Math.abs(c.interval - 300) < 1, c ? `${c.interval}ms` : '-');
}

// ------------------------------------------------------------------- Impale
console.log('\n-- Impale: Uim1 distance, Uim3 damage, Uim4 air time');
{
  const L = levelInfo(ABILS.A04T, 1);            // 고사리싹의 춤, Akiha
  check('A04T carries 600 distance, 2000 damage, 1s air time',
        L.data1 === 600 && L.data3 === 2000 && L.data4 === 1,
        `${L.data1} / ${L.data3} / ${L.data4}`);
  clearFoes();
  const near = foe(300, 0), far = foe(1500, 0);
  if (near && far) {
    const hp0 = near.hp, hpFar0 = far.hp;
    execute(world, hero, ABILS.A04T, 1, { x: hero.x + 600, y: hero.y });
    check('a unit 300 along the line takes the 2000',
          Math.abs((hp0 - near.hp) - 2000) < 200, `${Math.round(hp0 - near.hp)}`);
    // Read positionally the line ran 2000 long and 1 wide -- it reached far
    // past Uim1 and hit almost nothing on the way.
    check('a unit at 1500 is beyond Uim1 and takes nothing', far.hp === hpFar0,
          `${hpFar0 - far.hp}`);
    check('and the one it hit is stunned for the air time',
          (near.buffs || []).some((b) => b.kind === 'stun'), 'stun');
  } else check('dummies could be summoned for the line test', false, 'no hfoo');
}

// ------------------------------------------------------------ Breath of Fire
console.log('\n-- ANcf is Breath of Fire: a cone, not a ring at the caster\'s feet');
{
  check('ANcf routes to the breath case', baseOf(ABILS.A01N) === 'ANbf', baseOf(ABILS.A01N));
  const L = levelInfo(ABILS.A01N, 3);            // 폭류파, InuYasha
  check('A01N rank 3 carries 3000 damage over an 800 range',
        L.data1 === 3000 && L.range === 900, `${L.data1} @ ${L.range}`);
  clearFoes();
  const out = foe(500, 0);
  if (out) {
    const hp0 = out.hp;
    execute(world, hero, ABILS.A01N, 3, { x: hero.x + 800, y: hero.y });
    // The Fan of Knives case used aare=100, so nothing past the caster's own
    // feet was ever touched.
    check('a unit 500 down the cone takes the 3000',
          Math.abs((hp0 - out.hp) - 3000) < 300, `${Math.round(hp0 - out.hp)}`);
  } else check('dummy could be summoned for the cone test', false, 'no hfoo');
}

// -------------------------------------------------------------- Battle Roar
console.log('\n-- ANbr is Battle Roar: it buffs friends, it does not burn enemies');
{
  const L = levelInfo(ABILS.A03S, 1);            // 섬경 천본앵경엄, Byakuya
  check('A03S carries 1000 in Nbr1 "Damage Increase"', L.data1 === 1000, `${L.data1}`);
  clearFoes();
  const bystander = foe(80, 0);
  if (bystander) {
    const hp0 = bystander.hp;
    execute(world, hero, ABILS.A03S, 1, { x: hero.x, y: hero.y });
    check('an enemy in range takes no damage from a roar', bystander.hp === hp0,
          `${hp0 - bystander.hp}`);
    check('and the caster comes away with the damage buff',
          (hero.buffs || []).some((b) => b.kind === 'rage'), 'rage');
  } else check('dummy could be summoned for the roar test', false, 'no hfoo');
}

// ---------------------------------------------------------- Finger of Death
console.log('\n-- Finger of Death keeps its damage in Nfd3');
{
  const L = levelInfo(ABILS.A01G, 1);            // 금술오의-시귀봉진, Sandaime
  check('A01G carries 0.25 graphic delay and 10000 damage',
        L.data1 === 0.25 && L.data3 === 10000, `d1=${L.data1} d3=${L.data3}`);
  clearFoes();
  const t = foe(120, 0);
  if (t) {
    const hp0 = t.hp;
    execute(world, hero, ABILS.A01G, 1, { target: t, x: t.x, y: t.y });
    // Armour reduction is real and applies here, so this checks the order of
    // magnitude the map asked for rather than the raw figure -- the defect was
    // 0.25, four orders of magnitude out.
    check('it deals the 10000, not the 0.25',
          Math.abs((hp0 - t.hp) - 10000) < 1000, `${Math.round(hp0 - t.hp)}`);
  } else check('dummy could be summoned for the nuke test', false, 'no hfoo');
}

// ------------------------------------------------- the map's deliberate zeros
//
// 27 of this map's abilities write an explicit 0 into a slot the engine used to
// default over, because the ability's own trigger carries the payload.  These
// four are from four different bases and four different heroes, one of them in
// the half of the roster HeroSweep.TXT never ran.
console.log('\n-- a slot the map set to 0 deals 0, not the engine\'s fallback');
{
  const ZEROED = [
    ['A02V', 'Awrh', '초콜릿이 되라',   80],   // Majin Buu, was 80 in a 250 ring
    ['A007', 'AUcs', '게이트 오브 바빌론', 100],  // Gilgamesh, was 100 down a line
    ['A00K', 'AHtb', '츠쿠요미',        100],  // Itachi -- roster half never swept
    ['A04R', 'AOsh', '고무고무 총난타',   100],  // Luffy, ranks 1-5 zeroed, 6-10 are not
  ];
  for (const [id, base, name, wasDealing] of ZEROED) {
    const A = ABILS[id];
    if (!A) { check(`${id} is in the table`, false); continue; }
    const L = levelInfo(A, 1);
    check(`${id} ${name} carries an explicit 0, not an absent field`,
          'data1' in L && L.data1 === 0, `data1=${L.data1}`);
    clearFoes();
    const t = foe(60, 0);
    if (!t) { check(`${id} could be aimed at a dummy`, false); continue; }
    const hp0 = t.hp;
    execute(world, hero, A, 1, { target: t, x: t.x, y: t.y });
    check(`${id} deals nothing rather than the old ${wasDealing}`,
          t.hp === hp0, `${Math.round(hp0 - t.hp)} dealt`);
    // A 0.01 duration is the same statement in the duration field, and the
    // War Stomp case used to floor it to a full second.
    // No buff of ANY kind: asserting only "no stun" would have passed while the
    // block fell through to Thunder Clap's slow, which is a different ability.
    if (L.duration > 0 && L.duration <= 0.1)
      check(`${id} leaves no buff either, its duration being ${L.duration}`,
            (t.buffs || []).length === 0,
            (t.buffs || []).map((b) => b.kind).join(',') || 'none');
  }
  // ...and the fallback still applies where the map declared a real number, so
  // this is not a blanket "zero everything".
  clearFoes();
  const t = foe(60, 0);
  if (t) {
    const hp0 = t.hp;
    execute(world, hero, ABILS.A01N, 3, { x: hero.x + 400, y: hero.y });
    check('an ability that DOES declare its damage still deals it',
          Math.abs((hp0 - t.hp) - 3000) < 300, `${Math.round(hp0 - t.hp)}`);
  }
}

// ------------------------------------------------- the buffs the map reads
//
// war3map.j gates real trigger chains on UnitHasBuffBJ, and four of those codes
// could never be true because every applyBuff but one passed no `code`:
// 클러치 (A06Q) filters for B00H, 사폭장송 (A05Q) for B00X, Byakuya's A00T
// checks B00N, and A059's own trigger checks B00S. tools/ability_audit.mjs
// reports these under BUFF SEAMS -- but it reads the source, and a seam that
// reads closed there can still be open on the unit. This checks the unit.
console.log('\n-- the buff codes the map\'s own triggers read');
{
  const SEAMS = [
    ['A059', 'B00S', 'target', '아이스에이지'],   // AOws, stamps the enemies it stomps
    ['A03S', 'B00N', 'caster', '섬경 천본앵경엄'], // ANbr, a roar -- buffs self
    ['A000', 'B00X', 'target', '사박궤'],         // AEer, roots what it names
    ['A06P', 'B00H', 'target', '베인떼플루르'],
  ];
  for (const [id, code, where, name] of SEAMS) {
    const A = ABILS[id];
    if (!A) { check(`${id} is in the table`, false); continue; }
    clearFoes();
    const t = foe(80, 0);
    if (!t) { check(`${id} could be aimed`, false); continue; }
    execute(world, hero, A, 1, { target: t, x: t.x, y: t.y });
    const onTarget = world.abilityLevel(t, code) > 0;
    const onCaster = world.abilityLevel(hero, code) > 0;
    const got = where === 'target' ? onTarget : onCaster;
    check(`${id} ${name} stamps ${code} on the ${where}`, got,
          `target ${onTarget}, caster ${onCaster}`);
    // Clear it off the caster so the next roar's check cannot inherit it.
    hero.buffs = (hero.buffs || []).filter((b) => b.code !== code);
  }
}

// ------------------------------------------------------ shops are not targets
//
// The shops are the buildings inside each base, on player 15 -- Neutral
// Passive. Warcraft III never lets that be an enemy, and neither does
// world.hostile, so no amount of ordering can damage one. Asserted because it
// was reported from play as heroes attacking the shop.
console.log('\n-- the shop buildings cannot be fought');
{
  const shops = [...world.units.values()].filter((u) => SHOP_TYPES.has(u.typeKey));
  check('both bases have their shops standing', shops.length >= 10, `${shops.length}`);
  const shop = shops[0];
  if (shop) {
    check('a shop is Neutral Passive', shop.playerIndex === 15, `player ${shop.playerIndex}`);
    check('and on a different team from the hero, so team alone would call it an enemy',
          shop.team !== hero.team, `${shop.team} vs ${hero.team}`);
    check('yet the engine refuses to make it hostile', world.hostile(hero, shop) === false);
    // The guarantee that matters: it can never be acquired or splashed.
    world.moveUnit(hero, shop.x + 60, shop.y);
    world.binTick = -1; world.rebuildBins();
    const near = world.enemiesInRange(hero, shop.x, shop.y, 400);
    check('it is never returned as an enemy in range',
          !near.includes(shop), `${near.length} enemies near it`);
    // Ordering the attack -- which is what a right-click used to do -- lands
    // nothing, because stepAttack goes through hostile() before it swings.
    const hp0 = shop.hp;
    world.order(hero, { type: 'attack', target: shop });
    for (let i = 0; i < 180; i++) { eng.update(1000 / 30); world.step(); }
    check('ordering an attack on it takes nothing off it over six seconds',
          shop.hp === hp0, `${hp0} -> ${shop.hp}`);
    // world.damage itself is deliberately NOT filtered -- the map's own triggers
    // call UnitDamageTarget on whatever they please and the engine has to obey.
    // Recorded rather than asserted shut, because filtering it would silently
    // change what the map can do.
    world.damage(hero, shop, 5000, {});
    console.log(`   (a direct damage call is unfiltered by design: ` +
                `${Math.round(hp0)} -> ${Math.round(shop.hp)})`);
  }
}

// ------------------------------------------------------------------- Blink
//
// Ebl1 "Maximum Range" and Ebl2 "Minimum Range" are the hop; `range` is only
// how far away the order may be issued, and this map leaves it at Blizzard's
// 99999 on both blinks.
console.log('\n-- Blink: Ebl1 is the hop, not the order range');
for (const [id, hero_] of [['A01U', 'Eneru 전광'], ['A04M', 'Renji 순보']]) {
  const L = levelInfo(ABILS[id], 1);
  check(`${id} (${hero_}) carries a 400 maximum and a ${L.data2} minimum against range ${L.range}`,
        L.data1 === 400 && L.range === 99999, `d1=${L.data1} d2=${L.data2} rng=${L.range}`);
  hero.x = 0; hero.y = 0;
  execute(world, hero, ABILS[id], 1, { x: 20000, y: 0 });
  const hop = Math.hypot(hero.x, hero.y);
  check(`${id} hops its own 400 and not the whole map`, hop <= 420, `${Math.round(hop)}`);
  // the minimum is a floor on the hop: a click one pixel away still moves it
  hero.x = 0; hero.y = 0;
  execute(world, hero, ABILS[id], 1, { x: 1, y: 0 });
  const shortHop = Math.hypot(hero.x, hero.y);
  check(`${id} will not hop shorter than its Ebl2 minimum of ${L.data2}`,
        shortHop >= L.data2 - 40, `${Math.round(shortHop)} vs ${L.data2}`);
}
hero.x = 0; hero.y = 0;

// ------------------------------------------------------------- Flame Strike
//
// Six fields, all of them used: Hfs1 every Hfs2 for the shorter duration, then
// Hfs3 every Hfs4 for the rest, inside the ability's area, capped at Hfs6 per
// unit.  It used to share Death Coil's case and deal Hfs1 once to one unit.
console.log('\n-- Flame Strike: a burning circle, not a bolt');
{
  const L = levelInfo(ABILS.A04F, 10);           // 달을 뚫는다, Akiha
  check('A04F rank 10 carries 150 per 0.2s, 100 per 1s, 4.01s inside 10s, cap 3000',
        L.data1 === 150 && L.data2 === 0.2 && L.data3 === 100 && L.data4 === 1
          && L.heroDuration === 4.01 && L.duration === 10 && L.data6 === 3000,
        `${L.data1}/${L.data2}/${L.data3}/${L.data4} ${L.heroDuration}<${L.duration} cap ${L.data6}`);
  clearFoes();
  world.burns = [];
  const inside = foe(100, 0), outside = foe(2000, 0);
  // a point cast, on bare ground, with no unit under it at all
  const r = execute(world, hero, ABILS.A04F, 10, { x: hero.x, y: hero.y });
  check('a click on bare ground is a cast, not "need target"', r.ok === true, r.reason || '');
  const b = world.burns[0];
  check('it lights a burn of the ability\'s own area', b && b.radius === L.area,
        b ? `r=${b.radius} vs ${L.area}` : 'no burn');
  check('the full phase is the shorter duration, the whole burn the longer',
        b && Math.abs(b.fullUntil - (world.now + 4010)) < 2
          && Math.abs(b.until - (world.now + 10000)) < 2,
        b ? `${(b.fullUntil - world.now)}ms of ${(b.until - world.now)}ms` : '-');
  if (inside && outside) {
    const hp0 = inside.hp, out0 = outside.hp;
    for (let i = 0; i < 30 * 12; i++) { world.now += STEP; world.stepBurns(); }
    const took = hp0 - inside.hp;
    // 20 ticks of 150 is the cap exactly; nothing may take more than Hfs6
    check('a unit standing in it all the way takes the Hfs6 cap, not more',
          took > 2000 && took <= 3000 + 1, `${Math.round(took)} vs cap 3000`);
    check('one pulse of Hfs1 is not the whole spell', took > L.data1 * 2,
          `${Math.round(took)} vs a single ${L.data1}`);
    check('a unit outside the area takes nothing', outside.hp === out0,
          `${Math.round(out0 - outside.hp)}`);
  }
  world.burns = [];
}

// -------------------------------------------------------------- Mana Shield
//
// Nms1 "Mana per Hit Point", Nms2 "Damage Absorbed (%)".  All three shields in
// this map carry 100% absorbed at -0.01 mana per point: absorbing pays mana
// back, which is the author writing "cancels all damage" in the fields.
console.log('\n-- Mana Shield: damage off mana, at the ability\'s own rate');
for (const [id, who] of [['A00S', 'Sandaime 토둔-토류벽'], ['A06S', 'Nico Robin 칼렌듈러'],
                         ['A00P', 'Orochimaru 수둔-수진벽']]) {
  const L = levelInfo(ABILS[id], 1);
  check(`${id} (${who}) absorbs 100% at -0.01 mana per hit point`,
        L.data2 === 1 && L.data1 === -0.01, `pct=${L.data2} rate=${L.data1}`);
  // Warcraft III's Mana Shield is cast on the caster (retail targs1 = self), so
  // this is a self-buff even when the map widens the target list.
  hero.buffs = []; hero.maxMana = 500; hero.mana = 100; hero.armor = 0;
  execute(world, hero, ABILS[id], 1, {});
  const live = (hero.buffs || []).find((b) => b.kind === 'manashield' && b.until > world.now);
  check(`${id} leaves a live mana shield on the caster`, !!live, JSON.stringify(hero.buffs));
  const hp0 = hero.hp, mana0 = hero.mana;
  world.damage(null, hero, 1000, { spell: true });
  check(`${id} takes the damage off nothing while it holds`,
        hero.hp === hp0, `${Math.round(hp0 - hero.hp)} life lost`);
  check(`${id}'s negative rate pays mana back rather than spending it`,
        hero.mana > mana0, `${mana0} -> ${Math.round(hero.mana)}`);
  // and it is timed: this map gives all three an ahdu rather than the retail
  // toggle, so it has to end
  const secs = L.heroDuration || L.duration;
  check(`${id} lasts the ${secs}s the map gives it and no longer`,
        live && Math.abs(live.until - (world.now + secs * 1000)) < 2,
        live ? `${(live.until - world.now) / 1000}s vs ${secs}s` : '-');
  hero.buffs = [];
}
// a positive rate is retail's reading: it spends mana and drops when that runs out
{
  clearFoes();
  const victim = foe(60, 0);
  if (victim) {
    victim.maxMana = 50; victim.mana = 50; victim.armor = 0;
    victim.buffs = [{ kind: 'manashield', pct: 1, manaPerHp: 1, until: world.now + 60_000 }];
    const hp0 = victim.hp;
    world.damage(hero, victim, 200, { spell: true });
    check('a shield that SPENDS mana absorbs only what the mana covers',
          victim.mana === 0 && Math.round(hp0 - victim.hp) === 150,
          `mana ${victim.mana}, took ${Math.round(hp0 - victim.hp)} of 200`);
  }
}

// --------------------------------------------------------- Aerial Shackles
console.log('\n-- Aerial Shackles: Mls1 is damage per SECOND, over the duration');
{
  const L = levelInfo(ABILS.A04X, 3);            // 고무고무 바람개비, Luffy
  check('A04X rank 3 carries 900 a second for 20 seconds',
        L.data1 === 900 && L.duration === 20, `${L.data1} / ${L.duration}s`);
  clearFoes();
  world.dots = [];
  const victim = foe(200, 0);
  if (victim) {
    execute(world, hero, ABILS.A04X, 3, { target: victim });
    const d = (world.dots || [])[0];
    check('it burns for its per-second figure once a second, not once',
          d && d.perTick === 900 && Math.abs(d.interval - 1000) < 1,
          d ? `${d.perTick} every ${d.interval}ms` : 'no dot');
    check('and for the whole 20 seconds', d && Math.abs(d.until - (world.now + 20_000)) < 2,
          d ? `${(d.until - world.now) / 1000}s` : '-');
    check('what it shackles cannot move', (victim.buffs || []).some((b) => b.kind === 'slow' && b.pct === 1),
          JSON.stringify(victim.buffs));
  }
  world.dots = [];
}

// ------------------------------------------------- a summon count of zero
//
// AbilityMetaData's Hwe2 is "Summoned Unit Count", and Rock Lee's 취권 sets it
// to 0 at every level: the ability keeps the Quilbeast row for its buff and its
// cooldown, and delivers the spell from the map's own trigger.
console.log('\n-- a summon the map counted at zero summons nothing');
for (const id of ['A03R', 'A055']) {
  const L = levelInfo(ABILS[id], 1);
  check(`${id} names ${L.unit} and asks for ${L.data1} of them`,
        L.unit && L.data1 === 0, `${L.unit} x ${L.data1}`);
  const before = [...world.units.values()].filter((u) => u.alive && u.typeKey === L.unit).length;
  execute(world, hero, ABILS[id], 1, { x: hero.x + 200, y: hero.y });
  const after = [...world.units.values()].filter((u) => u.alive && u.typeKey === L.unit).length;
  check(`${id} puts no ${L.unit} on the field`, after === before, `${before} -> ${after}`);
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
