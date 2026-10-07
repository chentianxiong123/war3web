// Engine-level implementations of the base Warcraft III abilities.
//
// The map's script handles visuals, dummy-cast chains and bespoke effects; the
// abilities themselves are engine behaviour in the real game, so they live here.
// Every number comes from data/abilities.json (the map's own w3a overrides on top
// of Blizzard's AbilityData.slk) — nothing is invented.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
export const ABILS = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/abilities.json'), 'utf8'));

export const PASSIVE_BASES = new Set(['Aloc', 'Avul', 'Aneu', 'Apig', 'Abds', 'Abdl', 'Abgs',
  'Aeat', 'Arlm', 'Aspi', 'Aro1', 'ACm2', 'Asph', 'Aspy', 'Alit', 'ACct',
  // Named here because the map's own use of them settles it, not because the
  // base name suggests it.  AIcf (Cloak of Flames) reaches the map three ways
  // and none of them is a cast: A05Y is handed to a three-second o007 dummy by
  // SetUnitAbilityLevelSwapped and never ordered, A020 rides Eneru's Thunder
  // God form (O003) and does not appear in war3map.j at all, and AIcf is
  // already carried in ITEM_BONUS as a bonus held rather than cast.  ACnr
  // (Neutral Regen) sits on the base structure hatw, targets allies, and is
  // likewise never named by the script.  Both burn or heal on their own clock;
  // see TODO.txt -- until that clock exists they are silent rather than wrong.
  'AIcf', 'ACnr']);

const AURA_BASES = {
  AOae: { kind: 'speed', pct: 0.10 },        // Endurance Aura
  AHab: { kind: 'mana' },
  AHad: { kind: 'armor', flat: 1.5 },        // Devotion Aura
  AUav: { kind: 'vampiric', pct: 0.15 },     // Vampiric Aura
  AUau: { kind: 'regen', pct: 0.02 },        // Unholy Aura
  ACac: { kind: 'damage', pct: 0.10 },       // Command Aura
  AEar: { kind: 'regen', pct: 0.01 },        // Trueshot / brilliance style
};

/**
 * Several abilities are the same behaviour re-published for a different unit
 * (Cairne's War Stomp, the creep Shock Wave, the sea-giant/hydra stomps...).
 * They route to the behaviour they are a copy of.
 */
const BASE_ALIAS = {
  AOw2: 'AOws', Awrg: 'AOws', Awrh: 'AOws', Awrs: 'AOws', ACst: 'AOws',
  AOs2: 'AOsh', ACsh: 'AOsh', ANsh: 'AOsh',
  // ANcl was in this line too and is not Chain Lightning: its slots are
  // Follow Through Time / Target Type / Options and AbilityData.slk comments
  // it "Illidan - Channel".  Unused by this map, so the alias was only ever a
  // trap waiting for a port that does use it.
  ACcl: 'AOcl',
  // ACt2's four slots are Damage, Extra Damage To Target, Movement Speed
  // Reduction and Attack Speed Reduction -- Thunder Clap's set, in Thunder
  // Clap's order. With no case of its own it fell to the damage fallback, which
  // spends slot 1 and cannot see the other three: Sandaime's five 내려치기 ranks
  // carry a 0.2 to 1.0 movement and attack reduction that nothing applied.
  ACt2: 'AHtc',
  Afod: 'AUdc', AUfd: 'AUdc',
  ACfn: 'AUfn', ACdc: 'AUdc', ACtc: 'AHtc',
  ANbf2: 'ANbf',
  // AbilityData.slk's ANcf row carries `code = ANbf` and the comment
  // "Chen - Breath of Fire", and every field the map writes onto it is a
  // Ucs/Nbf one.  It names no fields of its own at all.  It was reaching the
  // Fan of Knives case, so InuYasha's 800-long cone became a 100-radius ring
  // around his own feet.
  ANcf: 'ANbf',
  // Two more of the same shape, found by the second half of the hero sweep.
  // AbilityData.slk's `code` column is the map editor's own answer to "which
  // ability's fields does this row use", and it is what made the ANcf line
  // above right.
  //
  // ACca's code is AUcs, comment "Carrion Swarm (creep)", and AbilityMetaData
  // lists ACca on Ucs1..Ucs4 itself. It was in no table at all, so Uryu's
  // 은령호작 -- whose whole payload is ~60 dummies each casting A04L -- fell to
  // the damage fallback: a 100-radius blast at a random point 250-600 away
  // instead of an 800-long, 125-wide line from the caster. Same numbers,
  // wrong shape, and anything past ~700 units was unhittable.
  ACca: 'AUcs',
  // ANsb's code is AHtb, comment "Rexxar - Storm Bolt". The fallback deals
  // slot 1 and can see nothing else, so Shiki's ultimate 극사나나야 landed its
  // 7000/10000/13000 and dropped the stun the map kept (Dur 5/7/9, HeroDur
  // 3/4/5) along with its B00R buff. Its own trigger pauses the victim for
  // about 1.8 s, so a hero was walking 1.2 to 3.2 s early.
  ANsb: 'AHtb',
};
/**
 * Bases whose case cannot do anything without a unit under the cursor.
 *
 * Every one of these opens with `if (!t) return { ok:false, reason:'need
 * target' }`, so a cast aimed at bare ground reaches the effect and does
 * nothing -- after world.castEffect has already spent the mana and started the
 * cooldown. Warcraft III never lets that happen: a unit-target spell will not
 * take a ground order at all, the cursor simply refuses.
 *
 * Kept as a list rather than derived, because the thing being declared is what
 * the CASES require, and a case that grows a `!t` guard should have to say so
 * here. tools/needtarget_test.mjs asserts the list against the source, so one
 * added without a line here fails rather than passing quietly.
 */
export const NEEDS_UNIT_TARGET = new Set([
  'AHtb', 'ANtb', 'ANfd', 'ANdr', 'AUdc', 'ANin', 'AEer', 'Amls',
]);
/** True when this ability's engine case refuses a cast with no unit target. */
export function needsUnitTarget(ab) { return !!ab && NEEDS_UNIT_TARGET.has(baseOf(ab)); }

export function baseOf(ab) { return (ab && (BASE_ALIAS[ab.base] || ab.base)) || ''; }

/**
 * Base abilities `execute` handles with a named behaviour (not the fallback).
 *
 * AOcr is deliberately absent: it used to share the roar case, spending its
 * Chance to Critical Strike as a rage percentage. It is passive and is read at
 * attack time out of PROC_BASES instead, which is where its Ocr1..Ocr4 mean
 * what they say.
 *
 * ACbh is absent for the same reason and was the same mistake. AbilityMetaData
 * names its slots "Chance to Bash", "Damage Multiplier", "Damage Bonus",
 * "Chance to Miss" and "Never Miss" -- it is Bash, a passive on-attack proc,
 * and it was sitting in the roar case reading a bash chance as a rage
 * percentage. Sandaime Hokage's five 강타 ranks are the only carriers on this
 * map and all five carry passiveArt, so the wrong case never actually ran; it
 * was in HANDLED_BASES, which is what kept tools/ability_audit.mjs reporting
 * five abilities green that nothing implemented. It is read at attack time out
 * of BASH_BASES now.
 */
export const HANDLED_BASES = new Set([
  'AHtb', 'ANtb', 'AUfn', 'AHtc', 'AOws', 'AUcs', 'AOsh', 'AUim', 'ANcs',
  'ANbr', 'ANbf', 'AEfk', 'ACtb', 'AOcl', 'AEch', 'AEbl', 'AUin', 'ANfd', 'AEer',
  'AOmi', 'AUls', 'ANpi', 'AEim', 'AIim', 'AHhb', 'AOhw', 'AChw', 'AHdi',
  'AHbn', 'AHmt', 'AEme', 'ACmt', 'ACro', 'ANdr', 'AUdc',
  'AHfs', 'ANin', 'ANsl', 'AUsl', 'ACsw', 'AHbz', 'AEsf', 'ANrf',
  'AOww', 'ANht', 'ANcr', 'ANms', 'ACmf', 'Amls', 'ANst',
]);

