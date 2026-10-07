// Screenshot units as the game builds them: PORT=8077 node tools/model_shot.mjs Byakuya2 Enel2
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';
const PORT = process.env.PORT || 8077;
const OUT = process.env.OUT || '.tmp';
const want = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
         // a fresh profile every run: chromium's disk cache will otherwise keep
         // serving the copy of the page it had before the last edit, and
         // setCacheEnabled does not clear what is already in there
         '--disable-dev-shm-usage', `--user-data-dir=.tmp/chrome-mv-${process.pid}`,
         '--disable-crash-reporter', '--disable-breakpad', '--no-first-run',
         '--disable-features=ProcessSingleton', '--disable-gpu-sandbox'],
  defaultViewport: { width: 520, height: 640 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('  PAGEERROR', e.message));
// These pages are edited between runs and the profile directory persists, so
// chromium will happily serve the copy it cached before the edit.
await page.setCacheEnabled(false);
await page.goto(`http://127.0.0.1:${PORT}/tools/modelview.html`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => window.ready === true, { timeout: 120000 });
for (const m of want) {
  let info;
  try {
    info = await page.evaluate((m) => window.showUnit(m, 0), m);
  } catch (e) {
    console.log(JSON.stringify({ model: m, error: String(e.message).split('\n')[0] }));
    continue;
  }
  await new Promise((r) => setTimeout(r, 700));
  const shot = await page.evaluate(() => window.grab(520, 640));
  fs.writeFileSync(`${OUT}/model_${m}.png`, Buffer.from(shot.uri.split(',')[1], 'base64'));
  console.log(JSON.stringify({ ...info, lit: shot.lit, of: shot.of }));
}
await browser.close();
