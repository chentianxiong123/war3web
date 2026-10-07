// Is the world framed for the part of the screen the player can actually see?
//
// Warcraft III draws the world across the whole screen and lays the console over
// the bottom of it. ConsoleUI.fdf's bottom tiles are 0.176 of the game's
// 0.6-tall screen box -- 29.33% -- so the middle of the window is not the middle
// of what is visible. A camera framed for the whole window aims 14.7% of the
// screen too low: the hero sits crowded against the frame with the room above
// him wasted.
//
// The two things worth asserting are the two that could break:
//   - the camera's own target lands at the centre of the *visible* strip
//   - a click still lands on the unit it was aimed at, because the raycast has
//     to read the same shifted projection. Getting that wrong would put every
//     click 14.7% of the screen away from the thing under the cursor, which no
//     framing check would notice.
//
//   node server/index.js &        # port 8077
//   node tools/camfit_test.mjs
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
         '--no-first-run', `--user-data-dir=.tmp/chrome-camfit-${process.pid}`],
  defaultViewport: { width: 1440, height: 900 },
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => !document.getElementById('lobby').classList.contains('hidden'),
                           { timeout: 60000 });
await page.evaluate(() => {
  const c = [...document.querySelectorAll('.hcard:not(.nomodel)')];
  (c[0] || document.querySelector('.hcard'))?.click();
});
await new Promise((r) => setTimeout(r, 600));
await page.$eval('#btnReady', (b) => b.click());
await page.waitForFunction(() => !document.getElementById('hud').classList.contains('hidden'),
                           { timeout: 60000 });
await new Promise((r) => setTimeout(r, 9000));      // let the creeps spawn

const out = await page.evaluate(() => {
  const { view } = window.FOC;
  const p = view.camTarget.clone().project(view.camera);
  const frac = (1 - p.y) / 2;                       // 0 at the top of the screen

  // Every visible unit, projected to its own screen point and picked back.
  //
  // Landing on a *different* unit is not a miss when that one is drawn in
  // front: units overlap, and picking the nearest is what a click should do.
  // The failure this is looking for is a pick that lands on nothing, or on
  // something further away, which is what an unshifted raycast would produce.
  const cam = view.camera.position;
  const tried = [], hit = [], missed = [];
  for (const [id, v] of view.views) {
    if (!v.root.visible || v.locust || v.loading) continue;
    const w = v.root.position.clone(); w.y += 70;
    const s = w.clone().project(view.camera);
    if (Math.abs(s.x) > 0.95 || Math.abs(s.y) > 0.95) continue;
    tried.push(id);
    const got = view.pickEntity(s.x, s.y);
    if (got && got.id === id) { hit.push(id); continue; }
    const other = got && view.views.get(got.id);
    const mine = cam.distanceTo(v.root.position);
    if (other && cam.distanceTo(other.root.position) <= mine + 1) hit.push(id);
    else missed.push({ id, got: got?.id ?? null });
    if (tried.length >= 25) break;
  }
  return {
    consoleFrac: view.consoleFrac,
    hasViewOffset: !!view.camera.view?.enabled,
    targetFromTop: +frac.toFixed(4),
    stripCentre: +((1 - view.consoleFrac) / 2).toFixed(4),
    tried: tried.length, hit: hit.length, missed: missed.slice(0, 4),
  };
});
console.log(JSON.stringify(out, null, 1));

// the fraction is read off the console pieces, not written down in the client
check('the console height came from the layout', Math.abs(out.consoleFrac - 0.2933) < 0.002,
      `${out.consoleFrac} (ConsoleUI.fdf: 0.176 of a 0.6 screen = 0.2933)`);
check('the projection is shifted, not left centred', out.hasViewOffset === true);
check('the camera aims at the middle of what is visible',
      Math.abs(out.targetFromTop - out.stripCentre) < 0.005,
      `${out.targetFromTop} vs ${out.stripCentre} (window centre would be 0.5)`);
check('and that is above the window centre', out.targetFromTop < 0.48,
      `${out.targetFromTop} -- the old framing put it at 0.5`);
check('a click lands on the unit under it, or one in front of it',
      out.tried > 0 && out.hit === out.tried,
      `${out.hit}/${out.tried} picked` + (out.missed.length ? ' misses: ' + JSON.stringify(out.missed) : ''));
// A missing hero portrait 404s on purpose -- the lobby card's onerror falls
// back to the unit's original Warcraft III icon -- so those are not failures.
const real = errs.filter((e) => !/404|portraits\//.test(e));
check('no console errors', real.length === 0, real.slice(0, 2).join(' | '));

await browser.close();
const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} checks passed`);
process.exit(bad ? 1 : 0);
