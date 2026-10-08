// Lobby + match lifecycle. The map's own JASS script owns the game rules;
// this layer only relays player intent into it and streams state out.
import { randomUUID } from 'node:crypto';
import { World, TYPES, int2id, id2int } from './world.js';
import { entry as abilEntry, isPassive, needsUnitTarget } from './abilities.js';
import { JassEngine } from './jass/engine.js';
import { Phase, Msg, TICK_HZ, SNAP_HZ } from '../shared/const.js';
import { BUILD } from './build.js';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
export const GAME = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/game.json'), 'utf8'));
const HERO_BY_ID = new Map(GAME.heroes.map((h) => [h.id, h]));
// icons for whatever a hero can end up carrying
const ITEM_ICON = new Map(GAME.shops.flatMap((s) => s.items)
  .filter((i) => i.icon).map((i) => [i.id, i.icon]));

/**
 * Card fields for an ability the hero definition never describes.
 *
 * data/game.json carries the abilities a hero can LEARN, so an alternate form's
 * own -- Luffy's 기간트 피스톨, Haku's 아이스블록 파르티잔, Ichigo's Black
 * Getsuga -- are not in it: they belong to the form's unit type.  The name, the
 * level table and the icon all exist in the ability table the engine already
 * reads, and the icon resolves the way tools/compile_game.py resolves it, by
 * file name against the converted textures.
 */
const TEXTURES = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/textures.json'), 'utf8')); }
  catch { return {}; }
})();
const ICON_BY_NAME = new Map(Object.entries(TEXTURES).map(([k, v]) =>
  [k.replace(/\\/g, '/').split('/').pop().replace(/\.[^.]*$/, '').toLowerCase(), v]));
const CARD_CACHE = new Map();
function cardEntry(aid) {
  if (CARD_CACHE.has(aid)) return CARD_CACHE.get(aid);
  const ab = abilEntry(aid);
  const icon = ab && ab.art && typeof ab.art.icon === 'string'
    ? ICON_BY_NAME.get(ab.art.icon.replace(/\\/g, '/').split('/').pop().replace(/\.[^.]*$/, '').toLowerCase())
    : null;
  const v = ab ? { id: aid, name: ab.name || aid, icon: icon || null,
                   hotkey: '', levels: ab.levels || [],
                   maxLvl: (ab.levels || []).length || 1,
                   reqLevel: ab.reqLevel || 0, levelSkip: ab.levelSkip || 0 }
              : {};
  CARD_CACHE.set(aid, v);
  return v;
}

// playable slots and their teams, as the map's config() assigns them
const TEAMS = (GAME.meta.teams || []).filter((t) => t.id < 2);
const PLAYER_SLOTS = TEAMS.flatMap((t) => t.players).sort((a, b) => a - b);
function teamOfSlot(slot) {
  const t = TEAMS.find((x) => x.players.includes(slot));
  return t ? t.id : 0;
}

// Debugging aids -- the level-to-cap key, so far -- are off unless the server
// was started with FOC_DEBUG=1. The client is told, and only binds the key when
// it is on, so a deployed build has no way to reach them and no key that quietly
// does nothing. Turn them on with:  FOC_DEBUG=1 npm start
const DEBUG = process.env.FOC_DEBUG === '1';
// How long a dropped player's seat is held for them. Warcraft III has no
// rejoin at all -- a dropped player has left -- so this is the port's own
// allowance rather than a figure from the game, sized for a page reload or a
// wifi blip rather than a walk away. Tests set it short.
const GRACE_MS = +(process.env.FOC_REJOIN_GRACE_MS || 60000);

let nextPlayer = 1;

/**
 * How many ranks of an ability a hero of this level may hold.
 *
 * Warcraft III gates the skill tree on the ability's own fields: 'reqLevel'
 * unlocks rank 1 and 'levelSkip' is how many hero levels each further rank
 * costs.  This map uses them heavily -- InuYasha's ultimate wants level 30 and
 * five levels per rank -- so the old fixed "every other level, ultimate at 6"
 * rule locked most of the roster out of its own spells.
 */
/**
 * What each spell needs pointed at it, derived by casting every hero ability
 * once and recording which target accessor its trigger reads (tools/spell_targets.mjs).
 * The ability tables carry no such column, so this is the only faithful source.
 */
const SPELL_TARGETS = (() => {
  try { return JSON.parse(fs.readFileSync(new URL('../data/spell_targets.json', import.meta.url), 'utf8')); }
  catch { return {}; }
})();

export function learnCap(ab, heroLevel) {
  if (!ab) return 0;
  const maxLvl = ab.maxLvl || (ab.levels || []).length || 1;
  const req = ab.reqLevel || 0;
  const skip = ab.levelSkip || 0;
  if (heroLevel < req) return 0;
  if (skip <= 0) return maxLvl;                 // no spacing: all ranks at once
  return Math.max(0, Math.min(maxLvl, Math.floor((heroLevel - req) / skip) + 1));
}

