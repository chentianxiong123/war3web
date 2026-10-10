import * as THREE from 'three';
import { AlertHistory } from './alerts.js';
import { Selection } from './selection.js';
import { minimapPoint } from './minimap.js';
import { Net } from './net.js';
import { Renderer, toX, toZ } from './render.js';
import { UI, Lang } from './ui.js';
import { HeroPreview } from './heroview.js';
import { Overlay } from './overlay.js';
import { buildConsole, buildTopBar, placeIn } from './console.js';
import { Audio } from './audio.js';
import { Msg, Phase, Ent, DEST_ID } from '/shared/const.js';

const alerts = new AlertHistory();
const net = new Net();
const ui = new UI(net);
window.__ui = ui;               // 诊断: 命令卡格子/资源面板的布局状态
const view = new Renderer(document.getElementById('view'));
const overlay = new Overlay(document.getElementById('overlay'));
const audio = new Audio();
// the top strip's resource readouts, built once the console layout arrives
let topBar = null;
let consoleSlots = null;
// The engine's own floating text -- bounty, miss, crit -- is made here rather
// than by the map's script, so it needs ids of its own that cannot collide with
// the engine's numeric text tag handles.
let bountySeq = 0;

/**
 * One of the engine's own text tags, over a point in the world.
 *
 * Shown only to the player the event names, which for all three of these is the
 * player who acted: it is feedback on your own kill, your own swing. The height
 * is the default text tag size of 10 through Blizzard.j's TextTagSize2Height --
 * MiscData.txt carries every other figure but not a size.
 */
function combatText(ev, text) {
  if (ev.player !== S.slot || !text) return;
  const t = ev.tag || {};
  overlay.tags.set({ tt: `fx:${bountySeq++}`, s: text,
                     x: ev.x, y: ev.y, z: 60, h: 10 * 0.023 / 10,
                     c: t.color, vx: t.vx, vy: t.vy,
                     life: t.life, fade: t.fade,
                     age: 0, perm: false, vis: true });
}
const S = {
  you: null, phase: Phase.LOBBY, game: null, hero: null,
  ents: new Map(),           // id -> latest server state
  prev: new Map(),           // id -> previous state (for interpolation)
  lastSnap: 0, snapDt: 1 / 15,
  selected: null, bounds: null, ready: false, showScore: false, cinematic: false, booted: false,
  castPending: null, itemPending: null, unitCast: null, minimapImg: null, debug: false,
  hoverId: null, altHeld: false,
  unitModels: null,          // also feeds the lobby's rotating hero preview
};
window.__S = S;               // 诊断:外部查看游戏状态
window.__view = view;             // 诊断:外部投影/点选测试
const TRAIN_BUTTONS = [['hpea', '农民', 75], ['hfoo', '步兵', 135], ['harr', '弓箭手', 90]];
window.__setSelection = (ids) => setSelection(ids);   // 测试/调试: 选中单位
// RTS 建造放置: 点命令卡上的建筑 -> 待放状态 -> 左键点地图 -> 发 BUILD
let pendingBuild = null;
// The command card calls these. They used to be window globals the card reached through,
// which meant the card drew its buttons from a second HTML panel and these were wired to
// nothing; both ends are here now -- the card is the card, and this is what a cell means.
ui.onTrain = (type) => { const uids = commandIds(); if (uids.length) net.send({ t: Msg.TRAIN, trainType: type, unitIds: uids }); };
ui.onBuild = (type) => { pendingBuild = type; ui.log('放置中: 左键点地图放建筑', 'lvl'); };
window.__trainBtn = ui.onTrain;   // 测试/调试: 绕过命令卡直接训练
window.__buildBtn = ui.onBuild;

// ------------------------------------------------------------------ networking
net.on(Msg.WELCOME, (m) => {
  const wasYou = S.you;
  S.you = m.you; net.you = m.you;
  net.token = m.token || null;
  try { sessionStorage.setItem('war3web.token', net.token || ''); } catch { /* private mode */ }
  reconnect.attempts = 0;
  // A second WELCOME is a reconnect. The terrain, the models and the world are
  // all still here; the next STATE and SNAPSHOT bring what changed, and the
  // room resends the permanent tags and the atmosphere on its own.
  if (S.booted) {
    ui.hideDisconnected();
    ui.log(m.you === wasYou ? 'reconnected' : 'rejoined as a new player', 'lvl');
    S.game = m.game; S.bounds = m.game.bounds;
    return;
  }
  S.game = m.game; S.bounds = m.game.bounds;
  // The server decides whether the debugging keys exist at all; the client only
  // binds what it was told about, so nothing here can reach a deployed build.
  S.debug = !!m.debug;
  ui.setBuild(m.build, S.debug, m.game?.meta?.name);
  if (S.debug) {
    const hint = document.getElementById('hint');
    if (hint) hint.textContent += ' \u00b7 L max level';
  }
  ui.setLoading('loading terrain…', 0.35);
  boot(m).then(() => {
    S.booted = true;
    ui.hideLoading();
    // The room does not wait for anyone's download, so the match can start
    // while the terrain is still loading. This continuation used to put the
    // lobby back up over a running game and nothing took it down again: the
    // server sends STATE when the phase changes, and it already had.
    if (S.phase === Phase.PLAYING) { S.cinematic = false; ui.startGame(); refitConsole(); }
    else ui.showLobby(m.game);
  }).catch((err) => {
    // One 404 on terrain.json or heights.bin used to leave the player watching
    // "loading terrain..." with nothing said and nothing to do.
    console.error('boot failed', err);
    ui.setLoading(`could not load the map: ${err && err.message || err}`, 1);
  });
});

net.on(Msg.STATE, (m) => {
  const was = S.phase;
  S.phase = m.phase;
  // the map's own slot for this client, which is what server-side events name
  S.slot = m.players.find((x) => x.id === S.you)?.slot ?? null;
  ui.renderTeams(m.players, S.you, m.phase);
  ui.updateScore(m.board, m.killsToWin);
  // a gate broken before this client joined, or before it reconnected: the
  // events only carry a change, so the state carries what has already happened
  if (m.dests && S.dests) {
    for (const d of m.dests) {
      const g = S.dests.get(d.d);
      if (!g) continue;
      g.hp = d.hp; g.max = d.max;
      if (d.dead && !g.dead) { g.dead = true; view.setDoodadDead(d.d); }
    }
  }
  if (m.phase === Phase.PLAYING) { S.cinematic = false; ui.startGame(); }
  if (m.phase === Phase.LOBBY && S.game) ui.showLobby(S.game);
  // Second matches in one room are real now that the room lifecycle is fixed,
  // so the state a match leaves behind has to be cleared on the way out of it:
  // the server drops everyone's ready flag in reset() and the client has to
  // agree, and a half-aimed spell must not survive into the lobby.
  if (m.phase !== was) {
    S.showScore = false; ui.toggleScore(false);
    if (m.phase === Phase.LOBBY) {
      selection.set([]); selection.groups.clear(); selectionInitialized = false; cameraHeroId = null;
      alerts.clear(); ui.minimapAlerts = [];
      ui.unitSel = null; ui.clearShop();
    }
    S.castPending = null; S.itemPending = null;
    canvas.style.cursor = 'default';
    // The console's two canvases can only be measured once the HUD is on
    // screen: the fit at load time runs while #hud is still hidden, where
    // every box is zero and fitMinimap declines to size a canvas from it.
    if (m.phase === Phase.PLAYING) refitConsole();
    if (m.phase === Phase.LOBBY) {
      S.ready = false;
      // the map's permanent labels belong to the world that just ended; the
      // next match makes its own, and the server replays them on the way in
      overlay.tags.clear();
      document.getElementById('btnReady').textContent = '准备';
    }
  }
});

