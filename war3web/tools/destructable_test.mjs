// Can anything actually break a gate open?
//
// The map's walls and gates block, and until now nothing could ever remove one:
// there was no destructable server-side at all. war3map.j never touches one
// either -- no KillDestructable, no DestructableRestoreLife anywhere in it -- so
// the only thing that opens a gate is a player hitting it until it falls.
//
// war3map.doo gives each placement a life percentage (every gate is 100, so they
// all start shut) and DestructableData gives the type its hit points and its
// selectable flag. Only the six gates carry that flag; the stone walls, the
// trees and the pathing blockers are 0, and a click may not land on one.
//
// The two halves that matter are the last two: a hero ordered at a gate has to
// reach it -- a gate is 896 units across and its middle is inside its own
// footprint, where nothing can stand -- and breaking it has to open the ground
// it was standing on, minus the posts its wreckage leaves behind.
//
// The last part needs a browser and a running server, because what the client
// draws for a broken gate and what a click can land on are only answerable
// there:
//
//   node server/index.js &        # port 8077
//   node tools/destructable_test.mjs
import fs from 'node:fs';
import path from 'node:path';
import { World } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';
import { DEST_ID } from '../shared/const.js';
import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';

const PORT = process.env.PORT || 8077;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT = path.resolve(import.meta.dirname, '..');
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};
const table = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/destructables.json'), 'utf8'));

const world = new World();
const dests = [...world.dests.values()];
const gates = dests.filter((d) => d.selectable);

check('every destructable the map places is an entity', dests.length === table.length,
      `${dests.length}`);
check('only the gates can be clicked', gates.length === 6,
      `${gates.length} selectable of ${dests.length}: ` +
      [...new Set(gates.map((g) => g.typeKey))].join(' '));
check('the walls and trees are not selectable',
      dests.filter((d) => /^LTw|^LTlt|^BTtw|^YTfb/.test(d.typeKey)).every((d) => !d.selectable),
      `${dests.filter((d) => !d.selectable).length} unselectable`);
check('the gates start shut and whole', gates.every((g) => g.alive && g.hp === g.maxHp && g.maxHp === 500),
      gates.map((g) => `${g.typeKey}:${g.hp}`).join(' '));
check('a destructable id names the same thing on both sides',
      gates.every((g) => world.target(DEST_ID + g.index) === g), `${DEST_ID}+index`);

// ---- range is measured to the footprint, not to the centre
//
// A gate's centre is inside its own footprint, where nothing can stand. Measured
// to the centre a melee hero pressed against the gate is still hundreds of units
// away from it and never swings.
const g0 = gates[0];
const far = world.destRange(g0, g0.x - 900, g0.y);
const near = world.destRange(g0, g0.x - 300, g0.y);
check('the range to a gate is measured to its footprint',
      world.destRange(g0, g0.x, g0.y) < 32 && near < 300 && far > near,
      `centre ${world.destRange(g0, g0.x, g0.y).toFixed(0)}, ` +
      `300 off ${near.toFixed(0)}, 900 off ${far.toFixed(0)}`);

// ---- a hero ordered at a gate reaches it and breaks it
const eng = new JassEngine(world);
eng.load(); eng.boot();
const STEP = 1000 / 30;
for (let i = 0; i < 30; i++) { eng.update(STEP); world.step(); }
const hero = [...world.units.values()].find((u) => u.isHero && u.alive);
check('there is a hero to swing at it', !!hero, hero ? hero.typeKey : 'none');

