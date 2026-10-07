/**
 * Warcraft III lightning, rebuilt on the client.
 *
 * Chain lightning, mana burn, drain, forked lightning: the engine draws these
 * itself rather than playing a model. An ability names a type in its
 * Lightningeffect field, and Splats\LightningData.slk says how to build the
 * strip -- which texture, how wide, how long a segment, how far each joint is
 * thrown off the straight line, and how long the bolt lives.
 *
 * 37 of this map's abilities name a type and nine of those are hero spells, so
 * until this existed a Rikujokoro or a Dance of the Camellia landed its damage
 * with nothing drawn between caster and target.
 *
 * A bolt is a camera-facing strip: the straight line from one end to the other,
 * divided into segments of roughly `seg` units, with every interior joint
 * displaced perpendicular to the line. The displacement is re-rolled a few
 * times a second, which is what makes it crackle rather than sit there as a
 * bent ribbon.
 */
import * as THREE from 'three';

const VERT = `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = `
uniform sampler2D map;
uniform vec3 tint;
uniform float alpha;
varying vec2 vUv;
void main() {
  vec4 t = texture2D(map, vUv);
  gl_FragColor = vec4(t.rgb * tint, t.a * alpha);
  if (gl_FragColor.a < 0.01) discard;
}`;

// how often the joints are thrown somewhere new
const JITTER_HZ = 12;

export class Bolt {
  constructor(spec, texture, scene) {
    this.d = spec;
    this.scene = scene;
    this.age = 0;
    this.since = 1e9;                     // force a re-roll on the first step
    // one quad per segment, so the strip can bend at every joint
    this.segs = 1;
    this.cap = 64;
    const pos = new Float32Array((this.cap + 1) * 2 * 3);
    const uv = new Float32Array((this.cap + 1) * 2 * 2);
    const idx = new Uint16Array(this.cap * 6);
    for (let i = 0; i < this.cap; i++) {
      const a = i * 2, o = i * 6;
      idx[o] = a; idx[o + 1] = a + 1; idx[o + 2] = a + 2;
      idx[o + 3] = a + 1; idx[o + 4] = a + 3; idx[o + 5] = a + 2;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e5);   // never cull
    this.geo = geo;
    this.mat = new THREE.ShaderMaterial({
      uniforms: { map: { value: texture },
                  tint: { value: new THREE.Color(spec.c[0], spec.c[1], spec.c[2]) },
                  alpha: { value: spec.c[3] } },
      vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.jit = [];
  }

  /**
   * Lay the strip between two world points.
   *
   * `up` is taken from the camera so the ribbon always presents its face; a
   * bolt built on a fixed axis disappears whenever the camera lines up with it.
   */
  place(a, b, camera) {
    const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1) { this.geo.setDrawRange(0, 0); return; }
    const n = Math.max(1, Math.min(this.cap, Math.round(len / this.d.seg)));
    if (n !== this.segs || !this.jit.length) {
      this.segs = n;
      this.jit = new Array(n + 1).fill(0).map(() => [0, 0]);
    }
    const dir = new THREE.Vector3(dx, dy, dz).divideScalar(len);
    const toCam = new THREE.Vector3().subVectors(camera.position, a).normalize();
    let side = new THREE.Vector3().crossVectors(dir, toCam);
    if (side.lengthSq() < 1e-6) side.set(1, 0, 0); else side.normalize();
    const perp = new THREE.Vector3().crossVectors(dir, side).normalize();

    const pos = this.geo.attributes.position.array;
    const uv = this.geo.attributes.uv.array;
    const half = this.d.w * 0.5;
    // TexCoordScale decides how many times the texture repeats along the bolt
    const uSpan = (this.d.uv || 1) * (len / Math.max(1, this.d.seg));
    for (let i = 0; i <= n; i++) {
      const t = i / n;
      const j = this.jit[i] || [0, 0];
      const px = a.x + dx * t + side.x * j[0] + perp.x * j[1];
      const py = a.y + dy * t + side.y * j[0] + perp.y * j[1];
      const pz = a.z + dz * t + side.z * j[0] + perp.z * j[1];
      const o = i * 6, o2 = i * 4;
      pos[o] = px - side.x * half; pos[o + 1] = py - side.y * half; pos[o + 2] = pz - side.z * half;
      pos[o + 3] = px + side.x * half; pos[o + 4] = py + side.y * half; pos[o + 5] = pz + side.z * half;
      uv[o2] = t * uSpan; uv[o2 + 1] = 0;
      uv[o2 + 2] = t * uSpan; uv[o2 + 3] = 1;
    }
    this.geo.setDrawRange(0, n * 6);
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.uv.needsUpdate = true;
  }

  /** Throw the interior joints somewhere new. The ends stay put. */
  reroll(len) {
    const amp = (this.d.noise || 0) * len;
    for (let i = 0; i < this.jit.length; i++) {
      if (i === 0 || i === this.jit.length - 1) { this.jit[i] = [0, 0]; continue; }
      this.jit[i] = [(Math.random() * 2 - 1) * amp, (Math.random() * 2 - 1) * amp];
    }
  }

  /** Returns false once the bolt has outlived its Duration. */
  step(dt, a, b, camera) {
    this.age += dt;
    this.since += dt;
    const len = a.distanceTo(b);
    if (this.since > 1 / JITTER_HZ) { this.reroll(len); this.since = 0; }
    this.place(a, b, camera);
    // it fades out over the back half of its life
    const k = Math.min(1, this.age / Math.max(0.05, this.d.life));
    this.mat.uniforms.alpha.value = this.d.c[3] * (k < 0.5 ? 1 : 1 - (k - 0.5) * 2);
    return this.age < this.d.life;
  }

  dispose() {
    this.scene.remove(this.mesh);
    this.geo.dispose();
    this.mat.dispose();
  }
}
