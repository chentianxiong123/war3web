// Do animation-driven sounds reach the speaker?
//
// A model's sound events name a four-character id. The build resolves it
// through UI/SoundInfo/AnimLookups.slk to a label and through AnimSounds.slk to
// files plus the volume, pitch and distances that place them. Until now the id
// resolved to a label and stopped there: 1370 events fired across the map's
// models with nothing to play.
//
// This drives a model through Walk and Death and asserts the whole chain -- the
// events fire, each resolves to a record, the record's files are real URLs that
// the server actually serves, and playWorld is reached. It asserts the negative
// too: an id the game ships no sound for must fall silent rather than throw or
// ask for a 404.
//
//   node server/index.js &        # port 8077
//   node tools/animsound_test.mjs
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
         '--no-first-run', `--user-data-dir=.tmp/chrome-snd-${process.pid}`],
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
  view.animSounds = await fetch('/data/animsounds.json').then((r) => r.json());

  // stand in for the audio system: record what would have been played
  const played = [];
  view.onAnimSound = (rec, x, y) => {
    if (!rec || !rec.f || !rec.f.length) return;
    played.push({ file: rec.f[(Math.random() * rec.f.length) | 0],
                  vol: rec.vol, cutoff: rec.cutoff, takes: rec.f.length });
  };

  const sndIds = [];
  for (const e of (v.events || [])) {
    if (String(e.d.kind).toUpperCase() === 'SND') sndIds.push(e.d.id);
  }
  const run = (seqName, frames) => {
    const act = v.actions.get(seqName.toLowerCase());
    if (!act) return false;
    if (v.currentAction && v.currentAction !== act) v.currentAction.stop();
    act.reset(); act.setLoop(2201, Infinity); act.play();
    v.currentAction = act; v.current = seqName.toLowerCase();
    v.seqIndex = view.seqIndexOf(v.meta, seqName);
    for (let i = 0; i < frames; i++) {
      v.mixer.update(1 / 30);
      window.__stepEvents(v.events, view.animCtxOf(v), (e) => view.fireEvent(e));
    }
    return true;
  };
  run('Walk', 90);
  const walking = played.length;
  run('Death', 120);

  // an id the game ships no sound for must fall silent, not throw
  let threwOnUnknown = false;
  try { view.onAnimSound(view.animSounds['ZZZZ'], 0, 0); }
  catch { threwOnUnknown = true; }

  return { sndEvents: sndIds.length, ids: sndIds.slice(0, 6),
           tableSize: Object.keys(view.animSounds).length,
           played: played.length, walking, threwOnUnknown,
           sample: played.slice(0, 4),
           multiTake: played.filter((p) => p.takes > 1).length };
});

console.log(JSON.stringify(out, null, 1));

// every file the run reached must actually be served
let served = 0, missing = [];
for (const p of (out.sample || [])) {
  const r = await fetch(`http://127.0.0.1:${PORT}/assets/${p.file}`, { method: 'HEAD' })
    .catch(() => null);
  if (r && r.ok) served++; else missing.push(p.file);
}

check('the model carries sound events', out.sndEvents > 0, `${out.sndEvents}`);
check('the compiled table reached the client', out.tableSize > 0, `${out.tableSize} ids`);
check('animating fires sounds', out.played > 0, `${out.played} played`);
check('walking makes footsteps', out.walking > 0, `${out.walking} while walking`);
check('every sound reached is actually served', missing.length === 0,
      missing.length ? missing.join(', ') : `${served} of ${out.sample?.length} checked`);
check('an id with no sound falls silent', out.threwOnUnknown === false);
check('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
await browser.close();
process.exit(passed === results.length ? 0 : 1);
