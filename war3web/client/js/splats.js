/**
 * Warcraft III's ground splats, and the event objects that throw them.
 *
 * An MDX event object is a node with a name and a list of keyframes: at that
 * moment in that animation, something happens. The name is a four-character
 * kind and a four-character id into one of the game's tables --
 *
 *   SPLxHBS1   a splat: Human Blood Small 1, from Splats\SplatData.slk
 *   FPTxFBL1   a footprint, which lives in that same table
 *   UBRxDHSB   an ubersplat, from Splats\UberSplatData.slk
 *   SPNxDNBL   a model to throw, from Splats\SpawnData.slk
 *   SNDxDHLS   a sound, from UI\SoundInfo\AnimLookups.slk
 *
 * 827 of this map's 1101 models carry these. The converter used to drop the
 * fire times, so none of it could ever happen: a spider died and left nothing
 * on the ground, feet landed silently, nothing bled.
 *
 * A splat is a flat quad on the terrain drawn from one cell of a sprite sheet.
 * It walks a range of cells while it lives, then holds a second range while it
 * decays, and its colour runs start -> middle -> end with the alpha included --
 * which is how blood darkens and dries rather than simply fading.
 */
import * as THREE from 'three';

const lerp = (a, b, t) => a + (b - a) * t;

/** Colour and alpha at a point in the splat's life, over its three stops. */
function ramp(c, t) {
  const half = t < 0.5;
  const u = half ? t * 2 : (t - 0.5) * 2;
  const a = c[half ? 0 : 1], b = c[half ? 1 : 2];
  return [lerp(a[0], b[0], u) / 255, lerp(a[1], b[1], u) / 255,
          lerp(a[2], b[2], u) / 255, lerp(a[3], b[3], u) / 255];
}

export class SplatField {
  /**
   * `spec` is the splat table; `heightAt` puts the quad on the terrain and
   * `loadTexture` resolves the sheet. Splats are pooled by nothing -- they are
   * short-lived and few -- but the geometry and material are per-splat because
   * each one animates its own cell and colour.
   */
  constructor(scene, table, heightAt, loadTexture) {
    this.scene = scene;
    // The field is built with the terrain, which happens before boot has
    // fetched the tables -- so hold a getter rather than a snapshot, or the
    // field captures `undefined` and silently never draws anything.
    this._table = table;
    this.heightAt = heightAt;
    this.loadTexture = loadTexture;
    this.live = [];
    // A battlefield can bleed faster than the ground can hold; oldest goes
    // first so a long fight does not accumulate quads without bound.
    this.cap = 120;
  }

  /** Drop one splat at a world point, by table id. */
  get table() {
    const t = typeof this._table === 'function' ? this._table() : this._table;
    return t || {};
  }

  add(id, wx, wy) {
    // ids in the tables are upper case; a few models write theirs otherwise
    const t = this.table;
    return this.addSpec(t[id] || t[String(id).toUpperCase()], wx, wy);
  }

  /** ...or from a spec built elsewhere, which is how ubersplats come through. */
  addSpec(d, wx, wy) {
    if (!d || !d.t) return null;
    const tex = this.loadTexture(d.t);
    if (!tex) return null;
    const s = Math.max(8, d.s || 50);
    const geo = new THREE.PlaneGeometry(s, s);
    const mat = new THREE.MeshBasicMaterial({
      map: tex, transparent: true, depthWrite: false,
      blending: THREE.NormalBlending,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set(wx, this.heightAt(wx, wy) + 1.5, -wy);
    mesh.renderOrder = -3;             // beneath shadows and ubersplats
    this.scene.add(mesh);
    const sp = { mesh, mat, geo, d, t: 0,
                 life: Math.max(0.05, d.life || 2), decay: Math.max(0.05, d.decay || 10) };
    this.live.push(sp);
    while (this.live.length > this.cap) this.remove(this.live[0]);
    this.step(sp, 0);
    return sp;
  }

  /** Point the quad's UVs at one cell of the sheet. */
  cell(sp, index) {
    const { rows, cols } = sp.d;
    const c = Math.max(0, Math.min(rows * cols - 1, index | 0));
    const u = (c % cols) / cols, v = 1 - (Math.floor(c / cols) + 1) / rows;
    const a = sp.geo.attributes.uv.array;
    a[0] = u; a[1] = v + 1 / rows;
    a[2] = u + 1 / cols; a[3] = v + 1 / rows;
    a[4] = u; a[5] = v;
    a[6] = u + 1 / cols; a[7] = v;
    sp.geo.attributes.uv.needsUpdate = true;
  }

  step(sp, dt) {
    sp.t += dt;
    const [l0, l1, d0, d1] = sp.d.uv || [0, 0, 0, 0];
    let k, from, to;
    if (sp.t <= sp.life) { k = sp.t / sp.life; from = l0; to = l1; }
    else { k = Math.min(1, (sp.t - sp.life) / sp.decay); from = d0; to = d1; }
    this.cell(sp, Math.round(lerp(from, to, k)));
    // colour runs across the whole life, living and decaying together
    const whole = Math.min(1, sp.t / (sp.life + sp.decay));
    const [r, g, b, a] = ramp(sp.d.c, whole);
    sp.mat.color.setRGB(r, g, b);
    sp.mat.opacity = a;
    return sp.t < sp.life + sp.decay;
  }

  update(dt) {
    for (let i = this.live.length - 1; i >= 0; i--) {
      if (!this.step(this.live[i], dt)) this.remove(this.live[i]);
    }
  }

  remove(sp) {
    const i = this.live.indexOf(sp);
    if (i >= 0) this.live.splice(i, 1);
    this.scene.remove(sp.mesh);
    sp.geo.dispose();
    sp.mat.dispose();
  }
}

/**
 * Collect the event objects in a loaded model.
 *
 * Each is a node with a per-sequence list of times, in seconds from that
 * sequence's start. The node itself is where the thing happens -- a foot, a
 * wound -- so its world position is what the caller needs when one fires.
 */
export function buildEvents(root) {
  const out = [];
  root.traverse((o) => {
    const def = o.userData && o.userData.w3event;
    if (def && Array.isArray(def.at)) out.push({ node: o, d: def, last: -1, seq: -1 });
  });
  return out;
}

/**
 * Fire every event whose time the clip has just crossed.
 *
 * `ctx` is the sequence being played and how far into it, the same context the
 * emitters use. Crossing is measured against the previous frame's time, so a
 * looping clip fires once per lap and a clip that is restarted fires again.
 */
export function stepEvents(events, ctx, fire) {
  if (!ctx || ctx.seq == null || ctx.seq < 0) return;
  for (const e of events) {
    const times = e.d.at[ctx.seq];
    if (!times || !times.length) { e.last = ctx.t; e.seq = ctx.seq; continue; }
    // a new sequence, or the clip looped: start looking from the top again
    if (e.seq !== ctx.seq || ctx.t < e.last) e.last = -1;
    for (const t of times) {
      if (t > e.last && t <= ctx.t) fire(e);
    }
    e.last = ctx.t;
    e.seq = ctx.seq;
  }
}