net.on(Msg.SNAPSHOT, (m) => {
  const now = performance.now();
  S.snapDt = Math.max(1 / 60, Math.min(0.5, (now - S.lastSnap) / 1000)) || 1 / 15;
  S.lastSnap = now;
  const seen = new Set();
  for (const e of m.s.ents) {
    seen.add(e.i);

    const old = S.ents.get(e.i);
    S.prev.set(e.i, old ? { x: old.x, y: old.y, f: old.f } : { x: e.x, y: e.y, f: e.f });
    const meta = findMeta(e);
    S.ents.set(e.i, Object.assign({}, meta, e));
    // A unit can change type mid-game -- Metamorphosis swaps the hero for its
    // alternate form -- and the view is built once from the model that type
    // names, so it has to be rebuilt when the type underneath it changes.
    if (!view.views.has(e.i)) view.spawnView(S.ents.get(e.i));
    else if (old && old.u !== e.u) {
      view.removeView(e.i);
      view.spawnView(S.ents.get(e.i));
    }
    // the models the unit's buffs hang on it; a no-op unless the set changed
    if (e.b || old?.b) view.syncBuffArt(e.i, e.b, S.buffArt);
  }
  for (const id of [...S.ents.keys()]) {
    if (seen.has(id)) continue;
    S.ents.delete(id); S.prev.delete(id); view.removeView(id);
  }
  view.syncItems(m.s.items, S.game?.items);
  // (static views use negative ids and are never tracked in S.ents, so they persist)
  if (m.s.board) ui.updateScore(m.s.board, 100);
  // The melee map has no heroes, so the 'hero' message that fills the top bar
  // never arrives; the authoritative numbers come on the snapshot instead.
  if (topBar) {
    const r = m.s.res && m.s.res[S.slot];
    if (r) {
      topBar.res.get('gold')?.replaceChildren(String(r.gold ?? 0));
      topBar.res.get('lumber')?.replaceChildren(String(r.lumber ?? 0));
      topBar.res.get('supply')?.replaceChildren(`${r.supply ?? 0}/${r.supplyMax ?? 5}`);
    }
  }
  ui.updateClock(m.s.clock);
  ui.quests = m.s.quests || [];
  selection.prune(id => S.ents.has(id) && S.ents.get(id).sel !== false);
  refreshSelection();
});

net.on(Msg.EVENT, (m) => {
  for (const ev of m.ev) handleEvent(ev);
});

net.on(Msg.CHATMSG, (m) => ui.log(`<b>${escapeHtml(m.from)}:</b> ${escapeHtml(m.text)}`));
net.on(Msg.ERROR, (m) => ui.log(m.m, 'kill'));
// The connection is gone: say so, and try to get the seat back. The server
// holds it for a minute; the attempts back off from a second to eight and give
// up a little after the seat would have, at which point the Refresh button is
// what is left.
function reconnect() {
  if (++reconnect.attempts > 12) { ui.showDisconnected('the seat is gone. refresh to join again.'); return; }
  ui.showDisconnected(`reconnecting… (attempt ${reconnect.attempts})`);
  setTimeout(() => { if (!net.ws) net.connect(savedName); }, Math.min(8000, 1000 * reconnect.attempts));
}
reconnect.attempts = 0;
net.on('closed', () => {
  ui.log('disconnected from server', 'kill');
  reconnect();
});

/**
 * "Our hero has fallen!"
 *
 * Warcraft III says this itself when a hero dies -- no map script is involved,
 * which is why nothing in war3map.j mentions it and it had never been ported.
 * UISounds.slk carries a row per race for your own hero and another for an
 * ally's, and the voice is the *listening* player's race rather than the dead
 * hero's, because it is your own advisor speaking. Which is also why the
 * decision is made here and not on the server: every client hears a different
 * answer, and some hear nothing.
 *
 * There is deliberately no enemy row in the table. Warcraft III is silent when
 * the other side loses a hero, and so is this.
 */
function heroDownWarning(e) {
  if (!e || e.k !== 1) return;                     // k=1 is a hero
  const table = S.uiSounds;
  if (!table) return;
  const mine = S.hero?.id;
  const myTeam = mine != null ? S.ents.get(mine)?.t : null;
  const prefix = e.i === mine ? 'HeroDies'
               : (myTeam != null && e.t === myTeam) ? 'AllyHeroDies'
               : null;
  if (!prefix) return;
  playAdvisorWarning(prefix, 'HeroDiesGeneric');
}

function playAdvisorWarning(prefix, fallback = prefix + 'Generic') {
  const table = S.uiSounds;
  if (!table) return;
  const want = (prefix + (S.hero?.race || '')).toLowerCase();
  const key = Object.keys(table).find(k => k.toLowerCase() === want);
  const row = table[key] || table[fallback];
  if (!row?.files?.length) return;
  audio.playUI(row.files[Math.floor(Math.random() * row.files.length)],
               row.vol ?? 1, row.flags);
}

/** Where the player is listening from: their hero, else the camera focus. */
function listener() {
  const me = S.ents.get(S.hero?.id);
  if (me) return { x: me.x, y: me.y };
  return { x: view.camTarget.x, y: -view.camTarget.z };
}

/** Every entity carries its unit-type id; look up the converted model for it. */
function findMeta(e) {
  const t = S.unitModels?.[e.u];
  if (t) return { model: t.m, scale: t.s, name: t.n, isHero: !!t.h, isBuilding: !!t.b,
                  radius: t.r, locust: !!t.l,
                  // the unit's own shadow image, size and offset
                  sh: t.sh, sw: t.sw, shh: t.shh, sx: t.sx, sy: t.sy, us: t.us, an: t.an,
                  // the selection circle's own scale and height off the ground
                  ss: t.ss, sz: t.sz };
  return {};
}

function recordAlert(kind, e, message) {
  if (S.phase !== Phase.PLAYING || !e) return;
  const alert = alerts.add(kind, e.x, e.y);
  if (!alert) return;
  ui.minimapAlerts = alerts.entries;
  if (message) ui.log(message, 'kill');
  if (kind === 'attack') playAdvisorWarning(e.isBuilding ? 'TownAttack' : 'UnderAttack');
}

