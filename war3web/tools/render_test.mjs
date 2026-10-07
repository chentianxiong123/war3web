// Does the renderer keep one unit's changes to itself, and give back what it took?
//
// Every view is cut from the model cache with SkeletonUtils.clone, which shares
// geometry *and* materials. That makes two whole classes of bug possible and
// both were live:
//
//   - a change meant for one unit lands on every unit of the type, and because
//     the mutated material stays in the cache, on every one spawned afterwards.
//     SetUnitVertexColor is the map's own way in -- 21 calls, mostly ghosting a
//     summon to 50% -- and it was recolouring the whole species.
//   - nothing was ever disposed, so the copies a view *does* make (team colour,
//     texture animation, the ground quads) accumulated on the GPU for the whole
//     match.
//
// Also checked here: a missile points where it is going, and a Locust dummy --
// which has no mesh at all -- cannot take a click meant for the unit behind it.
//
//   node server/index.js &        # port 8077
//   node tools/render_test.mjs
import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';

const PORT = process.env.PORT || 8077;
const MODEL = process.env.MODEL || 'units~creeps~heroflamelord~heroflamelord';
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
         '--disable-dev-shm-usage', '--disable-crash-reporter', '--disable-breakpad',
         '--no-first-run', `--user-data-dir=.tmp/chrome-render-${process.pid}`],
  defaultViewport: { width: 520, height: 640 },
});
const page = await browser.newPage();
await page.setCacheEnabled(false);
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });

await page.goto(`http://127.0.0.1:${PORT}/tools/modelview.html`,
                { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => window.ready === true, { timeout: 120000 });

const out = await page.evaluate(async (model) => {
  const view = window.view;
  const THREE = window.THREE;
  const um = window.__unitModels || {};
  const meta = Object.values(um).find((t) => t.m === model) || {};
  const matsOf = (mesh) => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]);
  const ent = (i, x) => ({ i, k: 1, t: 0, p: 0, c: 0, x, y: 0, f: 0, model,
                           scale: 1, radius: 32, name: model, sh: meta.sh, sw: meta.sw,
                           shh: meta.shh, sx: meta.sx, sy: meta.sy, an: meta.an,
                           us: meta.us, isBuilding: !!meta.b });
  // Drawn geosets only. A geoset the sequence hides outright now carries the
  // geoset animation's own alpha of 0 on its material as well as visible=false,
  // so its opacity no longer round-trips through a tint -- correctly, since
  // nothing is drawn from it either way. Comparing it would be comparing state
  // that never reaches the screen.
  const read = (v) => v.prims.filter((m) => m.visible).flatMap((m) => matsOf(m).map(
    (mm) => [mm.color ? mm.color.getHex() : -1, +mm.opacity.toFixed(3)].join(':')));

  for (const [k] of [...view.views]) view.removeView(k);

  // ---------------------------------------------------------------- tinting
  await view.spawnView(ent(70001, -200));
  await view.spawnView(ent(70002, 200));
  const a = view.views.get(70001), b = view.views.get(70002);
  if (!a || !b || !a.prims.length) return { error: 'nothing spawned' };

  // what the cache holds, before anyone touches anything
  const cached = [...view.modelCache.values()].find((r) => r.meta?.name === a.meta?.name);
  const cacheState = [];
  cached?.gltf.scene.traverse((o) => {
    if (o.isMesh) for (const mm of matsOf(o))
      cacheState.push([mm.color ? mm.color.getHex() : -1, +mm.opacity.toFixed(3)].join(':'));
  });

  const before = { a: read(a), b: read(b) };
  view.tintUnit(70001, 20, 20, 100, 128);         // the map's own ghosting call
  const afterTint = { a: read(a), b: read(b) };

  const cacheAfter = [];
  cached?.gltf.scene.traverse((o) => {
    if (o.isMesh) for (const mm of matsOf(o))
      cacheAfter.push([mm.color ? mm.color.getHex() : -1, +mm.opacity.toFixed(3)].join(':'));
  });

  // a third unit spawned after the tint must arrive clean, not pre-ghosted
  await view.spawnView(ent(70003, 400));
  const c = view.views.get(70003);
  const fresh = c ? read(c) : null;

  // and the tint has to come off again the way the map takes it off
  view.tintUnit(70001, 255, 255, 255, 255);
  const restored = read(a);

  // ------------------------------------------------------------- disposal
  // Counters, not object identity: what matters is that the GPU gets its
  // memory back, and renderer.info is where the game itself reports it.
  // renderer.info counts what has been *uploaded*, so each stage has to be
  // drawn before it is read -- a spawn that never reaches a frame costs
  // nothing yet, and measuring there would pass no matter what disposal did.
  const draw = () => view.renderer.render(view.scene, view.camera);
  const mem = () => ({ g: view.renderer.info.memory.geometries,
                       t: view.renderer.info.memory.textures });
  // Chromium drops this page's first WebGL context and hands back a new one a
  // few frames later; three no-ops its renders in between and uploads nothing,
  // so a counter read right after a draw can be zero for a reason that has
  // nothing to do with disposal. Draw across frames until it moves.
  const settle = async (want) => {
    for (let i = 0; i < 60 && !(mem().g > want); i++) {
      await new Promise(requestAnimationFrame);
      draw();
    }
  };
  // Cycled, not measured once: a leak is growth over time, and a single
  // spawn/remove pair cannot tell "freed" from "never allocated".
  // Warm the model cache before the baseline is taken. loadModel keeps the
  // glTF it parsed, so the *first* spawn of a type uploads geometry that is
  // never given back -- that is the cache doing its job, not a leak. Measuring
  // from before it was warm made "gives the geometry back" a comparison against
  // an empty renderer, which nothing could satisfy; it passed only because a
  // lost WebGL context had every counter reading zero.
  let id = 80000;
  await view.spawnView(ent(++id, 0));
  draw();
  await settle(0);
  view.removeView(id);
  draw();
  const base = mem();
  const cycles = [];
  for (let c = 0; c < 3; c++) {
    const ids = [];
    for (let i = 0; i < 4; i++) { ids.push(++id); await view.spawnView(ent(id, i * 90)); }
    draw();
    const peak = mem();
    for (const i of ids) view.removeView(i);
    draw();
    cycles.push({ peak, rest: mem() });
  }
  const peak = cycles[0].peak;
  const after = cycles[cycles.length - 1].rest;

  // ------------------------------------------------------------- missiles
  // The pipeline's model-forward is +X at yaw 0, so the object's own +X axis
  // has to end up pointing along the direction of travel.
  const idx = await view.modelIndex();
  const path = [...idx.exact.keys()].find((k) => /missile/.test(k) && !/\bnone\b/.test(k));
  let heading = null;
  if (path) {
    await view.spawnMissile({ fx: 9001, path, x: 0, y: 0, tx: 1000, ty: 0, speed: 500 });
    const m = view.missiles.get(9001);
    if (m) {
      view.stepMissiles(0.1);
      const fwd = new THREE.Vector3(1, 0, 0).applyQuaternion(m.obj.quaternion);
      // travelling due east in WC3 is +x, and toZ negates y, so z stays 0
      heading = { x: +fwd.x.toFixed(3), z: +fwd.z.toFixed(3) };
      view.endMissile(9001);
    }
  }

  // --------------------------------------------------------------- picking
  // A Locust dummy: Locust, and a model name the map deliberately leaves empty.
  for (const [k] of [...view.views]) view.removeView(k);
  await view.spawnView({ i: 71000, k: 1, t: 0, x: 0, y: 0, f: 0, model: '',
                         locust: true, radius: 32, name: 'dummy' });
  const dummy = view.views.get(71000);
  const picked = view.pickEntity(0, 0);

  return {
    prims: a.prims.length,
    tintChangedTarget: JSON.stringify(before.a) !== JSON.stringify(afterTint.a),
    bystanderUntouched: JSON.stringify(before.b) === JSON.stringify(afterTint.b),
    cacheUntouched: JSON.stringify(cacheState) === JSON.stringify(cacheAfter),
    freshSpawnClean: fresh && JSON.stringify(fresh) === JSON.stringify(before.b),
    tintRestores: JSON.stringify(restored) === JSON.stringify(before.a),
    mem: { base, peak, after, cycles },
    heading, missilePath: path || null,
    dummyExists: !!dummy, dummyHasMesh: dummy ? dummy.root.children.length : -1,
    pickedDummy: picked ? picked.id : null,
  };
}, MODEL);

console.log(JSON.stringify(out, null, 1));
if (out.error) { console.log('ABORT: ' + out.error); await browser.close(); process.exit(1); }

check('the model has materials to tint', out.prims > 0, `${out.prims} prims`);
check('a tint reaches the unit it names', out.tintChangedTarget === true);
check('another unit of the same type is untouched', out.bystanderUntouched === true,
      out.bystanderUntouched ? '' : 'the whole species was recoloured');
check('the model cache is untouched', out.cacheUntouched === true,
      out.cacheUntouched ? '' : 'the tint would outlive the unit');
check('a unit spawned after the tint arrives clean', out.freshSpawnClean === true);
check('the tint comes off again', out.tintRestores === true);

const { base, peak, after, cycles } = out.mem;
check('spawning costs GPU memory', peak.g > base.g, `${base.g} -> ${peak.g} geometries`);
check('every cycle gives the geometry back', cycles.every((c) => c.rest.g <= base.g),
      cycles.map((c) => `${c.peak.g}/${c.rest.g}`).join(' '));