export class Room {
  constructor(id = 'arena') {
    this.id = id;
    this.players = new Map();
    this.phase = Phase.LOBBY;
    this.world = null;
    this.eng = null;
    this.loop = null;
    this.snapAcc = 0;
    this.bootReport = null;
    this.resetTimer = null;
  }

  get list() {
    return [...this.players.values()].map((p) => ({
      id: p.id, name: p.name, team: p.team, heroId: p.heroId,
      ready: p.ready, connected: !!p.ws, away: !!p.dropTimer, entId: p.entId ?? null,
      kills: p.kills, deaths: p.deaths, slot: p.slot,
    }));
  }

  join(ws, name, token) {
    // A dropped player coming back inside the grace period gets their own
    // seat, hero and match back rather than a new seat: the token is the one
    // the WELCOME handed them, and only a socketless seat can be reclaimed.
    if (token) {
      const back = [...this.players.values()].find((x) => !x.ws && x.token === token);
      if (back) {
        back.ws = ws;
        if (back.dropTimer) { clearTimeout(back.dropTimer); back.dropTimer = null; }
        // the permanent tags and the atmosphere go out again with the next
        // snapshot, as they do for anyone who was not there when they were set
        back.tagsSent = false;
        this.welcome(back);
        this.broadcastState();
        if (this.phase === Phase.PLAYING) this.sendHero(back);
        return back;
      }
    }
    // A match with nobody connected is being held for the people who dropped
    // out of it, not against a stranger: someone new arriving at it -- no
    // token, or one the grace period has voided -- would otherwise be seated
    // into a running game of ghosts with no lobby in sight. They take the room
    // back to the lobby; the absent players' seats go with it, and a token
    // they come back with after this is a fresh seat like anyone else's.
    if (this.phase !== Phase.LOBBY && ![...this.players.values()].some((x) => x.ws)) this.reset();
    // Terenas 官方对战图: 玩家位 = player 0 / player 1 (2人对战红蓝敌对)
    const used = new Set([...this.players.values()].map((p) => p.slot));
    const chosen = [0, 1].find((sl) => !used.has(sl));
    // The map has ten playable slots and no eleventh. The old fallback walked
    // PLAYER_SLOTS looking for a free one, ran off the end, and used the loop
    // *index* as the slot -- which for a full room is 10, itself a real slot on
    // team 0 and already taken. Two late joiners both became player 10, both on
    // team 0, and the duel they were meant to fight had one side empty.
    if (chosen == null) {
      this.send(ws, { t: Msg.ERROR, m: 'This arena is full.' });
      try { ws.close(); } catch { /* already gone */ }
      return null;
    }
    const p = { id: nextPlayer++, ws, name: (name || 'Player').slice(0, 18),
                slot: chosen, team: chosen, token: randomUUID(),
                heroId: null, ready: false, entId: null, kills: 0, deaths: 0, dropTimer: null };
    this.players.set(p.id, p);
    this.welcome(p);
    this.broadcastState();
    return p;
  }

  welcome(p) {
    this.send(p.ws, {
      t: Msg.WELCOME, you: p.id, token: p.token, phase: this.phase, build: BUILD, debug: DEBUG,
      game: { meta: GAME.meta, bounds: GAME.bounds, shops: GAME.shops, spawns: GAME.spawns,
              // every item type, so the client can draw whatever it finds lying
              // in the world -- a recipe result is in no shop's stock list
              items: GAME.items, sfx: GAME.sfx },
      heroes: GAME.heroes.map(heroSummary),
    });
  }

  /**
   * A socket closed. In the lobby that is a player gone. In a match the seat
   * is held for GRACE_MS -- the hero keeps standing where it was, the script
   * is told nothing -- and only when nobody has come back for it does it
   * become what Warcraft III would have made of the drop in the first place:
   * EVENT_PLAYER_LEAVE, which the map's own triggers act on.
   */
  leave(p) {
    if (!p) return;
    p.ws = null;
    if (this.eng && this.phase === Phase.PLAYING) {
      if (!p.dropTimer) p.dropTimer = setTimeout(() => this.forfeit(p), GRACE_MS);
      this.broadcastState();
      return;
    }
    if (this.phase === Phase.LOBBY) this.players.delete(p.id);
    this.broadcastState();
    if (![...this.players.values()].some((x) => x.ws)) this.reset();
  }

  forfeit(p) {
    p.dropTimer = null;
    if (p.ws) return;                          // came back in time
    p.token = null;                            // the seat is no longer theirs to reclaim
    if (this.eng && this.phase === Phase.PLAYING) {
      const ph = this.eng.players[p.slot];
      const key = this.eng.eventId('EVENT_PLAYER_LEAVE');
      if (key != null) this.eng.fire(key, { player: ph });
    }
    this.broadcastState();
    // a match nobody is connected to and nobody can come back to is over
    if (![...this.players.values()].some((x) => x.ws || x.dropTimer)) this.reset();
  }

