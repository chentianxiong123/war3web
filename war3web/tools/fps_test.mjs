// Where a frame goes in the browser.
//
// The server holds a real match at 1% of its tick budget, so a game that stalls
// with a lot on screen is stalling in the client. This drives a real match and
// measures frames rather than guessing which part is expensive.
//
//   PORT=8077 node tools/fps_test.mjs
import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';

const PORT = process.env.PORT || 8077;
const SECONDS = +(process.env.SECS || 8);
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
         `--user-data-dir=.tmp/chrome-fps-${process.pid}`, '--disable-crash-reporter',
         '--disable-breakpad', '--no-first-run', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1440, height: 900 },
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => document.getElementById('loading').classList.contains('hidden'),
                           { timeout: 90000 });
await page.evaluate(() => {
  const c = [...document.querySelectorAll('.hcard')].find((x) => x.dataset.id === 'H00C');
  (c || document.querySelector('.hcard')).click();
});
await new Promise((r) => setTimeout(r, 700));
await page.$eval('#btnReady', (b) => b.click());
await page.waitForFunction(() => !document.getElementById('hud').classList.contains('hidden'),
                           { timeout: 60000 });
await new Promise((r) => setTimeout(r, 9000));       // let creeps spawn and models load
// The crowded case on demand: MOBS=300 fills a grid around the hero with the
// map's own creep types, some in frame and most not, which is what a real
// field looks like. Needs the server started with FOC_DEBUG=1, as npm test does.
const MOBS = +(process.env.MOBS || 0);
if (MOBS) {
  await page.evaluate((n) => window.FOC.net.send({ t: 'debugSpawn', n }), MOBS);
  await new Promise((r) => setTimeout(r, 6000));     // their models load too
}

// Time the pieces separately. requestAnimationFrame deltas alone say a frame was
// slow; they do not say which half was.
const out = await page.evaluate(async (secs) => {
  const V = window.FOC.view;
  const frames = [];
  const parts = { render: 0, three: 0, n: 0 };
  const origRender = V.renderer.render.bind(V.renderer);
  V.renderer.render = (s, c) => { const t = performance.now(); origRender(s, c); parts.three += performance.now() - t; };
  const origStep = V.render.bind(V);
  V.render = () => { const t = performance.now(); const d = origStep(); parts.render += performance.now() - t; parts.n++; return d; };
  // the rest of the frame, piece by piece: a frame that is slow says nothing
  // about which part of it is
  const wrap = (obj, name, key) => {
    if (!obj || typeof obj[name] !== 'function') return;
    parts[key] = 0;
    const orig = obj[name].bind(obj);
    obj[name] = (...a) => { const t = performance.now(); const r = orig(...a);
                            parts[key] += performance.now() - t; return r; };
  };
  wrap(V, 'pickEntity', 'pick');
  wrap(window.FOC.ui, 'drawMinimap', 'minimap');
  wrap(window.FOC.overlay, 'draw', 'bars');
  wrap(V, 'markSelected', 'circles');
  // The skeleton work itself, which is what the PERFORMANCE note suspects:
  // three.js re-skins and re-uploads a bone texture for every skinned mesh it
  // does not cull, and it counts once per skeleton per frame. The prototype is
  // reached through a live skeleton because THREE is not on the window.
  let skel = null;
  for (const v of V.views.values()) for (const m of v.prims || []) if (m.skeleton) { skel = m.skeleton; break; }
  parts.skelN = 0; parts.skel = 0;
  if (skel) {
    const proto = Object.getPrototypeOf(skel);
    const orig = proto.update;
    proto.update = function () { const t = performance.now(); orig.call(this);
                                 parts.skel += performance.now() - t; parts.skelN++; };
  }
  // and the scene-graph walk that recomposes every bone's matrix each frame,
  // on screen or not
  wrap(V.scene, 'updateMatrixWorld', 'matrices');
  let last = performance.now();
  await new Promise((done) => {
    const tick = () => {
      const now = performance.now();
      frames.push(now - last); last = now;
      if (now - start < secs * 1000) requestAnimationFrame(tick); else done();
    };
    const start = performance.now();
    requestAnimationFrame(tick);
  });
  frames.sort((a, b) => a - b);
  const pick = (p) => frames[Math.min(frames.length - 1, Math.floor(frames.length * p))];
  let meshes = 0, points = 0, visible = 0, offscreen = 0;
  V.scene.traverse((o) => { if (o.isMesh) { meshes++; if (o.visible) visible++; } if (o.isPoints) points++; });
  for (const v of V.views.values()) if (v.offscreen) offscreen++;
  return {
    frames: frames.length,
    median: pick(0.5), p90: pick(0.9), p99: pick(0.99), worst: frames[frames.length - 1],
    fps: 1000 / pick(0.5),
    viewRenderMs: parts.render / Math.max(1, parts.n),
    threeRenderMs: parts.three / Math.max(1, parts.n),
    perf: { ...V.perf },
    pickMs: parts.pick / Math.max(1, parts.n),
    minimapMs: parts.minimap / Math.max(1, parts.n),
    barsMs: parts.bars / Math.max(1, parts.n),
    circleMs: parts.circles / Math.max(1, parts.n),
    skelMs: parts.skel / Math.max(1, parts.n), skelN: parts.skelN / Math.max(1, parts.n),
    matricesMs: parts.matrices / Math.max(1, parts.n), offscreen,
    calls: V.renderer.info.render.calls, tris: V.renderer.info.render.triangles,
    programs: V.renderer.info.programs?.length ?? 0,
    textures: V.renderer.info.memory.textures, geometries: V.renderer.info.memory.geometries,
    meshes, visible, points, views: V.views.size, ents: window.FOC.S.ents.size,
  };
}, SECONDS);
await browser.close();

