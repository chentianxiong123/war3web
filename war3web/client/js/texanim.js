/**
 * Warcraft III texture animations, rebuilt on the client.
 *
 * A material layer can bind a TXAN entry, which slides, turns or stretches the
 * layer's UVs while the model plays. It is how a beam flows along its own
 * length, a portal turns, an aura crawls and a flipbook steps from cell to
 * cell. 83 layers across 39 of this map's models ask for one, and none of it
 * was carried across, so every one of them drew a still image.
 *
 * Two clocks drive these, and the difference matters. Most tracks -- 55 of the
 * 87 here -- are bound to a *global sequence*: they loop on a fixed period of
 * their own regardless of which animation is playing, which is what keeps a
 * flame scrolling while its owner stands, walks and attacks. The rest are
 * scoped to the playing sequence like everything else in this renderer.
 *
 * Materials and their textures arrive shared out of the model cache, so a view
 * that animates one has to own its own copies first or the whole scene's copies
 * of that model would slide together.
 */
import * as THREE from 'three';

/** Sample a vector track: `[t, x, y, …]` rows, held or interpolated. */
function sampleVec(keys, t, step, dim) {
  if (!keys || !keys.length) return null;
  if (t <= keys[0][0]) return keys[0].slice(1, 1 + dim);
  const last = keys[keys.length - 1];
  if (t >= last[0]) return last.slice(1, 1 + dim);
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1];
    if (t < a[0] || t > b[0]) continue;
    if (step) return a.slice(1, 1 + dim);
    const span = b[0] - a[0];
    const u = span <= 0 ? 0 : (t - a[0]) / span;
    const out = [];
    for (let k = 0; k < dim; k++) out.push(a[1 + k] + (b[1 + k] - a[1 + k]) * u);
    return out;
  }
  return last.slice(1, 1 + dim);
}

/**
 * One channel of a texture animation at this instant.
 *
 * `entry` is either `{g, k}` — its own looping clock — or one value per
 * sequence, each a constant or a list of keys. `elapsed` is wall-clock seconds
 * for the global form; `ctx` is the playing sequence for the scoped one.
 */
function channelAt(entry, step, ctx, elapsed, dflt, dim) {
  if (!entry) return dflt;
  if (!Array.isArray(entry)) {
    // its own clock, looping every `g` seconds
    const period = entry.g || 1;
    return sampleVec(entry.k, elapsed % period, step, dim) || dflt;
  }
  if (!ctx || ctx.seq == null || ctx.seq < 0) return dflt;
  const e = entry[ctx.seq];
  if (!e) return dflt;
  if (!Array.isArray(e[0])) return e;                 // constant for this sequence
  return sampleVec(e, ctx.t || 0, step, dim) || dflt;
}

const T0 = [0, 0], S1 = [1, 1], R0 = [0, 0, 0, 1];

/**
 * Give every animated layer its own material and texture, and hand back what
 * has to be stepped each frame.
 *
 * `prims` is the mesh list in geoset order, which is what `meta.geosets` is
 * indexed by -- the same pairing applyMaterials relies on.
 */
export function buildTexAnims(prims, meta) {
  const out = [];
  (prims || []).forEach((mesh, i) => {
    const gi = meta?.geosets?.[i];
    const mt = gi ? meta.materials?.[gi.material] : null;
    if (!mt?.uv) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const owned = mats.map((mm) => {
      const c = mm.clone();
      // the texture carries the transform, and it is shared too
      if (c.map) {
        c.map = c.map.clone();
        c.map.wrapS = c.map.wrapT = THREE.RepeatWrapping;
        c.map.center.set(0.5, 0.5);
        c.map.needsUpdate = true;
      }
      if (c.emissiveMap) c.emissiveMap = c.map;
      return c;
    });
    mesh.material = owned.length === 1 ? owned[0] : owned;
    out.push({ maps: owned.map((m) => m.map).filter(Boolean), d: mt.uv, mats: owned });
  });
  return out;
}

/**
 * Free what buildTexAnims cloned. The material and the texture are copies this
 * view alone draws with -- a fresh GPU upload per unit -- so unlike the rest of
 * the mesh they are the view's to release when it goes.
 */
export function disposeTexAnims(list) {
  for (const a of list || []) {
    for (const m of a.mats || []) m.dispose();
    for (const t of a.maps || []) t.dispose();
  }
}

/** Advance every animated layer. `elapsed` is seconds since the view was built. */
export function stepTexAnims(list, ctx, elapsed) {
  for (const a of list) {
    const d = a.d;
    const t = channelAt(d.t, d.tStep, ctx, elapsed, T0, 2);
    const s = channelAt(d.s, d.sStep, ctx, elapsed, S1, 2);
    const r = channelAt(d.r, d.rStep, ctx, elapsed, R0, 4);
    // the quaternion turns about the surface normal, so only its Z part shows
    const ang = 2 * Math.atan2(r[2], r[3]);
    for (const map of a.maps) {
      // Warcraft III's V axis runs opposite glTF's, so a downward scroll in the
      // model is an upward one here.
      map.offset.set(t[0], -t[1]);
      map.repeat.set(s[0] || 1, s[1] || 1);
      map.rotation = ang;
    }
  }
}
