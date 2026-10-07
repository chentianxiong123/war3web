// Plays the map's own imported MP3s: hero voice lines on cast, generic SFX on impact.
export class Audio {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();
    this.master = null;
    this.volume = 0.55;
    this.enabled = true;
    this.missing = new Set();      // paths the archives did not supply
    this.playing = new Set();      // NODUPLICATES: what must not start twice
  }
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return; }
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.volume;
    this.master.connect(this.ctx.destination);
  }
  async load(file) {
    if (!this.ctx) return null;
    if (this.buffers.has(file)) return this.buffers.get(file);
    const url = file.includes('/') ? `/assets/${file}` : `/assets/sounds/${file}`;
    const p = fetch(url)
      .then((r) => { if (!r.ok) throw new Error('missing'); return r.arrayBuffer(); })
      .then((b) => this.ctx.decodeAudioData(b))
      .catch(() => { this.missing.add(file); return null; });
    this.buffers.set(file, p);
    return p;
  }
  async play(file, gain = 1, rate = 1, loop = false) {
    if (!this.enabled || !file) return;
    this.init();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    const buf = await this.load(file);
    if (!buf) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = loop;
    src.playbackRate.value = rate;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g); g.connect(this.master);
    src.start();
    return src;
  }
  /**
   * Play a sound the map's script started, attenuated by distance from the
   * listener the way Warcraft III's 3D sounds are.
   */
  playWorld(path, x, y, vol = 1, pitch = 1, listener = null, dist = null,
            opts = null) {
    if (!path || this.missing.has(path)) return;
    let gain = Math.max(0, Math.min(1, vol));
    if (listener && typeof x === 'number' && typeof y === 'number') {
      const d = Math.hypot(x - listener.x, y - listener.y);
      // Warcraft III gives every sound its own falloff: full volume out to
      // MinDistance, fading to MaxDistance, and DistanceCutoff past which it is
      // not worth mixing at all. A footstep carries 2000, a building collapsing
      // 10000, which is what keeps a crowded fight from becoming one noise.
      // Without a table the old fixed pair stands, so the script's own sounds
      // are unaffected.
      const FULL = dist?.min || 1200;
      const FADE = Math.max(FULL + 1, dist?.max || 4500);
      const CUTOFF = dist?.cutoff || FADE;
      if (d > CUTOFF) return;
      if (d > FULL) gain *= Math.max(0, 1 - (d - FULL) / (FADE - FULL));
    }
    if (gain <= 0.01) return;
    // A sound the map created as looping keeps going until the map stops it --
    // this map's whole score is one such, HumanX1.mp3 at 4 minutes 44. It is
    // kept by the id the server gave it so StopSound can find it again.
    const id = opts && opts.snd;
    const loop = !!(opts && opts.loop);
    if (!loop && !id) { this.play(path, gain, pitch); return; }
    this.live = this.live || new Map();
    if (id && this.live.has(id)) return;          // already running
    this.play(path, gain, pitch, loop).then((src) => {
      if (!src) return;
      if (id) {
        this.live.set(id, src);
        src.onended = () => { if (this.live.get(id) === src) this.live.delete(id); };
      }
    }).catch(() => {});
  }

  /** StopSound: silence one sound the map started, by the id it was given. */
  stopSound(id, fade = false) {
    const src = this.live && this.live.get(id);
    if (!src) return;
    this.live.delete(id);
    try { src.stop(fade ? this.ctx.currentTime + 1.5 : 0); } catch { /* already done */ }
  }
  /**
   * A sound with no place on the map: the advisor in your ear.
   *
   * Warcraft III's warnings -- "Our hero has fallen!" -- are not 3D. They play
   * at their own volume wherever the hero died, because the voice is yours and
   * not the battlefield's, so this deliberately skips the distance falloff
   * playWorld applies.
   */
  playUI(path, vol = 1, flags = null) {
    if (!path || this.missing.has(path)) return;
    const gain = Math.max(0, Math.min(1, vol));
    if (gain <= 0.01) return;
    // NODUPLICATES, straight off the row: Warcraft III will not start one of
    // these while it is already playing. Hero-death warnings carry it,
    // and in a map where heroes die constantly it is the difference between a
    // warning and a pile-up. CHANNELFULLPREEMPT is deliberately not honoured --
    // it decides what to evict when a mixer channel is full, and there is no
    // channel model here to be full.
    const solo = Array.isArray(flags) && flags.includes('NODUPLICATES');
    if (solo) {
      if (this.playing.has(path)) return;
      this.playing.add(path);
      this.play(path, gain, 1)
        .then((src) => {
          if (src) src.onended = () => this.playing.delete(path);
          else this.playing.delete(path);
        })
        .catch(() => this.playing.delete(path));
      return;
    }
    this.play(path, gain, 1);
  }

  /**
   * The map's music.
   *
   * A track at a time out of the list the server sent, moving on when one ends
   * and looping the list, because that is what Warcraft III does with
   * SetMapMusic: the call names a list, not a single file.  It is an <audio>
   * element rather than a decoded buffer -- a five-minute mp3 decodes to tens of
   * megabytes as raw samples, and this one streams instead.
   *
   * It cannot start until the page has been interacted with, so a call that
   * arrives before then is remembered and started by the first click, the same
   * gate the effects mixer sits behind.
   */
  /**
   * The ambient theme: a bed under everything, looping, at the volume its own
   * MIDISounds row states. Warcraft III crossfades day into night as the clock
   * turns; the hour picks which one here, and changing it swaps the bed.
   *
   * An <audio> element again rather than a decoded buffer -- these are four and
   * a half minutes each.
   */
  setAmbient(day, night, hour = 12) {
    this.ambient = { day, night };
    this.ambientHour = hour;
    this.applyAmbient();
  }
  setAmbientHour(hour) { this.ambientHour = hour; this.applyAmbient(); }
  applyAmbient() {
    const a = this.ambient;
    if (!a) return;
    const h = this.ambientHour ?? 12;
    // Warcraft III's own dawn and dusk, which is where the day/night light
    // curve turns as well
    const isDay = h >= 6 && h < 18;
    const want = (isDay ? a.day : a.night) || a.day || a.night;
    if (!want || !want.file) return;
    if (this.ambientPlaying === want.file) return;
    this.ambientPlaying = want.file;
    if (!this.ambientEl) {
      this.ambientEl = new window.Audio();
      this.ambientEl.loop = true;
      this.ambientEl.addEventListener('error', () => { this.ambientPlaying = null; });
    }
    this.ambientEl.src = `/assets/${want.file}`;
    this.ambientEl.volume = Math.max(0, Math.min(1, (want.volume ?? 0.6) * this.volume));
    const go = this.ambientEl.play();
    if (go && go.catch) go.catch(() => { this.ambientPending = true; });
  }

  /** SetMapMusic: remember the list without playing over the map's own score. */
  setMusicList(list, random = false, index = 0) {
    if (!Array.isArray(list) || !list.length) return;
    this.music = { list, random, index: Math.max(0, Math.min(list.length - 1, index | 0)) };
  }
  playMusic(list, random = false, index = 0) {
    if (!Array.isArray(list) || !list.length) return;
    this.music = { list, random, index: Math.max(0, Math.min(list.length - 1, index | 0)) };
    this.nextTrack(0);
  }
  nextTrack(step = 1) {
    const m = this.music;
    if (!m || !m.list.length) return;
    if (step) {
      m.index = m.random ? Math.floor(Math.random() * m.list.length)
                         : (m.index + step) % m.list.length;
    }
    const file = m.list[m.index];
    if (!file) return;
    if (!this.musicEl) {
      this.musicEl = new window.Audio();
      this.musicEl.addEventListener('ended', () => this.nextTrack(1));
      // a track the archives did not supply must not stop the list
      this.musicEl.addEventListener('error', () => this.nextTrack(1));
    }
    this.musicEl.src = file.includes('/') ? `/assets/${file}` : `/assets/sounds/${file}`;
    this.musicEl.volume = this.musicVolume ?? 0.35;
    const go = this.musicEl.play();
    if (go && go.catch) go.catch(() => { this.musicPending = true; });
  }
  stopMusic(fade = false) {
    if (!this.musicEl) return;
    if (!fade) { this.musicEl.pause(); return; }
    const el = this.musicEl, from = el.volume;
    let k = 0;
    const t = setInterval(() => {
      k += 0.05;
      el.volume = Math.max(0, from * (1 - k));
      if (k >= 1) { clearInterval(t); el.pause(); el.volume = from; }
    }, 50);
  }
  resumeMusic() {
    if (this.musicEl) { const g = this.musicEl.play(); if (g && g.catch) g.catch(() => {}); return; }
    if (this.music) this.nextTrack(0);
  }
  setMusicVolume(v) {
    this.musicVolume = Math.max(0, Math.min(1, v));
    if (this.musicEl) this.musicEl.volume = this.musicVolume;
  }
  /** Called on the first real interaction, when a browser will finally allow it. */
  unblockMusic() {
    if (this.ambientPending) {
      this.ambientPending = false;
      const g = this.ambientEl && this.ambientEl.play();
      if (g && g.catch) g.catch(() => {});
    }
    if (!this.musicPending) return;
    this.musicPending = false;
    this.resumeMusic();
  }

  setVolume(v) { this.volume = v; if (this.master) this.master.gain.value = v; }
}