/** True when the ability resolves to a named engine behaviour. */
export function isHandled(ab) {
  return !!ab && HANDLED_BASES.has(baseOf(ab));
}

export function entry(abilId) { return ABILS[abilId] || null; }

export function levelInfo(ab, lvl) {
  const L = (ab && ab.levels) || [];
  if (!L.length) return {};
  return L[Math.max(0, Math.min(L.length - 1, (lvl || 1) - 1))] || {};
}

/**
 * Whether an ability just sits on the unit rather than being cast.
 *
 * Warcraft III's own answer is the order string: anything that can be ordered
 * has one, a passive has none.  `targets` cannot stand in for it -- the table
 * leaves it empty for instant abilities exactly as it does for passives, which
 * is the same trap `tools/spell_targets.mjs` exists to work around for
 * targeting.  Reading it as "no targets means passive" marks most of a FOC
 * roster passive, and castDummy then skips the very ability the map's trigger
 * spawned the dummy to deliver: the effects play and nothing happens.
 */
export function isPassive(ab) {
  if (!ab) return true;
  if (PASSIVE_BASES.has(ab.base)) return true;
  if (AURA_BASES[ab.base] || STAT_AURA_FAMILY[ab.base]) return true;
  // Warcraft III gives its passive skills an order string too, so the icon is
  // the tell: passive art lives under ReplaceableTextures\PassiveButtons.
  if (ab.passiveArt) return true;
  // An order string proves it can be cast.  Its ABSENCE proves nothing:
  // Blizzard writes Order= into AbilityFunc for only some abilities, and
  // Fire Bolt, Finger of Death, Cloak of Flames and Neutral Regen carry an
  // Art= line and no Order= at all -- 462 of the 1046 abilities here have no
  // order string in the data.  So an empty order falls through to the targets
  // it declares rather than deciding on its own.
  if (ab.order) return false;
  const t = (ab.targets || '').toLowerCase();
  return t === '' || t === 'none' || t.includes('nonenone');
}

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
/** The map's value for a data slot, falling back only when it set none. */
const slot = (v, dflt) => (v === undefined || v === null ? dflt : v);
const rnd = (a, b) => a + Math.random() * (b - a);

/**
 * Bases whose DataA is the summon COUNT.
 *
 * AbilityMetaData's Hwe2 ("Summoned Unit Count") names exactly these in its
 * useSpecific column, and Hwe1 ("Summoned Unit Type") the same list -- so for
 * these, and only these, slot 1 is a number of units.  Everything else that
 * reaches summonFrom carries something else in slot 1 and keeps the old reading
 * of one unit.
 */
const SUMMON_COUNT_BASES = new Set(['AHwe', 'AEst', 'ANsg', 'ANsq', 'ANsw', 'ANwm',
  'AOsw', 'AOwd', 'Anwm', 'ACwe', 'AHpx', 'ACtn', 'ANlm']);

/**
 * The summon every summoning ability describes in its own data.
 *
 * Warcraft III keeps what to create in the ability's UnitID column and how many
 * in DataA, for all of Serpent Ward, Feral Spirit, Locust Swarm, Water Elemental
 * and the rest, so this needs no per-ability case -- only that the extractor
 * actually carry those columns through (see tools/abilities.py).
 *
 * A count the map set to ZERO summons nothing.  Rock Lee's 취권 and Haku's A055
 * are both ANsq with Hwe2 = 0 at every level: the map keeps the Quilbeast row
 * for its buff and its cooldown and delivers the real spell from its own
 * trigger, so flooring the count to one put a Quilbeast on the field that the
 * ability's own data forbids.  An ABSENT count still means one, which is what
 * the base rows expect.
 */
function summonFrom(w, caster, i, tx, ty, dur, count) {
  const n = count === undefined ? Math.max(1, Math.round(i.data1 || 1)) : Math.round(count);
  if (n < 1) return { ok: true, summoned: 0 };
  const spread = Math.max(64, Math.min(i.area || 128, 256));
  let made = 0;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + rnd(0, 0.4);
    const r = n > 1 ? spread : 0;
    if (w.summon(caster, i.unit, tx + Math.cos(a) * r, ty + Math.sin(a) * r,
                 dur || 60)) made++;
  }
  return made ? { ok: true, summoned: made }
              : { ok: false, reason: 'could not summon ' + i.unit };
}

/**
 * Metamorphosis and its kin: the unit becomes the type the ability names.
 *
 * Shared by the four bases that do it, which agree on everything the engine
 * uses -- the form in UnitID, the duration in ahdu -- and disagree about slot 5,
 * so the caller resolves that and passes the life bonus in.
 */
function morphInto(w, caster, i, dur, hpBonus) {
  const form = i.unit;
  const secs = i.heroDuration || dur || 45;
  if (form && w.morph(caster, form, secs, hpBonus)) return { ok: true };
  w.applyBuff(caster, { kind: 'morph', pct: 0.35, until: w.now + Math.max(15, dur) * 1000 });
  return { ok: true };
}

/**
 * Execute an ability's engine behaviour.
 * @param {World} w
 * @param {object} caster
 * @param {object} ab      ability table entry
 * @param {number} lvl
 * @param {object} o       {target, x, y}
 */
const MAGICAL_EFFECTS = new Set([
  'AHtb', 'ANtb', 'AUfn', 'AHtc', 'AOws', 'AUcs', 'AOsh', 'AUim', 'ANcs',
  'ANbf', 'AEfk', 'ACtb', 'AOcl', 'AEch', 'AHbz', 'ANrf', 'AHfs', 'AEer',
  'Amls', 'ANsi', 'ACsi', 'ANsl', 'AUsl', 'ACsw', 'ACro', 'ANbr',
  'AUfa', 'AUfu', 'ACfa', 'ANdr', 'ANpi', 'AEim', 'AIcf',
]);
export const isMagicalEffect = ab => MAGICAL_EFFECTS.has(baseOf(ab));
// Explicit native ultimate families; do not infer this from a custom learn level.
const UNIVERSAL_DAMAGE = new Set(['AEsf', 'AOww', 'ANst', 'ANfd', 'ANin', 'AUin']);

