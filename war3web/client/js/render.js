import * as THREE from 'three';
import { buildEmitters, setSortCamera } from './particles.js';
import { buildRibbons } from './ribbons.js';
import { LightPool, buildLights, stepLights } from './lights.js';
import { buildSprays } from './sprays.js';
import { SplatField, buildEvents, stepEvents } from './splats.js';
import { buildTexAnims, stepTexAnims, disposeTexAnims } from './texanim.js';
import { Bolt } from './lightning.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as skeletonClone } from 'three/addons/utils/SkeletonUtils.js';
import { Ent } from '/shared/const.js';

const TEAM_COLOR = [0x4f8fe0, 0xe05050, 0x9a9a9a];
// Warcraft III tints the selection circle by what the unit is to you, not by
// the owner's player colour.
const NOOP = () => {};
const SELECTION_COLOR = { own: 0x40ff40, ally: 0xffe040, enemy: 0xff4040, neutral: 0xdddddd };

// Every way this map writes "there is no model here". Four spellings of the
// same Korean word appear across its dummy unit types.
const NO_MODEL = new Set(['없다', '없음', '업다', '읎지여', 'none', '_', '-']);

// See pickClip: whether a building's working animation counts as one of its
// idle variants. The map's data does not settle it, so it is one constant.
const STAND_WORK_IDLES = true;

// The logical states the rest of the client asks for, as Warcraft III token
// sets. Anything not listed is tokenised as written, so an ability's own
// Animnames ("spell,slam") passes straight through.
const TAGS = {
  stand: ['stand'],
  walk: ['walk'],
  attack: ['attack'],
  death: ['death'],
  spell: ['spell'],
};

/** Attach-point tokens: punctuation and the trailing "Ref" carry no meaning. */
function attachTokens(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')
    .split(' ').filter((t) => t && t !== 'ref');
}

/**
 * Split a sequence name into Warcraft III animation tokens.
 *
 * "Stand Ready Attack" -> [stand, ready, attack]. The trailing "- 2" that marks
 * a variant is not a token; it is which of several sequences sharing a name
 * this is, and treating it as one would stop "Stand - 2" matching a request for
 * "stand". Commas separate tokens too, which is how the object data writes them.
 */
function tokensOf(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\s*-\s*\d+\s*$/, '')
    .split(/[\s,]+/)
    .filter(Boolean);
}

/**
 * The tokens a unit's Required Animation Names actually ask for.
 *
 * Almost always the field is the token list itself -- "upgrade,third" for the
 * Arcane Tower, "swim" for the water sheep. `alternateex` is the exception, and
 * it is Blizzard's own: it names no sequence in any of this map's 1101 converted
 * models, while `alternate` names 214, and every unit type that declares it is
 * the morphed form of another one -- Bear Form, Crow Form, Illidan's demon form,
 * the Obsidian Destroyer, Ichigo's Bankai. Read literally it is inert and every
 * one of those draws as its unmorphed self, so it asks for `alternate`.
 */
function animTokens(an) {
  const out = [];
  for (const t of tokensOf(an)) {
    out.push(t);
    if (t === 'alternateex' && !out.includes('alternate')) out.push('alternate');
  }
  return out;
}

/**
 * Warcraft III's variant weighting. `rarity` marks a sequence as the unusual
 * one -- the idle where the footman shifts his grip. The common variants are
 * rarity 0 and are what plays nearly all the time; a rare one surfaces
 * occasionally, which is the whole point of having it.
 */
function weightedByRarity(pool, meta) {
  const rarityOf = (clip) => {
    const s = meta?.sequences?.find((x) => x.name.toLowerCase() === clip);
    return s?.rarity || 0;
  };
  const common = pool.filter((n) => rarityOf(n) === 0);
  const rare = pool.filter((n) => rarityOf(n) > 0);
  const use = (rare.length && Math.random() < 0.1) ? rare : (common.length ? common : pool);
  return use[(Math.random() * use.length) | 0];
}

/** Map WC3 world coords -> three.js coords. */
export const toX = (x) => x;
export const toZ = (y) => -y;

/**
 * What a view built for itself, as against what it borrows.
 *
 * SkeletonUtils.clone shares geometry *and* materials with the model cache, so
 * a unit's mesh is mostly not its own: disposing it would take the model out
 * from under every other unit of the type, and mutating it recolours them all.
 * Everything registered here is a copy this holder made and may be freed with
 * it; everything else is the cache's and is left alone.
 */
function own(holder, ...things) {
  const list = holder.owned || (holder.owned = []);
  for (const t of things) if (t) list.push(t);
  return things[0];
}
function disposeOwned(holder) {
  for (const t of holder.owned || []) t.dispose?.();
  holder.owned = null;
}
const matsOf = (mesh) => (Array.isArray(mesh.material) ? mesh.material : [mesh.material]);

/** One keyframed 0..1 track, read at time `t` (seconds into the sequence). */
function sampleCurve(c, t) {
  if (t <= c[0][0]) return c[0][1];
  if (t >= c[c.length - 1][0]) return c[c.length - 1][1];
  let k = 0;
  while (k < c.length - 2 && c[k + 1][0] < t) k++;
  const [t0, a0] = c[k], [t1, a1] = c[k + 1];
  const span = t1 - t0;
  return span <= 0 ? a0 : a0 + (a1 - a0) * ((t - t0) / span);
}

/**
 * APPROXIMATION -- NOT ESTABLISHED FROM THE MAP OR THE MPQs.
 *
 * The one number in the crater that no extracted file supplies: the shape of
 * the bowl. TerrainDeformCrater is a bare `native` in common.j, and the curve
 * it applies lives in Blizzard's engine binary, which is not in war3.mpq or
 * any of the three expansion archives. Everything else about these craters is
 * sourced -- radius, depth, duration, sign, which vertices -- and is marked as
 * such where it is read; this function alone is a guess with a shape.
 *
 * Raised cosine over 0..1: full depth at the centre, nothing at the rim, and
 * zero slope at both ends so the crater meets undisturbed ground without a
 * crease. Chosen because it is the smoothest thing that satisfies the two
 * endpoints we DO know; it is not claimed to be Warcraft III's.
 *
 * If it ever needs settling, it needs a measurement against the retail game,
 * not another reading of the files -- they do not contain it. Until then, do
 * not cite this curve as map-derived behaviour and do not build anything on
 * its exact profile. See TODO.txt.
 */
const APPROX_CRATER_FALLOFF = (t) => 0.5 * (1 + Math.cos(Math.PI * Math.min(1, t)));

/**
 * How far a model reaches, from the MDX's own bounds: the model extent plus
 * one per sequence, which is what Warcraft III culls a unit with. The union of
 * them is the farthest any animation can put a vertex. Two forms, both in
 * model units and MDX axes (z up):
 *   sphere  the union box's centre and half-diagonal, for a mesh-local bounds
 *           that three.js transforms by the mesh's own matrix
 *   up, r   the same sphere flattened onto the vertical axis: centre `up`
 *           above the origin, radius reaching every corner from there, so it
 *           holds under any facing without a rotation
 * Null when the file carries no bounds at all (the particle-only effect models
 * do not).
 */
function cullBoundsOf(meta) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  const boxes = [meta?.extent, ...(meta?.sequences || []).map((q) => q.extent)];
  for (const b of boxes) {
    if (!b?.min || !b?.max) continue;
    for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], b.min[k]); hi[k] = Math.max(hi[k], b.max[k]); }
  }
  if (!(hi[0] > lo[0] || hi[1] > lo[1] || hi[2] > lo[2])) return null;
  const c = [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2];
  const half = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2;
  let r = 0;
  for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]])
    r = Math.max(r, Math.hypot(x, y, z - c[2]));
  return { sphere: new THREE.Sphere(new THREE.Vector3(c[0], c[1], c[2]), half), up: c[2], r };
}

/**
 * A static clone is drawn where it stands and never moves, so three things
 * that three.js redoes for it every frame need doing once:
 *   - the scene walk that recomposes every node under its holder -- a doodad
 *     model is skinned like any other, so that is its whole skeleton --
 *     Object3D.updateMatrixWorld recurses whether anything changed or not, and
 *     the holder's is replaced by a no-op after its first full pass;
 *   - the skeleton itself: three.js re-skins and re-uploads a bone texture for
 *     every skinned mesh it draws, and 360-odd scenery doodads were paying
 *     that per frame for a pose that never changes. The first update is left
 *     to run, after that first walk has placed the bones; the ones after it
 *     are no-ops;
 *   - and the frustum test, which every geoset is loaded without: a mesh that
 *     never moves can be culled by the bounds above.
 * Only for clones with no mixer. pickDoodad's raycast is untouched: it goes
 * through updateWorldMatrix, a different method, and the frozen matrices are
 * the right ones anyway.
 */
function freezeStatic(holder, obj, bounds) {
  holder.updateMatrixWorld = function (force) {
    THREE.Object3D.prototype.updateMatrixWorld.call(this, force);
    this.updateMatrixWorld = NOOP;
  };
  obj.traverse((m) => {
    if (!m.isMesh) return;
    if (m.isSkinnedMesh) {
      if (!bounds) return;                  // no bounds to cull with: leave it uncullable
      m.boundingSphere = bounds.sphere.clone();
      const sk = m.skeleton;
      if (!sk.__frozen) {
        sk.__frozen = true;
        const real = sk.update;
        sk.update = function () { real.call(this); this.update = NOOP; };
      }
    }
    m.frustumCulled = true;                 // a plain mesh culls by its geometry's bounds
  });
}

/**
 * A model instance: SkeletonUtils.clone, then one skeleton per model again.
 *
 * Every converted glb carries exactly one skin that all of its skinned geosets
 * share, and GLTFLoader gives them one Skeleton. SkeletonUtils.clone does not
 * keep that: it clones a Skeleton per SkinnedMesh, so a unit of four skinned
 * geosets arrives with four skeletons over the same bones, and three.js then
 * computes the bone matrices and uploads a bone texture four times a frame for
 * it. Measured before this: 1412 skeleton updates a frame for 397 units.
 * Meshes whose clones were cut from the same skeleton still share its
 * boneInverses array by reference and map to the same cloned bones, which is
 * the identity used to fold them back onto one.
 */
