// Selecting a shop takes over the console, the way Warcraft III does it.
//
// The shops in this map are the buildings inside each base -- five per side,
// mirrored: n000 스텟 상점, n001 아이템 상점, n00H and n00N 전용템 상점, and
// n013. Warcraft III does not open a window for one. Selecting the building
// replaces what the bottom bar shows: the portrait becomes the shop's model,
// the name and bars become the shop's, and the command card -- the same grid
// the hero's abilities sit in -- fills with its stock.
//
// It used to be a floating list on the 'b' key, which was wrong twice over.
// It is not what the game does, and four of this map's heroes bind an ability
// to 'b', so the ability table swallowed the key before the shop ever saw it --
// on those heroes the shop was simply unreachable. That last part is asserted
// here so it cannot come back.
//
//   node server/index.js &        # port 8077
//   node tools/shop_test.mjs
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

const PORT = process.env.PORT || 8077;
const fails = [];
let pass = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fails.push(name); console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
};

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
         '--disable-dev-shm-usage', '--disable-crash-reporter', '--disable-breakpad',
         '--no-first-run', `--user-data-dir=.tmp/chrome-shop-${process.pid}`],
  defaultViewport: { width: 1440, height: 900 },
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => document.getElementById('loading').classList.contains('hidden'),
                           { timeout: 120000 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Same entry the other browser tests use: click the lobby card by its own
// dataset id, give the server a moment to seat the pick, then ready up.
await page.evaluate(() => {
  const id = window.FOC.S.heroes?.[0]?.id;
  const card = [...document.querySelectorAll('.hcard')].find((c) => c.dataset.id === id);
  if (card) card.click(); else window.FOC.net.send({ t: 'pickHero', heroId: id });
});
await wait(600);
await page.$eval('#btnReady', (b) => b.click());
await page.waitForFunction(() => !document.getElementById('hud').classList.contains('hidden'),
                           { timeout: 120000 });
await page.waitForFunction(() => (window.FOC.S.hero?.abilities || []).length > 0, { timeout: 60000 });
await wait(3000);                              // let the first snapshots land

// ---- the shops are real buildings on the field
const found = await page.evaluate(() => {
  const S = window.FOC.S;
  const ents = [...S.ents.values()];
  const shops = ents.map((e) => ({ e, sh: window.FOC.shopFor(e) })).filter((x) => x.sh);
  return {
    declared: (S.game?.shops || []).length,
    onField: shops.length,
    types: [...new Set(shops.map((x) => x.e.u))].sort(),
    buildings: shops.every((x) => x.e.k === 3),
    sample: shops[0] ? { id: shops[0].e.i ?? shops[0].e.id, u: shops[0].e.u,
                         name: shops[0].sh.name, items: shops[0].sh.items.length } : null,
  };
});
console.log(`\n-- ${found.onField} shop buildings on the field, ${found.declared} types declared`);
check('the map declares its shops', found.declared === 5, `${found.declared}`);
check('and both bases have them on the field', found.onField >= 10, `${found.onField}`);
check('every one is a building', found.buildings === true);
check('all five types are present',
      ['n000', 'n001', 'n00H', 'n00N', 'n013'].every((t) => found.types.includes(t)),
      found.types.join(' '));

// ---- the hero's own card, before anything is selected
const before = await page.evaluate(() => ({
  cells: document.querySelectorAll('#abilities .slot').length,
  name: document.getElementById('pname2').textContent,
}));
check('the card starts on the hero\'s abilities', before.cells > 0, `${before.cells} cells`);

// ---- select a shop through the same predicate the click uses
const after = await page.evaluate(() => {
  const S = window.FOC.S;
  const hit = [...S.ents.values()].map((e) => ({ e, sh: window.FOC.shopFor(e) })).find((x) => x.sh);
  window.FOC.ui.selectShop(hit.e, hit.sh);
  window.FOC.showUnitPortrait();
  const cells = [...document.querySelectorAll('#abilities .slot')];
  return {
    want: hit.sh.items.length,
    cells: cells.length,
    priced: cells.filter((c) => /\d+g/.test(c.textContent)).length,
    icons: cells.filter((c) => (c.style.backgroundImage || '') !== 'none'
                            && c.style.backgroundImage).length,
    name: document.getElementById('pname2').textContent,
    shopName: hit.sh.name,
    stats: document.getElementById('stats').textContent,
    inventory: document.querySelectorAll('#inventory .islot').length,
  };
});
console.log(`\n-- selected ${JSON.stringify(after.shopName)}`);
check('the command card becomes the shop\'s stock', after.cells === after.want,
      `${after.cells} cells for ${after.want} items`);
check('every cell carries its price', after.priced === after.want,
      `${after.priced} of ${after.want}`);
check('and its icon', after.icons === after.want, `${after.icons} of ${after.want}`);
check('the name panel becomes the shop\'s', after.name.includes(after.shopName),
      JSON.stringify(after.name));
check('the stat block shows the stock and the gold to spend',
      /STOCK/.test(after.stats) && /GOLD/.test(after.stats), after.stats.slice(0, 60));
// Warcraft III leaves the inventory up while shopping -- it is the only way to
// see whether there is room for what you are about to buy.
check('the inventory stays visible', after.inventory === 6, `${after.inventory} slots`);

// ---- the cells are laid into the console's own grid, not stacked loose
const laid = await page.evaluate(() => {
  const r = [...document.querySelectorAll('#abilities .slot')].map((c) => c.getBoundingClientRect());
  const card = document.getElementById('abilities').getBoundingClientRect();
  return { n: r.length, positioned: r.filter((b) => b.width > 8 && b.height > 8).length,
           distinct: new Set(r.map((b) => `${Math.round(b.left)},${Math.round(b.top)}`)).size,
           card: { w: Math.round(card.width), h: Math.round(card.height) } };
});
check('the stock is laid into the card\'s measured cells, each with a size',
      laid.positioned === laid.n && laid.n > 0, `${laid.positioned}/${laid.n}`);
check('and no two items share a cell', laid.distinct === laid.n, `${laid.distinct}/${laid.n}`);

// ---- clicking a cell buys that item
const bought = await page.evaluate(() => {
  const sent = [];
  const net = window.FOC.net, real = net.send.bind(net);
  net.send = (m) => { sent.push(m); return real(m); };
  const cell = document.querySelector('#abilities .slot');
  cell.click();
  net.send = real;
  const S = window.FOC.S;
  const hit = [...S.ents.values()].map((e) => ({ e, sh: window.FOC.shopFor(e) })).find((x) => x.sh);
  return { sent, firstItem: hit.sh.items[0].id };
});
const buy = bought.sent.find((m) => m.t === 'buy');
check('clicking a cell sends a buy for that item',
      !!buy && buy.itemId === bought.firstItem,
      JSON.stringify(bought.sent) + ' want ' + bought.firstItem);

// ---- and the console goes back to the hero
const back = await page.evaluate(() => {
  window.FOC.ui.clearShop();
  window.FOC.showUnitPortrait();
  const cells = [...document.querySelectorAll('#abilities .slot')];
  return { cells: cells.length,
           commands: cells.filter((c) => c.dataset.command).length,
           stock: cells.filter((c) => c.classList.contains('shopitem')).length,
           name: document.getElementById('pname2').textContent };
});
// Counted by command rather than by a printed hotkey letter: the classic
// console draws none, and this check passed on its absence for as long as the
// stock left behind kept the cell count above zero.
check('clearing the selection restores the hero\'s abilities',
      back.commands > 0, `${back.commands} of ${back.cells} cells carry a command`);
// The card reconciles on data-command and the stock carries none, so every item
// but the last survived the trip back -- 17 cells, five of them still for sale
// underneath the hero's own buttons.
check('and the shop\'s stock is gone from the card', back.stock === 0,
      `${back.stock} item cells left of ${back.cells}`);
check('and the hero\'s name comes back', !back.name.includes(after.shopName),
      JSON.stringify(back.name));

// ---- the bug that made this necessary
// From the compiled table rather than the lobby payload: the lobby strips
// `hotkey` from its ability entries, so asking the browser gives a confident 0.
const GAME = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/game.json'), 'utf8'));
const onB = GAME.heroes.filter((h) => (h.abilities || [])
  .some((a) => String(a.hotkey || '').toLowerCase() === 'b'));
const bkey = { total: GAME.heroes.length, onB: onB.length, names: onB.map((h) => h.id) };
console.log(`\n   ${bkey.onB} of ${bkey.total} heroes bind an ability to 'b': ${bkey.names.join(' ')}`);
check('the hotkey collision that broke the old shop is real',
      bkey.onB > 0, `${bkey.onB} heroes bind 'b'`);
// The fix is that shopping is reachable by selection and needs no key at all.
// Pressing 'b' must now do nothing shop-shaped, and there must be no overlay
// left for it to open.
const bDoes = await page.evaluate(() => {
  const before = document.querySelectorAll('#abilities .slot').length;
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }));
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }));
  return { overlay: !!document.getElementById('shop'),
           cellsBefore: before,
           cellsAfter: document.querySelectorAll('#abilities .slot').length,
           shopSel: !!window.FOC.ui.shopSel };
});
check('the b-key overlay is gone entirely', bDoes.overlay === false);
check('and pressing b no longer changes the card',
      bDoes.cellsBefore === bDoes.cellsAfter && bDoes.shopSel === false,
      `${bDoes.cellsBefore} -> ${bDoes.cellsAfter}, selected ${bDoes.shopSel}`);