export function execute(w, caster, ab, lvl, o = {}) {
  if (!ab || !caster) return { ok: false, reason: 'no ability' };
  if (o.target && (needsUnitTarget(ab) || ['AUfa', 'AUfu', 'ACfa'].includes(baseOf(ab))) &&
      w.magicImmune(o.target) && isMagicalEffect(ab))
    return { ok: false, reason: 'magic immune' };
  const damageOptions = { spell: true, damageType: UNIVERSAL_DAMAGE.has(baseOf(ab)) ? 26 : 14 };
  const i = levelInfo(ab, lvl);
  const tx = o.x ?? (o.target ? o.target.x : caster.x);
  const ty = o.y ?? (o.target ? o.target.y : caster.y);
  // A field the map set to 0 and a field the map never set are different
  // things, and `||` cannot tell them apart.  27 of this map's own abilities
  // write an explicit zero into a slot the engine then defaults over --
  // Htb1:1=0.0, Ocl1:1=0.0, Ucs1:1=0.0, all of them mods in war3map.w3a --
  // because the ability's own trigger carries the payload.  Luffy's A04R
  // proves it is deliberate rather than lazy: Osh1:1..5=0 and then
  // Osh1:6..10=1800..3000 in the same field.  Substituting 80 or 100 there
  // invents damage the author removed.
  //
  // Measured while fixing it: across every ability this map builds, exactly
  // TWO levels reach one of these sites with the slot genuinely absent, and
  // both are retail rows the map never uses.  So the `|| 100` defaults were
  // never doing the job they look like they are doing -- they only ever fired
  // on a deliberate zero.  They are kept because a base row can still reach
  // here, and because the fallback belongs at the site that needs it.
  //
  // The compiled table keeps the distinction (152 levels omit data1 outright),
  // so `slot` can read it and d1..d4 stay undefined when the map set nothing.
  const d1 = i.data1, d2 = i.data2, d3 = i.data3, d4 = i.data4,
        d5 = i.data5, d6 = i.data6;
  const area = i.area || 0;
  const dur = i.heroDuration || i.duration || 0;
  // Native effects use the authored list; direct JASS damage remains separate.
  const targets = i.targets ?? ab.targets ?? '';
  const eligible = e => w.validSpellTarget(caster, e, ab, lvl) &&
    (targets.trim() ? true : w.hostile(caster, e));
  const affected = (x, y, r) => w.enumInRange(x, y, r).filter(eligible);
  const channel = (source, x, y, radius, damage, waves, interval, follow = false) =>
    w.channel(source, x, y, radius, damage, waves, interval, follow, eligible, damageOptions);
  const B = baseOf(ab);

  switch (B) {
    // ---- single-target nuke + stun (Storm Bolt / Thunder Bolt)
    case 'AHtb': case 'ANtb': {
      const t = o.target;
      if (!t) return { ok: false, reason: 'need target' };
      w.damage(caster, t, slot(d1, 100), damageOptions);
      if (dur > 0) w.applyBuff(t, { kind: 'stun', code: i.buff || null, until: w.now + dur * 1000 });
      return { ok: true };
    }
    // ---- armour on an ally for a while (Frost Armor)
    //
    // The two data fields are not damage. The World Editor names them "Armor
    // Duration" (DataA) and "Armor Bonus" (DataB), so the buff's life comes from
    // DataA -- the ability's own Dur field is the chill left on whoever attacks
    // the target, which is why this map sets it to 0.01 and means it.
    //
    // Reading DataA as damage is what broke Ichigo. This map casts Frost Armor
    // off a dummy purely to stamp a named buff on him -- B001 for the Hollow
    // form, B000 for Vizard, both with a zero armour bonus -- and his attack
    // trigger then tests for that buff to grant AGI x3 bonus damage. With no
    // case here the cast fell through to the generic "DataA is damage" default,
    // found the target friendly, and did nothing at all.
    case 'AUfa': case 'AUfu': case 'ACfa': {
      const t = o.target || caster;
      w.applyBuff(t, { kind: 'armor', code: i.buff || null, armor: d2,
                       until: w.now + slot(d1, 0) * 1000 });
      return { ok: true };
    }
    // ---- point AoE damage + slow (Frost Nova)
    case 'AUfn': {
      // Ufn1 is "Area of Effect Damage" and Ufn2 "Specific Target Damage", so
      // the unit actually clicked takes slot 2 and the splash takes slot 1 --
      // the retail Lich carries 50 and 100 in exactly that order, and a nova
      // that splashed harder than it hit would be the wrong way round.  This
      // block had them reversed.
      for (const e of affected(tx, ty, area || 200)) {
        const primary = !!o.target && e === o.target;
        const dmg = primary ? slot(d2, slot(d1, 100)) : slot(d1, 50);
        w.damage(caster, e, dmg, damageOptions);
        if (dur > 0) w.applyBuff(e, { kind: 'slow', pct: 0.4, code: i.buff || null, until: w.now + dur * 1000 });
      }
      return { ok: true };
    }
    // ---- caster-centred AoE + slow (Thunder Clap / War Stomp)
    case 'AHtc': case 'AOws': {
      for (const e of affected(caster.x, caster.y, area || 300)) {
        w.damage(caster, e, slot(d1, 80), damageOptions);
        // A duration of 0.01 is this map saying "the base does nothing here,
        // the trigger does the work" -- the same reading the silence case below
        // already applies.  Flooring it to a second gave four War Stomps a
        // one-second stun the map had deliberately removed: 초콜릿이 되라,
        // 적주함발, 드래곤회오리 치기 and 만뇌 all carry adur = ahdu = 0.01.
        // Below that threshold neither buff lands: a War Stomp must not fall
        // through to Thunder Clap's slow, which is a different ability.
        if (dur <= 0.1) continue;
        const code = i.buff || null;
        if (B === 'AOws') { w.applyBuff(e, { kind: 'stun', code, until: w.now + dur * 1000 }); continue; }
        // Htc3 is "Movement Speed Reduction (%)" and Htc4 "Attack Speed
        // Reduction (%)", both written as fractions -- Blizzard's own Mountain
        // King carries 0.5 and 0.5, Eneru's 뇌격 0.4 and 0.4. The 0.25 that used
        // to be here was a constant of ours matching no field on any of them.
        // War Stomp has neither field: AOws declares only its Damage, which is
        // why it takes the stun branch above and never reaches this one.
        w.applyBuff(e, { kind: 'slow', pct: slot(d3, 0.25), atkPct: slot(d4, 0),
                         code, until: w.now + dur * 1000 });
      }
      return { ok: true };
    }
    // ---- line damage (Carrion Swarm / Shock Wave)
    //
    // Ucs1..Ucs4 and Osh1..Osh4 are the same four in the same order: Damage,
    // Max Damage, Distance, Final Area.  Impale and Cluster Rockets used to
    // share this block and do not share those meanings -- see the two cases
    // below.
    case 'AUcs': case 'AOsh': {
      w.lineDamage(caster, tx, ty, slot(d1, 100), slot(d3, i.range || 800),
                   slot(d4, area || 120), d2 > 0 ? d2 : Infinity, eligible);
      return { ok: true };
    }
    // ---- Impale: a line, but its slots are not Carrion Swarm's
    //
    // Uim1 Wave Distance, Uim2 Wave Time, Uim3 Damage Dealt, Uim4 Air Time.
    // Read positionally as a Carrion Swarm this ran a 2000-long, 1-wide sliver
    // capped at 0.3 total damage: Akiha's 고사리싹의 춤 hit nothing at all.
    // The width is the ability's own area -- Uim has no width field.
    case 'AUim': {
      const hit = w.lineDamage(caster, tx, ty, slot(d3, 100), slot(d1, i.range || 800),
                               area || 120, Infinity, eligible);
      const air = slot(d4, dur);
      if (air > 0) for (const e of hit) w.applyBuff(e, { kind: 'stun', code: i.buff || null, until: w.now + air * 1000 });
      return { ok: true };
    }
    // ---- Cluster Rockets: a barrage into an area, not a line at all
    //
    // Ncs1 Damage Amount, Ncs2 Damage Interval, Ncs3 Missile Count, Ncs4 Max
    // Damage.  Yusuke's 숏건 fires Ncs3 rockets one every Ncs2 seconds into the
    // ability's own area; read as a line its Damage Interval became a total
    // damage cap of 0.3 and it stopped after a single unit.
    case 'ANcs': {
      const shots = Math.max(1, Math.round(slot(d3, 1)));
      channel(caster, tx, ty, area || 200, slot(d1, 100), shots, slot(d2, 0.25));
      return { ok: true };
    }
    // ---- cone damage (Breath of Fire / Breath of Frost)
    //
    // ANbr is NOT one of these.  Its slots are Nbr1 "Damage Increase" then
    // Roa2..Roa6 -- it is Battle Roar, targets friend and self, and belongs
    // with the roar case below.  Running it here pointed a hostile cone at
    // Rob Lucci's 『철괴』 and Byakuya's 섬경 천본앵경엄.
    case 'ANbf': {
      // Nbf2 Max Damage, Nbf3 Distance, Nbf4 Final Area -- the same four
      // Carrion Swarm carries, and the cone was reading none of them. `range` is
      // how far the order may be issued, not how far the breath reaches: Ichigo's
      // 검은 월아천충 is a 600 cone ordered at 800, and InuYasha's 폭류파 an 800
      // cone ordered at 900.
      //
      // The spread comes from the same two fields rather than from a constant:
      // a cone `len` long ending `d4` wide subtends atan(d4/len), which is 34
      // degrees for Ichigo against the flat 26 this used for everything.
      const len = slot(d3, i.range || 500);
      const half = slot(d4, 0) > 0 ? Math.atan2(d4, len) : 0.45;
      const cap = slot(d2, 0) > 0 ? d2 : Infinity;
      let spent = 0;
      const ang = Math.atan2(ty - caster.y, tx - caster.x);
      for (const e of w.allUnits()) {
        if (!eligible(e)) continue;
        const d = dist(caster, e);
        if (d > len) continue;
        let da = Math.atan2(e.y - caster.y, e.x - caster.x) - ang;
        while (da > Math.PI) da -= Math.PI * 2;
        while (da < -Math.PI) da += Math.PI * 2;
        if (Math.abs(da) > half) continue;
        if (spent >= cap) break;
        const hit = Math.min(slot(d1, 80), cap - spent);
        spent += hit;
        w.damage(caster, e, hit, damageOptions);
        // Nbf5 is a Damage Per Second the breath leaves behind; only Itachi's
        // 화둔-호화구의 술 carries one on this map.
        if (slot(d5, 0) > 0 && dur > 0) w.dotUnit(caster, e, d5, dur, 1);
        if (dur > 0) w.applyBuff(e, { kind: 'slow', pct: 0.3, code: i.buff || null, until: w.now + dur * 1000 });
      }
      return { ok: true };
    }
    // ---- Stampede: beasts pouring through a spot for the ability's duration
    //
    // Nst1 Beasts Per Second, Nst2 Beast Collision Radius, Nst3 Damage Amount,
    // Nst4 Damage Radius, Nst5 Damage Delay.  With no case it fell to the damage
    // fallback, which spends slot 1 -- so Gaara's 유사폭류, a ten-second
    // bombardment, dealt its FIVE BEASTS PER SECOND as five damage, once, and
    // Kisame's 수둔-대 폭포술 dealt two.  The 25 and the 1000 they actually carry
    // are in slot 3 and were read by nothing.
    //
    // Nst2 is the beasts' own collision radius, which matters only if the beasts
    // are drawn as units; the map's own art does that and the engine's damage
    // does not need it.
    case 'ANst': {
      const perSec = Math.max(0.1, slot(d1, 1));
      const secs = i.duration || i.heroDuration || 0;
      if (secs <= 0) return { ok: false, reason: 'no duration in the data' };
      channel(caster, tx, ty, slot(d4, area || 200), slot(d3, 0),
                Math.max(1, Math.round(perSec * secs)), 1 / perSec);
      return { ok: true };
    }
    // ---- caster AoE nuke (Fan of Knives, Cluster Rockets, Cyclone-likes)
    case 'AEfk': case 'ACtb': {
      for (const e of affected(caster.x, caster.y, area || 400)) w.damage(caster, e, slot(d1, 100), damageOptions);
      return { ok: true };
    }
    // ---- chain lightning
    case 'AOcl': case 'AEch': {
      let t = o.target, dmg = slot(d1, 100);
      const hops = Math.max(1, slot(d2, 4));
      const hit = new Set();
      for (let k = 0; k < hops && t && eligible(t); k++) {
        w.damage(caster, t, dmg, damageOptions);
        hit.add(t.id);
        dmg *= 0.75;
        let next = null, bd = Infinity;
        for (const e of w.allUnits()) {
          if (hit.has(e.id) || !eligible(e)) continue;
          const d = dist(t, e);
          if (d < 500 && d < bd) { bd = d; next = e; }
        }
        t = next;
      }
      return { ok: true };
    }
    // ---- blink
    //
    // Ebl1 is "Maximum Range" and Ebl2 "Minimum Range" (AbilityMetaData, both
    // useSpecific AEbl and nothing else).  Neither is the ability's `range`,
    // which is how far away the ORDER may be issued: Blizzard's own Warden
    // carries Rng1 = 99999 against Ebl1 = 1000 and Ebl2 = 200, and this map
    // keeps the same 99999 while writing Ebl1 = 400 on both of its blinks.
    // Reading the order range as the hop let Eneru's 전광 and Renji's 순보
    // cross the entire map in one jump.
    //
    // APPROXIMATION -- the minimum is clamped rather than refused.  The data
    // names the field and says nothing about what Warcraft III does with a
    // click inside it, so the hop is held to at least that distance; the other
    // reading is that the order is rejected outright.
    case 'AEbl': {
      const max = slot(d1, i.range || 700);
      const min = Math.min(slot(d2, 0), max);
      const d = Math.min(Math.max(dist(caster, { x: tx, y: ty }), min), max);
      const ang = Math.atan2(ty - caster.y, tx - caster.x);
      const c = w.grid.nearestWalkable(caster.x + Math.cos(ang) * d, caster.y + Math.sin(ang) * d);
      if (!c) return { ok: false, reason: 'blocked' };
      [caster.x, caster.y] = w.grid.toWorld(c[0], c[1]);
      caster.path = null;
      return { ok: true };
    }
    // ---- channelled area damage (Blizzard, Rain of Fire)
    //
    // Hbz1 is the WAVE COUNT and Hbz2 the damage per wave, in that order --
    // AbilityMetaData gives both fields to AHbz, ACbz, ANrf and ACrf, and
    // WorldEditStrings names them "Number of Waves" and "Damage".  Read the
    // other way round the total came out right and the shape did not: Nico
    // Robin's rank-3 시엔플루르, 30 waves of 1100, ran as 1100 waves of 30 and
    // bombarded a 600 radius for eighteen minutes.  tools/slot_test.mjs now
    // holds both fields to their declared meaning.
    //
    // APPROXIMATION -- the wave INTERVAL is not a field.  Nothing in the w3a,
    // the SLK or AbilityMetaData carries one for this family: retail spreads
    // the waves across the ability's own duration, so that is what this does.
    // It is the map's own two numbers rather than a constant of ours, and it
    // is right for 보구의 비 (5 waves, adur 10 -> one every 2s); where the map
    // has zeroed the duration to 0.01 to drive the spell from its own trigger,
    // the interval falls below a tick and stepChannels fires one wave per tick
    // regardless, so 시엔플루르's 30 waves land in about a second rather than
    // over the eighteen minutes the swapped slots produced.
    case 'AHbz': case 'ANrf': {
      const waves = Math.max(1, Math.round(slot(d1, 4)));
      const per = slot(d2, 40);
      const secs = i.duration || i.heroDuration || 0;
      channel(caster, tx, ty, area || 250, per, waves, secs > 0 ? secs / waves : 0);
      return { ok: true };
    }
    // ---- Starfall: its own fields, not Blizzard's
    //
    // Esf1 Damage Dealt, Esf2 Damage Interval, Esf3 Building Reduction -- no
    // wave count, no shards.  It shared the block above until the slot check
    // pointed out that AbilityMetaData never gives AEsf an Hbz field.  Unused
    // by this map; kept honest so it stays that way.
    case 'AEsf': {
      const every = slot(d2, 1);
      const secs = i.duration || i.heroDuration || 0;
      channel(caster, caster.x, caster.y, area || 250, slot(d1, 40),
                Math.max(1, Math.round(secs / every)), every, true);
      return { ok: true };
    }
    // ---- Bladestorm: damage everything around the caster for a duration
    case 'AOww': {
      channel(caster, caster.x, caster.y, area || 200, slot(d1, 75),
                Math.max(1, Math.round(dur || 6)), 1.0, true);
      return { ok: true };
    }
    // ---- Howl of Terror: cut nearby enemies' damage
    case 'ANht': {
      for (const e of affected(caster.x, caster.y, area || 500))
        w.applyBuff(e, { kind: 'weaken', pct: Math.abs(slot(d1, 25)) / 100, code: i.buff || null,
                         until: w.now + Math.max(5, dur) * 1000 });
      return { ok: true };
    }
    // ---- summons
    // Inferno: Uin1 Damage, Uin2 Duration, Uin3 Impact Delay.  The summon's life
    // is Uin2, not the ability's own Dur field -- five abilities here carry one
    // and it was read by nothing, so every infernal on the map lived the 60
    // seconds of our fallback instead of the 0.01 to 5 the map wrote.
    case 'AUin': {
      for (const e of affected(tx, ty, area || 200)) w.damage(caster, e, slot(d1, 50), damageOptions);
      // the map can re-skin what Inferno drops; its own UnitID says which
      w.summon(caster, i.unit || 'ninf', tx, ty, slot(d2, dur || 60));
      return { ok: true };
    }
    // Omi1 Number of Images, Omi2 Damage Dealt (%), Omi3 Damage Taken (%).
    case 'AOmi': {
      const n = Math.max(1, slot(d1, 1));
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        w.summon(caster, caster.typeKey, caster.x + Math.cos(a) * 120,
                 caster.y + Math.sin(a) * 120, dur || 30,
                 { image: true, dealt: slot(d2, 0), taken: slot(d3, 2) });
      }
      return { ok: true };
    }
    // ---- Locust Swarm: the swarm IS the spell, and the fields say so
    //
    // AbilityMetaData's Uls1..Uls5 resolve through WorldEditStrings to Number
    // of Swarm Units, Unit Release Interval, Max Swarm Units Per Target,
    // Damage Return Factor and Damage Return Threshold.  This case used to pass
    // d1 to w.damage -- dealing the petal COUNT as a damage figure, one
    // invisible pulse of 50 or 100.  Byakuya's A00T is the only caster in this
    // map: 50 uloc at ranks 1-5, 100 u000 at 6-10, one every 0.05 s, and the
    // damage is the petals' own attack out of their unit type rather than a
    // number of ours.
    case 'AUls': {
      const n = Math.round(slot(d1, 0));
      if (!i.unit || n < 1) return { ok: false, reason: 'no swarm in the data' };
      const made = w.releaseSwarm(caster, i.unit, n, slot(d2, 0.05), dur || 5);
      return made ? { ok: true, summoned: made } : { ok: false, reason: 'no swarm unit' };
    }
    // ---- damage-over-time aura the unit carries (Immolation)
    case 'ANpi': case 'AEim': case 'AIim': {
      caster.activeImmolation = { dps: slot(d1, 10), area: area || 200, ab, lvl };
      caster.immolation = caster.activeImmolation;
      return { ok: true };
    }
    // ---- heals / buffs
    case 'AHhb': case 'AOhw': case 'AChw': {
      const t = (o.target && !w.hostile(caster, o.target)) ? o.target : caster;
      w.heal(t, slot(d1, 200));
      return { ok: true };
    }
    // ---- Human priest Heal (Ahea): DataA heal amount, ally/self only.
    // WC3's priest heal also condemns on undead for negative data, but Terenas
    // is Human-vs-Human and the ability's authored targets are friendly-only.
    case 'Ahea': {
      const t = (o.target && !w.hostile(caster, o.target)) ? o.target : caster;
      w.heal(t, slot(d1, 25));
      return { ok: true };
    }
    // ---- Human priest Inner Fire (Ainf): DataA attack %, DataB armour.
    case 'Ainf': {
      const t = o.target || caster;
      if (!t || w.hostile(caster, t)) return { ok: false, reason: 'need ally target' };
      w.applyBuff(t, { kind: 'innerfire', pct: slot(d1, 0.1) || 0.1, armor: slot(d2, 5),
                       code: i.buff || null, until: w.now + Math.max(1, dur) * 1000 });
      return { ok: true };
    }
    // ---- Human priest Dispel Magic (Adis): DataB radius; strip buffs.
    case 'Adis': {
      for (const e of affected(tx, ty, slot(d2, 200))) w.clearBuffs(e);
      return { ok: true };
    }
    // ---- Human sorceress Slow (Aslo): DataA move %, DataB attack speed %.
    case 'Aslo': {
      const t = o.target;
      if (!t) return { ok: false, reason: 'need target' };
      w.applyBuff(t, { kind: 'slow', pct: slot(d1, 0.6), atkPct: slot(d2, 0.25),
                       code: i.buff || null, until: w.now + Math.max(1, dur) * 1000 });
      return { ok: true };
    }
    // ---- Human sorceress Invisibility (Aivs): hide an ally until it acts.
    case 'Aivs': {
      const t = (o.target && !w.hostile(caster, o.target)) ? o.target : caster;
      w.applyBuff(t, { kind: 'invis', code: i.buff || null, until: w.now + Math.max(1, dur) * 1000 });
      return { ok: true };
    }
    // ---- Human sorceress Polymorph (Aply): the target becomes a sheep -- in
    // WC3 the unit is replaced by a sheep unit; here the practical effect is a
    // long disable (it cannot attack or act) for the authored duration.
    case 'Aply': {
      const t = o.target;
      if (!t) return { ok: false, reason: 'need target' };
      w.applyBuff(t, { kind: 'stun', code: i.buff || 'Bshe', until: w.now + Math.max(1, dur) * 1000 });
      return { ok: true };
    }
    // ---- Human footman Defend (Adef): toggle stance. DataA damage taken %,
    // DataC attack speed loss %. No duration in the data (toggle), so the buff
    // lives until the player issues Defend again.
    case 'Adef': {
      const has = (caster.buffs || []).some((b) => b.kind === 'defend' && b.until > w.now);
      caster.buffs = (caster.buffs || []).filter((b) => !(b.kind === 'defend'));
      if (!has) w.applyBuff(caster, { kind: 'defend', pct: slot(d1, 0.5), atkPct: slot(d3, 0.3),
                                      code: i.buff || null, until: w.now + 24 * 60 * 60 * 1000 });
      w.recalc(caster);
      return { ok: true };
    }
    case 'AHdi': case 'AHbn': {
      w.applyBuff(caster, { kind: 'rage', pct: 0.25, code: i.buff || null, until: w.now + Math.max(5, dur) * 1000 });
      return { ok: true };
    }
    // Metamorphosis and its kin genuinely replace the unit: `unit` names the
    // form to take. Approximating it with a damage buff left nine heroes' whole
    // transformation -- Full Demon Form, Super Saiyan, Bankai -- as a number
    // going up quietly with nothing to see and no new body to fight in.
    case 'AHmt': case 'ACmt': case 'ANcr': {
      return morphInto(w, caster, i, dur, 0);
    }
    // AEme is split from its three neighbours for one field. Eme5 is "Alternate
    // Form Hit Point Bonus" -- life the form carries on top of its own unit
    // type's -- and AbilityMetaData gives that meaning to AEme alone: Chemical
    // Rage's fifth slot is a "Move Speed Bonus (Info Panel Only)", which is a
    // different thing entirely and must not be spent as life. Both of this
    // map's Metamorphoses write 3000 into Eme5 (InuYasha's 요괴화 and Eneru's
    // 뇌신) and nothing read it, so both forms stood 3000 life short of what the
    // map says they are.
    case 'AEme': {
      return morphInto(w, caster, i, dur, d5 || 0);
    }
    // Roa1 Damage Increase, Roa2 Defense Increase, Roa3 Life Regeneration Rate.
    // Only the first was read, so Byakuya's 섬경 천본앵경엄 handed out its 1000
    // damage and dropped the 100 armour and 150 life a second beside it, and Rob
    // Lucci's 『철괴』 -- which carries a zero damage increase and a hundred
    // points of armour -- did nothing at all.
    case 'ACro': case 'ANbr': {
      for (const a of w.alliesInRange(caster, caster.x, caster.y, area || 500).filter(a => w.validSpellTarget(caster, a, ab, lvl)))
        w.applyBuff(a, { kind: 'rage', pct: slot(d1, 25) / 100, code: i.buff || null,
                         armor: slot(d2, 0), regen: slot(d3, 0),
                         until: w.now + Math.max(5, dur) * 1000 });
      return { ok: true };
    }
    // (AOsf -- Spirit Wolves -- used to sit in this group, which meant a spell
    //  whose own data names the wolves to summon threw a damage number instead.)
    // ---- Finger of Death
    //
    // Nfd1 Graphic Delay, Nfd2 Graphic Duration, Nfd3 Damage.  It was aliased
    // to Death Coil, whose single slot IS its damage, so slot 1 was spent as
    // the damage figure: Sandaime's 금술오의-시귀봉진 carries 10000 in Nfd3 and
    // 0.25 in Nfd1, and dealt the 0.25.
    case 'ANfd': {
      const t = o.target;
      if (!t) return { ok: false, reason: 'need target' };
      if (d3 > 0) w.damage(caster, t, d3, damageOptions);
      return { ok: true };
    }
    // ---- Flame Strike: a burning circle on the ground, not a bolt at a unit
    //
    // Hfs1 Full Damage Dealt, Hfs2 Full Damage Interval, Hfs3 Half Damage
    // Dealt, Hfs4 Half Damage Interval, Hfs5 Building Reduction, Hfs6 Maximum
    // Damage -- AbilityMetaData gives all six to AHfs/ACfs/Abof and to nothing
    // else.  It used to share the Death Coil case next door, which reads slot 1
    // as one damage figure at one unit: Akiha's 달을 뚫는다 dealt 150 of its
    // 3000 in a single pulse, and a click on bare ground -- which is how the
    // spell is cast -- returned 'need target' and did nothing whatever.
    //
    // The two durations are the two phases rather than a hero/creep pair: the
    // ability targets the ground, so there is no unit to be a hero, and the
    // shorter of them is how long the full damage lasts.  Blizzard's own row
    // reads the same way, HeroDur1 2.67 inside Dur1 9.
    //
    // Hfs6 is capped PER TARGET, which is the reading this map's own arithmetic
    // supports: the author set it to exactly Hfs1 x 20.05 at every level (300
    // against 15, 3000 against 150), and 20.05 is the number of 0.2 s ticks in
    // the 4.01 s full phase -- so the cap is what one unit takes from standing
    // in the whole burn.  Recorded as a reading rather than a fact because
    // Blizzard's retail row does not follow the same rule (DataF1 90 against a
    // 121 full-phase total), and nothing in the data says which it is.
    case 'AHfs': {
      const secs = i.duration || i.heroDuration || 0;
      if (secs <= 0) return { ok: false, reason: 'no duration in the data' };
      w.burnGround(caster, tx, ty, area || 200, {
        eligible,
        full: slot(d1, 0), fullEvery: slot(d2, 1) || 1,
        half: slot(d3, 0), halfEvery: slot(d4, 1) || 1,
        fullSeconds: Math.min(i.heroDuration || secs, secs),
        seconds: secs,
        cap: d6 > 0 ? d6 : Infinity,
      });
      return { ok: true };
    }
    case 'ANdr': case 'AUdc': case 'ANin': {
      const t = o.target;
      if (!t) return { ok: false, reason: 'need target' };
      w.damage(caster, t, slot(d1, 120), damageOptions);
      if (B === 'ANdr') w.heal(caster, slot(d1, 120));
      return { ok: true };
    }
    // ---- Silence: the area cannot cast until it wears off.  FOC zeroes this
    // base on most of the spells built from it (duration 0.01, all data 0) and
    // does the work in its own trigger, so a near-zero duration is the map
    // saying "do nothing" rather than a value to floor upward.
    // ---- Entangling Roots
    //
    // Eer1 is "Damage per Second" and the base's whole point is that the target
    // cannot move while it burns -- it can still attack, so this is a total
    // movement slow and not a stun.
    //
    // AEer had no case at all and fell to the damage fallback, which cost more
    // than the roots: the buffs these abilities declare gate the map's own
    // triggers. 클러치 (A06Q) filters for units carrying B00H and 사폭장송
    // (A05Q) for B00X, and with nothing able to stamp either code both filters
    // were permanently empty. tools/ability_audit.mjs has been printing them
    // under BUFF SEAMS.
    case 'AEer': {
      const t = o.target;
      if (!t) return { ok: false, reason: 'need target' };
      // Warcraft III carries two durations and picks by what it hit. The rest
      // of this file takes heroDuration whenever there is one, which shortens
      // every root on a creep -- 사박궤 holds a hero 2s and a non-hero 10s, and
      // read the other way both get 2. Noted for the other cases in TODO.txt.
      const secs = (t.isHero ? i.heroDuration : i.duration) || i.duration
                || i.heroDuration || 0;
      if (secs <= 0.1) return { ok: true };          // the map's "do nothing"
      w.applyBuff(t, { kind: 'slow', pct: 1, code: i.buff || null,
                       until: w.now + secs * 1000 });
      if (slot(d1, 0) > 0) w.dotUnit(caster, t, d1, secs, 1);
      return { ok: true };
    }
    // ---- Mana Shield: the damage comes off mana instead of life
    //
    // Nms1 "Mana per Hit Point" and Nms2 "Damage Absorbed (%)" (AbilityMetaData,
    // useSpecific ANms/ACmf).  Nothing in server/ read either, so the three
    // shields on this map -- Sandaime's 토둔-토류벽, Nico Robin's 칼렌듈러 and
    // Orochimaru's 수둔-수진벽 -- did nothing at all.
    //
    // All three carry Nms2 = 1.0 (100% absorbed) and Nms1 = -0.01, a NEGATIVE
    // rate: absorbing damage pays mana back rather than spending it.  That is
    // the map writing "cancels all damage" in the ability's own fields, and
    // A00S's tooltip says exactly that -- 모든 데미지 캔슬.  Retail's row spends
    // 1 mana per point and runs until the mana is gone, which the same code
    // covers because the rate decides which way the mana moves.
    //
    // Warcraft III makes this a toggle (the order strings are manashieldon and
    // manashieldoff) with no duration; this map gives all three an ahdu of
    // 5-10 s, so the shield is timed here and the toggle-off order is not
    // modelled.
    case 'ANms': case 'ACmf': {
      const t = (o.target && !w.hostile(caster, o.target)) ? o.target : caster;
      const secs = i.heroDuration || i.duration || 0;
      w.applyBuff(t, { kind: 'manashield', code: i.buff || null,
                       pct: Math.max(0, Math.min(1, slot(d2, 1))),
                       manaPerHp: slot(d1, 1),
                       until: secs > 0 ? w.now + secs * 1000 : Infinity });
      return { ok: true };
    }
    // ---- Aerial Shackles: held in place, and burning while held
    //
    // Mls1 is "Damage Per Second" (AbilityMetaData Mls1, useSpecific Amls).
    // With no case at all Luffy's 고무고무 바람개비 fell through to the damage
    // fallback and spent its per-second figure as a single hit -- 300 where the
    // map wrote 300 a second for twenty seconds.
    //
    // The buff CODE is deliberately not stamped: abuf lists two (Bmlc, Bmlt)
    // and nothing in the data says which of them rides the target rather than
    // the caster.  The map's script removes Bmlt from the shackled unit itself,
    // so nothing here is gated on it.
    case 'Amls': {
      const t = o.target;
      if (!t) return { ok: false, reason: 'need target' };
      const secs = (t.isHero ? i.heroDuration : i.duration) || i.duration
                || i.heroDuration || 0;
      if (secs <= 0.1) return { ok: true };
      const buff = { kind: 'slow', pct: 1, until: w.now + secs * 1000 };
      w.applyBuff(t, buff);
      const dot = slot(d1, 0) > 0 ? w.dotUnit(caster, t, d1, secs, 1) : null;
      // The caster channels for as long as the target is held: the cast
      // timeline keeps it there, and lets go -- buff and burn with it -- when
      // the caster is interrupted, the target dies, or the map strips the buff.
      return { ok: true, hold: { target: t, buff, dot, until: w.now + secs * 1000 } };
    }
    case 'ANsi': case 'ACsi': {
      let n = 0;
      for (const e of affected(tx, ty, area || 300)) {
        if (dur <= 0.1) break;
        w.applyBuff(e, { kind: 'silence', code: i.buff || null, until: w.now + dur * 1000 });
        n++;
      }
      return { ok: true, silenced: n };
    }
    case 'ANsl': case 'AUsl': case 'ACsw': {
      for (const e of affected(tx, ty, area || 250))
        w.applyBuff(e, { kind: 'slow', pct: slot(d1, 30) / 100, code: i.buff || null,
                        until: w.now + Math.max(4, dur) * 1000 });
      return { ok: true };
    }
    default: {
      if (isPassive(ab)) return { ok: false, reason: 'passive' };
      // An ability naming a unit type is a summon, and its own data says what
      // and how many -- no case needed per summoning spell.
      if (i.unit) {
        return summonFrom(w, caster, i, tx, ty, dur,
                          SUMMON_COUNT_BASES.has(B) ? slot(d1, 1) : undefined);
      }
      // Data-driven fallback: an active ability with a damage value hits what it
      // targets; area if it has one, otherwise the single target.
      if (d1 > 0) {
        if (area > 0) { for (const e of affected(tx, ty, area)) w.damage(caster, e, d1, damageOptions); return { ok: true }; }
        if (o.target && w.hostile(caster, o.target)) { w.damage(caster, o.target, d1, damageOptions); return { ok: true }; }
      }
      return { ok: false, reason: 'no engine behaviour for ' + B };
    }
  }
}

