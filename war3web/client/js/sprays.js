/**
 * Warcraft III ParticleEmitter1, rebuilt on the client.
 *
 * The older of the two emitter kinds, and it works quite differently from
 * ParticleEmitter2: instead of drawing sprites from a sheet it throws whole
 * *models* -- `SharedModels\Bones1.MDL`, `Gutz1.MDL`, `Feather2.MDL`. It is the
 * burst a creep comes apart into when it dies, and there are 62 of them across
 * 28 models here.
 *
 * Because each particle is a mesh rather than a point, the pieces are pooled
 * per emitter and reused: a dragon bursting into two dozen bones should not
 * mean two dozen model loads at the moment it dies.
 */
import * as THREE from 'three';
import { visAt } from './particles.js';

const DEG = Math.PI / 180;

/**
 * Object3D.clone shares materials, and every piece is cut from one prototype
 * that itself came from the model cache. Fading a piece therefore used to fade
 * every piece of every corpse drawn from that model, and the faded material
 * stayed in the cache for the rest of the session. A piece takes its own
 * copies the first time it fades -- pieces are pooled, so this happens at most
 * once each, and only for sprays that actually fire.
 */
function ownMaterials(obj) {
  const out = [];
  obj.traverse((o) => {
    if (!o.isMesh) return;
    const mats = (Array.isArray(o.material) ? o.material : [o.material]).map((m) => {
      const c = m.clone();
      c.userData = Object.assign({}, c.userData, { __baseOpacity: c.opacity });
      out.push(c);
      return c;
    });
    o.material = mats.length === 1 ? mats[0] : mats;
  });
  return out;
}

class Spray {
  constructor(def, node, root, proto) {
    this.d = def;
    this.node = node;
    this.root = root;
    this.age = 0;
    this.acc = 0;
    const cap = Math.min(40, Math.max(2, Math.ceil(def.rate * Math.max(0.1, def.lifespan))));
    this.pieces = [];
    for (let i = 0; i < cap; i++) {
      const obj = proto.clone(true);
      obj.visible = false;
      root.add(obj);
      this.pieces.push({ obj, alive: false, t: 0, life: 0, mats: null,
                         v: new THREE.Vector3(), spin: new THREE.Vector3() });
    }
    this._p = new THREE.Vector3();
    this._q = new THREE.Quaternion();
  }

  spawn() {
    const p = this.pieces.find((x) => !x.alive);
    if (!p) return;
    const d = this.d;
    this.node.updateWorldMatrix(true, false);
    this._p.setFromMatrixPosition(this.node.matrixWorld);
    this.root.worldToLocal(this._p);
    p.obj.position.copy(this._p);
    // Warcraft III aims these in a cone: `latitude` opens it, `longitude`
    // sweeps around, and the piece leaves at `initVelocity`
    const lat = (d.latitude || 0) * DEG;
    const lon = Math.random() * Math.PI * 2;
    const phi = Math.random() * lat;
    const sp = (d.speed || 0) * (0.7 + Math.random() * 0.6);
    p.v.set(Math.sin(phi) * Math.cos(lon), Math.cos(phi), Math.sin(phi) * Math.sin(lon))
      .multiplyScalar(sp)
      // The velocity must live in the same space as the position it moves. The
      // emitter's point is brought into the root's frame above, so the
      // direction has to be too -- mixing the two sends every piece sideways
      // under the model root's Z-up-to-Y-up rotation, which reads as "sprays
      // are invisible" when they are merely somewhere else.
      .applyQuaternion(this.root.getWorldQuaternion(this._q).invert());
    p.spin.set(Math.random() * 8 - 4, Math.random() * 8 - 4, Math.random() * 8 - 4);
    p.t = 0;
    p.life = Math.max(0.1, d.lifespan);
    p.alive = true;
    p.obj.visible = true;
    // the pool hands back a piece that faded out last time it flew
    for (const m of p.mats || []) m.opacity = m.userData.__baseOpacity;
  }

  update(dt, ctx) {
    const d = this.d;
    this.age += dt;
    // A ParticleEmitter1 throws whole models -- bones, guts, feathers -- and is
    // switched on for the one sequence that throws them. Until the converter
    // carried that switch across, the caller had to guess from the unit's
    // state, so a gore emitter either never fired or fired forever.
    if (visAt(d, ctx) > 0.01 && d.rate > 0) {
      this.acc += d.rate * dt;
      let n = Math.min(Math.floor(this.acc), 6);
      this.acc -= n;
      while (n-- > 0) this.spawn();
    }
    for (const p of this.pieces) {
      if (!p.alive) continue;
      p.t += dt;
      if (p.t >= p.life) { p.alive = false; p.obj.visible = false; continue; }
      p.v.y -= (d.gravity || 0) * dt;
      p.obj.position.addScaledVector(p.v, dt);
      p.obj.rotation.x += p.spin.x * dt;
      p.obj.rotation.y += p.spin.y * dt;
      p.obj.rotation.z += p.spin.z * dt;
      // fade the last third of its life so pieces do not blink out
      const k = p.t / p.life;
      if (k > 0.66) {
        const a = 1 - (k - 0.66) / 0.34;
        if (!p.mats) p.mats = ownMaterials(p.obj);
        for (const m of p.mats) { m.transparent = true; m.opacity = m.userData.__baseOpacity * a; }
      }
    }
  }

  dispose() {
    for (const p of this.pieces) {
      this.root.remove(p.obj);
      for (const m of p.mats || []) m.dispose();   // the prototype's are the cache's
    }
    this.pieces.length = 0;
  }
}

/**
 * Rebuild every ParticleEmitter1 in a loaded model.
 *
 * `loadProto` resolves the thrown model's path to an Object3D to clone; it is
 * async, so emitters appear a frame or two after the model itself. That is
 * fine -- these fire on death, not on spawn.
 */
export async function buildSprays(root, loadProto) {
  const defs = [];
  root.traverse((o) => {
    const def = o.userData && o.userData.w3spray;
    if (def && def.model) defs.push({ node: o, def });
  });
  const out = [];
  for (const { node, def } of defs) {
    let proto = null;
    try { proto = await loadProto(def.model); } catch { proto = null; }
    if (!proto) continue;
    out.push(new Spray(def, node, root, proto));
  }
  return out;
}
