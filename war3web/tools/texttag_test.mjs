// Does floating text appear, and does it say what the map told it to?
//
// It did not. CreateTextTag returned an inert handle, the only thing that ever
// emitted was DestroyTextTag -- backwards, since 22 of the map's 48 tags are
// permanent and are never destroyed at all -- and the client's addFloater
// pushed into an array nothing read. Nothing reached the screen: not the spell
// shouts over a caster, not the duel arena's 3-2-1-Fight, not "Winner is
// <hero>", not the lane and base labels.
//
// The trap this test is built to avoid is the one the old sound test fell into:
// asserting a function was called rather than that anything happened. So the
// second half draws through the real Overlay onto a real canvas and reads the
// pixels back. "A tag was registered" is not "text is on screen".
//
// The numbers come from Blizzard.j, which the port runs verbatim:
//   TextTagSize2Height   size  * 0.023 / 10     -> the 0.8 x 0.6 screen box
//   TextTagSpeed2Velocity speed * 0.071 / 128   -> the same box, per second
// The map never calls a text tag native itself. All 48 sites are the World
// Editor's own action group: CreateTextTag{Loc,Unit}BJ, then for 26 of them
// velocity, permanent, lifespan and fadepoint.
//
//   node server/index.js &        # port 8077
//   node tools/texttag_test.mjs
import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';
import { World, id2int } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';
import { testHeroes } from './testheroes.mjs';

const PORT = process.env.PORT || 8077;
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// ---------------------------------------------------------------- the server
console.log('the map, booted:');
const world = new World();
const eng = new JassEngine(world);
eng.load();
eng.boot();
for (let i = 0; i < 300; i++) eng.update(1000 / 30);   // 10s: let init settle
const tags = eng.flushClientEvents().filter((e) => e.t === 'texttag');

check('the map\'s own init makes text tags', tags.length > 0, `${tags.length} sent`);

// Every one of these is created by CreateTextTagLocBJ at size 20, 15 or 14, and
// TextTagSize2Height is the only thing that turns a size into a height.
const heights = [...new Set(tags.map((t) => +t.h.toFixed(6)))].sort();
check('height is size * 0.023 / 10, not the raw size',
      heights.every((h) => [20, 15, 14].some((s) => near(h, s * 0.023 / 10, 1e-9))),
      heights.join(' '));

const red = tags.find((t) => /RED\|r TEAM/.test(t.s));
const blue = tags.find((t) => /BLUE\|r TEAM/.test(t.s));
check('the base markers survive with their colour codes intact',
      !!red && !!blue && red.s.includes('|c00ff0000') && blue.s.includes('|c000000ff'),
      red ? `${JSON.stringify(red.s)} ${JSON.stringify(blue?.s)}` : 'not found');

// transparency 50 -> PercentTo255(100 - 50) = R2I(50 * 2.55) = 127
const half = tags.filter((t) => t.c[3] === 127);
check('SetTextTagColorBJ\'s transparency reaches the alpha', half.length > 0,
      `${half.length} tags at alpha 127 (transparency 50)`);

check('the scenery labels are permanent, so they are kept for a late joiner',
      tags.every((t) => t.perm) && eng.liveTags().length === tags.length,
      `${eng.liveTags().length} live of ${tags.length}`);

// The other 26 are the transient ones, and the biggest group of them is the
// shout over a caster: the map's spell trigger is CreateTextTagUnitBJ of
// GetObjectName(GetSpellAbilityId()) + " !!" at size 13, in a random colour,
// then velocity 80 at 90 degrees, lifespan 1.5 and fadepoint 0.65. A real cast
// is the only thing that proves that path, so this casts one.
// world.step() drains the world's own event queue and returns it, so anything
// looking for a world event has to take it from here rather than flush after.
const worldEvents = [];
const tickBoth = (secs) => {
  for (let i = 0; i < Math.round(secs * 30); i++) {
    eng.update(1000 / 30);
    worldEvents.push(...world.step());
  }
};
const { caster, target } = testHeroes();
const A = world.sellUnit(world.tavernFor(caster.id), eng.players[0], caster.id);
const B = world.sellUnit(world.tavernFor(target.id), eng.players[5], target.id);
const spellTags = [];
if (A && B) {
  for (const aid of caster.learnable) {
    world.addAbility(A, id2int(aid));
    world.setAbilityLevel(A, id2int(aid), 3);
  }
  world.moveUnit(B, 0, 0); world.moveUnit(A, 200, 0);
  A.mana = A.maxMana = 5000;
  eng.flushClientEvents();
  // Where the caster stood as the trigger ran. The tag is a position, not an
  // attachment, so it must be this and not wherever the hero has walked to by
  // the time the shout fades -- nor where it was ORDERED from: a spell whose
  // target is out of range is walked into range first, and the shout goes up
  // where the cast lands, at the effect.
  let at = null;
  const effect = world.castEffect.bind(world);
  world.castEffect = (u) => { if (u === A) at = { x: A.x, y: A.y }; effect(u); };
  for (const aid of caster.learnable) {
    world.castAbility(A, id2int(aid), B, B.x, B.y);
    at = { x: A.x, y: A.y };
    tickBoth(1.2);
    for (const e of eng.flushClientEvents().filter((e) => e.t === 'texttag'))
      spellTags.push({ ...e, at });
    A.cooldowns.clear(); A.mana = A.maxMana;
    if (!B.alive) world.reviveUnit(B, B.x, B.y);
  }
}
// The shout is GetObjectName(GetSpellAbilityId()) + " !!", and GetObjectName
// used to read the id as a unit type -- which an ability id never is -- so
// every shout in the game was the two characters " !!" with no spell in front.
check('casting a spell shouts its name over the caster',
      spellTags.length > 0 && spellTags.every((t) => /\S/.test(t.s.replace('!!', ''))),
      spellTags.map((t) => JSON.stringify(t.s)).slice(0, 3).join(' '));
