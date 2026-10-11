// server/wasm_bridge.js — M4 阶段 4：server 端 wasm 桥
//
// 目标：封装 wasm 加载 + tick 循环 + SOA 快照 + buff 注入，供 server/room.js
// 与 server/world.js 共同调用（两套共存：world.js 跑能力/触发器/物品，
// wasm 跑模拟核心移动/攻击/经济/buff 效果）。
//
// 使用：
//   const br = new WasmBridge({ walkBin, dmgTable, unitTypes, maxUnits: 512, snapBufSize: 65536 });
//   await br.init();
//   br.spawn(0, 1300, 1100, "hfoo");
//   br.step(1/30);
//   const snap = br.snapshot();     // { tick, nowMs, nUnits, nMissiles, nEvents, units, gold, events }
//   br.applyBuff(0, "regen", 0, 0, 0, 0, 2.0);   // JS 能力施加 buff
//
// 参考：
//   - tools/combat_test.mjs 的 wasm 初始化 + 单位 spawn 模式
//   - tools/snaprender_test.mjs 的 SOA 快照解码
//   - tools/buff_test.mjs 的 sim_apply_buff 用法
//   - engine/src/sim.c 1338-1399 的 SOA 布局
//
// 注意：
//   - sim_apply_buff 的 untilMs 是 C long long，emscripten 绑定需 BigInt
//   - kind 参数支持字符串名（"regen"/"stun"/"slow"...）或数值枚举
//   - typeKey 查表得到战斗/经济单位参数；缺表走默认 hfoo
//   - 模块不依赖外部单例；每个房间/World 实例创建自己的 WasmBridge

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");

// 攻击类型 / 护甲类型枚举（与 combat_test.mjs 一致）
const ATK_TYPES = ["spells", "normal", "pierce", "siege", "magic", "chaos", "hero"];
const ARMOR_KINDS = ["small", "medium", "large", "fort", "normal", "hero", "divine", "none"];

// C buff kind 枚举（engine/src/sim.c 46-61）
const SIM_BUF = {
  speed: 0, mana: 1, armor: 2, vampiric: 3, regen: 4, damage: 5, morph: 6,
  stun: 7, slow: 8, weaken: 9, innerfire: 10, invis: 11, defend: 12,
  rage: 13, manashield: 14, silence: 15,
};
const BUF_BY_NAME = Object.fromEntries(Object.entries(SIM_BUF).map(([k, v]) => [k, v]));

// C 命令枚举（engine/src/sim.c SIM_ORD_*，216-221 行）
// 0 stop / 1 hold / 2 move / 3 attackMove / 4 attack / 5 build
export const SIM_ORD = { stop: 0, hold: 1, move: 2, attackMove: 3, attack: 4, build: 5 };

// 默认单位类型表（Terenas 官方实测值，与 combat_test/snaprender_test/buff_test 一致）
// kind: 0=other/fight 1=hpea(农民) 2=ngol(金矿) 3=htow(基地)
const DEFAULT_TYPES = {
  hfoo: {
    kind: 0, isFight: true,
    hp: 420, armor: 2, armorType: "large", dmgBase: 11, dmgDice: 1, dmgSides: 2,
    atkCd: 1.35, atkRange: 90, attackPoint: 0.5, attackBackswing: 0.5,
    atkType: "normal", weaponKind: 0, missileSpeed: 0, moveSpeed: 270, radius: 31,
  },
  hwat: {
    kind: 0, isFight: true,
    hp: 525, armor: 0, armorType: "large", dmgBase: 17, dmgDice: 1, dmgSides: 5,
    atkCd: 1.5, atkRange: 300, attackPoint: 0.4, attackBackswing: 0.77,
    atkType: "pierce", weaponKind: 1, missileSpeed: 1300, moveSpeed: 220, radius: 32,
  },
  hpea: { kind: 1, isFight: false, moveSpeed: 190, radius: 16, hp: 160 },
  ngol: { kind: 2, isFight: false, moveSpeed: 0, radius: 50, hp: 50 },
  htow: { kind: 3, isFight: false, moveSpeed: 0, radius: 176, hp: 2000 },
  // M4 阶段 5：建筑类型（buildTime 单位秒，isBuilding 标记）
  baam: { kind: 4, isFight: false, moveSpeed: 0, radius: 60, hp: 4500, armor: 3, isBuilding: true, buildTime: 60 },
  bhut: { kind: 4, isFight: false, moveSpeed: 0, radius: 60, hp: 1200, armor: 0, isBuilding: true, buildTime: 30 },
  twog: { kind: 4, isFight: false, moveSpeed: 0, radius: 50, hp: 700, armor: 2, isBuilding: true, buildTime: 55 },
  hbar: { kind: 4, isFight: false, moveSpeed: 0, radius: 80, hp: 1500, armor: 5, isBuilding: true, buildTime: 60 },
  hars: { kind: 4, isFight: false, moveSpeed: 0, radius: 80, hp: 1050, armor: 5, isBuilding: true, buildTime: 70 },
  harm: { kind: 4, isFight: false, moveSpeed: 0, radius: 80, hp: 1200, armor: 5, isBuilding: true, buildTime: 60 },
};

