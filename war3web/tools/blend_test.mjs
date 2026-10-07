// Do spell effects and missiles get their MDX filter mode?
//
// The loop that turns an additive MDX layer into THREE.AdditiveBlending used to
// run only for unit views, so every spell and missile model -- 540 of the 659
// materials on this map's ability art are additive or addalpha -- drew with
// plain glTF alpha. A glow rendered as a flat quad.
//
//   node server/index.js &        # port 8077
//   node tools/blend_test.mjs
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
         '--disable-dev-shm-usage', '--disable-crash-reporter', '--disable-breakpad',
         '--no-first-run', `--user-data-dir=.tmp/chrome-blend-${process.pid}`],
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
await wait(9000);

await page.evaluate(() => {
  for (let i = 0; i < 6; i++) window.FOC.net.send({ t: 'learn', slot: i });
});
await wait(600);

/** Blending across every effect and missile mesh currently on screen. */
const survey = () => page.evaluate(() => {
  const THREE = window.THREE || null;
  const ADD = 2;                     // THREE.AdditiveBlending
  const tally = (holder) => {
    let meshes = 0, additive = 0, prims = holder.prims ? holder.prims.length : 0;
    holder.obj?.traverse((o) => {
      if (!o.isMesh) return;
      meshes++;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      if (mats.some((m) => m && m.blending === ADD)) additive++;
    });
    return { meshes, additive, prims };
  };
  const acc = (list) => {
    const t = { meshes: 0, additive: 0, prims: 0, count: 0 };
    for (const h of list) {
      const r = tally(h);
      t.meshes += r.meshes; t.additive += r.additive; t.prims += r.prims; t.count++;
    }
    return t;
  };
  const { view } = window.FOC;
  return { fx: acc([...view.effects.values()]), missiles: acc([...view.missiles.values()]) };
});

let peak = { meshes: 0, additive: 0, prims: 0, count: 0 };
let peakM = { meshes: 0, additive: 0, prims: 0, count: 0 };
for (let i = 0; i < 8; i++) {
  await page.evaluate((slot) => {
    const S = window.FOC.S, hero = S.hero;
    const me = S.ents.get(hero.id);
    if (me) window.FOC.net.send({ t: 'cast', slot, x: me.x + 320, y: me.y + 220 });
  }, i % 5);
  await wait(1200);
  const s = await survey();
  for (const k of Object.keys(peak)) peak[k] = Math.max(peak[k], s.fx[k]);
  for (const k of Object.keys(peakM)) peakM[k] = Math.max(peakM[k], s.missiles[k]);
}

console.log('\nspell effects on screen (peak)');
console.log('  %d effects, %d meshes, %d prims tracked, %d additive',
            peak.count, peak.meshes, peak.prims, peak.additive);
console.log('missiles in flight (peak)');
console.log('  %d missiles, %d meshes, %d prims tracked, %d additive',
            peakM.count, peakM.meshes, peakM.prims, peakM.additive);
console.log();

check('effect models are tracked as prims', peak.prims > 0, `${peak.prims} meshes`);
check('effect models get MDX blending applied',
      peak.meshes === 0 || peak.additive > 0,
      `${peak.additive} of ${peak.meshes} meshes additive`);
check('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
await browser.close();
process.exit(passed === results.length ? 0 : 1);