/**
 * Passive bonuses an item ability grants while carried. Field meanings come from
 * the ability's own data (AbilityData.slk + the map's w3a overrides).
 */
// The passive bonus each item ability grants, keyed by the Blizzard ability it
// derives from.  Warcraft III keeps attribute values in fixed data slots across
// the whole family -- agility in DataA, intelligence in DataB, strength in DataC
// -- so these all read the same way; single-purpose bonuses put their value in
// DataA.  Names are Blizzard's own (`comments` in AbilityData.slk), which is
// what settles cases like AIs1: it is StrengthBonus (+1), not an attack-speed
// item, and reading it as one gave the wrong stat entirely.
const ATTR = (d) => ({ agi: d.data1 || 0, intel: d.data2 || 0, str: d.data3 || 0 });
const ITEM_BONUS = {
  // strength
  AIs1: ATTR, AIs3: ATTR, AIs4: ATTR, AIs6: ATTR, AIsm: ATTR, AInm: ATTR,
  // agility
  AIa1: ATTR, AIa3: ATTR, AIa4: ATTR, AIa6: ATTR, AIam: ATTR, AIgm: ATTR,
  // intelligence
  AIim: ATTR,
  // every attribute at once
  AIx5: ATTR, AIxm: ATTR,
  // attack and defence
  AItx: (d) => ({ damage: d.data1 }),
  AId0: (d) => ({ armor: d.data1 }), AId1: (d) => ({ armor: d.data1 }),
  AId3: (d) => ({ armor: d.data1 }), Ansk: (d) => ({ armor: d.data3 }),
  // life, mana and regeneration
  AIl1: (d) => ({ maxHp: d.data1 }), AIl2: (d) => ({ maxHp: d.data1 }),
  AImz: (d) => ({ maxMana: d.data1 }),
  Arel: (d) => ({ hpReg: d.data1 }), AIrm: (d) => ({ manaReg: d.data1 }),
  // speed
  AIsx: (d) => ({ attackSpeed: d.data1 }), AIs2: (d) => ({ attackSpeed: d.data1 }),
  AIms: (d) => ({ moveSpeed: d.data1 }),
  // on-hit effects
  SCva: (d) => ({ lifesteal: d.data1 }),
  AIcf: (d) => ({ flames: d.data1 }),
  ACce: (d) => ({ cleave: d.data1 }),
  // the experience tomes are consumed rather than carried, so they grant their
  // experience through itemUse -- they are not a passive bonus
};