function handleEvent(ev) {
  switch (ev.t) {
    case 'death': {
      const v = view.views.get(ev.id);
      if (v) view.play(v, 'death', true);
      const e = S.ents.get(ev.id);
      ui.log(`${escapeHtml(e?.name || 'a unit')} was slain`, 'kill');
      heroDownWarning(e);
      const team = S.ents.get(S.hero?.id)?.t;
      if (e?.k === Ent.HERO && (e.p === S.slot || (team != null && e.t === team)))
        recordAlert('death', e);
      break;
    }
    case 'respawn': { const v = view.views.get(ev.id); if (v) view.play(v, 'stand'); break; }
    case 'levelup': {
      if (ev.id === S.hero?.id) ui.log(`Level ${ev.lvl}!`, 'lvl');
      const v = view.views.get(ev.id);
      if (v) spawnRing(v.root.position, 0xffdd66, 160);
      break;
    }
    case 'attack': {
      const v = view.views.get(ev.id);
      if (v) view.play(v, 'attack', true);
      break;
    }
    case 'cast': {
      const v = view.views.get(ev.id);
      // the ability's own Animnames if it has one, else the generic cast clip.
      // A cast that holds the unit -- a casting time, a channel -- loops it
      // until the server says the cast is over.
      if (v) view.play(v, ev.anim || 'spell', !ev.loop);
      if (ev.x != null) spawnRing(new THREE.Vector3(toX(ev.x), view.heightAt(ev.x, ev.y) + 6, toZ(ev.y)), 0x88ccff, 120);
      break;
    }
    case 'castEnd': {
      const v = view.views.get(ev.id);
      if (v) view.play(v, 'stand');
      break;
    }
    case 'camShake': view.setShake(ev.mag, ev.vel, ev.vert); break;
    case 'terrainDeform': view.deformTerrain(ev); break;
    // floating text: sent once, finished, and aged out by the overlay
    case 'texttag': overlay.tags.set(ev); break;
    case 'texttagEnd': overlay.tags.remove(ev.tt); break;
    // The engine's own bounty text: the gold a kill just paid, floated over the
    // body. Warcraft III shows it to the killing player alone, so it is dropped
    // unless this client did the killing.
    //
    // Nothing here is chosen. The colour, drift, lifetime and fade all ride in
    // on the event from UI/MiscData.txt's BountyText block; the height is the
    // one figure that file does not carry, and it is the default text tag size
    // of 10 put through Blizzard.j's own TextTagSize2Height.
    case 'bounty': combatText(ev, `+${ev.gold}`); break;
    // The engine's own combat text. The server already found the miss and the
    // crit -- both were emitted and dropped on the floor here -- so all that
    // was missing is the number. Their colour, drift, lifetime and fade come
    // from UI/MiscData.txt and the word "miss" from GlobalStrings.fdf, so
    // nothing about how they look is chosen here.
    case 'miss': combatText(ev, ev.tag?.text || 'miss'); break;
    case 'crit': combatText(ev, String(ev.n)); break;
    // the engine draws these itself rather than playing a model
    case 'lightning': view.spawnBolt(ev); break;
    case 'aoe': spawnRing(new THREE.Vector3(toX(ev.x), view.heightAt(ev.x, ev.y) + 6, toZ(ev.y)), 0xff8844, ev.r); break;
    case 'blinkIn': case 'blinkOut':
      spawnRing(new THREE.Vector3(toX(ev.x), view.heightAt(ev.x, ev.y) + 6, toZ(ev.y)), 0xaa66ff, 110); break;
    case 'boss': ui.log('BOSS MULDER HAS FALLEN', 'kill'); break;
    // the script's DisplayText often embeds GetPlayerName -- player-typed
    case 'text': if (ev.s) ui.log(escapeHtml(String(ev.s).replace(/\|c........|\|r/g, '')), 'lvl'); break;
    case 'teleport': { const v = view.views.get(ev.id);
      if (v) spawnRing(new THREE.Vector3(toX(ev.x), view.heightAt(ev.x, ev.y) + 6, toZ(ev.y)), 0x66ddff, 130);
      break; }
    case 'gameover': ui.gameOver(ev.winner, ev.board); break;
    case 'dmg': {
      if (ev.id === S.hero?.id && ev.amt > 0) flash();
      const victim = S.ents.get(ev.id), source = S.ents.get(ev.src);
      if (ev.amt > 0 && S.slot != null && victim?.p === S.slot && source &&
          source.p !== victim.p && (source.t == null || source.t < 0 || source.t !== victim.t))
        recordAlert('attack', victim, 'Your units are under attack!');
      break;
    }
    case 'destDmg': {
      const g = S.dests?.get(ev.d);
      if (g) { g.hp = ev.hp; g.max = ev.max; }
      // the doors shudder: the gate models carry their own Stand Hit clip
      if (g && !g.dead) view.playDoodadClip(ev.d, 'stand hit');
      break;
    }
    case 'destDead': {
      const g = S.dests?.get(ev.d);
      if (g) { g.dead = true; g.hp = 0; }
      // the wreckage is already in the model, hidden until now by the stand
      // sequence's geoset-alpha track; the death clip is what drops it
      view.setDoodadDead(ev.d);
      view.playDoodadClip(ev.d, 'death', { hold: true });
      if (g && S.destPick?.has(ev.d)) ui.log('a gate has been broken open', 'kill');
      break;
    }
    // the map's script drives its own spell visuals through these
    case 'anim':     view.playUnitAnim(ev.id, ev.name); break;
    // animation speed: hastes, slows, and the two sites that freeze a unit at 0
    case 'timeScale': view.setUnitTimeScale(ev.id, ev.s); break;
    // A scripted camera move, aimed at one player by the map. `player` is unset
    // when the map called the bare native, which this one never does.
    case 'panCamera':
      if (ev.player == null || ev.player === S.slot) view.panTo(ev.x, ev.y, ev.dur);
      break;
    // the full-screen wash an ultimate or a duel transition throws
    case 'cineFilter':    overlay.cine.show(ev); break;
    case 'cineFilterOff': overlay.cine.clear(); break;
    case 'animIdx':  view.playUnitAnimIndex(ev.id, ev.i); break;
    case 'animQueue': view.queueUnitAnim(ev.id, ev.name); break;
    // CinematicModeBJ, for the players in its force: the interface fades, the
    // letterbox closes in, and input is ignored until it lifts
    case 'cinematic':
      if (ev.players == null || ev.players.includes(S.slot)) {
        S.cinematic = !!ev.on;
        ui.setCinematic(S.cinematic, ev.fade);
      }
      break;
    case 'sfx':      view.spawnEffect(ev, false); break;
    case 'sfxUnit':  view.spawnEffect(ev, true); break;
    case 'sfxEnd':   view.endEffect(ev.fx); break;
    // a weapon's shot, in flight; the server decides when it lands
    case 'missile':    view.spawnMissile(ev); break;
    case 'missileEnd': view.endMissile(ev.fx); break;
    case 'tint':     view.tintUnit(ev.id, ev.r, ev.g, ev.b, ev.a); break;
    // the map's own SetMapMusic / PlayMusic / StopMusic
    case 'music': {
      // `set` only records the list -- see SetMapMusic in server/jass/engine.js
      if (ev.set) { audio.setMusicList(ev.list, ev.random, ev.index); break; }
      if (ev.stop) { audio.stopMusic(ev.fade); break; }
      if (ev.resume) { audio.resumeMusic(); break; }
      if (ev.volume != null) { audio.setMusicVolume(ev.volume); break; }
      audio.playMusic(ev.list, ev.random, ev.index);
      break;
    }
    // SetTerrainFogEx: the map's own fog colour and distances, in place of the
    // ones the renderer used to pick for itself
    case 'fog': view.setFog(ev); break;
    // SetDayNightModels: the map's own sun and ambient colours, hour by hour
    case 'daynight': view.setDayNight(dayNightCurves, ev); break;
    case 'tod': view.setTimeOfDay(ev.hour); audio.setAmbientHour(ev.hour); break;
    // SetAmbientDaySound / SetAmbientNightSound, rendered from the game's own
    // MIDI and instrument bank by tools/ambience.py
    case 'ambient': audio.setAmbient(ev.day, ev.night, ev.hour); break;
    case 'sound': {
      // the map's own PlaySoundBJ / PlaySoundAtPointBJ / PlaySoundOnUnitBJ
      let x = ev.x, y = ev.y;
      if (ev.id != null) { const e2 = S.ents.get(ev.id); if (e2) { x = e2.x; y = e2.y; } }
      audio.playWorld(ev.path, x, y, ev.vol ?? 1, ev.pitch ?? 1, listener(), null,
                      { loop: ev.loop, snd: ev.snd });
      break;
    }
    case 'soundStop': audio.stopSound(ev.snd, ev.fade); break;
  }
}

// ------------------------------------------------------------------- visuals
const rings = [];
function spawnRing(pos, color, radius) {
  const g = new THREE.RingGeometry(radius * 0.2, radius, 32);
  g.rotateX(-Math.PI / 2);
  const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55,
    side: THREE.DoubleSide, depthWrite: false });
  const mesh = new THREE.Mesh(g, m);
  mesh.position.copy(pos);
  view.scene.add(mesh);
  rings.push({ mesh, t: 0, life: 0.55, r: radius });
}
function stepRings(dt) {
  for (let i = rings.length - 1; i >= 0; i--) {
    const r = rings[i];
    r.t += dt;
    const k = r.t / r.life;
    r.mesh.material.opacity = 0.55 * (1 - k);
    r.mesh.scale.setScalar(0.6 + k * 0.8);
    if (k >= 1) { view.scene.remove(r.mesh); r.mesh.geometry.dispose(); r.mesh.material.dispose(); rings.splice(i, 1); }
  }
}
let flashT = 0;
function flash() { flashT = 0.25; }
// data/daynight.json, loaded at boot and handed to the renderer when the map
// names which of the models it wants
let dayNightCurves = {};

