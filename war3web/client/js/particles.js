/**
 * Warcraft III ParticleEmitter2, rebuilt on the client.
 *
 * glTF has no concept of a particle emitter, so tools/mdx2gltf.py carries each
 * one across as node extras and this puts it back. It matters more than it
 * sounds: around eighty of the game's effect models -- Death and Decay, Cloud of
 * Fog, Flame Strike's burn, most of the blood and frost -- contain no geometry
 * whatsoever. Strip the emitters and they convert to a valid, entirely empty
 * scene, which is exactly how a spell ends up doing its animation while nothing
 * appears.
 *
 * Emitted particles do not follow the bone they came from; they are placed in
 * the effect's own space and left there, which is how Warcraft III behaves for
 * everything but a model-space emitter -- and those, 223 of them here, are
 * parented to their node instead so the particles ride along with it.
 */
import * as THREE from 'three';

// Warcraft III fogs a particle like anything else unless the emitter carries
// the Unfogged flag: 152 of this map's 2493 emitters do, 2341 do not, and
// nothing here was fogged at all. That stopped mattering while the world's fog
// was a soft blue starting at 4200 and started mattering the day it became the
// map's own black starting at 3000, with distant effects sitting bright against
// a black horizon.
//
// An additive emitter cannot mix toward the fog colour the way an opaque
// surface does -- adding grey to a bright spark brightens it -- so it fades
// toward nothing instead, which is the same thing whenever the fog is black and
// the right thing when it is not.
const FOG_PARS_V = `
uniform float fogNear;
uniform float fogFar;
varying float vFogK;
`;
const FOG_PARS_F = `
uniform vec3 fogColor;
uniform float fogged;
uniform float additive;
varying float vFogK;
`;
const FOG_APPLY = `
  float k = vFogK * fogged;
  if (additive > 0.5) gl_FragColor.rgb *= 1.0 - k;
  else gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, k);
`;

