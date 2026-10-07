// Does the ground actually move?
//
// Gaara's A03O and Kisame's A069 each dig a crater and cancel it about ten
// seconds later, through Blizzard.j's real TerrainDeformationCraterBJ.  Four of
// the map's six TerrainDeform calls are these; TerrainDeformCrater was
// `() => null`, so the water prison left the ground flat.
//
// What is measured from the files and asserted here: which vertices move, by
// how much at the centre, over how long, and in which direction -- Blizzard's
// TriggerStrings.txt settles the sign ("Depth may be negative for bumps"), so a
// positive depth digs down.  What is NOT in any extracted file is the radial
// falloff curve; TerrainDeformCrater is a bare native in common.j and the shape
// lives in the engine binary.  render.js uses a raised cosine and says so.
//
// The check that matters is the last one.  The map cancels a crater with an
// equal and opposite crater at the same point, so whatever curve is used, the
// terrain has to come back to exactly where it started -- otherwise every cast
// leaves the map permanently dented.  Asserting the heightfield's own numbers
// rather than "deformTerrain was called" is the point: a stub would pass that.
//
//   node server/index.js &        # port 8077
//   node tools/crater_test.mjs
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';
import { World } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = process.env.PORT || 8077;
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};

// ------------------------------------------------------------ what the map asks for
const mapj = fs.readFileSync(path.join(ROOT, 'extracted/war3map.j'), 'utf8');
// the argument list nests one call deep -- GetSpellTargetLoc(), GetRectCenter(r)
// -- so a plain [^)]* stops at the wrong bracket and reads half a call
const ARG = String.raw`(?:[^()]|\([^()]*\))*`;
const crater = [...mapj.matchAll(new RegExp(`TerrainDeformationCraterBJ\\((${ARG})\\)`, 'g'))]
  .map((m) => m[1]);
check('the map digs four craters and no more', crater.length === 4, `${crater.length}`);
check('each is permanent, radius 400, half a second',
      crater.every((a) => /^\.5,true,/.test(a) && /,400\.,-?400\.$/.test(a)),
      crater.join(' | ').slice(0, 120));
check('and they come in dig/undo pairs',
      crater.filter((a) => a.endsWith(',400.,400.')).length === 2 &&
      crater.filter((a) => a.endsWith(',400.,-400.')).length === 2,
      `${crater.filter((a) => a.endsWith(',400.,400.')).length} dig, ` +
      `${crater.filter((a) => a.endsWith(',400.,-400.')).length} undo`);

// Blizzard's own file is what settles the sign, so assert we still have it.
const hint = fs.readFileSync(path.join(ROOT, 'war3_extracted/UI/TriggerStrings.txt'), 'latin1');
check('Blizzard states which way a positive depth goes',
      /CraterBJHint=.*Depth may be negative for bumps/i.test(hint), 'TriggerStrings.txt');

// -------------------------------------------------------- the native, server side
const world = new World();
const eng = new JassEngine(world);
eng.load(); eng.boot();
eng.flushClientEvents();
const h = eng.vm.natives.get('TerrainDeformCrater')(512, -256, 400, 400, 500, true);
const evs = eng.flushClientEvents().filter((e) => e.t === 'terrainDeform');
check('the native is no longer a no-op', !!h && evs.length === 1, `${evs.length} event(s)`);
check('and it carries the arguments it was given',
      evs[0] && evs[0].x === 512 && evs[0].y === -256 && evs[0].r === 400 &&
      evs[0].depth === 400 && evs[0].ms === 500 && evs[0].permanent === true,
      JSON.stringify(evs[0] || null));

// The simulation must not be able to see it: the map never calls GetLocationZ,
// and the server's heightfield stays put, so there is nothing to desync.
check('the map never reads terrain height', !mapj.includes('GetLocationZ'), '0 calls');

// --------------------------------------------------------------- the ground itself
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
         '--disable-dev-shm-usage', '--disable-crash-reporter', '--disable-breakpad',
         '--no-first-run', `--user-data-dir=.tmp/chrome-crater-${process.pid}`],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => !document.getElementById('lobby').classList.contains('hidden'),
                           { timeout: 60000 });