// The crossing a gate actually closes, taken from the gate itself rather than
// guessed at: flood out from the open cells touching its footprint and see how
// many separate places they belong to. A gate that shuts something off has two.
const W = world.grid.w, H = world.grid.h;
function componentOf(seed, blocked) {
  const seen = new Set([seed]); const st = [seed]; 
  while (st.length) {
    const c = st.pop(), x = c % W, y = (c - x) / W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (seen.has(j) || blocked.has(j) || world.walk[j] !== 1) continue;
      seen.add(j); st.push(j);
    }
  }
  return seen;
}
function sidesOf(d) {
  const own = new Set(d.cells);
  const touching = new Set();
  for (const c of d.cells) {
    const x = c % W, y = (c - x) / W;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
      const j = ny * W + nx;
      if (!own.has(j) && world.walk[j] === 1) touching.add(j);
    }
  }
  const seen = new Set(); const groups = [];
  for (const c of touching) {
    if (seen.has(c)) continue;
    const comp = componentOf(c, own);
    for (const j of comp) seen.add(j);
    groups.push([c, comp.size]);
  }
  return groups.sort((a, b) => b[1] - a[1]);
}
const sides = new Map(gates.map((g) => [g, sidesOf(g)]));
const sealing = gates.find((g) => (sides.get(g) || []).length > 1 && sides.get(g)[1][1] > 500);
check('at least one gate has two sides to it', !!sealing,
      [...sides].map(([g, s]) => `${g.typeKey}:${s.length}`).join(' '));

const toWorld = (c) => world.grid.toWorld(c % W, Math.floor(c / W));
const [aSeed, bSeed] = sides.get(sealing).slice(0, 2).map((s) => s[0]);
const a = toWorld(aSeed), b = toWorld(bSeed);
const routeLen = () => {
  const p = world.grid.path(a[0], a[1], b[0], b[1]);
  if (!p) return Infinity;
  let n = 0, px = a[0], py = a[1];
  for (const [x, y] of p) { n += Math.hypot(x - px, y - py); px = x; py = y; }
  return n;
};
const straight = Math.hypot(b[0] - a[0], b[1] - a[1]);
const shutRoute = routeLen();
check('the shut gate makes that crossing a long way round or no way at all',
      shutRoute > straight * 3,
      `${shutRoute === Infinity ? 'no route' : Math.round(shutRoute)} against ` +
      `${Math.round(straight)} straight`);

// Start the hero well back on one side, not against the gate: reaching it is
// half of what is being tested, and a gate's own middle is not somewhere a unit
// can be sent, so the walk has to end at the footprint's edge instead.
const own = new Set(sealing.cells);
const hops = new Map([[aSeed, 0]]);
for (const q = [aSeed]; q.length; ) {
  const c = q.shift(), x = c % W, y = (c - x) / W, n = hops.get(c);
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
    const j = ny * W + nx;
    if (own.has(j) || world.walk[j] !== 1 || hops.has(j)) continue;
    hops.set(j, n + 1); q.push(j);
  }
}
const startCell = [...hops].find(([, n]) => n >= 20);
check('there is open ground to start the hero on', !!startCell,
      `${hops.size} cells on that side`);
const start = toWorld(startCell[0]);

const walkBefore = world.walk.reduce((x, y) => x + y, 0);
world.moveUnit(hero, start[0], start[1]);
hero.controlled = true;                       // a player's hero, not the guard AI
const startRange = world.destRange(sealing, hero.x, hero.y);
check('and it starts out of reach of the gate', startRange > hero.atkRange * 3,
      `${startRange.toFixed(0)} away, reach ${hero.atkRange}`);
world.order(hero, { type: 'attack', target: sealing });
let ticks = 0;
while (sealing.alive && ticks < 30 * 120) { eng.update(STEP); world.step(); ticks++; }
check('a hero ordered at a gate walks to it and breaks it', !sealing.alive,
      sealing.alive ? `still ${Math.round(sealing.hp)} hp after 120 s`
                    : `down in ${(ticks / 30).toFixed(1)} s, hero ` +
                      `${world.destRange(sealing, hero.x, hero.y).toFixed(0)} from it`);

// ---- and the ground it stood on comes back, minus its posts
const walkAfter = world.walk.reduce((x, y) => x + y, 0);
const opened = walkAfter - walkBefore;
const posts = sealing.deadCells.length;
check('breaking it opens its footprint but not its posts',
      opened > 0 && opened === sealing.ownCells.length - posts,
      `${opened} cells opened, ${posts} kept as rubble, footprint ${sealing.cells.length}`);
check('the crossing is short now', routeLen() < Math.min(shutRoute / 2, straight * 3),
      `${Math.round(routeLen())} against ` +
      `${shutRoute === Infinity ? 'no route' : Math.round(shutRoute)} while it stood`);

