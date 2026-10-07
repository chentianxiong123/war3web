// Which abilities can be cast at all?
//
// isPassive decides whether execute() runs an ability or returns
// {ok:false,'passive'}, and it was returning on the order-string line before it
// reached the targets line below -- so an ability with no order string was
// passive by definition and the rest of the function was dead code.
//
// The order string is the wrong thing to decide on alone.  It comes from
// Order= in Blizzard's Units\*AbilityFunc.txt (tools/abilities.py), and
// Blizzard writes that line for only some abilities: Fire Bolt (Awfb), Finger
// of Death (ANfd), Cloak of Flames (AIcf) and Neutral Regen (ACnr) each carry
// an Art= line and no Order= at all.  462 of the 1046 abilities here have no
// order string.  The map settles it: A00H and A01G both have none and both
// raise EVENT_PLAYER_UNIT_SPELL_EFFECT in war3map.j, so they are plainly cast.
// Absence proves nothing; presence still proves it can be ordered.
//
// Six verdicts move as a result, and this file pins all six, because the
// dangerous half of the change is the abilities that must NOT move: Cloak of
// Flames and Neutral Regen have a damage figure and an area, and letting them
// reach the data-driven fallback would fire a 500-damage nuke where the map
// wants a burn and a 40-damage one across 800 units where it wants a heal.
//
//   node tools/passive_test.mjs        (no server needed)
import fs from 'node:fs';
import path from 'node:path';
import { ABILS, PASSIVE_BASES, isPassive, execute, levelInfo } from '../server/abilities.js';
import { World } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};

// ---------------------------------------------------------------- the data
// The claim the fix rests on, asserted against Blizzard's own files rather
// than repeated from a comment.
const func = fs.readdirSync(path.join(ROOT, 'war3_extracted/Units'))
  .filter((f) => f.endsWith('AbilityFunc.txt'))
  .map((f) => fs.readFileSync(path.join(ROOT, 'war3_extracted/Units', f), 'latin1'))
  .join('\n');
const section = (id) => {
  const m = func.match(new RegExp(`^\\[${id}\\]$([\\s\\S]*?)(?=^\\[|\\Z)`, 'm'));
  return m ? m[1] : '';
};
for (const id of ['Awfb', 'ANfd', 'AIcf', 'ACnr']) {
  const s = section(id);
  check(`${id} is in AbilityFunc with art and no order string`,
        !!s && /^Art=/m.test(s) && !/^Order(on)?=/mi.test(s),
        s ? (/^Order/mi.test(s) ? 'it has one' : 'Art only') : 'no section');
}
check('an ability that does declare one still reads it', /^Order=blizzard$/m.test(section('AHbz')),
      'AHbz -> blizzard');
const noOrder = Object.values(ABILS).filter((a) => !a.order).length;
check('most of the roster has no order string', noOrder > 400,
      `${noOrder} of ${Object.keys(ABILS).length}`);

// And where the map overrides the string, the map wins.  Exactly one ability
// here sets 'aord', and tools/abilities.py used to take the base's string for
// it -- naming an order the map does not use.  Nothing dispatches on the value
// yet, which is precisely why it would have gone unnoticed.
const w3a = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/war3map.w3a.json'), 'utf8'));
const overrides = [...(w3a.custom || []), ...(w3a.base || [])]
  .map((r) => [r.id, r.mods && r.mods['aord:0']]).filter(([, o]) => o);
check('the map overrides exactly one order string', overrides.length === 1,
      overrides.map(([id, o]) => `${id} -> ${o}`).join(', ') || 'none');
check('and the compiled table takes it over the base\'s',
      overrides.length > 0 && overrides.every(([id, o]) => ABILS[id] && ABILS[id].order === o),
      overrides.map(([id, o]) => `${id}: table says ${ABILS[id] && ABILS[id].order}, map says ${o}`).join(', '));

// The map casts two of them, which is what makes absence meaningless.
const mapj = fs.readFileSync(path.join(ROOT, 'extracted/war3map.j'), 'utf8');
check('the map casts abilities that have no order string',
      !ABILS.A00H.order && !ABILS.A01G.order &&
      mapj.includes("GetSpellAbilityId()=='A00H'") && mapj.includes("GetSpellAbilityId()=='A01G'"),
      'A00H and A01G both raise SPELL_EFFECT');

