// JASS runtime: handle tables, trigger/timer scheduler, event dispatch, and the
// native API bound to the game world. The map's own script is the game logic.
import fs from 'node:fs';
import path from 'node:path';
import { VM, Handle } from './vm.js';
import { loadScripts } from './boot.js';

const ROOT = path.resolve(import.meta.dirname, '../..');

// war3map.wts: the map's string table. Scripts reference entries as TRIGSTR_nnn.
const WTS = (() => {
  try {
    const p = path.resolve(import.meta.dirname, '../../extracted/war3map.wts');
    const txt = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const out = new Map();
    for (const m of txt.matchAll(/STRING (\d+)\s*\{\n([\s\S]*?)\n\}/g))
      out.set(Number(m[1]), m[2]);
    return out;
  } catch { return new Map(); }
})();

export function resolveTrigstr(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/TRIGSTR_0*(\d+)/g, (all, n) => WTS.get(Number(n)) ?? all);
}

const DEG = Math.PI / 180, RAD = 180 / Math.PI;
const trunc = (v) => (v < 0 ? Math.ceil(v) : Math.floor(v)) | 0;

export const Ev = {
  TIMER: 'timer',
  UNIT_DEATH: 18, UNIT_DAMAGED: 308, UNIT_ATTACKED: 18,
};

export class JassEngine {
  constructor(world) {
    this.world = world;
    world.jass = this;
    this.vm = new VM();
    this.now = 0;                       // ms of game time
    this.triggers = [];
    this.timers = [];
    this.threads = [];
    this.regions = [];
    this.players = [];
    this.ctx = {};                      // current event context
    this.timerDialogs = [];             // Warcraft III's on-screen countdowns
    this.quests = [];
    this.ctxStack = [];
    this.clientEvents = [];
    this.log = [];
    this.errors = [];
    this.unimplemented = new Map();
    this.leaderboards = [];
    this.multiboards = [];
    this.booted = false;
    for (let i = 0; i < 16; i++) {
      this.players.push(new Handle('player', {
        index: i, name: `Player ${i + 1}`, team: i < 5 ? 0 : i < 10 ? 1 : 2,
        // Warcraft III starts each player on the colour of their slot; the map
        // is free to reassign it, and this one does, ten times over.
        color: i,
        gold: 0, lumber: 0,
        // PLAYER_STATE_GIVES_BOUNTY. Warcraft III has this ON for the neutral
        // players and off for everyone else, which is why Blizzard.j's
        // ConfigureNeutralVictim bothers to turn it off again for Neutral
        // Victim ("Neutral Victim does not give bounties") -- you only turn off
        // what defaults on. Neutral aggressive is player 12, and every one of
        // this map's 37 creeps belongs to it, so this is the flag that decides
        // whether killing a creep floats the gold it paid. The map turns it on
        // for Player(0..7) itself, which is what makes hero kills print too.
        givesBounty: i === 12,
        // PLAYER_SLOT_STATE_EMPTY. A slot is only PLAYING once somebody is in
        // it -- reporting all twelve as occupied makes the map believe it has a
        // full house, and this one counts slots to decide who duels.
        slotState: 0,
        // MAP_CONTROL_NONE for a seat nobody is in, MAP_CONTROL_NEUTRAL for the
        // four neutral players that own the creeps. A human seat becomes
        // MAP_CONTROL_USER (0) when somebody sits in it -- and it matters that
        // the creeps' owner is *not* USER, or a creep passes a filter meant to
        // find players.
        controller: i >= 12 ? 3 : 5,
        score: {}, techs: new Map(),
      }));
    }
  }

  // ------------------------------------------------------------------- boot
  load(paths) {
    const asts = loadScripts(this.vm, paths);
    installNatives(this.vm, this);
    // any native declared but not implemented becomes a recorded no-op
    for (const [name, sig] of this.vm.nativeSigs) {
      if (!this.vm.natives.has(name)) {
        this.vm.registerNative(name, (...a) => {
          this.unimplemented.set(name, (this.unimplemented.get(name) || 0) + 1);
          return this.vm.defaultFor(sig.ret);
        });
      }
    }
    this.asts = asts;
    return asts;
  }

  /**
   * Run a generator thread to completion or until it sleeps. Each thread keeps
   * its own event context: in Warcraft III a trigger action that sleeps still
   * sees GetTriggerUnit()/GetDyingUnit() when it resumes.
   */
  runThread(gen, label = '', ctx = null) {
    const th = { gen, label, wakeAt: 0, ctx: ctx || this.ctx };
    this.step(th);
    return th;
  }
  step(th) {
    this.vm.opCount = 0;
    const outer = this.ctx;
    if (th.ctx) this.ctx = th.ctx;
    try {
      this._step(th);
    } finally {
      this.ctx = outer;
    }
  }
  _step(th) {
    for (;;) {
      let r;
      try { r = th.gen.next(); }
      catch (e) { this.errors.push(`${th.label}: ${e.message}\n${(e.stack||'').split('\n').slice(1,6).join('\n')}`); th.done = true; return; }
      if (r.done) { th.done = true; return; }
      const y = r.value;
      if (y && typeof y.sleep === 'number') {
        th.wakeAt = this.now + Math.max(0, y.sleep) * 1000;
        if (!this.threads.includes(th)) this.threads.push(th);
        return;
      }
    }
  }

  boot() {
    const runAll = (gen, label) => this.runThread(gen, label);
    runAll(this.vm.initGlobals(), 'globals');
    if (this.vm.functions.has('config')) runAll(this.vm.runFunction('config'), 'config');
    if (this.vm.functions.has('main')) runAll(this.vm.runFunction('main'), 'main');
    this.booted = true;
    return { errors: this.errors.slice(), unimplemented: [...this.unimplemented].sort((a, b) => b[1] - a[1]) };
  }

  // -------------------------------------------------------------- scheduling
  update(dtMs) {
    this.now += dtMs;
    // periodic / one-shot trigger timers
    for (const t of this.timers) {
      if (t.dead) continue;
      if (t.paused) continue;
      while (this.now >= t.nextAt) {
        t.nextAt += t.periodMs;
        this.fireTimer(t);
        if (!t.periodic) { t.dead = true; break; }
        if (t.periodMs <= 0) break;
      }
    }
    this.timers = this.timers.filter((t) => !t.dead);
    // wake sleeping threads
    const ready = this.threads.filter((t) => !t.done && this.now >= t.wakeAt);
    this.threads = this.threads.filter((t) => !t.done && this.now < t.wakeAt);
    for (const th of ready) this.step(th);
    this.threads = this.threads.filter((t) => !t.done);
  }

  fireTimer(t) {
    if (t.trigger) this.execTrigger(t.trigger, { triggeringTrigger: t.trigger });
    else if (t.handler) this.runThread(this.vm.runFunction(t.handler.fn), 'timer:' + t.handler.fn);
  }

  /** Run a trigger's conditions then its actions, inside an event context. */
  execTrigger(tr, ctx) {
    if (!tr || !tr.enabled) return false;
    this.ctxStack.push(this.ctx);
    this.ctx = Object.assign({}, ctx, { triggeringTrigger: tr });
    try {
      for (const c of tr.conditions) {
        const g = this.vm.runFunction(c.fn);
        let r = g.next();
        while (!r.done) r = g.next();                 // conditions may not sleep
        if (!r.value) { this.ctx = this.ctxStack.pop(); return false; }
      }
      const evCtx = this.ctx;
      for (const a of tr.actions) {
        this.runThread(this.vm.runFunction(a.fn), 'trig:' + a.fn, evCtx);
      }
    } catch (e) {
      this.errors.push(`trigger: ${e.message}`);
    }
    this.ctx = this.ctxStack.pop();
    return true;
  }

  /** Dispatch a game event to every trigger registered for it. */
  fire(kind, ctx) {
    for (const tr of this.triggers) {
      if (!tr.enabled) continue;
      for (const ev of tr.events) {
        if (ev.kind !== kind) continue;
        if (ev.playerIndex != null && ctx.player && ev.playerIndex !== ctx.player.index) continue;
        if (ev.unit && ctx.unit !== ev.unit) continue;
        if (ev.rect && ctx.x != null && !rectHas(ev.rect, ctx.x, ctx.y)) continue;
        if (ev.chat != null && ctx.chat != null) {
          const s = ctx.chat;
          if (ev.exact ? s !== ev.chat : !s.startsWith(ev.chat)) continue;
        }
        this.execTrigger(tr, ctx);
        break;
      }
    }
  }

  /** Resolve a common.j event constant name to its dispatch key. */
  eventId(name) {
    const g = this.vm.globals.get(name);
    const v = g && g.value;
    return v && typeof v.v === 'number' ? `${v.__type}:${v.v}` : null;
  }

  /** The map's own scoreboard, as a plain grid. */
  scoreboard() {
    const mb = this.multiboards.find((m) => m.shown && m.cells.size)
            || this.multiboards.find((m) => m.cells.size);
    if (!mb) return null;
    const rows = [];
    for (let r = 0; r < mb.rows; r++) {
      const row = [];
      for (let c = 0; c < mb.cols; c++) {
        const cell = mb.cells.get(r + ',' + c);
        row.push(cell ? String(cell.value ?? '') : '');
      }
      if (row.some((x) => x !== '')) rows.push(row);
    }
    if (!rows.length) return null;
    return { title: mb.title, cols: mb.cols, rows };
  }

  emit(ev) { this.clientEvents.push(ev); }
  fxSeq = 0;
  ttSeq = 0;
  sndSeq = 0;          // so StopSound can name the sound it is stopping
  /**
   * The world's standing look and sound: the fog, the music list, the day/night
   * models and the hour.  All four are set once during config() and main(), so
   * a client that connects after that -- a reconnect, or a second window --
   * would never hear about them.  They are scenery in exactly the way the
   * permanent text tags are, and are replayed the same way.
   */
  atmosphere = {};
  /** The events that put a fresh client's world into the state the map set. */
  atmosphereEvents() {
    const a = this.atmosphere;
    return [a.daynight, a.fog, a.music, a.ambient, a.tod].filter(Boolean);
  }
  // The permanent tags, kept so a client that connects after they were made
  // still gets the scenery. A tag with a lifespan is dropped as soon as it has
  // been sent -- the client owns the whole of its short life.
  textTags = new Map();
  dirtyTags = new Set();

  /** Apply a change to a text tag and mark it for this tick's flush. */
  touchTag(t, f) { if (t) { f(); this.dirtyTags.add(t); } }

  /**
   * One event per tag touched this tick, carrying its finished state.
   *
   * A tag created and destroyed within the same tick is never sent at all,
   * rather than sent and immediately retracted.
   */
  flushTextTags() {
    for (const t of this.dirtyTags) {
      if (t.dead) {
        this.textTags.delete(t.tt);
        if (t.sent) this.clientEvents.push({ t: 'texttagEnd', tt: t.tt });
      } else {
        t.sent = true;
        this.clientEvents.push(textTagEvent(t));
        if (!t.permanent) this.textTags.delete(t.tt);
      }
    }
    this.dirtyTags.clear();
  }

  /** The live permanent tags, as the events that would have created them. */
  liveTags() {
    return [...this.textTags.values()].filter((t) => !t.dead).map(textTagEvent);
  }

  flushClientEvents() {
    this.flushTextTags();
    const e = this.clientEvents; this.clientEvents = []; return e;
  }
}