// ---- and no other world is affected by it
const fresh = new World();
check('a broken gate stays broken only in its own match',
      fresh.walk.reduce((x, y) => x + y, 0) === walkBefore &&
      [...fresh.dests.values()].every((d) => d.alive),
      `${fresh.walk.reduce((x, y) => x + y, 0)} vs ${walkBefore} walkable`);

// ---------------------------------------------------------------- the client
//
// Two things only the browser can answer: whether a click can land on a gate --
// against its meshes, because a gate is 896 units of wall and a sphere round its
// centre would both miss its ends and steal clicks meant for its neighbours --
// and whether breaking one actually changes what is drawn. The wreckage is
// already in the model, hidden by the stand sequence's geoset-alpha track, so
// dying is a switch to the death sequence's row of the same track.
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
         '--disable-dev-shm-usage', '--disable-crash-reporter', '--disable-breakpad',
         '--no-first-run', `--user-data-dir=.tmp/chrome-dest-${process.pid}`],
  defaultViewport: { width: 1280, height: 800 },
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
await page.evaluateOnNewDocument(() => localStorage.setItem('focs.name', 'Gate'));
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => !document.getElementById('lobby').classList.contains('hidden'),
                           { timeout: 60000 });
await wait(1200);
await page.evaluate(() => {
  const cards = [...document.querySelectorAll('.hcard:not(.nomodel)')];
  (cards[0] || document.querySelector('.hcard'))?.click();
});
await wait(600);
await page.$eval('#btnReady', (b) => b.click());
await page.waitForFunction(() => !document.getElementById('hud').classList.contains('hidden'),
                           { timeout: 60000 });
// Wait for the doodads themselves, not for the table that names them: the
// client fills S.destPick before addDoodads runs, because addDoodads needs it
// to know which placements to give a mixer. Waiting on the table let this run
// while the models were still loading.
await page.waitForFunction(() => {
  const { view, S } = window.FOC || {};
  if (!view?.doodadAt || !S?.destPick?.size || !view.doodads?.parent) return false;
  return [...S.destPick].every((i) => view.doodadAt.has(i));
}, { timeout: 90000 });
await wait(500);

