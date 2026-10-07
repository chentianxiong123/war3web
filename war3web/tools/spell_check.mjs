// Audit every hero ability against what its own tooltip says it should do.
//
// The map writes its descriptions to a house style: a sentence of prose, then
// `◎` lines carrying the numbers -- damage, stun, duration, cooldown, how many
// it summons. That is a statement of intent straight from the map, so it can be
// read as an expectation and held against what the engine actually does when the
// spell is cast.
//
// This is a heuristic, not a proof. It parses English text and watches a single
// punching bag, so it flags candidates rather than pronouncing verdicts: a spell
// marked `no effect seen` may still be firing something this harness cannot
// observe, and one marked `ok` may be doing the right kind of thing with the
// wrong numbers. Read it as a worklist.
//
//   node tools/spell_check.mjs            summary + the ones worth a look
//   node tools/spell_check.mjs --json     the whole table, for tools/spell_sheet.py
import fs from 'node:fs';
import { World, id2int } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';
import * as A from '../server/abilities.js';

const GAME = JSON.parse(fs.readFileSync('data/game.json', 'utf8'));

// Warcraft III maps carry their spell effects on invisible dummy units: create
// one, have it cast, remove it. They are marked with Locust ("Aloc"), which is
// the engine's own way of saying "this is not really a unit" -- so a summon
// count that does not exclude them reports Gum-Gum Storm as summoning 169 things.
const UNIT_TABLE = JSON.parse(fs.readFileSync('data/unittypes.json', 'utf8'));
const DUMMY = new Set(Object.values(UNIT_TABLE)
  .filter((t) => (t.abilities || []).includes('Aloc'))
  .map((t) => t.id));

