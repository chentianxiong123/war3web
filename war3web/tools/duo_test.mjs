// Two players, one room.
//
// Every other browser test in this repo opens a single page, and audit.mjs
// drives the world with no client at all -- so the multiplayer half of a
// multiplayer map had never been watched working. This seats two clients on
// opposite teams and asserts they can actually see each other: both heroes in
// both snapshots, distinct player colours on screen, movement propagating, chat
// arriving, and an item dropped by one appearing for the other.
//
//   node server/index.js &        # port 8077
//   node tools/duo_test.mjs
import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';

const PORT = process.env.PORT || 8077;
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
         '--disable-dev-shm-usage', `--user-data-dir=.tmp/chrome-duo-${process.pid}`,
         '--disable-crash-reporter', '--disable-breakpad', '--no-first-run',
         '--disable-features=ProcessSingleton', '--disable-gpu-sandbox'],
  defaultViewport: { width: 900, height: 600 },
});

/** A client sitting in the lobby with a hero chosen and a team joined. */
async function seat(label, cardIndex, team) {
  const page = await browser.newPage();
  page.errs = [];
  await page.setCacheEnabled(false);
  page.on('pageerror', (e) => page.errs.push(String(e.message)));
  page.on('console', (m) => { if (m.type() === 'error') page.errs.push(m.text()); });
  await page.evaluateOnNewDocument((n) => localStorage.setItem('focs.name', n), label);
  await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(() => !document.getElementById('lobby').classList.contains('hidden'),
                             { timeout: 30000 });
  await wait(1000);
  await page.evaluate((t) => window.FOC.net.send({ t: 'joinTeam', team: t }), team);
  await wait(300);
  const hero = await page.evaluate((i) => {
    const cards = [...document.querySelectorAll('.hcard:not(.nomodel)')];
    const c = cards[i] || cards[0];
    c && c.click();
    return c && c.querySelector('.nm')?.textContent;
  }, cardIndex);
  page.label = label;
  return { page, hero };
}

console.log(`two clients on :${PORT}`);
const A = await seat('Alpha', 0, 0);
const B = await seat('Bravo', 1, 1);
console.log(`  Alpha picked ${A.hero} | Bravo picked ${B.hero}`);

// the room starts only when every connected player is ready, so both must be
// seated before either readies
await A.page.$eval('#btnReady', (b) => b.click());
await wait(800);                         // let the server register one before the other
await B.page.$eval('#btnReady', (b) => b.click());

// Wait on the client's own phase rather than a CSS class -- the HUD un-hides on
// its own schedule and is not what "the game started" means -- and report what
// each side actually thinks if it never happens, rather than a bare timeout.
const phaseOf = (c) => c.page.evaluate(() => (window.FOC ? window.FOC.S.phase : 'no FOC'));
let started = false;
for (let i = 0; i < 60 && !started; i++) {
  started = (await phaseOf(A)) === 'playing' && (await phaseOf(B)) === 'playing';
  if (!started) await wait(1000);
}
if (!started) {
  console.log(`  FAIL  the room never started -- Alpha: ${await phaseOf(A)}, Bravo: ${await phaseOf(B)}`);
  await browser.close();
  process.exit(1);
}
await wait(9000);                        // let both settle and snapshots flow

console.log('\nwhat each client can see');
const view = (c) => c.page.evaluate(() => {
  const { S, FOC } = { S: window.FOC.S, FOC: window.FOC };
  const me = S.ents.get(S.hero?.id);
  const heroes = [...S.ents.values()].filter((e) => e.k === 1);
  return {
    myId: S.hero?.id ?? null,
    myTeam: me?.t ?? null,
    myColour: me?.c ?? null,
    heroesSeen: heroes.length,
    heroIds: heroes.map((h) => h.i),
    colours: heroes.map((h) => h.c),
    teams: heroes.map((h) => h.t),
    unitsSeen: S.ents.size,
    views: FOC.view.views.size,
  };
});
const a = await view(A), b = await view(B);
console.log('  Alpha:', JSON.stringify(a));
console.log('  Bravo:', JSON.stringify(b));

check('both clients reached the game', a.myId != null && b.myId != null);
check('the two heroes are distinct entities', a.myId !== b.myId, `${a.myId} vs ${b.myId}`);
check('Alpha can see Bravo', a.heroIds.includes(b.myId));
check('Bravo can see Alpha', b.heroIds.includes(a.myId));
check('they are on opposing teams', a.myTeam !== b.myTeam, `${a.myTeam} vs ${b.myTeam}`);
check('they wear different player colours', a.myColour !== b.myColour, `${a.myColour} vs ${b.myColour}`);
check('both clients built a view for both heroes', a.views > 1 && b.views > 1,
      `${a.views} / ${b.views}`);

