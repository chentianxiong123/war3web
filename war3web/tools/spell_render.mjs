// Does the spell actually draw anything?
//
// tools/spell_check.mjs records the effect events every cast emits; this replays
// them into the renderer alone (tools/fxview.html) and counts how many pixels of
// the frame change. Nothing to do with the game loop -- just: given this art,
// does the client put something on screen.
//
//   node server/index.js &            # port 8077
//   node tools/spell_render.mjs       # rewrites data/spell_check.json in place
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';

const PORT = process.env.PORT || 8077;
const rows = JSON.parse(fs.readFileSync('data/spell_check.json', 'utf8'));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
         '--disable-dev-shm-usage', '--user-data-dir=.tmp/chrome-fx',
         '--disable-crash-reporter', '--disable-breakpad', '--no-first-run',
         '--disable-features=ProcessSingleton', '--disable-gpu-sandbox'],
  defaultViewport: { width: 640, height: 480 },
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(e.message));
// These pages are edited between runs and the profile directory persists, so
// chromium will happily serve the copy it cached before the edit.
await page.setCacheEnabled(false);
page.on('requestfailed', (r) => errs.push('REQFAIL ' + (r.failure()?.errorText || '?') + ' ' + r.url()));
page.on('response', (r) => { if (r.status() >= 400) errs.push('HTTP ' + r.status() + ' ' + r.url()); });

await page.goto(`http://127.0.0.1:${PORT}/tools/fxview.html`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => window.ready === true, { timeout: 180000 });
const baseLit = await page.evaluate(() => window.baseLit);
console.log('bench up: %d of 76800 pixels have ground in them', baseLit);
if (baseLit < 1000) {
  console.error('ABORT: the empty frame is black, so the GPU context never came up.');
  console.error('Every spell would read as invisible. Not writing results.');
  await browser.close();
  process.exit(2);
}

const t0 = Date.now();
let n = 0, drew = 0, blank = 0;
for (const r of rows) {
  const paths = r.got && r.got.models ? r.got.models : [];
  if (!r.got || r.got.cast !== 'ok') { r.render = null; continue; }
  if (!paths.length) {
    r.render = { spawned: 0, asked: 0, tris: 0, pixels: 0, note: 'the cast emits no art to draw' };
    blank++; n++;
    continue;
  }
  let res;
  try {
    res = await page.evaluate((p) => window.testFx(p), paths);
  } catch (e) {
    res = { spawned: 0, asked: paths.length, tris: 0, pixels: 0, note: 'bench error: ' + e.message };
  }
  r.render = res;
  n++;
  if (res.pixels > 40) drew++; else blank++;
  process.stderr.write(`[${String(n).padStart(3)}/${rows.length}] ${((Date.now() - t0) / 1000).toFixed(0)}s `
    + `${r.id} ${String(res.spawned)}/${res.asked} models ${res.tris} tris ${res.pixels}px\n`);
}
await browser.close();

fs.writeFileSync('data/spell_check.json', JSON.stringify(rows, null, 1));
console.log('%d casts rendered: %d put something on screen, %d drew nothing', n, drew, blank);
if (errs.length) {
  fs.writeFileSync('.tmp/render_errors.txt', [...new Set(errs)].join('\n'));
  const kinds = {};
  for (const e of new Set(errs)) { const k = e.split(' ').slice(0, 2).join(' '); kinds[k] = (kinds[k] || 0) + 1; }
  console.log('page errors by kind:', kinds, '-> .tmp/render_errors.txt');
}