/**
 * wasm 桥：封装 wasm 加载 + tick + 快照 + buff 注入。
 * 每个 server 房间/World 创建独立实例（wasm 内存不共享）。
 */
export class WasmBridge {
  /**
   * @param {object} opts
   * @param {string} opts.walkBin   walk.bin 路径（默认为 public/data/walk.bin）
   * @param {object} opts.dmgTable  damageBonus 表（默认从 data/gameplay.json 读）
   * @param {object} opts.unitTypes 单位类型表（默认用 DEFAULT_TYPES）
   * @param {number} opts.maxUnits  单位槽位数（默认 512，需 >= SIM_MAX 且 <= wasm 侧 SIM_MAX）
   * @param {number} opts.snapBufSize sim_snapshot buffer 容量（float 元素数，默认 65536）
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.walkBinPath = opts.walkBin || path.join(ROOT, "public", "data", "walk.bin");
    this.dmgTable = opts.dmgTable ?? null;
    this.unitTypes = opts.unitTypes || DEFAULT_TYPES;
    this.maxUnits = opts.maxUnits || 512;
    this.snapBufSize = opts.snapBufSize || 65536;
    this.eng = null;
    this._gridPtr = 0;
    this._snapBuf = 0;
    this._sgBuf = 0;
    this._gbBuf = 0;
    this._evBuf = 0;
    this._buildBuf = 0;   // M4 阶段 5：建造状态读取 buffer
    this._initDone = false;
    this._pathMem = 0;    // M6: world 路径同步 scratch（float 点数，懒分配）
    this._pathCap = 0;
  }

  /** 加载 wasm + 初始化 grid + damage table。幂等，重复调用返回 true。 */
  async init() {
    if (this._initDone) return true;
    // 动态 import（避免 Node 加载即执行 wasm 绑定）；Windows 需 file:// URL
    const { default: createEngine } = await import(pathToFileURL(path.join(ROOT, "engine", "out", "engine.mjs")).href);
    this.eng = await createEngine();

    // walk 数据加载（Terenas 384×384，origin -6144,-6144）
    const walkArr = new Uint8Array(fs.readFileSync(this.walkBinPath));
    this._gridPtr = this.eng._malloc(walkArr.length);
    this.eng.HEAPU8.set(walkArr, this._gridPtr);
    this.eng._sim_grid_init(this._gridPtr, 384, 384, -6144, -6144);

    // damage bonus 表（7 攻击类型 × 8 护甲类型）
    const dt = this.dmgTable ?? (JSON.parse(fs.readFileSync(path.join(ROOT, "data", "gameplay.json"), "utf8")).damageBonus || {});
    const tbl = this.eng._malloc(7 * 8 * 4);
    for (let a = 0; a < 7; a++)
      for (let k = 0; k < 8; k++)
        this.eng.HEAPF32[(tbl >> 2) + a * 8 + k] = dt[ATK_TYPES[a]]?.[ARMOR_KINDS[k]] ?? 1;
    this.eng._sim_set_dmg_table(tbl);
    this.eng._free(tbl);

    // 快照 buffer
    this._snapBuf = this.eng._malloc(this.snapBufSize * 4);
    // sim_get_fight 读 buffer：6 float
    this._sgBuf = this.eng._malloc(6 * 4);
    // sim_get_buffs 读 buffer：4 buff × 2 int
    this._gbBuf = this.eng._malloc(4 * 4);
    // 事件读 buffer：预留 8192 条 × 4 float
    this._evBuf = this.eng._malloc(8192 * 4 * 4);
    // M4 阶段 5：建造状态读 buffer：6 float
    this._buildBuf = this.eng._malloc(6 * 4);
    // HEAP32 视图（sim_get_buffs 写 int*）
    this._heap32 = new Int32Array(this.eng.HEAPU8.buffer);

    this.eng._sim_clear_all();
    this.eng._sim_events_reset();
    this._initDone = true;
    return true;
  }

