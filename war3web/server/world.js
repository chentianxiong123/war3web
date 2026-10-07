// Engine-level simulation. Everything Warcraft III's engine does natively lives
// here (movement, pathing, auto-attack, damage, regen, death); everything the
// map's triggers do lives in its own script, run by server/jass.
import fs from 'node:fs';
import path from 'node:path';
import { Grid } from './pathing.js';
import { DEST_ID } from '../shared/const.js';
import { Handle } from './jass/vm.js';
import { ABILS, entry as abilEntry, execute as abilExecute, levelInfo, isPassive,
         auraEffects, auraSources, itemBonuses, itemUse, abilityBonuses, attackProcs,
         carriedImmolation, isMagicalEffect, needsUnitTarget, baseOf as abilBase } from './abilities.js';
import { chatFor } from './chatalias.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const readJSON = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

export const TERR = readJSON('public/data/terrain.json');
export const TYPES = readJSON('data/unittypes.json');
// Lumber a chopped tree yields (WC3: one tree = 10 wood into the bank).
const LUMBER_PER_TREE = 10;
// Train cost/time straight from UnitBalance.slk via data/unittypes.json
// (gold/buildTime columns), so the numbers always match the shipped data.
// Who trains what is the map's own standard melee table (official WC3 human
// buildings): Town Hall trains peasants, Barracks trains footmen+archers,
// Arcane Sanctum trains priests+sorceresses, Workshop the mortar team and
// Gryphon Aviary gryphons+flying machines. The unit list is the part of the
// relationship that lives in Blizzard's game data, not the build-menu wiring.
const BUILD_TRAIN = {
  htow: ['hpea'],
  hbar: ['hfoo', 'harr'],
  hars: ['hpri', 'hsor'],
  harm: ['hmtm'],
  hgra: ['hphx', 'hgyr'],
};
export const TRAIN = {};
for (const k of Object.values(BUILD_TRAIN).flat()) {
  const v = TYPES[k] || {};
  TRAIN[k] = { cost: Math.round(v.gold || 75), time: Math.round((v.buildTime || 20) * 1000) };
}
const WALK = new Uint8Array(fs.readFileSync(path.join(ROOT, 'public/data/walk.bin')));
const FLY = new Uint8Array(fs.readFileSync(path.join(ROOT, 'public/data/fly.bin')));
const FLY_DESTS = readJSON('public/data/flydestructables.json');
// The map's destructables, with the pathing cells each one claims. walk.bin
// already has them stamped in; this is what is needed to take one back out
// again when it dies, which is the only way a closed gate ever opens.
const DESTS = (() => { try { return readJSON('public/data/destructables.json'); }
                       catch { return []; } })();

// Warcraft III plays unit sound sets from the engine, not from map triggers.
// Every item type, not just the ones a shop happens to sell: an item dropped,
// created by the script or carried over from another map still needs to know
// what it grants.  The shop entries are laid on top for the map's own naming.
const ITEMS = (() => {
  const m = {};
  try {
    for (const [id, v] of Object.entries(readJSON('data/itemtypes.json'))) {
      m[id] = { id, name: v.name || '', abilities: v.abilities || [],
                charges: v.uses || 0, gold: v.gold || 0, level: v.level || 1,
                powerup: !!v.powerup };
    }
  } catch { /* no item table built yet */ }
  try {
    const g = readJSON('data/game.json');
    for (const s of g.shops) for (const i of s.items) m[i.id] = Object.assign({}, m[i.id], i);
  } catch { /* no shops */ }
  return m;
})();
const SOUNDSETS = (() => {
  try { return readJSON('data/soundsets.json'); } catch { return {}; }
})();
// Which buffs draw something. Only these are worth telling a client about: the
// rest are numbers it never sees, and a snapshot goes out fifteen times a
// second to everyone.
const BUFF_ART = (() => {
  try { return readJSON('data/buffart.json'); } catch { return {}; }
})();
const HEIGHTS = new Float32Array(fs.readFileSync(path.join(ROOT, 'public/data/heights.bin')).buffer);

// common.j: NORMAL (0) is spell attack type; MELEE (1) is normal weapon damage.
const MAGIC_IMMUNITY_BASES = new Set(['Amim', 'ACmi', 'ACm2', 'ACm3', 'AImx']);
const ATTACK_TYPES = ['spells', 'normal', 'pierce', 'siege', 'magic', 'chaos', 'hero'];
const DEG = Math.PI / 180;
const ART_TTL = 2200;            // how long an ability's own one-shot art lives
const NEUTRAL_HOSTILE = 12;      // creeps
const NEUTRAL_PASSIVE = 15;      // shops, taverns, picker props
const trunc = (v) => (v < 0 ? Math.ceil(v) : Math.floor(v)) | 0;

/** 4-char object id <-> integer, matching JASS 'abcd' literals. */
export function id2int(s) {
  if (typeof s === 'number') return s;
  let v = 0;
  const t = String(s).padEnd(4, ' ').slice(0, 4);
  for (let i = 0; i < 4; i++) v = (v * 256 + t.charCodeAt(i)) | 0;
  return v;
}
export function int2id(v) {
  if (typeof v === 'string') return v;
  let s = '';
  for (let i = 3; i >= 0; i--) s += String.fromCharCode((v >>> (i * 8)) & 0xff);
  return s;
}

const TYPE_BY_INT = new Map();
for (const k of Object.keys(TYPES)) TYPE_BY_INT.set(id2int(k), TYPES[k]);

// unitstate / playerstate ids from common.j
const US_LIFE = 0, US_MAX_LIFE = 1, US_MANA = 2, US_MAX_MANA = 3;
const PS_GOLD = 1, PS_LUMBER = 2, PS_GIVES_BOUNTY = 7;

const GP = (() => {
  try { return readJSON('data/gameplay.json'); } catch { return null; }
})();
const DEF_ARMOR = GP ? GP.defenseArmor : 0.06;
// The engine's own floating text, from UI/MiscData.txt via tools/gameplay.py.
// The fallback is Blizzard's own line for it, so a tree built before that tool
// was extended still prints the right thing rather than nothing.
const TEXT_TAGS = (GP && GP.textTags) || {};
const BOUNTY_TEXT = TEXT_TAGS.bounty
  || { color: [255, 220, 0, 255], vx: 0, vy: 0.03, life: 3, fade: 2 };
const MISS_TEXT = TEXT_TAGS.miss
  || { color: [255, 0, 0, 255], vx: 0, vy: 0.03, life: 3, fade: 1, text: 'miss' };
const CRIT_TEXT = TEXT_TAGS.criticalStrike
  || { color: [255, 0, 0, 255], vx: 0, vy: 0.04, life: 5, fade: 2 };
// UI/MiscData.txt carries a family per kind of floating text and the bash one
// had nothing to fire it, because nothing implemented Bash.
const BASH_TEXT = TEXT_TAGS.bash
  || { color: [255, 0, 0, 255], vx: 0, vy: 0.04, life: 5, fade: 2 };
// Creep leashing, straight from MiscGame.txt.  A unit that strays 'GuardDistance'
// from where it spawned starts thinking about heading back; if it chases for
// 'GuardReturnTime' without being attacked it turns around, and past
// 'MaxGuardDistance' it goes home no matter who is hitting it.
const GUARD_DIST = GP ? GP.guardDistance : 600;
const MAX_GUARD_DIST = GP ? GP.maxGuardDistance : 1000;
const GUARD_RETURN_MS = (GP ? GP.guardReturnTime : 5) * 1000;
const CALL_FOR_HELP = GP ? GP.callForHelp : 600;
const CREEP_CALL_FOR_HELP = GP ? GP.creepCallForHelp : 600;
// Experience tables, built from the MiscGame.txt recurrences.  needHeroXP[L-1]
// is what it costs to leave level L; grant*XP[L-1] is what killing a level-L
// unit is worth.  This map raises MaxHeroLevel to 50 in war3mapMisc.txt.
const XP_NEED = (GP && GP.needHeroXP) || null;
const XP_GRANT_HERO = (GP && GP.grantHeroXP) || null;
const XP_GRANT_NORMAL = (GP && GP.grantNormalXP) || null;
const MAX_HERO_LEVEL = GP ? GP.maxHeroLevel : 10;
const HERO_EXP_RANGE = GP ? GP.heroExpRange : 1200;
const HERO_FACTOR_XP = (GP && GP.heroFactorXP) || [100];
const SUMMONED_KILL_FACTOR = GP ? GP.summonedKillFactor : 0.5;
const BUILDING_KILLS_XP = GP ? !!GP.buildingKillsGiveExp : false;
const DMG_TABLE = GP ? GP.damageBonus : {};

export function armorFactor(armor) {
  return armor >= 0 ? 1 - (DEF_ARMOR * armor) / (1 + DEF_ARMOR * armor)
                    : 2 - Math.pow(1 - DEF_ARMOR, -armor);
}

/** Warcraft III's attack-type vs armour-type multiplier (Custom_V1 MiscGame.txt). */
export function typeBonus(attackType, armorType) {
  const row = DMG_TABLE[String(attackType || 'normal').toLowerCase()];
  if (!row) return 1;
  const v = row[String(armorType || 'none').toLowerCase()];
  return typeof v === 'number' ? v : 1;
}

// Everything a change of unit type replaces, and therefore everything that has
// to be put back when the form runs out.
// Units\MiscData.txt: how far a unit will chase an item it was ordered to take
// before it gives up on it.
const FOLLOW_ITEM_RANGE = 1000;
// Warcraft III has no "pickup range" constant -- the unit walks onto the item
// and takes it on contact, so the test is its own footprint. MiscData gives the
// item's shadow as 120x120, which is the size the game itself treats one as.
const ITEM_REACH = 60;

// Spatial bin size for unit lookups. Most acquisition ranges on this map are
// 500 and the largest is 1150, so a 256-unit cell keeps a typical query to a
// 5x5 block of cells rather than the whole world. BIN_COLS only has to be wider
// than the map in cells for the key arithmetic to stay collision-free.
const BIN = 256;
const BIN_COLS = 1 << 12;
const BIN_OFF = BIN_COLS >> 1;      // so a negative coordinate still keys uniquely

/**
 * Which bin a world position falls in.
 *
 * The offset matters: this map runs from -6144 to +6272, and folding a negative
 * cell index straight into `row * COLS + col` lets two different cells produce
 * the same key. Clamping rather than wrapping keeps a unit dumped far off the
 * map in an edge bin, which is still correct -- the exact distance check behind
 * this filters it -- instead of colliding with something in the middle.
 */
function binKey(x, y) {
  const cx = Math.min(BIN_COLS - 1, Math.max(0, Math.floor(x / BIN) + BIN_OFF));
  const cy = Math.min(BIN_COLS - 1, Math.max(0, Math.floor(y / BIN) + BIN_OFF));
  return cy * BIN_COLS + cx;
}

// AbilityMetaData gives the Ore1 field -- "Reincarnation Delay" in
// WorldEditStrings -- to exactly these three, which is the family that gets
// back up: AOre is the hero form, ACrn and ANrn the unit ones.
const REINCARNATE = new Set(['AOre', 'ACrn', 'ANrn']);
/**
 * Bases whose caster stands channelling until the spell is done: Blizzard and
 * Rain of Fire's waves, Starfall, Stampede, Cluster Rockets, Aerial Shackles.
 * Engine behaviour rather than a field -- no table in the archives says which
 * abilities hold their caster -- so this is the set the engine's own cases
 * queue waves for, less Bladestorm (AOww), whose caster walks while it spins.
 * ENDCAST waits on these; for everything else it follows EFFECT on the tick.
 */
const CHANNEL_HOLDS = new Set(['AHbz', 'ACbz', 'ANrf', 'ACrf', 'AEsf', 'ANst', 'ANcs', 'Amls']);

const WEAPON_FIELDS = ['atkTargetsAllowed', 'weaponKind', 'dmgBase', 'dmgDice', 'dmgSides',
  'atkCd', 'atkRange', 'atkType', 'attackPoint', 'attackBackswing',
  'missile', 'missileSpeed', 'missileArc', 'missileHoming'];
const secondWeapon = t => t ? Object.fromEntries(WEAPON_FIELDS.map(k => [k, t[k + '2']])) : null;

const MORPH_FIELDS = ['turnRate', 'atkTargetsAllowed', 'weaponKind', 'weapon2', 'typeId', 'typeKey', 'model', 'icon', 'armor', 'armorType',
  'movementType', 'targetAs', 'classifications', 'flyHeight',
  'attackPoint', 'attackBackswing', 'atkType', 'dmgBase', 'dmgDice', 'dmgSides', 'atkCd', 'atkRange', 'attacksEnabled', 'missile',
  'missileSpeed', 'missileArc', 'missileHoming', 'baseMoveSpeed', 'radius',
  'renderScale', 'hpReg', 'manaReg', 'str', 'strLvl', 'agi', 'agiLvl',
  'intel', 'intLvl'];

export class World {
  constructor() {
    // a copy, not the module's array: a gate that dies opens cells, and one
    // world's broken gate must not be broken in the next match as well
    this.walk = new Uint8Array(WALK);
    this.grid = new Grid(this.walk, TERR.pathWidth, TERR.pathHeight, TERR.offsetX, TERR.offsetY);
    this.fly = new Uint8Array(FLY);
    this.flyGrid = new Grid(this.fly, TERR.pathWidth, TERR.pathHeight, TERR.offsetX, TERR.offsetY);
    this.units = new Map();
    this.dests = new Map();
    this.items = new Map();
    this.nextId = 1;
    this.now = 0;
    this.dt = 1 / 30;
    this.tick = 0;
    this.jass = null;
    this.startLocs = [];
    this.alliances = new Map();
    this.playerCount = 12;
    this.clientEvents = [];
    this.fxSeq = 0;                // ids for engine-drawn ability art
    this.missiles = [];            // shots in flight, resolved on impact
    this.regionWatch = [];
    this.initDests();
  }

  /**
   * The map's destructables as things that can be hit.
   *
   * war3map.doo gives each placement a life percentage and DestructableData
   * gives the type its hit points, its selectable flag and the footprint it
   * stands on. Only the six gates are selectable -- the stone walls, the trees
   * and the pathing blockers are 0, and Warcraft III will not let a click land
   * on one of those -- but every one of them is built, because every one of
   * them owns cells that have to be released if it ever dies.
   */
  initDests() {
    for (const r of DESTS) {
      const maxHp = r.hp || 1;
      this.dests.set(DEST_ID + r.d, {
        id: DEST_ID + r.d, isDest: true, index: r.d, typeKey: r.id,
        x: r.x, y: r.y, facing: r.r || 0,
        hp: maxHp * ((r.life ?? 100) / 100), maxHp,
        radius: r.rad || 0, selectable: !!r.sel, targType: r.targ || '',
        armorType: 'none', armorTotal: 0, armor: 0,
        cells: r.c || [], ownCells: r.w || r.c || [],
        deadCells: r.k || [], deathSound: r.snd || null,
        alive: true,
      });
    }
  }

  /**
   * An order or a spell may name either kind of thing, so both id spaces
   * resolve through here. units.get() on its own silently missed a gate and
   * stepAttack then fell through to acquiring whatever enemy stood nearest.
   */
  target(id) {
    if (id == null) return null;
    return this.units.get(id) || this.dests.get(id) || null;
  }

  /**
   * How far a unit is from a destructable it means to hit.
   *
   * Not the distance to its centre: a gate is 896 units across and its centre
   * is inside its own footprint, where nothing can stand, so a melee hero beside
   * one would never be in range of it. The footprint is what the thing occupies,
   * so the range is measured to the nearest cell of it.
   */
  destRange(d, x, y) {
    if (d._cx == null) {
      const W = TERR.pathWidth;
      d._cx = d.cells.map((c) => TERR.offsetX + ((c % W) + 0.5) * 32);
      d._cy = d.cells.map((c) => TERR.offsetY + (Math.floor(c / W) + 0.5) * 32);
    }
    let best = Infinity;
    for (let i = 0; i < d._cx.length; i++) {
      const dx = d._cx[i] - x, dy = d._cy[i] - y;
      const v = dx * dx + dy * dy;
      if (v < best) best = v;
    }
    // half a cell in, so touching the footprint's edge counts as reaching it
    return Math.max(0, Math.sqrt(best) - 16);
  }

  /**
   * Kill a destructable and give its ground back.
   *
   * A cell only reopens when nothing standing still claims it: neighbouring
   * walls overlap where their bars meet, and a gate keeps its own posts --
   * pathTexDeath is the two pillars, so a broken gate is a hole with rubble
   * either side rather than clear ground.
   */
  killDest(d, src) {
    if (!d || !d.alive) return;
    d.alive = false; d.hp = 0;
    const still = new Set();
    for (const o of this.dests.values()) {
      if (!o.alive || o === d) continue;
      for (const c of o.cells) still.add(c);
    }
    const keep = new Set(d.deadCells);
    let opened = 0;
    // ownCells is the part of the footprint the bare terrain allows: a cell the
    // terrain blocks was never this destructable's to give back
    for (const c of d.ownCells) {
      if (keep.has(c) || still.has(c)) continue;
      if (this.walk[c] !== 1) { this.walk[c] = 1; opened++; }
    }
    if (opened) this.grid.invalidate();
    // Chopping a tree pays lumber to the attacker's player -- the WC3 meat of
    // the wood economy. Only trees carry the lumber tag.
    if ((d.targ === 'tree' || d.kind === 'tree') && src) {
      const owner = this.jass?.players?.[src.playerIndex];
      if (owner && src.playerIndex >= 0 && src.playerIndex < 12) {
        owner.lumber = (owner.lumber || 0) + LUMBER_PER_TREE;
        this.emit({ t: 'lumber', player: src.playerIndex, lumber: Math.round(owner.lumber) });
      }
    }
    const flight = FLY_DESTS.find(r => r.d === d.index);
    if (flight) {
      const claimed = new Set();
      for (const r of FLY_DESTS) {
        const alive = this.dests.get(DEST_ID + r.d)?.alive;
        for (const c of (alive ? r.c : r.k || [])) claimed.add(c);
      }
      for (const c of flight.w) if (!claimed.has(c)) this.fly[c] = 1;
      this.flyGrid.invalidate();
    }
    this.emit({ t: 'destDead', d: d.index, id: d.id, opened });
    // deathSnd names a label -- TreeWallDeath -- and animsounds.json is keyed by
    // MDX event id, not by label, so there is nothing yet to resolve it against.
    // Only the trees carry one and nothing can hit a tree here; the field is
    // kept so it is ready when the label table is.
    // anything walking now has a stale route: the world it was planned in has
    // changed shape, and a path that went the long way round is no longer the
    // one the unit would pick
    for (const u of this.units.values()) if (u.alive && u.path) u.path = null;
  }

  // ------------------------------------------------------------------ terrain
  /** The ResourceBar numbers for one player: gold/lumber and supply used/max. */
  playerRes(index) {
    const p = this.jass?.players?.[index];
    let supply = 0, supplyMax = 0;
    for (const u of this.units.values()) {
      if (u.playerIndex !== index || !u.alive) continue;
      const info = TYPES[u.typeKey];
      if (info) {
        if (info.food) supply += info.food;
        if (info.foodMade) supplyMax += info.foodMade;
      }
    }
    return {
      gold: Math.round(p?.gold || 0),
      lumber: Math.round(p?.lumber || 0),
      supply: Math.round(supply),
      supplyMax: Math.round(supplyMax || 5),
    };
  }

  bounds() {
    const w = (TERR.width - 1) * TERR.tileSize, h = (TERR.height - 1) * TERR.tileSize;
    return { minx: TERR.offsetX, miny: TERR.offsetY, maxx: TERR.offsetX + w, maxy: TERR.offsetY + h };
  }
  terrainZ(x, y) {
    const fx = (x - TERR.offsetX) / TERR.tileSize, fy = (y - TERR.offsetY) / TERR.tileSize;
    const i = Math.max(0, Math.min(TERR.width - 1, Math.round(fx)));
    const j = Math.max(0, Math.min(TERR.height - 1, Math.round(fy)));
    return HEIGHTS[j * TERR.width + i] || 0;
  }
  walkable(x, y) { return this.grid.walkableAt(x, y); }
  setStartLoc(i, x, y) { this.startLocs[trunc(i)] = [x, y]; this._bases = null; }
  startLoc(i) { return this.startLocs[trunc(i)] || [0, 0]; }