  reset() {
    if (this.loop) clearInterval(this.loop);
    // the post-victory timer, or it fires 20 s later into whatever match has
    // started since and tears down the wrong world
    if (this.resetTimer) clearTimeout(this.resetTimer);
    this.resetTimer = null;
    this.loop = null; this.world = null; this.eng = null; this.phase = Phase.LOBBY;
    for (const p of this.players.values()) {
      if (p.dropTimer) { clearTimeout(p.dropTimer); p.dropTimer = null; }
      // Somebody who left during the match was kept so the script could still
      // see their player; back in the lobby there is nothing to keep. Holding
      // them was what filled the room: every finished match left its players
      // behind, and after five of them the slots were gone.
      if (!p.ws) { this.players.delete(p.id); continue; }
      p.heroId = null; p.ready = false; p.entId = null; p.tagsSent = false;
    }
  }

  handle(p, m) {
    switch (m.t) {
      case Msg.JOIN_TEAM:
        if (this.phase === Phase.LOBBY && (m.team === 0 || m.team === 1)) {
          const want = TEAMS.find((t) => t.id === m.team);
          if (want && want.players.length) {
            const taken = new Set([...this.players.values()].filter((x) => x !== p).map((x) => x.slot));
            const free = want.players.find((s) => !taken.has(s));
            if (free != null) { p.team = m.team; p.slot = free; }
          }
          this.broadcastState();
        }
        break;
      case Msg.PICK_HERO:
        if (!HERO_BY_ID.has(m.heroId)) break;
        p.heroId = m.heroId;
        if (this.world && this.phase === Phase.PLAYING) this.buyHero(p);
        this.broadcastState();
        break;
      case Msg.READY: {
        p.ready = !!m.ready;
        if (this.phase === Phase.PLAYING) { break; }   // 官方对战图: 无英雄
        this.broadcastState();
        const active = [...this.players.values()].filter((x) => x.ws);
        if (this.phase === Phase.LOBBY && active.length > 0 && active.every((x) => x.ready))
          this.start();
        break;
      }
      case Msg.CHAT: {
        const text = String(m.text || '').slice(0, 200);
        this.broadcast({ t: Msg.CHATMSG, from: p.name, team: p.team, text });
        // chat also reaches the map's own command triggers (game modes)
        if (this.world) this.world.chat(this.eng.players[p.slot], text);
        break;
      }
      case Msg.PING: this.send(p.ws, { t: Msg.PONG, c: m.c }); break;
      default: this.command(p, m);
    }
  }