/** Sum every passive bonus from the items a unit carries. */
export function itemBonuses(items) {
  const out = { damage: 0, armor: 0, str: 0, agi: 0, intel: 0, maxHp: 0, maxMana: 0,
                hpReg: 0, manaReg: 0, attackSpeed: 0, lifesteal: 0, flames: 0, cleave: 0,
                moveSpeed: 0, xpMul: 0 };
  for (const it of items || []) {
    for (const aid of it.abilities || []) {
      const ab = ABILS[aid];
      if (!ab) continue;
      const fn = ITEM_BONUS[ab.base];
      if (!fn) continue;
      const d = levelInfo(ab, 1);
      const b = fn(d) || {};
      for (const k of Object.keys(out)) if (typeof b[k] === 'number') out[k] += b[k];
    }
  }
  return out;
}

/** Consumables: what using this item does, straight from its ability data. */
export function itemUse(it) {
  for (const aid of it.abilities || []) {
    const ab = ABILS[aid];
    if (!ab) continue;
    const d = levelInfo(ab, 1);
    if (ab.base === 'AIh1' || ab.base === 'AIh2' || ab.base === 'AIhx')
      return { kind: 'heal', amount: d.data1 || 0 };
    if (ab.base === 'AIe2' || ab.base === 'AIem' || ab.base === 'AIxp')
      return { kind: 'xp', amount: d.data1 || 0 };
    if (ab.base === 'AIma' || ab.base === 'AImz')
      return { kind: 'mana', amount: d.data1 || 0 };
  }
  return null;
}