// client/js/render.js resolveModel(), in Node: a spell can fire perfect art and
// still be invisible if the model it names was never converted.
const MODELS = (() => {
  const idx = JSON.parse(fs.readFileSync('assets/models.json', 'utf8'));
  const exact = new Map(), byBase = new Map();
  for (const k of Object.keys(idx)) {
    const low = k.toLowerCase();
    exact.set(low, true);
    byBase.set(low.split('\\').pop(), true);
  }
  return { exact, byBase };
})();
function resolveModel(path) {
  if (!path) return null;
  const key = String(path).replace(/\\\\/g, '\\').replace(/\//g, '\\')
    .replace(/^\\+/, '').replace(/\.(mdl|mdx)$/i, '').toLowerCase();
  if (!key || key === 'none' || key === '\uc5c6\ub2e4') return 'none';
  return (MODELS.exact.has(key) || MODELS.byBase.has(key.split('\\').pop())) ? 'ok' : 'missing';
}
const JSON_OUT = process.argv.includes('--json');
const MAXARG = process.argv.find((a) => a.startsWith('--max='));
const MAX = MAXARG ? +MAXARG.split('=')[1] : Infinity;
const T0 = Date.now();

// ---------------------------------------------------------------- expectation
const NUM = '([0-9]+(?:\\.[0-9]+)?)';

function expect(desc) {
  const e = { kinds: new Set(), damage: 0, stun: 0, summon: 0, cooldown: null,
              duration: null, area: null, range: null, notes: [] };
  if (!desc) return e;
  const text = desc.replace(/\s+/g, ' ');
  const low = text.toLowerCase();

  // the ◎ lines carry the numbers
  const bullets = desc.split('\n').filter((l) => l.trim().startsWith('◎'));
  for (const b of bullets) {
    const l = b.replace('◎', '').trim();
    const ll = l.toLowerCase();
    let m;
    if ((m = ll.match(new RegExp('^damage ' + NUM)))) e.damage = Math.max(e.damage, +m[1]);
    else if ((m = ll.match(new RegExp(NUM + ' damage (?:per|total)')))) e.damage = Math.max(e.damage, +m[1]);
    else if ((m = ll.match(new RegExp('^' + NUM + ' damage')))) e.damage = Math.max(e.damage, +m[1]);
    if ((m = ll.match(new RegExp('stun(?:ned)?(?: for)? ' + NUM + 's')))) e.stun = Math.max(e.stun, +m[1]);
    if ((m = ll.match(new RegExp('^stun ' + NUM + 's')))) e.stun = Math.max(e.stun, +m[1]);
    if ((m = ll.match(new RegExp('summons ' + NUM)))) { e.summon = Math.max(e.summon, +m[1]); e.kinds.add('summon'); }
    if (/^summons /.test(ll)) e.kinds.add('summon');
    if ((m = ll.match(new RegExp('^cooldown ' + NUM + 's')))) e.cooldown = +m[1];
    if ((m = ll.match(new RegExp('^(?:duration|lasts) ' + NUM + 's')))) e.duration = +m[1];
    if ((m = ll.match(new RegExp('^(?:effect )?area ' + NUM)))) e.area = +m[1];
    if ((m = ll.match(new RegExp('^cast range ' + NUM)))) e.range = +m[1];
    if (/slow|snare/.test(ll)) e.kinds.add('slow');
    if (/cannot cast|silence/.test(ll)) e.kinds.add('silence');
    if (/evade|evasion|critical|attack speed|movement speed|armor bonus|hp bonus|all stats|\+\d+ (?:to )?all/.test(ll))
      e.kinds.add('buff');
  }

  // the prose says what kind of thing it is
  if (/\bdamage\b|damages|strikes? .*for|deals? /.test(low)) e.kinds.add('damage');
  if (/summons?|calls? (?:up|forth|the)|spits a giant snake|revive/.test(low)) e.kinds.add('summon');
  if (/stun|knocks? .*out|holds? them fast|binds?|immobil/.test(low)) e.kinds.add('stun');
  if (/slows?\b/.test(low)) e.kinds.add('slow');
  if (/heals?|restores?|regenerat/.test(low)) e.kinds.add('heal');
  if (/becomes? |transforms?|hollowfies|full demon|turns? into/.test(low)) e.kinds.add('morph');
  if (/steps? a short distance|moves? to another position|in an instant|blink|teleport|flash step/.test(low))
    e.kinds.add('blink');
  if (/rises? by|increase[sd]?|gains?|amplif|\bbonus\b|shield|protect/.test(low)) e.kinds.add('buff');
  if (e.damage > 0) e.kinds.add('damage');
  if (e.stun > 0) e.kinds.add('stun');
  return e;
}

// -------------------------------------------------------------------- measure
const world = new World();
const eng = new JassEngine(world);
eng.load(); eng.boot();
const tick = () => { eng.update(1000 / 30); world.step(); };
for (let i = 0; i < 90; i++) tick();

// The bench has to stand on real ground. An off-map point looks fine for damage
// -- that is only arithmetic -- but every spell that moves a unit resolves
// against the pathing grid, so a blink cast into the void reports "blocked" and
// the spell looks broken when it is the harness that is wrong. Pick the emptiest
// open cell on the actual map instead.
const [X, Y] = (() => {
  const b = world.bounds();
  const clear = (x, y, r) => {
    for (let dx = -r; dx <= r; dx += 128) for (let dy = -r; dy <= r; dy += 128)
      if (!world.walkable(x + dx, y + dy)) return false;
    return true;
  };
  const near = (x, y) => Math.min(...[...world.units.values()].map((u) => Math.hypot(u.x - x, u.y - y)));
  let best = null, bestD = -1;
  for (let y = b.miny + 800; y < b.maxy - 800; y += 128)
    for (let x = b.minx + 800; x < b.maxx - 800; x += 128) {
      if (!clear(x, y, 768)) continue;
      const d = near(x, y);
      if (d > bestD) { bestD = d; best = [x, y]; }
    }
  if (!best) throw new Error('no open ground on the map to test on');
  process.stderr.write(`bench at ${best[0]},${best[1]} (nearest map unit ${Math.round(bestD)})\n`);
  return best;
})();
const OBSERVE = 60;                     // 2s at 30Hz

// Every spell is cast into the same world, so each one has to leave it as it
// found it. Summons made by the map's own triggers are not tagged as the
// caster's, and without this the crowd grows all run: later spells measure a
// different battlefield from earlier ones, and the tick cost climbs with it.
const RESIDENT = new Set(world.units.keys());
function sweep() {
  for (const u of [...world.units.values()]) if (!RESIDENT.has(u.id)) world.removeUnit(u);
}

function measure(hero, a, ab) {
  const caster = world.createUnit(eng.players[0], hero.id, X, Y, 0);
  if (!caster) return null;
  caster.mana = caster.maxMana = 999999;
  caster.moveSpeed = 0;
  caster.level = 1;
  world.addAbility(caster, id2int(a.id));
  world.learnSkill(caster, id2int(a.id));
  world.recalc(caster);

  // a main target, and a second body nearby so area effects show
  const foe = world.createUnit(eng.players[5], 'hfoo', X + 250, Y, 0);
  const near = world.createUnit(eng.players[5], 'hfoo', X + 330, Y + 80, 0);
  for (const u of [foe, near]) { if (u) { u.maxHp = u.hp = 1e7; u.moveSpeed = 0; } }

  const before = {
    foeHp: foe.hp, nearHp: near ? near.hp : 0,
    casterHp: caster.hp, casterMana: caster.mana,
    x: caster.x, y: caster.y, typeKey: caster.typeKey,
    ids: new Set(world.units.keys()),
  };
  world.flushEvents();
  const r = world.castAbility(caster, a.id, foe, foe.x, foe.y);

  // what the client would be told to draw
  const art = { fx: 0, missile: false, models: new Set(), unresolved: new Set() };
  const watch = (evs) => {
    for (const e of evs) {
      if (e.t === 'missile') { art.missile = true; }
      if (e.t === 'sfx' || e.t === 'sfxUnit' || e.t === 'missile') {
        const p = e.path || e.model;
        if (!p) continue;
        art.fx++;
        const st = resolveModel(p);
        if (st === 'missing') art.unresolved.add(String(p).toLowerCase());
        else if (st === 'ok') art.models.add(String(p).toLowerCase());
      }
    }
  };
  watch(world.flushEvents());

  // long enough for a missile to cross the gap and the first damage tick to land
  const seen = { stun: 0, slow: 0, silence: 0, casterBuff: new Set() };
  // A spell that overshoots its stated damage 60x and one that ticks for two
  // seconds look identical in a single total, so keep the half-second split:
  // flat between the two means one hit, climbing means damage over time.
  let dmgHalf = 0;
  for (let i = 0; i < OBSERVE; i++) {
    tick();
    watch(world.flushEvents());
    if (i === 14) dmgHalf = before.foeHp - foe.hp;
    for (const b of foe.buffs || []) {
      if (b.kind === 'stun') seen.stun = Math.max(seen.stun, (b.until - world.now) / 1000);
      if (b.kind === 'slow') seen.slow = 1;
      if (b.kind === 'silence') seen.silence = 1;
    }
    for (const b of caster.buffs || []) seen.casterBuff.add(b.kind);
  }

  // Count anything the caster's side gained, not just units tagged `summonedBy`:
  // the map's own triggers build their summons with CreateUnit and never set it,
  // so counting the tag alone reports "no summon" for half the summoning spells.
  // ...but "same owner" alone sweeps in the creep waves the map spawns for that
  // player all over the map. A summon arrives next to its caster, and the bench
  // deliberately stands well clear of everything else, so distance sorts them out.
  const summons = [...world.units.values()].filter((u) =>
    !before.ids.has(u.id) && u.id !== foe.id && u.id !== (near && near.id)
    && (u.summonedBy === caster.id || u.playerIndex === caster.playerIndex)
    && Math.hypot(u.x - X, u.y - Y) < 900
    && !DUMMY.has(u.typeKey)).length;
  const out = {
    cast: r.ok ? 'ok' : r.reason,
    missile: art.missile,
    fx: art.fx,
    models: [...art.models],
    unresolved: [...art.unresolved],
    damage: Math.round(before.foeHp - foe.hp),
    damageHalfSec: Math.round(dmgHalf),
    splash: near ? Math.round(before.nearHp - near.hp) : 0,
    summon: summons,
    stun: +seen.stun.toFixed(1),
    slow: seen.slow, silence: seen.silence,
    casterBuff: [...seen.casterBuff],
    moved: Math.round(Math.hypot(caster.x - before.x, caster.y - before.y)),
    morph: caster.typeKey !== before.typeKey,
    healed: Math.round(caster.hp - before.casterHp),
    cooldown: Math.round((caster.cooldowns?.get(id2int(a.id)) || 0) - 0) > 0
      ? Math.round(((caster.cooldowns.get(id2int(a.id)) || 0) - world.now) / 1000) : 0,
  };
  sweep();
  return out;
}

/** Whether the client was told to draw anything, and whether it could. */
function judgeArt(got) {
  if (!got || got.cast !== 'ok') return ['n/a', ''];
  if (got.unresolved.length)
    return ['broken', got.unresolved.length + ' model' + (got.unresolved.length > 1 ? 's' : '')
            + ' never converted: ' + got.unresolved.slice(0, 3).join(', ')];
  if (!got.fx && !got.missile) return ['none', 'the cast emits no effect at all'];
  return ['ok', got.fx + ' effect' + (got.fx > 1 ? 's' : '') + (got.missile ? ' + missile' : '')];
}

// --------------------------------------------------------------------- verdict
function judge(exp, got) {
  if (!got) return ['error', 'could not spawn the hero'];
  if (got.cast !== 'ok') return ['error', 'cast refused: ' + got.cast];
  const did = new Set();
  if (got.damage > 0 || got.splash > 0) did.add('damage');
  if (got.summon > 0) did.add('summon');
  if (got.stun > 0) did.add('stun');
  if (got.slow) did.add('slow');
  if (got.silence) did.add('silence');
  if (got.healed > 0) did.add('heal');
  if (got.casterBuff.length) did.add('buff');
  // A tooltip that says a hero "becomes" something and one that says his power
  // "rises" are describing the same transformation, so a form change satisfies
  // a promised buff -- it is the largest stat change the game can make.
  if (got.morph) did.add('buff');
  // a few units of drift is the engine settling the unit, not a reposition
  if (got.moved > 100) did.add('blink');
  if (got.morph) did.add('morph');

  const want = [...exp.kinds];
  if (!want.length) return did.size ? ['ok', 'acts; the tooltip says nothing specific'] : ['unknown', 'tooltip says nothing specific'];
  const hit = want.filter((k) => did.has(k));
  if (!did.size) return ['missing', 'tooltip promises ' + want.join('/') + '; nothing observed'];
  if (!hit.length) return ['mismatch', 'tooltip promises ' + want.join('/') + '; saw ' + [...did].join('/')];

  // numbers, where the tooltip gave one
  const notes = [];
  if (exp.damage > 0 && (got.damage + got.splash) > 0) {
    const ratio = (got.damage + got.splash) / exp.damage;
    if (ratio < 0.34 || ratio > 3) notes.push(`damage ${got.damage + got.splash} vs ${exp.damage} stated`);
  }
  if (exp.summon > 0 && got.summon !== exp.summon && got.summon > 0)
    notes.push(`summoned ${got.summon} vs ${exp.summon} stated`);
  if (exp.stun > 0 && got.stun > 0 && Math.abs(got.stun - exp.stun) > 1.5)
    notes.push(`stun ${got.stun}s vs ${exp.stun}s stated`);
  if (exp.cooldown != null && got.cooldown > 0 && Math.abs(got.cooldown - exp.cooldown) > Math.max(2, exp.cooldown * 0.25))
    notes.push(`cooldown ${got.cooldown}s vs ${exp.cooldown}s stated`);

  if (hit.length < want.length)
    notes.unshift('no ' + want.filter((k) => !did.has(k)).join('/') + ' seen');
  if (notes.length) return ['partial', notes.join('; ')];
  return ['ok', ''];
}

// ------------------------------------------------------------------------ run
const rows = [];
for (const hero of GAME.heroes) {
  for (const a of hero.abilities) {
    if (rows.length >= MAX) break;
    const ab = A.entry(a.id);
    const passive = !ab || A.isPassive(ab);
    const exp = expect(a.descEn || a.desc || '');
    let got = null, verdict = 'passive', why = 'not castable';
    let artVerdict = 'n/a', artWhy = '';
    if (!passive) {
      got = measure(hero, a, ab);
      [verdict, why] = judge(exp, got);
      [artVerdict, artWhy] = judgeArt(got);
    }
    rows.push({
      hero: hero.name, heroId: hero.id, id: a.id, base: ab ? A.baseOf(ab) : '',
      name: a.nameEn || a.name || a.id,
      desc: (a.descEn || a.desc || '').split('\n')[0],
      bullets: (a.descEn || a.desc || '').split('\n').filter((l) => l.startsWith('◎')),
      passive,
      expects: [...exp.kinds], expDamage: exp.damage, expSummon: exp.summon,
      expStun: exp.stun, expCooldown: exp.cooldown,
      got, verdict, why, artVerdict, artWhy,
    });
    process.stderr.write(
      `[${String(rows.length).padStart(3)}/130] ${((Date.now() - T0) / 1000).toFixed(1)}s ` +
      `units=${world.units.size} ${hero.name.slice(0, 12)} ${a.id} -> ${verdict}/${artVerdict}\n`);
  }
  if (rows.length >= MAX) break;
}

if (JSON_OUT) {
  fs.writeFileSync('data/spell_check.json', JSON.stringify(rows, null, 1));
  console.log('wrote data/spell_check.json (%d abilities)', rows.length);
} else {
  const by = {}, byArt = {};
  for (const r of rows) {
    by[r.verdict] = (by[r.verdict] || 0) + 1;
    byArt[r.artVerdict] = (byArt[r.artVerdict] || 0) + 1;
  }
  console.log('%d hero abilities audited against their own tooltips', rows.length);
  console.log('  does it do what it says');
  for (const [k, v] of Object.entries(by).sort((a, b) => b[1] - a[1]))
    console.log('   ' + k.padEnd(10) + String(v).padStart(3));
  console.log('  does it show anything');
  for (const [k, v] of Object.entries(byArt).sort((a, b) => b[1] - a[1]))
    console.log('   ' + k.padEnd(10) + String(v).padStart(3));
  console.log('\nworth a look:');
  for (const r of rows) {
    if (['ok', 'passive'].includes(r.verdict) && ['ok', 'n/a'].includes(r.artVerdict)) continue;
    console.log('  ' + r.verdict.padEnd(9) + (r.artVerdict === 'ok' ? '   ' : r.artVerdict.slice(0, 3)).padEnd(7)
      + r.hero.slice(0, 15).padEnd(16)
      + r.id.padEnd(6) + r.name.slice(0, 28).padEnd(29)
      + (r.why || r.artWhy));
  }
}