// ------------------------------------------------------------- the verdicts
// Pinned by id: a later edit that quietly disables more abilities fails here
// rather than in play.
const MOVED = ['AIrl', 'AIpr', 'A01G', 'A00H', 'A00V', 'A01O'];
const active = Object.entries(ABILS).filter(([, a]) => !isPassive(a)).map(([id]) => id);
const activeSet = new Set(active);
check('every ability that moved is now castable', MOVED.every((id) => activeSet.has(id)),
      MOVED.filter((id) => !activeSet.has(id)).join(' ') || 'all six');

// The ones that must not move, and why each is passive.
check('Cloak of Flames and Neutral Regen are named passive bases',
      PASSIVE_BASES.has('AIcf') && PASSIVE_BASES.has('ACnr'), 'AIcf, ACnr');
for (const [id, why] of [['A020', "Eneru's form, never named in war3map.j"],
                         ['A05Y', 'handed to an o007 dummy, never ordered'],
                         ['A002', 'sits on hatw and targets allies']])
  check(`${id} stays passive (${why})`, isPassive(ABILS[id]), ABILS[id].base);
check('an attribute bonus stays passive despite its order string',
      isPassive(ABILS.Aamk) && !!ABILS.Aamk.order, `order ${ABILS.Aamk.order}`);
const auraIds = Object.entries(ABILS).filter(([, a]) => a.base === 'AOae').map(([id]) => id);
check('every Endurance Aura on the map stays passive',
      auraIds.length > 0 && auraIds.every((id) => isPassive(ABILS[id])),
      `${auraIds.length} of them`);

// -------------------------------------------------------------- the damage
// The point of the whole change: Byakuya's 종경 백제검 is a 5000-damage Fire
// Bolt with no order string, no engine case and no trigger, so it was doing
// nothing at all.  Assert the target's health, not the predicate.
const world = new World();
const eng = new JassEngine(world);
eng.load(); eng.boot();
for (let i = 0; i < 30; i++) { eng.update(1000 / 30); world.step(); }

const A00V = ABILS.A00V;
check('it is a Fire Bolt with a real number on it',
      A00V.base === 'Awfb' && levelInfo(A00V, 1).data1 === 5000 && !A00V.order,
      `${A00V.base}, ${levelInfo(A00V, 1).data1} damage, no order string`);
check('and nothing else was ever going to run it',
      !mapj.includes("'A00V'") && !fs.readFileSync(path.join(ROOT, 'server/abilities.js'), 'utf8')
        .includes("case 'Awfb'"),
      'no trigger, no engine case');

const units = [...world.units.values()].filter((u) => u.alive);
const caster = units.find((u) => u.isHero);
const victim = units.find((u) => u.alive && u !== caster && world.hostile(caster, u));
check('there is someone to hit', !!caster && !!victim,
      victim ? `${victim.typeKey} at ${Math.round(victim.hp)} hp` : 'nobody hostile');
if (caster && victim) {
  victim.hp = victim.maxHp;
  const before = victim.hp;
  const r = execute(world, caster, A00V, 1, { target: victim, x: victim.x, y: victim.y });
  check('casting it is no longer refused as passive', r.ok === true, r.reason || 'ok');
  check('and the target actually loses health', victim.hp < before,
        `${Math.round(before)} -> ${Math.round(victim.hp)}`);
}

// The other half: a passive base reaching the fallback would be a nuke.  Fire
// the base regen at a full-health enemy and prove nothing was damaged.
const target2 = [...world.units.values()].find((u) => u.alive && u.hp === u.maxHp && u !== caster);
if (target2) {
  const before = target2.hp;
  const r = execute(world, caster, ABILS.A002, 1, { target: target2, x: target2.x, y: target2.y });
  check('a regen ability is refused rather than thrown as damage',
        r.ok === false && r.reason === 'passive' && target2.hp === before,
        `${r.reason}, ${Math.round(before)} -> ${Math.round(target2.hp)} hp`);
}

const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} checks passed`);
process.exit(bad ? 1 : 0);