function textTagEvent(t) {
  return { t: 'texttag', tt: t.tt, s: t.text, x: t.x, y: t.y, z: t.z,
           h: t.height, c: t.color, vx: t.xvel, vy: t.yvel,
           life: t.life, fade: t.fade, age: t.age,
           perm: t.permanent, vis: t.visible && !t.suspended };
}

function rectHas(r, x, y) { return x >= r.minx && x <= r.maxx && y >= r.miny && y <= r.maxy; }

/**
 * Dispatch key for an event handle. The type matters: playerunitevent 53 and
 * unitevent 53 are different events that must not collide.
 */
function evKey(ev) { return ev ? `${ev.__type}:${ev.v}` : 'event:null'; }

/**
 * Warcraft III audio (ADPCM/Huffman .wav, .mp3) is transcoded to .ogg at build
 * time and indexed by its lower-cased archive path, so an archive path the
 * script names has to be looked up rather than served verbatim.
 */
function loadIndex(files) {
  for (const f of files) {
    try { return JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')); }
    catch { /* absent: try the next location */ }
  }
  return {};
}
let SOUND_INDEX = null, IMPORT_INDEX = null, MUSIC_LIST = null, AMBIENCE = null;
let SOUND_LABELS = null;   // every SoundInfo row's volume and pitch, for SetSoundParamsFromLabel
/**
 * The ambient themes, rendered by tools/ambience.py.
 *
 * SetAmbientDaySound("CityScapeDay") names a row in MIDISounds.slk rather than
 * in AmbienceSounds.slk, and that row is a MIDI score plus the DLS instrument
 * bank it is played on -- which is why nothing here could play it until the
 * pipeline learned to render the pair once, with the game's own bank.
 */
function ambience() {
  if (!AMBIENCE) AMBIENCE = loadIndex(['data/ambience.json', 'public/data/ambience.json']);
  return AMBIENCE;
}
/**
 * The standard music playlist, UI\WorldEditData.txt's [MusicFiles].
 *
 * SetMapMusic("Music", ...) does not name a row in any SoundInfo table: "Music"
 * is the label for that list, which is what the World Editor's own music
 * dropdown shows.  tools/gameplay.py carries it into data/gameplay.json so this
 * needs no UI file at runtime.  Every path goes through the same sound index
 * every other sound uses, so a track the archives did not supply drops out
 * rather than reaching the client as a 404.
 */
function musicList() {
  if (MUSIC_LIST) return MUSIC_LIST;
  const gp = loadIndex(['data/gameplay.json', 'public/data/gameplay.json']);
  const idx = soundIndex();
  MUSIC_LIST = (gp.music || [])
    .map((p) => idx[String(p).replace(/\\/g, '/').toLowerCase()])
    .filter(Boolean);
  return MUSIC_LIST;
}
function soundIndex() {
  if (!SOUND_INDEX) SOUND_INDEX = loadIndex(['assets/sounds.json', 'public/assets/sounds.json']);
  return SOUND_INDEX;
}
/** Map imports keep their file name unless staging had to transcode them. */
function importIndex() {
  if (!IMPORT_INDEX) IMPORT_INDEX = loadIndex(['assets/imported_sounds.json',
                                               'public/assets/imported_sounds.json']);
  return IMPORT_INDEX;
}

/**
 * Wire name for a sound the script created. Map imports are served flat by their
 * file name; game sounds resolve through the transcode index to their .ogg.
 */
function soundKey(p) {
  if (!p) return null;
  const q = String(p).replace(/\\\\/g, '\\').replace(/\//g, '\\');
  if (/^war3mapimported\\/i.test(q)) {
    const base = q.split('\\').pop();
    return importIndex()[base.toLowerCase()] || base;
  }
  const rel = q.replace(/\\/g, '/');
  const idx = soundIndex();
  const hit = idx[rel.toLowerCase()];
  if (hit) return hit;
  // the script may name a .wav that shipped as .mp3 (or the reverse)
  const stem = rel.toLowerCase().replace(/\.[^./]*$/, '');
  for (const ext of ['.wav', '.mp3']) {
    const alt = idx[stem + ext];
    if (alt) return alt;
  }
  return rel;
}

// ============================================================ native bindings
function installNatives(vm, eng) {
  const W = () => eng.world;
  /**
   * The day or night ambient theme. Both are remembered on the engine so a
   * client joining later gets them, and so the pair is there for the moment the
   * clock is allowed to turn.
   */
  const setAmbient = (which, label) => {
    const row = ambience()[String(label || '')];
    const a = (eng.atmosphere.ambient || (eng.atmosphere.ambient = { t: 'ambient' }));
    a[which] = row ? { file: row.file, volume: row.volume, label } : null;
    a.hour = eng.todHour === undefined ? 12 : eng.todHour;
    eng.emit({ ...a });
  };
  const H = (type, props) => new Handle(type, props);
  // the cinematic filter being assembled, see DisplayCineFilter
  const CF = () => (eng.cineFilter || (eng.cineFilter = {
    tex: '', blend: 0, from: [0, 0, 0, 255], to: [0, 0, 0, 255], dur: 0 }));

  /**
   * Warcraft III's Convert* functions return the *same* handle for a given
   * value, and scripts compare them with ==. Minting a fresh object each call
   * would make every such comparison false, so they are interned.
   */
  const converted = new Map();
  const C = (type) => (i) => {
    const key = type + ':' + i;
    let h = converted.get(key);
    if (!h) { h = new Handle(type, { v: i }); converted.set(key, h); }
    return h;
  };
  const U = (u) => (u && u.alive !== false ? u : u);          // units are handles already
  const loc = (x, y) => H('location', { x, y });
  const P = (i) => eng.players[Math.max(0, Math.min(15, trunc(i)))];
  const asDeg = (r) => r;
  const rnd = () => Math.random();

  const N = {
    // ---------------------------------------------------------- conversions
    ConvertRace: C('race'),
    ConvertAllianceType: C('alliancetype'),
    ConvertRacePreference: C('racepreference'),
    ConvertIGameState: C('igamestate'),
    ConvertFGameState: C('fgamestate'),
    ConvertPlayerState: C('playerstate'),
    ConvertPlayerScore: C('playerscore'),
    ConvertPlayerGameResult: C('playergameresult'),
    ConvertUnitState: C('unitstate'),
    ConvertAIDifficulty: C('aidifficulty'),
    ConvertGameEvent: C('gameevent'),
    ConvertPlayerEvent: C('playerevent'),
    ConvertPlayerUnitEvent: C('playerunitevent'),
    ConvertWidgetEvent: C('widgetevent'),
    ConvertDialogEvent: C('dialogevent'),
    ConvertUnitEvent: C('unitevent'),
    ConvertLimitOp: C('limitop'),
    ConvertUnitType: C('unittype'),
    ConvertGameSpeed: C('gamespeed'),
    ConvertPlacement: C('placement'),
    ConvertStartLocPrio: C('startlocprio'),
    ConvertGameDifficulty: C('gamedifficulty'),
    ConvertGameType: C('gametype'),
    ConvertMapFlag: C('mapflag'),
    ConvertMapVisibility: C('mapvisibility'),
    ConvertMapSetting: C('mapsetting'),
    ConvertMapDensity: C('mapdensity'),
    ConvertMapControl: C('mapcontrol'),
    ConvertPlayerColor: C('playercolor'),
    ConvertPathingType: C('pathingtype'),
    ConvertVolumeGroup: C('volumegroup'),
    ConvertCameraField: C('camerafield'),
    ConvertBlendMode: C('blendmode'),
    ConvertRarityControl: C('raritycontrol'),
    ConvertTexMapFlags: C('texmapflags'),
    ConvertFogState: C('fogstate'),
    ConvertEffectType: C('effecttype'),
    ConvertVersion: C('version'),
    ConvertItemType: C('itemtype'),
    ConvertAttackType: C('attacktype'),
    ConvertDamageType: C('damagetype'),
    ConvertWeaponType: C('weapontype'),
    ConvertSoundType: C('soundtype'),
    OrderId: (s) => strHash(s),
    OrderId2String: (i) => String(i),
    String2OrderIdBJ: (s) => strHash(s),
    GetObjectName: (id) => W().objectName(id),
    // the type's own name, not a hero's proper name: this is what
    // GroupEnumUnitsOfType compares against
    UnitId2String: (id) => { const t = W().type(id); return (t && t.name) || ''; },

    // ------------------------------------------------------------- math/str
    GetRandomInt: (lo, hi) => (hi < lo ? lo : lo + Math.floor(rnd() * (hi - lo + 1))),
    GetRandomReal: (lo, hi) => lo + rnd() * (hi - lo),
    I2R: (i) => i, R2I: (r) => trunc(r), I2S: (i) => String(trunc(i)),
    R2S: (r) => r.toFixed(3), R2SW: (r, w, p) => r.toFixed(p),
    S2I: (s) => parseInt(s, 10) || 0, S2R: (s) => parseFloat(s) || 0,
    SubString: (s, a, b) => (s == null ? '' : String(s).substring(trunc(a), trunc(b))),
    StringLength: (s) => (s == null ? 0 : String(s).length),
    StringCase: (s, up) => (up ? String(s).toUpperCase() : String(s).toLowerCase()),
    StringHash: (s) => strHash(s),
    Sin: Math.sin, Cos: Math.cos, Tan: Math.tan,
    Asin: Math.asin, Acos: Math.acos, Atan: Math.atan,
    Atan2: (y, x) => Math.atan2(y, x), SquareRoot: (x) => (x < 0 ? 0 : Math.sqrt(x)),
    Pow: (a, b) => Math.pow(a, b),
    ModuloInteger: (a, b) => (b === 0 ? 0 : ((trunc(a) % trunc(b)) + trunc(b)) % trunc(b)),
    ModuloReal: (a, b) => (b === 0 ? 0 : ((a % b) + b) % b),

    // -------------------------------------------------------------- players
    Player: (i) => P(i),
    GetLocalPlayer: () => P(0),
    GetPlayerId: (p) => (p ? p.index : 0),
    GetPlayerName: (p) => (p ? p.name : ''),
    SetPlayerName: (p, s) => { if (p) p.name = s; },
    GetPlayerSlotState: (p) => C('playerslotstate')(p ? p.slotState : 0),
    GetPlayerController: (p) => C('mapcontrol')(p ? p.controller : 0),
    GetPlayerRace: () => C('race')(1),
    GetPlayerTeam: (p) => (p ? p.team : 0),
    SetPlayerTeam: (p, t) => { if (p) p.team = trunc(t); },
    GetPlayerColor: (p) => C('playercolor')(p ? (p.color ?? p.index) : 0),
    SetPlayerColor: (p, c) => {
      if (p) p.color = Math.max(0, Math.min(15, trunc(c && c.v) || 0));
    },
    SetPlayerAlliance: (a, b, t, on) => W().setAlliance(a, b, on),
    SetPlayerAllianceStateBJ: () => {},
    IsPlayerAlly: (a, b) => W().isAlly(a, b),
    IsPlayerEnemy: (a, b) => !W().isAlly(a, b) && a !== b,
    GetPlayerState: (p, st) => W().playerState(p, st && st.v),
    SetPlayerState: (p, st, v) => W().setPlayerState(p, st && st.v, v),
    GetPlayerScore: (p, s) => W().score(p, s && s.v),
    GetPlayerStructureCount: (p, incl) => {
      // melee 胜负检查依赖它: 玩家有建筑却数不到会被误判失败(单位被中立化)
      if (!p) return 0;
      let n = 0;
      for (const u of W().units.values()) {
        if (u.playerIndex === p.index && u.isBuilding && u.alive) n++;
      }
      return n;
    },
    GetPlayerUnitCount: (p) => W().unitsOfPlayer(p).length,
    SetPlayerHandicap: () => {},
    SetPlayerHandicapXP: (p, f) => W().setHandicapXP(p, f),
    SetPlayerTechResearched: (p, tech, lv) => { if (p) p.techs.set(tech, lv); },
    GetPlayerTechResearched: (p, tech, spec) => !!(p && (p.techs.get(tech) || 0) > 0),
    GetPlayerTechCount: (p, tech) => (p ? p.techs.get(tech) || 0 : 0),
    AddPlayerTechResearched: (p, tech, n) => { if (p) p.techs.set(tech, (p.techs.get(tech) || 0) + n); },
    SetPlayerTechMaxAllowed_: () => {},
    SetPlayerTechMaxAllowed: () => {},
    SetPlayerAbilityAvailable: () => {},
    GetPlayerStartLocation: (p) => (p ? p.index : 0),
    SetPlayerOnScoreScreen: () => {},
    SetPlayerController: (p, c) => { if (p) p.controller = c && c.v; },
    SetPlayerStartLocation: (p, i) => { if (p) p.startLoc = i; },
    ForcePlayerStartLocation: (p, i) => { if (p) p.startLoc = i; },
    SetPlayerRacePreference: () => {}, SetPlayerRaceSelectable: () => {},
    ConvertRacePref: C('racepreference'),
    ConvertPlayerSlotState: C('playerslotstate'),
    GetCameraMargin: () => 0,
    GetCameraBoundMinX: () => W().bounds().minx, GetCameraBoundMinY: () => W().bounds().miny,
    GetCameraBoundMaxX: () => W().bounds().maxx, GetCameraBoundMaxY: () => W().bounds().maxy,
    CreateSoundFromLabel: (label) => H('sound', { path: label, volume: 127 }),
    GetGameSpeed: () => C('gamespeed')(2),
    ForceEnumPlayers: (f, filter) => { if (f) { f.players.clear(); for (let i = 0; i < 12; i++) f.players.add(P(i)); } },
    ForceAddPlayer: (f, p) => { if (f) f.players.add(p); },
    ForceClear: (f) => { if (f) f.players.clear(); },
    CreateForce: () => H('force', { players: new Set() }),
    DestroyForce: () => {},
    IsPlayerInForce: (p, f) => !!(p && f && f.players && f.players.has(p)),
    ForceHasPlayer: (f, p) => !!(p && f && f.players && f.players.has(p)),
    ForceRemovePlayer: (f, p) => { if (f && f.players) f.players.delete(p); },
    LeaderboardGetLabelText: (lb) => (lb ? lb.title || '' : ''),
    LeaderboardGetItemCount_: () => 0,
    DelayedSuspendDecayCreate: () => {},
    GetPlayersAll: () => { const f = H('force', { players: new Set() }); for (let i = 0; i < 12; i++) f.players.add(P(i)); return f; },
    ForForce: function* (f, cb) {
      if (!f || !cb) return;
      for (const p of [...f.players]) {
        eng.ctxStack.push(eng.ctx); eng.ctx = Object.assign({}, eng.ctx, { enumPlayer: p });
        yield* vm.runFunction(cb.fn); eng.ctx = eng.ctxStack.pop();
      }
    },
    GetEnumPlayer: () => eng.ctx.enumPlayer || P(0),

    // ------------------------------------------------------- locations/rects
    Location: (x, y) => loc(x, y),
    // Warcraft III yields null for a null unit.  Returning (0,0) instead turned
    // a mis-targeted blink into a teleport to the middle of the map.
    GetUnitLoc: (u) => (u ? loc(u.x, u.y) : null),
    GetItemLoc: (i) => (i ? loc(i.x, i.y) : loc(0, 0)),
    GetRectCenter: (r) => (r ? loc((r.minx + r.maxx) / 2, (r.miny + r.maxy) / 2) : loc(0, 0)),
    GetUnitRallyLoc: () => null,
    GetSpellTargetLoc_: () => null,
    RemoveLocation: () => {},
    MoveLocation: (l, x, y) => { if (l) { l.x = x; l.y = y; } },
    GetLocationX: (l) => (l && typeof l.x === 'number' ? l.x : 0),
    GetLocationY: (l) => (l && typeof l.y === 'number' ? l.y : 0),
    GetLocationZ: (l) => (l ? W().terrainZ(l.x, l.y) : 0),
    Rect: (a, b, c, d) => H('rect', { minx: a, miny: b, maxx: c, maxy: d }),
    RectFromLoc: (a, b) => H('rect', { minx: Math.min(a.x, b.x), miny: Math.min(a.y, b.y),
                                       maxx: Math.max(a.x, b.x), maxy: Math.max(a.y, b.y) }),
    RemoveRect: () => {}, SetRect: (r, a, b, c, d) => { Object.assign(r, { minx: a, miny: b, maxx: c, maxy: d }); },
    GetRectMinX: (r) => r.minx, GetRectMinY: (r) => r.miny,
    GetRectMaxX: (r) => r.maxx, GetRectMaxY: (r) => r.maxy,
    GetRectCenterX: (r) => (r.minx + r.maxx) / 2, GetRectCenterY: (r) => (r.miny + r.maxy) / 2,
    GetWorldBounds: () => H('rect', W().bounds()),
    CreateRegion: () => H('region', { rects: [] }),
    RegionAddRect: (rg, r) => { rg.rects.push(r); },
    RemoveRegion: () => {},
    GetTerrainCliffLevel: () => 2,
    GetTerrainType: () => 0, GetTerrainVariance: () => 0,
    SetTerrainType: () => {},
    IsTerrainPathable: (x, y, t) => !W().walkable(x, y),
    GetLocationZ_: () => 0,

    // ----------------------------------------------------------------- units
    CreateUnit: (p, id, x, y, face) => {
      // 诊断: 记录初始单位创建 (Terenas 接线)
      if (['htow','hpea','hfoo','harr','ngol','ntrv'].includes(id)) console.log('[init]', id, '-> player', p ? p.index : 'null');
      return W().createUnit(p, id, x, y, face);
    },
    CreateUnitAtLoc: (p, id, l, face) => W().createUnit(p, id, l ? l.x : 0, l ? l.y : 0, face),
    CreateUnitByName: (p, name, x, y, f) => W().createUnit(p, name, x, y, f),
    KillUnit: (u) => W().killUnit(u, null),
    RemoveUnit: (u) => W().removeUnit(u),
    ShowUnit: (u, show) => { if (u) u.hidden = !show; },
    GetUnitX: (u) => (u ? u.x : 0), GetUnitY: (u) => (u ? u.y : 0),
    IsFogEnabled: () => false, IsFogMaskEnabled: () => false,
    SetUnitX: (u, x) => W().moveUnit(u, x, u ? u.y : 0),
    SetUnitY: (u, y) => W().moveUnit(u, u ? u.x : 0, y),
    SetUnitPosition: (u, x, y) => W().moveUnit(u, x, y),
    // a null location is a no-op in Warcraft III, not a move to the map origin
    SetUnitPositionLoc: (u, l) => { if (u && l) W().moveUnit(u, l.x, l.y); },
    SetUnitPositionLocFacingBJ: (u, l, f) => {
      W().moveUnit(u, l ? l.x : 0, l ? l.y : 0);
      if (u) u.facing = (f || 0) * DEG;
    },
    GetUnitFacing: (u) => (u ? u.facing * RAD : 0),
    SetUnitFacing: (u, d) => { if (u) u.facing = d * DEG; },
    SetUnitFacingTimed: (u, d) => { if (u) u.facing = d * DEG; },
    GetUnitTypeId: (u) => (u ? u.typeId : 0),
    GetUnitName: (u) => (u ? u.name : ''),
    GetOwningPlayer: (u) => (u ? eng.players[u.playerIndex] : P(0)),
    SetUnitOwner: (u, p, col) => {
      if (!u || !p) return;
      if (u.typeKey === 'htow' || u.typeKey === 'hpea') console.log('[owner]', u.typeKey, u.id, '->', p.index);
      u.playerIndex = p.index; u.team = p.team;
      const key = eng.eventId('EVENT_PLAYER_UNIT_CHANGE_OWNER');
      if (key != null) eng.fire(key, { unit: u, player: p });
    },
    GetUnitState: (u, st) => W().unitState(u, st && st.v),
    SetUnitState: (u, st, v) => W().setUnitState(u, st && st.v, v),
    GetUnitLifePercent: (u) => (u && u.maxHp ? (u.hp / u.maxHp) * 100 : 0),
    GetUnitManaPercent: (u) => (u && u.maxMana ? (u.mana / u.maxMana) * 100 : 0),
    SetUnitLifePercentBJ: (u, pct) => { if (u) u.hp = (u.maxHp * pct) / 100; },
    SetUnitManaPercentBJ: (u, pct) => { if (u) u.mana = (u.maxMana * pct) / 100; },
    UnitAddAbility: (u, id) => W().addAbility(u, id),
    UnitRemoveAbility: (u, id) => W().removeAbility(u, id),
    UnitMakeAbilityPermanent: () => true,
    GetUnitAbilityLevel: (u, id) => W().abilityLevel(u, id),
    SetUnitAbilityLevel: (u, id, lv) => W().setAbilityLevel(u, id, lv),
    DecUnitAbilityLevel: (u, id) => W().setAbilityLevel(u, id, W().abilityLevel(u, id) - 1),
    IncUnitAbilityLevel: (u, id) => W().setAbilityLevel(u, id, W().abilityLevel(u, id) + 1),
    UnitResetCooldown: (u) => W().resetCooldowns(u),
    IsUnitType: (u, t) => W().isUnitType(u, t && t.v),
    IsUnit: (a, b) => a === b,
    // An illusion is a unit this engine made as one: world.summon takes
    // { image: true } for the Mirror Image family (AOmi) and stamps u.isImage
    // there, along with the Omi2/Omi3 damage-dealt and damage-taken factors
    // that are the whole difference between an image and the hero. So the
    // answer is in our own model and needs nothing from the archives.
    // It was declared in common.j and implemented nowhere, which means it
    // returned false for every unit forever -- and a JASS condition that is
    // always false fails closed silently. Itachi's 사륜안 is exactly that: its
    // whole payload is an enumeration filtered on this native, so the ability
    // marked nothing, and a 30-second cooldown bought a puff of art.
    IsUnitIllusion: (u) => !!(u && u.isImage),
    IsUnitAlly: (u, p) => !!u && W().isAlly(eng.players[u.playerIndex], p),
    IsUnitEnemy: (u, p) => !!u && !W().isAlly(eng.players[u.playerIndex], p),
    IsUnitInRange: (a, b, r) => !!a && !!b && Math.hypot(a.x - b.x, a.y - b.y) <= r,
    IsUnitInRangeXY: (u, x, y, r) => !!u && Math.hypot(u.x - x, u.y - y) <= r,
    IsUnitInRangeLoc: (u, l, r) => !!u && !!l && Math.hypot(u.x - l.x, u.y - l.y) <= r,
    IsUnitVisible: () => true, IsUnitHidden: (u) => !!(u && u.hidden),
    IsUnitSelected: () => false,
    UnitAlive: (u) => !!(u && u.alive),
    PauseUnit: (u, on) => { if (u) u.paused = !!on; },
    SetUnitInvulnerable: (u, on) => { if (u) u.invulnerable = !!on; },
    SetUnitAnimation: (u, s) => eng.emit({ t: 'anim', id: u && u.id, name: s }),
    SetUnitAnimationByIndex: (u, i) => eng.emit({ t: 'animIdx', id: u && u.id, i }),
    // "spell" then a queued "stand": the winner's flourish after a duel. The
    // client plays the queued clip when the current one-shot ends.
    QueueUnitAnimation: (u, s) => eng.emit({ t: 'animQueue', id: u && u.id, name: s }),
    // Animation speed. Blizzard.j's SetUnitTimeScalePercent divides by 100
    // before this, so what arrives is already a multiplier: this map asks for
    // 36 of them between 0 and 2, and two of those are 0 -- a unit frozen mid
    // animation, which is a visible state and not a no-op.
    SetUnitTimeScale: (u, s) => {
      if (u) eng.emit({ t: 'timeScale', id: u.id, s: Math.max(0, +s || 0) });
    },
    SetUnitBlendTime: () => {},
    SetUnitScale: (u, x) => { if (u) u.renderScale = x; },
    SetUnitVertexColor: (u, r, g, b, a) => eng.emit({ t: 'tint', id: u && u.id, r, g, b, a }),
    SetUnitFlyHeight: (u, h) => { if (u) u.flyHeight = h; },
    GetUnitFlyHeight: (u) => (u ? u.flyHeight || 0 : 0),
    SetUnitMoveSpeed: (u, s) => {
      if (!u || !Number.isFinite(s)) return;
      W().removeAuraStats(u);
      u.baseMoveSpeed = u.moveSpeed = s;
      W().applyAuraStats(u);
    },
    GetUnitMoveSpeed: (u) => (u ? u.moveSpeed : 0),
    GetUnitDefaultMoveSpeed: (u) => (u ? u.baseMoveSpeed : 0),
    SetUnitTurnSpeed: (u, rate) => {
      if (u && Number.isFinite(rate)) u.turnRate = Math.max(0, rate);
    },
    GetUnitTurnSpeed: u => u?.turnRate ?? 0,
    UnitAddType: () => true, UnitRemoveType: () => true,
    SetUnitUseFood: () => {},
    GetUnitPointValue: (u) => (u ? u.level * 10 : 0),
    SetUnitUserData: (u, v) => { if (u) u.userData = trunc(v); },
    GetUnitUserData: (u) => (u ? u.userData || 0 : 0),
    UnitDamageTarget: (src, tgt, amt, attack, ranged, at, dt, wt) =>
      W().damage(src, tgt, amt, { attackType: at, damageType: dt }) > 0,
    UnitDamagePoint: (src, delay, radius, x, y, amt, attack, ranged, at, dt, wt) => {
      for (const u of W().enumInRange(x, y, radius))
        W().damage(src, u, amt, { attackType: at, damageType: dt });
      return true;
    },
    UnitApplyTimedLife: (u, buffId, dur) => { if (u) u.expireAt = eng.now + dur * 1000; },
    UnitShareVision: () => {}, UnitSuspendDecay: () => {},
    SetUnitExploded: () => {},
    GetHeroLevel: (u) => (u ? u.level : 0),
    SetHeroLevel: (u, lv, show) => W().setHeroLevel(u, lv),
    GetHeroXP: (u) => (u ? u.xp : 0),
    SetHeroXP: (u, xp) => { if (u) { u.xp = xp; W().checkLevel(u); } },
    AddHeroXP: (u, xp, show) => W().addXp(u, xp),
    GetHeroStr: (u, incl) => (u ? Math.round(u.strTotal ?? u.str) : 0),
    GetHeroAgi: (u, incl) => (u ? Math.round(u.agiTotal ?? u.agi) : 0),
    GetHeroInt: (u, incl) => (u ? Math.round(u.intTotal ?? u.intel) : 0),
    SetHeroStr: (u, v, perm) => { if (u) { u.str = v; W().recalc(u); } },
    SetHeroAgi: (u, v, perm) => { if (u) { u.agi = v; W().recalc(u); } },
    SetHeroInt: (u, v, perm) => { if (u) { u.intel = v; W().recalc(u); } },
    UnitStripHeroLevel: (u, n) => W().stripHeroLevel(u, n),
    GetHeroSkillPoints: (u) => (u ? u.skillPoints : 0),
    UnitModifySkillPoints: (u, n) => { if (u) u.skillPoints += trunc(n); return true; },
    SelectHeroSkill: (u, id) => W().learnSkill(u, id),
    SuspendHeroXP: () => {}, IsSuspendedXP: () => false,
    ReviveHero: (u, x, y, show) => W().reviveUnit(u, x, y),
    ReviveHeroLoc: (u, l, show) => W().reviveUnit(u, l ? l.x : 0, l ? l.y : 0),
    IsHeroUnitId: (id) => W().isHeroType(id),
    GetUnitRallyPoint: () => null,
    GetHeroProperName: (u) => (u ? u.properName || u.name : ''),

    // --------------------------------------------------------------- orders
    IssueImmediateOrder: (u, s) => W().order(u, { type: s }),
    IssueImmediateOrderById: (u, id) => W().order(u, { type: id }),
    IssuePointOrder: (u, s, x, y) => W().order(u, { type: s, x, y }),
    IssuePointOrderById: (u, id, x, y) => W().order(u, { type: id, x, y }),
    IssuePointOrderLoc: (u, s2, l) => W().order(u, { type: s2, x: l && l.x, y: l && l.y }),
    IssuePointOrderByIdLoc: (u, id, l) => W().order(u, { type: id, x: l && l.x, y: l && l.y }),
    IssueBuildOrderById: () => true,
    IssueInstantPointOrder: () => true, IssueInstantTargetOrder: () => true,
    IssueTargetOrder: (u, s, t) => W().order(u, { type: s, target: t }),
    IssueTargetOrderById: (u, id, t) => W().order(u, { type: id, target: t }),
    SetUnitPathing: (u, flag) => { if (u) u.pathingOff = !flag; },
    SetUnitAcquireRange: (u, r) => { if (u) u.acquireRange = r; },
    SetUnitColor: (u, c) => { if (u) u.color = c && c.v; },
    // waygates teleport units between arena sections in this map
    WaygateSetDestination: (u, x, y) => { if (u) u.waygate = { x, y, active: u.waygate?.active !== false }; },
    WaygateActivate: (u, on) => { if (u) { u.waygate = u.waygate || {}; u.waygate.active = !!on; } },
    WaygateGetDestinationX: (u) => (u && u.waygate ? u.waygate.x : 0),
    WaygateGetDestinationY: (u) => (u && u.waygate ? u.waygate.y : 0),
    WaygateIsActive: (u) => !!(u && u.waygate && u.waygate.active),
    UnitAddItemToSlotById: (u, id, slot) => {
      if (!u) return false;
      const it = W().createItem(id, u.x, u.y);
      u.items = u.items || [];
      u.items[slot] = it;
      return true;
    },

    // --------------------------------------------------------------- groups
    CreateGroup: () => H('group', { units: [] }),
    DestroyGroup: (g) => { if (g) g.units = []; },
    GroupAddUnit: (g, u) => { if (g && u && !g.units.includes(u)) g.units.push(u); return true; },
    GroupRemoveUnit: (g, u) => { if (g) g.units = g.units.filter((x) => x !== u); return true; },
    GroupClear: (g) => { if (g) g.units = []; },
    CountUnitsInGroup: (g) => (g ? g.units.length : 0),
    FirstOfGroup: (g) => (g && g.units.length ? g.units[0] : null),
    BlzGroupGetSize: (g) => (g ? g.units.length : 0),
    ForGroup: function* (g, cb) {
      if (!g || !cb) return;
      for (const u of [...g.units]) {
        eng.ctxStack.push(eng.ctx);
        eng.ctx = Object.assign({}, eng.ctx, { enumUnit: u });
        yield* vm.runFunction(cb.fn);
        eng.ctx = eng.ctxStack.pop();
      }
    },
    GroupEnumUnitsInRange: (g, x, y, r, filter) => fillGroup(g, W().enumInRange(x, y, r), filter),
    GroupEnumUnitsInRangeOfLoc: (g, l, r, filter) => fillGroup(g, W().enumInRange(l.x, l.y, r), filter),
    GroupEnumUnitsInRect: (g, r, filter) => fillGroup(g, W().enumInRect(r), filter),
    GroupEnumUnitsOfPlayer: (g, p, filter) => fillGroup(g, W().unitsOfPlayer(p), filter),
    // Warcraft III matches on the unit type's *name*, and Blizzard.j's
    // GetUnitsOfTypeIdAll round-trips a type id through UnitId2String to get it.
    // Returning every unit instead makes that helper a map-wide sweep: FOC uses
    // it to clear a spell's dummy units, so one cast removed the entire map.
    GroupEnumUnitsOfType: (g, name, filter) => {
      const want = String(name ?? '').trim().toLowerCase();
      if (!want) return fillGroup(g, [], filter);
      const of = W().allUnits().filter((u) => typeNameOf(u) === want);
      return fillGroup(g, of, filter);
    },
    GroupEnumUnitsSelected: (g) => fillGroup(g, [], null),
    GroupImmediateOrder: (g, s) => { for (const u of g.units) W().order(u, { type: s }); return true; },
    GroupPointOrder: (g, s, x, y) => { for (const u of g.units) W().order(u, { type: s, x, y }); return true; },
    GroupTargetOrder: (g, s, t) => { for (const u of g.units) W().order(u, { type: s, target: t }); return true; },
    GetEnumUnit: () => eng.ctx.enumUnit || null,
    GetFilterUnit: () => eng.ctx.filterUnit || eng.ctx.enumUnit || null,
    Filter: (c) => H('boolexpr', { fn: c && c.fn }),
    Condition: (c) => H('boolexpr', { fn: c && c.fn }),
    DestroyBoolExpr: () => {}, DestroyFilter: () => {},
    And: (a, b) => H('boolexpr', { and: [a, b] }),
    Or: (a, b) => H('boolexpr', { or: [a, b] }),
    Not: (a) => H('boolexpr', { not: a }),

    // ------------------------------------------------------------- triggers
    CreateTrigger: () => {
      const tr = H('trigger', { enabled: true, actions: [], conditions: [], events: [], eval: null });
      eng.triggers.push(tr); return tr;
    },
    DestroyTrigger: (tr) => { eng.triggers = eng.triggers.filter((t) => t !== tr); },
    ResetTrigger: (tr) => { if (tr) { tr.actions = []; tr.conditions = []; } },
    EnableTrigger: (tr) => { if (tr) tr.enabled = true; },
    DisableTrigger: (tr) => { if (tr) tr.enabled = false; },
    IsTriggerEnabled: (tr) => !!(tr && tr.enabled),
    TriggerAddAction: (tr, c) => { if (tr && c) tr.actions.push({ fn: c.fn }); return H('triggeraction', {}); },
    TriggerAddCondition: (tr, b) => { if (tr && b && b.fn) tr.conditions.push({ fn: b.fn }); return H('triggercondition', {}); },
    TriggerClearActions: (tr) => { if (tr) tr.actions = []; },
    TriggerClearConditions: (tr) => { if (tr) tr.conditions = []; },
    TriggerRemoveAction: () => true, TriggerRemoveCondition: () => true,
    TriggerExecute: function* (tr) { eng.execTrigger(tr, {}); },
    TriggerEvaluate: (tr) => {
      if (!tr) return false;
      for (const c of tr.conditions) {
        const g = vm.runFunction(c.fn); let r = g.next();
        while (!r.done) r = g.next();
        if (!r.value) return false;
      }
      return true;
    },
    TriggerSleepAction: function* (sec) { yield { sleep: sec }; },
    /** Run a function by name in a fresh thread, as Warcraft III does. */
    ExecuteFunc: (name) => {
      if (typeof name !== 'string' || !vm.functions.has(name)) return;
      eng.runThread(vm.runFunction(name), 'exec:' + name);
    },
    TriggerWaitForSound: function* () { yield { sleep: 0.1 }; },
    TriggerRegisterTimerEvent: (tr, timeout, periodic) => {
      if (!tr) return null;
      eng.timers.push({ trigger: tr, periodMs: timeout * 1000, periodic: !!periodic,
                        nextAt: eng.now + timeout * 1000 });
      return H('event', {});
    },
    TriggerRegisterTimerExpireEvent: (tr, t) => {
      if (t) t.trigger = tr;
      return H('event', {});
    },
    TriggerRegisterGameStateEvent: () => H('event', {}),
    TriggerRegisterDialogEvent: () => H('event', {}),
    TriggerRegisterDialogButtonEvent: () => H('event', {}),
    TriggerRegisterGameEvent: () => H('event', {}),
    TriggerRegisterEnterRegion: (tr, rg, filter) => {
      if (!tr) return null;
      for (const r of (rg ? rg.rects : [])) tr.events.push({ kind: 'enter', rect: r, filter });
      return H('event', {});
    },
    TriggerRegisterLeaveRegion: (tr, rg, filter) => {
      if (!tr) return null;
      for (const r of (rg ? rg.rects : [])) tr.events.push({ kind: 'leave', rect: r, filter });
      return H('event', {});
    },
    TriggerRegisterUnitInRange: (tr, u, r, filter) => {
      if (!tr) return null;
      tr.events.push({ kind: 'unitInRange', unit: u, range: r, filter }); return H('event', {});
    },
    TriggerRegisterPlayerEvent: (tr, p, ev) => {
      if (!tr) return null;
      tr.events.push({ kind: evKey(ev), playerIndex: p && p.index });
      return H('event', {});
    },
    TriggerRegisterPlayerUnitEvent: (tr, p, ev, filter) => {
      if (!tr) return null;
      tr.events.push({ kind: evKey(ev), playerIndex: p && p.index, filter });
      return H('event', {});
    },
    TriggerRegisterPlayerAllianceChange: () => H('event', {}),
    TriggerRegisterPlayerStateEvent: () => H('event', {}),
    TriggerRegisterPlayerChatEvent: (tr, p, s, exact) => {
      if (!tr) return null;
      tr.events.push({ kind: 'chat', playerIndex: p && p.index, chat: s, exact: !!exact });
      return H('event', {});
    },
    TriggerRegisterUnitEvent: (tr, u, ev) => {
      if (!tr) return null;
      tr.events.push({ kind: evKey(ev), unit: u }); return H('event', {});
    },
    TriggerRegisterUnitStateEvent: () => H('event', {}),
    TriggerRegisterDeathEvent: (tr, w) => { if (!tr) return null; tr.events.push({ kind: 'widgetDeath', unit: w }); return H('event', {}); },

    // -------------------------------------------------------- event getters
    GetTriggeringTrigger: () => eng.ctx.triggeringTrigger || null,
    GetTriggerUnit: () => eng.ctx.unit || null,
    GetTriggerPlayer: () => eng.ctx.player || null,
    GetTriggerWidget: () => eng.ctx.unit || null,
    GetSpellAbilityId: () => eng.ctx.spellId || 0,
    GetSpellAbilityUnit: () => eng.ctx.unit || null,
    GetSpellTargetUnit: () => eng.ctx.targetUnit || null,
    GetSpellTargetX: () => eng.ctx.targetX || 0,
    GetSpellTargetY: () => eng.ctx.targetY || 0,
    GetSpellTargetLoc: () => loc(eng.ctx.targetX || 0, eng.ctx.targetY || 0),
    GetSpellAbility: () => null,
    GetAttacker: () => eng.ctx.attacker || null,
    GetAttackedUnitBJ: () => eng.ctx.unit || null,
    GetDyingUnit: () => eng.ctx.unit || null,
    GetKillingUnit: () => eng.ctx.killer || null,
    GetDecayingUnit: () => eng.ctx.unit || null,
    GetEnteringUnit: () => eng.ctx.unit || null,
    GetLeavingUnit: () => eng.ctx.unit || null,
    GetLevelingUnit: () => eng.ctx.unit || null,
    GetLearningUnit: () => eng.ctx.unit || null,
    GetLearnedSkill: () => eng.ctx.skillId || 0,
    GetLearnedSkillLevel: () => eng.ctx.skillLevel || 1,
    GetRevivableUnit: () => eng.ctx.unit || null,
    GetRevivingUnit: () => eng.ctx.unit || null,
    GetSummoningUnit: () => eng.ctx.unit || null,
    GetSummonedUnit: () => eng.ctx.summoned || null,
    GetTransportUnit: () => null, GetLoadedUnit: () => null,
    GetSellingUnit: () => eng.ctx.seller || null,
    GetSoldUnit: () => eng.ctx.sold || null,
    GetBuyingUnit: () => eng.ctx.buyer || null,
    GetSoldItem: () => eng.ctx.soldItem || null,
    GetChangingUnit: () => eng.ctx.unit || null,
    GetManipulatingUnit: () => eng.ctx.unit || null,
    GetManipulatedItem: () => eng.ctx.item || null,
    GetOrderedUnit: () => eng.ctx.unit || null,
    GetIssuedOrderId: () => eng.ctx.orderId || 0,
    GetOrderPointX: () => eng.ctx.orderX || 0,
    GetOrderPointY: () => eng.ctx.orderY || 0,
    GetOrderPointLoc: () => loc(eng.ctx.orderX || 0, eng.ctx.orderY || 0),
    GetOrderTarget: () => eng.ctx.orderTarget || null,
    GetOrderTargetUnit: () => eng.ctx.orderTarget || null,
    GetEventDamage: () => eng.ctx.damage || 0,
    GetEventDamageSource: () => eng.ctx.damageSource || null,
    GetEventTargetUnit: () => eng.ctx.targetUnit || null,
    GetEventPlayerState: () => H('playerstate', { v: 0 }),
    GetEventPlayerChatString: () => eng.ctx.chat || '',
    GetEventPlayerChatStringMatched: () => eng.ctx.chatMatched || eng.ctx.chat || '',
    GetClickedButton: () => null, GetClickedDialog: () => null,
    GetExpiredTimer: () => eng.ctx.expiredTimer || null,
    GetTriggerExecCount: () => 1,

    // --------------------------------------------------------------- timers
    CreateTimer: () => H('timer', { periodMs: 0, periodic: false, nextAt: Infinity, paused: true }),
    DestroyTimer: (t) => { if (t) t.dead = true; },
    TimerStart: (t, timeout, periodic, handler) => {
      if (!t) return;
      Object.assign(t, { periodMs: timeout * 1000, periodic: !!periodic,
                         nextAt: eng.now + timeout * 1000, paused: false, dead: false,
                         handler: handler || t.handler, started: eng.now });
      if (!eng.timers.includes(t)) eng.timers.push(t);
    },
    // `started` is a timestamp, and the one that matters here is 0: this map
    // starts its stopwatch during init. `started || eng.now` therefore falls
    // through to now and reports zero elapsed forever, which left the map's
    // polled wait unable to converge -- and with it the creep-wave escalation,
    // which is a five-minute wait.
    TimerGetElapsed: (t) => (t ? (eng.now - (t.started ?? eng.now)) / 1000 : 0),
    TimerGetRemaining: (t) => (t ? Math.max(0, (t.nextAt - eng.now) / 1000) : 0),
    TimerGetTimeout: (t) => (t ? t.periodMs / 1000 : 0),
    PauseTimer: (t) => { if (t) t.paused = true; },
    ResumeTimer: (t) => { if (t) { t.paused = false; t.nextAt = eng.now + t.periodMs; } },
    // Warcraft III's countdown clock, top-right. This map uses one for the duel
    // -- "Duel in", 290-310s -- and it was the only way a player could tell how
    // long was left. The natives used to be accepted and thrown away.
    CreateTimerDialog: (t) => {
      const d = H('timerdialog', { timer: t || null, title: '', shown: false });
      eng.timerDialogs.push(d);
      return d;
    },
    TimerDialogDisplay: (d, show) => { if (d) d.shown = !!show; },
    TimerDialogSetTitle: (d, title) => { if (d) d.title = String(title == null ? '' : title); },
    DestroyTimerDialog: (d) => {
      if (!d) return;
      d.shown = false;
      const i = eng.timerDialogs.indexOf(d);
      if (i >= 0) eng.timerDialogs.splice(i, 1);
    },
    PolledWait: function* (sec) { yield { sleep: sec }; },

    // -------------------------------------------------------------- effects
    // Effects carry an id: several may share one model path at a time, so
    // DestroyEffect has to name the exact instance the client should drop.
    AddSpecialEffect: (path, x, y) => { const h = H('effect', { path, x, y, fx: ++eng.fxSeq });
      eng.emit({ t: 'sfx', fx: h.fx, path, x, y }); return h; },
    AddSpecialEffectLoc: (path, l) => N.AddSpecialEffect(path, l ? l.x : 0, l ? l.y : 0),
    AddSpecialEffectTarget: (path, u, attach) => {
      const h = H('effect', { path, unit: u, attach, fx: ++eng.fxSeq });
      eng.emit({ t: 'sfxUnit', fx: h.fx, path, id: u && u.id, attach }); return h; },
    DestroyEffect: (e) => { if (e) eng.emit({ t: 'sfxEnd', fx: e.fx, path: e.path }); },
    AddLightning: (code, checkVis, x1, y1, x2, y2) => { const h = H('lightning', { code, x1, y1, x2, y2 });
      eng.emit({ t: 'lightning', code, x1, y1, x2, y2 }); return h; },
    AddLightningEx: (code, cv, x1, y1, z1, x2, y2, z2) => N.AddLightning(code, cv, x1, y1, x2, y2),
    MoveLightning: () => true, MoveLightningEx: () => true,
    DestroyLightning: () => true,
    SetLightningColor: () => true, GetLightningColorA: () => 1,
    // Crater is the only one of the family this map reaches with anything to
    // show: 4 of its 6 TerrainDeform calls, all through Blizzard.j's real
    // TerrainDeformationCraterBJ, which passes duration in ms.  Gaara (A03O)
    // and Kisame (A069) each dig one and cancel it about ten seconds later
    // with a second, negative-depth crater at the same point -- so the sign
    // matters, and Blizzard states it rather than leaving it to be guessed:
    // TriggerStrings.txt's CraterBJ hint reads "Depth may be negative for
    // bumps", making a positive depth a pit.
    //
    // The simulation cannot observe any of this.  The server's own heightfield
    // is read by exactly one native, GetLocationZ, and war3map.j never calls
    // it, so the deformation is the client's alone and nothing desynchronises.
    TerrainDeformCrater: (x, y, radius, depth, duration, permanent) => {
      const h = H('terraindeformation', { x, y, radius, depth });
      eng.emit({ t: 'terrainDeform', shape: 'crater', x, y,
                 r: radius, depth, ms: duration, permanent: !!permanent });
      return h;
    },
    TerrainDeformRipple: () => null,
    TerrainDeformWave: () => null, TerrainDeformStop: () => {},
    AddWeatherEffect: () => H('weathereffect', {}),
    EnableWeatherEffect: () => {}, RemoveWeatherEffect: () => {},

    // ---------------------------------------------------------------- items
    CreateItem: (id, x, y) => W().createItem(id, x, y),
    RemoveItem: (i) => W().removeItem(i),
    UnitAddItem: (u, it) => W().giveItem(u, it),
    UnitAddItemById: (u, id) => W().giveItem(u, W().createItem(id, u.x, u.y)),
    UnitRemoveItem: (u, it) => W().dropItem(u, it),
    UnitRemoveItemFromSlot: (u, s) => W().dropItemSlot(u, s),
    UnitItemInSlot: (u, s) => (u && u.items ? u.items[s] || null : null),
    UnitInventorySize: (u) => 6,
    GetItemTypeId: (i) => (i ? i.typeId : 0),
    UnitHasItem: (u, it) => !!(u && it && u.items && u.items.includes(it)),
    GetOrderTargetItem: () => eng.ctx.orderTargetItem || null,
    GetItemName: (i) => (i ? i.name : ''),
    SetItemPosition: (i, x, y) => { if (i) { i.x = x; i.y = y; } },
    SetItemVisible: () => {}, SetItemDropOnDeath: () => {},
    GetItemCharges: (i) => (i ? i.charges || 0 : 0),
    SetItemCharges: (i, n) => { if (i) i.charges = n; },
    UnitUseItem: () => true, UnitUseItemPoint: () => true, UnitUseItemTarget: () => true,
    ItemPlayerColor: () => {},
    // An integer the script hangs on an item and reads back. This map's Monster
    // Ball is built on it: capturing a unit hides and pauses it, parks it in
    // udg_units07[n], hands the captor an I008 (몬스터볼(포획상태)) and stamps n
    // on that ball. Using, dropping or selling the ball then loops n = 1..count
    // and matches on GetItemUserData. Stubbed, every ball read back as 0 and no
    // iteration ever matched, so a captured unit could never be let out again --
    // capturing one deleted it from the game and paid you a useless ball.
    SetItemUserData: (i, d) => { if (i) i.userData = trunc(d); },
    GetItemUserData: (i) => (i ? i.userData || 0 : 0),

    // ------------------------------------------- cosmetic / UI (client-side)
    DisplayTextToPlayer: (p, x, y, s) =>
      eng.emit({ t: 'text', player: p && p.index, s: resolveTrigstr(s) }),
    DisplayTimedTextToPlayer: (p, x, y, dur, s) =>
      eng.emit({ t: 'text', player: p && p.index, s: resolveTrigstr(s), dur }),
    ClearTextMessages: () => {},
    // ----------------------------------------------------------- text tags
    // Warcraft III's floating text: the spell-name shouts over a caster, the
    // duel arena's 3-2-1-Fight, "Winner is <hero>", and the permanent lane and
    // shop labels. The map makes 48 of them and never calls a native directly
    // -- every site is the World Editor's own action group, which is
    // CreateTextTag{Loc,Unit}BJ and then, for 26 of the 48, velocity,
    // permanent, lifespan and fadepoint in that order.
    //
    // So nothing is sent when the tag is created: it would be sent empty. The
    // tag is marked dirty and flushed with its finished state at the end of the
    // tick, which is always the same tick -- no site sleeps mid-group.
    //
    // The units are Warcraft III's. Blizzard.j converts into the 0.8 x 0.6
    // screen box the FDF layouts use (tools/fdf.py): TextTagSize2Height is
    // `size * 0.023 / 10` and TextTagSpeed2Velocity is `speed * 0.071 / 128`.
    // They are passed on as they arrive and the client divides through by that
    // box, exactly as tools/uiframe.py does for the console.
    CreateTextTag: () => {
      // Warcraft III's defaults: opaque white, still, and permanent. Permanent
      // is the one that matters -- 22 of the map's 48 tags never get a
      // lifespan, because they are the scenery labels and are meant to stay.
      const h = H('texttag', { tt: ++eng.ttSeq, text: '', x: 0, y: 0, z: 0,
                               height: 0, color: [255, 255, 255, 255],
                               xvel: 0, yvel: 0, life: 0, fade: 0, age: 0,
                               permanent: true, visible: true });
      eng.textTags.set(h.tt, h);
      eng.dirtyTags.add(h);
      return h;
    },
    SetTextTagText: (t, s, h) => eng.touchTag(t, () => {
      t.text = resolveTrigstr(s); t.height = +h || 0; }),
    SetTextTagPos: (t, x, y, z) => eng.touchTag(t, () => {
      t.x = +x || 0; t.y = +y || 0; t.z = +z || 0; }),
    // Warcraft III places the tag where the unit stands and leaves it there --
    // it is a position, not an attachment. Every one of the map's unit tags
    // also sets a velocity, which is what carries the text off the caster.
    SetTextTagPosUnit: (t, u, z) => eng.touchTag(t, () => {
      if (u) { t.x = u.x; t.y = u.y; } t.z = +z || 0; }),
    SetTextTagColor: (t, r, g, b, a) => eng.touchTag(t, () => {
      t.color = [trunc(r), trunc(g), trunc(b), trunc(a)]; }),
    SetTextTagVelocity: (t, xv, yv) => eng.touchTag(t, () => {
      t.xvel = +xv || 0; t.yvel = +yv || 0; }),
    // Warcraft III can hide a tag from some players and not others, through
    // ShowTextTagForceBJ and its GetLocalPlayer test. This map never does --
    // no ShowTextTagForceBJ, no SetTextTagVisibility -- so visibility here is
    // one flag for everyone, and a per-player one would be untested guesswork.
    SetTextTagVisibility: (t, f) => eng.touchTag(t, () => { t.visible = !!f; }),
    SetTextTagFadepoint: (t, s) => eng.touchTag(t, () => { t.fade = +s || 0; }),
    SetTextTagLifespan: (t, s) => eng.touchTag(t, () => { t.life = +s || 0; }),
    SetTextTagPermanent: (t, f) => eng.touchTag(t, () => { t.permanent = !!f; }),
    SetTextTagAge: (t, s) => eng.touchTag(t, () => { t.age = +s || 0; }),
    // Suspending hides the tag without ageing it. Nothing in this map suspends
    // one; it is here so that a tag which is suspended does not simply vanish
    // from the protocol as though it had been destroyed.
    SetTextTagSuspended: (t, f) => eng.touchTag(t, () => { t.suspended = !!f; }),
    DestroyTextTag: (t) => eng.touchTag(t, () => { t.dead = true; }),
    CreateSound: (path, looping, is3d, stopOO, fade1, fade2, eax) =>
      H('sound', { path, looping, volume: 127, pitch: 1, snd: ++eng.sndSeq }),
    CreateSoundFilenameWithLabel: (p) => H('sound', { path: p }),
    CreateMIDISound: () => H('sound', {}),
    SetSoundDuration: (s, d) => { if (s) s.duration = d; },
    SetSoundChannel: (s, c) => { if (s) s.channel = c; },
    SetSoundVolume: (s, v) => { if (s) s.volume = v; },
    SetSoundPitch: (s, p) => { if (s) s.pitch = p; },
    SetSoundPosition: (s, x, y, z) => { if (s) { s.x = x; s.y = y; } },
    SetSoundDistances: () => {}, SetSoundConeAngles: () => {},
    SetSoundConeOrientation: () => {}, SetSoundDistanceCutoff: () => {},
    AttachSoundToUnit: (s, u) => { if (s) s.unit = u; },
    StartSound: (s) => {
      if (!s) return;
      eng.emit({ t: 'sound', path: soundKey(s.path),
                 x: s.x, y: s.y, id: s.unit && s.unit.id,
                 vol: (s.volume ?? 127) / 127, pitch: s.pitch ?? 1,
                 loop: !!s.looping, snd: s.snd });
    },
    // The map stops its own sounds, and this map's whole score depends on it:
    // udg_sound41 is HumanX1.mp3, created looping and 4 minutes 44 long, and
    // StopSoundBJ is what silences it when a team wins so the victory sting can
    // play. With this a stub the score could never stop.
    StopSound: (s, killWhenDone, fade) => {
      if (s && s.snd) eng.emit({ t: 'soundStop', snd: s.snd, fade: !!fade });
    },
    KillSoundWhenDone: () => {},
    // The row's own volume and pitch on top of a sound the script made from a
    // file. This map applies it to the countdown tick (ChatroomTimerTick, 80
    // of 127), the "Fight!!" sting (QuestNew, 80) and the intro score
    // (CreditsMusic, 120). Volume is in the same 0..127 the sound already
    // carries, so PlaySound's division by 127 applies unchanged.
    SetSoundParamsFromLabel: (s, label) => {
      if (!SOUND_LABELS) SOUND_LABELS = loadIndex(['data/soundlabels.json', 'public/data/soundlabels.json']);
      const row = SOUND_LABELS[String(label || '')];
      if (!s || !row) return;
      s.volume = row.vol;
      if (row.pitch != null) s.pitch = row.pitch;
    },
    RegisterStackedSound: () => {},
    // ---- ambience and music
    //
    // Warcraft III crossfades between the day theme and the night theme as the
    // clock turns. The clock does not turn here (see SetTimeOfDay), so the
    // theme for the hour it is fixed at is the one that plays; both are sent so
    // the client has them when it does turn.
    // ---- music.  The map sets it twice and it had never played.
    //
    // SetMapMusic(name, random, index): `name` is either the "Music" label,
    // which means the standard playlist, or a path to one track.  `random`
    // picks freely from the list and `index` is where a non-random list starts.
    // Warcraft III keeps playing the list after the track ends, which is why
    // the whole list goes to the client rather than one file.
    // SetMapMusic SETS the list; it does not play over what the map is already
    // playing. Reported from play as two songs at once, and the map settles it:
    // it creates HumanX1.mp3 as a LOOPING sound of 4 minutes 44 (udg_sound41),
    // starts it with PlaySoundBJ when a mode begins and stops it with
    // StopSoundBJ when a team wins, at which point NightElfVictory plays. That
    // is a score the map runs itself, through the sound system rather than the
    // music system, and Blizzard's standard playlist on top of it is a second
    // stream. The list is still sent, so ResumeMusic and the client have it.
    SetMapMusic: (name, random, index) => {
      const list = /^music$/i.test(String(name || '')) ? musicList()
                                                       : [soundKey(name)].filter(Boolean);
      if (!list.length) return;
      const ev = { t: 'music', set: true, list, random: !!random,
                   index: Math.max(0, Math.min(list.length - 1, index | 0)) };
      eng.atmosphere.music = ev;
      eng.emit(ev);
    },
    PlayMusic: (name) => {
      const f = soundKey(name);
      if (f) eng.emit({ t: 'music', list: [f], random: false, index: 0 });
    },
    PlayThematicMusic: (name) => {
      const f = soundKey(name);
      if (f) eng.emit({ t: 'music', list: [f], random: false, index: 0 });
    },
    StopMusic: (fade) => eng.emit({ t: 'music', stop: true, fade: !!fade }),
    ResumeMusic: () => eng.emit({ t: 'music', resume: true }),
    SetMusicVolume: (v) => eng.emit({ t: 'music', volume: Math.max(0, Math.min(1, (v || 0) / 100)) }),
    VolumeGroupSetVolume: () => {}, VolumeGroupReset: () => {},
    // NewSoundEnvironment names the EAX reverb preset the themes are played
    // through. There is no reverb model here, so it stays a no-op rather than
    // pretending.
    NewSoundEnvironment: () => {},
    SetAmbientDaySound: (label) => setAmbient('day', label),
    SetAmbientNightSound: (label) => setAmbient('night', label),
    SetSoundVolumeBJ: () => {},
    SetCameraBounds: () => {}, SetCameraPosition: () => {}, SetCameraQuickPosition: () => {},
    SetCameraRotateMode: () => {},
    SetCameraField: () => {}, AdjustCameraField: () => {}, SetCameraTargetController: () => {},
    SetCameraOrientController: () => {}, CameraSetupApply: () => {},
    CameraSetupApplyForceDuration: () => {}, CreateCameraSetup: () => H('camerasetup', {}),
    CameraSetupSetField: () => {}, CameraSetupSetDestPosition: () => {},
    CameraSetSmoothingFactor: () => {},
    // Camera shake. The map asks for it 91 times -- every heavy landing, every
    // big spell -- and every one of those calls did nothing, which is most of
    // what an impact feels like. `magnitude` is how far the camera is thrown and
    // `velocity` how fast it rattles; the Ex forms add a vertical-only flag.
    CameraSetTargetNoise: (mag, vel) =>
      eng.emit({ t: 'camShake', mag: +mag || 0, vel: +vel || 0, vert: false }),
    CameraSetSourceNoise: (mag, vel) =>
      eng.emit({ t: 'camShake', mag: +mag || 0, vel: +vel || 0, vert: false }),
    CameraSetTargetNoiseEx: (mag, vel, vert) =>
      eng.emit({ t: 'camShake', mag: +mag || 0, vel: +vel || 0, vert: !!vert }),
    CameraSetSourceNoiseEx: (mag, vel, vert) =>
      eng.emit({ t: 'camShake', mag: +mag || 0, vel: +vel || 0, vert: !!vert }),
    // A shake is cleared by asking for one of magnitude zero, and this is the
    // other way the map ends one.
    // Scripted camera moves. The map makes 39 of them and every one goes
    // through PanCameraToTimedLocForPlayer, whose Blizzard.j body is wrapped in
    // `if GetLocalPlayer() == whichPlayer`. On a shared authoritative server
    // there is no local player -- GetLocalPlayer answers Player(0) -- so that
    // gate would drop 38 of the 39 before the native ever saw them.
    //
    // Intercepting the BJ instead keeps the player it was aimed at, and the
    // client shows the pan only to that one. Natives resolve before JASS
    // functions (vm.js call()), which is what makes the override take.
    PanCameraToTimedLocForPlayer: (p, loc, dur) => {
      if (loc) eng.emit({ t: 'panCamera', player: p && p.index,
                          x: loc.x, y: loc.y, dur: Math.max(0, +dur || 0) });
    },
    PanCameraToTimedLocWithZForPlayer: (p, loc, z, dur) =>
      N.PanCameraToTimedLocForPlayer(p, loc, dur),
    // The bare natives, for a caller that does not go through the BJ. Nothing
    // in this map does, so these are reach rather than measured behaviour.
    PanCameraToTimed: (x, y, dur) =>
      eng.emit({ t: 'panCamera', x, y, dur: Math.max(0, +dur || 0) }),
    PanCameraTo: (x, y) => eng.emit({ t: 'panCamera', x, y, dur: 0 }),
    PanCameraToTimedWithZ: (x, y, z, dur) => N.PanCameraToTimed(x, y, dur),
    PanCameraToWithZ: (x, y, z) => N.PanCameraToTimed(x, y, 0),
    ResetToGameCamera: () => eng.emit({ t: 'camShake', mag: 0, vel: 0, vert: false }),
    // The full-screen filter: a texture tinted from one colour to another over
    // a duration. Built up over eight setters and then shown, which is why the
    // state accumulates here and only DisplayCineFilter sends anything -- the
    // same shape as a text tag, except that the BJs put the display call last
    // so nothing has to be deferred to the end of the tick.
    //
    // The map uses it five times, all through CinematicFadeBJ or
    // CinematicFilterGenericBJ: three over White_mask, which is a plain white
    // square and so exactly a flat colour, and two over shaped masks
    // (DiagonalSlash, and a command-button icon). The client resolves their
    // texture paths through the staged index and preserves the authored alpha.
    // All five use BLEND_MODE_BLEND and UVs (0, 0, 1, 1); other blend modes
    // and animated UVs are still outside this map's implemented filter path.
    SetCineFilterTexture: (tex) => { CF().tex = String(tex || ''); },
    SetCineFilterBlendMode: (m) => { CF().blend = m && m.v != null ? m.v : m; },
    SetCineFilterStartUV: () => {}, SetCineFilterEndUV: () => {},
    SetCineFilterStartColor: (r, g, b, a) => {
      CF().from = [trunc(r), trunc(g), trunc(b), trunc(a)]; },
    SetCineFilterEndColor: (r, g, b, a) => {
      CF().to = [trunc(r), trunc(g), trunc(b), trunc(a)]; },
    SetCineFilterDuration: (d) => { CF().dur = Math.max(0, +d || 0); },
    DisplayCineFilter: (on) => {
      if (!on) { eng.emit({ t: 'cineFilterOff' }); return; }
      const f = CF();
      eng.emit({ t: 'cineFilter', tex: f.tex, blend: f.blend,
                 from: f.from, to: f.to, dur: f.dur });
    },
    // Every match opens inside cinematic mode: CinematicModeBJ(true) before the
    // 3-2-1 countdown and (false) after "Fight!!". Blizzard.j does the
    // player-visible half under `if IsPlayerInForce(GetLocalPlayer(), force)`,
    // and there is no local player on a shared server (see
    // PanCameraToTimedLocForPlayer), so the BJ is answered here with the force
    // still known and the client does the rest: the interface fades out over
    // bj_CINEMODE_INTERFACEFADE (0.50 s), letterbox bars close in, and the
    // player's control goes with it. The global half -- game speed lock, fog
    // off, dawn/dusk off, a fixed random seed -- has nothing to act on here:
    // no fog of war, no speed setting, and the clock does not turn. Not
    // carried: the BJ fades instantly before bj_gameStarted, which this map
    // never reaches -- the countdown is well after the start.
    CinematicModeBJ: (on, force) => {
      const players = force && force.players ? [...force.players].map((p) => p.index) : null;
      eng.emit({ t: 'cinematic', on: !!on, fade: 0.5, players });
    },
    ShowInterface: () => {},
    EnableUserControl: () => {}, EnableUserUI: () => {},
    EnableOcclusion: () => {}, EnableSelect: () => {}, EnableDragSelect: () => {},
    ForceUIKey: () => {}, ForceUICancel: () => {},
    ClearSelection: () => {}, SelectUnit: () => {},
    // All four of the map's calls hand a player a hero it just swapped or
    // brought back: Yusuke's H00T -> Eidm at 250 STR and AGI copies the stats
    // and items onto a NEW unit and removes the old one, and the other three
    // re-show a hero that ShowUnitHide had deselected. Blizzard.j's body is
    // gated on GetLocalPlayer, which answers Player(0) here, so the BJ is
    // overridden with the player still known. The room takes it from there:
    // the unit selected for a player is the unit that player controls, which
    // is how the port learns of the swap at all -- nothing else re-points a
    // player at a new hero once the match has started.
    SelectUnitForPlayerSingle: (u, p) => {
      if (u && p) eng.emit({ t: 'select', player: p.index, id: u.id });
    },
    SetUnitSelectionScale: () => {},
    // The two DNC models are not scenery: each holds one light, FDirectSun,
    // whose colour and ambient colour are animated across a sequence that IS
    // the day.  tools/daynight.py carries those curves into data/daynight.json;
    // the renderer had been lighting the world with three constants of its own.
    SetDayNightModels: (terrain, unit) => {
      // data/daynight.json is keyed by the path the script names, lower-cased
      // with backslashes and no extension
      const key = (p) => String(p || '').replace(/\//g, '\\')
        .replace(/\.[^.\\]*$/, '').toLowerCase();
      const ev = { t: 'daynight', terrain: key(terrain), unit: key(unit),
                   hour: eng.todHour ?? 12 };
      eng.atmosphere.daynight = ev;
      eng.emit(ev);
    },
    // Warcraft III's clock. The map never touches it -- 0 calls to
    // SetTimeOfDay, SuspendTimeOfDay, SetTimeOfDayScale or GetTimeOfDay in the
    // whole script -- and it does not advance here, because how long a full day
    // takes is not in any file the archives gave us: it is not in MiscGame.txt,
    // not in MiscData.txt, and the DNC sequence's own 60 seconds is the length
    // of the ANIMATION rather than of the day. So the hour stays where Warcraft
    // III starts a melee map and the light is sampled there, which is a figure
    // from the map's own model rather than a colour of ours. A map that does
    // drive the clock will find these working.
    SetTimeOfDay: (h) => {
      eng.todHour = Math.max(0, Math.min(24, +h || 0));
      eng.atmosphere.tod = { t: 'tod', hour: eng.todHour };
      eng.emit(eng.atmosphere.tod);
    },
    SetTimeOfDayScale: (f) => { eng.todScale = Math.max(0, +f || 0); },
    GetTimeOfDayScale: () => (eng.todScale === undefined ? 1 : eng.todScale),
    SuspendTimeOfDay: (b) => { eng.todSuspended = !!b; },
    // SetTerrainFogEx(style, zstart, zend, density, r, g, b).  The client had a
    // fog of its own -- 0x0b1018 from 4200 to 9000 -- and this map asks for
    // black from 3000 to 5000, so the constant was both the wrong colour and
    // the wrong distance.  Style and density are carried but not yet drawn:
    // style picks linear against exponential falloff, which three.js has, and
    // density only applies to the exponential ones.
    SetTerrainFogEx: (style, zstart, zend, density, r, g, b) => {
      const ev = { t: 'fog', style: style | 0, start: +zstart || 0, end: +zend || 0,
                   density: +density || 0,
                   color: [Math.round((+r || 0) * 255), Math.round((+g || 0) * 255),
                           Math.round((+b || 0) * 255)] };
      eng.atmosphere.fog = ev;
      eng.emit(ev);
    },
    ResetTerrainFog: () => {
      eng.atmosphere.fog = { t: 'fog', reset: true };
      eng.emit(eng.atmosphere.fog);
    },
    SetSkyModel: () => {}, GetTimeOfDay: () => (eng.todHour === undefined ? 12 : eng.todHour),
    CreateFogModifierRect: () => H('fogmodifier', {}),
    CreateFogModifierRadius: () => H('fogmodifier', {}),
    CreateFogModifierRadiusLoc: () => H('fogmodifier', {}),
    FogModifierStart: () => {}, FogModifierStop: () => {}, DestroyFogModifier: () => {},
    FogEnable: () => {}, FogMaskEnable: () => {},
    SetDoodadAnimation: () => {}, SetDoodadAnimationRect: () => {},
    SetBlight: () => {}, SetBlightRect: () => {},
    StartMeleeAI: () => {}, StartCampaignAI: () => {}, CommandAI: () => {},
    SetPlayerAllianceStateAllyBJ: () => {},

    // ---------------------------------------------------------- leaderboards
    CreateLeaderboard: () => { const lb = H('leaderboard', { rows: [], title: '' });
      eng.leaderboards.push(lb); return lb; },
    DestroyLeaderboard: () => {},
    LeaderboardSetLabel: (lb, s) => { if (lb) lb.title = s; },
    LeaderboardAddItem: (lb, label, value, p) => { if (lb) lb.rows.push({ label, value, p: p && p.index }); },
    LeaderboardSetItemValue: (lb, i, v) => { if (lb && lb.rows[i]) lb.rows[i].value = v; },
    LeaderboardSetItemLabel: (lb, i, s) => { if (lb && lb.rows[i]) lb.rows[i].label = s; },
    LeaderboardGetItemCount: (lb) => (lb ? lb.rows.length : 0),
    LeaderboardClear: (lb) => { if (lb) lb.rows = []; },
    LeaderboardSortItemsByValue: (lb, asc) => {
      if (lb) lb.rows.sort((a, b) => (asc ? a.value - b.value : b.value - a.value));
    },
    LeaderboardGetPlayerIndex: (lb, p) => {
      if (!lb || !p) return 0;
      const i = lb.rows.findIndex((r) => r.p === p.index);
      return i < 0 ? 0 : i;
    },
    LeaderboardHasPlayerItem: (lb, p) => !!(lb && p && lb.rows.some((r) => r.p === p.index)),
    LeaderboardDisplay: () => {}, LeaderboardSetSizeByItemCount: () => {},
    PlayerSetLeaderboard: () => {}, PlayerGetLeaderboard: () => null,
    LeaderboardSetStyle: () => {},
    LeaderboardRemovePlayerItem: () => {}, LeaderboardSetLabelColor: () => {},
    LeaderboardSetValueColor: () => {}, LeaderboardSetItemStyle: () => {},
    // ---- multiboards: a grid the map fills in cell by cell
    CreateMultiboard: () => {
      const mb = H('multiboard', { rows: 0, cols: 0, title: '', cells: new Map(), shown: false });
      eng.multiboards.push(mb);
      return mb;
    },
    DestroyMultiboard: (mb) => { eng.multiboards = eng.multiboards.filter((x) => x !== mb); },
    MultiboardDisplay: (mb, show) => { if (mb) mb.shown = !!show; },
    MultiboardSetRowCount: (mb, n) => { if (mb) mb.rows = trunc(n); },
    MultiboardSetColumnCount: (mb, n) => { if (mb) mb.cols = trunc(n); },
    MultiboardGetRowCount: (mb) => (mb ? mb.rows : 0),
    MultiboardGetColumnCount: (mb) => (mb ? mb.cols : 0),
    MultiboardSetTitleText: (mb, t) => { if (mb) mb.title = resolveTrigstr(t); },
    MultiboardGetTitleText: (mb) => (mb ? mb.title : ''),
    MultiboardGetItem: (mb, row, col) => {
      if (!mb) return null;
      const key = trunc(row) + ',' + trunc(col);
      let cell = mb.cells.get(key);
      if (!cell) {
        cell = H('multiboarditem', { mb, row: trunc(row), col: trunc(col), value: '', icon: '' });
        mb.cells.set(key, cell);
      }
      return cell;
    },
    MultiboardReleaseItem: () => {},
    MultiboardSetItemValue: (it, v) => { if (it) it.value = resolveTrigstr(v); },
    MultiboardSetItemStyle: (it, showValue, showIcon) => {
      if (it) { it.showValue = !!showValue; it.showIcon = !!showIcon; }
    },
    MultiboardSetItemIcon: (it, path) => { if (it) it.icon = path; },
    MultiboardSetItemValueColor: (it, r, g, b, a) => { if (it) it.color = [r, g, b, a]; },
    MultiboardSetItemWidth: (it, w) => { if (it) it.width = w; },
    MultiboardSetItemsvalue: () => {}, MultiboardSetItemsStyle: () => {},
    MultiboardSetItemsIcon: () => {}, MultiboardSetItemsValueColor: () => {},
    MultiboardSetItemsWidth: () => {},
    MultiboardMinimize: () => {}, MultiboardClear: (mb) => { if (mb) mb.cells.clear(); },
    MultiboardSuppressDisplay: () => {},
    IsMultiboardDisplayed: (mb) => !!(mb && mb.shown),
    CreateQuest: () => { const q = H('quest', { title: '', description: '', discovered: true, required: false, completed: false, items: [] }); eng.quests.push(q); return q; },
    QuestSetTitle: (q, s) => { if (q) q.title = resolveTrigstr(s); },
    QuestSetDescription: (q, s) => { if (q) q.description = resolveTrigstr(s); },
    QuestSetCompleted: (q, b) => { if (q) q.completed = !!b; },
    QuestSetDiscovered: (q, b) => { if (q) q.discovered = !!b; },
    QuestSetRequired: (q, b) => { if (q) q.required = !!b; },
    QuestSetIconPath: (q, s) => { if (q) q.icon = s; },
    QuestCreateItem: (q) => { const item = H('questitem', { description: '', completed: false }); if (q) q.items.push(item); return item; },
    QuestItemSetDescription: (q, s) => { if (q) q.description = resolveTrigstr(s); },
    QuestItemSetCompleted: (q, b) => { if (q) q.completed = !!b; },
    DestroyQuest: (q) => { eng.quests = eng.quests.filter(x => x !== q); }, FlashQuestDialogButton: () => {},
    CreateDefeatCondition: () => H('defeatcondition', {}),
    DialogCreate: () => H('dialog', {}), DialogDisplay: () => {},
    DialogSetMessage: () => {}, DialogAddButton: () => H('button', {}),
    DialogAddQuitButton: () => H('button', {}), DialogClear: () => {}, DialogDestroy: () => {},

    // -------------------------------------------------------- map/game setup
    SetMapName: () => {}, SetMapDescription: () => {},
    SetPlayers: (n) => { W().playerCount = n; },
    SetTeams: () => {}, SetGamePlacement: () => {}, SetGameSpeed: () => {},
    SetGameDifficulty: () => {}, SetMapFlag: () => {}, SetGameTypeSupported: () => {},
    SetResourceDensity: () => {}, SetCreatureDensity: () => {},
    DefineStartLocation: (i, x, y) => W().setStartLoc(i, x, y),
    DefineStartLocationLoc: (i, l) => W().setStartLoc(i, l.x, l.y),
    SetStartLocPrioCount: () => {}, SetStartLocPrio: () => {},
    GetStartLocationX: (i) => W().startLoc(i)[0],
    GetStartLocationY: (i) => W().startLoc(i)[1],
    GetStartLocationLoc: (i) => { const s = W().startLoc(i); return loc(s[0], s[1]); },
    SetAllItemTypeSlots: () => {}, SetAllUnitTypeSlots: () => {},
    SetItemTypeSlots: () => {}, SetUnitTypeSlots: () => {},
    ChooseRandomCreep: (level) => W().randomCreep(level),
    ChooseRandomNPBuilding: () => 0, ChooseRandomItem: () => 0,
    ChooseRandomItemEx: () => 0,
    GetUnitsInRectAll: (r) => { const g = H('group', { units: [] }); return fillGroup(g, W().enumInRect(r), null); },
    GetGameTypeSelected: () => C('gametype')(1),
    IsMapFlagSet: () => false,
    GetTeams: () => 2, GetPlayers: () => 12,
    RemovePlayer: (p) => { if (p) p.slotState = 0; },
    CustomVictoryBJ: (p) => { eng.emit({ t: 'victory', player: p && p.index }); },
    CustomDefeatBJ: (p, msg) => { eng.emit({ t: 'defeat', player: p && p.index, msg }); },
    EndGame: () => {}, PauseGame: () => {},
    GetGameState: () => 0, SetGameState: () => {},
    // GAME_STATE_TIME_OF_DAY is ConvertFGameState(2). The BJs GetTimeOfDay and
    // SetTimeOfDay go through these and the engine answers those by name, so
    // only a caller of the raw native reaches here -- but a clock with two
    // answers is a defect waiting, so the raw one reads the same clock.
    GetFloatGameState: (st) => (st && st.v === 2 ? N.GetTimeOfDay() : 0),
    SetFloatGameState: (st, v) => { if (st && st.v === 2) N.SetTimeOfDay(v); },
    VersionGet: () => C('version')(1),
    VersionCompatible: () => true, VersionSupported: () => true,
    GetHandleId: (h) => handleId(h),
    StringIdentity: (s) => s,
    GetLocalizedString: (s) => s, GetLocalizedHotkey: (s) => (s ? s.charCodeAt(0) : 0),
    SetCampaignMenuRaceEx: () => {}, SetMissionAvailable: () => {},
    ForceCampaignSelectScreen: () => {},
    Preload: () => {}, PreloadEnd: () => {}, PreloadStart: () => {},
    PreloadRefresh: () => {}, PreloadGenClear: () => {}, PreloadGenStart: () => {},
    PreloadGenEnd: () => {},
    Cheat: () => {}, SyncSelections: () => {},
    DoNotSaveReplay: () => {}, SaveGameExists: () => false,
    ReloadGameCachesFromDisk: () => false,
    InitGameCache: () => H('gamecache', { map: new Map() }),
    SaveGameCache: () => true, FlushGameCache: () => {}, FlushStoredMission: () => {},
    StoreInteger: () => {}, StoreReal: () => {}, StoreBoolean: () => {},
    StoreUnit: () => true, StoreString: () => true,
    GetStoredInteger: () => 0, GetStoredReal: () => 0, GetStoredBoolean: () => false,
    GetStoredString: () => '', RestoreUnit: () => null,
    HaveStoredInteger: () => false, HaveStoredReal: () => false,
    HaveStoredBoolean: () => false, HaveStoredString: () => false,
    HaveStoredUnit: () => false,
  };

  /** A unit's type name, lowercased -- the key GroupEnumUnitsOfType matches on. */
  function typeNameOf(u) {
    const t = u && u.typeId != null ? W().type(u.typeId) : null;
    return String((t && t.name) || '').trim().toLowerCase();
  }

  function fillGroup(g, units, filter) {
    if (!g) return g;
    g.units = [];
    for (const u of units) {
      if (filter && filter.fn) {
        eng.ctxStack.push(eng.ctx);
        eng.ctx = Object.assign({}, eng.ctx, { filterUnit: u, enumUnit: u });
        const it = vm.runFunction(filter.fn);
        let r = it.next();
        while (!r.done) r = it.next();
        eng.ctx = eng.ctxStack.pop();
        if (!r.value) continue;
      }
      g.units.push(u);
    }
    return g;
  }

  let nextHandleId = 0x100000;
  const handleIds = new WeakMap();
  function handleId(h) {
    if (!h || typeof h !== 'object') return 0;
    if (!handleIds.has(h)) handleIds.set(h, nextHandleId++);
    return handleIds.get(h);
  }
  function strHash(s) {
    let h = 0;
    const t = String(s ?? '');
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0;
    return h;
  }

  vm.registerNatives(N);
  return N;
}