// ---------------------------------------------------------------------- boot
async function boot(m) {
  // M2: WebGPU 渲染器异步 init；首帧前必须就绪（WebGL 路径恒 resolved）
  await view.rendererReady;
  const [terr, heightsBuf, doodads, dests, unitModels, ubersplats,
         splatTable, spawnTable, animSounds, boltTable, uiSounds, buffArt,
         dncCurves] = await Promise.all([
    fetch('/data/terrain.json').then((r) => r.json()),
    fetch('/data/heights.bin').then((r) => r.arrayBuffer()),
    fetch('/data/doodads.json').then((r) => r.json()),
    // the destructables among them: which can be clicked, and what they cost
    // to break. Static, so it is read here rather than sent per match; only
    // what has actually been damaged comes over the wire.
    fetch('/data/destructables.json').then((r) => r.json()).catch(() => []),
    fetch('/data/unitmodels.json').then((r) => r.json()),
    // the ground decals buildings are stamped on
    fetch('/data/ubersplats.json').then((r) => r.json()).catch(() => ({})),
    // the event-object tables: splats and footprints, thrown models, sounds
    fetch('/data/splats.json').then((r) => r.json()).catch(() => ({})),
    fetch('/data/spawns.json').then((r) => r.json()).catch(() => ({})),
    fetch('/data/animsounds.json').then((r) => r.json()).catch(() => ({})),
    fetch('/data/lightning.json').then((r) => r.json()).catch(() => ({})),
    // Warcraft III's own warnings, off UISounds.slk -- the hero-death line
    fetch('/data/uisounds.json').then((r) => r.json()).catch(() => ({})),
    // the model a buff hangs on a unit, and the point it hangs from
    fetch('/data/buffart.json').then((r) => r.json()).catch(() => ({})),
    // the sun and ambient colours of Warcraft III's own day/night models, so
    // SetDayNightModels has something to name
    fetch('/data/daynight.json').then((r) => r.json()).catch(() => ({})),
  ]);
  S.uiSounds = uiSounds;
  S.buffArt = buffArt;
  dayNightCurves = dncCurves;
  // the map may have named its models before this finished loading
  view.setDayNight(dayNightCurves, null);
  // Warcraft III's console frame, from its own ConsoleUI.fdf, with our panels
  // moved into the openings the art leaves for them.
  fetch('/data/console.json').then((r) => r.json()).then((spec) => {
    const slots = buildConsole(spec, document.getElementById('console'));
    consoleSlots = slots;          // the tooling measures the card from these
    // How much of the screen the frame eats, taken from the pieces themselves
    // rather than written down here: the tallest BOTTOM-anchored tile is the
    // console's height (0.2933 for this layout). The camera needs it to aim at
    // the middle of what the player can see instead of the middle of the window.
    view.setConsoleFraction(Math.max(0, ...(spec.console || [])
      .filter((p) => String(p.a || '').startsWith('BOTTOM'))
      .map((p) => p.h || 0)));
    // The top strip's contents: the resource readout and the menu buttons.
    // All four are live. Quests was drawn from the layout's disabled art while
    // the quest natives were stubs; CreateQuest/QuestSetTitle/QuestSetDescription
    // now keep real quests and the snapshot carries them, so the button has
    // something behind it -- as do Menu, Allies and Chat.
    topBar = buildTopBar(spec, document.getElementById('uitop'), {
      enabled: () => true,
      onButton: (k) => {
        if (k === 'chat') ui.openChat();
        else ui.openDialog({ quests: 'Quests', menu: 'Main Menu', allies: 'Allies' }[k]);
      },
    });
    placeIn(document.getElementById('minimap'), slots.minimap);
    placeIn(document.getElementById('portrait'), slots.info);
    placeIn(document.getElementById('unitPortrait'), slots.portrait);
    document.documentElement.style.setProperty('--portrait-left', slots.portrait.left);
    document.documentElement.style.setProperty('--portrait-width', slots.portrait.width);
    // The card is four across and three down, which is twelve: the six
    // abilities fill it the way Warcraft III fills one, row by row, and the six
    // inventory slots take the rest.
    ui.cardCells = slots.cells;
    ui.invCells = slots.inv;
    ui.placeCard();
    // The minimap is sized by the art now, so its drawing buffer has to follow
    // or a 200x300 map is squashed into a landscape opening. This is the fit
    // for art that arrives mid-match; the first one happens when the HUD is
    // shown, since nothing here has a size while it is hidden.
    ui.fitMinimap();
    showUnitPortrait();
    // the console says what the controls are; the crib sheet was for before it
    const hint = document.getElementById('hint');
    if (hint && slots.cells.length) hint.style.display = 'none';
  }).catch(() => {});
  const doodadMeta = await fetch('/data/doodadmeta.json').then((r) => r.json()).catch(() => ({}));
  // baked cliff mesh; a map with no cliffs simply has no cliffs.json
  const cliffs = await (async () => {
    try {
      const spec = await fetch('/data/cliffs.json').then((r) => (r.ok ? r.json() : null));
      if (!spec || !spec.groups || !spec.groups.length) return null;
      spec.data = new Float32Array(await fetch('/data/cliffs.bin').then((r) => r.arrayBuffer()));
      return spec;
    } catch { return null; }
  })();
  S.unitModels = unitModels;
  // the ground-decal table, keyed by the id a unit's uberSplat names
  view.splats = ubersplats;
  view.splatTable = splatTable;
  view.spawnTable = spawnTable;
  view.animSounds = animSounds;
  view.boltTable = boltTable;
  /**
   * A sound event fired: a foot landed, a blade bit, a body hit the ground.
   *
   * The table gives several takes for a sound that repeats -- a footstep has
   * four -- so one is drawn each time rather than the same clip looping, and
   * the pitch wanders by the variance the sound itself declares. Volume and the
   * three distances are the game's own numbers, which is what keeps a crowded
   * fight legible without inventing a limit.
   */
  view.onAnimSound = (rec, x, y) => {
    if (!rec || !rec.f || !rec.f.length) return;
    const file = rec.f[(Math.random() * rec.f.length) | 0];
    const pitch = (rec.pitch || 1) + (Math.random() * 2 - 1) * (rec.pitchVar || 0);
    audio.playWorld(file, x, y, rec.vol ?? 1, Math.max(0.1, pitch), listener(),
                    { min: rec.min, max: rec.max, cutoff: rec.cutoff });
  };
  ui.setLoading('building arena…', 0.6);
  await view.buildTerrain(terr, new Float32Array(heightsBuf), cliffs);
  // only DestructableData's selectable flag may be clicked: that is the six
  // gates, and not the walls, the trees or the pathing blockers
  S.dests = new Map();
  S.destPick = new Set();
  for (const d of dests || []) {
    S.dests.set(d.d, { type: d.id, x: d.x, y: d.y, hp: d.hp, max: d.hp, dead: false });
    if (d.sel) S.destPick.add(d.d);
  }
  // the same six get an animation mixer, so a struck gate can shudder
  await view.addDoodads(doodads, doodadMeta, S.destPick);
  const img = new Image();
  img.src = '/assets/textures/war3mapMap.png';
  img.onload = () => { S.minimapImg = img; };
  // every unit, including taverns and shops, now comes from the map script
  ui.setLoading('ready', 1);
  const c = m.game.meta.startLoc.pick;
  view.focus(c[0], c[1], true);
}

// --------------------------------------------------------------------- input
const canvas = document.getElementById('view');

