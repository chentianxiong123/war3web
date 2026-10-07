import assert from 'node:assert/strict';
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader', '--disable-dev-shm-usage'],
  defaultViewport: { width: 1280, height: 800 } });
try {
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('response', r => { if (r.status() >= 400) errors.push(`${r.status()} ${r.url()}`); });
  await page.setCacheEnabled(false);
  const url = `http://127.0.0.1:${process.env.PORT || 8077}/tools/cliffview.html`;
  const open = async () => {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.ready === true, { timeout: 60000 });
  };
  const shot = async (side, label) => {
    await page.evaluate(side => {
      window.capture = true;
      const draw = () => {
        if (!window.capture) return;
        window.shoot(side === 'west' ? -2500 : 2500, -530, 1100, .75, side === 'west' ? .9 : -.9);
        requestAnimationFrame(draw);
      };
      draw();
    }, side);
    // The first software-WebGL upload can lose/restore the context. Require
    // real colored geometry before capturing; a blank screenshot is no proof.
    await page.waitForFunction(() => {
      const gl = window.view.renderer.getContext();
      if (gl.isContextLost()) return false;
      window.view.renderer.render(window.view.scene, window.view.camera);
      const pixel = new Uint8Array(4), colors = new Set();
      for (const x of [.25, .5, .75]) for (const y of [.25, .5, .75]) {
        gl.readPixels(Math.floor(gl.drawingBufferWidth * x), Math.floor(gl.drawingBufferHeight * y),
          1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        colors.add([...pixel].join(','));
      }
      return colors.size > 3;
    }, { timeout: 30000 });
    await page.screenshot({ path: `/tmp/foc-terrain-${side}-${label}.png` });
    await page.evaluate(() => { window.capture = false; });
  };
  // Optional local before/after capture. Baseline assets are not fixtures and
  // are never added to the source repository; normal CI only loads current art.
  const baseline = process.env.TERRAIN_BASELINE || '/tmp/foc-terrain-before';
  const files = { '/data/cliffs.json': 'cliffs.json', '/data/cliffs.bin': 'cliffs.bin',
    '/data/heights.bin': 'heights.bin', '/assets/textures/_ground.png': '_ground.png' };
  if (Object.values(files).every(f => fs.existsSync(`${baseline}/${f}`))) {
    await page.setRequestInterception(true);
    const intercept = r => {
      const file = files[new URL(r.url()).pathname];
      if (file) r.respond({ status: 200, contentType: file.endsWith('.json') ? 'application/json'
        : file.endsWith('.png') ? 'image/png' : 'application/octet-stream', body: fs.readFileSync(`${baseline}/${file}`) });
      else r.continue();
    };
    page.on('request', intercept);
    await open();
    await shot('west', 'before'); await shot('east', 'before');
    await page.setRequestInterception(false); page.off('request', intercept);
  }
  await open();
  const result = await page.evaluate(() => {
    const { view, THREE } = window;
    const t = view.terrInfo;
    const ray = new THREE.Raycaster(), down = new THREE.Vector3(0, -1, 0);
    const samples = [];
    // Walk across both halves of each ramp, checking heightAt against an
    // independent downward ray cast onto the actual drawn terrain.
    for (const start of [27, 67]) {
      for (let i = 0; i <= 8; i++) {
        const gx = start + i / 4, gy = 27.5;
        const x = t.offsetX + gx * t.tileSize, y = t.offsetY + gy * t.tileSize;
        ray.set(new THREE.Vector3(x, 1000, -y), down);
        const hit = ray.intersectObject(view.terrain)[0];
        samples.push({ height: view.heightAt(x, y), drawn: hit?.point.y });
      }
    }
    return { samples, stats: window.stats };
  });
  assert.equal(result.stats.cliffCells, 510);
  assert.equal(result.stats.rampCells, 4);
  assert.ok(result.samples.every(s => Number.isFinite(s.drawn) && Math.abs(s.drawn - s.height) < .05));
  for (const half of [result.samples.slice(0, 9), result.samples.slice(9)]) {
    assert.ok(Math.abs(half[0].height - half[8].height) === 128);
    assert.equal(half[4].height, 64);
    assert.ok(half.slice(1).every((s, i) => Math.abs(s.height - half[i].height) <= 16.05), 'smooth two-cell slope');
  }
  await shot('west', 'after'); await shot('east', 'after');
  assert.deepEqual(errors, []);
  console.log('PASS: both base ramps follow the rendered two-cell slope; 510 cliff cells; no page/asset errors');
} finally { await browser.close(); }