// --- movement propagates
console.log('\nmovement');
const before = await B.page.evaluate((id) => {
  const e = window.FOC.S.ents.get(id); return e ? { x: e.x, y: e.y } : null;
}, a.myId);
await A.page.evaluate(() => {
  const S = window.FOC.S, me = S.ents.get(S.hero.id);
  window.FOC.net.send({ t: 'move', x: me.x + 600, y: me.y + 600 });
});
await wait(4000);
const after = await B.page.evaluate((id) => {
  const e = window.FOC.S.ents.get(id); return e ? { x: e.x, y: e.y } : null;
}, a.myId);
const moved = before && after ? Math.round(Math.hypot(after.x - before.x, after.y - before.y)) : 0;
check("Bravo sees Alpha move", moved > 50, `${moved} units`);

// --- chat propagates
console.log('\nchat');
await B.page.evaluate(() => { window.__heard = []; });
await B.page.evaluate(() => {
  const orig = window.FOC.ui.log.bind(window.FOC.ui);
  window.FOC.ui.log = (html, cls) => { window.__heard.push(String(html)); return orig(html, cls); };
});
await A.page.evaluate(() => window.FOC.net.send({ t: 'chat', text: 'ping from alpha' }));
await wait(2000);
const heard = await B.page.evaluate(() => window.__heard || []);
check('Bravo receives Alpha’s chat', heard.some((h) => h.includes('ping from alpha')),
      heard.length ? heard[heard.length - 1].slice(0, 60) : 'nothing logged');

// --- an item dropped by one is seen by the other
console.log('\nground items across clients');
// Gold comes from kills in this map -- there is no starting purse -- so Alpha
// has to earn the price of the cheapest thing that is not a powerup. The hero
// stops once its target dies, so keep pointing it at something.
const NEED = await A.page.evaluate(() => {
  const defs = window.FOC.S.game.items;
  const prices = window.FOC.S.game.shops.flatMap((s) => s.items)
    .filter((i) => !(defs[i.id] || {}).p).map((i) => i.gold);
  return prices.length ? Math.min(...prices) : 300;
});
const swing = () => A.page.evaluate(() => {
  const S = window.FOC.S, me = S.ents.get(S.hero.id);
  if (!me) return;
  let best = null, bd = Infinity;
  for (const e of S.ents.values()) {
    if (e.i === me.i || e.k === 3 || e.t === me.t || !e.a) continue;
    const d = Math.hypot(e.x - me.x, e.y - me.y);
    if (d < bd) { bd = d; best = e; }
  }
  if (best) window.FOC.net.send({ t: 'attack', targetId: best.i });
});
let gold = 0;
for (let i = 0; i < 60 && gold < NEED; i++) {
  if (i % 4 === 0) await swing();                  // re-target as things die
  await wait(1000);
  gold = await A.page.evaluate(() => window.FOC.S.hero?.gold ?? 0);
}
console.log(`  (Alpha needs ${NEED}g for the cheapest droppable item)`);
let itemDetail = `Alpha earned ${gold} gold`;
let itemPass = null;
if (gold >= NEED) {
  // a powerup is spent the moment it is bought and never occupies a slot, so
  // buying the cheapest thing on the shelf leaves nothing to drop
  const buy = await A.page.evaluate((budget) => {
    const defs = window.FOC.S.game.items;
    const all = window.FOC.S.game.shops.flatMap((s) => s.items)
      .filter((i) => !(defs[i.id] || {}).p && i.gold <= budget)
      .sort((x, y) => x.gold - y.gold);
    if (!all.length) return null;
    window.FOC.net.send({ t: 'buy', itemId: all[0].id });
    return { id: all[0].id, name: all[0].name, gold: all[0].gold };
  }, gold);
  await wait(1500);
  const carried = await A.page.evaluate(() => (window.FOC.S.hero?.items || []).filter(Boolean).length);
  await A.page.evaluate(() => window.FOC.net.send({ t: 'dropItem', slot: 0 }));
  await wait(2500);
  const seenByB = await B.page.evaluate(() => window.FOC.view.groundItems.size);
  const seenByA = await A.page.evaluate(() => window.FOC.view.groundItems.size);
  itemPass = seenByB > 0 && seenByA > 0;
  itemDetail = buy ? `bought ${buy.name} (${buy.gold}g), carried ${carried}, `
                     + `Alpha sees ${seenByA} / Bravo sees ${seenByB} on the ground`
                   : `nothing affordable that is not a powerup (${gold}g)`;
}
if (itemPass === null) console.log(`  skip  an item dropped by Alpha reaches Bravo  -- ${itemDetail}`);
else check('an item dropped by Alpha reaches Bravo', itemPass, itemDetail);

// --- nothing broke along the way
const errs = [...A.page.errs, ...B.page.errs].filter((e) => !e.includes('ERR_ABORTED'));
check('no console errors on either client', errs.length === 0, errs.slice(0, 2).join(' | '));

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
if (failed.length) { console.log('failed:', failed.map((f) => f.name).join('; ')); process.exit(1); }