const selection = new Selection();
let selectionInitialized = false, selectionDrag = null, markedSelection = new Set();
let lastPortraitSelection = null;
let lastGroup = { key: null, time: 0 };
const selectionBox = document.createElement('div');
selectionBox.id = 'selectionBox';
selectionBox.style.cssText = 'display:none;position:fixed;pointer-events:none;border:1px solid #62ed65;background:#62ed6518;z-index:20';
document.body.appendChild(selectionBox);
function canCommand(ent) { return !!ent && !!ent.a && ent.p === S.slot && ent.sel !== false; }
ui.canCommand = canCommand;
function commandIds() { return selection.ids.filter(id => canCommand(S.ents.get(id))); }
function heroSelected() { return S.hero?.id != null && selection.activeId === S.hero.id; }
function sendOrder(message, queue = false) { const unitIds = commandIds(); if (unitIds.length) net.send({ ...message, unitIds, ...(queue ? { queue: true } : {}) }); }
function refreshSelection() {
  if (ui.shopSel) { if (S.hero) ui.updateHero(S.hero); return; }
  const primary = S.ents.get(selection.activeId);
  if (heroSelected() && S.hero) { ui.unitSel = null; ui.updateHero(S.hero); }
  else ui.renderSelected(primary || { name: '', a: 0 });
  if (primary?.q) document.getElementById('heroClass').textContent += ` · ${primary.q} queued`;
  if (selection.ids.length > 1) {
    const box = document.getElementById('stats');
    const group = document.createElement('div'); group.className = 'selection-group';
    box.replaceChildren(group);
    for (const id of selection.subgroups(S.ents).flat()) {
      const ent = S.ents.get(id); if (!ent) continue;
      const button = document.createElement('button');
      button.textContent = ent.name || ent.u;
      const active = ent.u === primary?.u;
      button.classList.toggle('active-subgroup', active);
      button.setAttribute('aria-pressed', String(active));
      button.dataset.unitId = id;
      button.title = active ? 'Click to select this unit; Shift-click to remove' : 'Click to activate this subgroup; Shift-click to remove';
      const choose = e => {
        if (e.shiftKey) setSelection(selection.ids.filter(i => i !== id));
        else if (active) setSelection([id]);
        else { selection.activeId = id; changeSubgroup(); }
      };
      button.onpointerdown = e => { if (e.button === 0) { e.preventDefault(); choose(e); } };
      button.onclick = e => { if (e.detail === 0) choose(e); };
      group.appendChild(button);
    }
  }
  const portraitKey = `${selection.activeId}:${primary?.u}`;
  if (portraitKey !== lastPortraitSelection) { lastPortraitSelection = portraitKey; showUnitPortrait(); }
}
function changeSubgroup() {
  ui.skillMenu = false; ui.orderPending = null; S.castPending = null; S.itemPending = null;
  canvas.style.cursor = 'default'; refreshSelection(); showUnitPortrait();
}
function setSelection(ids) {
  selection.set(ids.filter(id => S.ents.has(id) && S.ents.get(id).sel !== false));
  selection.activeId = selection.subgroups(S.ents)[0]?.[0] ?? null;
  selectionInitialized = true;
  ui.clearShop(); ui.skillMenu = false; ui.orderPending = null;
  S.castPending = null; S.itemPending = null; S.unitCast = null; canvas.style.cursor = 'default';
  refreshSelection(); showUnitPortrait();
}
function screenPosition(ent) {
  const p = new THREE.Vector3(toX(ent.x), view.heightAt(ent.x, ent.y), toZ(ent.y)).project(view.camera);
  return { x: (p.x + 1) * innerWidth / 2, y: (1 - p.y) * innerHeight / 2, visible: p.z >= -1 && p.z <= 1 && Math.abs(p.x) <= 1 && Math.abs(p.y) <= 1 };
}
function sameTypeOnScreen(ent) {
  return [...S.ents.values()].filter(u => canCommand(u) && u.u === ent.u && screenPosition(u).visible).map(u => u.i);
}
addEventListener('mousemove', e => {
  if (!selectionDrag) return;
  const d = selectionDrag;
  d.moved ||= Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5;
  if (d.moved) Object.assign(selectionBox.style, { display: 'block', left: Math.min(d.x, e.clientX) + 'px', top: Math.min(d.y, e.clientY) + 'px', width: Math.abs(e.clientX - d.x) + 'px', height: Math.abs(e.clientY - d.y) + 'px' });
});
addEventListener('mouseup', e => {
  // A pending building is issued on the press, before the selection can change -- see the
  // canvas mousedown handler, where the reason it could not be issued here is written down.
  // All that is left on this path is dropping the pending placement.
  if (pendingBuild && e.button === 0 && !e.target.closest?.('.slot')) {
    pendingBuild = null;
    return;
  }
  if (e.button !== 0) return;
  if (!selectionDrag) return;
  const d = selectionDrag; selectionDrag = null; selectionBox.style.display = 'none';
  if (S.phase !== Phase.PLAYING || S.cinematic) return;
  if (d.moved) {
    const ids = [...S.ents.values()].filter(ent => {
      if (!canCommand(ent)) return false;
      const p = screenPosition(ent);
      return p.visible && p.x >= Math.min(d.x,e.clientX) && p.x <= Math.max(d.x,e.clientX) && p.y >= Math.min(d.y,e.clientY) && p.y <= Math.max(d.y,e.clientY);
    }).map(ent => ent.i);
    setSelection(d.shift ? [...commandIds(), ...ids] : ids);
    return;
  }
  const picked = view.pickEntity(e.clientX / innerWidth * 2 - 1, 1 - e.clientY / innerHeight * 2);
  const ent = S.ents.get(picked?.id);
  if (ent?.sel === false) return;
  const shop = shopFor(picked);
  if (shop && !d.shift) {
    setSelection([]); ui.unitSel = null; ui.selectShop(ent || picked, shop); showUnitPortrait(); return;
  }
  if (d.ctrl && canCommand(ent)) setSelection(sameTypeOnScreen(ent));
  else if (d.shift && canCommand(ent)) {
    selection.set(commandIds()); selection.toggle(ent.i); setSelection(selection.ids);
  } else if (!d.shift) setSelection(ent ? [ent.i] : []);
});
addEventListener('blur', () => { selectionDrag = null; selectionBox.style.display = 'none'; });

canvas.addEventListener('contextmenu', (e) => e.preventDefault());
canvas.addEventListener('mousedown', (e) => {
  if (S.phase !== Phase.PLAYING || S.cinematic) return;
  const nx = (e.clientX / innerWidth) * 2 - 1;
  const ny = -(e.clientY / innerHeight) * 2 + 1;
  if (e.button === 0) {
    // Placing a building: issued on the press, and before anything below can clear the
    // selection.
    //
    // It was issued on the *release*, from a window-level mouseup, and that meant it never
    // went out at all. The press on the canvas runs the selection handler first -- clicking
    // open ground clears the selection -- so by the time the release asked sendOrder to
    // deliver it, commandIds() was empty and sendOrder sent nothing. The card said
    // "placing" and no building ever appeared.
    //
    // Every other order on this card is issued here as well, for the same reason: it is
    // the unit that builds, so it has to still be selected at the moment of the click.
    if (pendingBuild) {
      const g = view.pickGround(nx, ny);
      if (g) sendOrder({ t: Msg.BUILD, buildType: pendingBuild, x: g.x, y: g.y });
      pendingBuild = null;
      canvas.style.cursor = 'default';
      return;
    }
    if (ui.orderPending) {
      const g = view.pickGround(nx, ny), target = view.pickEntity(nx, ny);
      if (ui.orderPending === 'attack' && target && target.id !== S.hero?.id)
        sendOrder({ t: Msg.ATTACK, targetId: target.id }, e.shiftKey);
      else if (g) sendOrder({ t: Msg.MOVE, x: g.x, y: g.y, attack: ui.orderPending === 'attack', patrol: ui.orderPending === 'patrol' }, e.shiftKey);
      ui.orderPending = null; canvas.style.cursor = 'default'; return;
    }
    // an item aimed at a unit: the Monster Ball is thrown at a creep
    if (S.itemPending != null) {
      const t = view.pickEntity(nx, ny);
      if (t && t.id !== S.hero?.id) {
        net.send({ t: 'useItem', slot: S.itemPending, targetId: t.id });
        S.itemPending = null;
        canvas.style.cursor = 'default';
      }
      return;                                    // stay armed until something is hit
    }
    if (S.unitCast) {
      const g = view.pickGround(nx, ny);
      const t = view.pickEntity(nx, ny);
      if (g) net.send({ t: 'castUnit', abilId: S.unitCast.id, unitIds: S.unitCast.unitIds,
                        x: g.x, y: g.y, targetId: t ? t.id : undefined });
      S.unitCast = null;
      canvas.style.cursor = 'default';
      return;
    }
    if (S.castPending != null) {
      const g = view.pickGround(nx, ny);
      const t = view.pickEntity(nx, ny);
      const ab = S.hero?.abilities?.[S.castPending];
      const tid = t && t.id !== S.hero?.id ? t.id : undefined;
      if (ab?.targetMode === 'unit' && tid == null) {
        ui.log(`${ab.name} needs a target`, 'lvl');
        return;                                   // stay armed, let them click a unit
      }
      if (g) net.send({ t: Msg.CAST, slot: S.castPending, x: g.x, y: g.y, targetId: tid });
      S.castPending = null;
      canvas.style.cursor = 'default';
      return;
    }
    selectionDrag = { x: e.clientX, y: e.clientY, shift: e.shiftKey, ctrl: e.ctrlKey, moved: false };
  } else if (e.button === 2) {
    if (ui.orderPending || S.castPending != null || S.itemPending != null) {
      ui.orderPending = null; S.castPending = null; S.itemPending = null; S.unitCast = null; canvas.style.cursor = 'default'; return;
    }
    if (!commandIds().length) return;
    // Warcraft III's smart order: an item under the cursor beats anything else,
    // and the hero walks to it rather than teleporting it into a slot
    const gi = view.pickItem(nx, ny);
    if (gi && heroSelected()) { net.send({ t: 'pickup', itemId: gi.id }); markMove({ x: gi.x, y: gi.y }); return; }
    const t = view.pickEntity(nx, ny);
    const te = t ? S.ents.get(t.id) : null;
    // Right-clicking a shop walks to it, as Warcraft III does -- you approach a
    // shop to trade with it. It used to send an attack, because this compared
    // TEAMS and a shop sits on player 15's team 2 while the heroes are on 0 and
    // 1. The server refused the order (world.hostile is false for neutral
    // passive, so nothing was ever damaged) but the hero still ran at the
    // building as though it meant to swing.
    if (te && te.p === NEUTRAL_PASSIVE && te.k === Ent.SHOP) {
      sendOrder({ t: Msg.MOVE, x: te.x, y: te.y }, e.shiftKey);
      markMove({ x: te.x, y: te.y });
      return;
    }
    if (t && te) {
      sendOrder({ t: 'smart', targetId: t.id }, e.shiftKey);
    } else if (pickGate(nx, ny) != null) {
      const di = pickGate(nx, ny);
      sendOrder({ t: Msg.ATTACK, targetId: DEST_ID + di }, e.shiftKey);
      const g = S.dests.get(di);
      if (g) markMove(g);
    } else {
      const g = view.pickGround(nx, ny);
      if (g) { sendOrder({ t: Msg.MOVE, x: g.x, y: g.y }, e.shiftKey); markMove(g); }
    }
  }
});
/** A gate under the cursor, if it is still standing. */
function pickGate(nx, ny) {
  if (!S.destPick || !S.destPick.size) return null;
  const i = view.pickDoodad(nx, ny, S.destPick);
  if (i == null) return null;
  return S.dests.get(i)?.dead ? null : i;
}