/** Aura contributions a unit receives from nearby allies. */
/**
 * Attribute bonuses a hero carries from its own passive skills.
 *
 * Attribute Bonus (`Aamk`) is a skill you learn, not one you cast, and its
 * value sits in the same three data slots the stat tomes use -- agility in
 * DataA, intelligence in DataB, strength in DataC.  It was being treated as a
 * castable spell, which meant the +50 it grants was thrown at whatever the hero
 * was pointing at as 50 damage, and no hero ever got the stats.
 */
// Which ability bases may carry an attribute bonus is not a judgement call:
// AbilityMetaData.slk lists it, on the useSpecific column of the Iagi, Istr and
// Iint fields, and these twenty-four are what it names. We knew one of them, so
// every transformation built on AIx2 granted nothing -- Goku's three Super
// Saiyan forms are +50, +100 and +150 to all three attributes and gave none of
// it.
//
// Guessing from the data instead of from this list is the trap. Reading "any
// ability whose data1 is positive" picks up AInv, whose data1 is how many
// inventory slots it opens, and AIcf, where it is a damage figure.
const ATTR_SKILLS = new Set([
  'Aamk', 'AIab', 'AIa1', 'AIa3', 'AIa4', 'AIa6', 'AIx5', 'AIx1', 'AIx2',
  'AIs1', 'AIs3', 'AIs4', 'AIs6', 'AIi1', 'AIi3', 'AIi4', 'AIi6',
  'AIxm', 'AIam', 'AIim', 'AIsm', 'AIgm', 'AItm', 'AInm',
]);

