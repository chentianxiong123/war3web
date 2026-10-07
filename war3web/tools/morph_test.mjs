// Does a metamorphosis change what the player actually sees?
//
// Ichigo's Bankai (A00J) is a Chemical Rage-based morph: the ability names H00C
// as the normal form and O000 as the alternate one. O000 is the *same* imported
// model asking for a different animation set ("alternateex"), which is how one
// file holds both his Shikai and his Bankai -- Warcraft III has no native that
// changes a unit's model, so the alternate form is the change. The model's
// geoset animations then swap his body: geosets 1 and 3 in the normal
// sequences, 2 in the alternate ones.
//
// So this drives the real client and asserts the whole chain: the ability
// morphs the unit type, the type carries Required Animation Names, the renderer
// prefers the sequences those name, and the geosets on screen actually change.
//
//   PORT=8077 FOC_DEBUG=1 node server/index.js &
//   PORT=8077 node tools/morph_test.mjs
//
// FOC_DEBUG is required: Bankai is a level-10 skill and the level-to-cap key is
// the only way to get there without playing the match.
import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';
import fs from 'node:fs';

const PORT = process.env.PORT || 8077;
const HERO = 'H00C';                 // Ichigo Kurosaki
const ABIL = 'A00J';                 // 만해:천쇄참월 -- Bankai: Tensa Zangetsu
const FORM = 'O000';                 // the alternate form the ability names

const UM = JSON.parse(fs.readFileSync('public/data/unitmodels.json', 'utf8'));
const ABILS = JSON.parse(fs.readFileSync('data/abilities.json', 'utf8'));

let pass = 0, fail = 0;
const check = (ok, what, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? '  -- ' + detail : ''}`);
  ok ? pass++ : fail++;
};

// ---------------------------------------------------------------- the data
const lv0 = ABILS[ABIL]?.levels?.[0] || {};
check(lv0.unit === FORM, `${ABIL} names ${FORM} as its alternate form`, `unit=${lv0.unit}`);
const norm = UM[HERO] || {}, alt = UM[FORM] || {};
check(!!alt.an, `${FORM} carries Required Animation Names`, `an=${JSON.stringify(alt.an)}`);
check(alt.m === norm.m, 'both forms are one model file', `${norm.m} / ${alt.m}`);

const meta = JSON.parse(fs.readFileSync(`public/assets/models/${alt.m}.json`, 'utf8'));
const altSeqs = meta.sequences.filter((s) => /\balternate\b/i.test(s.name));
check(altSeqs.length > 0, 'the model has alternate sequences',
      `${altSeqs.length} of ${meta.sequences.length}`);
// the two forms must not merely play different clips, they must *look* different
const alphaOf = (re) => (meta.sequences.find((s) => re.test(s.name)) || {}).geosetAlpha;
const aNorm = alphaOf(/^stand$/i), aAlt = alphaOf(/^stand alternate$/i);
check(!!aNorm && !!aAlt && JSON.stringify(aNorm) !== JSON.stringify(aAlt),
      'the alternate sequence shows different geosets',
      `${JSON.stringify(aNorm)} vs ${JSON.stringify(aAlt)}`);

// ------------------------------------------------------------- the client
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
         `--user-data-dir=.tmp/chrome-morph-${process.pid}`, '--disable-crash-reporter',
         '--disable-breakpad', '--no-first-run', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => document.getElementById('loading').classList.contains('hidden'),
                           { timeout: 90000 });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

await page.evaluate((id) => {
  const card = [...document.querySelectorAll('.hcard')]
    .find((c) => c.dataset.id === id || c.getAttribute('data-id') === id);
  if (card) card.click();
  else window.FOC.net.send({ t: 'pickHero', heroId: id });
}, HERO);
await wait(600);
await page.$eval('#btnReady', (b) => b.click());
await page.waitForFunction(() => !document.getElementById('hud').classList.contains('hidden'),
                           { timeout: 60000 });
await wait(5000);

/** What the hero is: unit type, the clip it is playing, and which geosets show. */
const shot = () => page.evaluate(() => {
  const S = window.FOC.S, v = window.FOC.view.views.get(S.hero?.id);
  const e = S.ents.get(S.hero?.id);
  return { u: e?.u, an: e?.an, clip: v?.current || null,
           req: v?.animProps || [],
           shown: (v?.prims || []).map((m) => (m.visible ? 1 : 0)).join('') };
});

const before = await shot();
check(before.u === HERO, 'starts in his normal form', `u=${before.u} clip=${before.clip}`);

await page.evaluate(() => window.FOC.net.send({ t: 'debugLevel' }));
await wait(1500);
const slot = await page.evaluate((a) =>
  (window.FOC.S.hero?.abilities || []).findIndex((x) => x.id === a), ABIL);
check(slot >= 0, `${ABIL} is in a slot`, `slot=${slot}`);
await page.evaluate((s) => window.FOC.net.send({ t: 'learn', slot: s }), slot);
await wait(800);
await page.evaluate((s) => window.FOC.net.send({ t: 'cast', slot: s }), slot);
await wait(2500);

const after = await shot();
check(after.u === FORM, 'casting it changes his unit type', `u=${after.u}`);
check(after.req.includes('alternate'), 'the view asks for the alternate animations',
      `req=[${after.req}]`);
check(/alternate/i.test(after.clip || ''), 'and plays an alternate clip',
      `${before.clip} -> ${after.clip}`);
check(after.shown !== before.shown, 'a different set of geosets is on screen',
      `${before.shown} -> ${after.shown}`);
check(!errs.length, 'no console errors', errs.slice(0, 3).join(' | '));

await browser.close();
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