check('the shout is transient, and drifts',
      spellTags.length > 0 && spellTags.every((t) => !t.perm && t.life > 0 && t.vy > 0),
      spellTags[0] ? `life=${spellTags[0].life} fade=${spellTags[0].fade} ` +
                     `vy=${spellTags[0].vy} h=${spellTags[0].h}` : '');
check('and it stands where the caster was, not where it ends up',
      spellTags.length > 0 && spellTags.every((t) => t.x === t.at.x && t.y === t.at.y),
      spellTags[0] ? `tag ${spellTags[0].x.toFixed(0)},${spellTags[0].y.toFixed(0)} ` +
                     `at cast ${spellTags[0].at.x.toFixed(0)},${spellTags[0].at.y.toFixed(0)} ` +
                     `-- caster now ${A.x.toFixed(0)},${A.y.toFixed(0)}` : '');

// The engine's own bounty text. The map turns it on with eight
// SetPlayerFlagBJ(PLAYER_STATE_GIVES_BOUNTY, true, Player(0..7)) calls in its
// init, and Warcraft III floats the gold it just paid over the body for the
// killing player alone.
check('the map turns bounty on for the eight playable slots',
      [0, 1, 2, 3, 4, 5, 6, 7].every((i) => world.playerState(eng.players[i], 7) === 1),
      `0-7 = ${[0,1,2,3,4,5,6,7].map((i) => world.playerState(eng.players[i], 7)).join('')}`);
// Blizzard.j turns Neutral Victim off with the comment "Neutral Victim does not
// give bounties", and you only turn off what defaults on -- which is how we know
// neutral aggressive, who owns every creep on this map, defaults ON. Gating on
// the flag alone and defaulting everyone to off is what made creep kills silent.
check('neutral aggressive gives bounty by default, neutral victim does not',
      world.playerState(eng.players[12], 7) === 1 &&
      world.playerState(eng.players[13], 7) === 0,
      `p12=${world.playerState(eng.players[12], 7)} p13=${world.playerState(eng.players[13], 7)}`);

const killFor = (victim) => {
  worldEvents.length = 0;
  const before = world.playerOf(A).gold;
  world.moveUnit(A, victim.x + 80, victim.y);
  world.damage(A, victim, 1e9, { raw: true });
  tickBoth(0.2);
  return { ev: worldEvents.find((e) => e.t === 'bounty'),
           paid: Math.round(world.playerOf(A).gold - before) };
};

let creepKill = null, heroKill = null, shopKill = null;
if (A && B) {
  const creep = [...world.units.values()]
    .find((u) => u.alive && u.playerIndex === 12 && !u.isHero);
  creepKill = creep ? killFor(creep) : null;
  check('killing a creep floats the gold it paid', 
        !!creepKill?.ev && creepKill.ev.gold === creepKill.paid && creepKill.paid > 0,
        creepKill?.ev ? `+${creepKill.ev.gold} to player ${creepKill.ev.player}`
                      : `paid ${creepKill?.paid}, no text`);

  heroKill = killFor(B);
  check('killing a hero floats its 500', 
        !!heroKill?.ev && heroKill.ev.gold === heroKill.paid && heroKill.paid === 500,
        heroKill?.ev ? `+${heroKill.ev.gold}` : `paid ${heroKill?.paid}, no text`);
  if (!B.alive) world.reviveUnit(B, B.x, B.y);

  // Neutral passive owns the shops and fountains and is not flagged, so it pays
  // without printing -- which is the flag doing its job rather than a gap.
  const shop = [...world.units.values()]
    .find((u) => u.alive && u.playerIndex === 15 && !u.isHero);
  shopKill = shop ? killFor(shop) : null;
  check('a kill on an unflagged owner pays but prints nothing',
        !shopKill || !shopKill.ev, shopKill?.ev ? 'it printed' : 'silent');
}