  /**
   * Team bases. Maps that pick heroes in-world put every player slot on one
   * shared pick point and give each team its own extra start location; the
   * pick area is walled off, so heroes belong at the base instead.
   */
  teamBase(team) {
    if (!this._bases) {
      const locs = this.startLocs.filter(Boolean);
      const key = (l) => l[0] + ',' + l[1];
      const counts = new Map();
      for (const l of locs) counts.set(key(l), (counts.get(key(l)) || 0) + 1);
      const shared = [...counts].sort((a, b) => b[1] - a[1])[0];
      const distinct = shared && shared[1] > 1
        ? locs.filter((l) => key(l) !== shared[0]) : [];
      const uniq = [];
      for (const l of distinct) if (!uniq.some((u) => key(u) === key(l))) uniq.push(l);
      this._bases = uniq.length >= 2 ? uniq : locs;
    }
    return this._bases[team] || this._bases[0] || [0, 0];
  }

  // ------------------------------------------------------------- unit types
  type(id) {
    if (typeof id === 'number') return TYPE_BY_INT.get(id) || null;
    return TYPES[id] || TYPE_BY_INT.get(id2int(id)) || null;
  }
  typeName(id) { const t = this.type(id); return t ? (t.properName || t.name || int2id(id)) : ''; }

  /**
   * Warcraft III's GetObjectName takes any object id, not just a unit type.
   * Reading it as a unit type alone is why the map's spell shout came out as
   * " !!": its one call site is GetObjectName(GetSpellAbilityId()), so the id
   * it is handed is always an ability's and never a unit's.
   */
  objectName(id) {
    const t = this.type(id);
    if (t) return t.properName || t.name || int2id(id);
    const key = typeof id === 'number' ? int2id(id) : String(id);
    // The names come out of the object editor padded to a fixed width
    const ab = ABILS[key];
    if (ab && ab.name) return String(ab.name).trim();
    const it = ITEMS[key];
    if (it && it.name) return String(it.name).trim();
    return '';
  }
  isHeroType(id) { const t = this.type(id); return !!(t && t.isHero); }

