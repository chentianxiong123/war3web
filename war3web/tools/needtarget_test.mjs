// A unit-target spell clicked at bare ground used to cost its cooldown.
//
// Warcraft III refuses the ORDER: the cursor will not take a ground click for a
// spell that needs a unit, so nothing is spent and the map's SPELL_EFFECT
// trigger never runs. Here the cast was accepted, walked its cast point,
// reached castEffect, spent the mana and started the cooldown, and only then
// did the case return 'need target' and do nothing -- silently, since the
// result is not read past that point.
//
// It was reachable because the target classifier calls almost everything
// 'point' (tools/spell_targets.mjs says so itself: one map-wide trigger reads
// GetSpellTargetLoc on every spell), so the client offered a ground click.
//
//   node tools/needtarget_test.mjs        (no server needed)
import fs from 'node:fs';
import path from 'node:path';
import { World } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';
import { NEEDS_UNIT_TARGET, needsUnitTarget, entry as abilEntry, baseOf } from '../server/abilities.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};

// ------------------------------------------- the list matches the source
// A case that grows a `!t` guard must be declared. Derive the truth from
// server/abilities.js and compare, so the list cannot quietly fall behind.
const SRC = fs.readFileSync(path.join(ROOT, 'server/abilities.js'), 'utf8');
const found = new Set();
const lines = SRC.split('\n');
for (let i = 0; i < lines.length; i++) {
  if (!/return \{ ok: false, reason: 'need target' \}/.test(lines[i])) continue;
  // walk back to the case labels that open this block
  for (let j = i - 1; j > i - 6 && j >= 0; j--) {
    const m = [...lines[j].matchAll(/case '([A-Za-z0-9]{4})':/g)].map((x) => x[1]);
    if (m.length) { m.forEach((b) => found.add(b)); break; }
  }
}
const missing = [...found].filter((b) => !NEEDS_UNIT_TARGET.has(b));
const extra = [...NEEDS_UNIT_TARGET].filter((b) => !found.has(b));
check('every case that refuses a targetless cast is declared', missing.length === 0, missing.join(',') || `${found.size} found`);
check('and nothing is declared that no case refuses', extra.length === 0, extra.join(',') || 'none');

// ------------------------------------------- the spells this reaches
const targets = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/spell_targets.json'), 'utf8'));
const game = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/game.json'), 'utf8'));
const hit = [];
for (const h of game.heroes) for (const a of (h.abilities || [])) {
  if (needsUnitTarget(abilEntry(a.id)) && targets[a.id] === 'point') hit.push(`${h.id}/${a.id}`);
}
check('hero spells the classifier mislabels as point', hit.length > 0, hit.join(' '));

// ------------------------------------------- the order is refused
const world = new World();
const eng = new JassEngine(world);
eng.load(); eng.boot();
const creep = [...world.units.values()].find((u) => u.alive && !u.isHero && !u.isBuilding && u.typeKey);
const caster = world.createUnit(eng.players[0], 'H00M', 0, 0, 0);   // Shiki: A05H is AHtb via ANsb
const victim = world.createUnit(eng.players[6], creep.typeKey, 200, 0, 0);
const int = (s) => s.split('').reduce((a, c) => (a << 8) | c.charCodeAt(0), 0) >>> 0;
const KEY = int('A05H');
world.addAbility(caster, KEY); world.setAbilityLevel(caster, KEY, 1);
caster.mana = caster.maxMana = 1000;
check('the ability needs a unit target', needsUnitTarget(abilEntry('A05H')), `base ${baseOf(abilEntry('A05H'))}`);

const manaBefore = caster.mana;
const r = world.castAbility(caster, KEY, null, 900, 900);           // bare ground
check('a ground click is refused outright', r.ok === false && /target/.test(r.reason || ''), JSON.stringify(r));
check('with a reason the room can show the player', typeof r.reason === 'string' && r.reason.length > 0, r.reason);
check('no mana was spent', caster.mana === manaBefore, `${manaBefore} -> ${caster.mana}`);
check('no cooldown was started', !((caster.cooldowns || new Map()).get(KEY) > world.now),
      String((caster.cooldowns || new Map()).get(KEY) || 0));
check('and the unit is not left casting', !caster.cast);

// the same spell on a real unit still works
const ok = world.castAbility(caster, KEY, victim, victim.x, victim.y);
check('the same cast on a unit is accepted', ok.ok === true, JSON.stringify(ok));
for (let i = 0; i < 120 && caster.cast; i++) world.step();
check('it reaches its effect and spends the cooldown',
      (caster.cooldowns.get(KEY) || 0) > world.now && caster.mana <= manaBefore);

// ------------------------------------------- and the client is told
// The layer that can fail is the hero card the client actually reads, so drive
// a real room and inspect it. Gaara's A05K is one of the four the classifier
// calls 'point' while its case demands a unit.
const { Room } = await import('../server/room.js');
const room = new Room('needtarget');
const ws = { readyState: 1, out: [], send(x) { this.out.push(JSON.parse(x)); } };
const p2 = room.join(ws, 'Gaara');
room.handle(p2, { t: 'pickHero', heroId: 'H023' });
room.handle(p2, { t: 'ready', ready: true });
clearInterval(room.loop); room.loop = null;
const card = [...ws.out].reverse().find((m) => m.t === 'hero');
const row = card && (card.h.abilities || []).find((a) => a && a.id === 'A05K');
check('the hero card carries the mislabelled spell', !!row, row ? row.id : 'not on the card');
check('the classifier still calls it point', targets['A05K'] === 'point', `"${targets['A05K']}"`);
check('but the client is told to demand a unit', row && row.targetMode === 'unit',
      row ? `targetMode "${row.targetMode}"` : 'no row');
clearTimeout(room.resetTimer);

const failed = results.filter((r2) => !r2.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