const VERT = FOG_PARS_V + `
attribute float psize;
attribute float palpha;
attribute vec3 pcolor;
attribute vec2 pcell;
varying float vAlpha;
varying vec3 vColor;
varying vec2 vCell;
void main() {
  vAlpha = palpha; vColor = pcolor; vCell = pcell;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vFogK = smoothstep(fogNear, fogFar, -mv.z);
  gl_PointSize = psize * (300.0 / max(1.0, -mv.z));
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = FOG_PARS_F + `
uniform sampler2D map;
uniform vec2 grid;
varying float vAlpha;
varying vec3 vColor;
varying vec2 vCell;
void main() {
  if (vAlpha <= 0.0) discard;
  vec2 uv = (vCell + gl_PointCoord) / grid;
  uv.y = 1.0 - uv.y;                       // glTF images are top-down
  vec4 t = texture2D(map, uv);
  gl_FragColor = vec4(t.rgb * vColor, t.a * vAlpha);
` + FOG_APPLY + `
  if (gl_FragColor.a < 0.01) discard;
}`;

// A tail particle is a streak, not a dot: the quad runs from where the particle
// is back along its own velocity. `gl_PointSize` cannot express that, so tail
// emitters get real geometry -- 510 of this map's emitters are tail-only and a
// further 177 are head-and-tail, and every one of them used to draw as a round
// billboard. Sparks, debris trails and missile exhaust are all in that set.
const TAIL_VERT = FOG_PARS_V + `
attribute vec3 pvel;
attribute vec2 corner;      // x: 0 at the head, 1 at the tail; y: -1..1 across
attribute float psize;
attribute float palpha;
attribute vec3 pcolor;
attribute vec2 pcell;
uniform float tailLen;
varying float vAlpha;
varying vec3 vColor;
varying vec2 vCell;
varying vec2 vQuad;
void main() {
  vAlpha = palpha; vColor = pcolor; vCell = pcell;
  vQuad = vec2(corner.x, corner.y * 0.5 + 0.5);
  vec4 head = modelViewMatrix * vec4(position, 1.0);
  vFogK = smoothstep(fogNear, fogFar, -head.z);
  vec3 vel = (modelViewMatrix * vec4(pvel, 0.0)).xyz;
  // a motionless particle has no direction to stretch along; stand it upright
  vec3 dir = length(vel) > 1e-4 ? normalize(vel) : vec3(0.0, 1.0, 0.0);
  vec3 p = head.xyz - dir * (tailLen * length(vel) * corner.x);
  // widen across the streak, square to the view, so it always faces the camera
  vec3 side = cross(dir, vec3(0.0, 0.0, 1.0));
  side = length(side) > 1e-4 ? normalize(side) : vec3(1.0, 0.0, 0.0);
  p += side * (corner.y * psize * 0.5);
  gl_Position = projectionMatrix * vec4(p, 1.0);
}`;

const TAIL_FRAG = FOG_PARS_F + `
uniform sampler2D map;
uniform vec2 grid;
varying float vAlpha;
varying vec3 vColor;
varying vec2 vCell;
varying vec2 vQuad;
void main() {
  if (vAlpha <= 0.0) discard;
  vec2 uv = (vCell + vQuad) / grid;
  uv.y = 1.0 - uv.y;
  vec4 t = texture2D(map, uv);
  gl_FragColor = vec4(t.rgb * vColor, t.a * vAlpha);
` + FOG_APPLY + `
  if (gl_FragColor.a < 0.01) discard;
}`;

/**
 * The camera, for the emitters that ask to be drawn far to near.
 *
 * Set once by the renderer rather than threaded through every update() call:
 * the emitter context is about which sequence is playing, and the camera is not
 * part of that.
 */
let SORT_CAMERA = null, FOG_SCENE = null;
/**
 * The camera to sort against and the scene to read the fog from.
 *
 * The fog has to be read here rather than left to three.js: the renderer only
 * refreshes fogColor, fogNear and fogFar for the material types it ships, and a
 * raw ShaderMaterial is not one of them, so `fog: true` alone leaves the
 * uniforms at whatever they were built with. Copying them each frame also means
 * an emitter follows a SetTerrainFogEx that arrives after it was created.
 */
export function setSortCamera(cam, scene) { SORT_CAMERA = cam; FOG_SCENE = scene || FOG_SCENE; }
const _camLocal = new THREE.Vector3();
const _inv = new THREE.Matrix4();

const lerp = (a, b, t) => a + (b - a) * t;
const ZERO = new THREE.Vector3();

/**
 * An emitter's on/off switch for the sequence being played.
 *
 * Warcraft III scopes animation tracks to the playing sequence, and an
 * emitter's visibility track is mostly a list of the sequences it is *off*
 * for -- across this map's models, 8594 of 10381 keyed (emitter, sequence)
 * pairs hold zero for the whole sequence. Emitting regardless, which is what
 * this did, is why a standing Huntress trailed riding dust and idle units
 * smoked and bled: the converter carries `vis` across per sequence, and
 * `ctx` is which one is playing and how far into it.
 *
 * No context means no animation to scope to, so the emitter simply runs.
 */
export function visAt(def, ctx) {
  return sampleSeq(def?.vis, ctx, 1, def?.visStep);
}

/**
 * Sample a per-sequence track at the moment `ctx` describes.
 *
 * Each entry is either a constant for that whole sequence or a list of
 * [seconds-from-sequence-start, value] pairs. Without a context there is no
 * sequence to look up, so the caller's default stands.
 */
export function sampleSeq(track, ctx, dflt, step) {
  if (!track || !ctx || ctx.seq == null || ctx.seq < 0) return dflt;
  const e = track[ctx.seq];
  if (e === undefined) return dflt;
  if (typeof e === 'number') return e;
  const t = ctx.t || 0;
  if (t <= e[0][0]) return e[0][1];
  const last = e[e.length - 1];
  if (t >= last[0]) return last[1];
  for (let i = 0; i < e.length - 1; i++) {
    if (t >= e[i][0] && t <= e[i + 1][0]) {
      // MDLINTERP_DONT_INTERP: the value holds until the next key rather than
      // sliding towards it, and that is how nearly every one of these tracks
      // is authored. Ramping instead turns a rate that should jump 0 -> 500
      // into a slide, and switches an emitter on early.
      if (step) return e[i][1];
      const span = e[i + 1][0] - e[i][0];
      return span <= 0 ? e[i + 1][1]
        : lerp(e[i][1], e[i + 1][1], (t - e[i][0]) / span);
    }
  }
  return last[1];
}

/** The largest rate a per-sequence track ever asks for, for sizing buffers. */
function peakOf(track, floor) {
  let peak = floor || 0;
  for (const e of track || []) {
    if (Array.isArray(e)) { for (const [, v] of e) peak = Math.max(peak, v); }
    else peak = Math.max(peak, e || 0);
  }
  return peak;
}

/** Colour, alpha and size are given at three moments; walk between them. */
function segment(e, t) {
  const half = t < 0.5;
  const u = half ? t * 2 : (t - 0.5) * 2;
  const i = half ? 0 : 1, j = half ? 1 : 2;
  const c0 = e.color[i], c1 = e.color[j];
  return {
    r: lerp(c0[0], c1[0], u), g: lerp(c0[1], c1[1], u), b: lerp(c0[2], c1[2], u),
    a: lerp(e.alpha[i], e.alpha[j], u),
    s: lerp(e.scale[i], e.scale[j], u),
  };
}

class Emitter {
  constructor(def, origin, texture) {
    this.d = def;
    this.origin = origin;
    // Size the pool from the loudest rate the emitter ever reaches, not the
    // static one: for an explosion the static rate is 0 and the real one --
    // up to 500 a second -- lives in the animated track.
    this.peakRate = peakOf(def.rate, def.rateStatic || 0);
    const cap = Math.max(8, Math.ceil(this.peakRate * Math.max(0.1, def.lifespan)) + 8);
    this.cap = Math.min(cap, 600);          // a runaway emitter must not stall the frame
    this.n = 0;
    // headOrTail: 0 head, 1 tail, 2 both. A tail needs a stretched quad, so it
    // gets four vertices per particle instead of one point.
    this.tail = def.headOrTail === 1 || def.headOrTail === 2;
    const per = this.tail ? 4 : 1;
    this.age = new Float32Array(this.cap);
    this.life = new Float32Array(this.cap);
    this.vel = new Float32Array(this.cap * 3);
    const pos = new Float32Array(this.cap * per * 3);
    const col = new Float32Array(this.cap * per * 3);
    const alp = new Float32Array(this.cap * per);
    const siz = new Float32Array(this.cap * per);
    const cell = new Float32Array(this.cap * per * 2);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('pcolor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('palpha', new THREE.BufferAttribute(alp, 1));
    geo.setAttribute('psize', new THREE.BufferAttribute(siz, 1));
    geo.setAttribute('pcell', new THREE.BufferAttribute(cell, 2));
    if (this.tail) {
      const vel = new Float32Array(this.cap * 4 * 3);
      const corner = new Float32Array(this.cap * 4 * 2);
      const idx = new Uint32Array(this.cap * 6);
      for (let i = 0; i < this.cap; i++) {
        const c = i * 8;
        corner[c] = 0; corner[c + 1] = -1;        // head, one side
        corner[c + 2] = 0; corner[c + 3] = 1;     // head, other side
        corner[c + 4] = 1; corner[c + 5] = -1;    // tail, one side
        corner[c + 6] = 1; corner[c + 7] = 1;     // tail, other side
        const v = i * 4, o = i * 6;
        idx[o] = v; idx[o + 1] = v + 2; idx[o + 2] = v + 1;
        idx[o + 3] = v + 1; idx[o + 4] = v + 2; idx[o + 5] = v + 3;
      }
      geo.setAttribute('pvel', new THREE.BufferAttribute(vel, 3));
      geo.setAttribute('corner', new THREE.BufferAttribute(corner, 2));
      geo.setIndex(new THREE.BufferAttribute(idx, 1));
    }
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);   // never cull
    const additive = def.filter === 1 || def.filter === 3 || def.filter === 4;
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: texture },
        grid: { value: new THREE.Vector2(def.cols, def.rows) },
        tailLen: { value: Math.max(0, def.tailLength || 0) },
        // three.js refreshes these three itself for any material with fog on,
        // so the emitter follows whatever SetTerrainFogEx last asked for
        fogColor: { value: new THREE.Color() },
        fogNear: { value: 1 },
        fogFar: { value: 1e6 },
        fogged: { value: def.unfogged ? 0 : 1 },
        additive: { value: additive ? 1 : 0 },
      },
      vertexShader: this.tail ? TAIL_VERT : VERT,
      fragmentShader: this.tail ? TAIL_FRAG : FRAG,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      fog: true,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    // SortPrimsFarZ: draw the far particles first so a nearer one lands on top.
    //
    // It only changes the picture where blending is order-dependent. Addition is
    // commutative, so the 186 additive emitters carrying this flag look
    // identical either way and pay nothing for it; the 32 blended point
    // emitters are what this is for. The two blended TAIL emitters are left
    // alone: their geometry is already indexed as quads and reordering it is a
    // different job for a pair of models.
    //
    // Only the index buffer is reordered, never the attributes, so the slot
    // pool that spawn() and update() share is untouched.
    this.sortFarZ = !!def.sortFarZ && !additive && !this.tail;
    if (this.sortFarZ) {
      this.order = new Uint32Array(this.cap);
      for (let i = 0; i < this.cap; i++) this.order[i] = i;
      geo.setIndex(new THREE.BufferAttribute(this.order, 1));
      this._keys = new Float32Array(this.cap);
      this._idx = new Array(this.cap);
    }
    this.points = this.tail ? new THREE.Mesh(geo, this.mat) : new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    // tail emitters are Meshes, not Points; tag both so a count of live
    // emitters does not silently drop by half when one becomes the other
    this.points.userData.w3emitter = true;
    this.geo = geo;
    this.per = per;
    this.emitAcc = 0;
    this.wasOn = false;      // whether the track had it switched on last frame
  }

  spawn() {
    const d = this.d, i = this.n < this.cap ? this.n++ : (Math.random() * this.cap) | 0;
    const lat = (d.latitude || 0) * Math.PI / 180;
    // a cone about straight up, `latitude` degrees wide
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.random() * lat;
    const sp = (d.speed || 0) * (1 + (Math.random() * 2 - 1) * (d.variation || 0) / Math.max(1, Math.abs(d.speed || 1)));
    const sx = Math.sin(phi) * Math.cos(theta), sy = Math.cos(phi), sz = Math.sin(phi) * Math.sin(theta);
    this.vel[i * 3] = sx * sp;
    this.vel[i * 3 + 1] = sy * sp;
    this.vel[i * 3 + 2] = sz * sp;
    // emitters have an extent: width across, length along
    const px = this.origin.x + (Math.random() - 0.5) * (d.width || 0);
    const py = this.origin.y;
    const pz = this.origin.z + (Math.random() - 0.5) * (d.length || 0);
    const pos = this.geo.attributes.position.array;
    const cells = Math.max(1, d.rows * d.cols);
    const c = (Math.random() * cells) | 0;
    const cell = this.geo.attributes.pcell.array;
    // one point, or the four corners of a streak, all seeded from the same spot
    for (let k = 0; k < this.per; k++) {
      const v = i * this.per + k;
      pos[v * 3] = px; pos[v * 3 + 1] = py; pos[v * 3 + 2] = pz;
      cell[v * 2] = c % d.cols;
      cell[v * 2 + 1] = (c / d.cols) | 0;
    }
    this.age[i] = 0;
    this.life[i] = Math.max(0.05, d.lifespan);
  }

  update(dt, ctx) {
    const d = this.d;
    const on = visAt(d, ctx) > 0.01;
    // The rate is usually animated; the static number beside it is 0 for every
    // emitter that spikes, which is most explosions. Whatever it works out to,
    // a rate of zero emits nothing -- there is no floor to fall back to.
    const rate = sampleSeq(d.rate, ctx, d.rateStatic || 0, d.rateStep);
    if (!on) {
      this.emitAcc = 0;
    } else if (rate > 0) {
      this.emitAcc += rate * dt;
      // Squirt throws its batch in a single frame instead of spreading it over
      // the second; that is the whole of what the flag means.
      let budget = d.squirt ? Math.min(this.emitAcc | 0, 60)
                            : Math.min(this.emitAcc | 0, 40);
      if (d.squirt) this.emitAcc = budget ? 0 : this.emitAcc;
      else this.emitAcc -= budget;
      while (budget-- > 0) this.spawn();
    }
    this.wasOn = on;
    // Linear fog only. The exponential styles carry a density rather than two
    // planes, and this map asks for style 0; an emitter under one of those is
    // left unfogged rather than fogged by a number that does not apply.
    const fog = FOG_SCENE && FOG_SCENE.fog;
    if (fog && fog.near !== undefined) {
      const u = this.mat.uniforms;
      u.fogColor.value.copy(fog.color);
      u.fogNear.value = fog.near;
      u.fogFar.value = fog.far;
    }
    const pos = this.geo.attributes.position.array;
    const col = this.geo.attributes.pcolor.array;
    const alp = this.geo.attributes.palpha.array;
    const siz = this.geo.attributes.psize.array;
    const pv = this.tail ? this.geo.attributes.pvel.array : null;
    const per = this.per;
    for (let i = 0; i < this.n; i++) {
      const base = i * per;
      this.age[i] += dt;
      const t = this.age[i] / this.life[i];
      if (t >= 1) {
        for (let k = 0; k < per; k++) alp[base + k] = 0;
        continue;
      }
      this.vel[i * 3 + 1] -= (d.gravity || 0) * dt;
      const vx = this.vel[i * 3], vy = this.vel[i * 3 + 1], vz = this.vel[i * 3 + 2];
      const s = segment(d, t);
      for (let k = 0; k < per; k++) {
        const v = base + k;
        pos[v * 3]     += vx * dt;
        pos[v * 3 + 1] += vy * dt;
        pos[v * 3 + 2] += vz * dt;
        col[v * 3] = s.r; col[v * 3 + 1] = s.g; col[v * 3 + 2] = s.b;
        alp[v] = s.a;
        siz[v] = s.s;
        if (pv) { pv[v * 3] = vx; pv[v * 3 + 1] = vy; pv[v * 3 + 2] = vz; }
      }
    }
    if (this.sortFarZ && this.n > 1) this.sortByDepth();
    // a point list draws vertices; a streak draws two triangles per particle
    this.geo.setDrawRange(0, this.tail ? this.n * 6 : this.n);
    const names = ['position', 'pcolor', 'palpha', 'psize', 'pcell'];
    if (this.tail) names.push('pvel');
    for (const a of names) this.geo.attributes[a].needsUpdate = true;
  }

  /** Far particles first, by distance from the camera in the emitter's own space. */
  sortByDepth() {
    const cam = SORT_CAMERA;
    if (!cam) return;
    this.points.updateWorldMatrix(true, false);
    _inv.copy(this.points.matrixWorld).invert();
    _camLocal.setFromMatrixPosition(cam.matrixWorld).applyMatrix4(_inv);
    const pos = this.geo.attributes.position.array;
    const keys = this._keys, idx = this._idx;
    for (let i = 0; i < this.n; i++) {
      const dx = pos[i * 3] - _camLocal.x;
      const dy = pos[i * 3 + 1] - _camLocal.y;
      const dz = pos[i * 3 + 2] - _camLocal.z;
      keys[i] = dx * dx + dy * dy + dz * dz;
      idx[i] = i;
    }
    const live = idx.slice(0, this.n);
    live.sort((a, b) => keys[b] - keys[a]);          // farthest first
    for (let i = 0; i < this.n; i++) this.order[i] = live[i];
    this.geo.index.needsUpdate = true;
  }

  dispose() { this.geo.dispose(); this.mat.dispose(); }
}

/**
 * Rebuild every emitter in a loaded model, parented to `root` so the whole
 * effect can be moved and removed as one thing.
 */
export function buildEmitters(root, loadTexture) {
  const out = [];
  root.updateWorldMatrix(true, true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  root.traverse((o) => {
    const def = o.userData && o.userData.w3particle;
    if (!def || !def.texture) return;
    const tex = loadTexture(def.texture);
    if (!tex) return;
    // A model-space emitter's particles ride with the bone that threw them
    // instead of being left where they were born -- 223 of this map's emitters
    // say so, and the header above admits this was the one case not handled.
    // Parenting the whole system to the node is exactly that behaviour, and it
    // makes the spawn point the node's own origin.
    if (def.modelSpace) {
      const e = new Emitter(def, ZERO, tex);
      o.add(e.points);
      out.push(e);
      return;
    }
    const origin = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld).applyMatrix4(inv);
    const e = new Emitter(def, origin, tex);
    root.add(e.points);
    out.push(e);
  });
  return out;
}
