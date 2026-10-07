// Do MDX event objects fire, and does a death leave blood on the ground?
//
// An event object names a kind and an id -- SPLxHBS1 is Human Blood Small 1 --
// and its KEVT track says when in the animation it happens. The converter used
// to discard those times, so nothing could ever fire: 814 of this map's models
// carry events and none of them did anything. A spider died and left nothing.
//
// This drives a model through its death sequence and counts what lands.
//
//   node server/index.js &        # port 8077
//   node tools/event_test.mjs
import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';

const PORT = process.env.PORT || 8077;
const MODEL = process.env.MODEL || 'units~creeps~spider~spider';
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
         '--disable-dev-shm-usage', '--disable-crash-reporter', '--disable-breakpad',
         '--no-first-run', `--user-data-dir=.tmp/chrome-ev-${process.pid}`],
  defaultViewport: { width: 520, height: 640 },
});
const page = await browser.newPage();
await page.setCacheEnabled(false);
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });

await page.goto(`http://127.0.0.1:${PORT}/tools/modelview.html`,
                { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => window.ready === true, { timeout: 120000 });
await page.evaluate((m) => window.showUnit(m, 0), MODEL);
await new Promise((r) => setTimeout(r, 2000));

const out = await page.evaluate(async () => {
  const view = window.view;
  const v = [...view.views.values()][0];
  if (!v) return { error: 'nothing spawned' };
  // the bench page has no terrain, so give the field somewhere to put things
  if (!view.splatField) {
    const { SplatField } = await import('/js/splats.js');
    view.splatField = new SplatField(view.scene, view.splatTable || {},
      () => 0, (uri) => view.fxTexture(uri));
  }
  const kinds = {};
  for (const e of (v.events || [])) {
    const k = String(e.d.kind).toUpperCase();
    kinds[k] = (kinds[k] || 0) + 1;
  }
  const fired = [];
  const orig = view.fireEvent.bind(view);
  view.fireEvent = (e) => { fired.push(String(e.d.kind).toUpperCase()); orig(e); };

  const run = (seqName, frames) => {
    const act = v.actions.get(seqName.toLowerCase());
    if (!act) return false;
    if (v.currentAction && v.currentAction !== act) v.currentAction.stop();
    act.reset(); act.setLoop(2201, Infinity); act.play();
    v.currentAction = act; v.current = seqName.toLowerCase();
    v.seqIndex = view.seqIndexOf(v.meta, seqName);
    for (let i = 0; i < frames; i++) {
      v.mixer.update(1 / 30);
      const ctx = view.animCtxOf(v);
      window.__stepEvents(v.events, ctx, (e) => view.fireEvent(e));
    }
    return true;
  };
  const before = fired.length;
  const ranWalk = run('Walk', 90);
  const walkFired = fired.length - before;
  const mid = fired.length;
  const ranDeath = run('Death', 120);
  const deathFired = fired.length - mid;

  return { events: (v.events || []).length, kinds,
           ranWalk, walkFired, ranDeath, deathFired,
           splatsOnGround: view.splatField.live.length,
           tableSize: Object.keys(view.splatTable || {}).length,
           firedKinds: [...new Set(fired)] };
});

console.log(JSON.stringify(out, null, 1));
check('the model carries event objects', out.events > 0, `${out.events}`);
check('the splat table reached the client', out.tableSize > 0, `${out.tableSize} types`);
check('walking fires events (footsteps)', !out.ranWalk || out.walkFired > 0,
      `${out.walkFired} fired`);
check('dying fires events', !out.ranDeath || out.deathFired > 0, `${out.deathFired} fired`);
check('something is left on the ground', out.splatsOnGround > 0,
      `${out.splatsOnGround} splats`);
check('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
await browser.close();
process.exit(passed === results.length ? 0 : 1);
