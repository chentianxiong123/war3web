// The flat layer between the world and the interface: health bars over units.
//
// Warcraft III draws these in world space but as plain rectangles, not
// geometry, and a canvas is the honest way to do the same. The alternative -- a
// DOM node per unit -- means projecting and restyling a hundred elements every
// frame for something that is four fillRects.
//
// What is shown follows the game rather than a MOBA: a bar over the unit you
// are hovering, over your own hero, and over everything while ALT is held.
// Warcraft III shows exactly those three.
const BAR_W = 42;                  // pixels at the reference camera distance
const BAR_H = 5;
const GAP = 1;                     // between the health bar and the mana bar

// Green while healthy, amber as it falls, red when it is nearly gone. The
// thresholds are Warcraft III's familiar ones; the game draws these itself
// rather than shipping art for them, so there is no file to read them from.
function healthColor(frac) {
  if (frac > 0.6) return '#39c839';
  if (frac > 0.3) return '#e0c020';
  return '#d03030';
}

// A text tag's height and velocity are plain fractions of the viewport.
//
// This is the one figure in floating text that is not read from a file, and it
// was wrong once. The FDF layouts are authored in Warcraft III's 0.8 x 0.6
// screen box (tools/fdf.py), so the first reading divided through by 0.6 the
// way tools/uiframe.py does for the console pieces. That makes a default tag
// 3.8% of screen height and the map's size-14 lane signs 5.4%, and on screen
// they dwarfed the game -- reported from play, which is the only instrument
// there is for this.
//
// Read as a plain fraction instead, Blizzard.j's TextTagSize2Height puts the
// default size of 10 at 2.3% of screen height, which is what Warcraft III's
// floating combat text measures. Two things say the comparison is fair: the
// camera here shows the same slice of world as the game's own default (2315
// units against 1650-at-70-degrees' 2311, within 0.2%), so a tag is directly
// comparable, and every one of the map's own sizes then lands in a sane band --
// 2.3% for combat text, 3.2% for a lane sign, 4.6% for a base marker.
//
// What is still unsettled is why the two spaces differ, since both are called a
// height. Nothing in the map or the MPQs says outright. If a retail screenshot
// ever contradicts this, here is the constant.
/**
 * Warcraft III's inline colour codes: `|cAARRGGBB` opens a run and `|r` closes
 * it. Splitting rather than stripping, because for two of the map's own tags
 * the colour *is* the label -- the base markers read "|c00ff0000RED|r TEAM" and
 * "|c000000ffBLUE|r TEAM", and stripped they are two identical white words.
 *
 * The leading AA is ignored. The map writes 00 there for text it plainly means
 * to be seen, so reading it as an alpha would erase exactly the labels this
 * exists to colour; the tag's own SetTextTagColor alpha is the one that counts.
 */
function colourRuns(s, base) {
  const runs = [];
  const re = /\|c([0-9a-fA-F]{8})|\|r/g;
  let at = 0, colour = base, m;
  while ((m = re.exec(s))) {
    if (m.index > at) runs.push({ text: s.slice(at, m.index), colour });
    colour = m[1] ? `#${m[1].slice(2)}` : base;
    at = re.lastIndex;
  }
  if (at < s.length) runs.push({ text: s.slice(at), colour });
  return runs;
}

/**
 * Floating text: the map's 48 tags, and nothing else.
 *
 * The server sends a tag once, finished, and the client runs the whole of its
 * life from there. Motion and fade are both functions of age alone, so
 * streaming them would spend a message a frame restating what one message
 * already determines.
 *
 * These are drawn on the canvas rather than in the scene for the same reason
 * the health bars are: Warcraft III draws them in world space but as flat text,
 * always facing the camera and always the same size on screen.
 */
class TextTags {
  constructor() {
    this.tags = new Map();
    this.last = performance.now();
    // A multiplier on every tag's height. The height is the one figure in
    // floating text that no file in the game carries: war3skins.txt names the
    // face and MiscData.txt the colours and timings, but nothing states a size.
    // So this is set by eye against the retail game, and 0.8 is where two
    // rounds of "still a little big" from play landed it -- default combat text
    // at 1.8% of screen height, the map's size-14 lane signs at 2.6%, its
    // size-20 base markers at 3.7%.
    // Still the knob: FOC.overlay.tags.scale = N in the console, look, keep the
    // number. 1 is Blizzard.j's TextTagSize2Height untouched.
    this.scale = 0.8;
  }