export function abilityBonuses(w, u) {
  const out = { agi: 0, intel: 0, str: 0 };
  if (!u || !u.abilities) return out;
  for (const [key, lvl] of u.abilities) {
    if (lvl < 1) continue;
    const ab = ABILS[w.abilKey(key)];
    if (!ab || !ATTR_SKILLS.has(baseOf(ab))) continue;
    const d = levelInfo(ab, lvl);
    out.agi += d.data1 || 0;
    out.intel += d.data2 || 0;
    out.str += d.data3 || 0;
  }
  return out;
}

/**
 * The burn a unit carries as an ABILITY rather than as an item.
 *
 * AIcf (Cloak of Flames) is passive -- it has no order string and is never
 * cast -- but it is not silent: Icfd is "Damage Per Duration" (AbilityMetaData,
 * useSpecific AIcf) over the ability's own duration, inside its own area.  The
 * same base already reaches the game through ITEM_BONUS when it is carried on
 * an item, and this is the other half: Eneru's Thunder God form (O003) holds
 * A020 as a unit ability, 500 damage per 1.0 s in a 200 radius, and the form
 * burned nobody because only items were ever consulted.
 */
export function carriedImmolation(w, u) {
  if (!u) return null;
  const burn = (key, lvl) => {
    if (lvl < 1) return null;
    const ab = ABILS[w.abilKey(key)];
    if (!ab || baseOf(ab) !== 'AIcf') return null;
    const d = levelInfo(ab, lvl);
    const secs = d.duration || d.heroDuration || 1;
    const dps = (d.data1 || 0) / (secs > 0 ? secs : 1);
    return dps > 0 ? { dps, area: d.area || 200, ab, lvl } : null;
  };
  for (const [key, lvl] of u.abilities || []) {
    const effect = burn(key, lvl);
    if (effect) return effect;
  }
  // Preserve the existing item damage sum, but keep each item's radius and
  // target restrictions instead of replacing them with a fixed 200 radius.
  const sources = [];
  for (const item of u.items || []) for (const key of item.abilities || []) {
    const effect = burn(key, 1);
    if (effect) sources.push(effect);
  }
  return sources.length ? { sources, dps: sources.reduce((n, e) => n + e.dps, 0),
    area: Math.max(...sources.map(e => e.area)) } : null;
}