  randomCreep(level) {
    const lv = trunc(level);
    const pool = [];
    for (const [i, t] of TYPE_BY_INT) {
      if (String(t.race).toLowerCase() !== 'creeps') continue;
      if (t.level !== lv) continue;
      if (t.isBuilding) continue;
      pool.push(i);
    }
    if (!pool.length) return 0;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  // ------------------------------------------------------------------- units
  createUnit(playerHandle, typeIdRaw, x, y, facingDeg) {
    const t = this.type(typeIdRaw);
    const typeId = typeof typeIdRaw === 'number' ? typeIdRaw : id2int(typeIdRaw);
    const pidx = playerHandle ? playerHandle.index : 12;
    const radius = t ? Math.max(8, t.collision) : 24;
    const [ux, uy] = this.freeSpotNear(x, y, radius, t?.movementType);
    const maxHp = t ? Math.max(1, t.hp) : 100;
    const maxMana = t ? t.mana : 0;
    const u = new Handle('unit', {
      id: this.nextId++, typeId, typeKey: int2id(typeId), playerIndex: pidx,
      team: playerHandle ? playerHandle.team : 2,
      name: t ? (t.properName || t.name) : int2id(typeId),
      properName: t ? t.properName : null,
      model: t ? t.model : '', icon: t ? t.icon : '',
      x: ux, y: uy, facing: (facingDeg || 0) * DEG,
      alive: true, hidden: false, paused: false, invulnerable: false,
      hp: maxHp, maxHp, mana: t ? (t.manaStart || maxMana) : 0, maxMana,
      hpReg: t ? t.hpReg : 0, manaReg: t ? t.manaReg : 0.01,
      armor: t ? t.armor : 0,
      armorType: t ? (t.armorType || 'none') : 'none',
      atkTargetsAllowed: t?.atkTargetsAllowed ?? '', weaponKind: t?.weaponKind || '',
      weapon2: secondWeapon(t),
      atkType: t ? (t.atkType || 'normal') : 'normal',
      dmgBase: t ? t.dmgBase : 0, dmgDice: t ? t.dmgDice : 1, dmgSides: t ? t.dmgSides : 1,
      attackPoint: t?.attackPoint ?? 0, attackBackswing: t?.attackBackswing ?? 0,
      atkCd: t ? Math.max(0.2, t.atkCd) : 1.5, atkRange: t ? t.atkRange : 90, atkTimer: 0,
      // UnitWeapons.slk 'weapsOn' / the map's own 'uaen': how many of the unit
      // type's weapons are turned on.  Zero means it has no attack at all --
      // 103 of this map's unit types say so, and every one of them is a dummy
      // carrying its base's damage that it is never meant to use.
      attacksEnabled: t ? (t.attacksEnabled ?? 1) : 1,
      // the weapon's missile, if it throws one (Units\*UnitFunc.txt)
      missile: t ? t.missile : null, missileSpeed: t ? t.missileSpeed : 0,
      missileArc: t ? t.missileArc : 0, missileHoming: t ? t.missileHoming : 0,
      moveSpeed: t ? t.moveSpeed : 270, baseMoveSpeed: t ? t.moveSpeed : 270,
      radius: t ? Math.max(8, t.collision) : 24,
      renderScale: t ? t.scale || 1 : 1,
      // A unit type's 'level' is its data level (bounty, XP granted).  Warcraft
      // III heroes always enter the world at level 1 regardless of it -- this
      // map stamps every hero type level 5, which was handing them four free
      // levels and unlocking abilities their level should not reach yet.
      level: t && t.isHero ? 1 : (t ? t.level : 1),
      xp: 0, skillPoints: t && t.isHero ? 1 : 0,
      isHero: !!(t && t.isHero), isBuilding: !!(t && t.isBuilding),
      // how long this unit's death animation runs before the corpse decays
      deathTime: t && t.deathTime != null ? t.deathTime : 3,
      str: t ? t.str_ : 0, strLvl: t ? t.strLvl : 0,
      agi: t ? t.agi : 0, agiLvl: t ? t.agiLvl : 0,
      intel: t ? t.int_ : 0, intLvl: t ? t.intLvl : 0,
      abilities: new Map(), items: [], buffs: [],
      order: { type: 'idle' }, path: null, userData: 0,
      // where this unit stands guard, and how far it looks for a fight
      homeX: x, homeY: y, returning: false, strayedAt: 0, lastAttackedAt: 0,
      acquisitionRange: t ? t.acquisitionRange || 500 : 500,
      // how far into the spell animation a cast takes effect, and how long the
      // animation runs on after it (UnitWeapons.slk castpt / castbsw)
      castPoint: t ? t.castPoint || 0 : 0, castBackswing: t ? t.castBackswing || 0 : 0,
      turnRate: t?.turnRate ?? 0.6,
      movementType: t?.movementType || '', targetAs: t?.targetAs || '',
      classifications: t?.classifications || '',
      flyHeight: t?.flyHeight || 0, expireAt: 0, bounty: t ? t.bountyPlus : 0,
      kills: 0, deaths: 0, sellUnits: t ? t.sellUnits || [] : [],
      sellItems: t ? t.sellItems || [] : [],
      // hero-shaped units owned by neutral-passive are the map's in-world hero
      // picker; the web lobby replaces it, so they are not sent to clients
      pickerProp: !!(t && t.isHero) && pidx === NEUTRAL_PASSIVE,
    });
    if (u.pickerProp) { u.paused = true; u.invulnerable = true; }
    for (const a of (t ? t.abilities : [])) u.abilities.set(id2int(a), 1);
    if (t && t.isHero) {
      this.recalc(u);
      u.hp = u.maxHp; u.mana = u.maxMana;
    } else {
      // a non-hero's abilities are set above, so this is where a carried burn
      // is first seen -- the fire-wall units are created and never touched again
      this.recalc(u);
    }
    this.units.set(u.id, u);
    this.emit({ t: 'spawn', id: u.id });
    return u;
  }

  /**
   * A walkable spot near (x,y) that is not already occupied. Warcraft III spreads
   * units created at the same point instead of stacking them.
   */
  freeSpotNear(x, y, radius, movementType = '') {
    const grid = movementType === 'fly' ? this.flyGrid : this.grid;
    const clear = (px, py) => {
      if (!grid.clearFootprint(px, py, px, py, radius)) return false;
      for (const o of this.units.values()) {
        if (!o.alive || o.isBuilding || o.hidden || (o.movementType === 'fly') !== (movementType === 'fly')) continue;
        const need = radius + o.radius;
        if ((o.x - px) ** 2 + (o.y - py) ** 2 < need * need) return false;
      }
      return true;
    };
    const c0 = grid.nearestWalkable(x, y, 24, (px, py) => grid.clearFootprint(px, py, px, py, radius));
    const [bx, by] = c0 ? grid.toWorld(c0[0], c0[1]) : [x, y];
    if (clear(bx, by)) return [bx, by];
    const step = Math.max(24, radius * 1.8);
    for (let ring = 1; ring <= 8; ring++) {
      const n = ring * 6;
      const start = Math.random() * Math.PI * 2;
      for (let k = 0; k < n; k++) {
        const a = start + (k / n) * Math.PI * 2;
        const px = bx + Math.cos(a) * step * ring;
        const py = by + Math.sin(a) * step * ring;
        if (clear(px, py)) return [px, py];
      }
    }
    return [bx, by];
  }

  removeUnit(u) { if (!u) return; u.alive = false; u.removed = true; this.units.delete(u.id); }

  /** One of a unit's sound-set clips, as the engine would pick it. */
  unitSound(u, event) {
    const set = SOUNDSETS[u && u.typeKey] || SOUNDSETS[u && u.origin];
    const s = set && set[event];
    if (!s || !s.files.length) return null;
    return { path: s.files[Math.floor(Math.random() * s.files.length)],
             vol: s.vol ?? 1, pitch: s.pitch ?? 1 };
  }

  /**
   * The Reincarnation the unit holds, if it is off cooldown.
   *
   * Warcraft III's Reincarnation is not cast: it fires by itself when the unit
   * dies, stands the body back up where it fell, and goes on cooldown. Nothing
   * here implemented it, so Orochimaru's A01K -- his level-10 skill, one level,
   * no hotkey -- simply did nothing and he died like anyone else. The map's own
   * trigger for it plays a sound on SPELL_EFFECT and nothing more; the revive
   * itself has always been the engine's job.
   *
   * AOre, ACrn and ANrn are the family: AbilityMetaData gives the Ore1 field
   * (WorldEditStrings: "Reincarnation Delay") to exactly those three.
   */
  reincarnation(u) {
    if (!u || !u.abilities) return null;
    for (const [key, lvl] of u.abilities) {
      if (!(lvl >= 1)) continue;
      const a = abilEntry(this.abilKey(key));
      if (!a || !REINCARNATE.has(a.base)) continue;
      if ((u.cooldowns && u.cooldowns.get(key) || 0) > this.now) continue;
      return { key, lvl, a };
    }
    return null;
  }

  /**
   * Start a death the unit is going to get up from.
   *
   * The delay is the ability's own DataA -- 3 seconds for A01K against
   * Blizzard's 7 -- and the cooldown starts now, not when the body rises, so
   * dying twice inside two minutes is still fatal the second time. The spell
   * events fire here because this is when the ability is used; that is what
   * reaches the map's trigger and plays its line.
   */
  startReincarnation(u, re) {
    const L = levelInfo(re.a, re.lvl);
    u.cooldowns = u.cooldowns || new Map();
    u.cooldowns.set(re.key, this.now + (L.cooldown || 0) * 1000);
    u.reincarnateAt = this.now + Math.max(0, L.data1 || 0) * 1000;
    u.corpseUntil = 0;                     // it is not a corpse, it is waiting
    this.emitAbilityArt(re.a, u, null, u.x, u.y);
    if (!this.jass) return;
    const ctx = { unit: u, spellId: re.key, targetUnit: null,
                  targetX: u.x, targetY: u.y, player: this.playerOf(u) };
    for (const name of ['EVENT_PLAYER_UNIT_SPELL_CHANNEL', 'EVENT_PLAYER_UNIT_SPELL_CAST',
                        'EVENT_PLAYER_UNIT_SPELL_EFFECT', 'EVENT_PLAYER_UNIT_SPELL_FINISH',
                        'EVENT_PLAYER_UNIT_SPELL_ENDCAST']) {
      const k = this.jass.eventId(name);
      if (k != null) this.jass.fire(k, ctx);
    }
  }

  killUnit(u, killer) {
    if (u) this.cancelAttack(u);
    if (!u || !u.alive) return;
    this.interruptCast(u);                      // a dying caster stops casting
    u.alive = false; u.hp = 0; u.path = null; u.order = { type: 'idle' };
    u.orderQueue = []; this.pendingMovementPaths?.delete(u);
    // Warcraft III carries timed life as the BTLF buff, so death disposes of it
    // with every other buff and it cannot outlive the unit. We keep it as a bare
    // timestamp instead, which `u.buffs = []` does not touch -- so a revived hero
    // still carried a long-past expiry and the sweep killed him again on the very
    // tick he came back, forever. Ichigo's Hollow form is the one that shows it:
    // it ends in UnitApplyTimedLife, so he died, revived, and died again on a
    // four-second cycle and never stayed up.
    u.expireAt = 0;
    // Bounty and experience are paid for the death, not for the blow: Warcraft
    // III pays them however the unit died, and this map kills plenty of things
    // from its own triggers. Awarding only on the damage path left every
    // script-driven kill worth nothing.
    this.awardKill(u, killer);
    const ds = this.unitSound(u, 'death');
    if (ds) this.emit({ t: 'sound', path: ds.path, x: u.x, y: u.y, vol: ds.vol, pitch: ds.pitch });
    const kp = this.playerOf(killer);
    if (kp && killer !== u && this.hostile(killer, u)) {
      this.addScore(kp, 1);                       // PLAYER_SCORE_UNITS_KILLED
      if (u.isHero) this.addScore(kp, 7);         // PLAYER_SCORE_HEROES_KILLED
    }
    // Warcraft III leaves a corpse. It plays the unit's death animation for the
    // unit's own death time, decays the flesh, and the bones linger after that;
    // only then is it gone. Nothing here ever removed a dead unit, so corpses
    // accumulated in the world forever -- and the client hid them the instant
    // they died, so a spider simply vanished mid-animation. Heroes are exempt:
    // they revive, so their body is not a corpse.
    if (!u.isHero) {
      const g = GP || {};
      const decay = u.isBuilding ? (g.structureDecayTime ?? 30)
                                 : (g.decayTime ?? 2) + (g.boneDecayTime ?? 88);
      u.corpseUntil = this.now + ((u.deathTime ?? 3) + decay) * 1000;
    }
    this.emit({ t: 'death', id: u.id, killer: killer && killer.id });
    const dctx = { unit: u, killer, player: this.playerOf(u) };
    this.fireUnitEvent('EVENT_PLAYER_UNIT_DEATH', dctx);
    this.fireUnitEvent('EVENT_UNIT_DEATH', dctx);       // per-unit death registrations
    // After the death events, not instead of them: Warcraft III pays the kill
    // and tells the map somebody died either way. The body just does not stay
    // down.
    const re = this.reincarnation(u);
    if (re) this.startReincarnation(u, re);
  }

  /**
   * ReviveHero on a hero who is not dead does nothing in Warcraft III, and this
   * had no such guard: the map revives its heroes at their altar on a timer, so
   * a hero who had already got back up on his own was dragged there and given
   * full health a second time.
   */
  reviveUnit(u, x, y) {
    if (!u || u.alive) return false;
    u.reincarnateAt = 0;
    const c = this.grid.nearestWalkable(x, y);
    if (c) [u.x, u.y] = this.grid.toWorld(c[0], c[1]);
    u.alive = true; this.recalc(u); u.hp = u.maxHp; u.mana = u.maxMana;
    u.buffs = []; u.path = null; u.order = { type: 'idle' };
    this.emit({ t: 'revive', id: u.id });
    return true;
  }

  moveUnit(u, x, y) {
    if (!u) return;
    u.x = x; u.y = y; u.path = null;
  }

  unitState(u, st) {
    if (!u) return 0;
    switch (st) {
      case US_LIFE: return u.alive ? u.hp : 0;
      case US_MAX_LIFE: return u.maxHp;
      case US_MANA: return u.mana;
      case US_MAX_MANA: return u.maxMana;
    }
    return 0;
  }
  setUnitState(u, st, v) {
    if (!u) return;
    switch (st) {
      case US_LIFE:
        if (v <= 0) { this.killUnit(u, null); return; }
        u.hp = Math.min(u.maxHp, v); return;
      case US_MAX_LIFE: u.maxHp = Math.max(1, v); return;
      case US_MANA: u.mana = Math.max(0, Math.min(u.maxMana, v)); return;
      case US_MAX_MANA: u.maxMana = Math.max(0, v); return;
    }
  }

  recalc(u) {
    if (!u) return;
    this.removeAuraStats(u);
    // A non-hero gets one thing out of this and only one: the burn it carries.
    //
    // Everything below derives life, mana, armour and damage from a HERO's
    // attributes and items, which a creep has none of -- running it for every
    // unit would rewrite the whole roster's stats. But Cloak of Flames is not
    // a hero ability: Warcraft III burns anything that holds it, and this map
    // relies on that. Ace's 불의장벽 is twelve fire emitters whose entire
    // payload is a carried AIcf, and it was dealing nothing because the only
    // path to a carried burn was through this hero-gated function.
    // Deliberately NOT widened past AIcf: Byakuya's petals carry Apig, whose
    // damage interval names no field of its own, and tools/unread_accepted.json
    // records leaving that unread rather than inventing one. That stays unread.
    if (!u.isHero) {
      const burn = carriedImmolation(this, u);
      if (burn) { u.immolation = burn; u.immolationFromAbility = true; }
      else if (u.immolationFromAbility) { u.immolation = u.activeImmolation || null; u.immolationFromAbility = false; }
      this.applyAuraStats(u);
      return;
    }
    const lv = Math.max(0, u.level - 1);
    const t = this.type(u.typeId) || {};
    u.strTotal = u.str + u.strLvl * lv;
    u.agiTotal = u.agi + u.agiLvl * lv;
    u.intTotal = u.intel + u.intLvl * lv;
    const HP_PER_STR = GP ? GP.strHitPointBonus : 19;
    const MANA_PER_INT = GP ? GP.intManaBonus : 15;
    const DEF_PER_AGI = GP ? GP.agiDefenseBonus : 0.14;
    const ATK_PER_STR = GP ? GP.strAttackBonus : 1;
    u.maxHp = Math.max(1, Math.round((t.hp || 100) + u.strTotal * HP_PER_STR
                                     + ((u.morphed && u.morphed.hpBonus) || 0)));
    u.maxMana = Math.round((t.mana || 0) + u.intTotal * MANA_PER_INT);
    const ib = itemBonuses(u.items);
    const sb = abilityBonuses(this, u);          // passive skills like Attribute Bonus
    u.strTotal += ib.str + sb.str;
    u.agiTotal += ib.agi + sb.agi;
    u.intTotal += ib.intel + sb.intel;
    u.maxHp += Math.round(ib.maxHp + (ib.str + sb.str) * HP_PER_STR);
    u.maxMana += Math.round(ib.maxMana + (ib.intel + sb.intel) * MANA_PER_INT);
    u.armorTotal = (t.armor || 0) + u.agiTotal * DEF_PER_AGI + ib.armor;
    // Warcraft III derives life from strength, mana from intelligence and armour
    // from agility for every hero, but attack damage from the hero's *primary*
    // attribute alone.  Using strength for all of them hands an agility hero its
    // strength gain as damage -- on this map, whose base template grants +15
    // strength a level, that roughly doubled some heroes' damage.
    const prim = String(t.primary || 'STR').toUpperCase();
    const primTotal = prim === 'AGI' ? u.agiTotal : prim === 'INT' ? u.intTotal : u.strTotal;
    u.primaryAttr = prim;
    u.dmg = (t.dmgBase || 0) + primTotal * ATK_PER_STR + ib.damage;
    u.lifesteal = ib.lifesteal; u.cleave = ib.cleave;
    // A burn can come from a carried item or from an ability the unit holds;
    // only one this code granted is ever taken away again, so a cast Immolation
    // survives a recalc and a morph form's burn ends with the form.
    const carried = carriedImmolation(this, u);
    if (carried) { u.immolation = carried; u.immolationFromAbility = true; }
    else if (u.immolationFromAbility) { u.immolation = u.activeImmolation || null; u.immolationFromAbility = false; }
    // attack speed: agility plus any item bonus, as Warcraft III stacks them
    const AS_PER_AGI = GP ? GP.agiAttackSpeedBonus : 0.02;
    u.attackSpeedMul = 1 + u.agiTotal * AS_PER_AGI + ib.attackSpeed;
    u.hpReg = (t.hpReg ?? 0) + u.strTotal * (GP?.strRegenBonus ?? 0.05) + ib.hpReg;
    u.manaReg = ((t.manaReg ?? 0) + u.intTotal * (GP?.intRegenBonus ?? 0.05))
      * (1 + ib.manaReg);
    // boots and the like add a flat move-speed bonus
    u.moveSpeed = u.baseMoveSpeed + (ib.moveSpeed || 0);
    u.xpMul = 1 + (ib.xpMul || 0) / 100;      // ExperienceMod items, as a percent
    for (const b of (u.buffs || [])) {
      if (b.until && b.until <= this.now) continue;
      // armour and life regeneration ride whichever buff carries them: an
      // armour buff is the obvious one, and Battle Roar's Roa2/Roa3 put both on
      // a rage buff.
      u.armorTotal += b.armor || 0;
      u.hpReg += b.regen || 0;
      if (b.kind === 'slow') u.moveSpeed *= 1 - b.pct;
      if (b.kind === 'slow' && b.atkPct) u.attackSpeedMul *= 1 - b.atkPct;
      if (b.kind === 'defend' && b.atkPct) u.attackSpeedMul *= 1 - b.atkPct;
      if (b.kind === 'rage' || b.kind === 'morph' || b.kind === 'innerfire') { u.dmg *= 1 + b.pct; }
      if (b.kind === 'weaken') u.dmg *= 1 - b.pct;
    }
    this.applyAuraStats(u);
    u.hp = Math.min(u.hp, u.maxHp);
    u.mana = Math.min(u.mana, u.maxMana);
  }

  removeAuraStats(u) {
    for (const [stat, amount] of Object.entries(u.auraApplied || {})) u[stat] -= amount;
    u.auraApplied = null;
  }

  applyAuraStats(u) {
    const applied = {};
    for (const [stat, amount] of Object.entries(u.auraStats || {})) {
      const field = stat === 'movePct' ? 'moveSpeed' : stat;
      const base = u[field] ?? (field === 'armorTotal' ? u.armor || 0 : field === 'attackSpeedMul' ? 1 : 0);
      const delta = stat === 'movePct' ? base * amount : amount;
      u[field] = base + delta;
      applied[field] = delta;
    }
    u.auraApplied = applied;
  }

  stepAuras() {
    const sources = auraSources(this);
    for (const u of this.units.values()) {
      this.removeAuraStats(u);
      u.auraStats = auraEffects(this, u, sources);
      this.applyAuraStats(u);
    }
  }

  get maxHeroLevel() { return MAX_HERO_LEVEL; }

  /** What it costs to advance out of level `lv`. */
  xpForLevel(lv) {
    if (!XP_NEED || !XP_NEED.length) return 100 + lv * 120;
    return XP_NEED[Math.min(XP_NEED.length - 1, Math.max(0, trunc(lv) - 1))];
  }
  /**
   * Warcraft III pays experience to every enemy hero within HeroExpRange of the
   * dying unit -- not just to whoever landed the blow -- from the GrantHeroXP /
   * GrantNormalXP tables indexed by the victim's level.  Gold bounty is the
   * killer's alone.
   *
   * HeroFactorXP scales the award; the data file ships the list without a
   * comment, and it is applied here as the per-head factor when several heroes
   * share one kill, which is what its length (one entry per sharer) implies.
   */
  awardKill(victim, killer) {
    if (killer) {
      const p = this.playerOf(killer);
      if (p) {
        const gold = Math.round(victim.bounty || 10 + victim.level * 4);
        p.gold += gold;
        // Warcraft III floats the gold it just paid over the body, and shows it
        // to the killing player alone. It does that only where the victim's
        // owner gives bounty: neutral aggressive by default, which is every
        // creep on this map, plus Player(0..7) because the map's init turns it
        // on for them -- which is what makes a hero kill print its 500 too.
        //
        // The tag itself is not ours to design. UI/MiscData.txt carries the
        // engine's own settings for it -- BountyText Color, Velocity, Lifetime
        // and FadeStart -- in the units the text tag natives already take, so
        // they are passed through as the tag's own.
        const owner = this.playerOf(victim);
        if (owner && owner.givesBounty && gold > 0) {
          this.emit({ t: 'bounty', player: p.index, gold, x: victim.x, y: victim.y,
                      tag: BOUNTY_TEXT });
        }
      }
    }
    if (!XP_GRANT_HERO || !XP_GRANT_NORMAL) return;
    if (victim.isBuilding && !BUILDING_KILLS_XP) return;
    const tbl = victim.isHero ? XP_GRANT_HERO : XP_GRANT_NORMAL;
    const lv = Math.max(1, trunc(victim.level) || 1);
    let base = tbl[Math.min(tbl.length - 1, lv - 1)];
    if (victim.summoned) base *= SUMMONED_KILL_FACTOR;
    const sharers = this.enumInRange(victim.x, victim.y, HERO_EXP_RANGE).filter(
      (h) => h.isHero && h.alive && !h.pickerProp && h !== victim &&
             !this.isAlly(this.playerOf(h), this.playerOf(victim)));
    if (!sharers.length) return;
    const f = HERO_FACTOR_XP[Math.min(HERO_FACTOR_XP.length - 1, sharers.length - 1)] / 100;
    for (const h of sharers) this.addXp(h, base * f);
  }

  addXp(u, amt) {
    if (!u || !u.isHero) return;
    // ExperienceMod items (tomes of retraining and the like) scale what is
    // gained, and so does the player's own experience handicap
    const ph = this.playerOf(u);
    const hx = this.handicapXP && ph ? this.handicapXP.get(ph.index) : undefined;
    u.xp += amt * (u.xpMul || 1) * (hx === undefined ? 1 : hx);
    this.checkLevel(u);
  }
  checkLevel(u) {
    while (u.level < MAX_HERO_LEVEL && u.xp >= this.xpForLevel(u.level)) {
      u.xp -= this.xpForLevel(u.level);
      this.setHeroLevel(u, u.level + 1);
    }
  }
  setHeroLevel(u, lv) {
    if (!u) return;
    u.level = Math.max(1, trunc(lv));
    u.skillPoints = (u.skillPoints || 0) + 1;
    this.recalc(u);
    u.hp = u.maxHp; u.mana = u.maxMana;
    this.emit({ t: 'levelup', id: u.id, lvl: u.level });
    this.fireUnitEvent('EVENT_PLAYER_HERO_LEVEL', { unit: u, player: this.playerOf(u) });
  }

  /**
   * Take levels back off a hero.
   *
   * Blizzard.j's SetHeroLevelBJ calls this when the level it is asked for is
   * LOWER than the one the hero has, and the native returned true and did
   * nothing -- so a scripted level down did not happen. It is not setHeroLevel
   * in reverse: going up grants a skill point and refills life and mana, and
   * none of that is given back here beyond the skill points themselves, because
   * Warcraft III strips the level without healing anyone.
   */
  stripHeroLevel(u, n) {
    if (!u || !u.isHero) return false;
    const want = Math.max(1, (u.level || 1) - Math.max(0, trunc(n)));
    if (want === u.level) return false;
    const lost = u.level - want;
    u.level = want;
    u.xp = 0;
    u.skillPoints = Math.max(0, (u.skillPoints || 0) - lost);
    this.recalc(u);
    this.applyAuraStats(u);
    u.hp = Math.min(u.hp, u.maxHp);
    u.mana = Math.min(u.mana, u.maxMana);
    this.emit({ t: 'levelup', id: u.id, lvl: u.level });
    return true;
  }

  /** A player's experience handicap, as SetPlayerHandicapXP sets it. */
  setHandicapXP(playerHandle, f) {
    this.handicapXP = this.handicapXP || new Map();
    const idx = playerHandle && (playerHandle.index ?? playerHandle);
    if (idx == null) return;
    this.handicapXP.set(idx, Math.max(0, +f || 0));
  }

  addAbility(u, abilId) {
    if (!u) return false;
    const k = typeof abilId === 'number' ? abilId : id2int(abilId);
    if (!u.abilities.has(k)) { u.abilities.set(k, 1); this.recalc(u); }
    return true;
  }
  removeAbility(u, abilId) {
    if (!u) return false;
    u.abilities.delete(typeof abilId === 'number' ? abilId : id2int(abilId));
    this.holdReleasedBy(u, typeof abilId === 'number' ? int2id(abilId) : abilId);
    this.recalc(u);
    return true;
  }
  abilityLevel(u, abilId) {
    if (!u) return 0;
    const k = typeof abilId === 'number' ? abilId : id2int(abilId);
    const lv = u.abilities.get(k) || 0;
    if (lv) return lv;
    // Warcraft III stores a buff on the unit as an ability, which is why
    // Blizzard.j writes UnitHasBuffBJ as GetUnitAbilityLevel(unit, buffId) > 0.
    // Ours live in their own list, so a named buff has to answer here too or the
    // map can never see one -- and this map asks constantly, from Ichigo's
    // AGI x3 attack bonus to the guard that stops his Hollow form re-triggering.
    const code = typeof abilId === 'number' ? int2id(abilId) : abilId;
    // A w3a `abuf` field can name several buffs at once -- Gilgamesh's A027
    // carries "B00I,BHbz" -- so a stored code is matched as a list, not a
    // string, or the map's UnitHasBuffBJ misses every multi-buff ability.
    const carries = (b) => b.code === code
      || (typeof b.code === 'string' && b.code.includes(',') && b.code.split(',').includes(code));
    return (u.buffs || []).some((b) => carries(b) && (!b.until || b.until > this.now)) ? 1 : 0;
  }
  setAbilityLevel(u, abilId, lv) {
    if (!u) return 0;
    const k = typeof abilId === 'number' ? abilId : id2int(abilId);
    const n = Math.max(0, trunc(lv));
    if (n === 0) u.abilities.delete(k); else u.abilities.set(k, n);
    // An ability can be a stat block -- Attribute Bonus and its kin grant
    // strength, agility and intelligence -- so the moment the list changes the
    // derived numbers are stale. They were only refreshed when something *else*
    // recalculated, so learning Attribute Bonus did nothing at all until the
    // next level-up, item or buff happened to run one.
    this.recalc(u);
    return n;
  }
  resetCooldowns(u) { if (u) u.cooldowns = new Map(); return true; }

  /**
   * Damage a destructable.
   *
   * None of what happens when a unit dies applies: there is no owner, no
   * experience, no corpse and nothing calls for help. The attack-type table has
   * no row for the Wood and Stone armour DestructableData names, so typeBonus
   * would return 1 for every one of them and is not consulted.
   */
  damageDest(src, d, amount) {
    const dmg = Math.max(0, amount);
    d.hp -= dmg;
    d.lastAttackedAt = this.now;
    this.emit({ t: 'destDmg', d: d.index, id: d.id, hp: Math.max(0, Math.round(d.hp)),
                max: Math.round(d.maxHp) });
    if (d.hp <= 0) this.killDest(d, src);
    return dmg;
  }

  /** Learning a skill is an event the map's triggers listen for. */
  learnSkill(u, abilId) {
    if (!u) return 0;
    const key = typeof abilId === 'number' ? abilId : id2int(abilId);
    const lvl = this.abilityLevel(u, key) + 1;
    this.setAbilityLevel(u, key, lvl);
    this.fireUnitEvent('EVENT_PLAYER_HERO_SKILL',
                       { unit: u, skillId: key, skillLevel: lvl, player: this.playerOf(u) });
    return lvl;
  }

  /** Query live abilities so native add/remove and morph grants take effect immediately. */
  magicImmune(u) {
    if (!u) return false;
    for (const [key, level] of u.abilities || [])
      if (level > 0 && MAGIC_IMMUNITY_BASES.has(abilEntry(this.abilKey(key))?.base)) return true;
    for (const item of u.items || []) for (const key of item.abilities || [])
      if (MAGIC_IMMUNITY_BASES.has(abilEntry(this.abilKey(key))?.base)) return true;
    return false;
  }

  /** common.j unittype ids. */
  isUnitType(u, t) {
    if (!u) return false;
    switch (t) {
      case 0: return !!u.isHero;          // UNIT_TYPE_HERO
      case 1: return !u.alive;            // UNIT_TYPE_DEAD
      case 2: return !!u.isBuilding;      // UNIT_TYPE_STRUCTURE
      case 3: return u.movementType === 'fly';   // FLYING
      case 4: return u.movementType !== 'fly';       // GROUND
      case 7: return (u.atkRange || 0) <= 200; // MELEE_ATTACKER
      case 8: return (u.atkRange || 0) > 200;  // RANGED_ATTACKER
      case 26: return this.magicImmune(u); // MAGIC_IMMUNE
      case 10: return !!u.summonedBy;     // SUMMONED
      case 11: return this.stunned(u);    // STUNNED
      default: return false;
    }
  }

  // ----------------------------------------------------------------- combat
  damage(src, tgt, amount, opts = {}) {
    if (!tgt || !tgt.alive || tgt.invulnerable) return 0;
    if (tgt.isDest) return this.damageDest(src, tgt, amount, opts);
    let dmg = amount;
    // A unit can carry a multiplier on what it takes -- a mirror image does, out
    // of the summoning ability's own Omi3 "Damage Taken (%)".
    if (tgt.damageTakenMul) dmg *= tgt.damageTakenMul;
    if (!opts.raw) {
      // Attack type controls the armor-class table; damage type independently
      // controls numeric armor. Native calls must not inherit the source weapon.
      const at = opts.attackType != null ? ATTACK_TYPES[opts.attackType?.v ?? opts.attackType]
        : opts.spell ? 'spells' : (src?.atkType ?? 'normal');
      const dt = opts.damageType?.v ?? opts.damageType ?? (opts.spell ? 14 : 4);
      if (this.magicImmune(tgt) && (dt === 14 || (dt === 4 && at === 'magic'))) return 0;
      dmg *= typeBonus(at, tgt.armorType);
      if (dt === 4) dmg *= armorFactor(tgt.armorTotal ?? tgt.armor ?? 0);
      // Human footman Defend (Adef): DataA is damage taken %, and a defending
      // footman also fights at the slowed attack rate recalc applies.
      const def = (tgt.buffs || []).find((b) => b.kind === 'defend' && b.until > this.now);
      if (def && dmg > 0) dmg *= 1 - (def.pct || 0);
    }
    // Mana Shield takes its share off mana instead of life, at the ability's
    // own Nms1 "Mana per Hit Point" rate, and drops when the mana runs out.
    // This map's three shields all carry a NEGATIVE rate, so absorbing pays
    // mana back instead of spending it -- see the ANms case in abilities.js.
    const shield = (tgt.buffs || []).find((b) => b.kind === 'manashield' && b.until > this.now);
    if (shield && dmg > 0) {
      const rate = shield.manaPerHp;
      let absorbed = dmg * shield.pct;
      if (rate > 0) {
        absorbed = Math.min(absorbed, (tgt.mana || 0) / rate);
        tgt.mana = Math.max(0, (tgt.mana || 0) - absorbed * rate);
        if (tgt.mana <= 0) shield.until = 0;
      } else if (rate < 0) {
        tgt.mana = Math.min(tgt.maxMana || 0, (tgt.mana || 0) - absorbed * rate);
      }
      dmg -= absorbed;
      this.emit({ t: 'absorb', id: tgt.id, amt: Math.round(absorbed) });
    }
    tgt.hp -= dmg;
    tgt.lastAttackedAt = this.now;
    if (src) this.callForHelp(tgt, src);
    this.emit({ t: 'dmg', id: tgt.id, src: src && src.id, amt: Math.round(dmg) });
    const dmgCtx = { unit: tgt, damageSource: src, damage: dmg, player: this.playerOf(tgt) };
    this.fireUnitEvent('EVENT_PLAYER_UNIT_DAMAGED', dmgCtx);
    this.fireUnitEvent('EVENT_UNIT_DAMAGED', dmgCtx);     // per-unit damage registrations
    if (tgt.hp <= 0) this.killUnit(tgt, src);
    return dmg;
  }

  // ----------------------------------------------------------------- orders
  order(u, o, queue = false, preserveQueue = false) {
    if (!u || !u.alive || u.paused) return false;
    if (o.target && ['attack', 'smart'].includes(o.type) && !this.weaponFor(u, o.target)) return false;
    if (o.type === 'follow' && (!o.target?.alive || o.target === u || o.target.hidden || this.isLocust(o.target))) return false;
    if (o.x != null && (!Number.isFinite(o.x) || !Number.isFinite(o.y))) return false;
    if (queue && (u.cast || u.order.type !== 'idle' || u.orderQueue?.length)) {
      u.orderQueue ||= [];
      if (u.orderQueue.length >= 35) return false;
      // Resolve targets again at execution; removed/dead targets are skipped.
      u.orderQueue.push({ type: o.type, x: o.x, y: o.y, targetId: o.target?.id });
      return true;
    }
    if (!preserveQueue) u.orderQueue = [];

    u.repathAt = 0;
    this.pendingMovementPaths?.delete(u);
    this.cancelAttack(u);
    // any order breaks off a cast in progress, as the game's does
    this.interruptCast(u);
    const numericOrder = typeof o.type === 'number' || /^-?\d+$/.test(String(o.type));
    // A numeric order casts only for a unit the MAP made to cast it.
    //
    // The script orders by raw id, and OrderId() here is a hash of ours that
    // can never match a literal the script passes, so the port cannot tell one
    // numeric order from another -- TODO.txt records that the table which
    // would settle it is not in the MPQs. castDummy is the standing answer:
    // run whatever ability the unit holds. That is right for a dummy and wrong
    // for a hero, and the map makes the distinction for us.
    //
    // Measured over all 188 numeric-order sites in war3map.formatted.j: every
    // one that is meant to cast orders a unit the trigger CREATED a line or
    // two above -- 151 sites, 150 of them Locust, the odd one out a 10-life
    // effect dummy. The only numeric orders aimed at anything else are six
    // aborts (851972, to GetTriggerUnit or GetAttacker, each in a path that
    // prints a refusal) and one attack order at a dummy. No hero is ever
    // ordered by id to cast.
    //
    // So a hero reaching castDummy was always the abort case, and it fired the
    // first ability in the hero's map instead. Byakuya has Blink granted at
    // creation, before any skill point is spent, so all three of his script
    // gates -- Bankai exclusivity, the recast lock, the blink-into-base block
    // -- teleported him 50 units east instead of refusing. The cast in
    // progress was already broken off by interruptCast above, which is why
    // this read as a stray hop rather than a broken spell.
    if (numericOrder && !u.isHero && this.castDummy(u, { target: o.target, x: o.x, y: o.y })) return true;
    const name = typeof o.type === 'string' ? o.type : String(o.type);
    if (/stop|halt/i.test(name)) { u.order = { type: 'idle' }; u.path = null; return true; }
    if (name === 'hold') { u.order = { type: 'hold' }; u.path = null; return true; }
    // RTS 训练 (Terenas 官方对战): 建筑训练单位
    if (/train/i.test(name)) {
      const tr = o.trainType || (typeof o.type === 'string' && /^[a-z]{4}$/.test(o.type) ? o.type : null);
      if (!tr || !TRAIN[tr]) return false;
      const ph = this.playerOf(u);
      if (!ph || (ph.gold || 0) < TRAIN[tr].cost) return false;
      u.training = { type: tr, until: this.now + TRAIN[tr].time };
      return true;
    }
    // RTS 建造: 农民走到放置点, 到点后进入建造过程 (stepBuilds)
    if (/build/i.test(name)) {
      const bt = o.buildType || (typeof o.type === 'string' && /^[a-z]{4}$/.test(o.type) ? o.type : null);
      const info = bt && TYPES[bt];
      if (!bt || !info || !info.isBuilding) { console.log('[build] 拒绝: 类型无效', bt); return false; }
      if (!/^(hpea|hmil)$/.test(u.typeKey)) { console.log('[build] 拒绝: 非农民', u.typeKey); return false; }
      const ph = this.playerOf(u);
      if (!ph) return false;
      if ((ph.gold || 0) < (info.gold || 0) || (ph.lumber || 0) < (info.lumber || 0)) {
        console.log('[build] 拒绝: 资源不足', ph.gold, ph.lumber, info.gold, info.lumber); return false;
      }
      const bx = o.x, by = o.y;
      if (bx == null || by == null || !this.canPlace(bx, by)) { console.log('[build] 拒绝: 位置不可放', bx, by); return false; }
      u.buildingTarget = { type: bt, x: bx, y: by };
      u.afterMove = { cmd: 'buildHere' };
      u.path = this.routeUnit(u, bx, by);
      u.order = { type: 'move', x: bx, y: by };
      console.log('[build] 农民', u.id, '->', bt, '@', bx, by);
      return true;
    }
    if (o.target) {
      u.order = { type: o.type === 'follow' ? 'follow' : 'attack', targetId: o.target.id };
      // a gate is 896 units across and its middle is inside its own footprint,
      // so walk at it rather than at a point nothing can stand on
      u.path = o.target.isDest && !preserveQueue ? this.routeUnit(u, o.target.x, o.target.y) : null;
      if (o.target.isDest) return true;         // no script event names one
      this.fireUnitEvent('EVENT_PLAYER_UNIT_ISSUED_TARGET_ORDER',
        { unit: u, orderTarget: o.target, orderId: o.type, player: this.playerOf(u) });
      return true;
    }
    if (o.x != null) {
      if (!Number.isFinite(o.x) || !Number.isFinite(o.y)) return false;
      const attack = /attack/i.test(name);
      u.path = preserveQueue ? null : this.routeUnit(u, o.x, o.y);
      u.order = name === 'patrol'
        ? { type: 'patrol', x: o.x, y: o.y, fromX: u.x, fromY: u.y }
        : { type: attack ? 'attackMove' : 'move', x: o.x, y: o.y };
      if (preserveQueue) this.requestMovementPath(u, o.x, o.y);
      return true;
    }
    return true;
  }

  /**
   * Build placement sanity: the spot must be on walkable ground and keep a
   * clear radius away from existing units, as a peasant's ghost does.
   * The map's trees/destructables already block walk.bin, so a spot inside
   * a forest or on a cliff fails for free.
   */
  canPlace(x, y) {
    const W = TERR.width, H = TERR.height;
    const i = Math.floor((x - TERR.offsetX) / TERR.tileSize);
    const j = Math.floor((y - TERR.offsetY) / TERR.tileSize);
    if (i < 0 || j < 0 || i >= W || j >= H) return false;
    if (!this.walk[j * (W - 1) + i]) return false;
    for (const uu of this.units.values()) {
      if (!uu.alive || uu.removed) continue;
      if (Math.hypot(uu.x - x, uu.y - y) < 90) return false;
    }
    return true;
  }

  /** Consume completed commands before idle AI can acquire a different enemy. */
  advanceOrders(u) {
    if (!u.orderQueue?.length || u.cast || u.paused || !u.alive) return;
    const type = u.order.type;
    const target = u.order.targetId != null ? this.target(u.order.targetId) : null;
    const done = type === 'idle' || (type === 'move' && !u.path?.length && !this.pendingMovementPaths?.has(u))
      || (['attack', 'follow'].includes(type) && (!target?.alive || target.hidden));
    if (!done) return;
    // A bounded queue also bounds the work needed to discard expired targets.
    while (u.orderQueue.length) {
      const next = u.orderQueue.shift();
      const target = next.targetId != null ? this.target(next.targetId) : null;
      if (next.targetId != null && (!target?.alive || target.hidden)) continue;
      if (this.order(u, { type: next.type, x: next.x, y: next.y, target }, false, true) && u.order.type !== 'idle') break;
    }
  }

  // ------------------------------------------------------------ enumeration
  allUnits() { return [...this.units.values()].filter((u) => u.alive && !u.hidden); }

  /**
   * Bin every live unit by position, once a tick.
   *
   * enumInRange used to walk the whole unit list, and every unit's AI runs one
   * of those every tick looking for something to attack. That is quadratic, and
   * measured on this map it is what falls over: 120 units cost 0.6 ms a tick,
   * 620 cost 29.6 against a 33 ms budget, and 1120 cost 111.7 -- three and a
   * half times over. 96% of what it scanned was out of range.
   *
   * Rebuilt whole rather than maintained as units move: it is one pass over the
   * units against the many queries it serves, and a stale bin is a class of bug
   * that only shows up under load.
   */
  rebuildBins() {
    if (this.binTick === this.tick) return;
    this.binTick = this.tick;
    const bins = this.bins || (this.bins = new Map());
    bins.clear();
    for (const u of this.units.values()) {
      if (!u.alive || u.hidden) continue;
      const k = binKey(u.x, u.y);
      const cell = bins.get(k);
      if (cell) cell.push(u); else bins.set(k, [u]);
    }
  }

  /** Put a unit in the current bin, so one created mid-tick is still findable. */
  binUnit(u) {
    if (!this.bins || this.binTick !== this.tick || !u.alive || u.hidden) return;
    const k = binKey(u.x, u.y);
    const cell = this.bins.get(k);
    if (cell) cell.push(u); else this.bins.set(k, [u]);
  }

  enumInRange(x, y, r) {
    this.rebuildBins();
    const out = [];
    const rr = r * r;
    // one cell of margin: a unit moves at most a fifth of a cell in a tick, so
    // this covers anything that shifted since the bins were built
    const x0 = Math.floor((x - r) / BIN) - 1, x1 = Math.floor((x + r) / BIN) + 1;
    const y0 = Math.floor((y - r) / BIN) - 1, y1 = Math.floor((y + r) / BIN) + 1;
    for (let cy = y0; cy <= y1; cy++) {
      for (let cx = x0; cx <= x1; cx++) {
        const cell = this.bins.get(binKey(cx * BIN, cy * BIN));
        if (!cell) continue;
        for (const u of cell) {
          if (!u.alive || u.hidden) continue;
          // squared distance: Math.hypot guards against overflow nobody here can
          // reach, and costs several times a multiply to do it
          const dx = u.x - x, dy = u.y - y;
          if (dx * dx + dy * dy <= rr) out.push(u);
        }
      }
    }
    return out;
  }
  enumInRect(r) {
    if (!r) return [];
    return this.allUnits().filter((u) => u.x >= r.minx && u.x <= r.maxx && u.y >= r.miny && u.y <= r.maxy);
  }
  unitsOfPlayer(p) {
    const i = p ? p.index : -1;
    return this.allUnits().filter((u) => u.playerIndex === i);
  }
  playerOf(u) { return this.jass && u ? this.jass.players[u.playerIndex] : null; }

  // ---------------------------------------------------------- RTS 经济 (Terenas 官方对战补丁)
  stepGathers() {
    for (const u of this.units.values()) {
      if (!u.alive || u.paused || u.hidden || u.typeKey !== 'hpea' || u.playerIndex > 1) continue;
      const g = u.gather;
      if (this.tick % 60 === 0 && (g === undefined || this.tick < 900)) console.log('[gather]', u.id, 'order', u.order.type, 'path', !!u.path, 'g', g ? g.phase + '/' + Math.round(g.until - this.now) : '-');
      if (g && g.mineId) {
        const mine = this.units.get(g.mineId);
        if (!mine || !mine.alive) { u.gather = null; continue; }
        if (g.phase === 'toMine') {
          if (Math.hypot(u.x - mine.x, u.y - mine.y) < 140) {
            g.phase = 'mining'; g.until = this.now + 1800;   // 挖矿 1.8s
            u.order = { type: 'idle' }; u.path = null;
          } else if (u.order.type !== 'move') {
            const sp = this.walkSpotNear(mine.x, mine.y, u);
            if (sp) this.order(u, { type: 'move', x: sp[0], y: sp[1] });
          }
        } else if (g.phase === 'mining') {
          if (this.now >= g.until) {
            const base = [...this.units.values()]
              .find((b) => b.alive && b.typeKey === 'htow' && b.playerIndex === u.playerIndex);
            if (!base) { u.gather = null; continue; }
            g.phase = 'toBase'; g.baseId = base.id;
            const bs = this.walkSpotNear(base.x, base.y, u);
            if (bs) this.order(u, { type: 'move', x: bs[0], y: bs[1] });
            else u.gather = null;
          }
        } else if (g.phase === 'toBase') {
          const base = this.units.get(g.baseId);
          const arrived = base && (Math.hypot(u.x - base.x, u.y - base.y) < 280 || (u.order.type === 'idle' && !u.path));
          if (arrived) {
            const p = this.playerOf(u);
            if (p) { p.gold = (p.gold || 0) + 10; console.log('[gather] 交金', u.id, 'gold=', Math.round(p.gold)); }
            u.gather = { mineId: mine.id, phase: 'toMine' };
          }
        }
      } else if (u.order.type === 'idle' && !u.path) {
        // 空闲农民自动找最近金矿 (WC3 默认行为)
        const mine = [...this.units.values()]
          .filter((m) => m.alive && m.typeKey === 'ngol')
          .sort((a, b) => Math.hypot(a.x - u.x, a.y - u.y) - Math.hypot(b.x - u.x, b.y - u.y))[0];
        if (mine) {
          u.gather = { mineId: mine.id, phase: 'toMine' };
          this.order(u, { type: 'move', x: mine.x, y: mine.y });
        }
      }
    }
  }

  // 找 (cx,cy) 附近第一个可走的点 (递增半径探测)
  walkSpotNear(cx, cy, u) {
    const grid = this.movementGrid(u);
    const offs = [[-80, -80], [80, -80], [-80, 80], [80, 80],
                  [0, -120], [0, 120], [-120, 0], [120, 0],
                  [-130, -130], [130, -130], [-130, 130], [130, 130],
                  [0, -160], [0, 160], [-160, 0], [160, 0]];
    for (const [dx, dy] of offs) {
      const x = cx + dx, y = cy + dy;
      if (grid.clearFootprint(x, y, x, y, u.radius)) return [x, y];
    }
    return null;   // 全不可走 (不该发生)
  }

  stepTraining() {
    for (const u of this.units.values()) {
      if (!u.alive || u.paused || u.playerIndex > 1) continue;
      const tr = u.training;
      if (!tr) continue;
      // 只有训练建筑能训自己的单位 (官方人族建筑表)
      const mine = BUILD_TRAIN[u.typeKey];
      if (!mine || !mine.includes(tr.type)) { u.training = null; continue; }
      if (this.now >= tr.until) {
        u.training = null;
        const ph = this.playerOf(u);
        if (ph) ph.gold = (ph.gold || 0) - TRAIN[tr.type].cost;
        const u2 = this.createUnit(ph, tr.type, u.x + (Math.random() - 0.5) * 90, u.y - 100, 180);
        if (this.jass) {
          const k = this.jass.eventId('EVENT_PLAYER_UNIT_TRAIN_FINISH');
          if (k != null) this.jass.fire(k, { unit: u, player: ph, trainedUnit: u2 });
        }
      }
    }
  }

  /**
   * Building: a peasant that reached its spot starts construction; the
   * building appears as a progress state for its buildTime, then completes.
   * Cost is charged on completion (WC3 charges as items are dropped into the
   * ghost, but the practical result is the same for the player's gold/lumber
   * totals — it only matters if the building is cancelled, which needs a
   * cancel order we can add later).
   */
  stepBuilds() {
    for (const u of this.units.values()) {
      if (!u.alive || u.paused) continue;
      // a peasant that finished walking to its spot starts pouring the ghost
      if (u.afterMove?.cmd === 'buildHere') {
        const bt = u.buildingTarget;
        if (!bt) { u.afterMove = null; continue; }
        const info = TYPES[bt.type];
        if (!info) { u.afterMove = null; continue; }
        const done = Math.hypot(u.x - bt.x, u.y - bt.y) < 110;
        if (done) {
          u.afterMove = null; u.buildingTarget = null;
          u.building = { type: bt.type, x: bt.x, y: bt.y, until: this.now + (info.buildTime || 30) * 1000 };
          this.emit({ t: 'buildStart', id: u.id, type: bt.type, x: bt.x, y: bt.y });
          this.recalc(u);
        }
      }
      // the builder finishing pays the bill and the building stands
      if (u.building && this.now >= u.building.until) {
        const b = u.building;
        const info = TYPES[b.type];
        u.building = null;
        const ph = this.playerOf(u);
        if (ph) {
          ph.gold = Math.max(0, (ph.gold || 0) - (info?.gold || 0));
          ph.lumber = Math.max(0, (ph.lumber || 0) - (info?.lumber || 0));
        }
        const bd = this.createUnit(ph, b.type, b.x, b.y, 180);
        if (bd && this.jass) {
          const k = this.jass.eventId('EVENT_PLAYER_UNIT_CONSTRUCT_FINISH');
          if (k != null) this.jass.fire(k, { unit: bd, player: ph, constructor: u });
        }
      }
    }
  }

  // ------------------------------------------------------------------ items
  createItem(idRaw, x, y) {
    const key = typeof idRaw === 'number' ? int2id(idRaw) : idRaw;
    const def = ITEMS[key] || {};
    const it = new Handle('item', { id: this.nextId++,
                                    typeId: typeof idRaw === 'number' ? idRaw : id2int(idRaw),
                                    typeKey: key, x, y, charges: def.charges || 0,
                                    name: def.name || '', abilities: def.abilities || [],
                                    powerup: !!def.powerup });
    this.items.set(it.id, it);
    return it;
  }
  removeItem(it) {
    if (!it) return;
    // an item held by a unit must also leave that unit's inventory
    const owner = it.owner;
    if (owner && owner.items) {
      owner.items = owner.items.filter((x) => x !== it);
      this.recalc(owner);
    }
    it.owner = null;
    this.items.delete(it.id);
  }
  /**
   * A powerup is spent the instant it is picked up.
   *
   * Warcraft III does not carry a tome: the bonus becomes part of the hero and
   * the item is gone.  Holding them instead lets seven of this map's shop items
   * fill a six-slot inventory, and makes a 19000-gold permanent stat purchase
   * something you could drop by accident.
   */
  consumePowerup(u, it) {
    const b = itemBonuses([it]);
    u.str += b.str || 0;
    u.agi += b.agi || 0;
    u.intel += b.intel || 0;
    const eff = itemUse(it);
    if (eff) {
      if (eff.kind === 'xp') this.addXp(u, eff.amount);
      else if (eff.kind === 'heal') this.heal(u, eff.amount);
      else if (eff.kind === 'mana') u.mana = Math.min(u.maxMana, u.mana + eff.amount);
    }
    this.fireUnitEvent('EVENT_PLAYER_UNIT_PICKUP_ITEM',
                       { unit: u, item: it, player: this.playerOf(u) });
    this.items.delete(it.id);
    this.recalc(u);
    return true;
  }

  giveItem(u, it) {
    if (!u || !it) return false;
    if (it.powerup) return this.consumePowerup(u, it);
    if (u.items.length >= 6) return false;
    u.items.push(it); it.owner = u;
    this.recalc(u);
    this.fireUnitEvent('EVENT_PLAYER_UNIT_PICKUP_ITEM',
                       { unit: u, item: it, player: this.playerOf(u) });
    return true;
  }
  dropItem(u, it) {
    if (!u || !it) return false;
    const had = u.items.includes(it);
    u.items = u.items.filter((x) => x !== it);
    it.owner = null;
    // it lands where the carrier stood -- but two items on the same spot are one
    // item as far as anyone clicking can tell, so nudge off anything already there
    [it.x, it.y] = this.freeItemSpot(u.x, u.y);
    this.recalc(u);
    // the map listens for this the same way it listens for a pickup
    if (had) this.fireUnitEvent('EVENT_PLAYER_UNIT_DROP_ITEM',
                                { unit: u, item: it, player: this.playerOf(u) });
    return true;
  }

  /**
   * Sell an item back to a shop.
   *
   * Warcraft III refunds the item's gold cost scaled by the `pawnItemRate`
   * gameplay constant -- 0.75 here -- and fires PAWN_ITEM, which was the one
   * event kind of seventeen this map registers that never fired.
   */
  pawnItem(u, it) {
    if (!u || !it || !u.items.includes(it)) return false;
    const def = ITEMS[it.typeKey] || {};
    const rate = GP && GP.pawnItemRate != null ? GP.pawnItemRate : 0.75;
    const refund = Math.floor((def.gold || 0) * rate);
    const p = this.playerOf(u);
    if (p) p.gold = (p.gold || 0) + refund;
    u.items = u.items.filter((x) => x !== it);
    this.recalc(u);
    // GetSoldItem is what a PAWN_ITEM trigger reads, and it answers from
    // ctx.soldItem: the shop-purchase path at sellItem carries both keys and
    // this one carried only `item`, so every pawn trigger saw a null item. The
    // Monster Ball's is the one that shows it -- selling a captured ball is
    // supposed to destroy what is inside it.
    this.fireUnitEvent('EVENT_PLAYER_UNIT_PAWN_ITEM',
                       { unit: u, item: it, soldItem: it, seller: u, player: p });
    this.removeItem(it);
    return refund;
  }

  /** A spot near (x, y) with no other item already lying on it. */
  freeItemSpot(x, y) {
    const taken = (px, py) => [...this.items.values()].some(
      (o) => !o.owner && !o.hidden && Math.hypot(o.x - px, o.y - py) < ITEM_REACH);
    if (!taken(x, y) && this.walkable(x, y)) return [x, y];
    for (let r = ITEM_REACH; r <= ITEM_REACH * 4; r += ITEM_REACH) {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
        if (!taken(px, py) && this.walkable(px, py)) return [px, py];
      }
    }
    return [x, y];
  }

