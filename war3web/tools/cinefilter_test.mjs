import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';

const browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--disable-dev-shm-usage'], defaultViewport: { width: 720, height: 480 } });
try {
  const page = await browser.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', r => r.isNavigationRequest()
    ? r.respond({ status: 200, contentType: 'text/html', body: '<body style="margin:0;background:#345"><canvas></canvas></body>' })
    : r.continue());
  await page.goto(`http://127.0.0.1:${process.env.PORT || 8077}/`);
  const checks = await page.evaluate(async () => {
    const { CineFilter } = await import('/js/overlay.js');
    const filter = new CineFilter(), canvas = document.querySelector('canvas');
    canvas.width = innerWidth; canvas.height = innerHeight;
    const ctx = canvas.getContext('2d'), results = [];
    const check = (name, pass) => results.push({ name, pass });
    const mask = 'ReplaceableTextures\\CameraMasks\\DiagonalSlash_mask.blp';
    const icon = 'ReplaceableTextures\\CommandButtons\\BTNWhirlwind.blp';
    const white = 'ReplaceableTextures\\CameraMasks\\White_mask.blp';
    const draw = () => { ctx.clearRect(0, 0, canvas.width, canvas.height); filter.draw(ctx); return ctx.getImageData(0, 0, canvas.width, canvas.height).data; };
    for (const tex of [mask, icon, white]) {
      await filter.show({ tex, to: [255, 255, 255, 255], dur: 0, blend: 2 });
      const actual = draw();
      // Independently draw the original served PNG, without the filter's
      // texture loader or tint cache, then compare the rendered pixels.
      const idx = await (await fetch('/assets/textures.json')).json();
      const img = new Image(); img.src = '/assets/' + idx[tex.toLowerCase()]; await img.decode();
      const ref = document.createElement('canvas'); ref.width = innerWidth; ref.height = innerHeight;
      const rc = ref.getContext('2d'); rc.drawImage(img, 0, 0, innerWidth, innerHeight);
      const expected = rc.getImageData(0, 0, innerWidth, innerHeight).data;
      check(`${tex}: matches authored texture`, actual.every((v, i) => Math.abs(v - expected[i]) <= 1));
    }
    await filter.show({ tex: mask, to: [255, 0, 0, 128], dur: 0 });
    const tinted = draw();
    check('red tint preserves transparent and visible mask regions',
      tinted.some((v, i) => i % 4 === 3 && v === 0) && tinted.some((v, i) => i % 4 === 3 && v > 20)
      && tinted.every((v, i) => i % 4 !== 3 || v <= 128)
      && tinted.every((v, i) => (i % 4 !== 1 && i % 4 !== 2) || v === 0));
    await filter.show({ tex: mask, to: [255, 0, 0, 0], dur: 0 });
    check('the map’s fully transparent slash remains invisible', draw().every(v => v === 0));
    await filter.show({ tex: white, from: [255, 255, 255, 0], to: [255, 255, 255, 255], dur: 2 });
    filter.f.start = performance.now() - 1000;
    const middle = draw()[3];
    check('fade reaches half alpha at half duration', middle >= 127 && middle <= 130);
    filter.f.start = performance.now() - 10000;
    check('elapsed time completes fades after a background-tab gap', draw()[3] === 255);
    const realTexture = filter.texture.bind(filter);
    let finish;
    filter.texture = () => new Promise(resolve => { finish = resolve; });
    const pending = filter.show({ tex: mask, to: [255, 255, 255, 255], dur: 0 });
    check('a loading texture never becomes a solid flash', draw().every(v => v === 0));
    filter.clear(); finish(await realTexture(mask)); await pending;
    check('late texture completion cannot revive a cleared filter', draw().every(v => v === 0));
    filter.texture = realTexture;
    await filter.show({ tex: icon, to: [255, 255, 255, 255], dur: 0 });
    draw();
    return results;
  });
  for (const c of checks) console.log(`${c.pass ? 'ok' : 'FAIL'} ${c.name}`);
  await page.screenshot({ path: '/tmp/foc-cinematic-whirlwind.png' });
  assert.deepEqual(errors, []);
  assert.ok(checks.every(c => c.pass), 'cinematic pixel regression');
  console.log(`${checks.length}/${checks.length} checks passed`);
} finally { await browser.close(); }
