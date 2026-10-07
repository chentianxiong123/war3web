// A close look at a hero in a live game, captured properly.
//
// page.screenshot() gets a blank frame here: WebGL clears the drawing buffer
// after compositing unless preserveDrawingBuffer is set, so the compositor has
// nothing to hand over. Reading a render target back gives the real pixels --
// the same trick tools/modelview.html uses.
//
//   node server/index.js &        # port 8077
//   node tools/hero_shot.mjs [outfile]
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';

const PORT = process.env.PORT || 8077;
const OUT = process.argv[2] || '.tmp/hero.png';
const W = +(process.env.W || 900), H = +(process.env.H || 700);
// how close to sit: 1 is the normal game camera, lower is nearer
const ZOOM = +(process.env.ZOOM || 0.28);
const PITCH = +(process.env.PITCH || 0.42);

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
         '--disable-dev-shm-usage', '--disable-crash-reporter', '--disable-breakpad',
         '--no-first-run', `--user-data-dir=.tmp/chrome-hero-${process.pid}`],
  defaultViewport: { width: W, height: H },
});
const page = await browser.newPage();
await page.setCacheEnabled(false);
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 200)); });

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => !document.getElementById('lobby').classList.contains('hidden'),
                           { timeout: 40000 });
await new Promise((r) => setTimeout(r, 1000));
await page.evaluate((want) => {
  const cards = [...document.querySelectorAll('.hcard')];
  const c = want ? cards.find((x) => new RegExp(want, 'i').test(x.textContent)) : null;
  (c || cards[0]).click();
}, process.env.HERO || '');
await new Promise((r) => setTimeout(r, 600));
await page.$eval('#btnReady', (x) => x.click());
await page.waitForFunction(() => window.FOC && window.FOC.S.phase === 'playing', { timeout: 60000 });
await new Promise((r) => setTimeout(r, 11000));

const info = await page.evaluate(({ zoom, pitch }) => {
  const { view, S } = window.FOC;
  const me = S.ents.get(S.hero?.id);
  if (!me) return { error: 'no hero' };
  // sit close to the hero's own feet, which is where the ground art lives
  view.camTarget.set(me.x, view.heightAt(me.x, me.y) + 60, -me.y);
  view.camDist *= zoom;
  view.camPitch = pitch;
  view.updateCamera();
  const v = view.views.get(me.id);
  // what is actually drawn under and around it
  const ground = [];
  v?.root.traverse((o) => {
    if (!o.isMesh || o === v.obj) return;
    const g = o.geometry?.type || '';
    if (!/Plane/.test(g)) return;
    const m = Array.isArray(o.material) ? o.material[0] : o.material;
    ground.push({ what: o === v.shadow ? 'shadow' : o === v.splat ? 'ubersplat' : 'other',
                  geometry: g, blending: m?.blending, transparent: !!m?.transparent,
                  alphaTest: m?.alphaTest, opacity: m?.opacity,
                  depthWrite: !!m?.depthWrite,
                  colour: m?.color ? m.color.getHexString() : null,
                  texture: m?.map?.image?.currentSrc?.split('/').slice(-2).join('/') || null });
  });
  return { hero: me.name, model: v?.meta?.name, ground,
           splats: view.splatField?.live.length ?? 0 };
}, { zoom: ZOOM, pitch: PITCH });

console.log(JSON.stringify(info, null, 1));

const png = await page.evaluate(async ({ w, h }) => {
  // the game page does not expose three, so pull it in by URL -- the importmap
  // only covers module scripts and this runs as a classic one
  const THREE = await import('/three/build/three.module.js');
  const view = window.FOC.view;
  const r = view.renderer;
  const rt = new THREE.WebGLRenderTarget(w, h);
  view.camera.aspect = w / h; view.camera.updateProjectionMatrix();
  r.setRenderTarget(rt);
  r.render(view.scene, view.camera);
  const buf = new Uint8Array(w * h * 4);
  r.readRenderTargetPixels(rt, 0, 0, w, h, buf);
  r.setRenderTarget(null);
  rt.dispose();
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d');
  const img = ctx.createImageData(w, h);
  for (let y = 0; y < h; y++) {                    // GL reads bottom-up
    const src = (h - 1 - y) * w * 4, dst = y * w * 4;
    img.data.set(buf.subarray(src, src + w * 4), dst);
  }
  // the renderer clears to alpha 0; force it opaque or the PNG is transparent
  for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
  ctx.putImageData(img, 0, 0);
  return cv.toDataURL('image/png');
}, { w: W, h: H });

fs.writeFileSync(OUT, Buffer.from(png.split(',')[1], 'base64'));
console.log('wrote %s (%d bytes)', OUT, fs.statSync(OUT).size);
await browser.close();
