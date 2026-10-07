// Three things the client got wrong once the window or the connection moved.
//
//   - heightAt rounded to the nearest terrain vertex, so a unit crossing a ramp
//     climbed it in 128-unit steps instead of walking up it. The ground that is
//     drawn is two triangles per cell; standing on it means reading the same
//     triangle, which is what pickGround's raycast already returned.
//   - the minimap and the console portrait size their drawing buffers in pixels,
//     once, when the console art lands. Everything else in the frame is laid out
//     in percentages, so after a resize those two alone were drawing at the old
//     size into a box that had changed shape.
//   - a dropped socket left the last frame standing with nothing moving in it and
//     one line in the log. It read as a hang.
//
// Part one builds a small terrain on the model bench and checks the height
// against a ray fired straight down at the mesh -- an independent answer, not a
// restatement of the formula. Part two drives the real game.
//
//   node server/index.js &        # port 8077
//   node tools/polish_test.mjs
import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';

const PORT = process.env.PORT || 8077;
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
         '--disable-dev-shm-usage', '--disable-crash-reporter', '--disable-breakpad',
         '--no-first-run', `--user-data-dir=.tmp/chrome-polish-${process.pid}`],
  defaultViewport: { width: 900, height: 600 },
});

// ---------------------------------------------------------------- the ground
console.log('terrain, on the model bench');
const bench = await browser.newPage();
await bench.setCacheEnabled(false);
const benchErrs = [];
bench.on('pageerror', (e) => benchErrs.push('PAGEERROR ' + e.message));
bench.on('console', (m) => { if (m.type() === 'error') benchErrs.push(m.text().slice(0, 200)); });
await bench.goto(`http://127.0.0.1:${PORT}/tools/modelview.html`,
                 { waitUntil: 'domcontentloaded', timeout: 90000 });
await bench.waitForFunction(() => window.ready === true, { timeout: 120000 });

const ground = await bench.evaluate(async () => {
  const view = window.view, THREE = window.THREE;
  const W = 5, H = 5, TS = 128;
  // A ramp climbing east, and a 256 step between rows 2 and 3 -- the shape a
  // cliff has. Cell (1,2) is told it carries a cliff model, so the ground mesh
  // leaves a hole there exactly as the real map does.
  const heights = new Float32Array(W * H);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++)
    heights[j * W + i] = i * 32 + (j >= 3 ? 256 : 0);
  const terr = { width: W, height: H, tileSize: TS, offsetX: 0, offsetY: 0 };
  const CLIFF = 2 * (W - 1) + 1;                 // cell (i=1, j=2)
  await view.buildTerrain(terr, heights, { cells: [CLIFF] });

  // The independent answer: drop a ray onto the mesh the renderer built.
  const ray = new THREE.Raycaster();
  const down = new THREE.Vector3(0, -1, 0);
  const onMesh = (wx, wy) => {
    ray.set(new THREE.Vector3(wx, 5000, -wy), down);
    const hit = ray.intersectObject(view.terrain, false);
    return hit.length ? hit[0].point.y : null;
  };

  const sample = (wx, wy) => ({ wx, wy, h: view.heightAt(wx, wy), mesh: onMesh(wx, wy) });
  // interior points of ordinary cells, both halves of the split
  const pts = [sample(64, 32), sample(32, 96), sample(160, 64), sample(300, 200)];
  const worst = Math.max(...pts.map((p) => (p.mesh == null ? Infinity : Math.abs(p.h - p.mesh))));

  // across one ramp cell, west to east: three distinct climbing values, where
  // rounding to a vertex gave the same number twice
  const ramp = [0.2, 0.5, 0.8].map((u) => +view.heightAt(u * TS, 16).toFixed(3));

  // the cliff cell: no ground triangle there, and no interpolation across it
  const cx = 128 + TS * 0.25, cy = 256 + TS * 0.25;
  const corners = [heights[2 * W + 1], heights[2 * W + 2],
                   heights[3 * W + 1], heights[3 * W + 2]];

  return { pts, worst, ramp, cliffMesh: onMesh(cx, cy), cliffH: view.heightAt(cx, cy), corners };
});

console.log(JSON.stringify(ground, null, 1));
check('height matches the mesh that is drawn', ground.worst < 0.5,
      `worst gap ${ground.worst.toFixed(4)} over ${ground.pts.length} points`);
check('a ramp climbs smoothly, not in steps',
      ground.ramp[0] < ground.ramp[1] && ground.ramp[1] < ground.ramp[2],
      ground.ramp.join(' -> '));
check('a cliff cell has no ground under it', ground.cliffMesh === null,
      ground.cliffMesh === null ? '' : `ray hit y=${ground.cliffMesh}`);