// ---- a shop is not an enemy
//
// Reported from play: the heroes attack the shop. Nothing was ever damaged --
// world.hostile refuses Neutral Passive, so the swing could not land -- but the
// client classified a shop as an enemy and offered the order, and the hero ran
// at the building. The cause was comparing TEAMS: a shop sits on player 15's
// team 2 while the heroes are on teams 0 and 1.
const rel = await page.evaluate(() => {
  const S = window.FOC.S;
  const hit = [...S.ents.values()].map((e) => ({ e, sh: window.FOC.shopFor(e) })).find((x) => x.sh);
  const me = S.ents.get(S.hero?.id);
  return { shop: window.FOC.relationTo(hit.e), shopTeam: hit.e.t, myTeam: me?.t,
           shopPlayer: hit.e.p };
});
console.log(`\n   shop on player ${rel.shopPlayer}, team ${rel.shopTeam}; hero team ${rel.myTeam}`);
check('a shop reads as neutral, not as an enemy', rel.shop === 'neutral', rel.shop);
// The teams really do differ -- so this check would pass vacuously if the shop
// happened to share the hero's team, and it does not.
check('and it is not neutral merely because the teams match',
      rel.shopTeam !== rel.myTeam, `${rel.shopTeam} vs ${rel.myTeam}`);

check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | '));
await browser.close();
console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
