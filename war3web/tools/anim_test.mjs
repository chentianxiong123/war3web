// Does the client pick animations the way Warcraft III does?
//
// The old pickClip held a literal table of sequence names and returned the first
// exact match, so 416 of the 588 models this map places had stand variants that
// were unreachable for the entire game -- including the "Stand Work" that the
// war mill's `work smoke` and the ammo dump's fire are keyed to.
//
// Selection is now by token set, weighted by each sequence's own `rarity`. This
// watches a live scene long enough for the variants to come round and asserts
// three things: variants are actually reached, buildings can reach Stand Work,
// and units never do.
//
//   node server/index.js &        # port 8077
//   node tools/anim_test.mjs
import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';

const PORT = process.env.PORT || 8077;
const SECONDS = +(process.env.SECONDS || 45);
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
         '--disable-dev-shm-usage', '--disable-crash-reporter', '--disable-breakpad',
         '--no-first-run', `--user-data-dir=.tmp/chrome-anim-${process.pid}`],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
await page.setCacheEnabled(false);
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => !document.getElementById('lobby').classList.contains('hidden'),
                           { timeout: 40000 });
await wait(1000);
await page.evaluate(() => document.querySelector('.hcard')?.click());
await wait(500);
await page.$eval('#btnReady', (x) => x.click());
await page.waitForFunction(() => window.FOC && window.FOC.S.phase === 'playing', { timeout: 60000 });
await wait(8000);

// record every clip each view plays over the window
await page.evaluate(() => {
  window.__seen = new Map();          // model -> {building, clips:Set}
  window.__tick = () => {
    for (const v of window.FOC.view.views.values()) {
      if (!v.current || !v.meta) continue;
      const key = v.meta.name || '?';
      let e = window.__seen.get(key);
      if (!e) { e = { building: !!v.isBuilding, clips: new Set() }; window.__seen.set(key, e); }
      e.clips.add(v.current);
    }
  };
  window.__timer = setInterval(window.__tick, 200);
});
console.log('watching a live scene for %ds...', SECONDS);
await wait(SECONDS * 1000);

const out = await page.evaluate(() => {
  clearInterval(window.__timer);
  const rows = [];
  for (const [model, e] of window.__seen) {
    rows.push({ model, building: e.building, clips: [...e.clips] });
  }
  return rows;
});

const varied = out.filter((r) => r.clips.length > 1);
const bWork = out.filter((r) => r.building && r.clips.some((c) => /\bwork\b/.test(c)));
const uWork = out.filter((r) => !r.building && r.clips.some((c) => /\bwork\b/.test(c)));

console.log('\n%d models observed, %d played more than one clip', out.length, varied.length);
for (const r of varied.slice(0, 10)) {
  console.log('  %-46s %s  %s', r.model.slice(0, 46),
              r.building ? 'building' : 'unit    ', r.clips.join(' | '));
}
console.log('\nbuildings that reached a work animation: %d', bWork.length);
for (const r of bWork.slice(0, 8)) console.log('  %s', r.model.slice(0, 60));

check('animation variants are reachable at all', varied.length > 0,
      `${varied.length} models cycled variants`);
check('units never play a work animation', uWork.length === 0,
      uWork.length ? uWork.map((r) => r.model).slice(0, 3).join(', ') : 'none did');
check('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
await browser.close();
process.exit(passed === results.length ? 0 : 1);
