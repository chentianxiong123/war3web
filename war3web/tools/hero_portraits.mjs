// Render each hero's own model to a portrait for the lobby's character select.
//
// The map ships no icons for its heroes. Every one of the 26 carries an
// imported model -- Goku, Ichigo, Luffy, Zoro -- and every one of them shows
// whatever icon the Warcraft III unit it was built from happened to have, so
// Goku picks as a Paladin and Ichigo as a Blood Elf Peasant. Nothing is wrong
// with the data; the author simply never drew any, and the icon field holds the
// base unit's art.
//
// The lobby is ours rather than the map's -- the map's pick area is a sealed
// pocket the web lobby replaces outright -- so drawing a hero as itself here is
// not a departure from the map.
//
// These are baked at build time rather than drawn live: 26 animated models in
// one grid is a great deal of WebGL for a menu, and a portrait does not move.
// The detail pane spins the real model instead.
//
//   node server/index.js &            # port 8077
//   node tools/hero_portraits.mjs     # -> public/assets/portraits/<id>.png
//
// Options: PORT, S (pixel size), ONLY (comma-separated hero ids, for tuning).
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';

const PORT = process.env.PORT || 8077;
const S = +(process.env.S || 256);
const OUT = process.env.OUT || 'public/assets/portraits';
const ONLY = (process.env.ONLY || '').split(',').filter(Boolean);
// the colour .hcard img already paints behind an icon, so a portrait drops in
const CARD_BG = 0x05060a;

const GAME = JSON.parse(fs.readFileSync('data/game.json', 'utf8'));
// The model key the renderer wants is the one the client is given at spawn --
// `ent.model` is used verbatim -- and that lives in unitmodels.json. game.json
// carries the raw MDX path, which is the same string for an imported model
// ("Goku") and a different one for a stock Blizzard path: it says
// "units\\nightelf\\herodemonhunter\\..." where the converted file is
// "units~nightelf~herodemonhunter~...". Taking it from there 404s on exactly the
// heroes that use a base model.
const UM = JSON.parse(fs.readFileSync('public/data/unitmodels.json', 'utf8'));
let heroes = GAME.heroes
  .map((h) => ({ ...h, model: (UM[h.id] || {}).m || h.model,
                 scale: (UM[h.id] || {}).s ?? h.scale }))
  .filter((h) => h.model);
if (ONLY.length) heroes = heroes.filter((h) => ONLY.includes(h.id));
console.log('rendering %d portrait(s) at %dx%d', heroes.length, S, S);

fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
         '--disable-dev-shm-usage', '--disable-crash-reporter', '--disable-breakpad',
         '--no-first-run', `--user-data-dir=.tmp/chrome-portrait-${process.pid}`],
  defaultViewport: { width: S, height: S },
});
const page = await browser.newPage();
await page.setCacheEnabled(false);
page.on('pageerror', (e) => console.log('PAGEERROR', e.message));

