// Lobby + match lifecycle. The map's own JASS script owns the game rules;
// this layer only relays player intent into it and streams state out.
// The WAR3 hero-pick card is gone: Terenas is a straight-up melee map, so a
// player owns the units the map's script gives them and no hero slot.
import { randomUUID } from 'node:crypto';
import { World, TYPES, int2id, id2int } from './world.js';
import { JassEngine } from './jass/engine.js';
import { Phase, Msg, TICK_HZ, SNAP_HZ } from '../shared/const.js';
import { BUILD } from './build.js';
import { WasmBridge, SIM_BUF_KINDS, SIM_ORD } from './wasm_bridge.js';
import fs from 'node:fs';
import path from 'node:path';

// wasm 认识的 buff kind 名（用于判断 world.js 的 buff 能否桥接到 wasm）
const SIM_BUFF_KINDS = new Set(Object.keys(SIM_BUF_KINDS));

// M7：从 world.js 的 TYPES（data/unittypes.json 全表）派生 wasm 能识别的单位类型表。
// 之前的 WasmBridge 只认识硬编码的 11 种（hfoo/hwat/hpea/htow/ngol/baam/bhut/twog/hbar/hars/harm），
// 英雄、野怪、建筑全 spawn 失败 → binary 快照只有玩家几个单位，野怪/英雄走 JSON 通道（位置打架/抽搐）。
// 生成规则：isBuilding → kind 4（金矿=2、大厅=3 特例）；isHero 或 attacksEnabled>0 且 dmgBase>0 → kind 0；
// 其余（农民/浣熊/装饰）→ kind 1。武器：weaponType 含 Missile 类 → 远程（weaponKind=1），Metal/Slice 类 → 近战（0）。
function buildSimUnitTypes() {
  const KIND_REF = { ngol: 2, htow: 3 };
  const MELEE_WT = /Metal|Chop|Slice|Blunt|Punch|Claw|Spear|Fang|Bite|Gore/i;
  const out = {};
  for (const [key, t] of Object.entries(TYPES)) {
    const isB = t.isBuilding === 1 || t.isBuilding === true || t.isBuilding === '1';
    const isHero = t.isHero === 'True' || t.isHero === true || t.isHero === 1;
    const attacks = Number(t.attacksEnabled) > 0;
    const hasDmg = Number(t.dmgBase) > 0 || Number(t.dmgDice) > 0;
    const fights = !isB && (isHero || (attacks && hasDmg));
    const wt = String(t.weaponType || '_');
    const ranged = wt !== '_' && wt !== '' && !MELEE_WT.test(wt);
    out[key] = {
      kind: isB ? (KIND_REF[key] ?? 4) : (fights ? 0 : 1),
      isFight: fights,
      isBuilding: isB,
      buildTime: Number(t.buildTime) || 0,
      moveSpeed: Number(t.moveSpeed) || 0,
      radius: Number(t.collision) || 16,
      hp: Number(t.hp) || 100,
      armor: Number(t.armor) || 0,
      armorType: String(t.armorType) || 'medium',
      dmgBase: Number(t.dmgBase) || 0,
      dmgDice: Number(t.dmgDice) || 0,
      dmgSides: Number(t.dmgSides) || 1,
      atkCd: Number(t.atkCd) || 0,
      atkRange: Number(t.atkRange) || 90,
      attackPoint: Number(t.attackPoint) || 0,
      attackBackswing: Number(t.attackBackswing) || 0,
      atkType: String(t.atkType) || 'normal',
      weaponKind: ranged ? 1 : 0,
      missileSpeed: Number(t.missileSpeed) || 0,
    };
  }
  return out;
}

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
const GRACE_MS = +(process.env.WAR3_REJOIN_GRACE_MS || 60000);

let nextPlayer = 1;

