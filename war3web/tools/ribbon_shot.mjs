// Do ribbons actually draw?
//
// A ribbon is only visible while the bone it hangs from is moving, so this
// plays each model's attack animation and compares the frame against the same
// model standing still. The difference is the trail.
//
//   node server/index.js &          # port 8077
//   node tools/ribbon_shot.mjs kisame Byakuya2 SandWaveMissile
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';

const PORT = process.env.PORT || 8077;
const OUT = process.env.OUT || '.tmp';
const want = process.argv.slice(2);

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
         '--disable-dev-shm-usage', `--user-data-dir=${OUT}/chrome-rib-${process.pid}`,
         '--disable-crash-reporter', '--disable-breakpad', '--no-first-run',
         '--disable-features=ProcessSingleton', '--disable-gpu-sandbox'],
  defaultViewport: { width: 520, height: 640 },
});
const page = await browser.newPage();
await page.setCacheEnabled(false);
page.on('pageerror', (e) => console.log('  PAGEERROR', e.message));
await page.goto(`http://127.0.0.1:${PORT}/tools/modelview.html`,
                { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => window.ready === true, { timeout: 120000 });

for (const m of want) {
  let info;
  try { info = await page.evaluate((x) => window.showUnit(x, 0), m); }
  catch (e) { console.log(JSON.stringify({ model: m, error: String(e.message).split('\n')[0] })); continue; }
  await new Promise((r) => setTimeout(r, 700));

  // a ribbon only exists while its bone is moving, so swing before measuring
  const swung = await page.evaluate(() => window.ribbonContribution('attack', 1.0));
  const shot = await page.evaluate(() => window.grab(520, 640));
  fs.writeFileSync(`${OUT}/ribbon_${m}.png`, Buffer.from(shot.uri.split(',')[1], 'base64'));
  console.log(JSON.stringify({ model: m, tris: info.tris, ...swung }));
}
await browser.close();
