/**
 * Warcraft III omni lights, rebuilt on the client.
 *
 * Spell effects carry them: a fireball lights the ground it passes over, a
 * lightning bolt flashes the models around it. There are 118 across this map's
 * art, all point lights with an attenuation range and a colour, and they are
 * what stops an impact from looking like a decal pasted on the floor.
 *
 * The lights live in a fixed **pool**. Three.js bakes the number of lights into
 * every material's shader, so adding one recompiles every material in the scene
 * -- which, on a map where a dozen effects appear and vanish each second, is a
 * stutter for every spell cast. A pool of a constant size costs one compile at
 * startup and none afterwards; effects borrow a slot and give it back, and an
 * effect that finds the pool empty simply goes unlit rather than stalling the
 * frame.
 */
import * as THREE from 'three';
import { visAt } from './particles.js';

// Warcraft III attenuates a light *linearly* between attStart and attEnd, while
// three.js since r155 is physically correct: intensity is in candela and falls
// off with distance squared. At this world scale -- a unit is about 100 units
// tall -- that difference is five orders of magnitude, and a light set from the
// raw number lands at zero. `decay: 0` gives the flat-then-cut-off falloff that
// matches Warcraft III, and in that mode intensity is a plain multiplier again.
const DECAY = 0;
// Calibrated by measuring one light of data-intensity 10 against an unlit frame:
// 0.05 changed 4954 of 76800 pixels, 0.1 changed 8920, and it flattens off above
// 0.22 as the surface blows out. 0.08 sits in the responsive part of that curve
// -- a spell light that reads clearly without washing the ground white.
const INTENSITY = 0.08;
const POOL = 8;

export class LightPool {
  constructor(scene) {
    this.slots = [];
    for (let i = 0; i < POOL; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 500);
      l.visible = false;
      scene.add(l);
      this.slots.push({ light: l, owner: null });
    }
  }

  /** Give an effect a slot, if one is free. */
  claim(owner, def) {
    const s = this.slots.find((x) => !x.owner);
    if (!s) return null;
    s.owner = owner;
    s.light.color.setRGB(def.color[0], def.color[1], def.color[2]);
    s.light.intensity = Math.max(0, def.intensity) * INTENSITY;
    s.light.distance = Math.max(100, def.attEnd || 200);
    s.light.decay = DECAY;
    s.light.visible = true;
    return s;
  }

  release(owner) {
    for (const s of this.slots) {
      if (s.owner !== owner) continue;
      s.owner = null;
      s.light.visible = false;
      s.light.intensity = 0;
    }
  }
}

/**
 * Attach every omni light in a loaded model to pool slots, and hand back the
 * per-frame work: each light follows the node it hangs from.
 */
export function buildLights(root, pool, owner) {
  const out = [];
  root.updateWorldMatrix(true, true);
  root.traverse((o) => {
    const def = o.userData && o.userData.w3light;
    if (!def) return;
    const slot = pool.claim(owner, def);
    if (!slot) return;                  // pool full: this effect goes unlit
    out.push({ node: o, slot, def, owner });
  });
  return out;
}

/**
 * Keep each borrowed light on the node that owns it, and lit only while its own
 * visibility track says so -- a flare that belongs to one sequence should not
 * burn through the other eight.
 */
export function stepLights(lights, ctx) {
  for (const l of lights) {
    // The slot may already have been released and handed to another effect;
    // driving it from a stale list would move and blink someone else's light.
    if (l.slot.owner !== l.owner) continue;
    l.node.updateWorldMatrix(true, false);
    l.slot.light.position.setFromMatrixPosition(l.node.matrixWorld);
    l.slot.light.visible = visAt(l.def, ctx) > 0.01;
  }
}