  command(p, m) {
    if (!this.world || this.phase !== Phase.PLAYING) return;
    const W = this.world;
    if (m.t === Msg.TRAIN) {
      // RTS 训练: 选中建筑 -> 训练单位 (Terenas 官方对战)
      const ids = m.unitIds === undefined ? [p.entId] : Array.isArray(m.unitIds) ? m.unitIds.slice(0, 4) : [];
      for (const id of ids) {
        const unit = Number.isInteger(id) && this.world.units.get(id);
        if (!unit || unit.playerIndex !== p.slot || !unit.alive) continue;
        this.world.order(unit, { type: 'train', trainType: m.trainType });
      }
      return;
    }
    if (m.t === Msg.BUILD) {
      // RTS 建造: 选中农民 -> 在 (x,y) 建建筑
      const ids = m.unitIds === undefined ? [p.entId] : Array.isArray(m.unitIds) ? m.unitIds.slice(0, 4) : [];
      for (const id of ids) {
        const unit = Number.isInteger(id) && this.world.units.get(id);
        if (!unit || unit.playerIndex !== p.slot || !unit.alive) continue;
        this.world.order(unit, { type: 'build', buildType: m.buildType, x: m.x, y: m.y });
      }
      return;
    }
    if (m.t === 'castUnit') {
      // Casting from a selected unit's command card.
      //
      // Msg.CAST is the hero protocol: it resolves the ability through the hero's own
      // command card (slotAbility looks the slot up in HERO_BY_ID), so on a map whose
      // units are all ordinary footmen and priests there is no hero to resolve and every
      // cast it was asked for found nothing at all. The ability button therefore had
      // nothing behind it -- you could see the spell, you could not cast it.
      //
      // The ability is named outright instead of by slot, because a non-hero's card is
      // the list in the snapshot rather than a fixed layout the server holds. Ownership
      // is checked the same way TRAIN and BUILD check it, so one player cannot spend
      // another's mana, and castAbility itself does the rest: range, target legality,
      // mana, cooldown, and the cast itself.
      const ids = m.unitIds === undefined ? [p.entId] : Array.isArray(m.unitIds) ? m.unitIds.slice(0, 12) : [];
      const target = m.targetId != null ? this.world.units.get(m.targetId) : null;
      let bad = null;
      for (const id of new Set(ids)) {
        const unit = Number.isInteger(id) && this.world.units.get(id);
        if (!unit || unit.playerIndex !== p.slot || !unit.alive) continue;
        const r = this.world.castAbility(unit, m.abilId, target, m.x, m.y);
        if (!r.ok && !bad) bad = r.reason;
      }
      if (bad) this.send(p.ws, { t: Msg.ERROR, m: bad });
      return;
    }
    if ([Msg.MOVE, Msg.STOP, 'hold', Msg.ATTACK, 'smart'].includes(m.t)) {
      // Missing selection is the legacy single-hero protocol. An explicit empty
      // or invalid selection must never silently redirect an order to the hero.
      const ids = m.unitIds === undefined ? [p.entId] : Array.isArray(m.unitIds) ? m.unitIds.slice(0, 12) : [];
      let queueFull = false;
      for (const id of new Set(ids)) {
        const unit = Number.isInteger(id) && W.units.get(id);
        if (!unit || unit.playerIndex !== p.slot || !unit.alive || unit.hidden || unit.removed || unit.pickerProp || W.isLocust(unit)) continue;
        const issue = order => {
          if (W.order(unit, order, m.queue === true)) { unit.controlled = true; unit.returning = false; }
          else if (m.queue === true && unit.orderQueue?.length >= 35) queueFull = true;
        };
        if (m.t === Msg.MOVE) {
          if (Number.isFinite(m.x) && Number.isFinite(m.y))
            issue({ type: m.patrol ? 'patrol' : m.attack ? 'attack' : 'move', x: m.x, y: m.y });
        } else if (m.t === Msg.STOP || m.t === 'hold') issue({ type: m.t });
        else {
          const target = W.target(m.targetId);
          if (m.t === 'smart' && target && !target.isDest) {
            if (target !== unit) issue({ type: W.hostile(unit, target) && W.weaponFor(unit, target) ? 'attack' : 'follow', target });
          } else if (target && !target.isDest && !W.hostile(unit, target)) issue({ type: 'move', x: target.x, y: target.y });
          else if (target && (!target.isDest || target.selectable)) issue({ type: 'attack', target });
        }
      }
      if (queueFull) this.send(p.ws, { t: Msg.ERROR, m: 'Order queue is full (35 commands).' });
      return;
    }
    const u = W.units.get(p.entId);
    if (!u || !u.alive) return;
    switch (m.t) {
      case Msg.CAST: {
        const abilId = this.slotAbility(p, u, m.slot);
        if (!abilId) return;
        const target = m.targetId ? W.units.get(m.targetId) : null;
        const r = W.castAbility(u, abilId, target, m.x, m.y);
        if (!r.ok) this.send(p.ws, { t: Msg.ERROR, m: r.reason });
        break;
      }
      case Msg.LEARN: {
        const abilId = this.slotAbility(p, u, m.slot, true);
        if (!abilId || u.skillPoints < 1) return;
        const cur = W.abilityLevel(u, abilId);
        const hero = HERO_BY_ID.get(p.heroId);
        const ab = hero && hero.abilities.find((a) => a.id === int2id(abilId));
        const cap = learnCap(ab, u.level);
        if (cur >= cap) return;
        W.learnSkill(u, abilId);
        u.skillPoints--;
        this.sendHero(p);
        break;
      }
      case Msg.BUY: this.buyItem(p, u, m.itemId); break;
      case 'useItem': {
        const it = (u.items || [])[m.slot];
        // an item whose ability names a target is cast at one -- the Monster
        // Ball is the only one on this map that does
        const t = m.targetId != null ? W.units.get(m.targetId) : null;
        if (it) { W.useItem(u, it, t); this.sendHero(p); }
        break;
      }
      // ---- level a hero to the cap, for testing a late-game build
      //
      // A level at a time rather than one jump to the cap: stepping is what
      // grants each skill point and fires EVENT_PLAYER_HERO_LEVEL, and the map's
      // own triggers listen for that. Assigning the level outright would leave a
      // level-50 hero with one skill point and skip whatever the script hands
      // out on the way up, which is a different bug to debug against.
      case 'debugLevel': {
        if (!DEBUG) return;
        while (u.level < W.maxHeroLevel) W.setHeroLevel(u, u.level + 1);
        u.xp = 0;
        this.sendHero(p);
        break;
      }
      // ---- kill your own hero outright, for testing what a death does
      //
      // Sibling of debugLevel and gated the same way. The hero-death warning
      // was covered only by tests that handed the client a synthetic death
      // event, which is exactly the shape of test that passes while the real
      // path is broken -- there was no way to make a hero actually die on
      // demand, so nothing ever drove one.
      case 'debugKill': {
        if (!DEBUG) return;
        this.world.killUnit(u, null);
        break;
      }
      // ---- fill the field around your hero, for measuring a crowded frame
      //
      // Third sibling, gated the same way. The client-side cost of a match is
      // set by how many units exist and how many of them the camera can see,
      // and a fresh match has a hundred creeps spread over the whole map.
      // tools/fps_test.mjs needs the crowded case on demand: the same neutral
      // creep types the map already spawned, laid out in a grid around the
      // hero so that some are in frame and most are not, which is the shape of
      // a real field. Capped, because a typo is not a reason to build ten
      // thousand units.
      case 'debugSpawn': {
        if (!DEBUG) return;
        const n = Math.min(1000, Math.max(0, m.n | 0));
        const types = [...new Set([...W.units.values()].filter((x) => x.alive && !x.isHero
          && !x.isBuilding && x.typeKey).map((x) => x.typeKey))];
        const neutral = W.jass.players[12];
        // 20 columns 220 apart: a 4400-wide band, which at the game's camera
        // leaves about a fifth of the field in frame, as a real match does
        const cols = 20, gap = 220;
        for (let i = 0; i < n && types.length; i++) {
          W.createUnit(neutral, types[i % types.length],
                       u.x + (i % cols - cols / 2) * gap, u.y + (Math.floor(i / cols) - n / cols / 2) * gap, 0);
        }
        break;
      }
      case 'dropItem': {
        const it = (u.items || [])[m.slot];
        if (it) { this.world.dropItem(u, it); this.sendHero(p); }
        break;
      }
      case 'pickup': {
        // right-clicking an item on the ground: the hero walks to it and takes
        // it on arrival, exactly as an ordered pickup does in Warcraft III
        const it = this.world.items.get(m.itemId);
        if (it) this.world.orderPickup(u, it);
        break;
      }
      case 'pawnItem': {
        const it = (u.items || [])[m.slot];
        if (it) { this.world.pawnItem(u, it); this.sendHero(p); }
        break;
      }
    }
  }

