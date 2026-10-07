// Can you catch anything with the Monster Ball?
//
// I006 몬스터볼 carries A03V, and the map's trigger for it is a whole capture
// system: the target must be owned by Player(12) -- neutral hostile, so creeps
// only -- and at 30% life or less, then a GetRandomInt(0,'d') roll succeeds on
// 30 or under. On success the creep is hidden, paused, made over to the captor,
// and an I008 몬스터볼(포획상태) is put in his hands with SetItemUserData
// stamping which creep it holds. Using that ball lets the creep out 150 units
// in front of him; dropping it puts the creep back in; selling it destroys the
// creep outright.
//
// Every one of those four triggers finds its creep by looping n = 1..count and
// comparing GetItemUserData(ball) to n. Both natives were stubs -- one writing
// nothing, the other answering 0 -- so no iteration ever matched: capturing a
// creep hid it for good and paid out a ball that did nothing.
//
// The second half is reachability. A03V names a target, and nothing could cast
// an item ability at one: the six command slots are built from the hero's own
// castable list and useItem took no target at all. It is the only item on this
// map that aims at something, so this is one item's worth of behaviour.
//
// The last part needs a browser and a running server: whether the ball can be
// aimed at all is a client question.
//
//   node server/index.js &        # port 8077
//   node tools/monsterball_test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { World, id2int } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';
import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';

const PORT = process.env.PORT || 8077;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT = path.resolve(import.meta.dirname, '..');
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

// ---- the two items and the one aimed ability
const items = read('data/itemtypes.json');
const abils = read('data/abilities.json');
check('both balls exist', !!items.I006 && !!items.I008,
      `${items.I006?.name} / ${items.I008?.name}`);
check('the empty ball is a one-use aimed item',
      items.I006?.uses === 1 && (items.I006.abilities || []).includes('A03V'),
      `uses ${items.I006?.uses}, abilities ${JSON.stringify(items.I006?.abilities)}`);
check('its ability names a target',
      /nonhero/.test(abils.A03V?.targets || '') && !!abils.A03V?.order,
      `${abils.A03V?.targets} / order ${abils.A03V?.order}`);

const world = new World();
const eng = new JassEngine(world);
eng.load(); eng.boot();
const STEP = 1000 / 30;
for (let i = 0; i < 30; i++) { eng.update(STEP); world.step(); }

// Three items on the map carry an ability that names unit targets, and this
// is the only one the map itself listens for.
//
// This assertion used to read "the only aimed item on the map", and that was
// true only because tools/abilities.py read a target column that does not
// exist, so almost every ability compiled with an empty target list. With that
// fixed (2026-09-13) two more items report as aimed -- a Throwing Dagger
// carrying Storm Bolt and 해루석 carrying Soul Burn, both of which Warcraft III
// really does aim. The count was never the invariant; what this test needs is
// that the Monster Ball is aimed, because its capture trigger hangs off the
// spell events an aimed item fires.
const aimed = Object.keys(items).filter((id) => {
  const it = { abilities: items[id].abilities || [] };
  return !!world.itemSpell(it);
});
check('the Monster Ball is an aimed item', aimed.includes('I006'), aimed.join(' ') || 'none');
const jass = fs.readFileSync(path.join(ROOT, 'extracted/war3map.formatted.j'), 'utf8');
const listened = aimed.filter((id) => (items[id].abilities || [])
  .some((a) => new RegExp(`'${a}'`).test(jass)));
check('and the only aimed item the map has a spell trigger for',
      listened.length === 1 && listened[0] === 'I006', listened.join(' ') || 'none');

const hero = [...world.units.values()].find((u) => u.isHero && u.alive);
hero.playerIndex = 0; hero.team = 0;              // a player's hero, not tavern stock
const creep = [...world.units.values()].find(
  (u) => u.alive && !u.isHero && u.playerIndex === 12 && !u.isBuilding);
check('there is a creep to catch', !!creep, creep ? `${creep.typeKey} owned by 12` : 'none');

// ---- using the ball has to reach the map's capture trigger
const ball = world.createItem('I006', hero.x, hero.y);
world.giveItem(hero, ball);
check('the ball is carried and known to be aimed',
      hero.items.includes(ball) && world.itemSpell(ball) === 'A03V',
      `itemSpell ${world.itemSpell(ball)}`);

// at full life it must refuse: the map wants 30% or less
const errs0 = eng.errors.length;
world.useItem(hero, ball, creep);
check('a healthy creep cannot be caught', !creep.hidden,
      `at ${Math.round((creep.hp / creep.maxHp) * 100)}% life`);
check('and the script did not error', eng.errors.length === errs0, `${eng.errors.length - errs0} new`);

