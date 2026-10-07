// Does a corpse dissolve, or does it just stop existing?
//
// Warcraft III fades a body out over Decay Flesh and Decay Bone, and it does so
// through the *material's* alpha track (KMTA) -- a different track from the
// geoset alpha that fades an aura. mdx.py parsed it and mdx2gltf.py threw it
// away, so the client was handed nothing to fade with: a corpse held full
// opacity until its timer ran out and then vanished.
//
// 133 of 250 sampled unit models animate it across a decay sequence and 136
// model/sequence pairs take it to zero. This drives one of those and reads the
// opacity actually on the material.
//
//   node server/index.js &        # port 8077
//   node tools/dissolve_test.mjs
import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';

const PORT = process.env.PORT || 8077;
// The green spider's Decay Bone runs its material from 1.0 to 0.0 while the
// geoset wearing it is still fully drawn, so the material track is the only
// thing dissolving that corpse. That distinction matters: on 65 of the 90
// fading pairs the geoset alpha has already culled the mesh by the time the
// material moves, and there this track changes nothing on screen. 25 are like
// the spider, and those are what this fixes.
const MODEL = process.env.MODEL || 'units~creeps~spidergreen~spidergreen';
const SOLID = 'units~creeps~heroflamelord~heroflamelord';
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
         '--disable-dev-shm-usage', '--disable-crash-reporter', '--disable-breakpad',
         '--no-first-run', `--user-data-dir=.tmp/chrome-dissolve-${process.pid}`],
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
  const ent = (i, m, x) => ({ i, k: 1, t: 0, p: 0, c: 0, x, y: 0, f: 0, model: m,
                              scale: 1, radius: 32, name: m });
  for (const [k] of [...view.views]) view.removeView(k);
  await view.spawnView(ent(50001, model, 0));
  await view.spawnView(ent(50002, model, 400));       // bystander, left alone
  const A = view.views.get(50001), B = view.views.get(50002);
  if (!A || !B) return { error: 'nothing spawned' };

  // A dissolve is a curve that starts solid and ends clear, on a geoset the
  // sequence actually shows. Anything looser matches the opposite case: these
  // models also fade bones *in* during Decay Flesh, on a geoset that is hidden
  // at the time, and asserting against one of those proves nothing.
  const gs = A.meta.geosets || [];
  const dissolveIn = (sq) => {
    const ga = sq.geosetAlpha || [];
    const curves = sq.matAlphaCurve || [];
    for (let mi = 0; mi < curves.length; mi++) {
      const c = curves[mi];
      if (!c || c[0][1] <= 0.5 || c[c.length - 1][1] > 0.02) continue;
      const prim = gs.findIndex((g, i) => g.material === mi && (ga[i] ?? 1) > 0.05);
      if (prim >= 0) return { c, mi, prim };
    }
    return null;
  };
  const decay = (A.meta.sequences || []).filter((s) => /decay/i.test(s.name) && dissolveIn(s));
  if (!decay.length) return { error: 'no decay sequence dissolves a visible geoset' };

  const opac = (v) => v.prims.map((m) => +matsOf(m)[0].opacity.toFixed(3));
  const bystanderBefore = opac(B);
  // Ask for it, then read back what pickClip chose: it weighs variants by
  // rarity, so sampling a curve from a sequence that is not running proves
  // nothing.
  view.play(A, decay[0].name.toLowerCase());
  const seq = (A.meta.sequences || []).find((s) => s.name.toLowerCase() === A.current);
  const found = seq && dissolveIn(seq);
  if (!found) return { error: `picked ${A.current}, which does not dissolve` };
  const { c: curve, mi, prim } = found;

  const at = (t) => {
    A.currentAction.time = t;
    A.mixer.update(0);
    view.tickGeosetCurves(A);
    return { t: +t.toFixed(3), opac: opac(A), vis: A.prims[prim].visible,
             matA: A.prims[prim].userData.__matA ?? null,
             geoA: A.prims[prim].userData.__geoA ?? null };
  };
  // The fade is not spread over the sequence: on these models the material
  // holds at 1 for 58 of its 60 seconds and drops in the last 1.7. Sampling at
  // the midpoint reads the *geoset* fade instead and says nothing about this
  // track, so the samples sit either side of the last two keys.
  const t0 = curve[0][0], tEnd = curve[curve.length - 1][0];
  const tHold = curve[curve.length - 2][0];
  const start = at(t0);
  const mid = at((tHold + tEnd) / 2);
  // just inside the end, not on it: the action loops, so setting its time to
  // exactly the clip duration wraps it back to zero and samples the first key
  const end = at(Math.max(t0, tEnd - 0.01));

  at(t0 + (tEnd - t0) * 0.5);
  const beforeTint = opac(A)[prim];
  view.tintUnit(50001, 255, 255, 255, 128);
  const afterTint = opac(A)[prim];

  // a model whose decay does not animate its material pays nothing
  await view.spawnView(ent(50003, solid, -400));
  const S = view.views.get(50003);
  if (S) view.play(S, 'stand');

  return { seq: seq.name, played: A.current, keys: curve.length, mi, prim,
           start, mid, end, beforeTint, afterTint,
           bystanderBefore, bystanderAfter: opac(B),
           solidOwns: S ? !!S.ownsMats : null };
}, { model: MODEL, solid: SOLID });

console.log(JSON.stringify(out, null, 1));
if (out.error) { console.log('ABORT: ' + out.error); await browser.close(); process.exit(1); }

const P = out.prim;
check('a decay sequence dissolves a visible geoset', out.keys > 1,
      `${out.seq}, ${out.keys} keys, material ${out.mi}, prim ${P} (playing ${out.played})`);
// unset means 1: nothing is cloned or written while a material is fully opaque
check('the corpse starts solid', (out.start.matA ?? 1) > 0.98 && out.start.vis === true,
      `material alpha ${out.start.matA ?? '1 (untouched)'}, visible=${out.start.vis}`);
check('the material fades part-way through the last keys',
      out.mid.matA < 0.9 && out.mid.matA > 0.05,
      `t=${out.mid.t}: material alpha ${out.mid.matA}`);
check('and reaches clear by the end', out.end.matA <= 0.02,
      `t=${out.end.t}: material alpha ${out.end.matA}`);
check('the fade reaches the thing on screen, not just the bookkeeping',
      out.mid.opac[P] < out.start.opac[P] - 0.05,
      `opacity ${out.start.opac[P]} -> ${out.mid.opac[P]} (geoset alpha ${out.mid.geoA})`);
check('a tint multiplies the dissolve rather than replacing it',
      Math.abs(out.afterTint - out.beforeTint * 0.502) < 0.02,
      `${out.beforeTint} x 0.5 -> ${out.afterTint}`);
check('another corpse of the same type is untouched',
      JSON.stringify(out.bystanderBefore) === JSON.stringify(out.bystanderAfter),
      `${out.bystanderBefore} -> ${out.bystanderAfter}`);
check('a model whose decay does not fade pays nothing', out.solidOwns === false,
      out.solidOwns ? 'it cloned its materials for no reason' : '');
check('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
await browser.close();
process.exit(passed === results.length ? 0 : 1);
