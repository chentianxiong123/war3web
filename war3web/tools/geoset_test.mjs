// Does a geoset fade, or does it pop?
//
// An MDX geoset animation carries a real 0..1 alpha track and Warcraft III
// draws the geoset at that alpha. The client read it as `visible = a > 0.05`,
// so every fade became a switch: Devotion Aura's ring, which is authored to sit
// at half alpha and ebb away over the second half of its Stand, came on solid
// and went off instantly.
//
// 19 of the 1105 converted models carry an alpha strictly between clear and
// solid -- the auras, War Stomp's and Thunder Clap's caster rings, three
// missiles, the feathers. This drives one of them frame by frame and reads the
// opacity actually on the material.
//
// The other half of the test is the cost and the blast radius: materials are
// shared through the model cache, so fading one instance must not fade another,
// must not reach the cache, and must not happen at all for the models that
// never fade.
//
//   node server/index.js &        # port 8077
//   node tools/geoset_test.mjs
import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';

const PORT = process.env.PORT || 8077;
// Trueshot Aura's ring is the clearest case in the set: its Stand track runs
// 0.30 -> 0.535 -> 0.30 over 1.267s and is *never* solid and never clear, so
// the old `visible = a > 0.05` drew it at full opacity for its whole life.
const MODEL = process.env.MODEL || 'abilities~spells~nightelf~trueshotaura~trueshotaura';
const SOLID = 'units~creeps~heroflamelord~heroflamelord';   // no fading geoset
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
         '--disable-dev-shm-usage', '--disable-crash-reporter', '--disable-breakpad',
         '--no-first-run', `--user-data-dir=.tmp/chrome-geoset-${process.pid}`],
  defaultViewport: { width: 520, height: 520 },
});
const page = await browser.newPage();
await page.setCacheEnabled(false);
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
await page.goto(`http://127.0.0.1:${PORT}/tools/modelview.html`,
                { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => window.ready === true, { timeout: 120000 });

const out = await page.evaluate(async ({ model, solid }) => {
  const view = window.view;
  const matsOf = (m) => (Array.isArray(m.material) ? m.material : [m.material]);
  const um = window.__unitModels || {};
  const meta = Object.values(um).find((t) => t.m === model) || {};
  const ent = (i, m, x) => ({ i, k: 1, t: 0, p: 0, c: 0, x, y: 0, f: 0, model: m,
                              scale: 1, radius: 32, name: m, an: meta.an });

  for (const [k] of [...view.views]) view.removeView(k);
  await view.spawnView(ent(60001, model, 0));
  await view.spawnView(ent(60002, model, 300));       // the bystander
  const A = view.views.get(60001), B = view.views.get(60002);
  if (!A || !B || !A.prims.length) return { error: 'nothing spawned' };

  const cached = [...view.modelCache.values()].find((r) => r.meta?.name === A.meta?.name);
  const cacheOpacity = () => {
    const out = [];
    cached?.gltf.scene.traverse((o) => {
      if (o.isMesh) for (const mm of matsOf(o)) out.push(+mm.opacity.toFixed(3));
    });
    return out;
  };
  const opac = (v) => v.prims.map((m) => +matsOf(m)[0].opacity.toFixed(3));
  const shown = (v) => v.prims.map((m) => (m.visible ? 1 : 0)).join('');

  view.play(A, 'stand');
  view.play(B, 'stand');
  const curve = (A.alphaCurve || []).filter(Boolean).length;
  const cacheBefore = cacheOpacity();
  const bystanderBefore = opac(B);

  // Drive A's clip to a chosen time and sample. B is deliberately left alone.
  const at = (t) => {
    A.currentAction.time = t;
    A.mixer.update(0);
    view.tickGeosetCurves(A);
    return { t, opac: opac(A), shown: shown(A),
             // the geoset factor on its own. Opacity is the product of this,
             // the material's own alpha track and any tint -- Trueshot Aura
             // animates both, so reading opacity alone cannot say what the
             // geoset track did.
             geoA: A.prims.map((m) => m.userData.__geoA ?? 1),
             matA: A.prims.map((m) => m.userData.__matA ?? 1),
             base: A.prims.map((m) => {
               const b = matsOf(m)[0].userData.__base;
               return b ? +b.opacity.toFixed(3) : null;
             }) };
  };
  const low  = at(0.0);      // authored 0.30
  const peak = at(0.40);     // authored 0.534
  const mid  = at(0.28);     // on the ramp between them
  const back = at(1.267);    // authored 0.30 again

  const bystander = { before: bystanderBefore, after: opac(B), shown: shown(B) };
  // the point is not that B avoids owning materials -- it is the same fading
  // model, so it should own them -- but that A's and B's are different objects
  const sharedMaterial = A.prims.some((m, i) =>
    B.prims[i] && matsOf(m)[0] === matsOf(B.prims[i])[0]);
  const cacheAfter = cacheOpacity();

  // A tint on top of a fade must multiply, not replace.
  at(0.40);
  const beforeTint = opac(A);
  view.tintUnit(60001, 255, 255, 255, 128);          // 50% alpha, no colour change
  const afterTint = opac(A);

  // A model with no fading geoset must never pay for any of this.
  await view.spawnView(ent(60003, solid, -300));
  const S = view.views.get(60003);
  if (S) view.play(S, 'stand');

  // And a model whose *only* animation is the geoset alpha has no glTF clip and
  // so no mixer to read a time from. It needs a clock of its own or it stays on
  // its first frame forever -- which for these two is fully transparent.
  const CLOCKLESS = 'abilities~spells~human~devotionaura~devotionaura';
  await view.spawnView(ent(60004, CLOCKLESS, 600));
  const C = view.views.get(60004);
  const clockless = C ? {
    hasMixer: !!C.mixer, hasClock: !!C.geoClock,
    dur: C.geoClock ? +C.geoClock.dur.toFixed(3) : null,
    samples: [0, 0.15, 0.3, 0.45].map(() => {
      view.tickGeosetCurves(C, 0.15);
      return { t: +C.geoClock.t.toFixed(2), opac: opac(C), shown: shown(C) };
    }),
  } : null;

  return {
    prims: A.prims.length, curves: curve,
    low, peak, mid, back, bystander,
    sharedMaterial,
    cacheUntouched: JSON.stringify(cacheBefore) === JSON.stringify(cacheAfter),
    beforeTint, afterTint,
    solidOwnsMats: S ? !!S.ownsMats : null,
    clockless,
    fadingOwnsMats: !!A.ownsMats,
  };
}, { model: MODEL, solid: SOLID });

console.log(JSON.stringify(out, null, 1));
if (out.error) { console.log('ABORT: ' + out.error); await browser.close(); process.exit(1); }

// geoset 1 is the ring; prims are indexed one-to-one against meta.geosets
const G = 1;
const base = out.peak.base[G];
const want = (f) => base * f;
check('the model has a fading geoset at all', out.curves > 0, `${out.curves} alpha curves`);
check('the ring is drawn throughout, never culled',
      out.low.shown[G] === '1' && out.peak.shown[G] === '1' && out.back.shown[G] === '1',
      `${out.low.shown} ${out.peak.shown} ${out.back.shown}`);
check('at its authored floor the geoset is at 0.30, not solid',
      Math.abs(out.low.geoA[G] - 0.30) < 0.02,
      `${out.low.geoA[G]} (drawn at ${out.low.opac[G]}, material track ${out.low.matA[G]})`);
check('at its authored peak it is 0.535, still not solid',
      Math.abs(out.peak.geoA[G] - 0.534) < 0.02,
      `${out.peak.geoA[G]} (drawn at ${out.peak.opac[G]}, material track ${out.peak.matA[G]})`);
check('the ramp between keys is sampled, not snapped',
      out.mid.geoA[G] > out.low.geoA[G] + 0.01 && out.mid.geoA[G] < out.peak.geoA[G] - 0.01,
      `${out.low.geoA[G]} < ${out.mid.geoA[G]} < ${out.peak.geoA[G]}`);
check('and it comes back down again',
      Math.abs(out.back.geoA[G] - 0.30) < 0.02,
      `${out.peak.geoA[G]} -> ${out.back.geoA[G]}`);
check('what is drawn is the product of both tracks, as the game multiplies them',
      base != null && Math.abs(out.peak.opac[G] - base * out.peak.geoA[G] * out.peak.matA[G]) < 0.02,
      `${base} x ${out.peak.geoA[G]} x ${out.peak.matA[G]} = ${out.peak.opac[G]}`);

check('another instance of the same model is untouched',
      JSON.stringify(out.bystander.before) === JSON.stringify(out.bystander.after),
      `${out.bystander.before} -> ${out.bystander.after}`);
check('the two instances hold different materials', out.sharedMaterial === false,
      out.sharedMaterial ? 'they share one, so a fade would reach both' : '');
check('the model cache is untouched', out.cacheUntouched === true,
      out.cacheUntouched ? '' : 'the fade would outlive the effect');

check('a tint multiplies the fade rather than replacing it',
      Math.abs(out.afterTint[G] - out.beforeTint[G] * 0.502) < 0.02,
      `${out.beforeTint[G]} x 0.5 -> ${out.afterTint[G]}`);

check('a model that never fades pays nothing', out.solidOwnsMats === false,
      out.solidOwnsMats ? 'it cloned its materials for no reason' : '');
check('the fading one does own its materials', out.fadingOwnsMats === true);
const C = out.clockless;
check('a model with no glTF clip still gets a clock', !!C && C.hasMixer === false && C.hasClock,
      C ? `mixer=${C.hasMixer} clock=${C.hasClock} dur=${C.dur}` : 'never spawned');
check('and its geosets actually move over that clock',
      !!C && new Set(C.samples.map((s) => JSON.stringify(s.opac))).size > 1,
      C ? C.samples.map((s) => `t=${s.t}:${s.shown}`).join(' ') : '');

check('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
await browser.close();
process.exit(passed === results.length ? 0 : 1);
