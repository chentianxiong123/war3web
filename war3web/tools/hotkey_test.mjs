// Does an ability bind to the key the *map* gives it?
//
// war3map.w3a assigns every hero ability a hotkey ('ahky'); 109 of the 130
// declare one. The client used a fixed Q/W/E/R/D/F row instead, so on most
// heroes the letter printed on the button and the key that cast were different
// keys -- and T, B, V and C, which four heroes' abilities ask for, could not be
// pressed at all.
//
// The assertion that matters is the one that could have failed before: press
// the key the server says an ability uses, and see that *that* ability casts.
// Checking only that a label renders would pass on the old build too.
//
//   node server/index.js &        # port 8077
//   node tools/hotkey_test.mjs
import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';

const PORT = process.env.PORT || 8077;
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
         '--disable-dev-shm-usage', '--disable-crash-reporter', '--disable-breakpad',
         '--no-first-run', `--user-data-dir=.tmp/chrome-hotkey-${process.pid}`],
  defaultViewport: { width: 1280, height: 860 },
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => !document.getElementById('lobby').classList.contains('hidden'),
                           { timeout: 60000 });

// Byakuya Kuchiki, deliberately: the map gives his six abilities C Q W E B V,
// so slot 0 must bind C and not Q. Under the old fixed row it was labelled Q,
// bound to Q, and C did nothing -- a hero that fails loudly if this regresses.
// HERO overrides it; the lobby filters by tavern, so the tabs are walked.
const HERO = process.env.HERO || 'H00N';
const picked = await page.evaluate((id) => {
  const find = () => document.querySelector(`.hcard[data-id="${id}"]`);
  if (find()) { find().click(); return id; }
  for (const tab of [...document.querySelectorAll('#tavtabs button')]) {
    tab.click();
    if (find()) { find().click(); return id; }
  }
  const c = [...document.querySelectorAll('.hcard:not(.nomodel)')];
  (c[0] || document.querySelector('.hcard'))?.click();
  return null;
}, HERO);
if (picked !== HERO) console.log(`NOTE: ${HERO} not found, fell back to the first hero`);
await new Promise((r) => setTimeout(r, 600));
await page.$eval('#btnReady', (b) => b.click());
await page.waitForFunction(() => !document.getElementById('hud').classList.contains('hidden'),
                           { timeout: 60000 });
await page.waitForFunction(() => window.FOC?.S?.hero?.abilities?.length > 0, { timeout: 60000 });

const info = await page.evaluate(() => {
  const h = window.FOC.S.hero;
  return {
    hero: h.name,
    abilities: h.abilities.map((a) => ({ slot: a.slot, id: a.id, hotkey: a.hotkey, key: a.key })),
  };
});
console.log(JSON.stringify(info, null, 1));

// ---- the server actually sends the map's hotkey
const declared = info.abilities.filter((a) => a.hotkey);
check('the hero payload carries the map\'s hotkeys', declared.length > 0,
      `${declared.length}/${info.abilities.length} abilities declare one`);

// ---- every ability resolves to some key, and no two share one
const keys = info.abilities.map((a) => a.key).filter(Boolean);
check('every ability resolves to a key', keys.length === info.abilities.length,
      `${keys.length}/${info.abilities.length}`);
check('no two abilities share a key', new Set(keys).size === keys.length,
      keys.join(' '));

// ---- a declared hotkey is honoured rather than overridden by position
const honoured = declared.every((a) => a.key === a.hotkey.trim().toLowerCase());
check('a declared hotkey is the key that binds', honoured,
      declared.map((a) => `${a.hotkey}->${a.key}`).join(' '));

// ---- and pressing it casts THAT ability
//
// Level the hero first so something is castable, then press each ability's own
// key and see which slot the client tried to cast.
await page.evaluate(() => window.FOC.net.send({ t: 'debugLevel' }));
await new Promise((r) => setTimeout(r, 1200));
await page.evaluate(() => {
  const h = window.FOC.S.hero;
  for (const a of h.abilities) if (a.lvl < 1) window.FOC.net.send({ t: 'learn', slot: a.slot });
});
await new Promise((r) => setTimeout(r, 1200));

const fired = await page.evaluate(async () => {
  const S = window.FOC.S, net = window.FOC.net;
  const sent = [];
  const realSend = net.send.bind(net);
  net.send = (m) => { if (m.t === 'cast') sent.push(m.slot); return realSend(m); };
  const out = [];
  for (const a of S.hero.abilities) {
    if (a.lvl < 1 || !a.key) continue;
    sent.length = 0;
    S.castPending = null;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: a.key, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: a.key, bubbles: true }));
    await new Promise((r) => setTimeout(r, 60));
    // a point/unit spell arms castPending instead of sending immediately
    const slot = sent.length ? sent[0] : S.castPending;
    out.push({ key: a.key, want: a.slot, got: slot === undefined ? null : slot });
    S.castPending = null;
  }
  net.send = realSend;
  return out;
});
console.log('key -> slot:', JSON.stringify(fired));

const tried = fired.filter((f) => f.got !== null);
check('pressing a key reached the cast path', tried.length > 0,
      `${tried.length}/${fired.length} keys produced a cast`);
check('each key casts its OWN ability', tried.length > 0 && tried.every((f) => f.got === f.want),
      tried.map((f) => `${f.key}:${f.want}${f.got === f.want ? '' : '!=' + f.got}`).join(' '));

// ---- the button says which key casts it
//
// Classic Warcraft III prints no letter on the command button; the hotkey is
// named in the tooltip, and that is where the card puts it. This ran against an
// overlay the HUD drew until it was matched to the classic console, and passed
// on an empty string once that overlay went away. Read after the hero is
// levelled, because an unlearned ability is not on the card to carry a tooltip.
const tips = await page.evaluate(() => {
  const out = [];
  window.FOC.S.hero.abilities.forEach((a, i) => {
    if (a.lvl < 1 || !a.key) return;
    const n = document.querySelector(`#abilities .slot[data-command="ability-${i}"]`);
    out.push({ key: a.key, tip: n ? n.dataset.tooltip : null });
  });
  return out;
});
const named = tips.filter((t) => (t.tip || '').includes(`(${t.key.toUpperCase()})`));
check('the button names the key that casts it',
      tips.length > 0 && named.length === tips.length,
      `${named.length}/${tips.length} -- ` + tips.map((t) => `${t.key}:${(t.tip || 'no button').split('\n')[0]}`).join(' | '));

// A missing hero portrait 404s on purpose -- the card's onerror falls back to
// the unit's original Warcraft III icon -- so those are not failures.
const real = errs.filter((e) => !/404|portraits\//.test(e));
check('no console errors', real.length === 0, real.slice(0, 2).join(' | '));

// the point of the whole change: at least one ability binds a key the old
// fixed Q/W/E/R/D/F row could never have produced
const POS = ['q', 'w', 'e', 'r', 'd', 'f'];
const moved = info.abilities.filter((a, i) => a.key && a.key !== POS[i]);
check('a hotkey the fixed row could not produce is bound', moved.length > 0,
      moved.map((a) => `slot${a.slot} ${POS[a.slot]}->${a.key}`).join(' ') || 'none differ');

await browser.close();
const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} checks passed`);
process.exit(bad ? 1 : 0);