  /**
   * Order a unit to fetch an item, the way a right-click does in Warcraft III.
   *
   * The unit walks to it and takes it on arrival; it is not teleported into the
   * inventory. MiscData's FollowItemRange bounds how far it will go.
   */
  orderPickup(u, it) {
    if (!u || !u.alive || !it || it.owner || it.hidden) return false;
    if (Math.hypot(it.x - u.x, it.y - u.y) > FOLLOW_ITEM_RANGE) return false;
    if (this.reachesItem(u, it)) return this.takeItem(u, it);
    u.path = this.routeUnit(u, it.x, it.y);
    u.order = { type: 'pickup', itemId: it.id, x: it.x, y: it.y };
    // Warcraft III issues this as a targeted order like any other
    this.fireUnitEvent('EVENT_PLAYER_UNIT_ISSUED_TARGET_ORDER',
      { unit: u, orderTargetItem: it, orderId: 'smart', player: this.playerOf(u) });
    return true;
  }

  reachesItem(u, it) {
    return Math.hypot(it.x - u.x, it.y - u.y) <= ITEM_REACH + (u.radius || 24);
  }

  /** Pick it up, and stop walking towards it either way. */
  takeItem(u, it) {
    if (!it || it.owner) return false;
    const got = this.giveItem(u, it);
    if (got) {
      u.path = null;
      if (u.order && u.order.type === 'pickup') u.order = { type: 'idle' };
    }
    return got;
  }

  /**
   * Items in the world, once per tick.
   *
   * Two things happen here, both Warcraft III's rules: a unit that was sent to
   * fetch an item takes it when it arrives, and a *powerup* is taken by anyone
   * who simply walks over it -- that is what makes a rune a rune. Ordinary
   * items sit there until someone is told to pick them up.
   */
  stepItems() {
    for (const u of this.units.values()) {
      if (!u.alive || !u.order || u.order.type !== 'pickup') continue;
      const it = this.items.get(u.order.itemId);
      if (!it || it.owner || it.hidden) { u.order = { type: 'idle' }; u.path = null; continue; }
      if (this.reachesItem(u, it)) this.takeItem(u, it);
      else if (!u.path) u.order = { type: 'idle' };      // could not get there
    }
    for (const it of [...this.items.values()]) {
      if (it.owner || it.hidden || !it.powerup) continue;
      for (const u of this.units.values()) {
        if (!u.alive || u.hidden || !u.isHero) continue;
        if (!this.reachesItem(u, it)) continue;
        this.giveItem(u, it);                            // consumes it
        break;
      }
    }
  }

  /**
   * The ability an item casts at something, if it has one.
   *
   * Exactly one item on this map does: I006, the Monster Ball, whose A03V
   * targets nonhero/enemies/ground. Everything else with an ability either
   * carries a passive bonus or acts on its holder, so this is one item's worth
   * of behaviour and not a general item-spell system.
   */
  itemSpell(it) {
    for (const id of (it && it.abilities) || []) {
      const a = abilEntry(id);
      if (!a || !a.order) continue;
      const t = (a.targets || '').toLowerCase();
      if (t && t !== 'none' && t !== 'self' && !t.startsWith('none')) return id;
    }
    return null;
  }