  /** Create or reconfigure a tag. A reconfigured tag keeps the age it has. */
  set(ev) {
    const t = this.tags.get(ev.tt) || { age: 0 };
    Object.assign(t, ev);
    if (ev.age != null) t.age = ev.age;
    this.tags.set(ev.tt, t);
  }

  remove(id) { this.tags.delete(id); }
  clear() { this.tags.clear(); }

  draw(ctx, view) {
    const now = performance.now();
    // A tab that was in the background is not a tag that aged a minute
    const dt = Math.min(0.25, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    if (!this.tags.size) return;
    const w = innerWidth, h = innerHeight;
    ctx.save();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    for (const [id, t] of this.tags) {
      t.age += dt;
      // A permanent tag never expires; anything else dies at its lifespan.
      // That split is the whole of why the lane labels stay and a spell shout
      // does not: 22 of the map's tags are never given a lifespan at all.
      if (!t.perm && t.life > 0 && t.age >= t.life) { this.tags.delete(id); continue; }
      if (!t.vis || !t.s) continue;

      const p = view.groundPoint(t.x, t.y, t.z).project(view.camera);
      if (p.z > 1) continue;                              // behind the camera
      // Velocity is per second in the screen box, so it is a screen drift and
      // not a world one -- the text slides up the display, not up the map.
      const sx = (p.x * 0.5 + 0.5) * w + t.vx * t.age * w;
      const sy = (-p.y * 0.5 + 0.5) * h - t.vy * t.age * h;
      const size = t.h * h * this.scale;
      if (size < 1 || sx < -w || sx > w * 2 || sy < -size || sy > h + size) continue;

      // Opaque until the fadepoint, then out linearly by the end of the life.
      let a = (t.c?.[3] ?? 255) / 255;
      if (!t.perm && t.life > t.fade && t.age > t.fade) {
        a *= 1 - (t.age - t.fade) / (t.life - t.fade);
      }
      if (a <= 0) continue;

      // Friz Quadrata, the face UI\war3skins.txt names as TextTagFont, staged
      // out of war3.mpq. Not bold: the game sets this text in the roman, and a
      // synthetic bold is a good part of why the first attempt read as heavy.
      ctx.font = `${size.toFixed(1)}px "Friz Quadrata", "Trebuchet MS", serif`;
      const base = `rgb(${t.c?.[0] ?? 255},${t.c?.[1] ?? 255},${t.c?.[2] ?? 255})`;
      const runs = colourRuns(String(t.s), base);
      if (!runs.length) continue;
      // laid out left to right, so the whole string is what gets centred
      let x = sx - runs.reduce((n, r) => n + ctx.measureText(r.text).width, 0) / 2;
      const off = Math.max(1, size * 0.05);
      for (const r of runs) {
        // Warcraft III draws this text over the terrain with a dark shadow
        // under it, which is the only thing keeping pale text legible on the
        // pale ground this map has a lot of
        ctx.globalAlpha = a * 0.7;
        ctx.fillStyle = '#000';
        ctx.fillText(r.text, x + off, sy + off);
        ctx.globalAlpha = a;
        ctx.fillStyle = r.colour;
        ctx.fillText(r.text, x, sy);
        x += ctx.measureText(r.text).width;
      }
    }
    ctx.restore();
  }
}

/**
 * Warcraft III's cinematic filter: a full-screen wash that runs from one colour
 * to another over a duration, which is what the map throws for its ultimates
 * and its duel transitions.
 *
 * Colours arrive 0-255 with alpha already resolved from the BJ's transparency,
 * so nothing here decides how it looks. It ends by holding the end colour --
 * DisplayCineFilter(false), which Blizzard.j's FinishCinematicFadeBJ sends, is
 * what clears it, and a fade-in ends transparent anyway.
 */
export class CineFilter {
  constructor() {
    this.f = null;
    this.textures = new Map();
    this.index = fetch('/assets/textures.json').then(r => {
      if (!r.ok) throw new Error('Cinematic texture index unavailable');
      return r.json();
    });
    // Keep a failed preload handled even before the first filter is shown.
    this.index.catch(e => console.warn(e.message));
  }