/**
 * The shops are the buildings inside each base -- five per side, mirrored:
 * n000 스텟 상점, n001 아이템 상점, n00H and n00N 전용템 상점, n013.
 * data/game.json keys its shop list by that unit type, so an entity is a shop
 * when its type id is one of them.
 */
const SHOP_BY_TYPE = new Map();
function shopFor(ent) {
  if (!ent) return null;
  if (!SHOP_BY_TYPE.size) for (const sh of (S.game?.shops || [])) SHOP_BY_TYPE.set(sh.id, sh);
  const e = S.ents.get(ent.id) || ent;
  return SHOP_BY_TYPE.get(e.u) || null;
}

function markMove(g) {
  ui.minimapOrder = { ...g, until: performance.now() + 700 };
  spawnRing(new THREE.Vector3(toX(g.x), view.heightAt(g.x, g.y) + 4, toZ(g.y)), 0x66ff99, 70);
}

canvas.addEventListener('wheel', (e) => {
  if (S.cinematic) return;
  view.camDist = Math.max(700, Math.min(4200, view.camDist * (1 + Math.sign(e.deltaY) * 0.1)));
}, { passive: true });

addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (document.activeElement?.tagName === 'INPUT') return;
  if (S.phase !== Phase.PLAYING || S.cinematic) return;
  if (S.showScore) { if (e.key === 'Escape') ui.onShowScore(false); return; }
  if (document.getElementById('wcDialog')) { if (e.key === 'Escape') ui.closeDialog(); return; }
  if (e.key === 'Enter') { e.preventDefault(); ui.openChat(); return; }
  if (e.key === 'F9' || e.key === 'F10' || e.key === 'F11') {
    e.preventDefault(); ui.openDialog({ F9: 'Quests', F10: 'Main Menu', F11: 'Allies' }[e.key]); return;
  }
  if (e.code === 'Space' || e.key === ' ') {
    e.preventDefault();
    if (!e.repeat && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const alert = alerts.next();
      if (alert) focusCamera(alert.x, alert.y);
    }
    return;
  }
  if (e.key === 'Tab') {
    e.preventDefault();
    if (!ui.shopSel && !e.ctrlKey && !e.metaKey) { selection.cycle(S.ents, e.shiftKey ? -1 : 1); changeSubgroup(); }
    return;
  }
  const itemSlot = { Numpad7: 0, Numpad8: 1, Numpad4: 2, Numpad5: 3, Numpad1: 4, Numpad2: 5 }[e.code];
  if (itemSlot != null) {
    e.preventDefault();
    if (!e.repeat && !e.ctrlKey && !e.altKey && !e.metaKey) ui.activateItem(itemSlot);
    return;
  }
  if (['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key) && !e.altKey && !e.ctrlKey && !e.metaKey) {
    e.preventDefault(); cameraKeys.add(e.key); return;
  }
  // F1 selects your hero in Warcraft III; a melee map has none, so it is a no-op.
  if (e.key === 'F1') { e.preventDefault(); return; }
  if (/^[0-9]$/.test(k)) {
    e.preventDefault();
    if (e.ctrlKey) selection.assign(k, id => canCommand(S.ents.get(id)));
    else {
      selection.recall(k, id => canCommand(S.ents.get(id)));
      setSelection(selection.ids);
      if (lastGroup.key === k && performance.now() - lastGroup.time < 350) {
        const units = commandIds().map(id => S.ents.get(id));
        if (units.length) { focusCamera(units.reduce((n,u) => n + u.x, 0) / units.length, units.reduce((n,u) => n + u.y, 0) / units.length); }
      }
      lastGroup = { key: k, time: performance.now() };
    }
    return;
  }
  if (['m','s','h','a','p'].includes(k)) {
    ui.onCommand({m:'move',s:'stop',h:'hold',a:'attack',p:'patrol'}[k], e.shiftKey); return;
  }
  // The hero skill grid is gone: m/s/h/a/p are this map's real commands, and
  // the rest of the row is the debug views and the escape menu.
  else if (k === '[') { view.frozen = !view.frozen;
    ui.log(`animation ${view.frozen ? 'frozen' : 'running'}`, 'lvl'); }
  else if (k === ']') { view.noUnits = !view.noUnits;
    if (!view.noUnits) for (const v of view.views.values()) v.root.visible = true;
    ui.log(`units ${view.noUnits ? 'hidden' : 'shown'}`, 'lvl'); }
  else if (k === '`') { overlay.stats.on = !overlay.stats.on;
    ui.log(`frame stats ${overlay.stats.on ? 'on' : 'off'}`, 'lvl'); }
  else if (k === 'escape') {
    S.castPending = null; S.itemPending = null; ui.orderPending = null; ui.skillMenu = false; canvas.style.cursor = 'default';
    if (S.hero) ui.updateHero(S.hero);
    if (ui.shopSel) setSelection([S.hero?.id]);
  }
});
addEventListener('keyup', (e) => {
  cameraKeys.delete(e.key);
  if (e.key === 'Alt') S.altHeld = false;
});
// Warcraft III shows every visible unit's bar for as long as ALT is held
addEventListener('keydown', (e) => { if (e.key === 'Alt') S.altHeld = true; });
addEventListener('blur', () => { S.altHeld = false; });
ui.onShowScore = show => { S.showScore = show; ui.toggleScore(show); };
ui.canUseItems = () => S.phase === Phase.PLAYING && !S.cinematic && !!S.hero?.alive && (heroSelected() || !!ui.shopSel);
ui.beforeUseItem = () => { S.castPending = null; S.itemPending = null; ui.orderPending = null; canvas.style.cursor = 'default'; };
ui.getVolume = () => audio.volume;
ui.setVolume = value => { audio.volume = value; if (audio.master) audio.master.gain.value = value; };
ui.onCommand = (command, queue = false) => {
  if (!commandIds().length) return;
  S.castPending = null; S.itemPending = null;
  if (command === 'stop' || command === 'hold') {
    ui.orderPending = null; canvas.style.cursor = 'default';
    sendOrder({ t: command }, queue);
  } else {
    ui.orderPending = command; canvas.style.cursor = 'crosshair';
  }
};
ui.onCastSlot = (slot) => {
  if (!heroSelected()) return;
  const a = S.hero?.abilities?.[slot];
  if (!a || a.lvl < 1) return;
  S.castPending = slot; canvas.style.cursor = 'crosshair';
};

