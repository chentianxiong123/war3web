// What each visual layer actually contributes, per model.
//   node server/index.js &   # 8077
//   node tools/fx_audit.mjs kisame RedDragon ichigo3
import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';
const PORT = process.env.PORT || 8077;
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
         '--disable-dev-shm-usage', `--user-data-dir=.tmp/chrome-fxa-${process.pid}`,
         '--disable-crash-reporter', '--disable-breakpad', '--no-first-run',
         '--disable-features=ProcessSingleton', '--disable-gpu-sandbox'],
  defaultViewport: { width: 520, height: 640 },
});
const page = await browser.newPage();
await page.setCacheEnabled(false);
page.on('pageerror', (e) => console.log('  PAGEERROR', e.message));
await page.goto(`http://127.0.0.1:${PORT}/tools/modelview.html`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => window.ready === true, { timeout: 120000 });
for (const m of process.argv.slice(2)) {
  try { await page.evaluate((x) => window.showUnit(x, 0), m); }
  catch (e) { console.log(JSON.stringify({ model: m, error: String(e.message).split('\n')[0] })); continue; }
  await new Promise((r) => setTimeout(r, 800));
  const r = await page.evaluate(() => window.layerContribution('attack', 1.0));
  console.log(JSON.stringify({ model: m, ...r }));
}
await browser.close();