  /**
   * Use a carried item: its own ability data says what that does.
   *
   * An item whose ability names a target is *cast*, not merely used: Warcraft
   * III fires that ability's spell events with GetSpellAbilityId set to it, and
   * the Monster Ball's whole capture trigger hangs off exactly that. Using it
   * still fires USE_ITEM as well, as the game does -- the map listens for both,
   * on different balls.
   */
  useItem(u, it, target = null) {
    if (!u || !it) return false;
    // A spent item must not still work.
    //
    // `uses` is the map's own count -- a Potion of Greater Healing says 1 --
    // and charges are seeded from it. The effect was applied before the charge
    // was spent, and an item already at zero was never refused, so a potion
    // healed 1000 every time it was used no matter how often. Worse, the first
    // use DROPS it (below) rather than destroying it, so the spent potion lay
    // on the ground to be picked up and used again. Applying a one-use item
    // twice contradicts the number the map wrote, which is what settles this.
    // An item whose TYPE declares no uses is not a consumable and is not
    // limited here -- charges 0 means "no limit", not "spent", so the type is
    // what decides.
    const def = ITEMS[it.typeKey] || {};
    if (def.charges > 0 && !(it.charges > 0)) return false;
    const eff = itemUse(it);
    if (eff) {
      if (eff.kind === 'heal') this.heal(u, eff.amount);
      else if (eff.kind === 'mana') u.mana = Math.min(u.maxMana, u.mana + eff.amount);
      else if (eff.kind === 'xp') this.addXp(u, eff.amount);
    }
    const spell = this.itemSpell(it);
    if (spell && this.jass) {
      const abil = abilEntry(spell);
      const tx = target ? target.x : u.x, ty = target ? target.y : u.y;
      this.emit({ t: 'cast', id: u.id, ab: spell, anim: abil?.art?.anim || null });
      this.emitAbilityArt(abil, u, target, tx, ty);
      const ctx = { unit: u, spellId: id2int(spell), targetUnit: target || null,
                    targetX: tx, targetY: ty, player: this.playerOf(u) };
      for (const name of ['EVENT_PLAYER_UNIT_SPELL_CHANNEL', 'EVENT_PLAYER_UNIT_SPELL_CAST',
                          'EVENT_PLAYER_UNIT_SPELL_EFFECT', 'EVENT_PLAYER_UNIT_SPELL_FINISH',
                          'EVENT_PLAYER_UNIT_SPELL_ENDCAST']) {
        const k = this.jass.eventId(name);
        if (k != null) this.jass.fire(k, ctx);
      }
    }
    this.fireUnitEvent('EVENT_PLAYER_UNIT_USE_ITEM',
                       { unit: u, item: it, player: this.playerOf(u) });
    if (it.charges > 0 && --it.charges <= 0) this.dropItem(u, it);
    return true;
  }
  dropItemSlot(u, s) {
    if (!u || !u.items[s]) return false;
    return this.dropItem(u, u.items[s]);
  }

  // ---------------------------------------------------------------- players
  isAlly(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const key = `${a.index}:${b.index}`;
    if (this.alliances.has(key)) return this.alliances.get(key);
    return a.team === b.team;
  }
  setAlliance(a, b, on) {
    if (!a || !b) return;
    this.alliances.set(`${a.index}:${b.index}`, !!on);
  }
  /** WC3 player score categories (see the supplement's PLAYER_SCORE_* ids). */
  score(p, k) { return p && p.score ? (p.score[k] || 0) : 0; }
  addScore(p, k, n = 1) { if (p) { p.score = p.score || {}; p.score[k] = (p.score[k] || 0) + n; } }

  playerState(p, st) {
    if (!p) return 0;
    if (st === PS_GOLD) return Math.round(p.gold);
    if (st === PS_LUMBER) return Math.round(p.lumber);
    if (st === PS_GIVES_BOUNTY) return p.givesBounty ? 1 : 0;
    return 0;
  }
  setPlayerState(p, st, v) {
    if (!p) return;
    if (st === PS_GOLD) p.gold = v;
    else if (st === PS_LUMBER) p.lumber = v;
    // The map turns this on for players 0-7 in its init, which is what makes
    // killing one of their units pay -- and print -- a bounty.
    else if (st === PS_GIVES_BOUNTY) p.givesBounty = !!v;
  }

  // ----------------------------------------------------- ability engine glue
  abilKey(k) { return typeof k === 'number' ? int2id(k) : k; }
  /**
   * Warcraft III's neutral-passive slot (15) never fights and is never fought;
   * neutral-aggressive (12) is hostile to every player. Picker props are inert.
   */
  hostile(a, b) {
    if (!a || !b || a === b) return false;
    if (a.pickerProp || b.pickerProp) return false;
    if (a.playerIndex === NEUTRAL_PASSIVE || b.playerIndex === NEUTRAL_PASSIVE) return false;
    if (a.playerIndex === NEUTRAL_HOSTILE || b.playerIndex === NEUTRAL_HOSTILE)
      return a.playerIndex !== b.playerIndex;
    return !this.isAlly(this.playerOf(a), this.playerOf(b));
  }
  enemiesInRange(caster, x, y, r) {
    return this.enumInRange(x, y, r).filter((e) => this.hostile(caster, e) && !e.isBuilding);
  }
  alliesInRange(caster, x, y, r) {
    return this.enumInRange(x, y, r).filter((e) => !this.hostile(caster, e));
  }
  heal(u, amt) {
    if (!u || !u.alive) return;
    u.hp = Math.min(u.maxHp, u.hp + amt);
    this.emit({ t: 'heal', id: u.id, amt: Math.round(amt) });
  }
  applyBuff(u, b) {
    if (!u || !u.alive) return;
    // A buff the map named is replaced by its own code rather than by its kind:
    // two abilities can both grant armour and still be distinct buffs the script
    // tests for separately, which is exactly how Ichigo's Hollow (B001) and
    // Vizard (B000) forms are told apart.
    u.buffs = (u.buffs || []).filter((x) => (b.code ? x.code !== b.code : x.kind !== b.kind));
    u.buffs.push(b);
    this.recalc(u);
  }

  /** Dispel: strip every buff a unit carries (Human priest Adis / others). */
  clearBuffs(u) {
    if (!u) return;
    u.buffs = [];
    this.recalc(u);
  }
  stunned(u) { return (u.buffs || []).some((b) => b.kind === 'stun' && b.until > this.now); }
  silenced(u) { return (u.buffs || []).some((b) => b.kind === 'silence' && b.until > this.now); }
  /**
   * Metamorphosis: the hero becomes another unit type for a while.
   *
   * Warcraft III implements this by swapping the unit for the alternate form the
   * ability names in its `unit` field, then swapping it back when the buff runs
   * out -- it is a genuine change of unit type, which is why Metamorphosis
   * carries no effect art of its own: the new body *is* the effect.
   *
   * The hero keeps its identity across the change: same level, experience,
   * skills and inventory. Life and mana carry as fractions rather than values,
   * so entering a form with a larger pool does not heal you for the privilege,
   * and leaving one does not kill you.
   */
  morph(u, typeKey, seconds, hpBonus = 0) {
    const t = this.type(typeKey);
    if (!u || !t) return false;
    const hpFrac = u.maxHp > 0 ? u.hp / u.maxHp : 1;
    const manaFrac = u.maxMana > 0 ? u.mana / u.maxMana : 0;
    if (!u.morphed) {
      const saved = {};
      for (const k of MORPH_FIELDS) saved[k] = u[k];
      u.morphed = { saved, until: 0 };
    }
    u.typeId = id2int(typeKey);
    u.typeKey = int2id(u.typeId);
    u.model = t.model || '';
    u.icon = t.icon || '';
    u.armor = t.armor || 0;
    u.armorType = t.armorType || 'none';
    u.atkType = t.atkType || 'normal';
    u.dmgBase = t.dmgBase || 0;
    u.dmgDice = t.dmgDice || 1;
    u.dmgSides = t.dmgSides || 1;
    this.cancelAttack(u);
    u.attackPoint = t.attackPoint ?? 0;
    u.attackBackswing = t.attackBackswing ?? 0;
    u.atkCd = Math.max(0.2, t.atkCd || 1.5);
    u.atkTargetsAllowed = t.atkTargetsAllowed ?? '';
    u.weaponKind = t.weaponKind || '';
    u.weapon2 = secondWeapon(t);
    u.attacksEnabled = t.attacksEnabled ?? 1;
    u.atkRange = t.atkRange || 90;
    u.missile = t.missile || null;
    u.missileSpeed = t.missileSpeed || 0;
    u.missileArc = t.missileArc || 0;
    u.missileHoming = t.missileHoming || 0;
    u.turnRate = t.turnRate ?? 0.6;
    u.movementType = t.movementType || '';
    u.targetAs = t.targetAs || '';
    u.classifications = t.classifications || '';
    u.flyHeight = t.flyHeight || 0;
    u.baseMoveSpeed = t.moveSpeed || u.baseMoveSpeed;
    u.radius = Math.max(8, t.collision || u.radius);
    u.renderScale = t.scale || 1;
    u.hpReg = t.hpReg || 0;
    u.manaReg = t.manaReg || 0.01;
    if (t.str_ != null) { u.str = t.str_; u.strLvl = t.strLvl || 0; }
    if (t.agi != null) { u.agi = t.agi; u.agiLvl = t.agiLvl || 0; }
    if (t.int_ != null) { u.intel = t.int_; u.intLvl = t.intLvl || 0; }
    // The alternate form is a unit type of its own, and its ability list is
    // usually where the transformation's real power lives: Goku's Super Saiyan
    // forms carry the +50/+100/+150 attribute abilities, Ichigo's Bankai carries
    // the Black Getsuga, and twelve more forms on this map do the same. Swapping
    // only the stat block left every one of them behind.
    //
    // Its *hero* abilities are deliberately not touched. An alternate form
    // declares the same hero skills precisely so they carry across, and granting
    // them here would hand the player, at rank 1, whatever they had chosen not
    // to learn.
    const granted = u.morphed.granted || (u.morphed.granted = []);
    for (const a of (t.abilities || [])) {
      const k = id2int(a);
      if (u.abilities.has(k)) continue;
      u.abilities.set(k, 1);
      granted.push(k);
    }
    u.morphed.until = this.now + Math.max(1, seconds || 0) * 1000;
    u.morphed.hpBonus = hpBonus || 0;
    this.recalc(u);
    if (!u.isHero) {
      u.maxHp = Math.max(1, t.hp || u.maxHp);
      u.maxMana = t.mana || u.maxMana;
    }
    u.hp = Math.max(1, Math.round(u.maxHp * hpFrac));
    u.mana = Math.round(u.maxMana * manaFrac);
    this.emit({ t: 'morph', id: u.id, u: u.typeKey });
    return true;
  }

  /** Back to the shape it started in, keeping whatever it earned meanwhile. */
  unmorph(u) {
    if (u) this.cancelAttack(u);
    if (!u || !u.morphed) return false;
    const hpFrac = u.maxHp > 0 ? u.hp / u.maxHp : 1;
    const manaFrac = u.maxMana > 0 ? u.mana / u.maxMana : 0;
    for (const k of MORPH_FIELDS) u[k] = u.morphed.saved[k];
    // only what the form itself added, so anything learned or granted meanwhile
    // survives the change back
    for (const k of (u.morphed.granted || [])) u.abilities.delete(k);
    u.morphed = null;
    this.recalc(u);
    u.hp = Math.max(1, Math.round(u.maxHp * hpFrac));
    u.mana = Math.round(u.maxMana * manaFrac);
    this.emit({ t: 'morph', id: u.id, u: u.typeKey });
    return true;
  }

  summon(owner, typeKey, x, y, seconds, opts = {}) {
    // Warcraft III cannot summon a unit type that does not exist, and this map
    // asks it to: A05N names o000/o00D/o00E/o00F/o00B per level and none of the
    // five is in war3map.w3u -- stale ids the author left behind. createUnit
    // will happily build one anyway, with no type record and so no model, which
    // is what put a modelless unit on the client and what ghost_test caught.
    if (!this.type(typeKey)) return null;
    const p = this.playerOf(owner);
    const u = this.createUnit(p, typeKey, x, y, owner.facing / DEG);
    if (!u) return null;
    u.expireAt = this.now + Math.max(1, seconds) * 1000;
    u.summonedBy = owner.id;
    // A mirror image is not a weaker copy: Warcraft III gives it the hero's own
    // life and states the difference in two fields instead. Omi2 is "Damage
    // Dealt (%)" and Omi3 "Damage Taken (%)", and Blizzard's own Blade Master
    // carries 0 and 2 -- an image that deals nothing and takes double. This map
    // writes 1 and 1.5 on Sandaime's 그림자 분신. The 0.2 life factor that used
    // to be here appears in no field of either of them.
    if (opts.image) {
      u.isImage = true;
      u.dmg = (u.dmg || 0) * (opts.dealt ?? 0);
      u.dmgBase = (u.dmgBase || 0) * (opts.dealt ?? 0);
      u.damageTakenMul = opts.taken ?? 2;
    }
    return u;
  }

  /**
   * Fountains: units carrying Warcraft III's neutral-regen abilities restore a
   * fraction of max life/mana per second to everything in range, friend or foe.
   */
  stepFountains() {
    if (this._fountains === undefined || this.tick % 30 === 0) {
      this._fountains = [];
      for (const u of this.units.values()) {
        if (!u.alive || !u.abilities || !u.abilities.size) continue;
        for (const [key, lvl] of u.abilities) {
          const ab = abilEntry(int2id(key));
          if (!ab) continue;
          if (ab.base !== 'ACnr' && ab.base !== 'ANre') continue;
          const i = levelInfo(ab, lvl || 1);
          this._fountains.push({ u, mana: ab.base === 'ANre',
                                 rate: i.data1 || 0.01, area: i.area || 500 });
        }
      }
    }
    for (const fo of this._fountains) {
      if (!fo.u.alive) continue;
      for (const e of this.enumInRange(fo.u.x, fo.u.y, fo.area)) {
        if (!e.alive || e === fo.u || e.isBuilding) continue;
        if (fo.mana) {
          if (e.maxMana > 0) e.mana = Math.min(e.maxMana, e.mana + e.maxMana * fo.rate * this.dt);
        } else if (e.hp < e.maxHp) {
          e.hp = Math.min(e.maxHp, e.hp + e.maxHp * fo.rate * this.dt);
        }
      }
    }
  }

  /** Repeated area damage over time, as channelled spells do. */
  /**
   * Damage on one unit over time: `perTick` every `interval` seconds for
   * `seconds`, stopping if either party dies.
   *
   * The area channel next door is the wrong shape for this -- Entangling Roots
   * burns the unit it rooted and nothing standing beside it, and a radius small
   * enough to fake that would still catch whatever shares the tile.
   */
  dotUnit(caster, target, perTick, seconds, interval = 1) {
    if (!target || perTick <= 0 || seconds <= 0) return null;
    this.dots = this.dots || [];
    const d = { caster, target, perTick,
                interval: Math.max(100, interval * 1000),
                nextAt: this.now + interval * 1000,
                until: this.now + seconds * 1000 };
    this.dots.push(d);
    return d;
  }

  stepDots() {
    if (!this.dots || !this.dots.length) return;
    for (const d of this.dots) {
      if (this.now >= d.until || !d.target.alive) { d.until = 0; continue; }
      if (this.now < d.nextAt) continue;
      d.nextAt = this.now + d.interval;
      this.damage(d.caster && d.caster.alive ? d.caster : null, d.target, d.perTick, { spell: true });
    }
    this.dots = this.dots.filter((d) => d.until > this.now && d.target.alive);
  }

  /**
   * A damage line out of the caster toward a point: everything hostile within
   * `width` of the line and `length` along it, in the order the world holds
   * them, until `cap` total damage has been dealt.
   *
   * Shared by Carrion Swarm, Shock Wave and Impale, which agree on the shape
   * and disagree completely on which data slot carries which of these four
   * numbers -- so the caller resolves the slots and this only draws the line.
   * Returns the units actually hit, for callers that also stun them.
   */
  lineDamage(caster, tx, ty, damage, length, width, cap = Infinity, eligible = null) {
    const ang = Math.atan2(ty - caster.y, tx - caster.x);
    const cos = Math.cos(ang), sin = Math.sin(ang);
    const hit = [];
    let total = 0;
    for (const e of this.allUnits()) {
      if (eligible ? !eligible(e) : !this.hostile(caster, e)) continue;
      const dx = e.x - caster.x, dy = e.y - caster.y;
      const along = dx * cos + dy * sin;
      const side = Math.abs(-dx * sin + dy * cos);
      if (along <= 0 || along > length || side > width + e.radius) continue;
      if (total >= cap) break;
      total += this.damage(caster, e, damage, { spell: true });
      hit.push(e);
    }
    return hit;
  }

  /**
   * Flame Strike's burning ground: `full` damage every `fullEvery` seconds for
   * the first `fullSeconds`, then `half` every `halfEvery` for the rest of
   * `seconds`, to everything hostile inside `radius`, with each unit taking at
   * most `cap` from the one cast.
   *
   * The area channel next door cannot do this: it has one damage figure, one
   * interval and no per-target accounting, and Flame Strike's six fields are
   * exactly those three things twice over plus the cap.  The circle stays on
   * the ground it was cast on and keeps burning if the caster dies, which is
   * what a patch of fire does.
   */
  burnGround(caster, x, y, radius, o) {
    this.burns = this.burns || [];
    this.burns.push({ caster, x, y, radius, eligible: o.eligible || null,
                      full: o.full || 0, fullEvery: Math.max(50, (o.fullEvery || 1) * 1000),
                      half: o.half || 0, halfEvery: Math.max(50, (o.halfEvery || 1) * 1000),
                      fullUntil: this.now + (o.fullSeconds || 0) * 1000,
                      until: this.now + (o.seconds || 0) * 1000,
                      nextAt: this.now,
                      cap: o.cap > 0 ? o.cap : Infinity,
                      dealt: new Map() });
  }

  stepBurns() {
    if (!this.burns || !this.burns.length) return;
    for (const b of this.burns) {
      if (this.now >= b.until || this.now < b.nextAt) continue;
      const full = this.now < b.fullUntil;
      b.nextAt = this.now + (full ? b.fullEvery : b.halfEvery);
      const per = full ? b.full : b.half;
      if (per <= 0) continue;
      for (const e of (b.eligible ? this.enumInRange(b.x, b.y, b.radius).filter(b.eligible) : this.enemiesInRange(b.caster, b.x, b.y, b.radius))) {
        // the cap counts what the spell asked for, which is the unit the
        // ability's own Hfs1 and Hfs6 are written in -- armour comes off after
        const had = b.dealt.get(e.id) || 0;
        if (had >= b.cap) continue;
        const want = Math.min(per, b.cap - had);
        b.dealt.set(e.id, had + want);
        this.damage(b.caster, e, want, { spell: true });
      }
      this.emit({ t: 'aoe', x: Math.round(b.x), y: Math.round(b.y), r: Math.round(b.radius) });
    }
    this.burns = this.burns.filter((b) => this.now < b.until);
  }

  channel(caster, x, y, radius, perWave, waves, interval, followCaster = false, eligible = null, damageOptions = { spell: true }) {
    this.channels = this.channels || [];
    this.channels.push({ caster, x, y, radius, perWave, left: waves,
                         nextAt: this.now, interval: interval * 1000, followCaster, eligible, damageOptions });
  }

  /**
   * Locust Swarm's release, from the ability's own fields: Uls1 units of type
   * Ulsu, one every Uls2 seconds, all expiring together when the swarm's
   * duration runs out.  They are ordinary units after that -- they acquire and
   * attack with the damage their own unit type carries, which is where the
   * swarm's damage comes from.  Nothing here is a damage figure of our own.
   */
  releaseSwarm(caster, typeKey, count, interval, seconds) {
    if (!this.type(typeKey) || count < 1) return 0;
    this.swarms = this.swarms || [];
    this.swarms.push({ caster, typeKey, left: Math.round(count),
                       interval: Math.max(10, (interval || 0.05) * 1000),
                       nextAt: this.now, until: this.now + Math.max(1, seconds) * 1000 });
    return Math.round(count);
  }

  stepSwarms() {
    if (!this.swarms || !this.swarms.length) return;
    for (const s of this.swarms) {
      if (s.left <= 0) continue;
      if (!s.caster.alive || this.now >= s.until) { s.left = 0; continue; }
      while (s.left > 0 && this.now >= s.nextAt) {
        s.nextAt += s.interval;
        s.left--;
        const a = Math.random() * Math.PI * 2, r = 24 + Math.random() * 64;
        const u = this.summon(s.caster, s.typeKey,
                              s.caster.x + Math.cos(a) * r, s.caster.y + Math.sin(a) * r,
                              Math.max(1, (s.until - this.now) / 1000));
        if (!u) { s.left = 0; break; }
      }
    }
    this.swarms = this.swarms.filter((s) => s.left > 0);
  }

  stepChannels() {
    if (!this.channels || !this.channels.length) return;
    for (const c of this.channels) {
      if (c.left <= 0) continue;
      if (this.now < c.nextAt) continue;
      c.nextAt = this.now + c.interval;
      c.left--;
      if (!c.caster.alive) { c.left = 0; continue; }
      const cx = c.followCaster ? c.caster.x : c.x;
      const cy = c.followCaster ? c.caster.y : c.y;
      for (const e of (c.eligible ? this.enumInRange(cx, cy, c.radius).filter(c.eligible) : this.enemiesInRange(c.caster, cx, cy, c.radius)))
        this.damage(c.caster, e, c.perWave, c.damageOptions);
      this.emit({ t: 'aoe', x: Math.round(cx), y: Math.round(cy), r: Math.round(c.radius) });
    }
    this.channels = this.channels.filter((c) => c.left > 0);
  }

