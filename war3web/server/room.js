// Lobby + match lifecycle. The map's own JASS script owns the game rules;
// this layer only relays player intent into it and streams state out.
// The FOC hero-pick card is gone: Terenas is a straight-up melee map, so a
// player owns the units the map's script gives them and no hero slot.
import { randomUUID } from 'node:crypto';
import { World, TYPES, int2id, id2int } from './world.js';
import { JassEngine } from './jass/engine.js';
import { Phase, Msg, TICK_HZ, SNAP_HZ } from '../shared/const.js';
import { BUILD } from './build.js';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
export const GAME = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/game.json'), 'utf8'));

// playable slots and their teams, as the map's config() assigns them
const TEAMS = (GAME.meta.teams || []).filter((t) => t.id < 2);
const PLAYER_SLOTS = TEAMS.flatMap((t) => t.players).sort((a, b) => a - b);
function teamOfSlot(slot) {
  const t = TEAMS.find((x) => x.players.includes(slot));
  return t ? t.id : 0;
}

// How long a dropped player's seat is held for them. Warcraft III has no
// rejoin at all -- a dropped player has left -- so this is the port's own
// allowance rather than a figure from the game, sized for a page reload or a
// wifi blip rather than a walk away. Tests set it short.
const GRACE_MS = +(process.env.FOC_REJOIN_GRACE_MS || 60000);

let nextPlayer = 1;

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
      id: p.id, name: p.name, team: p.team,
      ready: p.ready, connected: !!p.ws, away: !!p.dropTimer,
      kills: p.kills, deaths: p.deaths, slot: p.slot,
    }));
  }

  join(ws, name, token) {
    // A dropped player coming back inside the grace period gets their own
    // seat and match back rather than a new seat: the token is the one
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
    // The map has two playable slots and no third. The old fallback walked
    // PLAYER_SLOTS looking for a free one, ran off the end, and used the loop
    // *index* as the slot -- which for a full room is 2, itself a real slot on
    // team 0 and already taken. Two late joiners both became player 2, both on
    // team 0, and the duel they were meant to fight had one side empty.
    if (chosen == null) {
      this.send(ws, { t: Msg.ERROR, m: 'This arena is full.' });
      try { ws.close(); } catch { /* already gone */ }
      return null;
    }
    const p = { id: nextPlayer++, ws, name: (name || 'Player').slice(0, 18),
                slot: chosen, team: chosen, token: randomUUID(),
                ready: false, kills: 0, deaths: 0, dropTimer: null };
    this.players.set(p.id, p);
    this.welcome(p);
    this.broadcastState();
    return p;
  }

  welcome(p) {
    this.send(p.ws, {
      t: Msg.WELCOME, you: p.id, token: p.token, phase: this.phase, build: BUILD,
      game: { meta: GAME.meta, bounds: GAME.bounds, shops: GAME.shops, spawns: GAME.spawns,
              // every item type, so the client can draw whatever it finds lying
              // in the world -- a recipe result is in no shop's stock list
              items: GAME.items, sfx: GAME.sfx },
    });
  }

  /**
   * A socket closed. In the lobby that is a player gone. In a match the seat
   * is held for GRACE_MS -- the units keep standing where they were, the
   * script is told nothing -- and only when nobody has come back for it does
   * it become what Warcraft III would have made of the drop in the first
   * place: EVENT_PLAYER_LEAVE, which the map's own triggers act on.
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
      p.ready = false; p.tagsSent = false;
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
      case Msg.READY: {
        p.ready = !!m.ready;
        if (this.phase === Phase.PLAYING) { break; }
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

  /**
   * Orders from a selection. unitIds is an explicit list (empty allowed);
   * absent means a legacy single-unit player, which this map never creates.
   * Ownership is checked the same way for every order, so one player cannot
   * spend another's mana or march another's army.
   */
  command(p, m) {
    if (!this.world || this.phase !== Phase.PLAYING) return;
    const W = this.world;
    const sel = (n) => {
      const ids = m.unitIds === undefined ? [] : Array.isArray(m.unitIds) ? m.unitIds.slice(0, n) : [];
      const out = [];
      for (const id of new Set(ids)) {
        const unit = Number.isInteger(id) && W.units.get(id);
        if (unit && unit.playerIndex === p.slot && unit.alive && !unit.hidden
            && !unit.removed && !unit.pickerProp && !W.isLocust(unit)) out.push(unit);
      }
      return out;
    };
    if (m.t === Msg.TRAIN) {
      // RTS 训练: 选中建筑 -> 训练单位 (Terenas 官方对战)
      for (const unit of sel(4)) W.order(unit, { type: 'train', trainType: m.trainType });
      return;
    }
    if (m.t === Msg.BUILD) {
      // RTS 建造: 选中农民 -> 在 (x,y) 建建筑
      for (const unit of sel(4)) W.order(unit, { type: 'build', buildType: m.buildType, x: m.x, y: m.y });
      return;
    }
    if (m.t === 'castUnit') {
      // Casting from a selected unit's command card. The ability is named
      // outright instead of by slot, because a non-hero's card is the list in
      // the snapshot rather than a fixed layout the server holds, and
      // castAbility does the rest: range, target legality, mana, cooldown.
      const units = sel(12);
      const target = m.targetId != null ? W.units.get(m.targetId) : null;
      let bad = null;
      for (const unit of units) {
        const r = W.castAbility(unit, m.abilId, target, m.x, m.y);
        if (!r.ok && !bad) bad = r.reason;
      }
      if (bad) this.send(p.ws, { t: Msg.ERROR, m: bad });
      return;
    }
    if ([Msg.MOVE, Msg.STOP, 'hold', Msg.ATTACK, 'smart'].includes(m.t)) {
      let queueFull = false;
      for (const unit of sel(12)) {
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
    this.phase = Phase.PLAYING;
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
