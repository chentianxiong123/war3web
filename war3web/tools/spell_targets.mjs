/**
 * Which target does each hero ability actually need?
 *
 * Warcraft III's ability tables carry no "unit target vs point target vs
 * instant" column -- 'targs1' is populated for instant and point abilities
 * alike -- so the honest source is the map's own trigger.  Cast every hero
 * ability once and record which target accessor its trigger reaches for:
 * GetSpellTargetUnit means it wants a unit, GetSpellTargetLoc/X/Y means a
 * point, neither means it fires where it stands.
 */
process.chdir(new URL('..', import.meta.url).pathname);
import fs from 'node:fs';
const { World, id2int } = await import('../server/world.js');
const { JassEngine } = await import('../server/jass/engine.js');
const { entry: abilEntry } = await import('../server/abilities.js');

const GAME = JSON.parse(fs.readFileSync('data/game.json', 'utf8'));
const w = new World(), e = new JassEngine(w);
e.load();

// Every read counts, the map's spell-wide triggers included: udg_trigger24's
// condition asks RectContainsLoc(base, GetSpellTargetLoc()) of every spell
// effect to keep seven blinks out of the bases, so nearly every spell here
// comes out "point". That is a safe superset -- a ground click carries the
// unit under it too -- and a unit read still outranks it. Attributing reads
// to the spell's own trigger alone was tried and turned 36 point spells
// (Rain of Fire, Inferno, Stampede, Blink, Shockwave among them) into "none",
// because their triggers read nothing and the point is the ENGINE's need,
// which no table in the data names. The base's own target kind is Blizzard
// engine knowledge; until it is written down, "point" is the honest default.
let touched = { unit: false, point: false };
for (const n of ['GetSpellTargetUnit']) {
  const f = e.vm.natives.get(n);
  e.vm.natives.set(n, function (...a) { touched.unit = true; return f.apply(this, a); });
}
for (const n of ['GetSpellTargetLoc', 'GetSpellTargetX', 'GetSpellTargetY']) {
  const f = e.vm.natives.get(n);
  if (f) e.vm.natives.set(n, function (...a) { touched.point = true; return f.apply(this, a); });
}
e.boot();
const tick = (s) => { for (let i = 0; i < Math.round(s * 30); i++) { e.update(1000 / 30); w.step(); } };
tick(2);

const modes = {};
const resting = new Set(e.threads);
for (const h of GAME.heroes) {
  const ids = (h.learnable && h.learnable.length) ? h.learnable
            : (h.abilities || []).map((a) => a.id);
  if (!ids.length) continue;
  let A;
  try { A = w.sellUnit(w.tavernFor(h.id), e.players[0], h.id); } catch { continue; }
  if (!A) continue;
  A.controlled = true; A.invulnerable = true; A.mana = A.maxMana = 999999;
  for (const aid of ids) {
    const k = id2int(aid);
    w.addAbility(A, k); w.setAbilityLevel(A, k, 1);
    // a live enemy in range, so a unit-target trigger has something to read
    const T = w.createUnit(e.players[6], 'hfoo', A.x + 120, A.y, 0);
    if (T) { T.maxHp = T.hp = 1e7; }
    touched = { unit: false, point: false };
    if (A.cooldowns) A.cooldowns.clear();
    A.mana = A.maxMana;
    try { w.castAbility(A, k, T, T ? T.x : A.x, T ? T.y : A.y); } catch {}
    // let waits inside the trigger resume -- and let the cast land at all: an
    // ability with a Casting Time fires its EFFECT trigger only after it
    const ct = Math.max(0, ...((abilEntry(aid) || {}).levels || []).map((l) => l.castTime || 0));
    tick(2.5 + ct);
    // Then drain the trigger's own sleeping threads before the next ability,
    // or a wait inside this spell's trigger wakes during the NEXT one's window
    // and reads the target on its behalf. Measured: twelve abilities changed
    // mode between two runs that differed only in timing. The map keeps a few
    // threads of its own asleep for good; those are the resting set, and the
    // wait is for everything else, capped so a runaway loop cannot stall it.
    for (let n = 0; n < 30 * 60 && e.threads.some((th) => !resting.has(th)); n++) tick(1 / 30);
    const mode = touched.unit ? 'unit' : touched.point ? 'point' : 'none';
    // a spell may read both; the unit is the stricter requirement
    modes[aid] = mode;
    if (T) T.alive = false;
  }
  A.alive = false;
}
fs.writeFileSync('data/spell_targets.json', JSON.stringify(modes, null, 1));
const c = {};
for (const v of Object.values(modes)) c[v] = (c[v] || 0) + 1;
console.log('hero abilities probed: ' + Object.keys(modes).length);
console.log('target modes: ' + JSON.stringify(c));