  /** The engine-level behaviour of an ability the unit carries. */
  runAbility(u, key, o) {
    const ab = abilEntry(this.abilKey(key));
    if (!ab) return { ok: false, reason: 'unknown ability' };
    return abilExecute(this, u, ab, this.abilityLevel(u, key) || 1, o);
  }

  /** A dummy unit ordered to cast: run the one active ability it carries. */
  castDummy(u, o) {
    if (!u || !u.abilities) return false;
    for (const [key] of u.abilities) {
      const ab = abilEntry(int2id(key));
      if (!ab || isPassive(ab)) continue;
      this.runAbility(u, key, o);
      return true;
    }
    return false;
  }

  // ------------------------------------------------ player-driven interactions
  /** Buy a hero from a tavern exactly as the map expects (fires EVENT_PLAYER_UNIT_SELL). */
  sellUnit(seller, buyerPlayer, unitTypeId) {
    if (!this.jass) return null;
    // the map's pick area is a sealed pocket; the web lobby replaces it, so a
    // bought hero starts at its team's base like it would after being teleported
    const base = this.teamBase(buyerPlayer ? buyerPlayer.team : 0);
    const x = base[0];
    const y = base[1];
    const u = this.createUnit(buyerPlayer, unitTypeId, x + (Math.random() - 0.5) * 200,
                              y + (Math.random() - 0.5) * 200, 270);
    u.controlled = true;
    this.jass.fire('unitEvent:' + this.jass.eventId('EVENT_PLAYER_UNIT_SELL'),
                   { unit: u, sold: u, seller, buyer: seller, player: buyerPlayer });
    return u;
  }

  /** Buy an item from a shop, raising the map's own sell-item event. */
  sellItem(seller, buyerUnit, itemTypeId) {
    const it = this.createItem(itemTypeId, buyerUnit ? buyerUnit.x : 0, buyerUnit ? buyerUnit.y : 0);
    if (!this.giveItem(buyerUnit, it)) { this.removeItem(it); return null; }
    this.fireUnitEvent('EVENT_PLAYER_UNIT_SELL_ITEM',
      { unit: seller, buyer: buyerUnit, seller, soldItem: it, item: it,
        player: this.playerOf(buyerUnit) });
    return it;
  }

  /** Find the shop that stocks a given item type. */
  shopFor(itemKey) {
    for (const u of this.units.values()) if (u.sellItems && u.sellItems.includes(itemKey)) return u;
    return null;
  }

  /** Find the tavern that sells a given hero type. */
  tavernFor(typeKey) {
    for (const u of this.units.values()) {
      if (u.sellUnits && u.sellUnits.includes(typeKey)) return u;
    }
    return null;
  }

  /**
   * Cast an ability -- as an ORDER with a timeline, not as a function call.
   *
   * Warcraft III does not resolve a spell on the frame it is ordered. The
   * caster walks into range, turns, and starts its spell animation; the effect
   * lands at the unit's cast point (UnitWeapons.slk castpt, 0.3s for most of
   * this roster) or, for an ability with a Casting Time (acas), after that
   * time; a channelled spell then holds the caster until it is done or
   * interrupted. The five spell events mark those moments, and the map's
   * triggers sit on them:
   *
   *   CHANNEL, CAST   the cast begins (in range, facing the target).  Five of
   *                   this map's triggers arm here -- they spawn the ritual
   *                   dummies for A01G, A00L, A03K, A060 and play A00W's
   *                   line -- and then WAIT for the ability's own casting time
   *                   before doing the real work.
   *   EFFECT          the cast point / casting time is reached: mana and
   *                   cooldown are spent and the ability happens.  Almost
   *                   every trigger in the map is here.
   *   FINISH          the spell ran to completion (its channel ended by
   *                   itself).  A022 hides the caster here.
   *   ENDCAST         the caster is no longer casting, for any reason -- after
   *                   FINISH, or alone on an interrupt: a new order, a stun,
   *                   death, the shackled target dying or losing its buff.
   *                   Six triggers clean up here.
   *
   * All five used to fire back to back in one call, which is why Luffy's
   * 고무고무 바람개비 (A04X) threw its target for 500 x 0: its EFFECT trigger
   * starts a spin and its ENDCAST trigger stops it, and the stop landed before
   * the first turn.  Now ENDCAST waits for the channel.
   *
   * What is established from the map and the archives: the event names, the
   * cast point and backswing per unit, the casting time per ability, which
   * abilities the map's own triggers treat as timed rituals, and each channel's
   * length from the ability's own fields.  What is engine behaviour rather than
   * data, and is taken from how the game is known to play rather than from any
   * file here: that mana and cooldown are spent at the effect and not at the
   * order, that a casting time replaces the cast point rather than adding to
   * it, and which bases hold their caster (CHANNEL_HOLDS).  tools/casttime_test.mjs
   * asserts each of the map's own expectations listed above.
   */
  /** Authored unit-target filters, evaluated again before the effect commits. */
  validSpellTarget(u, target, abil, lvl) {
    if (!target || target.hidden || this.isLocust(target)) return false;
    if (this.magicImmune(target) && isMagicalEffect(abil)) return false;
    const flags = new Set((levelInfo(abil, lvl).targets ?? abil?.targets ?? '')
      .toLowerCase().split(',').map(s => s.trim()).filter(Boolean));
    const has = (...names) => names.some(n => flags.has(n));
    if (has('none')) return false;
    if (!target.alive && !has('dead')) return false;
    if (target.alive && has('dead') && !has('alive')) return false;
    if (target.invulnerable && !has('invulnerable', 'invu')) return false;
    if (!target.invulnerable && has('invulnerable', 'invu') && !has('vulnerable', 'vuln')) return false;
    if (has('notself') && target === u) return false;
    const enemy = this.hostile(u, target);
    const ally = this.isAlly(this.playerOf(u), this.playerOf(target));
    if (has('self', 'player', 'friend', 'allies', 'enemy', 'enemies', 'neutral') && !(
      (has('self') && target === u) ||
      (has('player') && target.playerIndex === u.playerIndex) ||
      (has('friend', 'allies') && ally) ||
      (has('enemy', 'enemies') && enemy) ||
      (has('neutral') && !enemy && !ally))) return false;
    const kinds = new Set((target.targetAs || (target.isBuilding ? 'structure' :
      target.movementType === 'fly' ? 'air' : 'ground')).toLowerCase().split(',').map(s => s.trim()));
    if (has('air', 'ground', 'structure', 'ward', 'item', 'debris', 'tree', 'wall', 'bridge') &&
        ![...kinds].some(k => flags.has(k))) return false;
    const types = new Set((target.classifications || '').toLowerCase().split(',').map(s => s.trim()));
    for (const [yes, no, value] of [
      ['mechanical', 'organic', types.has('mechanical')],
      ['hero', 'nonhero', !!target.isHero],
      ['ancient', 'nonancient', types.has('ancient')],
      ['sapper', 'nonsapper', types.has('sapper')],
    ]) {
      if (has(yes, no) && !has(value ? yes : no)) return false;
    }
    return true;
  }

  castAbility(u, abilId, targetUnit, tx, ty) {
    if (!u || !u.alive || !this.jass) return { ok: false, reason: 'dead' };
    const key = typeof abilId === 'number' ? abilId : id2int(abilId);
    const lvl = this.abilityLevel(u, key);
    if (lvl < 1) return { ok: false, reason: 'not learned' };
    if (this.silenced(u)) return { ok: false, reason: 'silenced' };
    u.cooldowns = u.cooldowns || new Map();
    if ((u.cooldowns.get(key) || 0) > this.now) return { ok: false, reason: 'cooldown' };
    const info = this.abilityInfo(key, lvl);
    // the game refuses the ORDER for want of mana; the mana itself goes at the effect
    if (u.mana < info.mana) return { ok: false, reason: 'mana' };
    const targetAbil = abilEntry(this.abilKey(key));
    if (targetUnit && needsUnitTarget(targetAbil) && !this.validSpellTarget(u, targetUnit, targetAbil, lvl))
      return { ok: false, reason: 'invalid target' };
    if (targetUnit && !targetUnit.alive && !needsUnitTarget(targetAbil))
      return { ok: false, reason: 'dead target' };
    // A unit-target spell ordered at bare ground. Warcraft III refuses the
    // ORDER -- the cursor will not take it -- so nothing is spent and the
    // map's own SPELL_EFFECT trigger never runs. Here the cast used to be
    // accepted, walk its cast point, reach castEffect, spend the mana and
    // start the cooldown, and only then have the case return 'need target'
    // and do nothing at all. Four of the map's hero spells are reachable this
    // way, because the target classifier calls almost everything 'point'
    // (see tools/spell_targets.mjs, which says so itself).
    if (!targetUnit && needsUnitTarget(abilEntry(this.abilKey(key))))
      return { ok: false, reason: 'needs a target' };
    // Resume the explicit attack/march after casting; idle acquisition handles
    // casts issued when the player had no attack order.
    const prior = u.order && (u.order.type === 'attack' || u.order.type === 'attackMove') ? u.order : null;
    u.orderQueue = [];
    // a new cast replaces whatever the unit was doing, a cast included
    this.cancelAttack(u);
    this.interruptCast(u);
    const abil = abilEntry(this.abilKey(key));
    const L = abil ? levelInfo(abil, lvl) : {};
    u.cast = {
      key, lvl, abil, info, target: targetUnit || null,
      x: tx ?? (targetUnit ? targetUnit.x : u.x), y: ty ?? (targetUnit ? targetUnit.y : u.y),
      phase: 'approach', begunAt: 0, effectAt: 0, endAt: 0, channels: [], hold: null, prior,
      castTime: Math.max(0, L.castTime || 0),
      ctx: { unit: u, spellId: key, targetUnit: targetUnit || null,
             targetX: tx ?? u.x, targetY: ty ?? u.y, player: this.playerOf(u) },
    };
    u.order = { type: 'cast' };
    u.path = null;
    this.casters = this.casters || new Set();
    this.casters.add(u);
    // in range already: the cast begins on the tick it was ordered, as the
    // game's does, rather than one tick later
    this.stepCast(u);
    return { ok: true };
  }

  /** Where the cast is measured to, and how far it may be from there. */
  castDistance(u, c) {
    const t = c.target;
    if (t) return Math.max(0, Math.hypot(t.x - u.x, t.y - u.y) - (t.radius || 0) - (u.radius || 0));
    return Math.hypot(c.x - u.x, c.y - u.y);
  }

  stepCasts() {
    if (!this.casters || !this.casters.size) return;
    for (const u of [...this.casters]) {
      if (!u.cast) { this.casters.delete(u); continue; }
      if (!u.alive) { this.interruptCast(u); continue; }
      if (u.paused) continue;                          // PauseUnit freezes it in place
      if (this.stunned(u)) { this.interruptCast(u); continue; }
      this.stepCast(u);
    }
  }

  stepCast(u) {
    const c = u.cast;
    if (!c) return;
    if (c.target && (needsUnitTarget(c.abil)
      ? !this.validSpellTarget(u, c.target, c.abil, c.lvl) : !c.target.alive)) {
      // the target died: a cast that had not begun is simply dropped, one in
      // progress is broken off
      this.interruptCast(u);
      return;
    }
    if (c.phase === 'approach') {
      // a range of 0 is a self or instant cast; anything else is walked into
      const range = c.info.range || 0;
      if (range > 0 && this.castDistance(u, c) > range) {
        if (!u.path?.length || (u.repathAt ?? 0) <= this.now) {
          const gx = c.target ? c.target.x : c.x, gy = c.target ? c.target.y : c.y;
          u.path = this.routeUnit(u, gx, gy);
          u.repathAt = this.now + 400;
          if (!u.path || !u.path.length) { this.interruptCast(u); return; }   // no way there
        }
        return;
      }
      u.path = null;
      const gx = c.target ? c.target.x : c.x, gy = c.target ? c.target.y : c.y;
      if (range > 0 && !this.turnToward(u, gx, gy)) return;
      this.beginCast(u);
      return;
    }
    if (c.phase === 'casting') {
      if (this.now >= c.effectAt) this.castEffect(u);
      return;
    }
    if (c.phase === 'channel') {
      const waves = c.channels.some((ch) => ch.left > 0);
      const held = c.hold && this.now < c.hold.until && c.hold.target.alive;
      if (!waves && !held && this.now >= c.endAt) this.finishCast(u);
    }
  }

  beginCast(u) {
    const c = u.cast;
    u.path = null;
    c.phase = 'casting';
    c.begunAt = this.now;
    // A Casting Time (acas) is the time the map's own triggers wait for from
    // CHANNEL -- A01G's waits 3.0 against its 3.0 -- so it stands in for the
    // cast point rather than being added to it.
    c.effectAt = this.now + (c.castTime > 0 ? c.castTime : u.castPoint || 0) * 1000;
    // The ability names the animation it wants, as a Warcraft III token set:
    // "spell,slam", "attack,slam", "spell,throw", "stand,channel". 257 of this
    // map's abilities carry one and nothing had ever read it, so every cast
    // played whichever clip happened to be called "Spell". A cast that holds
    // the unit -- a casting time, a channel -- loops it until castEnd.
    c.loops = c.castTime > 0 || CHANNEL_HOLDS.has(abilBase(c.abil));
    this.emit({ t: 'cast', id: u.id, ab: int2id(c.key), anim: c.abil?.art?.anim || null,
                loop: c.loops ? 1 : 0 });
    this.fireSpellEvent('EVENT_PLAYER_UNIT_SPELL_CHANNEL', c.ctx);
    if (u.cast !== c) return;                          // the trigger itself broke it off
    this.fireSpellEvent('EVENT_PLAYER_UNIT_SPELL_CAST', c.ctx);
  }

  castEffect(u) {
    const c = u.cast;
    if (!c) return;
    if (c.target && needsUnitTarget(c.abil) && !this.validSpellTarget(u, c.target, c.abil, c.lvl)) {
      this.interruptCast(u);
      return;
    }
    u.mana = Math.max(0, u.mana - c.info.mana);
    u.cooldowns.set(c.key, this.now + c.info.cooldown * 1000);
    const before = this.channels ? this.channels.length : 0;
    let res = null;
    // 1. the engine performs the base Warcraft III ability, and draws the art
    //    that ability carries.  An ability with a missile hands its payload to
    //    the missile instead, and resolves when that lands.
    const o = { target: c.target, x: c.x, y: c.y };
    if (!this.launchAbilityMissile(u, c.abil, c.key, o)) res = this.runAbility(u, c.key, o);
    this.emitAbilityArt(c.abil, u, c.target, c.x, c.y);
    if (u.cast !== c) return;                          // the ability moved the caster on
    // a channelled base keeps the caster on the waves it just queued
    if (CHANNEL_HOLDS.has(abilBase(c.abil)) && this.channels)
      c.channels = this.channels.slice(before).filter((ch) => ch.caster === u);
    if (res && res.hold) c.hold = res.hold;
    c.phase = 'channel';
    c.endAt = this.now;
    // 2. the map's own trigger adds its bespoke effects on top
    this.fireSpellEvent('EVENT_PLAYER_UNIT_SPELL_EFFECT', c.ctx);
    if (u.cast !== c) return;
    // nothing holds the caster: the spell is over on the same tick
    if (!c.channels.length && !c.hold) this.finishCast(u);
  }

  /** The spell ran its course. */
  finishCast(u) {
    const c = u.cast;
    if (!c) return;
    this.fireSpellEvent('EVENT_PLAYER_UNIT_SPELL_FINISH', c.ctx);
    this.endCast(u, c);
  }

  /**
   * The caster stops for any other reason.  Nothing fires for a cast that had
   * not begun -- the unit was still walking there -- because nothing had.
   */
  interruptCast(u) {
    const c = u && u.cast;
    if (!c) return;
    for (const ch of c.channels) ch.left = 0;
    if (c.hold) this.releaseHold(c.hold);
    if (c.phase === 'approach') { this.dropCast(u, c); return; }
    this.endCast(u, c);
  }

  endCast(u, c) {
    if (u.cast !== c) return;
    this.dropCast(u, c);
    this.fireSpellEvent('EVENT_PLAYER_UNIT_SPELL_ENDCAST', c.ctx);
  }

  dropCast(u, c) {
    if (c.loops) this.emit({ t: 'castEnd', id: u.id });
    u.cast = null;
    if (this.casters) this.casters.delete(u);
    if (u.order && u.order.type === 'cast') {
      u.path = null;
      const t = c.prior && c.prior.targetId != null ? this.target(c.prior.targetId) : null;
      u.order = !u.orderQueue?.length && c.prior && u.alive && (c.prior.type === 'attackMove' || (t && t.alive)) ? c.prior : { type: 'idle' };
    }
  }

  /** Aerial Shackles lets go: the target walks, and stops burning. */
  releaseHold(h) {
    if (!h || !h.target) return;
    if (h.buff) h.target.buffs = (h.target.buffs || []).filter((b) => b !== h.buff);
    if (h.dot) h.dot.until = 0;
    h.until = 0;
    this.recalc(h.target);
  }

  /**
   * A buff the map strips from a shackled unit ends the shackles.  A04X's own
   * spin loop does exactly this -- UnitRemoveAbility(target, 'Bmlt') -- to let
   * the target go, and the channel has to end with it or the caster stands
   * holding nothing for the rest of the duration.
   */
  holdReleasedBy(target, code) {
    if (!this.casters) return;
    for (const u of this.casters) {
      const c = u.cast;
      if (!c || !c.hold || c.hold.target !== target) continue;
      const buffs = String(levelInfo(c.abil, c.lvl).buff || '').split(',').map((x) => x.trim());
      if (buffs.includes(code)) this.interruptCast(u);
    }
  }

  fireSpellEvent(name, ctx) {
    const k = this.jass.eventId(name);
    if (k != null) this.jass.fire(k, ctx);
  }

  abilityInfo(key, lvl) {
    const a = abilEntry(this.abilKey(key));
    if (!a) return { cooldown: 6, mana: 0 };
    const L = levelInfo(a, lvl);
    return { cooldown: L.cooldown || 0, mana: L.mana || 0,
             range: L.range || 0, area: L.area || 0, name: a.name };
  }

  /**
   * Chat reaches the map's own mode/command triggers.
   *
   * A command whose Korean the map's protection destroyed is translated back to
   * the literal the script actually registered, so a player can type the
   * command the map documents rather than the run of underscores it survives
   * as. See server/chatalias.js for which, and for the evidence.
   */
  chat(playerHandle, text) {
    if (!this.jass) return;
    const t = chatFor(text);
    this.jass.fire('chat', { player: playerHandle, chat: t, chatMatched: t });
  }

  // ------------------------------------------------------------ JASS events
  fireUnitEvent(constName, ctx) {
    if (!this.jass) return;
    const key = this.jass.eventId(constName);
    if (key == null) return;
    this.jass.fire(key, ctx);
  }

  /**
   * The art Warcraft III plays for an ability itself.
   *
   * These are engine visuals, not script ones: the game draws Casterart on who
   * cast, Targetart on what was hit and Areaeffectart over the ground without
   * the map asking. FOC's triggers add their own effects on top, which is why
   * some spells look right already -- but anything relying on the ability's own
   * art was silent, because it lives in Units\*AbilityFunc.txt rather than in
   * AbilityData.slk and so never reached the runtime at all.
   *
   * They are one-shot, unlike a script's AddSpecialEffect, which lives until
   * DestroyEffect: the client drops them once `ttl` has passed.
   */
  emitAbilityArt(ab, caster, target, tx, ty) {
    const art = ab && ab.art;
    if (!art) return;
    const at = (path, unit, x, y) => {
      // an art field may list several models; Warcraft III draws the first
      const p = String(path || '').split(',')[0].trim();
      if (!p || p === '_' || p === '-') return;
      const fx = -(++this.fxSeq);          // negative: never collides with JASS ids
      if (unit) this.emit({ t: 'sfxUnit', fx, path: p, id: unit.id, ttl: ART_TTL });
      else this.emit({ t: 'sfx', fx, path: p, x, y, ttl: ART_TTL });
    };
    at(art.caster, caster);
    // a unit-target spell hangs its art on the unit; a point-target one drops
    // it where it landed
    if (target) at(art.target, target);
    else at(art.target, null, tx, ty);
    at(art.special, null, tx, ty);
    at(art.area, null, tx, ty);
    // Effectart is the fourth of Warcraft III's art slots and was being skipped:
    // it plays where the spell lands, and 103 abilities here carry one.
    if (target) at(art.effect, target);
    else at(art.effect, null, tx, ty);
    // Lightningeffect is the fifth, and the engine draws this one itself rather
    // than playing a model: a strip between caster and target, built from a row
    // in LightningData.slk. 37 abilities here name a type -- chain lightning,
    // mana burn, drain, forked lightning -- and nine of them are hero spells.
    // A field listing two types gives the primary bolt first and the one used
    // for onward jumps second; a single cast draws the primary.
    const bolt = String(art.lightning || '').split(',')[0].trim();
    if (bolt && bolt !== '_' && bolt !== '-' && (target || (tx != null && ty != null))) {
      this.emit({ t: 'lightning', fx: -(++this.fxSeq), code: bolt,
                  x1: caster.x, y1: caster.y,
                  id2: target ? target.id : undefined,
                  x2: target ? target.x : tx, y2: target ? target.y : ty });
    }
  }