// Every figure of the bounty tag comes from UI/MiscData.txt's BountyText block,
// via tools/gameplay.py: colour 255,220,0 opaque, drift 0.03/s, 3s, fade at 2s.
const bt = creepKill?.ev?.tag || heroKill?.ev?.tag;
check('the bounty tag carries MiscData.txt\'s own settings',
      !!bt && JSON.stringify(bt.color) === JSON.stringify([255, 220, 0, 255]) &&
      bt.vx === 0 && bt.vy === 0.03 && bt.life === 3 && bt.fade === 2,
      bt ? JSON.stringify(bt) : 'no tag data');

// The engine's own combat text. The server already found both of these and
// emitted them; the client dropped them on the floor, so all that was ever
// missing was the number. Driven through stepAttack the way proc_test does,
// with Math.random pinned so the roll is not a coin toss.
if (A && B) {
  A.dmgDice = 0; A.dmgSides = 1; A.missileSpeed = 0;
  const realRandom = Math.random;
  const swing = (roll) => {
    Math.random = () => roll;
    // The crit swing is lethal at this hero's level, and setting hp on a dead
    // unit does not bring it back -- stepAttack then has nothing to swing at.
    if (!B.alive) world.reviveUnit(B, B.x, B.y);
    B.hp = B.maxHp; A.atkTimer = 0; A.x = B.x + 10; A.y = B.y;
    A.order = { type: 'attack', targetId: B.id };
    world.flushEvents();
    world.stepAttack(A);
    // Advance through the authored attack windup before inspecting impact.
    for (let i = 0; A.attackWindup && i < 300; i++) world.stepAttack(A);
    Math.random = realRandom;
    return world.flushEvents();
  };
  world.addAbility(A, id2int('AOcr'));            // Blade Master Critical Strike
  world.setAbilityLevel(A, id2int('AOcr'), 3);
  const critEv = swing(0).find((e) => e.t === 'crit');
  check('a critical strike floats its damage, in MiscData.txt\'s colour',
        !!critEv && critEv.n > 0 &&
        JSON.stringify(critEv.tag?.color) === JSON.stringify([255, 0, 0, 255]) &&
        critEv.tag.life === 5 && critEv.tag.fade === 2,
        critEv ? JSON.stringify(critEv) : 'no crit event');

  world.addAbility(B, id2int('AIev'));            // Evasion, on the defender
  world.setAbilityLevel(B, id2int('AIev'), 3);
  const missEv = swing(0).find((e) => e.t === 'miss');
  // The word is localisable and lives in UI/FrameDef/GlobalStrings.fdf as
  // MISS "miss", so it is read rather than spelled out in the client.
  check('an evaded attack floats the game\'s own word for it',
        !!missEv && missEv.tag?.text === 'miss' && missEv.tag.life === 3,
        missEv ? JSON.stringify(missEv) : 'no miss event');
}

// A tag configured over several calls must be sent once, finished -- not once
// per setter, and not empty at the moment of creation.
const N = eng.vm.natives;
const call = (n, ...a) => N.get(n)(...a);
eng.flushClientEvents();
const tt = call('CreateTextTag');
call('SetTextTagText', tt, 'Fight !!', 30 * 0.023 / 10);
call('SetTextTagPos', tt, 512, -256, 0);
call('SetTextTagColor', tt, 255, 0, 0, 255);
call('SetTextTagVelocity', tt, 0, 80 * 0.071 / 128);
call('SetTextTagPermanent', tt, false);
call('SetTextTagLifespan', tt, 1.5);
call('SetTextTagFadepoint', tt, 0.65);
const one = eng.flushClientEvents().filter((e) => e.t === 'texttag');
check('a tag configured over eight calls is sent once, finished',
      one.length === 1 && one[0].s === 'Fight !!' && one[0].perm === false &&
      one[0].life === 1.5 && one[0].fade === 0.65 && near(one[0].vy, 80 * 0.071 / 128),
      one.length === 1 ? JSON.stringify(one[0]) : `${one.length} events`);

check('a tag with a lifespan is not kept to replay at a late joiner',
      !eng.liveTags().some((t) => t.s === 'Fight !!'));