// Casting from a non-hero's command card.
//
// The hero path above names a slot in the hero's own card, which the server resolves
// through its hero table; a footman's card is the list in the snapshot, so this names the
// ability outright and sends the unit it was cast from. Which of the two is armed is
// recorded separately, because a map with heroes and an army has both at once.
//
// The target is sent whenever the click landed on something, and the server decides: it
// runs the same validSpellTarget the spell itself would, so a ground-targeted spell aimed
// at a unit, or a friendly spell aimed at an enemy, is refused with a reason rather than
// quietly doing the wrong thing. The client is not trusted to read Targets correctly for
// the 800 abilities in the table -- the server already has that answer.
const castUnitIds = () => {
  const ids = new Set(commandIds());
  if (S.selected != null && S.ents.get(S.selected)) ids.add(S.selected);
  return [...ids];
};
ui.onUnitCast = (id) => {
  if (S.phase !== Phase.PLAYING) return;
  const ids = castUnitIds();
  if (!ids.length) { ui.log('先选中一个单位再放技能', 'lvl'); return; }
  S.unitCast = { id, unitIds: ids };
  canvas.style.cursor = 'crosshair';
  ui.log(`${(ui.hudData?.strings?.[id]?.name) || id}: 点击地面或目标`, 'lvl');
};

/**
 * What the cursor is over, and what a unit is to you.
 *
 * Warcraft III circles the unit under the pointer as well as the one you have
 * selected, and colours both by relationship rather than by the owner's colour:
 * green yours, yellow an ally, red an enemy.
 */
let mouseNX = 0, mouseNY = 0;
addEventListener('mousemove', (e) => {
  mouseNX = (e.clientX / innerWidth) * 2 - 1;
  mouseNY = -(e.clientY / innerHeight) * 2 + 1;
});
// Warcraft III's fixed neutral slots. Player 15 is Neutral Passive -- the
// shops, the taverns and the pick-area props -- and server/world.js refuses to
// make it hostile to anything. The client has to agree, or it paints a shop as
// an enemy and offers to attack it.
const NEUTRAL_PASSIVE = 15;

function relationTo(e) {
  // The melee map has no hero: "own" is simply every unit whose owner is the
  // player's slot, and the two sides of the duel are team 0 and team 1.
  if (!e) return null;
  if (e.p != null && e.p === S.slot) return 'own';
  if (e.p === NEUTRAL_PASSIVE) return 'neutral';
  if (e.t == null || S.slot == null) return 'neutral';
  return e.t === S.slot ? 'ally' : 'enemy';
}

// Manual camera controls. Only the initial hero spawn centers automatically.
let dragging = false, lastX = 0, lastY = 0, cameraHeroId = null;
let minimapDragging = false, cameraPointer = null, cameraActive = true;
const cameraKeys = new Set();
const minimapCanvas = document.getElementById('mmcanvas');
function cameraInputAllowed() {
  return cameraActive && S.phase === Phase.PLAYING && !S.cinematic && !S.showScore &&
    !document.getElementById('wcDialog') && document.activeElement?.tagName !== 'INPUT';
}
function focusCamera(x, y) {
  view.scriptPan = null; view.focus(x, y, true); view.clampCam(S.bounds);
}
function panCamera(dx, dy) {
  const c = Math.cos(view.camYaw), s = Math.sin(view.camYaw);
  view.panBy(dx * c + dy * s, -dx * s + dy * c);
}
function stepCameraInput(dt) {
  if (!cameraInputAllowed() || minimapDragging || dragging) return;
  let dx = Number(cameraKeys.has('ArrowRight')) - Number(cameraKeys.has('ArrowLeft'));
  let dy = Number(cameraKeys.has('ArrowDown')) - Number(cameraKeys.has('ArrowUp'));
  if (cameraPointer && !cameraPointer.overMinimap) {
    dx += cameraPointer.x < 8 ? -1 : cameraPointer.x > innerWidth - 8 ? 1 : 0;
    dy += cameraPointer.y < 8 ? -1 : cameraPointer.y > innerHeight - 8 ? 1 : 0;
  }
  if (dx || dy) {
    const length = Math.hypot(dx, dy), speed = Math.max(700, view.camDist * .8) * Math.min(dt, .05);
    panCamera(dx / length * speed, dy / length * speed);
  }
}
function minimapLocation(e) { return minimapPoint(S.bounds, minimapCanvas.getBoundingClientRect(), e.clientX, e.clientY); }
minimapCanvas.addEventListener('contextmenu', e => e.preventDefault());
minimapCanvas.addEventListener('mousedown', e => {
  if (!cameraInputAllowed()) return;
  e.preventDefault();
  const point = minimapLocation(e); if (!point) return;
  if (e.button === 2) {
    if (ui.orderPending || S.castPending != null || S.itemPending != null) {
      ui.beforeUseItem(); return;
    }
    if (commandIds().length) { sendOrder({t:Msg.MOVE,...point},e.shiftKey); markMove(point); }
  } else if (e.button === 0) {
    if (ui.orderPending) {
      sendOrder({t:Msg.MOVE,...point,attack:ui.orderPending==='attack',patrol:ui.orderPending==='patrol'},e.shiftKey);
      ui.orderPending=null; canvas.style.cursor='default'; markMove(point); return;
    }
    if (S.castPending != null) {
      const ability=S.hero?.abilities?.[S.castPending];
      if (ability?.targetMode === 'unit') { ui.log('Choose a unit in the world for this ability.','lvl'); return; }
      net.send({t:Msg.CAST,slot:S.castPending,...point});
      S.castPending=null; canvas.style.cursor='default'; return;
    }
    if (S.itemPending != null) { ui.log('Choose a unit in the world for this item.','lvl'); return; }
    minimapDragging=true; focusCamera(point.x,point.y);
  }
});
canvas.addEventListener('mousedown', e => {
  if (e.button === 1 && cameraInputAllowed()) { e.preventDefault(); dragging=true; lastX=e.clientX; lastY=e.clientY; }
});
addEventListener('mouseup', () => { dragging=false; minimapDragging=false; });
addEventListener('mousemove', e => {
  cameraPointer={x:e.clientX,y:e.clientY,overMinimap:!!e.target.closest?.('#minimap')};
  if (!cameraInputAllowed()) return;
  if (minimapDragging) { const p=minimapLocation(e); if(p) focusCamera(p.x,p.y); }
  if (!dragging) return;
  const k=view.camDist/900;
  panCamera(-(e.clientX-lastX)*k,-(e.clientY-lastY)*k);
  lastX=e.clientX; lastY=e.clientY;
});
addEventListener('blur', () => { cameraActive=false; cameraKeys.clear(); cameraPointer=null; dragging=false; minimapDragging=false; });
addEventListener('focus', () => { cameraActive=true; });
document.addEventListener('mouseleave', () => { cameraPointer=null; });

canvas.addEventListener('dblclick', e => {
  if (S.phase !== Phase.PLAYING || S.cinematic || ui.orderPending || S.castPending != null) return;
  const picked = view.pickEntity(e.clientX / innerWidth * 2 - 1, 1 - e.clientY / innerHeight * 2);
  const ent = S.ents.get(picked?.id);
  if (canCommand(ent)) setSelection(sameTypeOnScreen(ent));
});

// lobby buttons
document.getElementById('btnTeam0').onclick = () => net.send({ t: Msg.JOIN_TEAM, team: 0 });
document.getElementById('btnTeam1').onclick = () => net.send({ t: Msg.JOIN_TEAM, team: 1 });
// Language toggle: both languages ship in game.json, so this only re-renders.
const btnLang = document.getElementById('btnLang');
function syncLang() {
  btnLang.textContent = Lang.en ? 'EN' : '\uD55C';
  // both languages ship in game.json; the lobby and the card are re-rendered
  if (S.game) ui.showLobby(S.game);
  if (S.hero) ui.renderAbilities(S.hero);
}
btnLang.onclick = () => { Lang.set(!Lang.en); syncLang(); };
syncLang();

document.getElementById('btnReady').onclick = () => {
  S.ready = !S.ready;   // 官方对战图: 无需选英雄, 直接 ready
  net.send({ t: Msg.READY, ready: S.ready });
  document.getElementById('btnReady').textContent = S.ready ? '取消准备' : '准备';
};