check('geometry does not creep across cycles',
      new Set(cycles.map((c) => c.rest.g)).size === 1,
      `rest: ${cycles.map((c) => c.rest.g).join(', ')} (baseline ${base.g})`);
// Asserted now. This used to be a note: the count climbed 9 per unit spawned
// and never fell, and the texanim clones were the wrong suspect -- they share
// the cache's source and sampler key, so disposing one moves nothing. The
// nine were bone textures: a Skeleton per skinned geoset, a DataTexture each,
// made by the renderer on first draw and disposed by nobody. releaseGPU
// disposes the skeleton now, and the geosets share one.
check('every cycle gives the textures back', cycles.every((c) => c.rest.t <= base.t),
      `${base.t} -> ${cycles.map((c) => c.rest.t).join(' -> ')}`);
check('textures do not creep across cycles',
      new Set(cycles.map((c) => c.rest.t)).size === 1,
      `${((after.t - base.t) / 12).toFixed(1)} per unit spawned`);

check('a missile model was found to aim', !!out.missilePath, out.missilePath || 'none');
check('a missile points along its travel', out.heading
      && out.heading.x > 0.99 && Math.abs(out.heading.z) < 0.02,
      JSON.stringify(out.heading) + ' (want x=1, z=0 flying east)');

check('a locust dummy has no mesh', out.dummyExists && out.dummyHasMesh === 0,
      `${out.dummyHasMesh} children`);
check('and cannot be clicked', out.pickedDummy === null,
      out.pickedDummy === null ? '' : `picked ${out.pickedDummy}`);

// --------------------------------------------------- the emitter flags
//
// Three flags every emitter carries and none was read. Checked on the real
// materials in the scene, because a uniform that is computed and never bound is
// exactly what a data-only check would wave through.
const emit = await page.evaluate(async () => {
  const view = window.view;
  const THREE = window.THREE;
  // An aura rather than a one-shot: a model whose only sequence is Birth ends
  // itself the moment that animation finishes, which is a fine way to watch an
  // effect vanish before the check reads it. This one loops, and the map marks
  // some of its emitters unfogged, so both branches are present.
  await view.spawnEffect({ fx: 'emitfog', path: 'war3mapImported\\SandAura.mdx',
                           x: 0, y: 0, ttl: 600 });
  await new Promise((r) => setTimeout(r, 200));
  // The bench page renders on demand and never runs the frame loop, so the
  // emitters have to be stepped by hand: that is where an emitter picks up the
  // scene's current fog, which is the whole point of the check below.
  for (const e of view.effects.values()) {
    const ctx = view.animCtxOf(e);
    for (const p of (e.emitters || [])) p.update(1 / 30, ctx);
  }
  const mats = [];
  view.scene.traverse((o) => {
    if (o.userData && o.userData.w3emitter && o.material && o.material.uniforms) mats.push(o.material);
  });
  if (!mats.length) return { none: true };
  const u = mats[0].uniforms;
  // and one that the model itself marks unfogged, if this effect has one
  const unfogged = mats.find((m) => m.uniforms.fogged.value === 0);
  const fogged = mats.find((m) => m.uniforms.fogged.value === 1);
  return {
    count: mats.length,
    fogOn: mats.every((m) => m.fog === true),
    hasFogUniforms: !!(u.fogColor && u.fogNear && u.fogFar),
    // three.js only refreshes these for a material with fog on, so a non-zero
    // far plane proves the renderer is feeding them
    fogFar: fogged ? fogged.uniforms.fogFar.value : null,
    sceneFogFar: view.scene.fog ? view.scene.fog.far : null,
    anyUnfogged: !!unfogged,
    additiveFlagsMatch: mats.every((m) =>
      (m.uniforms.additive.value === 1) === (m.blending === THREE.AdditiveBlending)),
  };
});
check('an emitter-only effect builds emitters at all', !emit.none && emit.count > 0,
      emit.none ? 'none built' : `${emit.count}`);
if (!emit.none) {
  check('every emitter material has fog switched on', emit.fogOn === true, String(emit.fogOn));
  check('and carries the three uniforms three.js feeds', emit.hasFogUniforms === true);
  check('the renderer really feeds them the scene\'s own fog',
        emit.fogFar !== null && emit.sceneFogFar !== null
        && Math.abs(emit.fogFar - emit.sceneFogFar) < 1,
        `${emit.fogFar} vs scene ${emit.sceneFogFar}`);
  check('the additive uniform agrees with the blend mode', emit.additiveFlagsMatch === true);
}

