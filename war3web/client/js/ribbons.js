/**
 * Warcraft III RibbonEmitter, rebuilt on the client.
 *
 * A ribbon is a trail. The emitter is a point on the skeleton -- a sword tip, a
 * hand, the leading edge of a wave -- and the game leaves a strip of texture
 * behind it as the animation drags it through space. There are 326 of them
 * across 128 of this map's models, and they are most of what a swing looks
 * like: strip them and a sword slash is an arm moving through empty air.
 *
 * glTF has no ribbon primitive, so tools/mdx2gltf.py carries the emitter across
 * as node extras and this puts it back. Each frame the emitter's world position
 * gives one new pair of edge points, `above` and `below` it along its own up
 * axis; the last `lifespan` seconds of those pairs are stitched into a strip.
 */
import * as THREE from 'three';
import { visAt } from './particles.js';

const VERT = `
attribute float aAlpha;
varying float vAlpha;
varying vec2 vUv;
void main() {
  vAlpha = aAlpha;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = `
uniform sampler2D map;
uniform vec3 tint;
varying float vAlpha;
varying vec2 vUv;
void main() {
  if (vAlpha <= 0.0) discard;
  vec4 t = texture2D(map, vUv);
  gl_FragColor = vec4(t.rgb * tint, t.a * vAlpha);
  if (gl_FragColor.a < 0.01) discard;
}`;

const UP = new THREE.Vector3(0, 1, 0);

class Ribbon {
  constructor(def, node, root, texture) {
    this.d = def;
    this.node = node;
    this.root = root;
    // one pair of edge points per emitted segment, for `lifespan` seconds of them
    this.cap = Math.min(240, Math.max(4, Math.ceil(def.rate * Math.max(0.05, def.lifespan)) + 2));
    this.seg = [];                       // newest last
    this.acc = 0;
    this.age = 0;

    const pos = new Float32Array(this.cap * 2 * 3);
    const uv = new Float32Array(this.cap * 2 * 2);
    const al = new Float32Array(this.cap * 2);
    const idx = new Uint16Array(Math.max(0, (this.cap - 1) * 6));
    for (let i = 0, o = 0; i < this.cap - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d2 = a + 3;
      idx[o++] = a; idx[o++] = b; idx[o++] = c;
      idx[o++] = b; idx[o++] = d2; idx[o++] = c;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('aAlpha', new THREE.BufferAttribute(al, 1));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);   // never cull

    // Warcraft III filter modes: 1 transparent, 2 blend, 3 additive, 4 addalpha
    const additive = def.filter === 3 || def.filter === 4;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: texture },
                  tint: { value: new THREE.Color(def.color[0], def.color[1], def.color[2]) } },
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.geo = geo;
    root.add(this.mesh);

    this._p = new THREE.Vector3();
    this._u = new THREE.Vector3();
    this._q = new THREE.Quaternion();
    this._s = new THREE.Vector3();
    this._s2 = new THREE.Vector3();
  }

  /**
   * Where the strip's two edges are this instant, in the effect's own space.
   *
   * Both offsets are taken in *world* space and only then brought into the
   * root's frame. Offsetting a root-local point by a world-space direction
   * mixes the two, and under the model root's Z-up-to-Y-up rotation that sends
   * the strip somewhere else entirely -- off screen, in the case that found it.
   */
  edges() {
    this.node.updateWorldMatrix(true, false);
    this._p.setFromMatrixPosition(this.node.matrixWorld);
    this.node.matrixWorld.decompose(this._s, this._q, this._s2);
    // the strip stands along the emitter's own up axis, so it twists with the
    // bone rather than always facing the sky
    this._u.copy(UP).applyQuaternion(this._q).normalize();
    const top = this._p.clone().addScaledVector(this._u, this.d.above);
    const bot = this._p.clone().addScaledVector(this._u, -this.d.below);
    this.root.worldToLocal(top);
    this.root.worldToLocal(bot);
    return { top, bot };
  }

  update(dt, ctx) {
    const d = this.d;
    this.age += dt;
    // A sword's trail belongs to the swing, not to standing still: the ribbon's
    // own visibility track says which sequences it draws in.
    if (visAt(d, ctx) <= 0.01) {
      this.seg.length = 0;
      this.acc = 0;
      if (this.mesh) this.mesh.visible = false;
      return;
    }
    if (this.mesh) this.mesh.visible = true;
    this.acc += d.rate * dt;
    let add = Math.min(Math.floor(this.acc), 4);
    this.acc -= add;
    // always keep the newest end pinned to where the emitter is now, or the
    // trail lags a fast swing by a whole frame
    if (add < 1 && !this.seg.length) add = 1;
    while (add-- > 0) {
      const e = this.edges();
      this.seg.push({ top: e.top, bot: e.bot, born: this.age });
      if (this.seg.length > this.cap) this.seg.shift();
    }
    if (this.seg.length) {
      const e = this.edges();
      const last = this.seg[this.seg.length - 1];
      last.top.copy(e.top); last.bot.copy(e.bot); last.born = this.age;
    }
    while (this.seg.length && this.age - this.seg[0].born > d.lifespan) this.seg.shift();

    const n = this.seg.length;
    if (n < 2) { this.geo.setDrawRange(0, 0); return; }
    const pos = this.geo.attributes.position.array;
    const uv = this.geo.attributes.uv.array;
    const al = this.geo.attributes.aAlpha.array;
    // one atlas cell, if the ribbon uses a sprite sheet
    const cw = 1 / d.cols, ch = 1 / d.rows;
    const cx = (d.slot % d.cols) * cw, cy = Math.floor(d.slot / d.cols) * ch;
    for (let i = 0; i < n; i++) {
      const s = this.seg[i];
      const u = cx + (i / (n - 1)) * cw;
      // Warcraft III does not fade a ribbon along its length: the strip carries
      // the emitter's alpha end to end and the *texture* provides the softness,
      // which is why these are blur and glow images. Tapering on top of that
      // halves an effect that is already faint, and the oldest segment ends up
      // at zero -- invisible, and the reason this looked broken at first.
      const a = d.alpha;
      const o3 = i * 6, o2 = i * 4, o1 = i * 2;
      pos[o3] = s.bot.x; pos[o3 + 1] = s.bot.y; pos[o3 + 2] = s.bot.z;
      pos[o3 + 3] = s.top.x; pos[o3 + 4] = s.top.y; pos[o3 + 5] = s.top.z;
      uv[o2] = u; uv[o2 + 1] = cy;
      uv[o2 + 2] = u; uv[o2 + 3] = cy + ch;
      al[o1] = a; al[o1 + 1] = a;
    }
    this.geo.setDrawRange(0, (n - 1) * 6);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.uv.needsUpdate = true;
    this.geo.attributes.aAlpha.needsUpdate = true;
  }

  dispose() { this.geo.dispose(); this.mat.dispose(); }
}

/** Rebuild every ribbon in a loaded model, parented to `root`. */
export function buildRibbons(root, loadTexture) {
  const out = [];
  root.updateWorldMatrix(true, true);
  root.traverse((o) => {
    const def = o.userData && o.userData.w3ribbon;
    if (!def || !def.texture) return;
    const tex = loadTexture(def.texture);
    if (!tex) return;
    out.push(new Ribbon(def, o, root, tex));
  });
  return out;
}