  /**
   * The command card: the hero's own castables, then anything active the unit
   * is holding right now that is not already on it.
   *
   * Warcraft III builds the card from the UNIT rather than from the hero, and a
   * metamorphosis is a genuine change of unit -- so an alternate form's own
   * ability list reaches the card the moment the form does.  Reading only the
   * static list left five of this map's sixteen forms granting an active
   * ability with no slot to cast it from: Luffy's Gear form carries the 1000
   * damage 기간트 피스톨, Haku's carries 아이스블록 파르티잔, Eneru's carries
   * A01Y, and none could ever be fired.
   *
   * It closes the same gap at the other end.  A hero's base (uabi) abilities
   * only reached `castable` when the map's own script named them in a
   * GetSpellAbilityId comparison, which is a rule about triggers rather than
   * about command cards: Majin Buu's 기폭팔 is a 5000-damage hero nuke that no
   * trigger mentions, so it had no slot either.
   *
   * Appending rather than inserting keeps every existing slot index where it
   * was, and both this and sendHero read the list through here so the client
   * and the server always agree on what slot N means.
   */
  cardSlots(p, u) {
    const hero = HERO_BY_ID.get(p.heroId);
    const list = [...((hero && (hero.castable || hero.learnable)) || [])];
    if (!u || !u.abilities) return list;
    for (const [key] of u.abilities) {
      const aid = int2id(key);
      if (list.includes(aid)) continue;
      const ab = abilEntry(aid);
      if (!ab || isPassive(ab)) continue;
      list.push(aid);
    }
    return list;
  }

  /** Hotkey slot -> the hero's learnable ability id (as the map defines them). */
  slotAbility(p, u, slot, forLearn = false) {
    const hero = HERO_BY_ID.get(p.heroId);
    if (!hero) return null;
    const list = this.cardSlots(p, u);
    const id = list[slot];
    // an innate ability cannot be spent skill points on
    if (forLearn && (hero.innate || []).includes(id)) return null;
    return id ? id2int(id) : null;
  }

  buyHero(p) {
    if (p.entId && this.world.units.get(p.entId)) return;
    const heroId = p.heroId || GAME.heroes[0].id;
    const tavern = this.world.tavernFor(heroId);
    const ph = this.eng.players[p.slot];
    const u = this.world.sellUnit(tavern, ph, heroId);
    if (!u) return;
    p.entId = u.id;
    // the map grants hero spells via its own trigger; make sure the slots exist
    const hero = HERO_BY_ID.get(heroId);
    for (const a of (hero?.learnable || [])) this.world.addAbility(u, id2int(a)) && this.world.setAbilityLevel(u, id2int(a), 0);
    this.sendHero(p);
  }

  buyItem(p, u, itemId) {
    for (const s of GAME.shops) {
      const it = s.items.find((i) => i.id === itemId);
      if (!it) continue;
      const ph = this.eng.players[p.slot];
      if (ph.gold < (it.gold || 0)) { this.send(p.ws, { t: Msg.ERROR, m: 'Not enough gold' }); return; }
      ph.gold -= it.gold || 0;
      const shop = this.world.shopFor(itemId);
      const item = this.world.sellItem(shop, u, itemId);
      if (!item) { ph.gold += it.gold || 0; this.send(p.ws, { t: Msg.ERROR, m: 'Inventory full' }); return; }
      item.name = it.name;
      this.sendHero(p);
      return;
    }
  }