const sorted = await page.evaluate(async () => {
  const view = window.view;
  // 14 models carry a BLENDED point emitter that asks to be sorted, which is the
  // only combination where draw order changes the picture -- addition is
  // commutative, so the 186 additive ones look the same either way and are
  // deliberately left unsorted.
  await view.spawnEffect({ fx: 'emitsort', path: 'Units\\Human\\WaterElemental\\WaterElemental.mdl',
                           x: 400, y: 400, ttl: 600 });
  await new Promise((r) => setTimeout(r, 200));
  // The emitter's rate is scoped to the sequence being played, and a unit model
  // spawned as an effect is not playing the one that turns this emitter on. The
  // sort is what is under test, not the emission rule, so the particles are put
  // there by hand and then one update sorts them.
  for (const e of view.effects.values()) {
    const ctx = view.animCtxOf(e);
    for (const p of (e.emitters || [])) {
      if (!p.sortFarZ) continue;
      for (let k = 0; k < 12; k++) p.spawn();
      p.update(1 / 30, ctx);
    }
  }
  const out = { checked: 0, indexed: 0, ordered: 0, skipped: 0 };
  const cams = [];
  view.scene.traverse((o) => {
    if (o.userData && o.userData.w3emitter && o.geometry && o.material.uniforms) cams.push(o);
  });
  for (const o of cams) {
    // only the blended point emitters that ask for it get an index buffer
    const wants = o.geometry.index && o.type === 'Points';
    if (!wants) continue;
    out.checked++;
    out.indexed++;
    const g = o.geometry, pos = g.attributes.position.array;
    const n = g.drawRange.count;
    if (n < 2) { out.skipped++; out.indexed--; out.checked--; continue; }
    const cam = view.camera;
    const inv = new window.THREE.Matrix4().copy(o.matrixWorld).invert();
    const c = new window.THREE.Vector3().setFromMatrixPosition(cam.matrixWorld).applyMatrix4(inv);
    let monotonic = true;
    let prev = Infinity;
    for (let i = 0; i < n; i++) {
      const j = g.index.array[i];
      const dx = pos[j * 3] - c.x, dy = pos[j * 3 + 1] - c.y, dz = pos[j * 3 + 2] - c.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d > prev + 1e-3) { monotonic = false; break; }
      prev = d;
    }
    if (monotonic) out.ordered++;
  }
  return out;
});
// this effect may carry no blended sorted emitter at all; the check is that
// when one is indexed, its indices really are far to near
check('a blended emitter that asks to be sorted gets an index buffer',
      sorted.indexed > 0, `${sorted.indexed} indexed`);
check('and its indices really run far to near',
      sorted.indexed > 0 && sorted.ordered === sorted.indexed,
      `${sorted.ordered} of ${sorted.indexed} in order`);

// ---------------------------------------------------- the day/night light
//
// The renderer's own three constants were lighting the world. Read the sun and
// the ambient back off the scene after the map's model is applied, because a
// curve that is compiled correctly and never reaches a light is exactly the
// failure a data-only check would pass.
const dnc = await page.evaluate(async () => {
  const view = window.view;
  const curves = await fetch('/data/daynight.json').then((r) => r.json()).catch(() => ({}));
  const key = 'environment\\dnc\\dnclordaeron\\dnclordaeronterrain\\dnclordaeronterrain';
  const unit = 'environment\\dnc\\dnclordaeron\\dnclordaeronunit\\dnclordaeronunit';
  if (!view.setDayNight || !curves[key]) return { missing: true };
  const before = view.sun.color.getHex();
  view.setDayNight(curves, { terrain: key, unit, hour: 12 });
  const noon = { sun: view.sun.color.getHex(), amb: view.hemi.color.getHex(),
                 i: +view.sun.intensity.toFixed(3) };
  view.setTimeOfDay(0);
  const night = { sun: view.sun.color.getHex(), amb: view.hemi.color.getHex() };
  view.setTimeOfDay(12);
  return { before, noon, night };
});
check('the day/night curves reach the renderer', !dnc.missing,
      dnc.missing ? 'no curve or no setDayNight' : '');
if (!dnc.missing) {
  check('the sun stops being the renderer\'s own 0xfff0d8',
        dnc.before === 0xfff0d8 && dnc.noon.sun !== 0xfff0d8,
        `${dnc.before.toString(16)} -> ${dnc.noon.sun.toString(16)}`);
  check('noon is brighter than midnight on the same light',
        (dnc.noon.sun & 0xff) > (dnc.night.sun & 0xff),
        `noon ${dnc.noon.sun.toString(16)} vs night ${dnc.night.sun.toString(16)}`);
  check('and the ambient moves with it', dnc.noon.amb !== dnc.night.amb,
        `${dnc.noon.amb.toString(16)} vs ${dnc.night.amb.toString(16)}`);
  check('the sun takes the model\'s own intensity', Math.abs(dnc.noon.i - 1.3) < 1e-6,
        String(dnc.noon.i));
}

check('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
await browser.close();
process.exit(passed === results.length ? 0 : 1);