// ---- hurt it, then keep throwing: the roll is 30%
creep.hp = creep.maxHp * 0.2;
let throws = 0;
while (!creep.hidden && throws < 400) {
  throws++;
  const b = world.createItem('I006', hero.x, hero.y);
  world.giveItem(hero, b);
  world.useItem(hero, b, creep);
}
check('a hurt creep can be caught', creep.hidden === true, `${throws} throws at a 30% roll`);
check('and it is put away properly', creep.paused === true && creep.playerIndex === 0,
      `paused ${creep.paused}, owner ${creep.playerIndex}`);

const caught = (hero.items || []).find((it) => it.typeKey === 'I008');
check('the captor is handed a captured ball', !!caught, caught ? 'I008' : 'nothing');
check('and the ball remembers which creep it holds', !!caught && caught.userData > 0,
      caught ? `userData ${caught.userData}` : 'no ball');

// ---- using it lets the creep out in front of him
world.useItem(hero, caught);
check('using it lets the creep out', !creep.hidden && !creep.paused,
      `hidden ${creep.hidden}, paused ${creep.paused}`);
check('in front of the captor, and his',
      Math.abs(Math.hypot(creep.x - hero.x, creep.y - hero.y) - 150) < 40 &&
      creep.playerIndex === 0,
      `${Math.hypot(creep.x - hero.x, creep.y - hero.y).toFixed(0)} units away, owner ${creep.playerIndex}`);

// ---- dropping it puts the creep back in
world.dropItem(hero, caught);
check('dropping it puts the creep back in',
      creep.hidden === true && creep.paused === true && creep.invulnerable === true,
      `hidden ${creep.hidden}, paused ${creep.paused}, invulnerable ${creep.invulnerable}`);

// ---- and selling it destroys the creep
world.giveItem(hero, caught);
const before = world.units.has(creep.id);
world.pawnItem(hero, caught);
check('selling it destroys the creep', before && !world.units.has(creep.id),
      `${before ? 'was alive' : 'was gone already'}, now ${world.units.has(creep.id) ? 'still there' : 'removed'}`);

check('the whole run left the script clean', eng.errors.length === errs0,
      `${eng.errors.length - errs0} errors`);

// ---------------------------------------------------------------- the client
//
// An aimed item has to arm the cursor and then send what it hit. Sending on the
// first click, as every other item does, would throw the ball at nothing.
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
         '--disable-dev-shm-usage', '--disable-crash-reporter', '--disable-breakpad',
         '--no-first-run', `--user-data-dir=.tmp/chrome-ball-${process.pid}`],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
await page.evaluateOnNewDocument(() => localStorage.setItem('focs.name', 'Ball'));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => !document.getElementById('lobby').classList.contains('hidden'),
                           { timeout: 60000 });
await wait(1200);
await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.hcard:not(.nomodel)')];
  (cards[0] || document.querySelector('.hcard'))?.click();
});
await wait(600);
await page.$eval('#btnReady', (b) => b.click());
await page.waitForFunction(() => !document.getElementById('hud').classList.contains('hidden'),
                           { timeout: 60000 });
await wait(2000);

const out = await page.evaluate(() => {
  const { ui, S, net } = window.FOC;
  const sent = [];
  const real = net.send.bind(net);
  net.send = (m) => { sent.push(m); };            // catch it rather than play a match
  const cellOf = (n) => document.querySelectorAll('#inventory .islot')[n];
  // a plain item goes at once; an aimed one arms instead
  ui.renderInventory({ items: [
    { slot: 0, id: 'I006', name: 'Monster Ball', charges: 1, targeted: true },
    { slot: 1, id: 'I000', name: 'Potion', charges: 1 },
  ] });
  S.itemPending = null;
  cellOf(1).click();
  const plain = sent.slice();
  sent.length = 0;
  cellOf(0).click();
  const armedTo = S.itemPending;
  const armedSent = sent.slice();
  const cursor = document.getElementById('c')?.style.cursor
              || document.querySelector('canvas')?.style.cursor;
  // escape lets go of it
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  const afterEsc = S.itemPending;
  net.send = real;
  return { plain, armedTo, armedSent, cursor, afterEsc,
           hasHook: typeof ui.onAimItem === 'function' };
});

check('the client has an aiming hook for items', out.hasHook, `${out.hasHook}`);
check('a plain item is used on the first click',
      out.plain.length === 1 && out.plain[0].t === 'useItem' && out.plain[0].targetId === undefined,
      JSON.stringify(out.plain));
check('an aimed item arms instead of firing',
      out.armedTo === 0 && out.armedSent.length === 0,
      `itemPending ${out.armedTo}, sent ${JSON.stringify(out.armedSent)}`);
check('and the cursor says so', out.cursor === 'crosshair', `${out.cursor}`);
check('escape lets go of it', out.afterEsc === null, `${out.afterEsc}`);
const real = errs.filter((e) => !/404|portraits\//.test(e));
check('no console errors', real.length === 0, real.slice(0, 2).join(' | '));
await browser.close();

const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} checks passed`);
process.exit(bad ? 1 : 0);