  start() {
    this.world = new World();
    this.eng = new JassEngine(this.world);
    this.eng.load();
    // Seat everyone *before* the script runs. Warcraft III's config() and the
    // map's init read the slot states, and this map gates its duel on which of
    // players 0-7 are PLAYING; booting first meant the script saw an empty
    // lobby and then found players in it afterwards.
    for (const p of this.players.values()) {
      const ph = this.eng.players[p.slot];
      // MAP_CONTROL_USER is 0; 1 is MAP_CONTROL_COMPUTER. Telling the map its
      // humans are computers makes every filter that looks for a real player
      // reject them -- which is how a two-person duel ended with both players
      // sitting in the stands and nobody in the ring.
      ph.name = p.name; ph.controller = 0; ph.slotState = 1;
    }
    const t0 = Date.now();
    this.bootReport = this.eng.boot();
    console.log(`[${this.id}] map script booted in ${Date.now() - t0}ms: ` +
      `${this.eng.triggers.length} triggers, ${this.eng.timers.length} timers, ` +
      `${this.world.units.size} units, ${this.bootReport.errors.length} errors`);
    // 诊断: 单位 owner 分布 (Terenas 接线)
    try {
      const dist = {};
      for (const u of this.world.units.values()) dist[u.playerIndex] = (dist[u.playerIndex] || 0) + 1;
      fs.appendFileSync('/tmp/war3web_diag.log', new Date().toISOString() + ' owner:' + JSON.stringify(dist) + '\n');
      const mine = [...this.world.units.values()].filter(u => [0,1].includes(u.playerIndex));
      fs.appendFileSync('/tmp/war3web_diag.log', ' p0/1 units: ' + mine.map(u => u.typeKey + '@' + u.playerIndex).slice(0, 20).join(',') + '\n');
    } catch (e) { console.log('diag fail', e.message); }
    this.phase = Phase.PLAYING;
    // A load knob for profiling: FOC_EXTRA_MOBS=200 stands that many more creeps
    // on the field so a frame can be measured at the unit count a real match
    // reaches rather than the one an idle test does.
    const extra = +(process.env.FOC_EXTRA_MOBS || 0);
    if (extra) {
      const kinds = [...new Set([...this.world.units.values()]
        .filter((u) => u.alive && !u.isHero && !u.isBuilding && !this.world.isDummy(u))
        .map((u) => u.typeKey))];
      const owner = this.eng.players[12];
      for (let i = 0; i < extra && kinds.length; i++) {
        this.world.createUnit(owner, kinds[i % kinds.length],
                              -1800 + (i % 24) * 130, -1200 + Math.floor(i / 24) * 130, 0);
      }
      console.log(`[${this.id}] FOC_EXTRA_MOBS: +${extra} creeps for profiling`);
    }
    // 官方对战图: 玩家单位由 war3map.j 脚本创建, 无需 FOC 英雄
    this.broadcastState();
    this.loop = setInterval(() => this.stepLoop(), 1000 / TICK_HZ);
  }