  texture(path) {
    const key = path.replace(/\//g, '\\').toLowerCase();
    if (!this.textures.has(key)) {
      const pending = this.index.then(async index => {
        const file = index[key];
        if (!file) throw new Error(`Cinematic texture missing: ${path}`);
        const img = new Image();
        img.src = `/assets/${file}`;
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        return { canvas, ctx, pixels: ctx.getImageData(0, 0, canvas.width, canvas.height), color: null };
      }).catch(e => { console.warn(e.message); return null; });
      this.textures.set(key, pending);
    }
    return this.textures.get(key);
  }

  show(ev) {
    const f = this.f = { from: ev.from || [0, 0, 0, 255], to: ev.to || [0, 0, 0, 0],
               dur: Math.max(0, +ev.dur || 0), start: performance.now(), tex: ev.tex,
               texture: null };
    // All five filters in this map use BLEND_MODE_BLEND and full-image UVs.
    // A named texture stays clear while loading; it must never flash as a
    // solid rectangle. Loading an old filter cannot replace the current one.
    f.ready = ev.tex ? this.texture(ev.tex).then(texture => { f.texture = texture; }) : Promise.resolve();
    return f.ready;
  }
  clear() { this.f = null; }

  draw(ctx) {
    const f = this.f;
    if (!f) return;
    const k = f.dur > 0 ? Math.min(1, (performance.now() - f.start) / (1000 * f.dur)) : 1;
    const c = (i) => Math.round(f.from[i] + (f.to[i] - f.from[i]) * k);
    const a = c(3) / 255;
    if (a <= 0 || (f.tex && !f.texture)) return;
    ctx.save();
    ctx.globalAlpha = a;
    if (f.texture) {
      const t = f.texture, color = [c(0), c(1), c(2)];
      if (t.color !== color.join(',')) {
        // Multiply RGB without changing the texture's authored alpha. Work
        // at asset resolution, and only when the tint changes, not per frame.
        const tinted = new ImageData(new Uint8ClampedArray(t.pixels.data), t.canvas.width, t.canvas.height);
        for (let i = 0; i < tinted.data.length; i += 4)
          for (let j = 0; j < 3; j++) tinted.data[i + j] *= color[j] / 255;
        t.ctx.putImageData(tinted, 0, 0);
        t.color = color.join(',');
      }
      ctx.drawImage(t.canvas, 0, 0, innerWidth, innerHeight);
    } else {
      ctx.fillStyle = `rgb(${c(0)},${c(1)},${c(2)})`;
      ctx.fillRect(0, 0, innerWidth, innerHeight);
    }
    ctx.restore();
  }
}

/**
 * A frame readout, because the numbers that matter are the ones on the machine
 * complaining.
 *
 * A headless profile cannot answer this: Chromium falls back to software WebGL,
 * which moves the whole cost of rasterising into the buffer swap where no timer
 * in the page can see it. What a real GPU spends is only visible on a real GPU,
 * so the game has to be able to say so itself.
 *
 * Draw calls lead, because that is the number most likely to be the problem: a
 * Warcraft III model is many geosets and each one is its own mesh.
 */
class Stats {
  constructor() {
    this.on = false;
    this.frames = [];
    this.last = performance.now();
  }

  sample() {
    const now = performance.now();
    const dt = now - this.last;
    this.last = now;
    // A gap of a second is not a slow frame -- it is loading, a tab switch, or
    // the machine asleep. Letting one in makes p99 read 20 seconds.
    if (dt > 0 && dt < 1000) this.frames.push(dt);
    if (this.frames.length > 120) this.frames.shift();
  }