  /** 清所有单位 + 事件（不重置 wasm 内存，仅重置 sim 状态）。 */
  clearAll() {
    this.eng._sim_clear_all();
    this.eng._sim_events_reset();
  }

  /** 推进一个 tick。dt 单位秒（1/30 对应 30 FPS）。 */
  step(dt) {
    this.eng._sim_step(dt);
  }

  /** 清空事件队列（读取事件后调用，避免下次 snapshot 重复带出）。 */
  eventsReset() {
    this.eng._sim_events_reset();
  }

  /**
   * 按 typeKey 查表 spawn 单位。
   * @param {number} id 槽位 id（0..maxUnits-1）
   * @param {number} x 世界 x
   * @param {number} y 世界 y
   * @param {string} typeKey 类型 key（"hfoo"/"hwat"/"hpea"/"ngol"/"htow" 等）
   * @param {object} [meta] { facing, team, playerIndex, bounty, level, hp }
   *   覆盖默认值；isFight 走 sim_spawn_fight，否则 sim_spawn_econ。
   * @returns {boolean} 是否成功
   */
  spawn(id, x, y, typeKey, meta = {}) {
    const T = this.unitTypes[typeKey];
    if (!T) return false;
    if (id < 0 || id >= this.maxUnits) return false;
    const facing = meta.facing ?? 0;
    const team = meta.team ?? 0;
    const pi = meta.playerIndex ?? team;
    const bounty = meta.bounty ?? 0;
    const level = meta.level ?? 1;
    if (T.isFight) {
      const hp = meta.hp ?? T.hp;
      const maxHp = meta.maxHp ?? T.hp;
      this.eng._sim_spawn_fight(
        id, x, y, facing,
        T.moveSpeed, T.radius, hp, maxHp, T.armor,
        ARMOR_KINDS.indexOf(T.armorType), team,
        T.dmgBase, T.dmgDice, T.dmgSides, T.atkCd,
        T.atkRange, T.attackPoint, T.attackBackswing,
        ATK_TYPES.indexOf(T.atkType), T.weaponKind, T.missileSpeed,
      );
    } else {
      const hp = meta.hp ?? T.hp;
      this.eng._sim_spawn_econ(
        id, x, y, T.kind, pi, team,
        T.moveSpeed, T.radius, facing, hp,
      );
    }
    this.eng._sim_set_meta(id, pi, bounty, level);
    return true;
  }

  /**
   * 给单位施加 buff。
   * @param {number} id 单位槽位
   * @param {string|number} kind buff kind（"regen"/"stun"/"slow"/... 或数值枚举）
   * @param {number} code 能力代码（用于同 code 替换；-1 表示按 kind 替换）
   * @param {number|bigint} until 过期 tick（ms 单位；0 = 永久）
   * @param {number} [pct] 百分比系数（如 rage/slow/weaken）
   * @param {number} [atkPct] 攻击速度减损系数（slow/defend）
   * @param {number} [flat] 固定值（armor/regen/manashield）
   * @returns {number} 写入的 buff 槽位；满则 -1
   */
  applyBuff(id, kind, code, until, pct = 0, atkPct = 0, flat = 0) {
    const kindIdx = typeof kind === "string" ? BUF_BY_NAME[kind] : kind;
    if (kindIdx == null) return -1;
    // untilMs 是 C long long，emscripten 绑定需 BigInt
    const untilMs = typeof until === "bigint" ? until : BigInt(Math.round(until || 0));
    return this.eng._sim_apply_buff(id, kindIdx, code | 0, untilMs, pct, atkPct, flat);
  }