/**
 * What a unit's own abilities do to an ordinary attack it makes or takes.
 *
 * ACct (Critical Strike), ANdb (Drunken Brawler) and AOcr (Blade Master) share
 * one field set -- AbilityMetaData's useSpecific column lists exactly those
 * three against Ocr1..Ocr5, and WorldEditStrings names them:
 *
 *   Ocr1  data1   Chance to Critical Strike   percent, minVal 0 maxVal 100
 *   Ocr2  data2   Damage Multiplier
 *   Ocr3  data3   Damage Bonus                zero on every ability in this map
 *   Ocr4  data4   Chance to Evade             fraction, minVal 0 maxVal 1
 *
 * The two ranges are what settle the units without guessing: a chance out of
 * 100 on one line and out of 1 on the next.  The author's own tooltips agree
 * -- A02W level 1 reads "피할확률 7% / 치명타확률 5% / 치명타 배수 1.25배"
 * against data4 0.07, data1 5, data2 1.25.
 *
 * This is read at attack time rather than stashed by recalc, because recalc
 * returns early on anything that is not a hero and every carrier here except
 * Itachi and Shiki is a summon.
 *
 * A051 블러디 어택 needs no special case: the map zeroed its Ocr1 because it
 * runs that proc itself in war3map.j on EVENT_PLAYER_UNIT_ATTACKED, and a
 * chance of 0 never fires.
 */
const PROC_BASES = new Set(['ACct', 'ANdb', 'AOcr']);

/**
 * Bash: a chance on attack to multiply the damage and stun what was hit.
 *
 * AbilityMetaData gives Cbh1..Cbh5 to exactly AHbh and ACbh, and
 * WorldEditStrings reads them "Chance to Bash", "Damage Multiplier", "Damage
 * Bonus", "Chance to Miss" and "Never Miss". The stun's length is the ability's
 * own duration, which is where Warcraft III keeps it and where this map writes
 * 1 to 3 seconds across Sandaime's five ranks.
 *
 * Cbh4 "Chance to Miss" is a penalty the bash imposes on the unit it stunned
 * and is not read here: all five of this map's ranks carry 0, so there is
 * nothing to spend and nothing to guess at.
 */
const BASH_BASES = new Set(['AHbh', 'ACbh']);

/**
 * The plain evasion family, which keeps its chance in a different slot.
 * AbilityMetaData gives Eev1 to exactly AEev, AIev, ACev and ACes, and
 * WorldEditStrings reads it "Chance to Evade" -- the same label as Ocr4, one
 * field earlier.  Its declared range is 0..10 rather than 0..1, so the range
 * alone does not settle the unit; the map's own tooltip does.  A01W 맨트라
 * carries Eev1 0.25 and its ubertip reads "적의 생각을 읽고 공격을 피합니다.
 * ◎피할 확률 25%", so it is a fraction here, matching Ocr4 rather than the
 * range's upper bound.
 */
const EVADE_BASES = new Set(['AEev', 'AIev', 'ACev', 'ACes']);

export function attackProcs(w, u) {
  const out = { chance: 0, mult: 1, bonus: 0, evade: 0, bash: null };
  if (!u || !u.abilities) return out;
  for (const [key, lvl] of u.abilities) {
    if (lvl < 1) continue;
    const ab = ABILS[w.abilKey(key)];
    if (!ab) continue;
    if (BASH_BASES.has(baseOf(ab))) {
      const d = levelInfo(ab, lvl);
      const chance = d.data1 || 0;
      if (chance > 0 && (!out.bash || chance > out.bash.chance)) {
        out.bash = { chance, mult: d.data2 || 1, bonus: d.data3 || 0,
                     stun: d.heroDuration || d.duration || 0 };
      }
      continue;
    }
    if (EVADE_BASES.has(baseOf(ab))) {
      out.evade = Math.max(out.evade, levelInfo(ab, lvl).data1 || 0);
      continue;
    }
    if (!PROC_BASES.has(baseOf(ab))) continue;
    const d = levelInfo(ab, lvl);
    // several of these on one unit is not a case this map produces; taking the
    // strongest is a choice, and the alternative -- rolling each -- would be
    // inventing a stacking rule the data does not state
    if ((d.data1 || 0) > out.chance) { out.chance = d.data1 || 0; out.mult = d.data2 || 1; }
    out.bonus += d.data3 || 0;
    out.evade = Math.max(out.evade, d.data4 || 0);
  }
  return out;
}

// AbilityData.slk's code column identifies item/creep aliases.
const STAT_AURA_FAMILY = {
  AHad: 'armor', ACav: 'armor', AIad: 'armor',
  AHab: 'mana', ACba: 'mana', AIba: 'mana',
  AOae: 'endurance', AOr2: 'endurance', SCae: 'endurance', AIae: 'endurance',
  AUau: 'unholy', ACua: 'unholy', AIau: 'unholy',
};

export function auraSources(w) {
  const out = [];
  for (const source of w.allUnits()) {
    if (!source.alive || source.hidden || source.pickerProp) continue;
    const abilities = [...(source.abilities || [])];
    for (const item of source.items || []) for (const key of item.abilities || []) abilities.push([key, 1]);
    for (const [key, lvl] of abilities) {
      const ab = ABILS[w.abilKey(key)], family = ab && STAT_AURA_FAMILY[ab.base];
      if (!family || lvl < 1) continue;
      out.push({ source, ab, lvl, family, info: levelInfo(ab, lvl) });
    }
  }
  return out;
}

export function auraEffects(w, u, sources = auraSources(w)) {
  const families = new Map();
  for (const { source, ab, lvl, family, info: d } of sources) {
    if (!u.alive || Math.hypot(source.x - u.x, source.y - u.y) > (d.area || 0)) continue;
    if (!w.validSpellTarget(source, u, ab, lvl)) continue;
    let effect;
    // Percentage armor/regen variants require separate formula verification.
    if (family === 'armor') effect = d.data2 ? {} : { armorTotal: d.data1 || 0 };
    if (family === 'mana') effect = d.data2 ? {} : { manaReg: d.data1 || 0 };
    if (family === 'endurance') effect = { movePct: d.data1 || 0, attackSpeedMul: d.data2 || 0 };
    if (family === 'unholy') effect = { movePct: d.data1 || 0, hpReg: d.data3 ? 0 : d.data2 || 0 };
    const best = families.get(family) || {};
    for (const [stat, value] of Object.entries(effect))
      if (!(stat in best) || value > best[stat]) best[stat] = value;
    families.set(family, best);
  }
  const out = {};
  for (const effect of families.values()) for (const [stat, value] of Object.entries(effect))
    out[stat] = (out[stat] || 0) + value;
  return out;
}
