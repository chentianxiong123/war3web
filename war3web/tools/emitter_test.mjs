// Do emitters obey the sequence they belong to?
//
// Warcraft III switches an emitter on for the sequences it belongs to and off
// for the rest -- 8594 of this map's 10381 keyed (emitter, sequence) pairs are
// "off for this whole sequence". The client used to ignore that and emit from
// everything, always, so idle units smoked, bled and trailed dust.
//
// This asserts the gate works in both directions: most emitters are quiet while
// their unit stands, and the map's own effects still emit. A gate that simply
// turned everything off would pass the first half and fail the second.
//
//   node server/index.js &        # port 8077
//   node tools/emitter_test.mjs
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
         '--no-first-run', `--user-data-dir=.tmp/chrome-emit-${process.pid}`],
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

/** Emitter state across the whole live scene. */
const survey = () => page.evaluate(() => {
  const { view } = window.FOC;
  const tally = (list) => {
    let total = 0, on = 0, live = 0, gated = 0;
    for (const e of list || []) {
      total++;
      // switched on by its track is not the same as emitting: an emitter whose
      // rate is zero for this sequence is visible and silent, and counting it
      // as active is how "the idle building throws 92 particles" gets reported
      if (e.n > 0) on++;
      if (Array.isArray(e.d?.vis)) gated++;
      // `n` is how many slots the emitter has ever used; a particle past its
      // life has alpha 0, so count the ones actually drawing something
      const alp = e.geo?.attributes?.palpha?.array;
      if (alp) for (let i = 0; i < e.n; i++) if (alp[i] > 0.01) live++;
    }
    return { total, on, live, gated };
  };
  let units = { total: 0, on: 0, live: 0, gated: 0 };
  for (const v of view.views.values()) {
    const t = tally(v.emitters);
    for (const k of Object.keys(units)) units[k] += t[k];
  }
  let fx = { total: 0, on: 0, live: 0, gated: 0 };
  for (const e of view.effects.values()) {
    const t = tally(e.emitters);
    for (const k of Object.keys(fx)) fx[k] += t[k];
  }
  // how many distinct sequences the scene is actually playing, so a result of
  // "everything is off" can be told apart from "nothing is animating"
  const seqs = new Set();
  for (const v of view.views.values()) if (v.current) seqs.add(v.current);
  return { units, fx, effects: view.effects.size, views: view.views.size,
           sequences: [...seqs] };
});

console.log('\nemitters on units, while the scene idles');
const a = await survey();
console.log('  %d views, %d emitters (%d carry a per-sequence switch)',
            a.views, a.units.total, a.units.gated);
console.log('  emitting right now: %d   live particles: %d', a.units.on, a.units.live);
console.log('  sequences playing: %s', a.sequences.join(', ') || '(none)');

check('the converter carried a per-sequence switch across',
      a.units.gated > 0, `${a.units.gated} of ${a.units.total} unit emitters`);
check('idle units do not emit from every emitter at once',
      a.units.total === 0 || a.units.on < a.units.total,
      `${a.units.on} of ${a.units.total} emitting`);

// ...but the gate must not simply be "off". Cast something and watch effects.
const before = a;
await page.evaluate(() => {
  const S = window.FOC.S, hero = S.hero;
  if (!hero) return;
  for (let i = 0; i < 6; i++) window.FOC.net.send({ t: 'learn', slot: i });
});
await wait(600);
let peak = { total: 0, on: 0, live: 0, gated: 0 }, peakFx = 0;
for (let i = 0; i < 6; i++) {
  await page.evaluate((slot) => {
    const S = window.FOC.S, hero = S.hero;
    const me = S.ents.get(hero.id);
    if (me) window.FOC.net.send({ t: 'cast', slot, x: me.x + 300, y: me.y + 200 });
  }, i % 4);
  // Sample across the cast rather than once at the end of it. A short effect is
  // born and gone inside a second, and `n` is a high-water mark of slots ever
  // used -- so one late sample reports emitters that "are emitting" with no
  // live particles left, which reads as a failure and is only a stale look.
  for (let k = 0; k < 7; k++) {
    await wait(200);
    const s = await survey();
    peakFx = Math.max(peakFx, s.effects);
    for (const kk of Object.keys(peak)) peak[kk] = Math.max(peak[kk], s.fx[kk]);
  }
}
console.log('\nwhile casting');
console.log('  peak effects on screen: %d', peakFx);
console.log('  peak effect emitters: %d, emitting: %d, live particles: %d',
            peak.total, peak.on, peak.live);

check('spell effects still spawn emitters', peak.total > 0, `${peak.total} at peak`);
check('spell effects still emit particles', peak.live > 0, `${peak.live} live at peak`);
check('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
await browser.close();
process.exit(passed === results.length ? 0 : 1);