call('DestroyTextTag', tt);
const gone = eng.flushClientEvents();
check('destroying a sent tag retracts it', gone.some((e) => e.t === 'texttagEnd' && e.tt === one[0].tt));

const tmp = call('CreateTextTag');
call('SetTextTagText', tmp, 'never seen', 0.023);
call('DestroyTextTag', tmp);
check('a tag created and destroyed in one tick is never sent at all',
      eng.flushClientEvents().filter((e) => e.t.startsWith('texttag')).length === 0);

// ---------------------------------------------------------------- the screen
console.log('\non screen:');
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
         '--disable-dev-shm-usage', '--disable-crash-reporter', '--disable-breakpad',
         '--no-first-run', `--user-data-dir=.tmp/chrome-texttag-${process.pid}`],
  defaultViewport: { width: 640, height: 640 },
});
const page = await browser.newPage();
await page.setCacheEnabled(false);
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
await page.goto(`http://127.0.0.1:${PORT}/tools/modelview.html`,
                { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => window.ready === true, { timeout: 120000 });

const out = await page.evaluate(async ({ redTag, blueTag }) => {
  const { Overlay } = await import('/js/overlay.js');
  const cv = document.createElement('canvas');
  document.body.appendChild(cv);
  const ov = new Overlay(cv);
  const view = window.view;

  // The bench page leaves its camera at the origin until a model is shown, and
  // a point directly above the origin projects to NaN from there. Put it where
  // the game's camera sits and look at the middle of the map.
  view.camera.position.set(0, 900, 900);
  view.camera.lookAt(0, 0, 0);
  view.camera.updateMatrixWorld(true);
  view.camera.matrixWorldInverse.copy(view.camera.matrixWorld).invert();

  // The canvas is the only witness. Everything below reads it back.
  const px = () => {
    const d = ov.ctx.getImageData(0, 0, cv.width, cv.height).data;
    let lit = 0, minY = 1e9, maxY = -1, sumA = 0;
    let reds = 0, blues = 0;
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3];
      if (a <= 8) continue;
      lit++; sumA += a;
      const y = Math.floor((i / 4) / cv.width);
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      // the shadow under the text is black, so only count coloured pixels
      if (d[i] > 120 && d[i + 1] < 90 && d[i + 2] < 90) reds++;
      if (d[i + 2] > 120 && d[i] < 90 && d[i + 1] < 90) blues++;
    }
    return { lit, minY, maxY, reds, blues, meanA: lit ? sumA / lit : 0 };
  };
  // draw() ages tags by wall clock, so a step is faked by rewinding `last`. It
  // clamps a single frame to 0.25s -- a backgrounded tab is not a tag that aged
  // a minute -- so a longer step is walked in frames the clamp will accept.
  const frame = (secs) => { ov.tags.last = performance.now() - secs * 1000;
                            ov.draw(view, new Map(), null); };
  const step = (secs) => {
    let left = secs;
    do { const d = Math.min(0.2, left); frame(d); left -= d; } while (left > 1e-9);
    return px();
  };

  const base = { t: 'texttag', x: 0, y: 0, z: 0, c: [255, 255, 255, 255],
                 vx: 0, vy: 0, life: 0, fade: 0, age: 0, perm: true, vis: true };

  // 1. does anything draw at all
  ov.tags.clear();
  ov.tags.set({ ...base, tt: 1, s: 'Fight !!', h: 30 * 0.023 / 10 });
  const drawn = step(0);

  // 2. an empty tag is not a blank rectangle, it is nothing
  ov.tags.clear();
  ov.tags.set({ ...base, tt: 2, s: '', h: 14 * 0.023 / 10 });
  const empty = step(0);

  // 3. size 20 draws taller than size 14, in the ratio the box gives.
  // `scale` is a deliberate taste knob set by eye from play, so it is pinned to
  // 1 here: what is under test is Blizzard.j's conversion, not the multiplier.
  ov.tags.scale = 1;
  ov.tags.clear();
  ov.tags.set({ ...base, tt: 3, s: 'Center', h: 20 * 0.023 / 10 });
  const big = step(0);
  ov.tags.clear();
  ov.tags.set({ ...base, tt: 4, s: 'Center', h: 14 * 0.023 / 10 });
  const small = step(0);

  // 4. the colour codes: red and blue must actually be red and blue
  ov.tags.clear();
  ov.tags.set({ ...base, tt: 5, s: redTag, h: 20 * 0.023 / 10 });
  const redPx = step(0);
  ov.tags.clear();
  ov.tags.set({ ...base, tt: 6, s: blueTag, h: 20 * 0.023 / 10 });
  const bluePx = step(0);

  // 5. velocity 80 at 90 degrees carries the text up the screen
  const spell = { ...base, tt: 7, s: 'Kaiten !!', h: 13 * 0.023 / 10,
                  perm: false, life: 1.5, fade: 0.65, vy: 80 * 0.071 / 128 };
  ov.tags.clear(); ov.tags.set(spell);
  const t0 = step(0.01);
  const t1 = step(0.6);

  // 6. past the fadepoint it dims, and at the lifespan it is gone
  ov.tags.clear(); ov.tags.set({ ...spell, tt: 8 });
  const bright = step(0.6);            // age 0.6, still short of fade 0.65
  const faded = step(0.6);             // age 1.2, 65% of the way through the fade
  const dead = step(0.5);              // age 1.7, past the 1.5 lifespan
  const stillThere = ov.tags.tags.size;

  // 7. a permanent tag outlives any lifespan. Aged directly rather than in 0.2s
  // frames, because two minutes of those is 600 draws to prove one thing.
  ov.tags.clear();
  ov.tags.set({ ...base, tt: 9, s: 'Top Left', h: 14 * 0.023 / 10 });
  ov.tags.tags.get(9).age = 120;
  const permanent = step(0.01);

  return { drawn, empty, big, small, redPx, bluePx, t0, t1,
           bright, faded, dead, stillThere, permanent };
}, { redTag: red?.s || '|c00ff0000RED|r TEAM', blueTag: blue?.s || '|c000000ffBLUE|r TEAM' });