const f = (n, d = 2) => Number(n).toFixed(d);
console.log(`frames                ${out.frames} over ${SECONDS}s`);
console.log(`median frame          ${f(out.median)} ms   (${f(out.fps, 1)} fps)`);
console.log(`p90 / p99 / worst     ${f(out.p90)} / ${f(out.p99)} / ${f(out.worst)} ms`);
console.log();
console.log(`view.render()         ${f(out.viewRenderMs)} ms per frame`);
console.log(`  of which WebGL      ${f(out.threeRenderMs)} ms`);
console.log(`  everything else     ${f(out.viewRenderMs - out.threeRenderMs)} ms`);
console.log(`  unit views        ${f(out.perf.views)} ms   (mixers, emitters, texanims)`);
console.log(`  effects           ${f(out.perf.fx)} ms`);
console.log(`  bolts/water/cam   ${f(out.perf.rest)} ms`);
console.log(`  renderer.render   ${f(out.perf.gl)} ms`);
console.log(`frame loop`);
console.log(`  interpolation     ${f(out.perf.interp)} ms   (per-entity, ${out.ents} entities)`);
console.log(`  hud + overlay     ${f(out.perf.ui)} ms`);
console.log(`pickEntity            ${f(out.pickMs)} ms per frame`);
console.log(`minimap               ${f(out.minimapMs)} ms per frame`);
console.log(`health bars           ${f(out.barsMs)} ms per frame`);
console.log(`selection circles     ${f(out.circleMs)} ms per frame`);
console.log(`skeleton updates      ${f(out.skelN, 1)} per frame, ${f(out.skelMs)} ms`);
console.log(`scene matrices        ${f(out.matricesMs)} ms per frame`);
console.log();
console.log(`draw calls            ${out.calls}`);
console.log(`triangles             ${out.tris}`);
console.log(`shader programs       ${out.programs}`);
console.log(`meshes (visible)      ${out.meshes} (${out.visible})`);
console.log(`particle systems      ${out.points}`);
console.log(`textures / geometries ${out.textures} / ${out.geometries}`);
console.log(`unit views / entities ${out.views} / ${out.ents}   (${out.offscreen} views off screen)`);