const out = await page.evaluate((ids) => {
  const { view, S } = window.FOC;
  const picks = [...(S.destPick || [])];
  const visible = (i) => {
    const names = [];
    view.doodadAt.get(i)?.obj.traverse((o) => { if (o.isMesh && o.visible) names.push(o.name); });
    return names.join('|');
  };
  // Aim at a point that is actually on the gate rather than at the middle of
  // the screen: a gate is an archway, and a ray down its centre goes through the
  // opening. The camera also carries a view offset for the console, so the
  // screen centre is not the camera's axis either -- project the point instead
  // of assuming where it lands.
  const aim = (i) => {
    const e = view.doodadAt.get(i);
    if (!e) return null;
    let mesh = null;
    e.obj.traverse((o) => { if (!mesh && o.isMesh && o.visible) mesh = o; });
    if (!mesh) return { none: true };
    mesh.updateWorldMatrix(true, false);
    mesh.geometry.computeBoundingSphere();
    const c = mesh.localToWorld(mesh.geometry.boundingSphere.center.clone());
    view.camera.position.set(c.x + 200, c.y + 600, c.z + 400);
    view.camera.lookAt(c.x, c.y, c.z);
    view.camera.updateMatrixWorld(true);
    const ndc = c.clone().project(view.camera);
    return { any: view.pickDoodad(ndc.x, ndc.y, null),
             gate: view.pickDoodad(ndc.x, ndc.y, S.destPick) };
  };
  const target = picks[0];
  const aimed = aim(target);
  // Does a hit actually move the doors? Run the Stand Hit clip forward and see
  // whether any bone ends up somewhere else. Every bone, not the first one
  // found: the clip keyframes three of the fourteen, and the rest hold still --
  // a probe on the wrong bone reports no movement from a clip that works.
  // Rotation as well as position, because a leaf bone that only turns stays
  // exactly where it was.
  const hit = (() => {
    const out = { clips: [], moved: 0, probed: 0, keyed: [] };
    for (const i of picks) {
      const e = view.doodadAt.get(i);
      if (!e?.mixer) continue;
      out.clips.push([...e.actions.keys()].filter((k) => /hit/.test(k)).join(','));
      const clip = e.actions.get('stand hit');
      // how many of its tracks actually vary: a clip of held keyframes would
      // play and change nothing
      out.keyed.push((clip?.tracks || []).filter((t) => t.times.length > 2).length);
      const bones = [];
      e.obj.traverse((o) => { if (o.isBone) bones.push(o); });
      if (!bones.length) continue;
      out.probed++;
      e.obj.updateMatrixWorld(true);
      const pose = () => bones.map((b) => [b.position.x, b.position.y, b.position.z,
                                           b.quaternion.x, b.quaternion.y,
                                           b.quaternion.z, b.quaternion.w]);
      const a = pose();
      view.playDoodadClip(i, 'stand hit');
      for (let f = 0; f < 8; f++) e.mixer.update(1 / 30);
      const b = pose();
      if (a.some((row, r) => row.some((v, k) => Math.abs(v - b[r][k]) > 1e-4))) out.moved++;
      e.mixer.stopAllAction();
    }
    return out;
  })();

  const before = picks.map(visible);
  const changed = picks.map((i) => view.setDoodadDead(i));
  const atDeath = picks.map(visible);
  // and run the death curves out: the gates fade a geoset in across the first
  // two thirds of the clip, so what is drawn a second later is not what is
  // drawn the instant it dies
  for (let f = 0; f < 40; f++)
    for (const i of picks) {
      const e = view.doodadAt.get(i);
      if (!e) continue;
      e.mixer?.update(1 / 30);
      if (e.deathCurve) view.tickDoodadCurves(e, 1 / 30);
    }
  const after = picks.map(visible);
  const curved = picks.filter((i, k) => atDeath[k] !== after[k]).length;
  return { registered: view.doodadAt ? view.doodadAt.size : 0, picks, aimed, hit,
           mixers: [...view.doodadAt.values()].filter((e) => e.mixer).length,
           before, atDeath, after, curved, changed,
           dests: S.dests ? S.dests.size : 0 };
}, null);

check('the client knows every destructable', out.dests === table.length,
      `${out.dests} of ${table.length}`);
check('and only the gates are clickable there', out.picks.length === 6, `${out.picks.length}`);
check('every placed doodad is registered to be found again', out.registered > 300,
      `${out.registered}`);
check('a click aimed at a gate lands on it', out.aimed && out.aimed.gate === out.picks[0],
      JSON.stringify(out.aimed));
check('only what can be struck carries a mixer', out.mixers === 6, `${out.mixers}`);
check('every gate has a hit clip', out.hit.clips.length === 6 && out.hit.clips.every((c) => c),
      out.hit.clips.join(' '));
check('the hit clip has keyframes to play', out.hit.keyed.every((n) => n > 0),
      out.hit.keyed.join(' ') + ' tracks that vary');
check('and being hit moves the doors', out.hit.probed > 0 && out.hit.moved === out.hit.probed,
      `${out.hit.moved} of ${out.hit.probed}`);
check('breaking a gate changes what is drawn',
      out.changed.filter(Boolean).length >= 4 &&
      out.picks.filter((_, i) => out.after[i] !== out.before[i]).length >= 4,
      out.picks.map((_, i) => (out.before[i] === out.after[i] ? 'unchanged' : 'swapped')).join(' '));
check('a geoset that fades in during the death clip actually arrives',
      out.curved >= 4, `${out.curved} of ${out.picks.length} changed again as the clip ran`);
// The city entrance gate has no geoset animation at all, so it has no wreckage
// to swap to. Hiding it instead would leave a hole in the wall, so it is left
// standing -- which is what the counts above have to show, not a zero.
check('and a gate with no wreckage is left alone rather than hidden',
      out.after.every((n) => n.length > 0), out.after.map((n) => n.split('|').length).join(' '));
const real = errs.filter((e) => !/404|portraits\//.test(e));
check('no console errors', real.length === 0, real.slice(0, 2).join(' | '));
await browser.close();

const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} checks passed`);
process.exit(bad ? 1 : 0);