check('text actually reaches the canvas', out.drawn.lit > 200, `${out.drawn.lit} lit pixels`);
check('an empty tag draws nothing', out.empty.lit === 0, `${out.empty.lit} lit pixels`);

// The height is a plain fraction of the viewport, so a size-20 tag is 0.046 of
// it: a 29px font in a 640px window, whose caps ink about 17-28px. The two ways
// to get this wrong land outside that band, and this window is what separates
// them -- dividing through by the 0.6-tall FDF box gives a 49px font (~39px of
// ink), which is what shipped first and was reported from play as far too big,
// and passing the raw size through gives 20px (~13px).
const bigH = out.big.maxY - out.big.minY, smallH = out.small.maxY - out.small.minY;
check('a size-20 tag is a plain fraction of the viewport',
      bigH >= 17 && bigH <= 28,
      `${bigH}px of ink in a 640px window; the 0.6 box would give ~39, a raw size ~13`);
check('and a size-14 tag is smaller in proportion',
      smallH < bigH && Math.abs(bigH / smallH - 20 / 14) < 0.25,
      `${bigH}px vs ${smallH}px = ${(bigH / smallH).toFixed(2)}, want ${(20 / 14).toFixed(2)}`);

check('|c00ff0000RED|r TEAM draws red pixels and no blue',
      out.redPx.reds > 20 && out.redPx.blues === 0,
      `${out.redPx.reds} red, ${out.redPx.blues} blue`);
check('|c000000ffBLUE|r TEAM draws blue pixels and no red',
      out.bluePx.blues > 20 && out.bluePx.reds === 0,
      `${out.bluePx.blues} blue, ${out.bluePx.reds} red`);

// Velocity 80 at 90 degrees is TextTagSpeed2Velocity(80) = 0.044375 of the
// viewport per second, so over 0.6s in a 640px window the text should climb
// 17px. Asserting the figure rather than "it moved" is what catches the drift
// being read in the wrong space -- the 0.6 box would carry it 28px.
const wantDrift = (80 * 0.071 / 128) * 0.6 * 640;
const gotDrift = out.t0.minY - out.t1.minY;
check('a tag with velocity climbs the screen, by the distance it should',
      Math.abs(gotDrift - wantDrift) <= 3,
      `${gotDrift}px over 0.6s, want ${wantDrift.toFixed(1)}px ` +
      `(y ${out.t0.minY} -> ${out.t1.minY})`);

check('it is opaque before the fadepoint and dimmer after',
      out.faded.meanA < out.bright.meanA * 0.75,
      `mean alpha ${out.bright.meanA.toFixed(0)} at age 0.6 -> ${out.faded.meanA.toFixed(0)} at 1.2`);
check('and gone at the end of its lifespan',
      out.dead.lit === 0 && out.stillThere === 0,
      `${out.dead.lit} lit pixels, ${out.stillThere} tags held`);
check('a permanent tag is still drawn two minutes later',
      out.permanent.lit > 100, `${out.permanent.lit} lit pixels`);

check('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
await browser.close();
process.exit(passed === results.length ? 0 : 1);
