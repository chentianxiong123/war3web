// What the client does with cinematic mode and a queued animation.
//
// CinematicModeBJ brackets every match's 3-2-1 countdown. In Warcraft III the
// interface fades, letterbox bars close in and the player can do nothing until
// it lifts; QueueUnitAnimation is what plays when a scripted one-shot ends,
// and without it a scripted "spell" used to hold its last frame for good.
// Both are asserted on the rendered page rather than on a flag: the bars'
// rectangles, the HUD's computed opacity, whether an order actually leaves
// the client, which clip the mixer is on.
//
//   PORT=8077 node tools/cinemode_test.mjs
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
         '--disable-dev-shm-usage', `--user-data-dir=.tmp/chrome-cine-${process.pid}`,
         '--disable-crash-reporter', '--disable-breakpad', '--no-first-run'],
  defaultViewport: { width: 1200, height: 800 },
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message)));
await page.goto(`http://127.0.0.1:${PORT}/?room=cine${process.pid}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => document.getElementById('loading').classList.contains('hidden'), { timeout: 90000 });
await page.evaluate(() => {
  const c = [...document.querySelectorAll('.hcard:not(.nomodel)')];
  (c[0] || document.querySelector('.hcard')).click();
});
await wait(700);
await page.$eval('#btnReady', (b) => b.click());
await page.waitForFunction(() => !document.getElementById('hud').classList.contains('hidden'), { timeout: 60000 });
await wait(6000);                                   // the hero's model has to be in

// ----------------------------------------------------------- cinematic mode
const shape = () => page.evaluate(() => {
  const hud = document.getElementById('hud');
  const top = document.querySelector('#letterbox .top').getBoundingClientRect();
  const bot = document.querySelector('#letterbox .bottom').getBoundingClientRect();
  return { cls: document.body.classList.contains('cinematic'),
           hudOpacity: +getComputedStyle(hud).opacity,
           topBottom: top.bottom, botTop: bot.top, h: innerHeight };
});
const before = await shape();
check('the interface is up and the bars are off screen',
      !before.cls && before.hudOpacity === 1 && before.topBottom <= 0 && before.botTop >= before.h,
      JSON.stringify(before));
await page.evaluate(() => { window.FOC.S.cinematic = true; window.FOC.ui.setCinematic(true, 0.2); });
await wait(600);
const during = await shape();
check('cinematic mode fades the interface out', during.cls && during.hudOpacity === 0, `opacity ${during.hudOpacity}`);
check('and closes letterbox bars in from both edges',
      during.topBottom > 40 && during.botTop < during.h - 40,
      `top bar to ${during.topBottom.toFixed(0)}, bottom bar from ${during.botTop.toFixed(0)} of ${during.h}`);

// control is off: a hotkey that would send an order sends nothing
await page.evaluate(() => {
  window.__sent = [];
  const orig = window.FOC.net.send.bind(window.FOC.net);
  window.FOC.net.send = (m) => { window.__sent.push(m.t); orig(m); };
});
const press = (key) => page.evaluate((k) => {
  addEventListener('keydown', () => {}, { once: true });
  dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
}, key);
await press('h');
await wait(200);
const sentIn = await page.evaluate(() => window.__sent.filter((t) => t === 'hold').length);
check('a hold order pressed during the cinematic never leaves the client', sentIn === 0, `${sentIn} sent`);
await page.evaluate(() => { window.FOC.S.cinematic = false; window.FOC.ui.setCinematic(false, 0.2); });
await wait(600);
await press('h');
await wait(200);
const sentOut = await page.evaluate(() => window.__sent.filter((t) => t === 'hold').length);
check('and the same key works again once it lifts', sentOut === 1, `${sentOut} sent`);
const after = await shape();
check('the interface and the bars come back', !after.cls && after.hudOpacity === 1 && after.topBottom <= 0 && after.botTop >= after.h);

// ----------------------------------------------------------- queued animation
const clips = await page.evaluate(() => {
  const V = window.FOC.view, id = window.FOC.S.hero?.id;
  const v = id != null && V.views.get(id);
  if (!v || !v.actions) return null;
  const once = [...v.actions.keys()].filter((k) => !/^(stand|walk|death|decay|birth)/.test(k));
  const dur = (k) => v.actions.get(k).getClip().duration;
  return { id, once, durs: Object.fromEntries(once.map((k) => [k, dur(k)])), stand: [...v.actions.keys()].filter((k) => /^stand/.test(k)) };
});
check('the hero has one-shot clips to script', !!clips && clips.once.length >= 2, clips ? clips.once.slice(0, 4).join(', ') : 'no view');
if (clips && clips.once.length >= 2) {
  const [a, b] = clips.once;
  const msA = Math.ceil(clips.durs[a] * 1000) + 700;
  // queued: the second clip follows the first when it ends
  await page.evaluate((id, a, b) => { const V = window.FOC.view; V.playUnitAnim(id, a); V.queueUnitAnim(id, b); }, clips.id, a, b);
  await wait(250);
  const mid = await page.evaluate((id) => window.FOC.view.views.get(id).current, clips.id);
  check('a scripted clip plays', mid === a, `${mid}`);
  // polled rather than waited out: the queued clip can be shorter than the
  // first, and by a fixed deadline it may already have ended and gone to stand
  let then = null;
  for (let t = 0; t < msA + 1500 && !(then && then.cur !== a); t += 50) {
    await wait(50);
    then = await page.evaluate((id) => { const v = window.FOC.view.views.get(id); return { cur: v.current, q: v.queuedAnim }; }, clips.id);
  }
  check('and the queued clip follows it when it ends', then && then.cur === b && then.q == null, JSON.stringify(then));
  // unqueued: the unit returns to its own stand rather than freezing
  const msB = Math.ceil(clips.durs[b] * 1000) + 700;
  await wait(msB);
  await page.evaluate((id, a) => window.FOC.view.playUnitAnim(id, a), clips.id, a);
  await wait(msA);
  const back = await page.evaluate((id) => { const v = window.FOC.view.views.get(id); return { cur: v.current, scripted: v.scripted, running: !!v.currentAction?.isRunning() }; }, clips.id);
  check('a scripted one-shot with nothing queued returns to stand',
        /^stand/.test(back.cur) && back.scripted === false && back.running, JSON.stringify(back));
}

check('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));
await browser.close();
const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