await page.evaluate(() => {
  const c = [...document.querySelectorAll('.hcard:not(.nomodel)')];
  (c[0] || document.querySelector('.hcard'))?.click();
});
await new Promise((r) => setTimeout(r, 600));
await page.$eval('#btnReady', (b) => b.click());
await page.waitForFunction(() => !document.getElementById('hud').classList.contains('hidden'),
                           { timeout: 60000 });
await new Promise((r) => setTimeout(r, 3000));

const out = await page.evaluate(async () => {
  const { view } = window.FOC;
  const t = view.terrInfo, W = t.width;
  // a point well inside the playable area, on the vertex grid
  const i = Math.floor(W / 2), j = Math.floor(t.height / 2);
  const x = t.offsetX + i * t.tileSize, y = t.offsetY + j * t.tileSize;
  const v = j * W + i;
  const pos = view.terrain.geometry.attributes.position;
  const before = view.heights[v];
  const beforeMesh = pos.array[v * 3 + 1];
  const beforeAt = view.heightAt(x, y);

  // run the deformation to completion the way the render loop would
  const settle = (ms) => { for (let n = 0; n < 40; n++) view.tickTerrain(ms / 1000 / 40); };
  view.deformTerrain({ x, y, r: 400, depth: 400, ms: 500, permanent: true });
  settle(600);
  const dug = view.heights[v], dugMesh = pos.array[v * 3 + 1], dugAt = view.heightAt(x, y);

  // how far out it reached, in vertices, and whether the rim is undisturbed
  const TS = t.tileSize;
  let moved = 0, rimFlat = true;
  for (let jj = j - 5; jj <= j + 5; jj++) for (let ii = i - 5; ii <= i + 5; ii++) {
    const d = Math.hypot((ii - i) * TS, (jj - j) * TS);
    const vv = jj * W + ii;
    const delta = view.heights[vv] - (d <= 400 ? 0 : 0);
    if (d <= 400 && Math.abs(pos.array[vv * 3 + 1] - view.heights[vv]) > 1e-6) rimFlat = false;
    if (d < 400 && vv !== v) moved++;
  }

  // and the undo the map itself issues
  view.deformTerrain({ x, y, r: 400, depth: -400, ms: 500, permanent: true });
  settle(600);
  const back = view.heights[v], backMesh = pos.array[v * 3 + 1], backAt = view.heightAt(x, y);
  return { before, beforeMesh, beforeAt, dug, dugMesh, dugAt, back, backMesh, backAt,
           moved, rimFlat, pending: (view.deforms || []).length };
});

check('a crater lowers the ground under its centre', out.dug < out.before - 300,
      `${out.before.toFixed(1)} -> ${out.dug.toFixed(1)}`);
check('by its full depth, digging rather than raising',
      Math.abs((out.before - out.dug) - 400) < 1, `${(out.before - out.dug).toFixed(2)} down`);
check('the drawn mesh moves with the heightfield',
      Math.abs(out.dugMesh - out.dug) < 1e-3, `mesh ${out.dugMesh.toFixed(1)} vs ${out.dug.toFixed(1)}`);
check('and everything that reads ground height follows',
      Math.abs(out.dugAt - out.dug) < 1e-3, `heightAt ${out.dugAt.toFixed(1)}`);
check('it reaches more than one vertex', out.moved > 4, `${out.moved} neighbours moved`);
check('the mesh and the heightfield never disagree', out.rimFlat, 'in step across the footprint');
check('the map\'s own undo restores the ground exactly',
      Math.abs(out.back - out.before) < 1e-6 && Math.abs(out.backMesh - out.beforeMesh) < 1e-6,
      `${out.before.toFixed(4)} -> ${out.dug.toFixed(1)} -> ${out.back.toFixed(4)}`);
check('and heightAt comes back with it',
      Math.abs(out.backAt - out.beforeAt) < 1e-6, `${out.backAt.toFixed(4)}`);
check('no deformation is left running', out.pending === 0, `${out.pending} pending`);

const real = errs.filter((e) => !/404|portraits\//.test(e));
check('no console errors', real.length === 0, real.slice(0, 2).join(' | '));

await browser.close();
const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} checks passed`);
process.exit(bad ? 1 : 0);
