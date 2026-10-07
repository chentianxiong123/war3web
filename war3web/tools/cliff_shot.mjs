// Render the terrain and the baked cliff mesh on their own and screenshot a few
// angles: tools/cliffview.html builds only what tools/cliffs.py produces, so a
// bad cliff shows up without the rest of the game in the way.
//   PORT=8077 node tools/cliff_shot.mjs      (needs the server running)
import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';

const PORT = process.env.PORT || 8077;
const OUT = process.env.OUT || '.tmp';
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
         '--disable-dev-shm-usage', '--user-data-dir=.tmp/chrome',
         '--disable-crash-reporter', '--disable-breakpad', '--no-first-run',
         '--disable-features=ProcessSingleton', '--disable-gpu-sandbox'],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
const errs = [];
page.on('console', (m) => { console.log('  [console.'+m.type()+']', m.text()); if (m.type() === 'error') errs.push(m.text()); });
page.on('pageerror', (e) => { console.log('  [pageerror]', e.message); errs.push(e.message); });
page.on('requestfailed', (r) => errs.push('REQFAIL ' + r.url()));
page.on('response', (r) => { if (r.status() >= 400) errs.push(`HTTP ${r.status()} ${r.url()}`); });

await page.goto(`http://127.0.0.1:${PORT}/tools/cliffview.html`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForFunction(() => window.ready === true, { timeout: 30000 });
// swiftshader drops the context while the big ground texture uploads; wait it out
await new Promise((r) => setTimeout(r, 3000));
await page.waitForFunction(() => !window.view.renderer.getContext().isContextLost(), { timeout: 30000 });
console.log('stats:', await page.evaluate(() => window.stats));

// the two base ramps and the cliff walls flanking them, plus a wide overview
const shots = [
  ['overview',   0,     0,   7000, 1.15,  0.00],
  ['ramp_west', -2500, -530, 1100, 0.55,  0.90],
  ['ramp_east',  2500, -530, 1100, 0.55, -0.90],
  ['wall',      -2450, -512,  900, 0.55,  2.60],
  ['corner_nw', -3000,  900, 1600, 0.45,  0.40],
];
for (const [name, x, y, d, p, yaw] of shots) {
  await page.evaluate((x, y, d, p, yaw) => window.shoot(x, y, d, p, yaw), x, y, d, p, yaw);
  await new Promise((r) => setTimeout(r, 400));
  await page.evaluate((x, y, d, p, yaw) => window.shoot(x, y, d, p, yaw), x, y, d, p, yaw);
  await page.screenshot({ path: `${OUT}/cliff_${name}.png` });
  console.log('shot', name);
}
if (errs.length) { console.log('ERRORS:'); for (const e of errs.slice(0, 20)) console.log('  ', e); }
else console.log('no console errors');
await browser.close();
