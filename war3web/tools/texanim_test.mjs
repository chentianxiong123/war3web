// Do texture animations actually move the UVs?
//
// A material layer can bind a TXAN entry that slides, turns or stretches its
// UVs while the model plays -- how a beam flows, a portal turns, a flipbook
// steps from cell to cell. 83 layers across 39 of this map's models ask for
// one and the converter carried none of it, so all of them drew a still image.
//
// Two clocks drive them and both have to work: 55 of the 87 tracks here are
// bound to a global sequence and loop on their own period regardless of the
// animation playing, the rest are scoped to the playing sequence. This checks
// the UVs move, that they move on the right clock, and -- the part that would
// otherwise go unnoticed -- that one animated model does not drag every other
// copy of itself along with it through the shared material cache.
//
//   node server/index.js &        # port 8077
//   node tools/texanim_test.mjs
import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';

const PORT = process.env.PORT || 8077;
const MODEL = process.env.MODEL || 'units~creeps~heroflamelord~heroflamelord';
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
         '--disable-dev-shm-usage', '--disable-crash-reporter', '--disable-breakpad',
         '--no-first-run', `--user-data-dir=.tmp/chrome-uv-${process.pid}`],
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
  const { stepTexAnims } = await import('/js/texanim.js');

  const anims = v.texAnims || [];
  const shapes = anims.map((a) => ({
    ownClock: !Array.isArray(a.d.t), step: !!a.d.tStep,
  }));

  // sample the offset over a second of wall clock, with no clip playing at all:
  // a global-sequence track must move anyway, which is the whole point of it
  const read = () => anims.map((a) => a.maps.map((m) => [
    +m.offset.x.toFixed(4), +m.offset.y.toFixed(4),
    +m.repeat.x.toFixed(4), +m.rotation.toFixed(4)].join(',')));
  const frames = [];
  for (let i = 0; i < 40; i++) {
    stepTexAnims(anims, view.animCtxOf(v), i * 0.05);
    frames.push(JSON.stringify(read()));
  }
  const distinct = new Set(frames).size;

  // The shared-material trap. Materials and textures arrive out of the model
  // cache shared between every instance, so animating one in place would slide
  // every other copy of that model in the scene with it. The view has to own
  // its own -- check that directly against what the cache still holds, which is
  // stronger than spawning a second view and hoping the difference shows.
  const name = v.meta?.name;
  const cached = [...view.modelCache.values()].find((r) => r.meta?.name === name);
  let ownsMaterial = null, ownsTexture = null;
  if (cached) {
    const cachedMats = new Set(), cachedMaps = new Set();
    cached.gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      for (const mm of (Array.isArray(o.material) ? o.material : [o.material])) {
        cachedMats.add(mm);
        if (mm.map) cachedMaps.add(mm.map);
      }
    });
    // an animated layer must hold neither the cache's material nor its texture
    ownsTexture = anims.every((a) => a.maps.every((m) => !cachedMaps.has(m)));
    ownsMaterial = v.prims.every((mesh) =>
      (Array.isArray(mesh.material) ? mesh.material : [mesh.material])
        .every((mm) => !mm.map || !cachedMaps.has(mm.map) || !mesh.userData.__anim));
  }

  return { anims: anims.length, shapes, distinctFrames: distinct,
           sample: frames.slice(0, 3), ownsMaterial, ownsTexture,
           cacheFound: !!cached };
});

console.log(JSON.stringify(out, null, 1));

check('the model has animated layers', out.anims > 0, `${out.anims}`);
check('at least one keeps its own clock',
      out.shapes?.some((s) => s.ownClock), JSON.stringify(out.shapes));
check('the UVs actually move over time', out.distinctFrames > 1,
      `${out.distinctFrames} distinct states across 40 samples`);
check('the cached model was found to compare against', out.cacheFound === true);
check('an animated layer owns its texture, not the cache\'s',
      out.ownsTexture === true,
      out.ownsTexture === true ? 'no sharing' : 'SHARED - every copy would slide together');
check('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
await browser.close();
process.exit(passed === results.length ? 0 : 1);