  stepLoop() {
    const dt = 1000 / TICK_HZ;
    try {
      this.eng.update(dt);
      const events = this.world.step();
      const scriptEvents = this.eng.flushClientEvents();
      for (const ev of events) {
        if (ev.t === 'death') {
          const u = this.world.units.get(ev.id);
          const k = this.world.units.get(ev.killer);
          for (const p of this.players.values()) {
            if (p.entId === ev.id) p.deaths++;
            if (k && p.entId === k.id) p.kills++;
          }
        }
      }
      // The map selecting a unit for a player: Warcraft III's way of handing
      // over a hero it swapped (Yusuke's demon form is a new unit carrying the
      // old one's stats) or brought back from hiding. A player controls one
      // unit here, so the one selected for them is the one they control from
      // now on. Ownership is checked: the script only ever selects a player's
      // own hero, and nobody else's is handed across.
      for (const ev of scriptEvents) {
        if (ev.t !== 'select') continue;
        const u = this.world.units.get(ev.id);
        const p = [...this.players.values()].find((x) => x.slot === ev.player);
        if (!u || !p || !u.isHero || u.playerIndex !== p.slot || p.entId === u.id) continue;
        p.entId = u.id;
        this.sendHero(p);
      }
      const all = events.concat(scriptEvents);
      // the map declares the winner itself
      const vic = scriptEvents.find((e) => e.t === 'victory');
      if (vic != null && this.phase === Phase.PLAYING) {
        this.phase = Phase.ENDED;
        // the winning slot's team as config() assigned it -- the reporting
        // unit can belong to any of the ten seats, 10 and 11 included
        const team = teamOfSlot(vic.player);
        this.broadcast({ t: Msg.EVENT, ev: [{ t: 'gameover', winner: team,
                         board: this.scriptBoard() }] });
        this.broadcastState();
        clearInterval(this.loop); this.loop = null;
        this.resetTimer = setTimeout(() => { this.reset(); this.broadcastState(); }, 20000);
        return;
      }
      if (all.length) this.broadcast({ t: Msg.EVENT, ev: all.slice(0, 200) });
      if (++this.snapAcc >= TICK_HZ / SNAP_HZ) {
        this.snapAcc = 0;
        const snap = this.world.snapshot();
        snap.board = this.scriptBoard();
        this.broadcast({ t: Msg.SNAPSHOT, s: snap });
        for (const p of this.players.values()) if (p.ws && p.entId) this.sendHero(p);
        // The map's permanent text tags -- the lane and shop labels -- are made
        // once, at init, and broadcast once. They are scenery rather than an
        // event, so anyone who connects later is caught up on them here; a tag
        // with a lifespan is long gone and is deliberately not replayed.
        for (const p of this.players.values()) {
          if (!p.ws || p.tagsSent) continue;
          p.tagsSent = true;
          // The fog, the music list and the day/night models are set once
          // during config() and main(), so a client that was not connected then
          // -- a reconnect, or a second window -- would have a world lit and
          // fogged by the renderer's own constants. They are scenery in exactly
          // the way the tags are, and go out with them.
          const ev = [...this.eng.atmosphereEvents(), ...this.eng.liveTags()];
          if (ev.length) this.send(p.ws, { t: Msg.EVENT, ev });
        }
      }
    } catch (e) {
      // one bad tick is a logged error; killing the process kills every room
      console.error('sim error:', e.message);
    }
  }

  sendHero(p) {
    const u = this.world?.units.get(p.entId);
    if (!u || !p.ws) return;
    const hero = HERO_BY_ID.get(p.heroId) || {};
    const ph = this.eng.players[p.slot];
    const slots = this.cardSlots(p, u);
    const abilities = slots.map((aid, i) => {
      const key = id2int(aid);
      const ab = (hero.abilities || []).find((a) => a.id === aid)
              || cardEntry(aid);
      const lvl = this.world.abilityLevel(u, key);
      const isInnate = (hero.innate || []).includes(aid);
      const cd = (u.cooldowns && u.cooldowns.get(key)) || 0;
      return { slot: i, id: aid, lvl, name: ab.name || aid, icon: ab.icon,
               // the key the map itself assigns this ability (w3a 'ahky').
               // 109 of the 130 hero abilities declare one, and they include
               // T, B, V and C -- none of which the client's old fixed
               // Q/W/E/R/D/F row could produce.
               hotkey: ab.hotkey || '',
               desc: ab.desc || ab.tip, archetype: ab.archetype,
               nameEn: ab.nameEn, descEn: ab.descEn || ab.tipEn,
               maxLvl: ab.maxLvl || (ab.levels || []).length || 1,
               reqLevel: ab.reqLevel || 0, levelSkip: ab.levelSkip || 0,
               innate: isInnate,
               // The classifier calls almost everything 'point' -- it reads
               // the map's own triggers, and one map-wide trigger reads
               // GetSpellTargetLoc on EVERY spell (tools/spell_targets.mjs
               // documents this). Where the engine's own case cannot run
               // without a unit under the cursor, that answer is simply wrong,
               // and the client would let the player click bare ground. The
               // case is the authority on its own requirement.
               targetMode: needsUnitTarget(abilEntry(aid)) ? 'unit'
                           : (SPELL_TARGETS[aid] || 'point'),
               // innate abilities are granted with the unit, never learned
               cap: isInnate ? Math.max(lvl, 1) : learnCap(ab, u.level),
               cdLeft: Math.max(0, (cd - this.world.now) / 1000),
               info: (ab.levels || [])[Math.max(0, lvl - 1)] || {} };
    });
    this.send(p.ws, { t: 'hero', h: {
      id: u.id, unitId: u.typeKey, name: u.properName || u.name, title: hero.title || '',
      titleEn: hero.titleEn || '',
      model: hero.model, level: u.level, xp: Math.round(u.xp),
      // Warcraft III speaks its warnings in the *listening* player's race
      // voice, not the dead unit's, so the client needs to know its own.
      race: (this.world.type(u.typeKey) || {}).race || '',
      skillPoints: u.skillPoints,
      xpNeed: Math.round(this.world.xpForLevel(u.level)),
      maxLevel: this.world.maxHeroLevel,
      hp: Math.round(u.hp), maxHp: Math.round(u.maxHp),
      mana: Math.round(u.mana), maxMana: Math.round(u.maxMana),
      str: Math.round(u.strTotal ?? u.str), agi: Math.round(u.agiTotal ?? u.agi),
      int: Math.round(u.intTotal ?? u.intel),
      dmg: Math.round(u.dmg ?? u.dmgBase), armor: +(u.armorTotal ?? u.armor).toFixed(1),
      moveSpeed: Math.round(u.moveSpeed), gold: Math.round(ph.gold),
      // the top strip reads these; the map spends both (27 gold references in
      // war3map.j, 8 lumber) and never touches food, so supply stays at what
      // the engine reports, which is nothing
      lumber: Math.round(ph.lumber || 0),
      kills: p.kills, deaths: p.deaths, alive: u.alive,
      respawnIn: 0,
      // the inventory the client draws: six slots, as Warcraft III gives a hero
      items: (u.items || []).map((i, n) => ({
        slot: n, id: i.typeKey || int2id(i.typeId),
        name: i.name || int2id(i.typeId),
        icon: (ITEM_ICON.get(i.typeKey || int2id(i.typeId)) || null),
        charges: i.charges || 0,
        // it is aimed at a unit rather than simply used
        targeted: !!this.world.itemSpell(i),
      })),
      abilities,
    } });
  }