  emit(e) { this.clientEvents.push(e); }
  flushEvents() { const e = this.clientEvents; this.clientEvents = []; return e; }

  // -------------------------------------------------------------------- step
  step() {
    this.now += this.dt * 1000;
    this.tick++;
    this.rebuildBins();
    this.stepMovementPaths();
    this.stepGathers();
    this.stepTraining();
    this.stepBuilds();
    this.stepMissiles();
    this.stepItems();
    this.stepCasts();
    this.stepAuras();
    const alive = [];
    for (const u of this.units.values()) {
      if (!u.alive) {
        // the body gets up where it fell, with everything back
        if (u.reincarnateAt && this.now >= u.reincarnateAt) {
          this.reviveUnit(u, u.x, u.y);
          continue;
        }
        // the corpse's time is up: flesh decayed, bones gone
        if (u.corpseUntil && this.now > u.corpseUntil) this.removeUnit(u);
        continue;
      }
      if (u.expireAt && this.now > u.expireAt) { this.killUnit(u, null); continue; }
      const buffCount = u.buffs.length;
      u.buffs = u.buffs.filter((b) => !b.until || b.until > this.now);
      if (u.buffs.length !== buffCount) this.recalc(u);
      if (u.morphed && u.morphed.until && this.now > u.morphed.until) this.unmorph(u);
      if (u.isHero) {
        u.hp = Math.min(u.maxHp, u.hp + (u.hpReg ?? 0) * this.dt);
      } else if (u.hpReg) {
        u.hp = Math.min(u.maxHp, u.hp + u.hpReg * this.dt);
        // Warcraft III kills a unit whose life reaches zero however it got
        // there, and a NEGATIVE life regeneration is how this map gives a spell
        // dummy a life span: 102 of its unit types carry one, and 84 of those
        // have ten life or less, so they are written to bleed out in a couple of
        // seconds.  Nothing here killed them, so every one of them sat on
        // negative life for the rest of the match -- the ten 적화포 dummies, the
        // eighteen around Kisame's water prison, the swords of 하늘의 쇠사슬.
        // No hero on the roster carries a negative regen, so nothing a player
        // controls can die this way.
        if (u.hp <= 0) { this.killUnit(u, null); continue; }
      }
      u.mana = Math.min(u.maxMana, u.mana + (u.manaReg ?? 0) * this.dt);
      if (u.paused || this.stunned(u)) { this.stepAttack(u); continue; }
      if (u.immolation) {
        for (const burn of u.immolation.sources || [u.immolation]) {
          const targets = burn.ab ? (levelInfo(burn.ab, burn.lvl).targets ?? burn.ab.targets ?? '') : '';
          for (const e of this.enumInRange(u.x, u.y, burn.area)) {
            if (burn.ab && !this.validSpellTarget(u, e, burn.ab, burn.lvl)) continue;
            if (!targets.trim() && !this.hostile(u, e)) continue;
            this.damage(u, e, burn.dps * this.dt, { spell: true });
          }
        }
      }
      alive.push(u);
      this.advanceOrders(u);
      this.stepAI(u);
      this.stepMove(u);
      this.stepAttack(u);
    }
    this.stepSwarms();
    this.stepDots();
    this.stepChannels();
    this.stepBurns();
    this.stepFountains();
    this.checkUnitInRange(alive);
    this.checkWaygates(alive);
    this.checkRegions(alive);
    return this.flushEvents();
  }

  /**
   * Creeps and neutral-hostile units pick their own targets; players drive heroes.
   * Acquisition uses each unit type's own range (UnitWeapons.slk 'acquire'), and
   * straying is leashed to the spawn point by the MiscGame.txt guard constants.
   * A unit under a scripted order (attackMove, a waypoint march) is left alone --
   * the map's own orders outrank guard behaviour.
   */
  stepAI(u) {
    if (u.controlled) {
      // Player heroes acquire normally, but never inherit creep guard leashes.
      if (u.order.type === 'attack') {
        const t = this.target(u.order.targetId);
        if (this.weaponFor(u, t)) return;
        u.order = { type: 'idle' }; u.path = null;
      }
      if (u.order.type !== 'idle' || !u.attacksEnabled || u.cast) return;
      let best = null, distance = Infinity;
      for (const t of this.enumInRange(u.x, u.y, u.acquisitionRange)) {
        if (!this.hostile(u, t) || !this.weaponFor(u, t)) continue;
        const d = Math.hypot(t.x - u.x, t.y - u.y);
        if (d < distance) { best = t; distance = d; }
      }
      if (best) u.order = { type: 'attack', targetId: best.id };
      return;
    }
    if (u.isBuilding || u.pickerProp) return;
    if (!u.attacksEnabled) return;                              // it has no weapon to acquire with
    if (u.playerIndex === NEUTRAL_PASSIVE) return;              // shops and props never fight
    if (u.returning) { this.stepReturnHome(u); return; }
    if (u.order.type !== 'idle' && u.order.type !== 'attack') return;

    const fromHome = Math.hypot(u.x - u.homeX, u.y - u.homeY);
    if (u.order.type === 'attack' && fromHome > GUARD_DIST) {
      if (!u.strayedAt) u.strayedAt = this.now;
      const chasing = this.now - Math.max(u.strayedAt, u.lastAttackedAt);
      if (fromHome > MAX_GUARD_DIST || chasing >= GUARD_RETURN_MS) return this.sendHome(u);
    } else {
      u.strayedAt = 0;
      if (fromHome > MAX_GUARD_DIST) return this.sendHome(u);
    }

    // Acquisition range picks a *new* target; it does not drop the current one.
    // A unit keeps chasing what it acquired until the guard rules above turn it
    // around -- otherwise nothing would ever stray far enough to be leashed.
    if (u.order.type === 'attack') {
      const t = this.target(u.order.targetId);
      if (this.weaponFor(u, t)) return;
      u.order = { type: 'idle' }; u.path = null;
    }

    let best = null, bd = Infinity;
    for (const o of this.enumInRange(u.x, u.y, u.acquisitionRange)) {
      if (!o.alive || o === u || o.hidden || o.isBuilding || this.isLocust(o)) continue;
      if (this.isAlly(this.playerOf(u), this.playerOf(o)) || !this.weaponFor(u, o)) continue;
      // no point acquiring prey that already stands outside this unit's post
      if (Math.hypot(o.x - u.homeX, o.y - u.homeY) > MAX_GUARD_DIST) continue;
      const d = Math.hypot(o.x - u.x, o.y - u.y);
      if (d < bd) { bd = d; best = o; }
    }
    if (best) u.order = { type: 'attack', targetId: best.id };
  }

  /** Turn a strayed guard around; it ignores targets until it is back on post. */
  sendHome(u) {
    u.returning = true; u.strayedAt = 0;
    u.order = { type: 'move', x: u.homeX, y: u.homeY };
    u.path = this.routeUnit(u, u.homeX, u.homeY);
  }

  stepReturnHome(u) {
    if (Math.hypot(u.x - u.homeX, u.y - u.homeY) <= 64) {
      u.returning = false; u.order = { type: 'idle' }; u.path = null; return;
    }
    if (u.path && u.path.length) return;
    u.path = this.routeUnit(u, u.homeX, u.homeY);
    u.order = { type: 'move', x: u.homeX, y: u.homeY };
    if (!u.path || !u.path.length) { u.returning = false; u.order = { type: 'idle' }; }
  }

  /**
   * MiscGame.txt CallForHelp / CreepCallForHelp: when a unit is hit, idle
   * neighbours within range join the fight -- this is what makes a creep camp
   * aggro as a group instead of one at a time.
   */
  callForHelp(victim, attacker) {
    if (!attacker.alive || victim.controlled) return;
    const r = victim.playerIndex === NEUTRAL_HOSTILE ? CREEP_CALL_FOR_HELP : CALL_FOR_HELP;
    for (const o of this.enumInRange(victim.x, victim.y, r)) {
      if (o === victim || !o.alive || o.controlled || o.isBuilding || o.pickerProp) continue;
      if (o.playerIndex === NEUTRAL_PASSIVE || o.returning) continue;
      if (o.order.type !== 'idle' || !this.weaponFor(o, attacker)) continue;
      if (!this.isAlly(this.playerOf(o), this.playerOf(victim))) continue;
      if (Math.hypot(attacker.x - o.homeX, attacker.y - o.homeY) > MAX_GUARD_DIST) continue;
      o.order = { type: 'attack', targetId: attacker.id };
    }
  }

  /** Turn rate is radians per 0.03 game seconds. Share one angular budget
   * across movement, casting and attacks in a simulation tick. Visual model
   * interpolation and retail facing tolerances are separate from this rule. */
  turnToward(u, x, y) {
    if (x === u.x && y === u.y) return true;
    const angle = Math.atan2(y - u.y, x - u.x);
    const delta = Math.atan2(Math.sin(angle - u.facing), Math.cos(angle - u.facing));
    if (Math.abs(delta) < 1e-9) return true;
    if (u.paused || this.stunned(u) || !u.alive) return false;
    if (u.turnBudgetAt !== this.now) {
      u.turnBudgetAt = this.now;
      u.turnBudget = Math.max(0, u.turnRate ?? 0.6) * this.dt / 0.03;
    }
    const amount = Math.min(Math.abs(delta), u.turnBudget);
    u.turnBudget -= amount;
    u.facing += Math.sign(delta) * amount;
    u.facing = Math.atan2(Math.sin(u.facing), Math.cos(u.facing));
    return Math.abs(delta) - amount < 1e-9;
  }

  stepMove(u) {
    if (u.attackWindup) return; // movement resumes after release or cancellation
    if (u.order.type === 'hold') { u.path = null; return; }
    if (u.order.type === 'follow') {
      const leader = this.target(u.order.targetId);
      if (!leader?.alive || leader.hidden || this.isLocust(leader)) { u.order = { type: 'idle' }; u.path = null; return; }
      const enemy = leader.order?.type === 'attack' ? this.target(leader.order.targetId) : leader.attackWindup?.target;
      const weapon = enemy && this.hostile(u, enemy) && this.weaponFor(u, enemy);
      if (weapon && Math.hypot(enemy.x - u.x, enemy.y - u.y) <= weapon.atkRange + enemy.radius) {
        u.order = { type: 'attack', targetId: enemy.id }; u.path = null; u.repathAt = 0;
      } else if (Math.hypot(leader.x - u.x, leader.y - u.y) <= Math.max(64, u.radius + leader.radius + 16)) {
        u.path = null; return;
      } else if ((u.repathAt ?? 0) <= this.now) this.requestMovementPath(u, leader.x, leader.y);
    }
    if (u.order.type === 'patrol' || u.order.type === 'attackMove') {
      const eligible = t => !!t && t.alive && !t.hidden && !t.invulnerable
        && this.weaponFor(u, t) && this.hostile(u, t);
      let target = u.attacksEnabled ? this.target(u.order.targetId) : null;
      if (!eligible(target)) {
        target = u.attacksEnabled ? this.enumInRange(u.x, u.y, u.acquisitionRange)
          .filter(eligible).sort((a, b) =>
            Math.hypot(a.x - u.x, a.y - u.y) - Math.hypot(b.x - u.x, b.y - u.y))[0] : null;
        if (u.order.targetId) { delete u.order.targetId; u.path = null; }
      }
      if (target) {
        if (u.order.targetId !== target.id) { u.path = null; u.repathAt = 0; }
        u.order.targetId = target.id;
        if (Math.hypot(target.x - u.x, target.y - u.y) <= this.weaponFor(u, target).atkRange + target.radius) {
          u.path = null; return;
        }
        if ((u.repathAt ?? 0) <= this.now) {
          this.requestMovementPath(u, target.x, target.y);
        }
      } else {
        if (u.order.targetId) { delete u.order.targetId; u.path = null; }
        if (!u.path?.length) {
          if (Math.hypot(u.x - u.order.x, u.y - u.order.y) < 32) {
            if (u.order.type === 'attackMove') { u.order = { type: 'idle' }; return; }
            [u.order.x, u.order.fromX] = [u.order.fromX, u.order.x];
            [u.order.y, u.order.fromY] = [u.order.fromY, u.order.y];
          }
          if ((u.repathAt ?? 0) <= this.now) {
            this.requestMovementPath(u, u.order.x, u.order.y);
          }
        }
      }
    }
    // Keep the pursuit route current as the target moves out of attack range.
    if (u.order.type === 'attack') {
      const t = this.target(u.order.targetId);
      const weapon = this.weaponFor(u, t);
      if (!weapon) { u.path = null; u.order = { type: 'idle' }; return; }
      if (t && t.alive && t.isDest) {
        if (this.destRange(t, u.x, u.y) > weapon.atkRange) {
          if ((u.repathAt ?? 0) <= this.now) {
            this.requestMovementPath(u, t.x, t.y);
          }
        } else u.path = null;
      } else if (t && t.alive) {
        if (Math.hypot(t.x - u.x, t.y - u.y) > weapon.atkRange + t.radius) {
          if ((u.repathAt ?? 0) <= this.now) {
            this.requestMovementPath(u, t.x, t.y);
          }
        } else {
          u.path = null;               // in range: hold position and fight
        }
      }
    }
    let tx = null, ty = null;
    if (u.path && u.path.length) [tx, ty] = u.path[0];
    if (tx == null) return;
    if (!this.turnToward(u, tx, ty)) return;
    const dx = tx - u.x, dy = ty - u.y, d = Math.hypot(dx, dy);
    const stepLen = u.moveSpeed * this.dt;
    const fraction = d > 0 ? Math.min(1, stepLen / d) : 0;
    const nx = u.x + dx * fraction, ny = u.y + dy * fraction;
    const blockers = this.movementBlockers(u, nx, ny);
    if (!this.canAdvance(u, nx, ny, blockers)) {
      if ((u.bodyRepathAt ?? 0) <= this.now) {
        const goal = u.path[u.path.length - 1];
        this.requestMovementPath(u, goal[0], goal[1], true);
      }
      return;
    }
    u.x = nx; u.y = ny;
    if (d <= stepLen) {
      u.path.shift();
      if (!u.path.length) { u.path = null; if (u.order.type === 'move') u.order = { type: 'idle' }; }
    }
  }

  /**
   * A shot in flight.
   *
   * Warcraft III resolves a ranged attack when the missile arrives, not when it
   * is loosed: `Missilespeed` from the weapon decides how long that takes. The
   * damage still belongs to the unit that was aimed at -- an arrow does not miss
   * because its target walked -- but a target that dies first is simply never
   * hit, and that gap is the whole point of giving missiles travel time.
   */
  launchMissile(src, target, opts = {}) {
    const speed = opts.speed || 0;
    // `target` is either a unit to home on or a fixed {x, y} to fly at.  A spell
    // aimed at the ground still has to land there even if whoever was standing
    // on it dies first, so a point shot carries no targetId and always impacts.
    const unit = target && target.id != null ? target : null;
    const dest = target ? { x: target.x, y: target.y } : null;
    if (!src || !dest || speed <= 0) return null;
    const m = {
      fx: ++this.fxSeq,
      srcId: src.id, targetId: unit ? unit.id : null,
      dx: dest.x, dy: dest.y,
      x: src.x, y: src.y,
      speed,
      arc: opts.arc || 0,
      art: opts.art || null,
      onHit: opts.onHit || null,
      // a shot that can never land must not sit in the list for ever
      deadline: this.now + Math.max(1500, (Math.hypot(dest.x - src.x, dest.y - src.y) / speed) * 3000),
    };
    this.missiles.push(m);
    if (m.art) {
      this.emit({ t: 'missile', fx: m.fx, path: m.art, x: src.x, y: src.y,
                  tx: dest.x, ty: dest.y, id: m.targetId, speed, arc: m.arc });
    }
    return m;
  }

  /**
   * Send an ability's payload as a missile, when the ability carries one.
   *
   * Warcraft III resolves a ranged spell when its missile arrives: the caster's
   * animation and the map's trigger fire at once, the damage waits. The ability
   * names the missile itself -- `Missileart`, `Missilespeed`, `Missilearc` in
   * Units\*AbilityFunc.txt -- so nothing here needs a list of which spells fly.
   *
   * Only the *engine* behaviour is deferred. The map's own trigger still runs at
   * cast time, because in the real game that is when it runs.
   *
   * Returns true when the payload has been handed to a missile.
   */
  launchAbilityMissile(caster, ab, key, o) {
    const art = ab && ab.art;
    const speed = art && Number(art.missileSpeed);
    if (!art || !art.missile || !(speed > 0)) return false;
    const target = o.target && o.target.alive ? o.target : null;
    const tx = o.x ?? (target ? target.x : caster.x);
    const ty = o.y ?? (target ? target.y : caster.y);
    // a spell that goes off where the caster stands has nothing to travel
    if (!target && Math.hypot(tx - caster.x, ty - caster.y) < 64) return false;
    const dest = target || { x: tx, y: ty };
    const m = this.launchMissile(caster, dest, {
      speed,
      arc: Number(art.missileArc) || 0,
      art: String(art.missile).split(',')[0].trim(),
      onHit: (src, hitUnit, hx, hy) => {
        if (!src) return;                    // the caster died in flight
        this.runAbility(src, key, { target: hitUnit || null, x: hx ?? tx, y: hy ?? ty });
      },
    });
    return !!m;
  }

  stepMissiles() {
    if (!this.missiles.length) return;
    const step = this.dt;
    const keep = [];
    for (const m of this.missiles) {
      const t = m.targetId != null ? this.target(m.targetId) : null;
      // a homing shot whose target died or left is spent, and damages nothing
      if (m.targetId != null && (!t || !t.alive)) {
        this.emit({ t: 'missileEnd', fx: m.fx });
        continue;
      }
      const aimX = t ? t.x : m.dx, aimY = t ? t.y : m.dy;
      const dx = aimX - m.x, dy = aimY - m.y;
      const dist = Math.hypot(dx, dy);
      const travel = m.speed * step;
      const reach = t && t.isDest ? this.destRange(t, m.x, m.y) : dist - ((t && t.radius) || 0);
      if (reach <= travel || this.now > m.deadline) {
        m.x = aimX; m.y = aimY;
        this.emit({ t: 'missileEnd', fx: m.fx });
        const src = this.units.get(m.srcId);
        if (m.onHit) m.onHit(src && src.alive ? src : null, t, aimX, aimY);
        continue;
      }
      m.x += (dx / dist) * travel;
      m.y += (dy / dist) * travel;
      keep.push(m);
    }
    this.missiles = keep;
  }

  /** Select an enabled weapon without replacing the unit's primary stats. */
  weaponFor(u, t) {
    if (!t || !t.alive || t.hidden || t.invulnerable || (!t.isDest && this.isLocust(t))) return null;
    const kinds = new Set((t.targetAs || t.targType || (t.isBuilding ? 'structure' :
      t.movementType === 'fly' ? 'air' : t.isDest ? 'debris' : 'ground'))
      .toLowerCase().split(',').map(s => s.trim()));
    for (const [bit, weapon] of [[1, u], [2, u.weapon2]]) {
      if (!(u.attacksEnabled & bit) || !weapon) continue;
      if (weapon.atkType === 'magic' && this.magicImmune(t)) continue;
      const flags = new Set((weapon.atkTargetsAllowed ?? '').toLowerCase().split(',').map(s => s.trim()));
      if (![...kinds].some(k => flags.has(k))) continue;
      // Map weapon lists can also narrow relationships and unit classes.
      const types = new Set((t.classifications || '').toLowerCase().split(','));
      if (flags.has('notself') && t === u) continue;
      if (flags.has('enemy') || flags.has('enemies')) {
        if (!this.hostile(u, t)) continue;
      }
      if (flags.has('organic') && !flags.has('mechanical') && types.has('mechanical')) continue;
      if (flags.has('mechanical') && !flags.has('organic') && !types.has('mechanical')) continue;
      if (flags.has('nonhero') && !flags.has('hero') && t.isHero) continue;
      if (flags.has('hero') && !flags.has('nonhero') && !t.isHero) continue;
      return { ...Object.fromEntries(WEAPON_FIELDS.map(k => [k, weapon[k]])), bit };
    }
    return null;
  }