await page.goto(`http://127.0.0.1:${PORT}/tools/modelview.html`,
                { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => window.ready === true, { timeout: 120000 });

const results = [];
const failed = [];
for (const h of heroes) {
  let out;
  try {
  out = await page.evaluate(async ({ id, model, scale, size, CARD_BG }) => {
    const THREE = await import('/three/build/three.module.js');
    const view = window.view;
    // By id, not by model: a shared model reaches whichever unit type the
    // lookup finds first, and for the five that draw as the Demon Hunter that
    // is a metamorphosis form whose animation set hides the ordinary body.
    await window.showUnit(model, 0, scale || 1, id);
    const v = [...view.views.values()][0];
    if (!v) return { error: 'no view' };

    // A portrait is the unit and nothing else. The bench builds real terrain so
    // that shadows and ground effects behave; none of it belongs behind a face.
    const hidden = [];
    const hide = (o) => { if (o && o.visible) { o.visible = false; hidden.push(o); } };
    hide(view.terrain); hide(view.cliffs); hide(view.water && view.water.mesh);
    hide(v.shadow); hide(v.splat);

    // Opaque, in the card's own colour, rather than transparent.
    //
    // A transparent portrait sounds tidier and is wrong here. Additive blending
    // is (SrcAlpha, One): on an empty target it piles up alpha while adding
    // almost no colour, so every additive effect in a model comes out a solid
    // black rectangle. Ichigo carries a 384x384 additive ground glow and that is
    // exactly what it did. Composited against the colour the card already uses,
    // the same glow reads as a glow.
    const bg = view.scene.background;
    view.scene.background = new THREE.Color(CARD_BG);

    // The game is lit as a dim outdoor scene, which reads as a silhouette at
    // portrait size. A menu picture gets its own key and fill, added for the
    // shot and taken away again.
    const key = new THREE.DirectionalLight(0xffffff, 2.0);
    key.position.set(-2, 3, 4);
    const fill = new THREE.AmbientLight(0xffffff, 1.1);
    view.scene.add(key); view.scene.add(fill);

    // Frame by looking at the render rather than at the model's declared size.
    //
    // The obvious way is the MDX extent, the way showUnit does it -- three.js
    // computes a bounding box off the bind-pose vertex buffer and takes no
    // account of skinning, so a posed model reports its unposed height. But an
    // extent is only as good as whoever saved the model. Ichigo's claims 835
    // units tall against a body of 184, and Byakuya's claims a radius of 234
    // around geometry collapsed to a speck. Trusting them puts one hero's head
    // in frame and leaves the next a dot in the middle of an empty card.
    //
    // So: render, measure the alpha the model actually covers, move the camera
    // to suit, and repeat. Two passes settle it, and it cannot be fooled by a
    // number in a file.
    const ground = view.heightAt(0, 0);
    view.camPitch = 0.10; view.camYaw = 0.55;
    view.camTarget.set(0, ground + 90, 0);
    view.camDist = 400;

    view.camera.aspect = 1;
    view.camera.updateProjectionMatrix();

    // measure at a cheap size while fitting, then take the real shot
    const readAt = (rtT, n) => {
      view.updateCamera();
      view.renderer.setRenderTarget(rtT);
      view.renderer.render(view.scene, view.camera);
      const b = new Uint8Array(n * n * 4);
      view.renderer.readRenderTargetPixels(rtT, 0, 0, n, n, b);
      view.renderer.setRenderTarget(null);
      return b;
    };
    // What the background actually comes out as, taken with the model hidden.
    //
    // Comparing against CARD_BG does not work -- the renderer's colour handling
    // does not hand the constant back unchanged, and everything reads as model.
    // Sampling a corner instead is a subtler trap: Ichigo's ground glow reaches
    // the edge of the frame, so the corner is glow and again everything counts.
    // Rendering once without the unit costs one frame and cannot be fooled.
    const probe = new THREE.WebGLRenderTarget(96, 96);
    v.root.visible = false;
    const bgBuf = readAt(probe, 96);
    const bg0 = bgBuf[0], bg1 = bgBuf[1], bg2 = bgBuf[2];
    v.root.visible = true;
    const isModel = (b, i) => Math.abs(b[i] - bg0) + Math.abs(b[i + 1] - bg1)
                            + Math.abs(b[i + 2] - bg2) > 18;
    const bounds = (b, n) => {                       // GL is bottom-up
      let x0 = n, x1 = -1, y0 = n, y1 = -1;
      for (let i = 0; i < b.length; i += 4) {
        if (!isModel(b, i)) continue;
        const px = (i / 4) % n, py = Math.floor((i / 4) / n);
        if (px < x0) x0 = px; if (px > x1) x1 = px;
        if (py < y0) y0 = py; if (py > y1) y1 = py;
      }
      return x1 < 0 ? null : { x0, x1, y0, y1, h: (y1 - y0 + 1) / n, w: (x1 - x0 + 1) / n,
                               cy: ((y0 + y1) / 2) / n };
    };
    const FILL = 0.86;                               // of the frame, tallest axis
    for (let pass = 0; pass < 3; pass++) {
      const bb = bounds(readAt(probe, 96), 96);
      if (!bb) break;                                // nothing drawn; leave it to the caller
      // recentre: how far the model's middle is from the frame's, in world units
      const fov = view.camera.fov * Math.PI / 180;
      const visible = 2 * view.camDist * Math.tan(fov / 2);
      view.camTarget.y += (bb.cy - 0.5) * visible;
      const fill = Math.max(bb.h, bb.w);
      view.camDist = Math.max(40, view.camDist * (fill / FILL));
    }
    probe.dispose();

    const rt = new THREE.WebGLRenderTarget(size, size);
    const buf = readAt(rt, size);
    rt.dispose();
    view.scene.remove(key); view.scene.remove(fill);
    view.scene.background = bg;
    for (const o of hidden) o.visible = true;

    const cv = document.createElement('canvas');
    cv.width = size; cv.height = size;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(size, size);
    for (let y = 0; y < size; y++) {               // GL reads bottom-up
      const src = (size - 1 - y) * size * 4, dst = y * size * 4;
      img.data.set(buf.subarray(src, src + size * 4), dst);
    }
    // how much of the frame the model actually covers, so a miss is visible in
    // the log rather than shipping as a blank card
    let lit = 0;
    for (let i = 0; i < img.data.length; i += 4) if (isModel(img.data, i)) lit++;
    for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
    ctx.putImageData(img, 0, 0);
    return { png: cv.toDataURL('image/png'), coverage: +(lit / (size * size)).toFixed(3),
             dist: Math.round(view.camDist), prims: v.prims.length };
  }, { id: h.id, model: h.model, scale: h.scale, size: S, CARD_BG });
  } catch (e) {
    // one hero that will not load must not take the other 25 with it
    console.log('  FAIL %s  %s  %s', h.id.padEnd(5), (h.model || '').slice(-34).padEnd(34),
                String(e.message).split('\n')[0].slice(0, 80));
    failed.push(h.id);
    continue;
  }
  if (!out || out.error || !out.png) {
    console.log('  FAIL %s  %s  %s', h.id.padEnd(5), (h.model || '').slice(-34).padEnd(34),
                (out && out.error) || 'no image');
    failed.push(h.id);
    continue;
  }
  const file = path.join(OUT, `${h.id}.png`);
  fs.writeFileSync(file, Buffer.from(out.png.split(',')[1], 'base64'));
  results.push({ id: h.id, coverage: out.coverage, bytes: fs.statSync(file).size });
  console.log('  %s  %s  coverage %s  dist %s  %s prims',
              h.id.padEnd(5), (h.model || '').slice(-34).padEnd(34),
              String(out.coverage).padEnd(6), String(out.dist).padStart(4),
              String(out.prims).padStart(3));
}

await browser.close();
const empty = results.filter((r) => r.coverage < 0.01);
console.log('\nwrote %d of %d portrait(s) to %s', results.length, heroes.length, OUT);
if (failed.length) console.log('FAILED: %s', failed.join(', '));
if (empty.length) {
  console.log('WARNING: %d are effectively blank -- %s',
              empty.length, empty.map((e) => e.id).join(', '));
}
process.exit(results.length && !empty.length && !failed.length ? 0 : 1);