  /**
   * The map keeps its own scoreboard — a multiboard grid in some maps, a
   * leaderboard in others. Surface whichever it built, verbatim.
   */
  scriptBoard() {
    const mb = this.eng?.scoreboard?.();
    if (mb) {
      const strip = (x) => String(x).replace(/\|c[0-9a-fA-F]{8}|\|r/g, '').trim();
      const grid = mb.rows.map((r) => r.map(strip));
      // team totals: the row labelled for each side carries its kill count
      const teamRows = grid.filter((r) => /team/i.test(r[0]));
      return { kind: 'multiboard', title: strip(mb.title), cols: mb.cols, rows: grid,
               teams: teamRows.map((r) => ({ label: r[0], value: r[1] })) };
    }
    const lb = (this.eng?.leaderboards || []).find((b) => b.rows.length);
    if (!lb) {
      if (!this.eng) return null;   // 游戏未开始 (join 时也走到这里)
      // Terenas 官方对战: 脚本不建计分板, 显示玩家资源 (金币/木材)
      const rows = [];
      for (const p of this.players.values()) {
        const ph = this.eng.players[p.slot];
        rows.push({ label: p.name,
                    gold: Math.round(ph?.gold ?? 0),
                    lumber: Math.round(ph?.lumber ?? 0) });
      }
      const teams = rows.map((r) => ({ label: r.label, value: r.gold }));
      return { kind: 'multiboard', title: 'Terenas Stand', cols: ['Player', 'Gold', 'Lumber'],
               rows: rows.map((r) => [r.label, r.gold, r.lumber]), teams };
    }
    return { kind: 'leaderboard', title: lb.title,
             rows: lb.rows.map((r) => ({ label: r.label, value: r.value, p: r.p })) };
  }

  broadcastState() {
    this.broadcast({ t: Msg.STATE, phase: this.phase, players: this.list,
                     board: this.scriptBoard(), killsToWin: GAME.meta.killsToWin,
                     dests: this.destState(), winner: null });
  }

  /**
   * What has already been broken. A player who joins or reconnects mid-match
   * has to see the gates that are down, and their hit points if they are not;
   * the events only carry a change.
   */
  destState() {
    if (!this.world) return null;
    const out = [];
    for (const d of this.world.dests.values()) {
      if (!d.selectable) continue;                 // nothing else can be hit
      if (d.alive && d.hp >= d.maxHp) continue;    // untouched, and the default
      out.push({ d: d.index, hp: Math.max(0, Math.round(d.hp)),
                 max: Math.round(d.maxHp), dead: !d.alive });
    }
    return out.length ? out : null;
  }
  send(ws, o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }
  broadcast(o) {
    const s = JSON.stringify(o);
    for (const p of this.players.values()) if (p.ws && p.ws.readyState === 1) p.ws.send(s);
  }
}

function heroSummary(h) {
  return { id: h.id, name: h.name, title: h.title, titleEn: h.titleEn,
           model: h.model, icon: h.icon,
           tavern: h.tavern, custom: h.custom, scale: h.scale, voices: h.voices || [],
           hp: h.hp, mana: h.mana, dmg: h.dmgBase, armor: h.armor,
           moveSpeed: h.moveSpeed, atkRange: h.atkRange,
           str: h.str_, agi: h.agi, int: h.int_,
           abilities: (h.learnable || []).map((id) => {
             const a = (h.abilities || []).find((x) => x.id === id);
             // both languages travel together; the client picks one
             return a ? { id: a.id, name: a.name, nameEn: a.nameEn,
                          icon: a.icon, desc: a.desc || a.tip,
                          descEn: a.descEn || a.tipEn,
                          archetype: a.archetype, levels: (a.levels || []).length || 1 } : null;
           }).filter(Boolean) };
}