  cancelAttack(u) {
    if (!u.attackWindup) return;
    u.attackWindup = null;
    u.atkTimer = 0; // cancelled before release; a released attack keeps its cooldown
  }

  stepAttack(u) {
    if (u.atkTimer > 0) u.atkTimer = Math.max(0, u.atkTimer - this.dt);
    if (!u.alive || !u.attacksEnabled || u.paused || this.stunned(u) || u.cast) {
      this.cancelAttack(u); return;
    }
    const pending = u.attackWindup;
    if (pending) {
      const t = pending.target;
      const d = t.isDest ? this.destRange(t, u.x, u.y)
        : Math.hypot(t.x - u.x, t.y - u.y) - t.radius;
      if (u.order !== pending.order || this.weaponFor(u, t)?.bit !== pending.weapon.bit || d > pending.weapon.atkRange) {
        this.cancelAttack(u); return;
      }
      pending.remaining -= this.dt;
      if (pending.remaining <= 1e-9) {
        u.attackWindup = null;
        this.releaseAttack(u, t, pending.weapon);
      }
      return;
    }
    if (!['attack', 'attackMove', 'hold', 'patrol'].includes(u.order.type)) return;
    let t = this.target(u.order.targetId);
    if (!t || !t.alive) {
      let bd = Infinity; t = null;
      for (const o of this.units.values()) {
        if (!o.alive || o === u || o.hidden || o.invulnerable || this.isLocust(o)) continue;
        if (!this.hostile(u, o)) continue;
        const weapon = this.weaponFor(u, o);
        if (!weapon) continue;
        const d = Math.hypot(o.x - u.x, o.y - u.y);
        if (d < weapon.atkRange + o.radius + 40 && d < bd) { bd = d; t = o; }
      }
      if (!t) return;
    }
    const d = t.isDest ? this.destRange(t, u.x, u.y)
                       : Math.hypot(t.x - u.x, t.y - u.y) - t.radius;
    const weapon = this.weaponFor(u, t);
    if (!weapon || d > weapon.atkRange) return;
    if (!this.turnToward(u, t.x, t.y)) return;
    if (u.atkTimer > 0) return;
    const speed = Math.max(0.2, u.attackSpeedMul || 1);
    u.atkTimer = Math.max(weapon.atkCd, (weapon.attackPoint || 0) + (weapon.attackBackswing || 0)) / speed;
    const windup = { target: t, order: u.order, weapon, remaining: (weapon.attackPoint || 0) / speed };
    u.attackWindup = windup;
    this.emit({ t: 'attack', id: u.id, target: t.id });
    // ATTACKED is raised at swing start; scripts may cancel the attack here.
    this.fireUnitEvent('EVENT_PLAYER_UNIT_ATTACKED', {
      unit: t, attacker: u, player: this.playerOf(t) });
    if (u.attackWindup !== windup) return;
    if (!u.alive || u.paused || this.stunned(u) || this.weaponFor(u, t)?.bit !== weapon.bit) {
      this.cancelAttack(u); return;
    }
    if (windup.remaining <= 0) { u.attackWindup = null; this.releaseAttack(u, t, weapon); }
  }

  releaseAttack(u, t, weapon = this.weaponFor(u, t)) {
    if (!weapon) return;
    let amount = weapon.dmgBase + ((u.dmg ?? u.dmgBase) - u.dmgBase);
    for (let i = 0; i < Math.max(0, Math.trunc(weapon.dmgDice)); i++)
      amount += Math.floor(Math.random() * Math.max(1, weapon.dmgSides)) + 1;
    const damageOptions = { attackType: ATTACK_TYPES.indexOf(weapon.atkType), damageType: 4 };
    const land = (src, victim) => {
      const hs = this.unitSound(u, 'hit');     // weapon impact, as the engine plays it
      if (hs) this.emit({ t: 'sound', path: hs.path, x: victim.x, y: victim.y,
                          vol: hs.vol * 0.7, pitch: hs.pitch });
      if (!src) return;                        // the shooter died mid-flight
      // The defender's chance first: an evaded attack deals nothing, so it has
      // to short-circuit before cleave as well as before the hit itself.
      const def = attackProcs(this, victim);
      if (def.evade > 0 && Math.random() < def.evade) {
        // Shown to whoever swung, the way the bounty is shown to whoever
        // killed: this is feedback on your own attack. Warcraft III's own
        // audience for it is not stated anywhere the port can read.
        this.emit({ t: 'miss', id: victim.id, x: victim.x, y: victim.y,
                    player: this.playerOf(src)?.index, tag: MISS_TEXT });
        return;
      }
      // ...then the attacker's.  The multiplier goes on the roll rather than on
      // the result, because damage() is where armour applies and a crit is
      // struck before armour reads it.
      const atk = attackProcs(this, src);
      let swing = amount + atk.bonus;
      const crit = atk.chance > 0 && Math.random() * 100 < atk.chance;
      if (crit) swing *= atk.mult || 1;
      if (src.cleave) {
        for (const e of this.enemiesInRange(src, victim.x, victim.y, 150))
          if (e !== victim) this.damage(src, e, amount * src.cleave, damageOptions);
      }
      // Bash: its own roll, its own multiplier, and it stuns what it hits for
      // the ability's own duration.  Independent of the crit roll because the
      // two are different abilities; nothing in this map carries both.
      let bashed = false;
      if (atk.bash && Math.random() * 100 < atk.bash.chance) {
        bashed = true;
        swing = (swing + atk.bash.bonus) * (atk.bash.mult || 1);
        if (atk.bash.stun > 0) {
          this.applyBuff(victim, { kind: 'stun', until: this.now + atk.bash.stun * 1000 });
        }
      }
      const dealt = this.damage(src, victim, swing, damageOptions);
      if (bashed && dealt > 0) {
        this.emit({ t: 'crit', id: victim.id, n: Math.round(dealt),
                    x: victim.x, y: victim.y,
                    player: this.playerOf(src)?.index, tag: BASH_TEXT });
      }
      if (crit && dealt > 0) {
        this.emit({ t: 'crit', id: victim.id, n: Math.round(dealt),
                    x: victim.x, y: victim.y,
                    player: this.playerOf(src)?.index, tag: CRIT_TEXT });
      }
      if (src.lifesteal && dealt > 0) this.heal(src, dealt * src.lifesteal);
    };
    if (weapon.weaponKind !== 'normal' && weapon.missileSpeed > 0 && this.launchMissile(u, t, {
          speed: weapon.missileSpeed, arc: weapon.missileArc, art: weapon.missile, onHit: land })) return;
    land(u, t);                                // melee, or a weapon with no missile
  }

  /** Bodies remain solid when they cannot act. Scripted pathing-off and
   * hidden/Locust units do not obstruct ordinary movement. */
  blocksMovement(u) {
    return u.alive && !u.hidden && !u.pathingOff && !this.isLocust(u);
  }

  movementGrid(u) { return u.movementType === 'fly' ? this.flyGrid : this.grid; }
  routeUnit(u, x, y) { return this.movementPath(u, x, y, []); }

  /** FIFO keeps a wave's automatic pursuit/detour searches from all running
   * on one tick. Explicit player orders still get their initial route at once.
   * The time budget is soft: finish one search before yielding to the next tick. */
  requestMovementPath(u, x, y, body = false) {
    this.pendingMovementPaths ||= new Map();
    if (!this.pendingMovementPaths.has(u))
      this.pendingMovementPaths.set(u, { x, y, body, order: u.order, targetId: u.order.targetId });
  }

  stepMovementPaths() {
    if (!this.pendingMovementPaths?.size) return;
    const started = performance.now();
    let searched = 0;
    for (const [u, request] of this.pendingMovementPaths) {
      if (searched >= 16 || (searched && performance.now() - started >= 6)) break;
      this.pendingMovementPaths.delete(u);
      if (!u.alive || u.removed || u.paused || (u.cast && (!request.body || u.cast.phase !== 'approach')) || u.order !== request.order || u.order.targetId !== request.targetId) continue;
      const target = request.targetId != null ? this.target(request.targetId) : null;
      if (request.targetId != null && !target?.alive) continue;
      const x = target?.x ?? request.x, y = target?.y ?? request.y;
      const path = request.body ? this.movementPath(u, x, y, this.movementBlockers(u)) : this.routeUnit(u, x, y);
      if (request.body) {
        if (path?.length) u.path = path;
        u.bodyRepathAt = this.now + 250;
      } else {
        u.path = path;
        u.repathAt = this.now + 400;
      }
      searched++;
    }
  }

  movementBlockers(u, x = null, y = null) {
    if (!this.blocksMovement(u)) return [];
    const out = [], flying = u.movementType === 'fly';
    for (const t of this.units.values()) {
      if (t === u || (t.movementType === 'fly') !== flying) continue;
      // Only bodies intersecting the swept bounds can obstruct this step.
      // Route searches omit the endpoints and receive all candidate bodies.
      const radius = u.radius + t.radius;
      if (x != null && (t.x < Math.min(u.x, x) - radius || t.x > Math.max(u.x, x) + radius ||
        t.y < Math.min(u.y, y) - radius || t.y > Math.max(u.y, y) + radius)) continue;
      if (this.blocksMovement(t)) out.push(t);
    }
    return out;
  }

  /** Test the whole swept segment, not just its endpoint (fast units must not
   * tunnel through a body). Existing scripted overlaps may move apart. */
  canAdvance(u, x, y, blockers) {
    if (!this.movementGrid(u).clearFootprint(u.x, u.y, x, y, u.pathingOff ? 0 : u.radius)) return false;
    const dx = x - u.x, dy = y - u.y, len2 = dx * dx + dy * dy;
    for (const t of blockers) {
      const ax = t.x - u.x, ay = t.y - u.y;
      const start2 = ax * ax + ay * ay;
      const f = len2 ? Math.max(0, Math.min(1, (ax * dx + ay * dy) / len2)) : 0;
      const distance2 = (ax - f * dx) ** 2 + (ay - f * dy) ** 2;
      const need2 = (u.radius + t.radius) ** 2;
      if (distance2 < Math.min(start2, need2) - 1e-6) return false;
    }
    return true;
  }

  movementPath(u, x, y, blockers) {
    // Freeze these positions for this synchronous search. The next movement
    // step still checks live bodies before committing a waypoint.
    const circles = blockers.map(t => ({ x: t.x, y: t.y,
      r2: Math.min((u.radius + t.radius) ** 2, (u.x - t.x) ** 2 + (u.y - t.y) ** 2) }));
    const grid = this.movementGrid(u), radius = u.pathingOff ? 0 : u.radius;
    // A cell test should inspect nearby bodies, not the entire spawned wave.
    const bucketSize = 128, buckets = new Map();
    const key = (cx, cy) => `${cx},${cy}`;
    for (const circle of circles) {
      const r = Math.sqrt(circle.r2);
      for (let cy = Math.floor((circle.y - r) / bucketSize); cy <= Math.floor((circle.y + r) / bucketSize); cy++)
        for (let cx = Math.floor((circle.x - r) / bucketSize); cx <= Math.floor((circle.x + r) / bucketSize); cx++) {
          const k = key(cx, cy), bucket = buckets.get(k);
          if (bucket) bucket.push(circle); else buckets.set(k, [circle]);
        }
    }
    const occupancy = (px, py) => {
      const bucket = buckets.get(key(Math.floor(px / bucketSize), Math.floor(py / bucketSize)));
      return !bucket || bucket.every(t => (px - t.x) ** 2 + (py - t.y) ** 2 >= t.r2 - 1e-6);
    };
    const pass = (px, py) => grid.clearFootprint(px, py, px, py, radius) && occupancy(px, py);
    if (this.canAdvance(u, x, y, blockers)) return [[x, y]];
    const cell = grid.nearestWalkable(u.x, u.y, 24, pass);
    if (!cell) return null;
    const entry = grid.toWorld(...cell);
    if (!this.canAdvance(u, entry[0], entry[1], blockers)) return null;
    const route = grid.path(entry[0], entry[1], x, y, 20000, circles.length ? occupancy : null, radius);
    return route ? [entry, ...route] : null;
  }

  /** "unit comes within range of X" registrations. */
  checkUnitInRange(list) {
    if (!this.jass) return;
    for (const tr of this.jass.triggers) {
      for (const ev of tr.events) {
        if (ev.kind !== 'unitInRange' || !ev.unit || !ev.unit.alive) continue;
        ev._in = ev._in || new Set();
        for (const u of list) {
          if (u === ev.unit) continue;
          const near = Math.hypot(u.x - ev.unit.x, u.y - ev.unit.y) <= (ev.range || 200);
          if (near && !ev._in.has(u.id)) {
            ev._in.add(u.id);
            this.jass.execTrigger(tr, { unit: u, player: this.playerOf(u) });
          } else if (!near) ev._in.delete(u.id);
        }
      }
    }
  }

  /** Units that walk onto an active waygate are moved to its destination. */
  checkWaygates(list) {
    const gates = [];
    for (const g of this.units.values()) if (g.alive && g.waygate && g.waygate.active) gates.push(g);
    if (!gates.length) return;
    for (const u of list) {
      if (u.isBuilding || u.waygate) continue;
      for (const g of gates) {
        if (Math.hypot(u.x - g.x, u.y - g.y) > (g.radius || 64) + u.radius) continue;
        if (u.lastGate === g.id && this.now - (u.lastGateAt || 0) < 2000) continue;
        const c = this.grid.nearestWalkable(g.waygate.x, g.waygate.y);
        if (!c) continue;
        [u.x, u.y] = this.grid.toWorld(c[0], c[1]);
        u.path = null; u.lastGate = g.id; u.lastGateAt = this.now;
        this.emit({ t: 'teleport', id: u.id, x: Math.round(u.x), y: Math.round(u.y) });
        break;
      }
    }
  }

  /** Enter/leave region events for triggers that registered rects. */
  checkRegions(list) {
    if (!this.jass) return;
    for (const tr of this.jass.triggers) {
      for (const ev of tr.events) {
        if (ev.kind !== 'enter' && ev.kind !== 'leave') continue;
        ev._in = ev._in || new Set();
        for (const u of list) {
          const inside = u.x >= ev.rect.minx && u.x <= ev.rect.maxx
                      && u.y >= ev.rect.miny && u.y <= ev.rect.maxy;
          const was = ev._in.has(u.id);
          if (inside && !was) {
            ev._in.add(u.id);
            if (ev.kind === 'enter') this.jass.execTrigger(tr, { unit: u, player: this.playerOf(u), x: u.x, y: u.y });
          } else if (!inside && was) {
            ev._in.delete(u.id);
            if (ev.kind === 'leave') this.jass.execTrigger(tr, { unit: u, player: this.playerOf(u), x: u.x, y: u.y });
          }
        }
      }
    }
  }

  /** Locust, and no model to draw: an invisible spell-carrier, not a unit. */
  /**
   * APPROXIMATION -- NOT ESTABLISHED FROM THE MAP OR THE MPQs.
   *
   * Warcraft III's Locust ability makes a unit unselectable and untargetable,
   * which is why a Locust Swarm's fifty petals do not pull every enemy in the
   * lane onto themselves.  The extracted data does not say so: Aloc has a row
   * in CommonAbilityStrings with Name=Locust, no Func entry, no tooltip and no
   * data fields.  Everything else about the swarm is sourced; this one line is
   * engine behaviour taken on knowledge, and it is here because the visible
   * alternative -- every hero abandoning its target to swing at petals -- is
   * plainly not the map's behaviour either.
   *
   * Deliberately narrow: it removes locusts from auto-attack ACQUISITION only.
   * It does not make them immune to area damage, because whether Warcraft III
   * does that is a second question the files also do not answer.
   */
  isLocust(u) {
    if (!u) return false;
    if (this._locustTypes === undefined) this._locustTypes = new Map();
    let l = this._locustTypes.get(u.typeKey);
    if (l === undefined) {
      l = ((this.type(u.typeId) || {}).abilities || []).includes('Aloc');
      this._locustTypes.set(u.typeKey, l);
    }
    return l;
  }

  isDummy(u) {
    if (this._dummyTypes === undefined) this._dummyTypes = new Map();
    let d = this._dummyTypes.get(u.typeKey);
    if (d === undefined) {
      const t = this.type(u.typeId) || {};
      const model = String(t.model || '').replace(/\.(mdl|mdx)$/i, '').trim();
      // the map spells "there is no model" several ways; what they share is that
      // none of them name anything that was ever converted
      const named = model && /[\x00-\x7f]/.test(model);
      d = (t.abilities || []).includes('Aloc') && !named;
      this._dummyTypes.set(u.typeKey, d);
    }
    return d;
  }

  /** The colour index whose TeamColor/TeamGlow textures this unit wears. */
  playerColorOf(u) {
    const p = this.jass && this.jass.players && this.jass.players[u.playerIndex];
    const c = p && p.color;
    return typeof c === 'number' ? c : (u.playerIndex ?? 0);
  }

  /** Compact wire snapshot for clients. */
  snapshot() {
    const ents = [];
    for (const u of this.units.values()) {
      if (u.hidden || u.removed || u.pickerProp) continue;
      // A Locust unit with no model is a dummy the map casts spells through.
      // Warcraft III never shows one, and this map leaks them -- Byakuya's Senka
      // creates one per cast and never removes it, as the original does too. They
      // stay in the simulation, because a trigger counting units of a type would
      // notice if they vanished; they simply stop being sent to a client that
      // has nothing to draw for them.
      if (this.isDummy(u)) continue;
      ents.push({ i: u.id, k: u.isHero ? 1 : u.isBuilding ? 3 : 2,
                  u: u.typeKey, x: Math.round(u.x), y: Math.round(u.y),
                  f: +u.facing.toFixed(2), t: u.team, p: u.playerIndex,
                  // Warcraft III's team colour is the *player's* colour, which
                  // the map may reassign, and it is what the model's replaceable
                  // textures are swapped for.
                  c: this.playerColorOf(u),
                  a: u.alive ? 1 : 0, sel: !this.isLocust(u),
                  h: Math.round(u.hp), H: Math.round(u.maxHp),
                  m: Math.round(u.mana), M: Math.round(u.maxMana),
                  l: u.level, mv: u.path ? 1 : 0 });
      // 建造中: 农民身上挂建筑进度 (客户端选择卡/进度渲染)
      if (u.building) {
        const bt = TYPES[u.building.type];
        const total = (bt?.buildTime || 30) * 1000;
        ents[ents.length - 1].bld = {
          type: u.building.type, x: u.building.x, y: u.building.y,
          pct: Math.max(0, Math.min(100, Math.round((1 - (u.building.until - this.now) / total) * 100)))
        };
      }
      if (u.orderQueue?.length) ents[ents.length - 1].q = u.orderQueue.length;
      // Warcraft III hangs the buff's model on the unit for as long as the buff
      // is on it. Sent only when there is one, so the common unit costs nothing.
      const art = [];
      for (const b of (u.buffs || []))
        if (b.code && BUFF_ART[b.code] && (!b.until || b.until > this.now)) art.push(b.code);
      if (art.length) ents[ents.length - 1].b = art;
    }
    // Items lying in the world. They were tracked server-side and never sent,
    // so a dropped item existed, was owned by nobody and sat at the right
    // coordinates -- and was invisible and unreachable from the client.
    const items = [];
    for (const it of this.items.values()) {
      if (it.owner || it.hidden) continue;
      items.push({ i: it.id, u: it.typeKey, x: Math.round(it.x), y: Math.round(it.y),
                   n: it.name || '', c: it.charges || 0 });
    }
    // Warcraft III's on-screen countdown, if the map is showing one. This map
    // runs the duel clock through it, which is how a player knows how long is
    // left -- there is no day/night cycle in this map to read it from.
    let clock = null;
    for (const d of (this.jass && this.jass.timerDialogs) || []) {
      if (!d.shown || !d.timer) continue;
      clock = { title: d.title || '',
                left: Math.max(0, Math.round((d.timer.nextAt - this.now) / 100) / 10) };
      break;
    }
    const quests = (this.jass?.quests || []).filter(q => q.discovered).map(q => ({
      title: q.title, description: q.description, required: q.required, completed: q.completed,
      items: q.items.map(i => ({ description: i.description, completed: i.completed })),
    }));
    // Player resources for the WC3 top bar: gold/lumber spend, supply used/max.
    // Supply max comes from the buildings the melee game starts with (Town
    // Hall +5, Farm +5); service units' food comes straight from UnitData.
    const res = [];
    for (let i = 0; i < 12; i++) res.push(this.playerRes(i));
    return { tick: this.tick, now: Math.round(this.now), ents, items, clock, quests, res };
  }
}
