import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';
const SP = process.env.SP || '/tmp';
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader', '--user-data-dir=.tmp/chrome', '--disable-crash-reporter', '--disable-breakpad', '--no-first-run',
         '--window-size=1440,900', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1440, height: 900 },
});
const page = await browser.newPage();
const errs = [], logs = [];
page.on('console', (m) => { const t = m.text(); logs.push(`${m.type()}: ${t}`); if (m.type() === 'error') errs.push(t); });
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
page.on('requestfailed', (r) => errs.push('REQFAIL ' + r.url() + ' ' + r.failure()?.errorText));
page.on('response', (r) => { if (r.status() >= 400) errs.push(`HTTP ${r.status()} ${r.url()}`); });

await page.goto(`http://127.0.0.1:${process.env.PORT || 8080}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => !document.getElementById('lobby').classList.contains('hidden'), { timeout: 30000 });
console.log('lobby visible');
await new Promise(r => setTimeout(r, 1200));
await page.screenshot({ path: `${SP}/shot_lobby.png` });

// pick the first hero that has an imported model, then ready up
const picked = await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.hcard:not(.nomodel)')];
  if (!cards.length) cards.push(...document.querySelectorAll('.hcard'));
  if (!cards.length) return null;
  cards[0].click();
  return cards[0].querySelector('.nm')?.textContent;
});
console.log('picked hero:', picked);
await new Promise(r => setTimeout(r, 600));
await page.screenshot({ path: `${SP}/shot_pick.png` });
// picking a hero re-renders the lobby, so a positional click can land on the
// element that just moved; dispatch on the node instead
await page.$eval('#btnReady', (b) => b.click());
await page.waitForFunction(() => !document.getElementById('hud').classList.contains('hidden'), { timeout: 30000 });
console.log('in game');
await new Promise(r => setTimeout(r, 12000));   // let creep waves spawn
await page.screenshot({ path: `${SP}/shot_game.png` });

// walk somewhere and cast, then shoot again
const info = await page.evaluate(() => {
  const c = document.getElementById('view');
  const r = c.getBoundingClientRect();
  const ev = (type, opts) => c.dispatchEvent(new MouseEvent(type, Object.assign({
    bubbles: true, clientX: r.width * 0.55, clientY: r.height * 0.45, button: 0 }, opts)));
  ev('mousedown');
  return { canvas: [c.width, c.height] };
});
await new Promise(r => setTimeout(r, 2500));
await page.keyboard.press('q');
await new Promise(r => setTimeout(r, 1200));
await page.screenshot({ path: `${SP}/shot_action.png` });

const diag = await page.evaluate(() => {
  const gl = document.getElementById('view').getContext('webgl2') || document.getElementById('view').getContext('webgl');
  return { renderer: gl ? gl.getParameter(gl.RENDERER) : 'no gl' };
});
console.log('gl:', diag.renderer, 'canvas', info.canvas);

// What is actually in the scene. A screenshot of a WebGL canvas comes back
// blank unless preserveDrawingBuffer is set, so counting the scene is the
// honest way to tell "it rendered" from "it did not".
const scene = await page.evaluate(() => {
  const R = window.FOC && window.FOC.view;
  if (!R) return { error: 'no renderer on window' };
  let meshes = 0, points = 0, textured = 0;
  R.scene.traverse((o) => {
    if (o.isPoints || o.userData?.w3emitter) points++;
    if (!o.isMesh) return;
    meshes++;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    if (m && m.map) textured++;
  });
  let ribbons = 0, sprays = 0, lights = 0, shadows = 0;
  for (const v of R.views.values()) {
    ribbons += (v.ribbons || []).length;
    sprays += (v.sprays || []).length;
    lights += (v.lights || []).length;
    if (v.shadow) shadows++;
  }
  const litSlots = R.lightPool ? R.lightPool.slots.filter((x) => x.owner).length : -1;
  // anything drawn as a stand-in rather than a real model -- the "ghosts"
  const ghosts = [];
  for (const [id, v] of R.views) {
    const e = window.FOC.S.ents.get(id);
    if (!e || e.model) continue;                 // has a real model: fine
    let meshes = 0;
    v.root.traverse((o) => { if (o.isMesh) meshes++; });
    if (meshes) ghosts.push({ id, type: e.u, locust: !!e.locust, meshes, k: e.k });
  }
  return { units: R.views.size, meshes, texturedMeshes: textured,
           particleSystems: points, ribbons, sprays, lights, litSlots, shadows,
           ghosts: ghosts.length, ghostSample: ghosts.slice(0, 6),
           modelsLoaded: R.modelCache?.size ?? -1,
           doodads: R.doodads ? R.doodads.children.length : -1 };
});
console.log('scene:', JSON.stringify(scene));
// An aborted request is not a failure: three.js cancels a fetch it no longer
// needs (a duplicate, or a model whose view was removed while it loaded), and
// counting those as errors buries the ones that matter.
const aborted = errs.filter((e) => e.includes('ERR_ABORTED'));
const real = errs.filter((e) => !e.includes('ERR_ABORTED'));
console.log('console errors:', real.length, '(plus', aborted.length, 'aborted fetches)');
for (const e of real.slice(0, 12)) console.log('  !', e);
await browser.close();