// ------------------------------------------------------------------ main loop
// What the frame costs outside the renderer. Four clock reads, always on, for
// the same reason the renderer keeps its own: a slow frame says nothing about
// which part of it is slow.
const framePerf = { interp: 0, ui: 0 };
function frame() {
  const dt = view.render();
  const tRender = performance.now();
  stepRings(dt);
  // interpolate entity views toward server state
  const alpha = Math.min(1, (performance.now() - S.lastSnap) / 1000 / S.snapDt);
  for (const [id, e] of S.ents) {
    const v = view.views.get(id);
    if (!v) continue;
    const p = S.prev.get(id) || e;
    const x = p.x + (e.x - p.x) * alpha;
    const y = p.y + (e.y - p.y) * alpha;
    v.root.position.set(toX(x), view.heightAt(x, y), toZ(y));
    let df = e.f - v.root.rotation.y;
    while (df > Math.PI) df -= Math.PI * 2;
    while (df < -Math.PI) df += Math.PI * 2;
    v.root.rotation.y += df * Math.min(1, dt * 12);
    // A corpse is not invisible. Warcraft III plays the death animation, decays
    // the flesh and leaves bones behind; hiding the unit the instant it died
    // meant a spider vanished mid-animation and nothing was ever left on the
    // ground. The server now keeps the body for its real decay time and removes
    // it when that runs out, which is what takes the view with it.
    v.root.visible = true;
    if (!v.loading && v.mixer) {
      const moving = Math.hypot(e.x - p.x, e.y - p.y) > 1.2;
      // A corpse ages through three sequences in order -- Death, then Decay
      // Flesh, then Decay Bone -- each starting when the one before it has run
      // out. A model missing one of them simply holds the pose it is in, which
      // pickClip returns null for rather than standing the body back up.
      const done = v.currentAction && !v.currentAction.isRunning();
      let want;
      if (e.a !== 0) want = moving ? 'walk' : 'stand';
      else if (v.stateName === 'death') want = done ? 'decay flesh' : 'death';
      else if (v.stateName === 'decay flesh') want = done ? 'decay bone' : 'decay flesh';
      else if (v.stateName === 'decay bone') want = 'decay bone';
      else want = 'death';
      // Death plays once and holds the final pose. Looping it makes a corpse
      // roll over, snap upright and roll again -- Warcraft III death sequences
      // carry the body a long way (a spider's spans 170 units vertically), so a
      // looped one reads as a live unit tipping over and righting itself.
      const once = want === 'death' || want.startsWith('decay');
      // A state is now a Warcraft III token set -- an ability asks for
      // "spell,slam" rather than "spell" -- so a one-shot cast or attack has to
      // be recognised by its tokens, not by string equality, or walking would
      // cut every such cast off on the next frame.
      const busy = /(^|,|\s)(attack|spell)(,|\s|$)/.test(v.stateName || '');
      if (!busy && v.stateName !== want) view.play(v, want, once);
      else if (busy && v.currentAction && !v.currentAction.isRunning()) view.play(v, want, once);
    }
  }
  const tInterp = performance.now();
  const me = S.ents.get(S.hero?.id);
  if (S.booted && S.phase === Phase.PLAYING && me && cameraHeroId !== S.hero.id) {
    cameraHeroId = S.hero.id;
    if (!view.scriptPan) focusCamera(me.x, me.y);
  }
  stepCameraInput(dt);
  view.stepPan(dt);
  if (S.bounds) view.clampCam(S.bounds);
  if (S.phase === Phase.PLAYING) drawUnitUI();
  if (S.phase === Phase.PLAYING && unitPortrait) unitPortrait.step(dt);
  if (S.phase === Phase.PLAYING && S.bounds)
    ui.drawMinimap(S.bounds, [...S.ents.values()], S.slot, S.minimapImg, view.cameraFootprint());
  if (flashT > 0) { flashT -= dt; document.body.style.boxShadow = `inset 0 0 200px rgba(200,30,30,${flashT * 1.4})`; }
  else document.body.style.boxShadow = '';
  const k = 0.1;
  framePerf.interp += (tInterp - tRender - framePerf.interp) * k;
  framePerf.ui += (performance.now() - tInterp - framePerf.ui) * k;
  if (view.perf) { view.perf.interp = framePerf.interp; view.perf.ui = framePerf.ui; }
  requestAnimationFrame(frame);
}

/**
 * The layer Warcraft III draws over the world: a circle under the unit you are
 * pointing at and under your own hero, and a health bar over each of them --
 * over everything, while ALT is held.
 */
/**
 * The console's own portrait: the hero, animated, in the arch.
 *
 * Built lazily and only once -- it owns a WebGL context, so rebuilding it per
 * hero would leak one every time. It does not turn: Warcraft III's console
 * portrait faces the player and idles, and only the lobby's spins.
 */
let unitPortrait = null;
function showUnitPortrait() {
  const cv = document.getElementById('unitPortrait');
  // While a shop is selected the arch shows the shop's building, as the game
  // does; S.unitModels carries every unit type's model, shops included.
  const sel = ui.shopSel;
  const h = ui.unitSel ? { id: ui.unitSel.u, name: ui.unitSel.name } : sel ? { id: sel.shop.id, name: sel.shop.name } : null;
  if (!cv) return;
  cv.style.visibility = h?.id ? 'visible' : 'hidden';
  if (!h?.id) return;
  const box = cv.getBoundingClientRect();
  const size = { w: Math.max(48, Math.round(box.width) || 128),
                 h: Math.max(48, Math.round(box.height) || 128) };
  if (!unitPortrait) unitPortrait = new HeroPreview(cv, size, { spin: false, fill: 0.9, head: true });
  unitPortrait.show(h, (S.unitModels || {})[h.id]).catch(() => {});
}

const barsShown = new Set();
function drawUnitUI() {
  const hover = view.pickEntity(mouseNX, mouseNY);
  const next = new Set(selection.ids);
  if (hover && S.ents.get(hover.id)?.sel !== false) next.add(hover.id);
  for (const id of markedSelection) if (!next.has(id)) view.markSelected(id, null);
  for (const id of next) view.markSelected(id, relationTo(S.ents.get(id)), S.ents.get(id));
  markedSelection = next;
  barsShown.clear();
  if (S.altHeld) for (const id of S.ents.keys()) barsShown.add(id);
  else for (const id of next) barsShown.add(id);
  overlay.draw(view, S.ents, barsShown);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const savedName = localStorage.getItem('war3web.name') || `Player${Math.floor(Math.random() * 900 + 100)}`;
document.getElementById('pname').value = savedName;
document.getElementById('pname').onchange = (e) => localStorage.setItem('war3web.name', e.target.value);
// A browser will not let a page make noise before it has been touched, and the
// map sets its music in config(), long before that -- so the first interaction
// starts both the effects mixer and whatever music was already asked for.
const wake = () => { audio.init(); audio.unblockMusic(); };
addEventListener('pointerdown', wake, { once: true });
addEventListener('keydown', wake, { once: true });
/**
 * The two canvases the console owns are sized in pixels once, when the art
 * first lands. Everything else in the frame is laid out in percentages and
 * rescales itself, so after a window resize those two -- and only those two --
 * are drawing at the old size into a box that is now a different shape.
 *
 * Coalesced onto a frame: a drag emits resize continuously, and reallocating
 * a drawing buffer per event is the expensive half of this.
 */
let refitQueued = false;
function refitConsole() {
  if (refitQueued) return;
  refitQueued = true;
  requestAnimationFrame(() => {
    refitQueued = false;
    ui.fitMinimap();
    const cv = document.getElementById('unitPortrait');
    if (unitPortrait && cv) {
      const box = cv.getBoundingClientRect();
      unitPortrait.setSize(Math.max(48, Math.round(box.width)),
                           Math.max(48, Math.round(box.height)));
    }
  });
}
addEventListener('resize', refitConsole);

// A handle for the tooling. A WebGL canvas screenshots blank unless
// preserveDrawingBuffer is set, so the only honest way for tools/shot.mjs to
// tell "the scene built" from "the scene is empty" is to count what is in it.
/** An item that is aimed rather than simply used arms the cursor. */
ui.onAimItem = (slot, it) => {
  S.castPending = null;
  S.itemPending = slot;
  canvas.style.cursor = 'crosshair';
  ui.log(`${escapeHtml(it.name || 'item')}: pick a target`, 'lvl');
};

window.FOC = { view, S, ui, net, overlay, audio, refitConsole, shopFor,
               showUnitPortrait, relationTo,
               get consoleSlots() { return consoleSlots; },
               get unitPortrait() { return unitPortrait; } };

ui.setLoading('connecting…', 0.1);
try { net.token = sessionStorage.getItem('war3web.token') || null; } catch { /* private mode */ }
net.connect(savedName);
// M2: WebGPU 渲染器 init 完成后才启动首帧（WebGL 恒立即）
view.rendererReady.then(() => frame());