export class Room {
  constructor(id = 'arena') {
    this.id = id;
    this.players = new Map();
    this.phase = Phase.LOBBY;
    this.world = null;
    this.eng = null;
    this.loop = null;
    this._tickRef = 0;   // 自调节 tick 循环的累计基准（ms）
    this.snapAcc = 0;
    this.bootReport = null;
    this.resetTimer = null;
    // M4 阶段 4：wasm 桥 —— world.js 是权威源（能力/触发器/物品），
    // wasm 跑模拟核心（移动/攻击/经济/buff 效果）。两套通过 wasm_bridge
    // 的 spawn/applyBuff/step API 桥接，binary 通道推 SOA 快照给客户端。
    this.bridge = new WasmBridge({ unitTypes: buildSimUnitTypes() });
    this.wasmReady = false;
    // 单位 ↔ wasm 槽位映射：worldUnitId <-> wasmSlot
    this.wasmSlotOf = new Map();
    this.wasmWorldOf = new Map();
    this.wasmSlotSeq = 0;
    // M5: slots registry（wasm slot -> { id, u, k, sel}），client 用它把 SOA
    // 的数字 slot 还原成 typeKey/模型/可选标记
    this.wasmSlots = new Map();
    this.wasmSlotsDirty = false;
    // M6: 世界单位 u.order 内容快照（worldUnitId -> key），用于命令镜像 diff
    this._mirrored = new Map();
    // M8: 上次同步的 buff 快照（unitId -> Map<"kind:code", {untilMs, pct, atkPct, flat}>），
    // 用于逐 tick diff：新增/变更推入 wasm，过期/移除清除 wasm。
    this._syncedBuffs = new Map();
    // M6: 世界单位 u.path 引用快照（worldUnitId -> u.path），用于路径接管 diff
    this._mirrorPathRef = new Map();
    // M5: client 确认收到 binary 后，JSON 快照降频（每 5 帧 ≈ 每 10 tick）
    this.clientBinaryReady = false;
    this.jsonAcc = 0;
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
        this.wasmSlotsDirty = true;   // M5: 重连后重新推送 slots registry
        this.welcome(back);
        this.broadcastState();
        this.sendSlots(back);          // M6: 重连后立即推送 slots registry
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
    this.wasmSlotsDirty = true;   // M5: 新玩家需要 slots registry 解码 binary
    this.welcome(p);
    this.broadcastState();
    this.sendSlots(p);             // M6: 新玩家加入后立即推送 slots registry
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
    // M4 阶段 4：wasm 侧清场（单位/事件），下次开局重新同步；wasm 内存本身
    // 保留（walk grid、dmg table 已初始化，无需重复加载）
    if (this.bridge._initDone) this.bridge.clearAll();
    this.wasmSlotOf.clear();
    this.wasmWorldOf.clear();
    this.wasmSlotSeq = 0;
    this.wasmSlots.clear();
    this.wasmSlotsDirty = false;
    this.clientBinaryReady = false;
    this.jsonAcc = 0;
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
      // M5: client 确认收到 binary 快照，JSON 快照降频
      case Msg.BINARY_READY:
        this.clientBinaryReady = true;
        this.jsonAcc = 0;
        break;
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
      const units = sel(4);
      for (const unit of units) W.order(unit, { type: 'train', trainType: m.trainType });
      // 训练产物由 _syncWasm 同步 spawn；wasm 无训练队列语义
    } else if (m.t === Msg.BUILD) {
      // RTS 建造: 选中农民 -> 在 (x,y) 建建筑
      const units = sel(4);
      for (const unit of units) W.order(unit, { type: 'build', buildType: m.buildType, x: m.x, y: m.y });
    } else if (m.t === 'castUnit') {
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
    } else if ([Msg.MOVE, Msg.STOP, 'hold', Msg.ATTACK, 'smart'].includes(m.t)) {
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
      // 玩家命令只进 world（u.order），下一 tick 由 _mirrorWorldOrders 统一镜像进 wasm
    } else {
      return;   // 未知消息类型，不处理
    }
    // M6: 命令处理后立即广播快照（不等下一个 tick），降低输入延迟
    this.broadcastSnapshotNow();
  }

  /**
   * M6: 世界单位命令 → wasm 镜像（统一命令源）。
   * world 的 order() 是全部命令的入口——玩家命令与内部自动命令（stepGathers
   * 采矿 move、callForHelp 求助攻击等）都会写 u.order。每 tick 对每个有 wasm
   * 槽位的单位比较 u.order 内容快照，变化即 push 进 wasm：
   *   idle→stop、hold→hold、move→move、attackMove/patrol→attackMove、
   *   attack→attack(目标有槽位)/attackMove(目标位置近似)、follow→move 近似。
   * wasm 侧自带 gather_pass/build_pass，命令流一致后两边状态机同步推进。
   * 边界：wasm 无训练/技能语义（跳过）；野怪等无槽位单位不镜像（不参与 wasm）。
   * 玩家命令不再单独接线（删除 _wasmCommand 分支）——命令只进 u.order，
   * 下一 tick 由本函数统一捕获，单一来源不会双写打架。
   */
  _mirrorWorldOrders() {
    if (!this.wasmReady || !this.world) return;
    const W = this.world;
    const OP = SIM_ORD;
    for (const [wuId, slot] of this.wasmSlotOf) {
      const u = W.units.get(wuId);
      if (!u || !u.alive) continue;
      const o = u.order || { type: 'idle' };
      const key = `${o.type}|${o.x ?? ''}|${o.y ?? ''}|${o.targetId ?? ''}`;
      if (this._mirrored.get(wuId) === key) continue;
      this._mirrored.set(wuId, key);
      const B = this.bridge;
      const t = o.type;
      if (process.env.WAR3_TRACE_MIRROR === String(u.id)) {
        console.log(`[m]${this.world.tick} u${u.id} order ${t}(${o.x},${o.y},tgt=${o.targetId ?? ''}) path=${u.path ? u.path.length : 0}`);
      }
      if (t === 'idle' || t === 'stop') B.pushOrder(slot, OP.stop, 0, 0);
      else if (t === 'hold') B.pushOrder(slot, OP.hold, 0, 0);
      else if (t === 'move') B.pushOrder(slot, OP.move, o.x, o.y);
      else if (t === 'attackMove' || t === 'patrol') B.pushOrder(slot, OP.attackMove, o.x ?? 0, o.y ?? 0);
      else if (t === 'attack' || t === 'follow') {
        const target = o.targetId != null ? W.units.get(o.targetId) : null;
        if (!target || !target.alive || target.isDest) { B.pushOrder(slot, OP.stop, 0, 0); continue; }
        const tSlot = this.wasmSlotOf.get(target.id);
        if (t === 'attack' && tSlot != null) B.pushOrder(slot, OP.attack, 0, 0, tSlot);
        else B.pushOrder(slot, t === 'follow' ? OP.move : OP.attackMove, target.x, target.y);
      }
      else if (t === 'build') {
        // M8: 建造命令直接调用（不走 pushOrder 队列，orderBuild 是即时 wasm 调用）
        B.orderBuild(slot, o.typeKey || o.buildType, o.x, o.y);
      }
      // train/cast/其余：wasm 无对应语义，跳过
    }
  }

  /**
   * M6: world 单位路径 → wasm（引用 diff：stepMove 的 shift 只改内容不改引用，
   * routeUnit / requestMovementPath 重算时换新数组）。
   * 必须在 flushOrders() 之后调用——覆盖 flush 里 sim_order_move 自己 A* 的路径，
   * 让 wasm 单位沿 world 同一条路径走，位置逐 tick 同轨。
   */
  _applyWorldPaths() {
    if (!this.wasmReady || !this.world) return;
    const W = this.world;
    const OP = SIM_ORD;
    for (const [wuId, slot] of this.wasmSlotOf) {
      const u = W.units.get(wuId);
      if (!u || !u.alive) continue;
      const o = u.order || { type: 'idle' };
      const t = o.type;
      const active = (t === 'move' || t === 'attackMove' || t === 'patrol') && u.path && u.path.length;
      const ref = active ? u.path : null;
      if (this._mirrorPathRef.get(wuId) === ref) continue;
      this._mirrorPathRef.set(wuId, ref);
      if (process.env.WAR3_TRACE_MIRROR === String(wuId)) {
        console.log(`[p]${W.tick} u${wuId} path ${ref ? ref.length + 'pts' : 'null'} order=${t}`);
      }
      if (ref === null) {
        this.bridge.commandPath(slot, null);   // 到达/打断：清 wasm 路径
      } else {
        this.bridge.commandPath(slot, u.path, t === 'patrol' ? OP.attackMove : OP.move);
      }
    }
  }

  /** M7：world 权威 HP 每 tick 覆盖 wasm。
   *  world.damage() 是唯一权威（普攻/技能/物品/毒伤/治疗/触发都在这里结算）。
   *  wasm 只跑运动学（位置/朝向/移动）与自身普攻结算；HP 每 tick 追平 world 值。
   *  这样避免「wasm 已算普攻伤害、再同步 world 同一次 dmg 事件」造成双倍扣血，
   *  也自动覆盖 world 侧的主动治疗/毒伤/技能伤害。 */
  _syncWorldHp() {
    const W = this.world;
    for (const [id, slot] of this.wasmSlotOf) {
      const w = W.units.get(id);
      if (!w || !w.alive) continue;
      if (Number.isFinite(w.hp)) this.bridge.setHp(slot, w.hp);
      // M8: 英雄蓝条同步（mana>0 才同步，避免非英雄空调用）
      if (w.mana > 0) this.bridge.setMana(slot, w.mana);
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
      // Terenas 官方图: 玩家基地由 Blizzard.j MeleeStartingUnits 按玩家 start
      // location 创建（CreateUnitAtLoc(whichPlayer, 'htow', startLoc, ...)）。
      // 脚本只在 boot 时写入 DefineStartLocation(0, -4032, 2112) / (1, 3968,
      // -2560)；若玩家的 engine index 不在 0/1，startLoc(index) 落到默认
      // [0,0]，基地就建在地图中心（农民/大厅"生成位置错得离谱"）。
      // boot 前把脚本定义的两个基地位置按队伍预置给在座玩家。
      const loc = (p.team === 0 ? [-4032, 2112] : [3968, -2560]);
      this.world.setStartLoc(ph.index, loc[0], loc[1]);
    }
    const t0 = Date.now();
    this.bootReport = this.eng.boot();
    console.log(`[${this.id}] map script booted in ${Date.now() - t0}ms: ` +
      `${this.eng.triggers.length} triggers, ${this.eng.timers.length} timers, ` +
      `${this.world.units.size} units, ${this.bootReport.errors.length} errors`);
    this.phase = Phase.PLAYING;
    // 官方对战图: 玩家单位由 war3map.j 脚本创建, 无需 WAR3 英雄
    // M4 阶段 4：wasm 桥异步初始化，不阻塞开局；init 完成后 stepLoop 自动开始同步
    this._initWasm();
    this.broadcastState();
    // 自调节 tick 循环：setInterval 在 stepLoop 耗时波动时周期漂移（用户观感
    // "掉tick/一抽一抽"——binary 帧到达间隔忽长忽短，客户端位置节拍跳动）。
    // 改为按累计时间对齐：每 tick 后基于基准时间补偿下一周期，stepLoop 耗时可吸收。
    this._tickRef = performance.now() + 1000 / TICK_HZ;
    this.loop = setTimeout(() => this._tickLoop(), 1000 / TICK_HZ);
  }

  /** 自调节 tick：对齐到 _tickRef 累计时刻，stepLoop 耗时不会累积漂移。 */
  _tickLoop() {
    this.stepLoop();
    this._tickRef += 1000 / TICK_HZ;
    const delay = Math.max(0, this._tickRef - performance.now());
    this.loop = setTimeout(() => this._tickLoop(), delay);
  }

  /** 异步加载 wasm 桥（失败时静默降级，仍跑纯 JS 模拟）。 */
  async _initWasm() {
    if (this.wasmReady) return;
    try {
      await this.bridge.init();
      this.wasmReady = true;
      console.log(`[${this.id}] wasm bridge ready`);
    } catch (e) {
      // wasm 加载失败不应中止匹配：world.js 仍在跑完整模拟
      console.error(`[${this.id}] wasm init failed:`, e.message);
    }
  }

  /**
   * 每 tick 同步：把 world.js 里新创建的单位 spawn 到 wasm，并注入当前 buff。
   * 只处理 wasm 认识 typeKey 的单位（hfoo/hwat/hpea/建筑等），其余跳过——
   * 这正是两套共存的边界：wasm 跑它认识的，JS 跑剩下的。
   */
  _syncWasm() {
    if (!this.wasmReady || !this.world) return;
    const W = this.world;
    let dirty = false;
    for (const u of W.units.values()) {
      // 只同步客户端可见、活着、非拾取道具的单位（与 world.snapshot() 过滤条件一致）
      if (!u.alive || u.hidden || u.removed || u.pickerProp) continue;
      if (W.isDummy(u)) continue;
      if (this.wasmSlotOf.has(u.id)) continue;
      if (this.wasmSlotSeq >= this.bridge.maxUnits) break;   // 槽位耗尽，跳过本 tick
      const slot = this.wasmSlotSeq++;
      const ok = this.bridge.spawn(slot, u.x, u.y, u.typeKey, {
        facing: u.facing, team: u.team, playerIndex: u.playerIndex,
        bounty: u.bounty, level: u.level, hp: u.hp, maxHp: u.maxHp,
      });
      if (!ok) continue;   // wasm 不认识此 typeKey，槽位留给下次（wasmSlotSeq 单调递增）
      this.wasmSlotOf.set(u.id, slot);
      this.wasmWorldOf.set(slot, u.id);
      // M5: 注册 slots registry——client 用它把 SOA 的数字 slot 还原成 typeKey
      this.wasmSlots.set(slot, {
        id: u.id, u: u.typeKey,
        k: u.isHero ? 1 : u.isBuilding ? 3 : 2,
        sel: !W.isLocust(u),
      });
      dirty = true;
      // 新单位可能带着初始 buff（例如出生光环）——一并注入
      for (const b of (u.buffs || [])) this._syncBuffToWasm(u, b);
    }
    if (dirty) this.wasmSlotsDirty = true;
  }

  /** 把单个 buff 注入 wasm（code=-1 时按 kind 替换，否则按 code 替换）。 */
  _syncBuffToWasm(u, b) {
    if (!b || !b.kind) return;
    const slot = this.wasmSlotOf.get(u.id);
    if (slot == null) return;
    // wasm_bridge 支持的名字：speed/mana/armor/vampiric/regen/damage/morph/
    // stun/slow/weaken/innerfire/invis/defend/rage/manashield/silence
    const kind = b.kind;
    if (typeof kind === 'string' && !SIM_BUFF_KINDS.has(kind)) return;
    const code = b.code != null ? b.code : -1;
    // until 是绝对毫秒，wasm 侧要相对时长（0 = 永久）
    const untilMs = b.until ? Math.max(0, b.until - (this.world.now || 0)) : 0;
    this.bridge.applyBuff(slot, kind, code, untilMs, b.pct ?? 0, b.atkPct ?? 0, b.flat ?? 0);
  }

  /** M8: 每 tick 对比 world buff 与上次同步快照，新增/变更推入 wasm，过期/移除清除。 */
  _syncBuffs() {
    const W = this.world;
    const now = W.now || 0;
    for (const [wuId, slot] of this.wasmSlotOf) {
      const u = W.units.get(wuId);
      if (!u || !u.alive) continue;
      const buffs = u.buffs || [];
      const current = new Map();
      for (const b of buffs) {
        if (!b || !b.kind) continue;
        const code = b.code != null ? b.code : -1;
        const key = `${b.kind}:${code}`;
        const untilMs = b.until ? Math.max(0, b.until - now) : 0;
        current.set(key, { b, untilMs, pct: b.pct ?? 0, atkPct: b.atkPct ?? 0, flat: b.flat ?? 0 });
      }
      const prev = this._syncedBuffs.get(wuId) || new Map();
      for (const [key, info] of current) {
        const p = prev.get(key);
        if (!p || p.untilMs !== info.untilMs || p.pct !== info.pct
          || p.atkPct !== info.atkPct || p.flat !== info.flat) {
          this._syncBuffToWasm(u, info.b);
        }
      }
      for (const [key] of prev) {
        if (!current.has(key)) {
          const [kind, codeStr] = key.split(':');
          const code = codeStr !== '-1' ? +codeStr : -1;
          this.bridge.applyBuff(slot, kind, code, BigInt(0), 0, 0, 0);
        }
      }
      this._syncedBuffs.set(wuId, current);
    }
  }

  /**
   * M5: 推送 slots registry（wasm slot -> { id, u, k, sel}）+ colors 数组。
   * client 用它把 SOA 快照里的数字 slot 还原成 typeKey/模型/可选标记。
   * 只在 registry 变化时发送（wasmSlotsDirty 标志）。
   */
  _broadcastSlots() {
    const slots = {};
    for (const [slot, info] of this.wasmSlots) slots[slot] = info;
    const colors = [];
    for (let i = 0; i < 16; i++) {
      const p = this.eng?.players?.[i];
      colors[i] = typeof p?.color === 'number' ? p.color : i;
    }
    this.broadcast({ t: Msg.SLOTS, slots, colors });
  }

  /** M6: 向单个客户端发送 slots registry（新玩家加入时立即推送，不等下一个 tick）。 */
  sendSlots(p) {
    if (!p.ws || p.ws.readyState !== 1) return;
    if (this.wasmSlots.size === 0) return;   // M7: 空 registry 不推送（客户端会等 _broadcastSlots）
    const slots = {};
    for (const [slot, info] of this.wasmSlots) slots[slot] = info;
    const colors = [];
    for (let i = 0; i < 16; i++) {
      const pl = this.eng?.players?.[i];
      colors[i] = typeof pl?.color === 'number' ? pl.color : i;
    }
    this.send(p.ws, { t: Msg.SLOTS, slots, colors });
  }

  /** 推送一帧 SOA 二进制快照（与 JSON 快照并列发送）。 */
  _broadcastWasmSnapshot() {
    if (!this.wasmReady) return;
    const snap = this.bridge.snapshot();
    if (!snap.bufSize || snap.bufSize <= 0) return;
    const byteLen = snap.bufSize * 4;
    const src = this.bridge.eng.HEAPU8;
    // 拷贝出 wasm 堆，避免 ws.send 之后 wasm 内存被下一次 step 覆盖
    const buf = new Uint8Array(byteLen);
    buf.set(src.subarray(snap.bufAddr, snap.bufAddr + byteLen));
    this.broadcastBinary(Msg.SNAPSHOT_BIN, buf);
  }

  /** M6: 命令处理后立即广播快照（不等下一个 tick），降低输入延迟。 */
  broadcastSnapshotNow() {
    if (!this.world) return;
    // JSON 快照（包含完整 ents/items/res/clock/quests）
    const snap = this.world.snapshot();
    snap.board = this.scriptBoard();
    this.broadcast({ t: Msg.SNAPSHOT, s: snap });
    // 二进制 SOA 快照（高频位置/HP 更新）
    try { this._broadcastWasmSnapshot(); }
    catch (e) { console.error('wasm snapshot broadcast failed:', e.message); }
    // 重置节拍，避免紧接着的下一 tick 又触发一次快照
    this.snapAcc = 0;
    this.jsonAcc = 0;
  }

  stepLoop() {
    const dt = 1000 / TICK_HZ;
    try {
      this.eng.update(dt);
      const events = this.world.step();
      // M4 阶段 4：wasm 独立推进（移动/攻击/经济/buff 效果）——与 world.step()
      // 各自 tick，SOA 快照以 wasm 为准；JSON 快照仍以 world.js 为准（两套共存）
      if (this.wasmReady) {
        this._syncWasm();
        // M6: 世界单位命令变化 → wasm（含玩家命令 + stepGathers 等自动命令）
        this._mirrorWorldOrders();
        this.bridge.flushOrders();
        // M6: flush 会自己 A*，这里用 world 已算好的路径整段覆盖 → 逐 tick 同轨
        this._applyWorldPaths();
        // M7: world HP 权威覆盖 wasm（普攻/技能/物品/毒伤/治疗/触发每 tick 追平）
        this._syncWorldHp();
        // M8: world buff 变化持续同步 wasm（新增/变更推入，过期/移除清除）
        this._syncBuffs();
        this.bridge.step(1 / TICK_HZ);
      }
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
      // M6: binary 位置/HP 快照每 tick 广播（30 Hz）——位置主通道，绝不能被
      // 15 Hz 节流（否则每 67ms 才跳一次位置 = 用户看到的"一抽一抽/掉 tick"）。
      // JSON 快照才按 clientBinaryReady 降频（元数据刷新）。
      if (this.wasmReady) {
        // M7: world 主动死亡（技能/触发/爆炸）同步 wasm，binary 帧下一 tick 该单位消失
        for (const ev of all) {
          if (ev.t === 'death') {
            const slot = this.wasmSlotOf.get(ev.id);
            if (slot != null) this.bridge.kill(slot);
          }
        }
        try { this._broadcastWasmSnapshot(); }
        catch (e) { console.error('wasm snapshot broadcast failed:', e.message); }
      }
      if (++this.snapAcc >= TICK_HZ / SNAP_HZ) {
        this.snapAcc = 0;
        // M5: slots registry 变化时推送（client 用它解码 binary 快照）
        if (this.wasmSlotsDirty) {
          this._broadcastSlots();
          this.wasmSlotsDirty = false;
        }
        // M5: JSON 快照——clientBinaryReady 后降频（每 5 帧 ≈ 每 10 tick）
        // 降频后 JSON 负责元数据刷新（buff/物品/资源/计分板），binary 负责位置
        this.jsonAcc++;
        const jsonInterval = this.clientBinaryReady ? 5 : 1;
        if (this.jsonAcc >= jsonInterval) {
          this.jsonAcc = 0;
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

  // ---- M5: 二进制 SOA 快照通道 ----
  // WebSocket 二进制帧：客户端 ws.binaryType='arraybuffer' 后直接读 ArrayBuffer，
  // 无 JSON 编解码。帧格式 = 1 字节 tag (Msg.SNAPSHOT_BIN 的 ASCII 首字节 's')
  // + SOA Float32Array 的原始字节。tag 让客户端区分「二进制快照帧」与未来其他
  // 二进制帧（事件流压缩、模型资源推送等），无需 JSON 头。
  sendBinary(ws, tag, buf) {
    if (!ws || ws.readyState !== 1) return;
    const out = new Uint8Array(1 + buf.byteLength);
    out[0] = tag.charCodeAt(0);
    out.set(new Uint8Array(buf), 1);
    ws.send(out);
  }
  broadcastBinary(tag, buf) {
    const out = new Uint8Array(1 + buf.byteLength);
    out[0] = tag.charCodeAt(0);
    out.set(new Uint8Array(buf), 1);
    for (const p of this.players.values()) {
      if (p.ws && p.ws.readyState === 1) p.ws.send(out);
    }
  }
}