function cloneModel(scene) {
  const obj = skeletonClone(scene);
  const shared = new Map();                // boneInverses -> the skeleton kept
  obj.traverse((m) => {
    if (!m.isSkinnedMesh) return;
    const sk = m.skeleton;
    const keep = shared.get(sk.boneInverses);
    if (!keep) { shared.set(sk.boneInverses, sk); return; }
    if (keep.bones.length !== sk.bones.length || keep.bones.some((b, i) => b !== sk.bones[i])) return;
    m.bind(keep, m.bindMatrix);
  });
  return obj;
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = false;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0a0c12);
    // A starting fog, replaced the moment the map calls SetTerrainFogEx -- this
    // one asks for black from 3000 to 5000 and got neither until setFog existed.
    this.scene.fog = new THREE.Fog(0x0b1018, 4200, 9000);

    this.camera = new THREE.PerspectiveCamera(48, 1, 10, 12000);
    // the emitters need somewhere to measure depth from, and the scene's fog
    setSortCamera(this.camera, this.scene);
    this.camTarget = new THREE.Vector3(0, 0, 0);
    this.camDist = 2600;
    this.camPitch = 1.02;          // radians from horizontal
    this.camYaw = 0;
    this.consoleFrac = 0;          // set once the console is built; see setConsoleFraction
    this.replTex = new Map();      // doodad replaceable textures, shared by type
    this.effects = new Map();      // live AddSpecialEffect instances, by id
    this.fxTextures = new Map();   // particle sprite sheets, shared across emitters
    this.groundItems = new Map();  // items lying in the world, by id
    this.lightPool = new LightPool(this.scene);   // fixed size: see lights.js
    this.missiles = new Map();     // shots in flight, by id
    this.splatField = null;        // ground splats, see splats.js
    this.bolts = [];               // lightning in flight, see lightning.js

    // A starting light, replaced the moment the map calls SetDayNightModels:
    // the two DNC models it names carry the real sun and ambient colours, hour
    // by hour, and these three numbers are ours.
    this.hemi = new THREE.HemisphereLight(0xa9c2e8, 0x2a2620, 1.15);
    this.scene.add(this.hemi);
    const sun = new THREE.DirectionalLight(0xfff0d8, 1.15);
    sun.position.set(-800, 1600, 900);
    this.scene.add(sun);
    this.sun = sun;
    this.dncHour = 12;

    this.loader = new GLTFLoader();
    this.loader.setResourcePath('/assets/');   // glTF image URIs are asset-root relative
    this.modelCache = new Map();      // name -> {gltf, meta}
    this.pending = new Map();
    this.views = new Map();           // entId -> view
    this.clock = new THREE.Clock();
    this.selectionRing = null;
    this.terrain = null;
    // reused every frame so the cull costs no allocation
    this._frustum = new THREE.Frustum();
    this._fmat = new THREE.Matrix4();
    this._sph = new THREE.Sphere(new THREE.Vector3(), 220);

    addEventListener('resize', () => this.resize());
    this.resize();
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // The console covers the bottom of the screen and the world is drawn behind
    // it, so the middle of the window is not the middle of what can be seen.
    const f = this.consoleFrac || 0;
    if (f > 0) this.camera.setViewOffset(w, h, 0, (h * f) / 2, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  /**
   * How much of the screen height the console covers.
   *
   * Warcraft III draws the world across the whole screen and lays the console
   * over the bottom of it -- ConsoleUI.fdf's bottom tiles are 0.176 of the
   * game's 0.6-tall screen box, which is 29.33%. A camera framed for the whole
   * window therefore centres on the middle of the *window*, 14.7% of the screen
   * below the middle of the strip the console leaves visible: the hero sits low,
   * crowded against the frame, with the room above him wasted.
   *
   * The projection is shifted rather than shrunk, which is what the game does --
   * the world still fills the screen and the console overlays it -- so nothing
   * is cropped and only the optical centre moves. Raycasting and the floating
   * text read the same projection matrix, so picking and labels follow.
   */
  setConsoleFraction(f) {
    const v = Math.max(0, Math.min(0.6, Number(f) || 0));
    if (v === this.consoleFrac) return;
    this.consoleFrac = v;
    this.resize();
  }

  // ------------------------------------------------------------- world build
  /**
   * The ground surface, built straight in world space over the w3e vertex grid.
   *
   * Cells carrying a cliff are left out: Warcraft III drops the ground there and
   * stamps a cliff model that supplies the surface on both levels itself, so
   * filling the cell with interpolated ground is exactly what turns a step into
   * a ramp.  `cliffs.cells` is the list tools/cliffs.py drew a model for; ramp
   * cells are not in it and keep their sloping ground, as the game does.
   */
  async buildTerrain(terr, heights, cliffs = null) {
    const { width: W, height: H, tileSize: TS, offsetX, offsetY } = terr;
    const skip = new Set(cliffs && cliffs.cells ? cliffs.cells : []);
    const pos = new Float32Array(W * H * 3);
    const uv = new Float32Array(W * H * 2);
    for (let j = 0; j < H; j++) {
      for (let i = 0; i < W; i++) {
        const v = j * W + i;                       // w3e vertex, row 0 = south
        pos[v * 3] = offsetX + i * TS;
        pos[v * 3 + 1] = heights[v] || 0;
        pos[v * 3 + 2] = -(offsetY + j * TS);
        // _ground.png is baked north-first, and the loader flips it: v=1 north
        uv[v * 2] = i / (W - 1);
        uv[v * 2 + 1] = j / (H - 1);
      }
    }
    const idx = [];
    for (let j = 0; j < H - 1; j++) {
      for (let i = 0; i < W - 1; i++) {
        if (skip.has(j * (W - 1) + i)) continue;
        const a = j * W + i, b = a + 1, c = a + W, d = c + 1;
        idx.push(a, b, c, b, d, c);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const tex = await new THREE.TextureLoader().loadAsync('/assets/textures/_ground.png');
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    // The cliffs ask for this and the ground did not, which is most of why the
    // two looked like different materials where they meet: at an RTS camera
    // angle every ground texel is seen edge-on, and without anisotropy that
    // smears while the cliff beside it stays sharp.
    tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    const mat = new THREE.MeshLambertMaterial({ map: tex });
    const mesh = new THREE.Mesh(geo, mat);
    this.scene.add(mesh);
    this.terrain = mesh;
    this.terrInfo = terr;
    this.heights = heights;
    this.cliffCells = skip;               // heightAt must not ramp across these
    if (cliffs) await this.buildCliffs(cliffs);
    await this.buildWater(terr);
    // splats lie on the terrain, so the field can only exist once it does
    this.splatField = new SplatField(this.scene, () => this.splatTable,
      (x, y) => this.heightAt(x, y), (uri) => this.fxTexture(uri));
    return mesh;
  }

  /**
   * The cliffs, as one baked mesh per cliff texture.
   *
   * tools/cliffs.py has already placed every cell's model and merged them into
   * world-space triangles, so there is nothing to instance here: the buffer is
   * interleaved position/normal/uv and goes straight to the GPU.  UVs come from
   * the .mdx unchanged, which is the glTF convention, so the texture must not
   * be flipped.
   */
  async buildCliffs(spec) {
    if (!spec || !spec.groups || !spec.groups.length || !spec.data) return null;
    const stride = spec.stride || 8;
    const data = spec.data;
    const loader = new THREE.TextureLoader();
    const group = new THREE.Group();
    for (const g of spec.groups) {
      const view = data.subarray(g.start * stride, (g.start + g.count) * stride);
      const inter = new THREE.InterleavedBuffer(view, stride);
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.InterleavedBufferAttribute(inter, 3, 0));
      geo.setAttribute('normal', new THREE.InterleavedBufferAttribute(inter, 3, 3));
      geo.setAttribute('uv', new THREE.InterleavedBufferAttribute(inter, 2, 6));
      geo.computeBoundingSphere();
      let tex = null;
      try {
        tex = await loader.loadAsync('/assets/' + g.texture);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.flipY = false;
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        tex.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      } catch { tex = null; }
      const mat = new THREE.MeshLambertMaterial(tex ? { map: tex } : { color: 0x6b6b73 });
      group.add(new THREE.Mesh(geo, mat));
    }
    this.scene.add(group);
    this.cliffs = group;
    return group;
  }


  /**
   * Warcraft III stores water as a per-vertex flag plus an absolute level; the
   * staged data turns that into the tiles that show water and the height of
   * their surface.  In this map that is the moat ringing each base -- a trench
   * cut 256 below the bank and filled to ground level.
   */
  async buildWater(terr) {
    const spec = terr.water;
    if (!spec || !spec.cells || !spec.cells.length) return null;
    const { tileSize: TS, offsetX: OX, offsetY: OY, width: W } = terr;
    const cw = W - 1;
    // TerrainArt\Water.slk gives the surface offset for this tileset (-89.6 for
    // most of them); the level stored per vertex is the brim, and the drawn
    // surface sits that far below it.
    const DROP = spec.height ?? -89.6;
    // Warcraft III fades water out toward the shore instead of ending it on a
    // hard line -- that ramp, not a shader, is most of why a flat sheet reads
    // wrong.  Alpha comes from how deep the water is over each corner.
    const FADE = 140;                       // depth over which it reaches full body
    const MAX_A = 0.78;
    const n = spec.cells.length;
    const pos = new Float32Array(n * 4 * 3);
    const uv = new Float32Array(n * 4 * 2);
    const col = new Float32Array(n * 4 * 4);
    const idx = new Uint32Array(n * 6);
    const gh = (i, j) => (this.heights ? (this.heights[j * W + i] || 0) : 0);
    spec.cells.forEach((c, k) => {
      const i = c % cw, j = Math.floor(c / cw);
      const z = (spec.z[k] ?? 0) + DROP;
      const x0 = OX + i * TS, x1 = x0 + TS;
      const y0 = OY + j * TS, y1 = y0 + TS;
      const v = k * 4;
      const set = (o, x, y, ci, cj) => {
        pos[(v + o) * 3] = toX(x); pos[(v + o) * 3 + 1] = z; pos[(v + o) * 3 + 2] = toZ(y);
        const depth = z - gh(ci, cj);
        const a = Math.max(0, Math.min(1, depth / FADE)) * MAX_A;
        col.set([1, 1, 1, a], (v + o) * 4);
      };
      set(0, x0, y0, i, j); set(1, x1, y0, i + 1, j);
      set(2, x0, y1, i, j + 1); set(3, x1, y1, i + 1, j + 1);
      uv.set([0, 0, 1, 0, 0, 1, 1, 1], v * 2);
      idx.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], k * 6);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 4));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeVertexNormals();

    // Warcraft III's water sequence is Water00..Water44 (WaterBlobs/WaterWake are
    // separate effects, not frames); stop at the first one that is not staged.
    const loader = new THREE.TextureLoader();
    const frames = [];
    const nFrames = spec.numTex || 45;
    for (let f = 0; f < nFrames; f++) {
      const name = String(f).padStart(2, '0');
      try {
        const tx = await loader.loadAsync(`/assets/textures/Textures/Water${name}.png`);
        tx.colorSpace = THREE.SRGBColorSpace;
        tx.wrapS = tx.wrapT = THREE.RepeatWrapping;
        frames.push(tx);
      } catch { break; }
    }
    const mat = new THREE.MeshLambertMaterial({
      map: frames[0] || null,
      color: frames.length ? 0xffffff : 0x2f6f9e,
      vertexColors: true,                   // carries the shoreline alpha ramp
      transparent: true,
      depthWrite: false, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 1;                 // draw over the trench floor
    this.scene.add(mesh);
    this.water = { mesh, mat, frames, t: 0, fps: spec.texRate || 15 };
    return mesh;
  }

  tickWater(dt) {
    const w = this.water;
    if (!w || w.frames.length < 2) return;
    w.t += dt;
    const f = Math.floor(w.t * w.fps) % w.frames.length;
    if (w.mat.map !== w.frames[f]) { w.mat.map = w.frames[f]; w.mat.needsUpdate = true; }
  }

  /**
   * The ground height under a world point.
   *
   * A unit stands on the surface that is drawn, so this reads the triangle the
   * renderer built rather than the nearest vertex.  buildTerrain splits every
   * cell along the (i+1,j)--(i,j+1) diagonal, which puts a point in the a,b,c
   * half while u+v <= 1 and in the b,d,c half after that; taking the plane of
   * its own half is what pickGround's raycast returns for the same spot.
   * Rounding to a vertex made a unit climb a ramp in tile-sized steps.
   *
   * Cells carrying a cliff are the exception, for the reason buildTerrain
   * leaves them out of the ground mesh: there is no surface between the two
   * levels there, only the cliff model's own step, and interpolating across it
   * would float a unit halfway up the face.  Those keep the nearest corner.
   */
  /**
   * Warcraft III's TerrainDeformCrater, as far as the files can carry it.
   *
   * What is measured and exact: which vertices move, by how much at the
   * centre, over how long, and in which direction -- Blizzard's own
   * TriggerStrings.txt says of CraterBJ that "Depth may be negative for
   * bumps", so a positive depth digs.  This map only ever asks for radius 400
   * depth +/-400 over 500 ms, permanent, from Gaara's A03O and Kisame's A069.
   *
   * What is NOT established anywhere in the extracted files: the radial
   * falloff curve itself.  TerrainDeformCrater is a bare `native` line in
   * common.j and the shape it applies lives in Blizzard's engine binary, which
   * is not in the MPQs.  The raised-cosine bowl below is therefore an
   * approximation and is labelled as one rather than passed off as the game's.
   *
   * The one thing that makes the approximation safe to ship: the map always
   * cancels a crater with a second crater of the same radius at the same point
   * and the opposite depth.  Displacement is linear in depth, so whatever
   * curve is chosen, the undo restores the original heights exactly and no
   * error accumulates in the terrain.
   */
  deformTerrain(ev) {
    const t = this.terrInfo;
    if (!t || !this.heights || !this.terrain) return null;
    const { width: W, height: H, tileSize: TS, offsetX, offsetY } = t;
    const R = Math.max(1, ev.r || 0), depth = ev.depth || 0;
    const ci = (ev.x - offsetX) / TS, cj = (ev.y - offsetY) / TS;
    const span = Math.ceil(R / TS);
    const verts = [];
    for (let j = Math.max(0, Math.floor(cj - span)); j <= Math.min(H - 1, Math.ceil(cj + span)); j++)
      for (let i = Math.max(0, Math.floor(ci - span)); i <= Math.min(W - 1, Math.ceil(ci + span)); i++) {
        const d = Math.hypot((i - ci) * TS, (j - cj) * TS);
        if (d > R) continue;
        verts.push([j * W + i, -depth * APPROX_CRATER_FALLOFF(d / R)]);
      }
    if (!verts.length) return null;
    const def = { verts, applied: 0, ms: Math.max(1, ev.ms || 0), t: 0 };
    (this.deforms || (this.deforms = [])).push(def);
    return def;
  }

  /**
   * Walk each live deformation forward and write the delta it has not applied
   * yet, so overlapping craters compose instead of the last writer winning.
   */
  tickTerrain(dt) {
    if (!this.deforms || !this.deforms.length) return;
    const pos = this.terrain.geometry.attributes.position;
    let touched = false;
    for (const d of this.deforms) {
      d.t = Math.min(d.ms, d.t + dt * 1000);
      const want = d.t / d.ms;
      const step = want - d.applied;
      if (step === 0) continue;
      d.applied = want;
      touched = true;
      for (const [v, full] of d.verts) {
        this.heights[v] = (this.heights[v] || 0) + full * step;
        pos.array[v * 3 + 1] = this.heights[v];
      }
    }
    // a finished deformation stays: both of this map's craters are permanent,
    // and the script undoes them with a crater of its own
    this.deforms = this.deforms.filter((d) => d.applied < 1);
    if (touched) {
      pos.needsUpdate = true;
      this.terrain.geometry.computeVertexNormals();
    }
  }

  heightAt(wx, wy) {
    const t = this.terrInfo;
    if (!t || !this.heights) return 0;
    const W = t.width, H = t.height;
    const fx = (wx - t.offsetX) / t.tileSize, fy = (wy - t.offsetY) / t.tileSize;
    const i = Math.max(0, Math.min(W - 2, Math.floor(fx)));
    const j = Math.max(0, Math.min(H - 2, Math.floor(fy)));
    const r = j * W + i;
    const a = this.heights[r] || 0, b = this.heights[r + 1] || 0;
    const c = this.heights[r + W] || 0, d = this.heights[r + W + 1] || 0;
    const u = Math.max(0, Math.min(1, fx - i)), v = Math.max(0, Math.min(1, fy - j));
    if (this.cliffCells && this.cliffCells.has(j * (W - 1) + i))
      return u < 0.5 ? (v < 0.5 ? a : c) : (v < 0.5 ? b : d);
    return u + v <= 1 ? a + (b - a) * u + (c - a) * v
                      : d + (c - d) * (1 - u) + (b - d) * (1 - v);
  }

  async addDoodads(list, meta = {}, animated = null) {
    // Doodads with no visible model (pathing/LOS blockers) are invisible in the
    // real game; their effect is in the pathing map, which the server already uses.
    const visible = (list || []).filter((d) => (meta[d.id] || {}).visible !== false);
    if (!visible.length) return;
    // Where each placement ended up, by its index in the list the server keys
    // its destructables on. A gate that dies has to be found again to be shown
    // broken, and clicked on before that.
    const idxOf = new Map();
    (list || []).forEach((d, i) => idxOf.set(d, i));
    this.doodadAt = this.doodadAt || new Map();
    const byType = new Map();
    for (const d of visible) {
      if (!byType.has(d.id)) byType.set(d.id, []);
      byType.get(d.id).push(d);
    }
    const group = new THREE.Group();
    for (const [id, items] of byType) {
      const info = meta[id] || {};
      // The texture a replaceable slot stands for, from DestructableData's
      // texFile, compiled per destructable *type* by stage.py.
      //
      // Warcraft III shares one model across many types and swaps only this --
      // lordaerontree is used by five destructables with five different tree
      // textures -- so the converted model cannot carry it, and the geoset that
      // asks for it arrives with no texture at all. The 17 Lordaeron trees and
      // 10 Barrens trees on this map drew nothing until it was put back.
      //
      // Only a material with no texture is touched: the city gate's cliff slot
      // is already resolved to the tileset's own recolour by mdx2gltf, which is
      // the sharper answer than the bare name this table gives, and overwriting
      // it would undo that.
      //
      // Materials are cloned rather than mutated, and the clone is shared by
      // every instance of the type: skeletonClone hands out the model cache's
      // own materials, so writing to one would repaint every doodad drawn from
      // that model and every one spawned afterwards.
      let replTex = null;
      if (info.tex) {
        replTex = this.replTex.get(info.tex);
        if (!replTex) {
          replTex = new THREE.TextureLoader().load('/assets/' + info.tex);
          replTex.colorSpace = THREE.SRGBColorSpace;
          replTex.flipY = false;   // mdx2gltf 转换 UV 直通(WC3左上), three 默认 flipY 会双重翻转 -> 树冠顶部错位到贴图棕色带
          replTex.wrapS = replTex.wrapT = THREE.RepeatWrapping;
          this.replTex.set(info.tex, replTex);
        }
      }
      const patched = new Map();
      const applyRepl = (root) => {
        if (!replTex) return;
        root.traverse((o) => {
          if (!o.isMesh || !o.material) return;
          const arr = Array.isArray(o.material) ? o.material : [o.material];
          const out = arr.map((mm) => {
            if (!mm || mm.map) return mm;
            let c = patched.get(mm);
            if (!c) {
              c = mm.clone();
              c.map = replTex;
              c.transparent = true;
              c.alphaTest = mm.alphaTest || 0.5;
              c.needsUpdate = true;
              patched.set(mm, c);
            }
            return c;
          });
          o.material = Array.isArray(o.material) ? out : out[0];
        });
      };
      // a doodad type can ship several numbered variations; `variation` picks one
      const protos = new Map();
      const protoFor = async (variation) => {
        const name = (info.v && info.v[variation]) || info.m;
        if (!name) return null;
        if (protos.has(name)) return protos.get(name);
        let rec = null;
        try {
          const r = await this.loadModel(name);
          rec = { scene: r.gltf.scene, meta: r.meta, anims: r.gltf.animations || [], bounds: r.bounds };
        } catch { rec = null; }
        protos.set(name, rec);
        return rec;
      };

      /**
       * Hide the geosets the model's own "stand" sequence hides.
       *
       * A destructable model carries its wreckage as extra geosets and hides
       * them with a geoset-alpha (KGAO) track: the elven gate stands as
       * [1,0,1,0] and dies as [1,1,0,0], so geoset 1 is the debris and 2 is the
       * gate itself. Units sample those tracks through play(); a doodad never
       * animates, so nothing sampled them and every geoset drew at full alpha --
       * which is why the gates showed the closed doors and their own rubble at
       * the same time. Four of the five gate models do this; the city entrance
       * gate has no geoset animation at all, which is why it looked right.
       *
       * Visibility is per-object, so this is set on the clone and never touches
       * the material the model cache holds.
       */
      const standAlpha = (rec) => {
        const seqs = rec?.meta?.sequences || [];
        const s = seqs.find((q) => /^stand$/i.test(q.name))
               || seqs.find((q) => /^stand/i.test(q.name));
        return s?.geosetAlpha || null;
      };
      const seqAlpha = (rec, name) => {
        const seqs = rec?.meta?.sequences || [];
        const s = seqs.find((q) => new RegExp('^' + name + '$', 'i').test(q.name))
               || seqs.find((q) => new RegExp('^' + name, 'i').test(q.name));
        return s?.geosetAlpha || null;
      };
      const applyAlpha = (root, a) => {
        if (!a) return false;
        let i = 0;
        root.traverse((o) => { if (o.isMesh) { const v = a[i++]; o.visible = !(v !== undefined && v <= 0.01); } });
        return true;
      };
      const applyStand = (root, rec) => applyAlpha(root, standAlpha(rec));
      for (const d of items) {
        const rec = await protoFor(d.variation || 0);
        const proto = rec && rec.scene;
        const h = this.heightAt(d.x, d.y);
        let obj;
        if (proto) {
          obj = cloneModel(proto);
          applyRepl(obj);
          applyStand(obj, rec);
        } else {
          obj = new THREE.Mesh(new THREE.CylinderGeometry(30, 40, 200, 6),
            new THREE.MeshLambertMaterial({ color: 0x33384a }));
          obj.position.y = 100;
        }
        const holder = new THREE.Group();
        holder.add(obj);
        holder.position.set(toX(d.x), d.z || 0, toZ(d.y));
        holder.rotation.y = d.rot || 0;
        const s = (info.s || 1);
        holder.scale.set((d.sx || 1) * s, (d.sz || 1) * s, (d.sy || 1) * s);
        group.add(holder);
        const di = idxOf.get(d);
        if (di == null) continue;
        const entry = { holder, obj, rec, dead: false, mixer: null, actions: null };
        // Only what can actually be struck gets a mixer. Every gate model
        // carries a Stand Hit clip -- the doors shudder when they are hit --
        // and Warcraft III plays it on every blow. The other 350-odd doodads
        // are scenery and never move, so they stay as static clones.
        if (animated && animated.has(di) && rec?.anims?.length) {
          entry.mixer = new THREE.AnimationMixer(obj);
          entry.actions = new Map();
          for (const clip of rec.anims) entry.actions.set(clip.name.toLowerCase(), clip);
        } else if (proto) freezeStatic(holder, obj, rec.bounds);
        this.doodadAt.set(di, entry);
      }
    }
    this.scene.add(group);
    this.doodads = group;
  }

  /**
   * Play one of a destructable's own clips, once.
   *
   * A gate is hit and shudders: every gate model carries a Stand Hit sequence,
   * and its geoset alphas are the same as the stand pose's, so this is bone
   * motion and not a swap of what is drawn. clampWhenFinished holds the last
   * frame rather than snapping back, which is what death needs; a hit is short
   * enough that holding it is what the game does too, until the next blow
   * restarts it.
   */
  playDoodadClip(index, name, { hold = false } = {}) {
    const e = this.doodadAt && this.doodadAt.get(index);
    if (!e || !e.mixer) return false;
    const clip = e.actions.get(name.toLowerCase());
    if (!clip) return false;
    if (e.action) e.action.stop();
    const a = e.mixer.clipAction(clip);
    a.reset();
    a.setLoop(THREE.LoopOnce, 1);
    a.clampWhenFinished = hold;
    a.play();
    e.action = a;
    return true;
  }

  /**
   * Show a destructable broken.
   *
   * The wreckage is already in the model, hidden by the stand sequence's
   * geoset-alpha track -- the elven gate stands as [1,0,1,0] and dies as
   * [1,1,0,0]. Dying is that second row, so this is the same switch the stand
   * pose made, read from the other sequence. A model with no geoset animation
   * (the city entrance gate has none) has no wreckage to show and is left as it
   * is rather than being hidden, which would leave a hole in the wall.
   */
  setDoodadDead(index) {
    const e = this.doodadAt && this.doodadAt.get(index);
    if (!e || e.dead) return false;
    e.dead = true;
    const seqs = e.rec?.meta?.sequences || [];
    const s = seqs.find((q) => /^death$/i.test(q.name)) || seqs.find((q) => /^death/i.test(q.name));
    const a = s && s.geosetAlpha;
    if (!a) return false;
    if (!e.prims) { e.prims = []; e.obj.traverse((o) => { if (o.isMesh) e.prims.push(o); }); }
    e.prims.forEach((o, i) => { const v = a[i]; o.visible = !(v !== undefined && v <= 0.01); });
    // Some geosets are not held at a value across the sequence but fade over
    // it: the elven gate's death curves geoset 3 from 0 up to 1 across the
    // first two thirds, and reading only the held alphas left that one hidden
    // for good. Ticked against the clip while it plays.
    e.deathCurve = (s.geosetAlphaCurve && s.geosetAlphaCurve.some(Boolean))
      ? s.geosetAlphaCurve : null;
    e.deathClock = 0;
    return true;
  }

  /**
   * Walk a dying destructable's geoset-alpha curves forward.
   *
   * Visibility rather than opacity: a doodad's materials are shared by every
   * placement of its type -- that sharing is deliberate, and what keeps a
   * replaceable texture from being cloned 27 times for the trees -- so fading
   * one instance would fade them all. The timing is the part that carries.
   */
  tickDoodadCurves(e, dt) {
    if (!e.deathCurve) return;
    e.deathClock += dt;
    const t = e.deathClock;
    const c = e.deathCurve;
    let live = false;
    for (let i = 0; i < c.length; i++) {
      const mesh = e.prims && e.prims[i];
      if (!c[i] || !mesh) continue;
      mesh.visible = sampleCurve(c[i], t) > 0.02;
      const last = c[i][c[i].length - 1];
      if (t < last[0]) live = true;
    }
    if (!live) e.deathCurve = null;             // settled: stop reading it
  }

  /**
   * The destructable under the cursor, by placement index.
   *
   * Against the meshes rather than a bounding sphere: a gate is 896 units of
   * wall and a sphere around its centre would take clicks meant for whatever
   * stands beside it, and miss its ends.
   */
  pickDoodad(nx, ny, allowed) {
    if (!this.doodadAt || !this.doodadAt.size) return null;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    let best = null, bd = Infinity;
    for (const [i, e] of this.doodadAt) {
      if (allowed && !allowed.has(i)) continue;
      // Raycasting reads matrixWorld and does not compute it. A doodad that has
      // not been through a render yet -- the group is added to the scene only
      // once every type has loaded -- still carries an identity matrix, so it
      // sits at the origin as far as the ray is concerned and is never hit.
      e.holder.updateWorldMatrix(true, true);
      const hit = ray.intersectObject(e.holder, true);
      if (hit.length && hit[0].distance < bd) { bd = hit[0].distance; best = i; }
    }
    return best;
  }

  // ---------------------------------------------------------------- models
  async loadModel(name) {
    if (this.modelCache.has(name)) return this.modelCache.get(name);
    if (this.pending.has(name)) return this.pending.get(name);
    const p = (async () => {
      const [gltf, meta] = await Promise.all([
        this.loader.loadAsync(`/assets/models/${name}.glb`),
        fetch(`/assets/models/${name}.json`).then((r) => r.json()),
      ]);
      gltf.scene.traverse((o) => {
        if (o.isMesh) {
          o.frustumCulled = false;
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const mm of mats) {
            if (mm.map) mm.map.colorSpace = THREE.SRGBColorSpace;
            mm.side = mm.side ?? THREE.FrontSide;
          }
        }
      });
      const rec = { gltf, meta, bounds: cullBoundsOf(meta) };
      this.modelCache.set(name, rec);
      return rec;
    })();
    // A 404 is remembered here forever otherwise, so a unit whose model is
    // missing stays invisible through every respawn rather than falling back
    // to the stand-in once.
    p.catch(() => { if (this.pending.get(name) === p) this.pending.delete(name); });
    this.pending.set(name, p);
    return p;
  }

  async spawnView(ent) {
    if (this.views.has(ent.i)) return this.views.get(ent.i);
    const view = { id: ent.i, kind: ent.k, team: ent.t, root: new THREE.Group(),
                   mixer: null, actions: new Map(), meta: null, current: null,
                   prims: [], loading: true, x: ent.x, y: ent.y, facing: ent.f };
    this.views.set(ent.i, view);
    this.scene.add(view.root);
    view.root.position.set(toX(ent.x), this.heightAt(ent.x, ent.y), toZ(ent.y));

    const name = ent.model;
    view.isHero = !!ent.isHero;
    // A Locust unit is a dummy the map casts its spells through -- the player is
    // never meant to see or touch it. Its model is deliberately a name that does
    // not exist, and this map spells that four different ways in Korean
    // ("없다", "없음", "업다", "읎지여"), so matching the spellings is a losing
    // game: what settles it is that the unit is Locust and has no model. Give it
    // no stand-in mesh, or it walks the battlefield as a grey capsule -- the
    // "ghost orc" left behind by Byakuya's Senka.
    if (!name && ent.locust) { view.locust = true; view.loading = false; return view; }
    // Blizzard base models are not inside the map file; use readable stand-ins.
    const standIn = () => {
      if (ent.k === Ent.SHOP || ent.isBuilding) {
        const body = new THREE.Mesh(own(view, new THREE.BoxGeometry(200, 210, 200)),
          own(view, new THREE.MeshLambertMaterial({ color: 0x6d6a63 })));
        body.position.y = 105;
        const roof = new THREE.Mesh(own(view, new THREE.ConeGeometry(165, 130, 4)),
          own(view, new THREE.MeshLambertMaterial({ color: 0x8a5a3c })));
        roof.position.y = 275; roof.rotation.y = Math.PI / 4;
        view.root.add(body, roof);
      } else {
        const r = Math.max(14, (ent.radius || 24) * 0.9);
        const g = own(view, new THREE.CapsuleGeometry(r, r * 2, 4, 10));
        const mesh = new THREE.Mesh(g, own(view, new THREE.MeshLambertMaterial(
          { color: TEAM_COLOR[ent.t] ?? 0x888888 })));
        mesh.position.y = Math.max(14, (ent.radius || 24) * 0.9) * 2;
        view.root.add(mesh);
      }
      view.loading = false;
      return view;
    };
    if (!name) return standIn();
    // A model the assets do not carry is a real case -- o00D is named by a
    // morph and has no unit type -- and it used to leave a unit that could be
    // clicked and killed but never seen. spawnEffect and spawnMissile both
    // catch here; this did not.
    let rec;
    try { rec = await this.loadModel(name); } catch { return standIn(); }
    if (!this.views.has(ent.i)) return view;        // removed while loading
    const { gltf, meta } = rec;
    const obj = cloneModel(gltf.scene);
    obj.scale.setScalar(ent.scale || 1);
    view.root.add(obj);
    view.obj = obj;
    // While the cull below has this model hidden, the per-frame scene walk
    // would still recompose every bone in it: Object3D.updateMatrixWorld
    // recurses whether or not a node is visible, and at 400 units that walk
    // was 9 ms a frame. Skipped while hidden. Nothing goes stale that
    // matters: the walk recomputes the whole subtree the frame it is shown
    // again, and an on-demand query in the meantime (getWorldPosition on an
    // attachment point, say) rebuilds its own ancestor chain through
    // updateWorldMatrix, which does not come through here.
    obj.updateMatrixWorld = function (force) {
      if (this.visible) THREE.Object3D.prototype.updateMatrixWorld.call(this, force);
    };
    view.meta = meta;
    view.bounds = rec.bounds;
    view.isBuilding = !!ent.isBuilding;      // decides the Stand Work question
    view.animProps = animTokens(ent.an);     // Required Animation Names
    this.attachShadow(view, ent);
    this.attachSplat(view, ent);
    // Materials first, and prims with them. Emitters, ribbons and sprays add
    // their own meshes to this same object, so collecting prims afterwards
    // counts those too -- which slides the geoset index off the end and hands
    // an emitter's carefully built ShaderMaterial the blending rules meant for
    // a geoset. prims is indexed one-to-one against meta.geosets and must hold
    // nothing but the model's own geometry.
    view.prims = this.applyMaterials(obj, meta, view);
    view.emitters = this.attachEmitters(obj);
    view.ribbons = this.attachRibbons(obj);
    // Deliberately no lights on unit views: a unit lives for the whole game and
    // would hold its pool slot forever, so the first eight units with a torch
    // would leave nothing for any spell. Lights go to effects and missiles,
    // which come and go.
    this.attachSprays(obj, view);
    view.events = buildEvents(obj);      // blood, footprints, impacts
    // Team colour, the way Warcraft III does it: a material bound to a
    // ReplaceableTextures swatch wears the *owning player's* colour, so the
    // texture is swapped rather than the material tinted. The converter bakes
    // colour 00 (red) as the default, which is why every unit of every team used
    // to arrive red; `ent.c` is the colour the map actually gave that player.
    const colour = String(ent.c ?? ent.p ?? 0).padStart(2, '0');
    view.prims.forEach((mesh, i) => {
      const gi = meta.geosets?.[i];
      const mt = gi ? meta.materials?.[gi.material] : null;
      const kind = /ReplaceableTextures\/(TeamColor|TeamGlow)\//i.exec(mt?.texture || '');
      if (!kind) return;
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      mesh.material = mats.map((mm) => {
        const c = own(view, mm.clone());
        c.map = this.teamTexture(kind[1], colour) || c.map;   // the swatch is shared
        if (c.emissiveMap) c.emissiveMap = c.map;
        return c;
      });
      if (mesh.material.length === 1) mesh.material = mesh.material[0];
    });
    // after the team-colour clone above, so the material animated is the one
    // this view owns rather than the cache's shared copy
    view.texAnims = buildTexAnims(view.prims, meta);
    view.bornAt = performance.now() / 1000;
    if (gltf.animations.length) {
      view.mixer = new THREE.AnimationMixer(obj);
      // a scale set before this view existed, or before it was rebuilt by a
      // metamorphosis, still applies to the unit underneath it
      const held = this.timeScales?.get(view.id);
      if (held != null) view.mixer.timeScale = held;
      for (const clip of gltf.animations) {
        const a = view.mixer.clipAction(clip);
        view.actions.set(clip.name.toLowerCase(), a);
      }
      // Warcraft III draws a fresh idle variant each time the animation comes
      // round; that is what makes a building's work animation surface every so
      // often rather than never or always.
      view.mixer.addEventListener('loop', (e) => {
        if (view.stateName !== 'stand' || e.action !== view.currentAction) return;
        this.play(view, 'stand', false, true);
      });
      // A clip the script asked for by name plays once and used to hold its
      // last frame for good: SetUnitAnimation("spell") left the unit frozen
      // mid-cast until something else changed its state. Warcraft III returns
      // to the unit's own stand when the sequence ends -- or to whatever
      // QueueUnitAnimation asked for, which this map uses for the duel
      // winner's flourish: "spell", then a queued "stand".
      view.mixer.addEventListener('finished', (e) => {
        if (e.action !== view.currentAction || !view.scripted) return;
        const next = view.queuedAnim;
        view.queuedAnim = null;
        if (next) this.playUnitAnim(view.id, next);
        else this.play(view, view.stateName || 'stand', false, true);
      });
    }
    this.armGeosetClock(view, meta);
    view.loading = false;
    this.play(view, 'stand');
    return view;
  }

  /**
   * Honour each geoset's MDX filter mode, and hand back the meshes in geoset
   * order so the geoset-visibility pass can index them.
   *
   * This lived inside buildView and so ran for *units only*. Warcraft III
   * effect art is glow art -- 540 of the 659 materials on this map's 312
   * ability-art models are additive or addalpha -- and every one of those
   * models arrives through spawnEffect or spawnMissile, which never ran this.
   * They drew with plain glTF alpha: a flat quad where a glow belongs.
   */
  applyMaterials(obj, meta, holder) {
    const prims = [];
    obj.traverse((o) => { if (o.isMesh) prims.push(o); });
    prims.forEach((mesh, i) => {
      const gi = meta?.geosets?.[i];
      const mt = gi ? meta.materials?.[gi.material] : null;
      if (!mt) return;
      // An unshaded layer is not lit. Warcraft III takes the texture as the
      // colour and no lamp touches it; a PBR material lights it and adds an
      // emissive copy on top, so the layer is drawn roughly three times over.
      // On an additive layer that is what turns a soft team glow into a
      // rectangle: the quad's near-black border (RGB 1 in the source art) gets
      // lifted far enough to separate from the ground behind it, and the box is
      // the quad's own outline. An unlit material is the honest expression of
      // "not lit" and needs no compensating factors.
      if (mt.unshaded) {
        const swap = (mm) => {
          const b = new THREE.MeshBasicMaterial({
            map: mm.map || mm.emissiveMap || null,
            color: 0xffffff, transparent: mm.transparent, opacity: mm.opacity,
            alphaTest: mm.alphaTest, side: mm.side, depthTest: mm.depthTest,
            depthWrite: mm.depthWrite, blending: mm.blending,
          });
          return own(holder, b);
        };
        mesh.material = Array.isArray(mesh.material)
          ? mesh.material.map(swap) : swap(mesh.material);
      }
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const mm of mats) {
        if (mt.filter === 'additive' || mt.filter === 'addalpha') {
          mm.blending = THREE.AdditiveBlending;
          mm.transparent = true; mm.depthWrite = false;
        } else if (mt.filter === 'modulate' || mt.filter === 'modulate2x') {
          mm.blending = THREE.MultiplyBlending;
          mm.transparent = true; mm.depthWrite = false;
        } else if (mt.filter === 'blend') {
          mm.transparent = true; mm.depthWrite = false;
        }
        if (mt.twoSided) mm.side = THREE.DoubleSide;
        if (mt.noDepthTest) mm.depthTest = false;
        // priorityPlane is the model's own answer to "which of these overlapping
        // additive layers goes on top"; it was exported and never read, leaving
        // the order to whatever the scene graph happened to produce.
        if (mt.priority) mesh.renderOrder = mt.priority;
      }
    });
    return prims;
  }

  /**
   * Which sequence a thing is playing and how far into it, for the emitters
   * hanging off it. Anything with no animation returns null, and an emitter
   * given no context simply runs -- there is no sequence to scope it to.
   */
  animCtxOf(h) {
    const a = h && (h.currentAction || h.action);
    return a ? { seq: h.seqIndex ?? -1, t: a.time } : null;
  }

  /**
   * Resolve a Warcraft III attach point to a node inside the model.
   *
   * The script names them the way the World Editor does -- "origin", "chest",
   * "weapon", "overhead", "right foot" -- while the model calls them
   * "Origin Ref", "Chest Ref", "Foot Right Ref", "Head - Ref". Matching is by
   * whole token, so word order does not matter, "Ref" and punctuation are
   * noise, and `head` cannot accidentally match `OverHead Ref` the way a
   * substring test would.
   *
   * The map does this 59 times and every one of them used to land on the unit's
   * root: an overhead buff drawn at the feet, a weapon effect at the origin.
   */
  attachNode(obj, attach) {
    const want = attachTokens(attach);
    if (!want.length || !obj) return null;
    let best = null, bestExtra = Infinity;
    obj.traverse((o) => {
      if (!o.name) return;
      const t = attachTokens(o.name);
      if (!t.length || !want.every((w) => t.includes(w))) return;
      const extra = t.filter((x) => !want.includes(x)).length;
      if (extra < bestExtra) { bestExtra = extra; best = o; }
    });
    return best;
  }

  /** Where a clip sits in the model's sequence list, which is what `vis` is keyed by. */
  seqIndexOf(meta, clipName) {
    if (!meta?.sequences || !clipName) return -1;
    const want = String(clipName).toLowerCase();
    return meta.sequences.findIndex((s) => s.name.toLowerCase() === want);
  }

  /**
   * Choose an MDX sequence for a logical state, the way Warcraft III does.
   *
   * The engine names animations by *token set*, not by string. The map says so
   * itself: 257 of its abilities carry an Animnames field holding things like
   * "spell,slam", "attack,slam", "stand,channel" -- a request for {spell, slam}
   * that matches the sequence "Spell Slam". A sequence qualifies when its own
   * tokens contain every token asked for.
   *
   * Among the qualifying sequences the engine picks one at random, weighted by
   * `rarity` -- which is exactly what that field is for, and which was exported
   * in the sequence meta and read by nothing. This mattered more than it looks:
   * the old code returned the *first* exact name match and never varied, so 416
   * of the 588 models this map places had stand variants that were unreachable
   * for the whole game.
   */
  pickClip(view, state) {
    if (!view.actions.size) return null;
    const names = [...view.actions.keys()];
    const want = TAGS[state] || tokensOf(state);
    const cand = names
      .map((n) => ({ n, extra: tokensOf(n).filter((t) => !want.includes(t)) }))
      .filter(({ n }) => {
        const t = tokensOf(n);
        return want.every((w) => t.includes(w));
      });
    if (!cand.length) {
      const loose = names.find((n) => n.startsWith(want[0] || ''));
      if (loose) return loose;
      // Falling back to Stand is only ever right for a unit that is alive. A
      // model with no Decay Flesh asked to decay must hold the pose its death
      // clip left it in -- returning Stand there stands the corpse back up.
      return TAGS[state] ? (names.find((n) => n.startsWith('stand')) || names[0]) : null;
    }
    // Containment alone is too loose. A request for {stand} contains "Stand
    // Upgrade Third Attack Ready" as surely as it contains "Stand", and drawing
    // freely among them made the arcane tower flicker between its base and all
    // three upgraded appearances. Warcraft III keeps the extra tokens in check
    // with the unit's Required Animation Names: what a unit does *not* declare,
    // it does not play.
    const req = view.animProps || [];
    // The one documented widening. "Stand Work" is a building's working
    // animation, and whether the engine admits it into the plain idle pool is
    // not decidable from this map's data: the rarity values disagree with each
    // other (the Barracks has Stand at 1 and Stand Work at 0). It is admitted
    // for buildings only, which is where the war mill's `work smoke` and the
    // ammo dump's fire live. Flip this one constant to change that judgement.
    const allow = STAND_WORK_IDLES && view.isBuilding && want.includes('stand')
      ? req.concat('work') : req;
    let pool = cand.filter((c) => c.extra.every((t) => allow.includes(t)));
    // What a unit declares, it *prefers*. This was the missing half: the rule
    // was "an exact match wins, and the declared tokens only break a tie when
    // nothing matched exactly", which is right for the arcane tower -- it has no
    // plain Stand, only "Stand Upgrade Third" and four siblings -- and wrong for
    // everything whose model carries both. The Castle drew as a Town Hall, the
    // Fortress as a Great Hall, the swimming penguin as a walking one, Illidan's
    // demon form as Illidan, and Ichigo's Bankai as Ichigo: 57 unit/animation
    // pairs across 22 unit types, every one of them the plain variant of a model
    // that had the right one all along.
    const score = (c) => c.extra.filter((t) => req.includes(t)).length;
    if (pool.length) {
      const best = Math.max(...pool.map(score));
      pool = pool.filter((c) => score(c) === best);
      return weightedByRarity(pool.map((c) => c.n), view.meta);
    }
    // Nothing the unit is allowed to play matches. Take the closest thing:
    // most of what it declares, then least of what it does not, then the model's
    // own order so the choice is stable rather than flickering between equals.
    const rank = (c) => [-score(c), c.extra.length, this.seqIndexOf(view.meta, c.n)];
    let best = cand[0], bs = rank(best);
    for (const c of cand.slice(1)) {
      const s2 = rank(c);
      for (let i = 0; i < s2.length; i++) {
        if (s2[i] !== bs[i]) { if (s2[i] < bs[i]) { best = c; bs = s2; } break; }
      }
    }
    return best.n;
  }

  play(view, state, once = false, reroll = false) {
    if (!view.mixer) return;
    // Selection is a random draw among variants now, so re-entering a state the
    // unit is already in must not re-roll on every call -- only when the state
    // actually changes, or when the clip has come round and the engine would
    // draw again.
    if (!reroll && view.stateName === state && view.currentAction?.isRunning()) return;
    const clip = this.pickClip(view, state);
    if (!clip) return;
    if (view.current === clip) { view.stateName = state; return; }
    const next = view.actions.get(clip);
    if (!next) return;
    if (view.currentAction) view.currentAction.fadeOut(0.18);
    next.reset();
    next.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    next.clampWhenFinished = once;
    next.fadeIn(0.18).play();
    view.current = clip;
    view.currentAction = next;
    view.stateName = state;
    view.scripted = false;
    view.seqIndex = this.seqIndexOf(view.meta, clip);
    this.applyGeosetVisibility(view, clip);
  }

  /** MDX geoset animations decide which geosets show in each sequence. */
  applyGeosetVisibility(view, clipName) {
    const meta = view.meta;
    if (!meta?.sequences) return;
    const seq = meta.sequences.find((s) => s.name.toLowerCase() === clipName);
    if (!seq) return;
    const alpha = seq.geosetAlpha;
    if (alpha) view.prims.forEach((mesh, i) => {
      const a = alpha[i];
      if (a !== undefined) this.setGeosetAlpha(view, mesh, a);
    });
    // some sequences fade a geoset in or out partway through (gore appearing
    // mid-death); those get ticked per frame
    view.alphaCurve = seq.geosetAlphaCurve || null;

    // The material's own alpha, which is the track that dissolves a corpse.
    // It is indexed by material, not by geoset, so each prim asks its geoset
    // which material it wears.
    const mAlpha = seq.matAlpha;
    if (mAlpha) view.prims.forEach((mesh, i) => {
      const mi = meta.geosets && meta.geosets[i] ? meta.geosets[i].material : null;
      const a = mi == null ? undefined : mAlpha[mi];
      if (a !== undefined) this.setMaterialAlpha(view, mesh, a);
    });
    view.matCurve = seq.matAlphaCurve || null;
  }

  /** Sample the in-sequence alpha curves against the clip's current time. */
  tickGeosetCurves(view, dt = 0) {
    const geo = view.alphaCurve, mats = view.matCurve;
    if (!geo && !mats) return;
    let t;
    if (view.currentAction) t = view.currentAction.time;
    else if (view.geoClock) {                  // a model whose only animation is this
      const c = view.geoClock;
      c.t = c.dur > 0 ? (c.t + dt) % c.dur : 0;
      t = c.t;
    } else return;
    if (geo) for (let i = 0; i < geo.length; i++) {
      const mesh = view.prims[i];
      if (geo[i] && mesh) this.setGeosetAlpha(view, mesh, sampleCurve(geo[i], t));
    }
    // material curves are indexed by material, so they are read through the
    // geoset that wears one rather than positionally against prims
    if (mats) {
      const gs = view.meta && view.meta.geosets;
      for (let i = 0; i < view.prims.length; i++) {
        const mi = gs && gs[i] ? gs[i].material : null;
        const c = mi == null ? null : mats[mi];
        if (c) this.setMaterialAlpha(view, view.prims[i], sampleCurve(c, t));
      }
    }
  }

  /**
   * A material's own alpha, which is a separate track from its geoset's.
   *
   * Warcraft III dissolves a corpse with this one: 133 of 250 unit models
   * animate it across Decay Flesh and Decay Bone, and 70 of those take it to
   * zero. The converter parsed it and threw it away, so a corpse used to hold
   * full opacity until its timer ran out and it simply stopped existing.
   */
  setMaterialAlpha(view, mesh, a) {
    const prev = mesh.userData.__matA ?? 1;
    if (Math.abs(a - prev) < 0.002) return;
    mesh.userData.__matA = a;
    if (!mesh.visible) return;
    this.ownPrimMaterials(view);
    this.applyMeshAlpha(view, mesh);
  }

  /**
   * A clock for a model whose only animation *is* its geoset alpha.
   *
   * Devotion Aura and the Voodoo Aura have no bone or node animation at all --
   * nothing on them moves, the ring simply breathes -- so the converter writes
   * no glTF clip and there is no mixer to read a time from. Both were drawn
   * frozen on their first frame, which for these two is fully transparent. The
   * sequence still carries its duration, so this gives them one of their own.
   */
  armGeosetClock(holder, meta) {
    if (holder.mixer || holder.geoClock || !meta?.sequences) return;
    const seq = meta.sequences.find((x) => /^stand/i.test(x.name) && x.geosetAlphaCurve)
             || meta.sequences.find((x) => x.geosetAlphaCurve);
    if (!seq || !(seq.duration > 0)) return;
    holder.current = seq.name.toLowerCase();
    this.applyGeosetVisibility(holder, holder.current);
    if (holder.alphaCurve) holder.geoClock = { t: 0, dur: seq.duration };
  }

  /**
   * One geoset's alpha, as Warcraft III applies it: a fade, not a switch.
   *
   * A geoset animation carries a real 0..1 track and the game draws the geoset
   * at that alpha, which is how an aura's ring breathes and how flesh dissolves
   * during Decay.  Reading it as `visible = a > 0.05` turned every one of those
   * into a pop.  19 of the 1105 converted models carry a value strictly between
   * clear and solid -- the auras, War Stomp's and Thunder Clap's caster rings,
   * three missiles and the feathers -- so the material is only touched when one
   * of them is actually part-way through a fade.  Everything else keeps the old
   * visibility-only path and its cost.
   *
   * Fully clear is still not drawn at all: cheaper, and identical on screen.
   */
  setGeosetAlpha(view, mesh, a) {
    mesh.visible = a > 0.02;
    const prev = mesh.userData.__geoA ?? 1;
    if (Math.abs(a - prev) < 0.002) return;      // solid every frame: the common case
    mesh.userData.__geoA = a;
    if (!mesh.visible) return;                   // nothing drawn, nothing to shade
    this.ownPrimMaterials(view);
    this.applyMeshAlpha(view, mesh);
  }

  /**
   * Push a mesh's authored colour and opacity through everything modulating it.
   *
   * Warcraft III multiplies rather than replaces, so a geoset animation holding
   * a layer at 40% and a SetUnitVertexColor ghosting the unit to 50% leave it
   * at 20%.  Both used to write `opacity` straight, which meant whichever ran
   * last simply won and the other was lost.
   */
  applyMeshAlpha(view, mesh) {
    const geo = mesh.userData.__geoA ?? 1;
    const mat = mesh.userData.__matA ?? 1;
    const tintA = view.tintA ?? 1;
    for (const mm of matsOf(mesh)) {
      const base = mm.userData.__base;
      if (!base) continue;
      if (mm.color && base.color) {
        if (view.tintColor) mm.color.copy(base.color).multiply(view.tintColor);
        else mm.color.copy(base.color);
      }
      mm.opacity = base.opacity * geo * mat * tintA;
      mm.transparent = base.transparent || mm.opacity < 1;
    }
  }


  // ------------------------------------------------------------ spell visuals
  /**
   * models.json is keyed by the archive path ("units\creeps\gnoll\gnoll");
   * the converted files swap the separator for "~".
   */
  modelIndex() {
    if (!this._modelIndex) {
      this._modelIndex = fetch('/assets/models.json')
        .then((r) => r.json())
        .then((idx) => {
          const m = new Map(), byBase = new Map();
          for (const k of Object.keys(idx)) {
            const asset = k.replace(/\\/g, '~');
            const low = k.toLowerCase();
            m.set(low, asset);
            // map imports are keyed by bare name ("OrbitalRay") while the script
            // asks for "war3mapImported\OrbitalRay.mdl", so index the tail too
            byBase.set(low.split('\\').pop(), asset);
          }
          return { exact: m, byBase };
        })
        .catch(() => ({ exact: new Map(), byBase: new Map() }));
    }
    return this._modelIndex;
  }

  /** A model path as the map's script writes it -> converted asset name. */
  async resolveModel(path) {
    if (!path) return null;
    const idx = await this.modelIndex();
    const key = String(path)
      .replace(/\\\\/g, '\\')
      .replace(/\//g, '\\')
      .replace(/^\\+/, '')
      .replace(/\.(mdl|mdx)$/i, '')
      .toLowerCase();
    // the map's explicit "no model", which it spells several ways
    if (!key || key === 'none' || NO_MODEL.has(key.replace(/\.(mdl|mdx)$/i, ''))) return null;
    return idx.exact.get(key) || idx.byBase.get(key.split('\\').pop()) || null;
  }

  /** AddSpecialEffect / AddSpecialEffectTarget. */
  /**
   * Put back the particle emitters glTF cannot carry.
   *
   * The sprite sheet is shared: a hundred blood effects on screen are a hundred
   * emitters but one texture, and re-decoding it per effect is what turns a
   * spell into a stutter.
   */
  /** TeamColor07.png / TeamGlow07.png and the rest, loaded once and shared. */
  teamTexture(kind, colour) {
    const uri = `textures/ReplaceableTextures/${kind}/${kind}${colour}.png`;
    let t = this.fxTextures.get(uri);
    if (!t) {
      t = new THREE.TextureLoader().load('/assets/' + uri);
      t.colorSpace = THREE.SRGBColorSpace;
      t.flipY = false;                 // glTF UVs, like the texture it replaces
      this.fxTextures.set(uri, t);
    }
    return t;
  }

  /**
   * ParticleEmitter1 sprays -- the models a creep bursts into.
   *
   * Async, because each emitter names a model of its own to throw; the sprays
   * attach a moment after the unit does, which is harmless since they fire on
   * death rather than on spawn.
   */
  attachSprays(obj, owner) {
    buildSprays(obj, async (path) => {
      const name = await this.resolveModel(path);
      if (!name) return null;
      const rec = await this.loadModel(name);
      return cloneModel(rec.gltf.scene);
    }).then((list) => { owner.sprays = list; }).catch(() => {});
  }

  /**
   * A unit's shadow.
   *
   * Warcraft III does not shadow-map anything: it lays a flat textured quad on
   * the ground beneath each unit, and the unit's own data names the image and
   * gives its size and offset -- 767 of this map's 997 unit types carry one.
   * That is why turning `shadowMap` on would not have produced them, and why it
   * stays off: this is both faithful and far cheaper than a shadow pass.
   */
  attachShadow(view, ent) {
    if (!ent.sh || view.shadow) return;
    const w = (ent.sw || 128), h = (ent.shh || 128);
    const tex = this.fxTextures.get('shadow:' + ent.sh) || (() => {
      const t = new THREE.TextureLoader().load(
        `/assets/textures/ReplaceableTextures/Shadows/${ent.sh}.png`);
      t.colorSpace = THREE.SRGBColorSpace;
      this.fxTextures.set('shadow:' + ent.sh, t);
      return t;
    })();
    const mesh = new THREE.Mesh(
      own(view, new THREE.PlaneGeometry(w, h)),
      own(view, new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.55,
                                              depthWrite: false, color: 0x000000 })));
    mesh.rotation.x = -Math.PI / 2;
    // shadowX/shadowY place the image's corner, not its centre
    mesh.position.set(w / 2 - (ent.sx || 0), 3, h / 2 - (ent.sy || 0));
    mesh.renderOrder = -1;
    view.root.add(mesh);
    view.shadow = mesh;
  }

  /**
   * Warcraft III's selection circle.
   *
   * Every number here is measured from the game's own art rather than chosen.
   * UI\Feedback\selectioncircle\selectioncircle.mdx is a flat quad spanning
   * +/-38.2 world units at selection scale 1, sitting 12 units above the
   * ground so it does not fight the terrain for depth -- so that is the radius
   * and that is the lift. The scale itself is the unit type's own `ussc`, which
   * is a different field from the model scale: the Paladin is 1.25 selection
   * against 1.0 model, and this map sets Ichigo to 1.1 and his Bankai form to
   * 1.25.
   *
   * Warcraft III ships three ring textures rather than one, and the reason is
   * visible in the art: the band is 5 pixels wide in Small, 3 in Med and 1 in
   * Large, so a circle drawn bigger keeps the same stroke on screen. Which one
   * the engine picks at which size is not in any data file, so the thresholds
   * below are ours; everything above them is the game's.
   *
   * The colour is by relationship, not by player: green for yours, red for an
   * enemy, yellow for an ally. The art is a white alpha mask, which is what
   * lets one texture serve all three.
   */
  selectionCircle(view, ent) {
    if (view.circle) return view.circle;
    const r = 38.2 * (ent.ss || 1);
    const tier = r < 60 ? 'Small' : r < 110 ? 'Med' : 'Large';
    const key = 'sel:' + tier;
    let tex = this.fxTextures.get(key);
    if (!tex) {
      tex = new THREE.TextureLoader().load(
        `/assets/textures/ReplaceableTextures/Selection/SelectionCircle${tier}.png`);
      tex.colorSpace = THREE.SRGBColorSpace;
      this.fxTextures.set(key, tex);
    }
    const mesh = new THREE.Mesh(
      own(view, new THREE.PlaneGeometry(r * 2, r * 2)),
      own(view, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false,
                                              color: 0x40ff40 })));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 12 + (ent.sz || 0);
    // Drawn after the world's own ground art, not under it. Warcraft III shows
    // the circle over whatever a unit is standing on, and several heroes here
    // carry a big additive ground glow -- Ichigo's is 384 units across -- which
    // is (SrcAlpha, One) over anything beneath it and washes a green ring to
    // nothing. This sits above every priorityPlane a model can ask for, and it
    // still depth-tests, so the unit itself is in front of it as it should be.
    mesh.renderOrder = 900;
    mesh.visible = false;
    view.root.add(mesh);
    view.circle = mesh;
    return mesh;
  }

  /**
   * Where a unit's health bar hangs, in world space.
   *
   * Measured off the built model once and cached, not taken from the MDX
   * extent: this map's extents are unreliable enough that Ichigo's claims 835
   * units against a body of 184, which would hang his bar off the top of the
   * screen. A bounding box over the bind pose is not exact under skinning but
   * it is the right size, which is all a bar needs.
   */
  /**
   * A world point as a vector the caller can project: map x/y on the terrain,
   * plus a height offset. The vector is reused, so project or read it before
   * asking for another one.
   */
  groundPoint(wx, wy, dz) {
    return (this._gpt || (this._gpt = new THREE.Vector3()))
      .set(toX(wx), this.heightAt(wx, wy) + (dz || 0), toZ(wy));
  }

  barAnchor(v) {
    // A view spawns before its glTF arrives, so measuring on the first frame
    // measures nothing. Cache only once there is geometry to measure, or every
    // unit in the game keeps the fallback for its whole life.
    if (v.headY == null && v.prims && v.prims.length) {
      const box = new THREE.Box3();
      for (const m of v.prims) box.expandByObject(m);
      if (!box.isEmpty()) v.headY = Math.max(40, box.max.y - v.root.position.y) + 26;
    }
    return v.root.position.clone().setY(v.root.position.y + (v.headY ?? 140));
  }

  /**
   * Draw every unit in its bind pose, with no skeleton work.
   *
   * The diagnostic the other two switches cannot give. Hiding the units removes
   * their draw calls and their skinning together; freezing animation removes
   * neither, because three.js rebuilds a skeleton for every skinned mesh it
   * renders whatever the mixer did beforehand. This leaves the draw calls
   * untouched and takes only the skeleton away, so whichever of the two costs
   * the frame shows up alone.
   *
   * It stubs the skeleton's own update rather than clearing isSkinnedMesh:
   * three.js reaches the skeleton through the mesh's matrix update, not through
   * that flag. The models stand stiff while it is on -- it is a measurement,
   * not a mode.
   */
  setSkinning(on) {
    this.skinless = !on;
    const seen = new Set();
    for (const v of this.views.values()) {
      for (const mesh of v.prims || []) {
        const sk = mesh.skeleton;
        if (!sk || seen.has(sk)) continue;
        seen.add(sk);
        if (!sk.__realUpdate) sk.__realUpdate = sk.update;
        sk.update = on ? sk.__realUpdate : NOOP;
      }
    }
    return seen.size;
  }

  /** Show or hide one unit's circle. `rel` is own | ally | enemy | neutral. */
  markSelected(id, rel, ent) {
    const v = this.views.get(id);
    if (!v) return;
    if (!rel && !v.circle) return;               // nothing to hide, nothing to build
    const c = this.selectionCircle(v, ent || {});
    c.visible = !!rel;
    if (rel) c.material.color.setHex(SELECTION_COLOR[rel] ?? SELECTION_COLOR.neutral);
  }

  /**
   * The ground decal a building is stamped on.
   *
   * Warcraft III lays an "ubersplat" under every building -- scorched earth
   * beneath an orc hut, flagstones beneath a human one, the rune ring under an
   * altar. The unit names a row in Splats\UberSplatData.slk which gives the
   * texture and a scale; 961 of this map's unit types name one and 179 of those
   * references resolve to art. None of it drew, because that whole directory
   * was missing from the extraction.
   *
   * It sits a hair above the ground and below the unit's shadow, and does not
   * write depth, so terrain and shadow both read through it correctly.
   */
  attachSplat(view, ent) {
    const id = ent.us;
    if (!id || view.splat) return;
    const spec = this.splats?.[id];
    if (!spec) return;
    const key = 'splat:' + id;
    let tex = this.fxTextures.get(key);
    if (!tex) {
      tex = new THREE.TextureLoader().load('/assets/' + spec.t);
      tex.colorSpace = THREE.SRGBColorSpace;
      this.fxTextures.set(key, tex);
    }
    const s = Math.max(16, spec.s || 100);
    const mesh = new THREE.Mesh(
      own(view, new THREE.PlaneGeometry(s, s)),
      own(view, new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false,
                                    // BlendMode 1 is the additive glow used by
                                    // rune circles; 0 is ordinary alpha
                                    blending: spec.b === 1 ? THREE.AdditiveBlending
                                                           : THREE.NormalBlending })));
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 2;
    mesh.renderOrder = -2;              // under the shadow, over the ground
    view.root.add(mesh);
    view.splat = mesh;
  }

  /** Omni lights an effect carries, borrowed from the fixed pool. */
  attachLights(obj, owner) { return buildLights(obj, this.lightPool, owner); }

  /**
   * An event object has come round: do the thing it names.
   *
   * The node's own world position is where it happens -- a wound, a foot, the
   * point a body part is thrown from -- so a splat lands under the wound rather
   * than under the unit's origin.
   */
  fireEvent(e) {
    e.node.updateWorldMatrix(true, false);
    const p = new THREE.Vector3().setFromMatrixPosition(e.node.matrixWorld);
    const wx = p.x, wy = -p.z;         // back out of three.js coords
    // a handful of models spell the kind in lower case ('fptxFBL1')
    switch (String(e.d.kind).toUpperCase()) {
      // a splat and a footprint are the same thing from the same table; the
      // only difference is which cells of the sheet they use
      case 'SPL':
      case 'FPT':
        this.splatField?.add(e.d.id, wx, wy);
        break;
      case 'UBR': {
        // an ubersplat is a single image rather than a sheet, and holds before
        // it decays; the field draws it the same way once told so
        const u = this.splats?.[e.d.id];
        if (u) {
          this.splatField?.addSpec({ t: u.t, rows: 1, cols: 1, s: u.s, b: u.b,
                                     uv: [0, 0, 0, 0],
                                     life: (u.birth || 0) + (u.hold || 0),
                                     decay: u.decay || 2,
                                     c: [[255, 255, 255, 255], [255, 255, 255, 255],
                                         [255, 255, 255, 0]] }, wx, wy);
        }
        break;
      }
      case 'SPN': {
        const path = this.spawnTable?.[e.d.id];
        if (path) this.spawnEffect({ fx: 'spn' + (this.spawnSeq = (this.spawnSeq || 0) + 1),
                                     path, x: wx, y: wy, ttl: 4 }, false);
        break;
      }
      case 'SND': {
        // The build resolves the id the whole way -- through AnimLookups to a
        // label, through AnimSounds to files and the numbers that place them --
        // so there is nothing to look up here. An id the game ships no sound
        // for is simply absent from the table and falls silent.
        const snd = this.animSounds?.[e.d.id];
        if (snd && this.onAnimSound) this.onAnimSound(snd, wx, wy);
        break;
      }
    }
  }

  /**
   * A bolt of lightning between two points.
   *
   * The far end may be a unit rather than a fixed spot, in which case the strip
   * follows it -- a drain holds on its target while both move. Chest height is
   * the anchor at each end: a beam drawn between two units' feet reads as a
   * cable lying on the floor.
   */
  spawnBolt(ev) {
    const spec = this.boltTable?.[ev.code];
    if (!spec || !spec.t) return;
    const tex = this.fxTexture(spec.t);
    if (!tex) return;
    const b = new Bolt(spec, tex, this.scene);
    b.from = { x: ev.x1, y: ev.y1 };
    b.toId = ev.id2;
    b.to = { x: ev.x2, y: ev.y2 };
    this.bolts.push(b);
  }

  /** Where a bolt's end sits this frame: on its unit if it has one. */
  boltEnd(pt, id) {
    const v = id != null ? this.views.get(id) : null;
    const p = v ? v.root.position : null;
    const x = p ? p.x : toX(pt.x);
    const z = p ? p.z : toZ(pt.y);
    const y = (p ? p.y : this.heightAt(pt.x, pt.y)) + 70;   // roughly chest high
    return new THREE.Vector3(x, y, z);
  }

  stepBolts(dt) {
    for (let i = this.bolts.length - 1; i >= 0; i--) {
      const b = this.bolts[i];
      const a = this.boltEnd(b.from, b.fromId);
      const c = this.boltEnd(b.to, b.toId);
      if (!b.step(dt, a, c, this.camera)) {
        b.dispose();
        this.bolts.splice(i, 1);
      }
    }
  }

  /** One texture per path, shared by every effect that names it. */
  fxTexture(uri) {
    let t = this.fxTextures.get(uri);
    if (!t) {
      t = new THREE.TextureLoader().load('/assets/' + uri);
      t.colorSpace = THREE.SRGBColorSpace;
      this.fxTextures.set(uri, t);
    }
    return t;
  }

  /** Trails dragged behind a bone; the same shared-texture rule as emitters. */
  attachRibbons(obj) {
    return buildRibbons(obj, (uri) => {
      let t = this.fxTextures.get(uri);
      if (!t) {
        t = new THREE.TextureLoader().load('/assets/' + uri);
        t.colorSpace = THREE.SRGBColorSpace;
        this.fxTextures.set(uri, t);
      }
      return t;
    });
  }

  attachEmitters(obj) {
    return buildEmitters(obj, (uri) => {
      let t = this.fxTextures.get(uri);
      if (!t) {
        t = new THREE.TextureLoader().load('/assets/' + uri);
        t.colorSpace = THREE.SRGBColorSpace;
        this.fxTextures.set(uri, t);
      }
      return t;
    });
  }

  async spawnEffect(ev, onUnit) {
    if (this.effects.has(ev.fx)) return;
    const name = await this.resolveModel(ev.path);
    if (!name) return;
    let rec;
    try { rec = await this.loadModel(name); } catch { return; }
    if (this.effects.has(ev.fx)) return;            // destroyed while loading
    const obj = cloneModel(rec.gltf.scene);
    let parent = this.scene;
    if (onUnit) {
      const v = this.views.get(ev.id);
      if (!v) return;
      // hang it off the named attach point if the model has one; the root is
      // the fallback, and the map's "origine" typo is meant to find nothing
      parent = this.attachNode(v.obj, ev.attach) || v.root;
    } else {
      obj.position.set(toX(ev.x), this.heightAt(ev.x, ev.y), toZ(ev.y));
    }
    parent.add(obj);
    const fx = { obj, parent, mixer: null };
    if (rec.gltf.animations.length) {
      fx.mixer = new THREE.AnimationMixer(obj);
      const pick = (n) => rec.gltf.animations.find((a) => a.name.toLowerCase().startsWith(n));
      const birth = pick('birth'), stand = pick('stand');
      const clip = birth || stand || rec.gltf.animations[0];
      const act = fx.mixer.clipAction(clip);
      act.setLoop(birth ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
      act.clampWhenFinished = true;
      act.play();
      fx.currentAction = act;
      fx.current = clip.name.toLowerCase();
      fx.seqIndex = this.seqIndexOf(rec.meta, clip.name);
      // Warcraft III effects play Birth once, then settle into Stand.
      if (birth && stand) {
        fx.mixer.addEventListener('finished', () => {
          fx.currentAction = fx.mixer.clipAction(stand).reset().play();
          fx.current = stand.name.toLowerCase();
          fx.seqIndex = this.seqIndexOf(rec.meta, stand.name);
          this.applyGeosetVisibility(fx, fx.current);
        });
      } else if (birth) {
        // ...but a model with *only* a Birth has nothing to settle into, and the
        // effect is over when the animation is. Clamping the last frame instead
        // leaves the thing standing on the battlefield for the rest of the game:
        // Byakuya's Flash Step and Senka both play MirrorImageCaster, whose one
        // and only sequence is Birth, and it is a transparent orc.
        fx.mixer.addEventListener('finished', () => this.endEffect(ev.fx));
      }
    }
    fx.meta = rec.meta;
    fx.prims = this.applyMaterials(obj, rec.meta, fx);
    fx.texAnims = buildTexAnims(fx.prims, rec.meta);
    fx.bornAt = performance.now() / 1000;
    // and the same per-sequence geoset switching units get: an effect model's
    // sequences hide and show parts of it just as a unit's do
    if (fx.current) this.applyGeosetVisibility(fx, fx.current);
    this.armGeosetClock(fx, rec.meta);
    fx.emitters = this.attachEmitters(obj);
    fx.ribbons = this.attachRibbons(obj);
    fx.lights = this.attachLights(obj, fx);
    this.attachSprays(obj, fx);
    this.effects.set(ev.fx, fx);
    // The art an ability carries is one-shot: Warcraft III plays it and drops
    // it, with no DestroyEffect to match. A script's AddSpecialEffect has no
    // ttl and still lives until the script says otherwise.
    if (ev.ttl > 0) fx.expire = setTimeout(() => this.endEffect(ev.fx), ev.ttl);
    // a script that forgets DestroyEffect must not grow the scene without bound
    if (this.effects.size > 400) this.endEffect(this.effects.keys().next().value);
  }

  /**
   * A shot in flight.
   *
   * The server owns the outcome -- it decides when the missile lands and who it
   * damages -- so this only has to draw the thing travelling. It homes on the
   * target the way Warcraft III's do, and `Missilearc` bows the path upward by
   * that fraction of the distance covered.
   */
  async spawnMissile(ev) {
    if (this.missiles.has(ev.fx)) return;
    const name = await this.resolveModel(ev.path);
    if (!name) return;
    let rec;
    try { rec = await this.loadModel(name); } catch { return; }
    if (this.missiles.has(ev.fx)) return;          // it landed while loading
    const obj = cloneModel(rec.gltf.scene);
    const z0 = this.heightAt(ev.x, ev.y) + 40;
    obj.position.set(toX(ev.x), z0, toZ(ev.y));
    this.scene.add(obj);
    const m = { obj, x: ev.x, y: ev.y, z0, tx: ev.tx, ty: ev.ty, id: ev.id,
                speed: Math.max(1, ev.speed || 900), arc: ev.arc || 0,
                travelled: 0, total: Math.max(1, Math.hypot(ev.tx - ev.x, ev.ty - ev.y)) };
    if (rec.gltf.animations.length) {
      m.mixer = new THREE.AnimationMixer(obj);
      const clip = rec.gltf.animations[0];
      m.currentAction = m.mixer.clipAction(clip).play();
      m.current = clip.name.toLowerCase();
      m.seqIndex = this.seqIndexOf(rec.meta, clip.name);
    }
    m.meta = rec.meta;
    m.prims = this.applyMaterials(obj, rec.meta, m);
    m.texAnims = buildTexAnims(m.prims, rec.meta);
    m.bornAt = performance.now() / 1000;
    if (m.current) this.applyGeosetVisibility(m, m.current);
    this.armGeosetClock(m, rec.meta);
    m.emitters = this.attachEmitters(obj);
    m.ribbons = this.attachRibbons(obj);
    m.lights = this.attachLights(obj, m);
    this.missiles.set(ev.fx, m);
  }

  endMissile(fx) {
    const m = this.missiles.get(fx);
    this.missiles.delete(fx);
    if (!m) return;
    m.mixer?.stopAllAction();
    this.lightPool.release(m);         // hand the pool slot back
    this.scene.remove(m.obj);
    this.releaseGPU(m);
  }

  stepMissiles(dt) {
    const now = performance.now() / 1000;
    for (const [fx, m] of this.missiles) {
      m.mixer?.update(dt);
      const ctx = this.animCtxOf(m);
      for (const e of (m.emitters || [])) e.update(dt, ctx);
      for (const r of (m.ribbons || [])) r.update(dt, ctx);
      stepLights(m.lights || [], ctx);
      if (m.texAnims?.length) stepTexAnims(m.texAnims, ctx, now - (m.bornAt || now));
      // follow the target while it lives, else keep to the point it was aimed at
      const v = m.id != null ? this.views.get(m.id) : null;
      const tx = v ? v.root.position.x : toX(m.tx);
      const tz = v ? v.root.position.z : toZ(m.ty);
      const px = toX(m.x), pz = toZ(m.y);
      const dx = tx - px, dz = tz - pz;
      const dist = Math.hypot(dx, dz);
      const move = m.speed * dt;
      if (dist <= move) { this.endMissile(fx); continue; }
      const nx = px + (dx / dist) * move, nz = pz + (dz / dist) * move;
      m.x = nx; m.y = -nz;
      m.travelled = Math.min(m.total, m.travelled + move);
      const k = m.total > 0 ? m.travelled / m.total : 1;
      const lift = m.arc > 0 ? m.arc * m.total * 4 * k * (1 - k) : 0;
      const ground = this.heightAt(m.x, m.y) + 40;
      m.obj.position.set(nx, ground + lift, nz);
      // The pipeline's model-forward is +X at yaw 0 -- unit facing is written
      // straight into rotation.y and Warcraft III's facing 0 is east -- so a
      // travel direction in (x, z) turns by atan2(-dz, dx). atan2(dx, dz) is
      // the same angle a quarter turn out, which is why every arrow and spear
      // in the game flew sideways.
      m.obj.rotation.y = Math.atan2(-dz, dx);
    }
  }

  /** DestroyEffect. */
  endEffect(fx) {
    const e = this.effects.get(fx);
    this.effects.delete(fx);
    if (!e) return;
    if (e.expire) clearTimeout(e.expire);
    e.mixer?.stopAllAction();
    this.lightPool.release(e);
    e.parent?.remove(e.obj);
    this.releaseGPU(e);
  }

  /**
   * SetUnitAnimation: the script names sequences loosely ("attack", "spell
   * slam"), so fall back to a prefix match the way the game does.
   */
  /**
   * Animation speed, as SetUnitTimeScale sets it: 1 is the authored rate, 0
   * freezes the unit where it stands. Kept per id rather than on the view,
   * because a metamorphosis throws the view away and builds another, and a
   * hasted hero that morphs is still hasted.
   */
  setUnitTimeScale(id, s) {
    const scale = Math.max(0, +s || 0);
    (this.timeScales || (this.timeScales = new Map())).set(id, scale);
    const v = this.views.get(id);
    if (v && v.mixer) v.mixer.timeScale = scale;
  }

  playUnitAnim(id, name) {
    const v = this.views.get(id);
    if (!v || !v.mixer || !v.actions.size) return;
    const want = String(name || '').toLowerCase().trim();
    if (!want) return;
    let clip = v.actions.has(want) ? want : null;
    if (!clip) {
      for (const k of v.actions.keys()) {
        if (k === want || k.startsWith(want + ' ') || k.startsWith(want)) { clip = k; break; }
      }
    }
    if (!clip) return;
    this.playClip(v, clip, !/^(stand|walk)/.test(clip));
  }

  /** QueueUnitAnimation: what plays when the current one-shot ends. */
  queueUnitAnim(id, name) {
    const v = this.views.get(id);
    if (v) v.queuedAnim = String(name || '') || null;
  }

  /** SetUnitAnimationByIndex. */
  playUnitAnimIndex(id, i) {
    const v = this.views.get(id);
    if (!v || !v.actions.size) return;
    const names = [...v.actions.keys()];
    const clip = names[i];
    if (clip) this.playClip(v, clip, true);
  }

  playClip(view, clip, once) {
    const act = view.actions.get(clip);
    if (!act || view.current === clip) return;
    if (view.currentAction) view.currentAction.fadeOut(0.12);
    act.reset();
    act.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
    act.clampWhenFinished = once;
    act.fadeIn(0.12).play();
    view.current = clip;
    view.currentAction = act;
    view.scripted = true;                 // the 'finished' listener returns it to stand
    // The map drives 53 animations by name -- "attack", "birth", "spell",
    // "death". Without this the clip changes but the emitters stay scoped to
    // whatever sequence was playing before, so a script-triggered death plays
    // the standing unit's emitters and none of its own.
    view.seqIndex = this.seqIndexOf(view.meta, clip);
    this.applyGeosetVisibility(view, clip);
  }

  /**
   * SetUnitVertexColor -- 21 calls in this map, and every one of them was
   * tinting the wrong units.
   *
   * A view draws with the model cache's materials, which every other unit of
   * the type draws with too: ghosting one summon to 50% used to ghost all of
   * them, and because the mutated material stays in the cache, every unit of
   * that type spawned afterwards arrived pre-ghosted. The first tint takes the
   * view its own copies.
   *
   * The colour modulates the material's rather than replacing it, which is
   * what a vertex colour does, and the alpha modulates the authored opacity --
   * an additive glow written at 0.5 must not be forced to 1 by a tint that
   * only asked for full alpha.
   */
  /**
   * SetTerrainFogEx's own fog: style, near and far plane, density and colour.
   *
   * Style 0 is Warcraft III's linear fog, which is three.js's Fog; the
   * exponential styles map to FogExp2, where the density field is the one that
   * matters and the two distances do not. This map asks for style 0, black,
   * 3000 to 5000, and the renderer had been drawing 0x0b1018 from 4200 to 9000
   * because nothing told it otherwise.
   */
  /**
   * The day/night light, from the model SetDayNightModels named.
   *
   * `curves` is data/daynight.json: KLAC as the sun's colour and KLBC as the
   * ambient, keyed by hour across the model's own sequence, with the light's
   * own intensities beside them. Only the colours move -- the light's rotation
   * is one static key in the model and the axis convention that would turn it
   * into a world direction is not stated there, so the sun keeps the position
   * it already had.
   */
  setDayNight(curves, ev) {
    this.dncCurves = curves || this.dncCurves;
    if (ev) {
      this.dncTerrain = ev.terrain || this.dncTerrain;
      this.dncUnit = ev.unit || this.dncUnit;
      if (ev.hour != null) this.dncHour = ev.hour;
    }
    this.applyDayNight();
  }
  setTimeOfDay(hour) { this.dncHour = hour; this.applyDayNight(); }
  applyDayNight() {
    const c = this.dncCurves && this.dncCurves[this.dncTerrain];
    if (!c || !this.sun) return;
    const at = (keys) => {
      if (!keys || !keys.length) return null;
      const h = Math.max(0, Math.min(24, this.dncHour ?? 12));
      let a = keys[0], b = keys[keys.length - 1];
      for (let i = 0; i < keys.length - 1; i++) {
        if (h >= keys[i][0] && h <= keys[i + 1][0]) { a = keys[i]; b = keys[i + 1]; break; }
      }
      const span = b[0] - a[0];
      const k = span > 0 ? (h - a[0]) / span : 0;
      return [a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k, a[3] + (b[3] - a[3]) * k];
    };
    const sunCol = at(c.color);
    if (sunCol) { this.sun.color.setRGB(sunCol[0], sunCol[1], sunCol[2]); this.sun.intensity = c.intensity ?? 1.3; }
    // the unit model carries its own ambient strength; the terrain one lights
    // the ground, and the hemisphere here stands in for both
    const amb = at(c.ambient);
    if (amb && this.hemi) {
      this.hemi.color.setRGB(amb[0], amb[1], amb[2]);
      const uc = this.dncCurves[this.dncUnit];
      this.hemi.intensity = (c.ambIntensity ?? 0.2) + ((uc && uc.ambIntensity) || 0);
      this.hemi.groundColor.setRGB(amb[0] * 0.35, amb[1] * 0.35, amb[2] * 0.3);
    }
  }

  setFog(o) {
    if (!o || o.reset) {
      this.scene.fog = new THREE.Fog(0x0b1018, 4200, 9000);
      return;
    }
    const [r, g, b] = o.color || [0, 0, 0];
    const col = (r << 16) | (g << 8) | b;
    if (o.style > 0 && o.density > 0) this.scene.fog = new THREE.FogExp2(col, o.density / 1000);
    else this.scene.fog = new THREE.Fog(col, o.start || 0, Math.max((o.start || 0) + 1, o.end || 1));
  }

  tintUnit(id, r, g, b, a) {
    const v = this.views.get(id);
    if (!v) return;
    this.ownPrimMaterials(v);
    v.tintColor = new THREE.Color((r ?? 255) / 255, (g ?? 255) / 255, (b ?? 255) / 255);
    v.tintA = (a ?? 255) / 255;
    // through applyMeshAlpha rather than straight onto the material, so a
    // geoset animation part-way through a fade is multiplied, not overwritten
    for (const mesh of v.prims) this.applyMeshAlpha(v, mesh);
  }

  /**
   * Give a view its own copy of every material it draws with, remembering what
   * the model authored so a later tint modulates that rather than an already
   * tinted value.
   */
  ownPrimMaterials(view) {
    if (view.ownsMats) return;                 // idempotent: both callers may ask
    view.ownsMats = true;
    for (const mesh of view.prims) {
      const copies = matsOf(mesh).map((mm) => {
        const c = own(view, mm.clone());
        c.userData = Object.assign({}, c.userData, {
          __base: { color: c.color ? c.color.clone() : null,
                    opacity: c.opacity, transparent: c.transparent },
        });
        return c;
      });
      mesh.material = copies.length === 1 ? copies[0] : copies;
    }
  }

  /**
   * The models a unit's buffs hang on it, kept in step with the buffs it has.
   *
   * Warcraft III draws a buff's Target Attachment for as long as the buff is
   * on the unit -- Ichigo's Hollow form is DeathCoilMissile at "head", and this
   * map stamps that buff on him by casting Frost Armor off a dummy purely to
   * name it. `ftat` is a model *list*, one per attachment point, which is how
   * Thorny Shield hangs four shields and Bloodlust two.
   *
   * Reuses the same path AddSpecialEffectTarget takes, so a buff model gets its
   * emitters, ribbons and texture animation like any other effect.
   */
  syncBuffArt(id, codes, table) {
    const v = this.views.get(id);
    if (!v) return;
    const want = new Set(codes || []);
    const held = v.buffFx || (v.buffFx = new Map());
    for (const [code, ids] of [...held]) {
      if (want.has(code)) continue;
      for (const fx of ids) this.endEffect(fx);
      held.delete(code);
    }
    for (const code of want) {
      if (held.has(code)) continue;
      const rec = table && table[code];
      if (!rec || !rec.target || !rec.target.length) continue;
      const points = rec.points || [];
      const ids = [];
      rec.target.forEach((path, n) => {
        const fx = `buff:${id}:${code}:${n}`;
        ids.push(fx);
        // no point named is the unit's origin, which is where the game puts it
        this.spawnEffect({ fx, path, id, attach: points[n] || points[0] || 'origin' }, true);
      });
      held.set(code, ids);
    }
  }

  removeView(id) {
    const v = this.views.get(id);
    if (!v) return;
    // buff art hangs off a bone rather than the root, so the sweep below cannot
    // see it; it has to be named
    for (const ids of (v.buffFx || new Map()).values())
      for (const fx of ids) this.endEffect(fx);
    v.buffFx = null;
    for (const [fx, e] of this.effects) if (e.parent === v.root) this.endEffect(fx);
    this.lightPool.release(v);
    this.scene.remove(v.root);
    v.mixer?.stopAllAction();
    this.releaseGPU(v);
    this.views.delete(id);
  }

  /**
   * Hand back what a view, effect or missile built for itself.
   *
   * Nothing here touches the model cache: the mesh and its materials are
   * borrowed and other units are still drawing with them. What is freed is the
   * copies -- team colour, texture animation, tint, and the ground quads --
   * plus the emitters, ribbons and sprays, which own buffers of their own.
   * Without this renderer.info.memory climbs for the whole match; the `
   * readout is where to watch it flatten.
   */
  releaseGPU(holder) {
    // The skeleton's bone texture is the renderer's own upload -- a DataTexture
    // three.js makes the first time it draws the skinned mesh -- and nothing
    // owned it here, so it outlived the unit. That was the "9 per unit, never
    // released" texture growth: one skeleton per skinned geoset (see
    // cloneModel), one bone texture each, none disposed. Distinct skeletons
    // only; the geosets share one now.
    const skeletons = new Set();
    holder.obj?.traverse((m) => { if (m.isSkinnedMesh) skeletons.add(m.skeleton); });
    for (const sk of skeletons) sk.dispose();
    for (const e of (holder.emitters || [])) e.dispose();
    for (const r of (holder.ribbons || [])) r.dispose();
    for (const sp of (holder.sprays || [])) sp.dispose();
    disposeTexAnims(holder.texAnims);
    holder.emitters = holder.ribbons = holder.sprays = holder.texAnims = null;
    disposeOwned(holder);
  }

  // ---------------------------------------------------------------- camera
  focus(x, y, snap = false) {
    const t = new THREE.Vector3(toX(x), this.heightAt(x, y), toZ(y));
    if (snap) this.camTarget.copy(t);
    else this.camTarget.lerp(t, 0.14);
  }
  panBy(dx, dz) {
    // taking the camera by hand ends whatever the script was doing with it,
    // the way dragging in Warcraft III does
    this.scriptPan = null;
    this.camTarget.x += dx; this.camTarget.z += dz;
  }

  /**
   * A scripted camera move: PanCameraToTimed, straight over `dur` seconds.
   *
   * Linear, because that is the whole of what the native says -- go here, take
   * this long. Nothing in MiscData.txt or the map states a curve, and the
   * [CameraRates] block is about the player's own camera rather than a pan.
   */
  panTo(wx, wy, dur) {
    const to = new THREE.Vector3(toX(wx), this.heightAt(wx, wy), toZ(wy));
    if (!(dur > 0)) { this.camTarget.copy(to); this.scriptPan = null; return; }
    this.scriptPan = { from: this.camTarget.clone(), to, t: 0, dur };
  }

  /** Advance a scripted pan. True while one owns the camera. */
  stepPan(dt) {
    const p = this.scriptPan;
    if (!p) return false;
    p.t += dt;
    const k = Math.min(1, p.t / p.dur);
    this.camTarget.lerpVectors(p.from, p.to, k);
    if (k >= 1) this.scriptPan = null;
    return true;
  }
  /** Minimap outline on the camera focus plane; avoids terrain mesh raycasts. */
  cameraFootprint() {
    const ray = new THREE.Raycaster(), plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -this.camTarget.y);
    const points = [], bottom = -1 + 2 * this.consoleFrac;
    for (const [x, y] of [[-1,1],[1,1],[1,bottom],[-1,bottom]]) {
      ray.setFromCamera(new THREE.Vector2(x,y),this.camera);
      const point=ray.ray.intersectPlane(plane,new THREE.Vector3());
      if (!point) return [];
      points.push({x:point.x,y:-point.z});
    }
    return points;
  }

  clampCam(b) {
    if (!b) return;
    this.camTarget.x = Math.max(b.minX, Math.min(b.maxX, this.camTarget.x));
    this.camTarget.z = Math.max(-b.maxY, Math.min(-b.minY, this.camTarget.z));
  }
  /**
   * Camera shake, as CameraSetTargetNoise asks for it.
   *
   * `mag` is how far the camera is thrown, `vel` how fast it rattles. A shake
   * runs until the map cancels it with a magnitude of zero, so this holds the
   * request rather than decaying on its own -- the script decides when it stops,
   * and this map calls for one 91 times.
   */
  setShake(mag, vel, vert) {
    this.shake = mag > 0 ? { mag, vel: Math.max(0.1, vel || 1), vert: !!vert, t: 0 } : null;
  }

  updateCamera(dt = 0) {
    const d = this.camDist;
    const cp = Math.cos(this.camPitch), sp = Math.sin(this.camPitch);
    let ox = 0, oy = 0, oz = 0;
    const sh = this.shake;
    if (sh) {
      sh.t += dt;
      // two incommensurate frequencies per axis, so the rattle does not read as
      // a clean sine wave the eye can follow
      const w = sh.t * sh.vel;
      oy = Math.sin(w * 6.3) * sh.mag;
      if (!sh.vert) {
        ox = Math.sin(w * 4.7 + 1.3) * sh.mag;
        oz = Math.sin(w * 5.9 + 2.1) * sh.mag;
      }
    }
    this.camera.position.set(
      this.camTarget.x + Math.sin(this.camYaw) * cp * d + ox,
      this.camTarget.y + sp * d + oy,
      this.camTarget.z + Math.cos(this.camYaw) * cp * d + oz);
    this.camera.lookAt(this.camTarget);
  }

  /**
   * Items lying in the world.
   *
   * The server has always known about these; they simply were not on the wire,
   * so a dropped item existed at the right coordinates and nothing drew it. They
   * are not units -- no health, no team, no animation to speak of -- so they get
   * a much lighter view than spawnView builds, and they bob so a small model on
   * busy ground is still findable.
   */
  async syncItems(list, defs) {
    const seen = new Set();
    for (const e of (list || [])) {
      seen.add(e.i);
      let g = this.groundItems.get(e.i);
      if (!g) {
        g = { id: e.i, x: e.x, y: e.y, type: e.u, name: e.n, root: new THREE.Group(), loading: true };
        this.groundItems.set(e.i, g);
        this.scene.add(g.root);
        const def = defs && defs[e.u];
        const name = def && def.m ? await this.resolveModel(def.m) : null;
        // an item whose model did not convert still has to be clickable, so it
        // falls back to a marker rather than to nothing
        if (name) {
          try {
            const rec = await this.loadModel(name);
            const obj = cloneModel(rec.gltf.scene);
            g.root.add(obj);
            if (rec.gltf.animations.length) {
              g.mixer = new THREE.AnimationMixer(obj);
              const clip = rec.gltf.animations[0];
              g.currentAction = g.mixer.clipAction(clip).play();
              g.seqIndex = this.seqIndexOf(rec.meta, clip.name);
            }
          } catch { /* fall through to the marker */ }
        }
        if (!g.root.children.length) {
          const mesh = new THREE.Mesh(new THREE.OctahedronGeometry(26),
            new THREE.MeshLambertMaterial({ color: 0xd8b45a, emissive: 0x3a2f12 }));
          g.root.add(mesh);
        }
        g.loading = false;
      }
      g.x = e.x; g.y = e.y; g.name = e.n;
      g.root.position.set(toX(e.x), this.heightAt(e.x, e.y), toZ(e.y));
    }
    for (const [id, g] of [...this.groundItems]) {
      if (seen.has(id)) continue;
      g.mixer?.stopAllAction();
      this.scene.remove(g.root);
      this.groundItems.delete(id);
    }
  }

  stepItems(dt) {
    this.itemBob = (this.itemBob || 0) + dt;
    for (const g of this.groundItems.values()) {
      g.mixer?.update(dt);
      g.root.position.y = this.heightAt(g.x, g.y) + 10 + Math.sin(this.itemBob * 2 + g.id) * 5;
      g.root.rotation.y += dt * 0.9;
    }
  }

  /** The item under a screen position, if the click is close enough to one. */
  pickItem(nx, ny) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    let best = null, bd = Infinity;
    for (const g of this.groundItems.values()) {
      const c = new THREE.Sphere(g.root.position.clone().setY(g.root.position.y + 20), 55);
      const p = new THREE.Vector3();
      if (ray.ray.intersectSphere(c, p)) {
        const d = ray.ray.origin.distanceTo(p);
        if (d < bd) { bd = d; best = g; }
      }
    }
    return best;
  }

  /** Ground point under a screen position. */
  pickGround(nx, ny) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    // cliff faces are their own mesh, and the ground has a hole under each one,
    // so a click on a cliff would otherwise fall through to the y=0 plane
    const targets = [];
    if (this.terrain) targets.push(this.terrain);
    if (this.cliffs) targets.push(this.cliffs);
    if (targets.length) {
      const hit = ray.intersectObjects(targets, true);
      if (hit.length) return { x: hit[0].point.x, y: -hit[0].point.z };
    }
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const p = new THREE.Vector3();
    if (ray.ray.intersectPlane(plane, p)) return { x: p.x, y: -p.z };
    return null;
  }

  pickEntity(nx, ny) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(nx, ny), this.camera);
    let best = null, bd = Infinity;
    for (const v of this.views.values()) {
      // A Locust dummy is the unit the map casts its spells through and has no
      // mesh at all; a view still loading has none yet. Neither is on screen,
      // so neither may take a click meant for the unit behind it.
      if (!v.root.visible || v.locust || v.loading) continue;
      const c = new THREE.Sphere(v.root.position.clone().setY(v.root.position.y + 70), 90);
      const p = new THREE.Vector3();
      if (ray.ray.intersectSphere(c, p)) {
        const d = ray.ray.origin.distanceTo(p);
        if (d < bd) { bd = d; best = v; }
      }
    }
    return best;
  }

  render() {
    const dt = this.clock.getDelta();
    // texture animations bound to a global sequence keep their own time,
    // independent of any clip, so they need a wall clock to loop against
    const now = performance.now() / 1000;
    // A frame that is slow says nothing about which part of it is, and this
    // renderer has four parts that all grow with what is on screen. Kept always
    // on: it is four clock reads a frame, and the alternative is guessing.
    const perf = this.perf || (this.perf = { views: 0, fx: 0, gl: 0, rest: 0 });
    const mark = performance.now();
    // Two switches for finding out where a slow frame goes on a real machine,
    // which a headless profile cannot: software WebGL buries rasterising in the
    // buffer swap, so the split between "too many draw calls" and "too much
    // skinning" is only visible where there is a real GPU. Freezing animation
    // leaves the same draw calls with none of the per-frame skeleton work;
    // hiding the units leaves the terrain and doodads with neither.
    if (this.noUnits) {
      for (const v of this.views.values()) v.root.visible = false;
    } else {
    // Only animate -- and only draw -- what the camera can see.
    //
    // Warcraft III's own answer to a busy field: a unit off screen has nothing
    // to show, so stepping its mixer, its emitters and its texture animations
    // is work thrown away, and so is skinning and drawing it. The second half
    // is the one that used to cost the frame: every geoset is loaded with
    // frustumCulled off, and in three.js the skeleton update and its bone
    // texture upload live inside that very test (WebGLRenderer.projectObject
    // -> objects.update -> skeleton.update), so every skinned unit in the match
    // was re-skinned, uploaded and drawn every frame whether or not it was
    // anywhere near the screen. A subtree whose `visible` is false is skipped
    // before any of that, so hiding the model object is what takes the
    // off-screen work away; the geosets keep frustumCulled off on purpose,
    // because their bind-pose bounds say nothing about where an animation
    // reaches.
    //
    // The test is done once per frame against the camera's frustum rather than
    // per mesh, around the view's root, with the model's own extents for its
    // radius: the MDX carries a bounding box per sequence, which is what the
    // game itself culls with, and the union of them all is the farthest any
    // animation can reach from the unit's feet. A model with no extents keeps
    // the old generous constant.
    this._frustum.setFromProjectionMatrix(this._fmat.multiplyMatrices(
      this.camera.projectionMatrix, this.camera.matrixWorldInverse));
    for (const v of this.views.values()) {
      this._sph.center.copy(v.root.position);
      if (v.bounds) {
        const k = v.obj?.scale.x || 1;
        this._sph.center.y += v.bounds.up * k; this._sph.radius = v.bounds.r * k;
      } else { this._sph.center.y += 80; this._sph.radius = 220; }
      const off = !this._frustum.intersectsSphere(this._sph);
      v.offscreen = off;
      // compared against the object rather than a flag, so a model rebuilt by
      // a metamorphosis (visible by default) is settled on its first frame
      if (v.obj && v.obj.visible === off) {
        v.obj.visible = !off;
        if (v.shadow) v.shadow.visible = !off;
        if (v.splat) v.splat.visible = !off;
      }
      // frozen is the diagnostic that keeps the draw calls and drops only the
      // animation, so it culls the same and skips just the stepping
      if (off || this.frozen) continue;
      v.mixer?.update(dt);
      const ctx = this.animCtxOf(v);
      for (const p of (v.emitters || [])) p.update(dt, ctx);
      for (const r of (v.ribbons || [])) r.update(dt, ctx);
      stepLights(v.lights || [], ctx);
      // Sprays used to be gated on a guess -- 'is this unit dying?' -- because
      // nothing carried the emitter's own switch across. Now it does.
      for (const sp of (v.sprays || [])) sp.update(dt, ctx);
      if (v.events?.length) stepEvents(v.events, ctx, (e) => this.fireEvent(e));
      if (v.texAnims?.length) stepTexAnims(v.texAnims, ctx, now - v.bornAt);
      if (v.alphaCurve || v.matCurve) this.tickGeosetCurves(v, dt);
    }
    }
    // the handful of destructables that can be struck; everything else in the
    // doodad group has no mixer at all
    if (this.doodadAt) for (const e of this.doodadAt.values()) {
      e.mixer?.update(dt);
      if (e.deathCurve) this.tickDoodadCurves(e, dt);
    }
    this.tickTerrain(dt);
    const tViews = performance.now();
    for (const e of this.effects.values()) {
      e.mixer?.update(dt);
      const ctx = this.animCtxOf(e);
      for (const p of (e.emitters || [])) p.update(dt, ctx);
      for (const r of (e.ribbons || [])) r.update(dt, ctx);
      stepLights(e.lights || [], ctx);
      for (const sp of (e.sprays || [])) sp.update(dt, ctx);
      if (e.texAnims?.length) stepTexAnims(e.texAnims, ctx, now - (e.bornAt || now));
      if (e.alphaCurve || e.matCurve) this.tickGeosetCurves(e, dt);
    }
    const tFx = performance.now();
    this.splatField?.update(dt);
    this.stepBolts(dt);
    this.stepMissiles(dt);
    this.stepItems(dt);
    this.tickWater(dt);
    this.updateCamera(dt);
    const tRest = performance.now();
    this.renderer.render(this.scene, this.camera);
    const tGl = performance.now();
    // smoothed, so the readout is legible rather than flickering
    const k = 0.1;
    perf.views += (tViews - mark - perf.views) * k;
    perf.fx += (tFx - tViews - perf.fx) * k;
    perf.rest += (tRest - tFx - perf.rest) * k;
    perf.gl += (tGl - tRest - perf.gl) * k;
    return dt;
  }
}