  /** 施加 buff 并返回 buff 列表（校验用）。 */
  getBuffs(id) {
    const n = this.eng._sim_get_buffs(id, this._gbBuf, 4);
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push({
        kind: this._heap32[(this._gbBuf >> 2) + i * 2],
        code: this._heap32[(this._gbBuf >> 2) + i * 2 + 1],
      });
    }
    return out;
  }

  /**
   * 读单个单位战斗状态。
   * @returns {{ hp, atkTimer, windup, atkCount, dmgCount, alive }}
   */
  getFight(id) {
    this.eng._sim_get_fight(id, this._sgBuf);
    const b = this._sgBuf >> 2;
    return {
      hp: this.eng.HEAPF32[b],
      atkTimer: this.eng.HEAPF32[b + 1],
      windup: this.eng.HEAPF32[b + 2],
      atkCount: this.eng.HEAPF32[b + 3],
      dmgCount: this.eng.HEAPF32[b + 4],
      alive: this.eng.HEAPF32[b + 5] > 0.5,
    };
  }

  /** 读玩家资源（gold）。 */
  getGold(playerIndex) {
    const b = this.eng._malloc(4);
    this.eng._sim_get_res(playerIndex, b);
    const g = this.eng.HEAPF32[b >> 2];
    this.eng._free(b);
    return g;
  }

  /**
   * M6: 入队一条命令（op 见 SIM_ORD_*）。targetId 为目标单位的 wasm 槽位
   * （attack 用），否则 0。命令在 sim_flush_orders() 后、sim_step 前生效。
   * @returns {boolean} 是否入队成功
   */
  pushOrder(id, op, x, y, targetId = 0) {
    if (!this.eng) return false;
    return this.eng._sim_order_push(id | 0, op | 0, +x || 0, +y || 0, targetId | 0) === 1;
  }

  /** M6: 使已入队命令生效（每次 sim_step 前调用一次）。 */
  flushOrders() {
    if (this.eng) this.eng._sim_flush_orders();
  }

  /**
   * M6: 用 world.js 已算好的路径整段接管单位行走（覆盖 flush 里 A* 的结果）。
   * world 的 u.path 是 [x,y] 世界坐标途经点数组（含终点，stepMove shift 消费）；
   * 传 null 清空路径回 idle。
   * @param {number} id wasm 槽位
   * @param {number[][]|null} pts world u.path
   * @param {number} op SIM_ORD.move / SIM_ORD.attackMove
   */
  commandPath(id, pts, op = SIM_ORD.move) {
    if (!this.eng) return;
    if (!pts || !pts.length) { this.eng._sim_command_path(id | 0, 0, 0, 0); return; }
    const need = pts.length * 2;
    if (need > this._pathCap) {
      if (this._pathMem) this.eng._free(this._pathMem);
      this._pathMem = this.eng._malloc(need * 4);
      this._pathCap = need;
    }
    const f32 = this.eng.HEAPF32;
    for (let i = 0, j = this._pathMem >> 2; i < pts.length; i++) {
      f32[j++] = pts[i][0]; f32[j++] = pts[i][1];
    }
    return this.eng._sim_command_path(id | 0, this._pathMem, pts.length | 0, op | 0);
  }

  /**
   * M4 阶段 5：给工人单位下建造命令。
   * @param {number} id 工人单位槽位
   * @param {string} typeKey 建筑类型 key（"baam"/"bhut"/"twog"/"hbar"/"hars"/"harm"）
   * @param {number} x 建筑落位 x
   * @param {number} y 建筑落位 y
   * @returns {boolean} 是否成功
   */
  orderBuild(id, typeKey, x, y) {
    const T = this.unitTypes[typeKey];
    if (!T || !T.isBuilding) return false;
    // 按 DEFAULT_TYPES 顺序映射到 C 侧 typeIdx
    const BUILD_ORDER = ["baam", "bhut", "twog", "hbar", "hars", "harm"];
    const typeIdx = BUILD_ORDER.indexOf(typeKey);
    if (typeIdx < 0) return false;
    return this.eng._sim_order_build(id, typeIdx, x, y) === 1;
  }

  /**
   * M4 阶段 5：读工人建造状态。
   * @returns {{ progress, time, active, targetType, targetId, completedId }}
   */
  getBuild(id) {
    this.eng._sim_get_build(id, this._buildBuf);
    const b = this._buildBuf >> 2;
    return {
      progress: this.eng.HEAPF32[b],
      time: this.eng.HEAPF32[b + 1],
      active: this.eng.HEAPF32[b + 2],
      targetType: Math.round(this.eng.HEAPF32[b + 3]),
      targetId: Math.round(this.eng.HEAPF32[b + 4]),
      completedId: Math.round(this.eng.HEAPF32[b + 5]),
    };
  }

  /** 读事件队列（不消耗，不 reset）。 */
  getEvents(maxN = 8192) {
    const n = this.eng._sim_events_get(this._evBuf, maxN);
    const out = [];
    for (let i = 0; i < n; i++) {
      const b = (this._evBuf >> 2) + i * 4;
      out.push([
        Math.round(this.eng.HEAPF32[b]),     // tick
        Math.round(this.eng.HEAPF32[b + 1]), // type: 0=attack 1=missileEnd 2=death 3=bounty
        Math.round(this.eng.HEAPF32[b + 2]), // a
        Math.round(this.eng.HEAPF32[b + 3]), // b
      ]);
    }
    return out;
  }

  /**
   * 生成 SOA 快照（解码后返回）。
   * @returns {{
   *   tick, nowMs, nUnits, nMissiles, nEvents,
   *   units: Array<{ id,x,y,facing,hp,maxHp,alive,team,pi,kind,mv,ga,level,mana,maxMana }>,
   *   gold: Array<number> (16),
   *   events: Array<[tick,type,a,b]>,
   *   bufAddr: number,   // 原始 wasm 指针（供零拷贝上传 GPU/WS）
   *   bufSize: number,   // 实际写入的 float 数
   * }}
   */
  snapshot() {
    const need = this.eng._sim_snapshot(this._snapBuf, this.snapBufSize);
    const F = (i) => this.eng.HEAPF32[(this._snapBuf >> 2) + i];
    const tick = Math.round(F(0));
    const nowMs = F(1);
    const nUnits = Math.round(F(2));
    const nMissiles = Math.round(F(3));
    const nEvents = Math.round(F(4));
    const COLS = 15;
    const C = (col, i) => F(5 + col * nUnits + i);
    const units = [];
    for (let i = 0; i < nUnits; i++) {
      units.push({
        id: Math.round(C(11, i)),
        x: C(0, i), y: C(1, i), facing: C(2, i),
        hp: Math.round(C(3, i)), maxHp: Math.round(C(4, i)), alive: C(5, i),
        team: Math.round(C(6, i)), pi: Math.round(C(7, i)),
        kind: Math.round(C(8, i)), mv: C(9, i), ga: C(10, i),
        level: Math.round(C(12, i)), mana: Math.round(C(13, i)), maxMana: Math.round(C(14, i)),
      });
    }
    const goldBase = 5 + nUnits * COLS;
    const gold = [];
    for (let i = 0; i < 16; i++) gold.push(Math.round(F(goldBase + i)));
    // 布局：gold16 → missiles*2 → events*4（见 sim.c 1379-1398）
    const evStart = goldBase + 16 + nMissiles * 2;
    const events = [];
    for (let i = 0; i < nEvents; i++) {
      events.push([
        Math.round(F(evStart + i * 4)),
        Math.round(F(evStart + i * 4 + 1)),
        Math.round(F(evStart + i * 4 + 2)),
        Math.round(F(evStart + i * 4 + 3)),
      ]);
    }
    return {
      tick, nowMs, nUnits, nMissiles, nEvents,
      units, gold, events,
      bufAddr: this._snapBuf,
      bufSize: need,
    };
  }

  /** 释放 wasm 内存（进程退出前调用；不调用也可，wasm 内存随模块销毁）。 */
  destroy() {
    if (!this.eng) return;
    for (const p of [this._snapBuf, this._sgBuf, this._gbBuf, this._evBuf, this._buildBuf, this._gridPtr]) {
      if (p) this.eng._free(p);
    }
    this._initDone = false;
  }
}

export const SIM_BUF_KINDS = SIM_BUF;
export const DEFAULT_UNIT_TYPES = DEFAULT_TYPES;
export default WasmBridge;