  draw(ctx, view, ents) {
    if (!this.on || this.frames.length < 8) return;
    const s = [...this.frames].sort((a, b) => a - b);
    const at = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
    const info = view.renderer.info;
    // Counting the scene means walking every object in it, which at 2000+ is
    // real work to put a number on screen -- and it lands in the frame time the
    // number is reporting. Once a second is plenty for a diagnostic.
    const now = performance.now();
    if (now - (this.countedAt || 0) > 1000) {
      this.countedAt = now;
      let meshes = 0, points = 0;
      view.scene.traverse((o) => { if (o.isMesh) meshes++; else if (o.isPoints) points++; });
      this.meshes = meshes; this.points = points;
    }
    const meshes = this.meshes || 0, points = this.points || 0;
    const lines = [
      `${(1000 / at(0.5)).toFixed(0)} fps   ${at(0.5).toFixed(1)} ms   p99 ${at(0.99).toFixed(1)} ms`,
      `draw calls   ${info.render.calls}`,
      `triangles    ${info.render.triangles.toLocaleString()}`,
      `meshes       ${meshes}   emitters ${points}`,
      `units        ${ents.size}   views ${view.views.size}`,
      `cpu  views   ${(view.perf?.views || 0).toFixed(1)}   interp ${(view.perf?.interp || 0).toFixed(1)}`,
      `     gl      ${(view.perf?.gl || 0).toFixed(1)}   ui ${(view.perf?.ui || 0).toFixed(1)}   fx ${(view.perf?.fx || 0).toFixed(1)}`,
      `[ anim ${view.frozen ? 'FROZEN' : 'on'}    ] units ${view.noUnits ? 'HIDDEN' : 'on'}`,
      `\\ skinning ${view.skinless ? 'OFF' : 'on'}`,
      `textures     ${info.memory.textures}   geometries ${info.memory.geometries}`,
    ];
    ctx.save();
    ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
    const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 16;
    ctx.fillStyle = 'rgba(4,6,10,0.82)';
    ctx.fillRect(innerWidth - w - 10, 52, w, lines.length * 15 + 12);
    ctx.fillStyle = '#9fe8b0';
    lines.forEach((l, i) => ctx.fillText(l, innerWidth - w - 2, 70 + i * 15));
    ctx.restore();
  }
}

export class Overlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.dpr = Math.min(2, devicePixelRatio || 1);
    this.stats = new Stats();
    this.tags = new TextTags();
    this.cine = new CineFilter();
    this.resize();
    addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  clear() {
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /**
   * @param view   the Renderer, for its camera and views
   * @param ents   the entity map, for hp/mana
   * @param show   which ids to draw a bar for
   */
  draw(view, ents, show) {
    const ctx = this.ctx;
    this.clear();
    this.stats.sample();
    // under the stats, over the bars: it is world content, they are a readout
    this.tags.draw(ctx, view);
    // over the text, under the stats: the filter washes the scene, and the
    // frame readout is a diagnostic that should stay legible through it
    this.cine.draw(ctx);
    this.stats.draw(ctx, view, ents);
    if (!show || !show.size) return;
    const w = innerWidth, h = innerHeight;
    // bars shrink with distance the way the unit does, within reason
    const scale = Math.max(0.55, Math.min(1.35, 1400 / (view.camDist || 1400)));
    const bw = BAR_W * scale, bh = Math.max(3, BAR_H * scale);
    for (const id of show) {
      const e = ents.get(id);
      const v = view.views.get(id);
      if (!e || !v || !v.root.visible) continue;
      const maxHp = e.H || 0;
      if (!maxHp) continue;
      // above the head, measured from the model rather than assumed
      const top = view.barAnchor(v);
      const p = top.project(view.camera);
      if (p.z > 1) continue;                       // behind the camera
      const sx = Math.round((p.x * 0.5 + 0.5) * w - bw / 2);
      const sy = Math.round((-p.y * 0.5 + 0.5) * h);
      if (sx < -bw || sx > w || sy < -20 || sy > h) continue;

      const hp = Math.max(0, Math.min(1, (e.h ?? maxHp) / maxHp));
      ctx.fillStyle = 'rgba(0,0,0,0.7)';
      ctx.fillRect(sx - 1, sy - 1, bw + 2, bh + 2);
      ctx.fillStyle = '#101418';
      ctx.fillRect(sx, sy, bw, bh);
      ctx.fillStyle = healthColor(hp);
      ctx.fillRect(sx, sy, Math.round(bw * hp), bh);

      const maxMana = e.M || 0;
      if (maxMana > 0) {
        const mp = Math.max(0, Math.min(1, (e.m ?? 0) / maxMana));
        const my = sy + bh + GAP;
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(sx - 1, my - 1, bw + 2, bh + 2);
        ctx.fillStyle = '#101418';
        ctx.fillRect(sx, my, bw, bh);
        ctx.fillStyle = '#3f7fd0';
        ctx.fillRect(sx, my, Math.round(bw * mp), bh);
      }
    }
  }
}
