// Exercise real canvas layout: projection-only tests miss high-DPI CSS scaling.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
    '--disable-dev-shm-usage', '--disable-crash-reporter', '--disable-breakpad'],
});
try {
  const page = await browser.newPage();
  // Load the production renderer and stylesheet without booting a match.
  await page.setRequestInterception(true);
  page.on('request', request => {
    if (request.isNavigationRequest()) request.respond({ contentType: 'text/html', body: `
      <link rel="stylesheet" href="/style.css">
      <script type="importmap">{"imports":{"three":"/three/build/three.module.js",
      "three/addons/":"/three/examples/jsm/"}}</script>
      <canvas id="view"></canvas><canvas id="overlay"></canvas>
      <div style="position:absolute;width:400px;height:300px">
        <canvas id="unitPortrait" style="width:25%;height:40%"></canvas>
        <canvas id="heroSpin"></canvas>
      </div>` });
    else request.continue();
  });
  for (const dpr of [1, 1.25, 2, 3]) {
    await page.setViewport({ width: 1000, height: 700, deviceScaleFactor: dpr });
    await page.goto(`http://127.0.0.1:${process.env.PORT || 8077}/`);
    await page.evaluate(async () => {
      const { Renderer } = await import('/js/render.js');
      const { Overlay } = await import('/js/overlay.js');
      const { HeroPreview } = await import('/js/heroview.js');
      window.view = new Renderer(document.getElementById('view'));
      window.overlay = new Overlay(document.getElementById('overlay'));
      window.portrait = new HeroPreview(document.getElementById('unitPortrait'), { w: 100, h: 120 });
      window.preview = new HeroPreview(document.getElementById('heroSpin'), 280);
      view.camera.position.set(0, 1200, 1000);
      view.camera.lookAt(0, 0, 0);
      view.camera.updateMatrixWorld();
      view.setConsoleFraction(0.2933);
    });
    for (const [width, height] of [[1000, 700], [800, 600]]) {
      await page.setViewport({ width, height, deviceScaleFactor: dpr });
      const result = await page.evaluate(() => {
        view.resize(); overlay.resize();
        portrait.r.resize(); preview.r.resize();
        const portraitRect = portrait.canvas.getBoundingClientRect();
        const previewRect = preview.canvas.getBoundingClientRect();
        const rect = view.canvas.getBoundingClientRect();
        const hud = overlay.canvas.getBoundingClientRect();
        const point = view.camera.position.clone().set(150, 0, -100);
        const ndc = point.clone().project(view.camera);
        // Where this world point actually appears in the displayed canvas.
        const x = rect.left + (ndc.x + 1) * rect.width / 2;
        const y = rect.top + (1 - ndc.y) * rect.height / 2;
        const picked = view.pickGround(x / innerWidth * 2 - 1, 1 - y / innerHeight * 2);
        // Draw a real health bar anchored to the same world point.
        view.views.set(1, { root: { visible: true } });
        view.barAnchor = () => point.clone();
        overlay.draw(view, new Map([[1, { H: 100, h: 100 }]]), new Set([1]));
        const pixel = overlay.ctx.getImageData(
          Math.round(x * overlay.dpr), Math.round((Math.round(y) + 2) * overlay.dpr), 1, 1).data;
        return { width: rect.width, height: rect.height,
          aligned: rect.left === hud.left && rect.top === hud.top &&
            rect.width === hud.width && rect.height === hud.height,
          error: picked ? Math.hypot(picked.x - point.x, picked.y + point.z) : Infinity,
          green: pixel[1] > pixel[0] && pixel[1] > pixel[2],
          bufferWidth: view.canvas.width,
          portrait: [portraitRect.width, portraitRect.height],
          preview: [previewRect.width, previewRect.height] };
      });
      assert.equal(result.width, width, `CSS width at DPR ${dpr}`);
      assert.equal(result.height, height, `CSS height at DPR ${dpr}`);
      assert.equal(result.bufferWidth, Math.floor(width * Math.min(dpr, 2)));
      assert.ok(result.aligned, 'world and overlay bounds agree');
      assert.ok(result.error < 0.001, `click lands on displayed point: ${result.error}`);
      assert.ok(result.green, 'health bar appears at displayed anchor');
      assert.deepEqual(result.portrait, [100, 120], 'portrait preserves percentage panel sizing');
      assert.deepEqual(result.preview, [280, 280], 'lobby preview stays square and panel sized');
      console.log(`ok DPR ${dpr}, ${width}x${height}: canvas, click and health bar aligned`);
    }
  }
} finally {
  await browser.close();
}