check('and keeps its step instead of ramping', ground.corners.includes(ground.cliffH),
      `${ground.cliffH} of corners ${ground.corners.join('/')}`);
check('no console errors on the bench', benchErrs.length === 0, benchErrs.slice(0, 2).join(' | '));
await bench.close();

// ------------------------------------------------------------- the real game
console.log('resize and disconnect, in game');
const page = await browser.newPage();
const errs = [];
await page.setCacheEnabled(false);
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
await page.evaluateOnNewDocument(() => localStorage.setItem('focs.name', 'Polish'));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => !document.getElementById('lobby').classList.contains('hidden'),
                           { timeout: 30000 });
await wait(1200);
await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.hcard:not(.nomodel)')];
  (cards[0] || document.querySelector('.hcard'))?.click();
});
await wait(600);
await page.$eval('#btnReady', (b) => b.click());
await page.waitForFunction(() => !document.getElementById('hud').classList.contains('hidden'),
                           { timeout: 30000 });
await wait(4000);                    // let the console art land and the portrait build

/** Does each canvas's drawing buffer agree with the box it is drawn into? */
const measure = () => page.evaluate(() => {
  const dpr = Math.min(2, devicePixelRatio || 1);
  const of = (id) => {
    const c = document.getElementById(id);
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { css: [Math.round(r.width), Math.round(r.height)], buf: [c.width, c.height],
             wantW: Math.round(r.width * dpr), wantH: Math.round(r.height * dpr) };
  };
  return { mm: of('mmcanvas'), portrait: of('unitPortrait'),
           hasPortrait: !!window.FOC.unitPortrait,
           phase: window.FOC.S.phase,
           hud: !document.getElementById('hud').classList.contains('hidden'),
           lobby: !document.getElementById('lobby').classList.contains('hidden') };
});

const before = await measure();
await page.setViewport({ width: 1320, height: 860 });
await wait(1500);
const after = await measure();
console.log(JSON.stringify({ before, after }, null, 1));

// The room starts the match without waiting for anyone's download, so boot()
// can finish after the game is already running. Its continuation used to show
// the lobby again, over a live match, with nothing left to take it down: the
// server sends STATE when the phase changes and it already had.
check('the lobby stays down once the match starts',
      before.hud === true && before.lobby === false,
      `phase=${before.phase} hud=${before.hud} lobby=${before.lobby}`);

const fits = (m) => !!m && Math.abs(m.buf[0] - m.wantW) <= 1 && Math.abs(m.buf[1] - m.wantH) <= 1;
// The load-time fit runs while #hud is still hidden, where every box is zero,
// so this was never right until the window happened to be resized.
check('the minimap is sized when the HUD appears', fits(before.mm),
      `${before.mm?.buf.join('x')} for a ${before.mm?.wantW}x${before.mm?.wantH} box`);
check('the portrait is too', !before.hasPortrait || fits(before.portrait),
      `${before.portrait?.buf.join('x')} for a ${before.portrait?.wantW}x${before.portrait?.wantH} box`);

check('the console rescales with the window',
      !!before.mm && !!after.mm && before.mm.css[0] !== after.mm.css[0],
      `minimap box ${before.mm?.css.join('x')} -> ${after.mm?.css.join('x')}`);
check('the minimap buffer follows its new box', fits(after.mm),
      `${after.mm?.buf.join('x')} for a ${after.mm?.wantW}x${after.mm?.wantH} box`);
check('the portrait buffer follows its new box',
      !after.hasPortrait || fits(after.portrait),
      after.hasPortrait ? `${after.portrait?.buf.join('x')} for a ` +
        `${after.portrait?.wantW}x${after.portrait?.wantH} box` : 'no portrait built');

// last, because it ends the session
const hiddenBefore = await page.evaluate(() =>
  document.getElementById('disconnected').classList.contains('hidden'));
await page.evaluate(() => window.FOC.net.ws.close());
await wait(1200);
const shown = await page.evaluate(() => {
  const d = document.getElementById('disconnected');
  return { visible: !d.classList.contains('hidden'),
           text: (d.textContent || '').replace(/\s+/g, ' ').trim(),
           hasButton: !!document.getElementById('btnRejoin') };
});
check('nothing says "disconnected" until it is', hiddenBefore === true);
check('a dropped socket says so', shown.visible === true, shown.text);
check('and offers the way back in', shown.hasButton === true);
check('no console errors in game', errs.length === 0, errs.slice(0, 2).join(' | '));

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
await browser.close();
process.exit(passed === results.length ? 0 : 1);
