// Every hero's attributes, and what the engine derives from them.
//
// Warcraft III splits the derivations: life comes from strength, mana from
// intelligence and armour from agility for *every* hero, but attack damage comes
// from that hero's own primary attribute. This map leans on that hard -- it sets
// a base template granting +15 to every attribute per level and then overrides
// each hero on top, so a hero who never overrides the strength gain still
// carries +15 strength a level. Reading damage off strength rather than the
// primary attribute therefore does not misprice heroes slightly; it roughly
// doubles some of them.
//
//   node tools/hero_audit.mjs           the roster, with derived stats
//   node tools/hero_audit.mjs --all     every attribute of every hero
import fs from 'node:fs';
import { World } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';

const GAME = JSON.parse(fs.readFileSync('data/game.json', 'utf8'));
const TYPES = JSON.parse(fs.readFileSync('data/unittypes.json', 'utf8'));
const GP = JSON.parse(fs.readFileSync('data/gameplay.json', 'utf8'));
const full = process.argv.includes('--all');

const world = new World();
const eng = new JassEngine(world);
eng.load();
eng.boot();
for (let i = 0; i < 90; i++) { eng.update(1000 / 30); world.step(); }

const LEVELS = [1, Math.round(GP.maxHeroLevel / 2), GP.maxHeroLevel];
console.log(`gameplay constants: maxHeroLevel=${GP.maxHeroLevel} strHP=${GP.strHitPointBonus} ` +
            `intMana=${GP.intManaBonus} agiArmor=${GP.agiDefenseBonus} primaryAttack=${GP.strAttackBonus}`);
console.log(`XP table: ${GP.needHeroXP.length} entries, ` +
            `${GP.needHeroXP.every((v, i) => i === 0 || v >= GP.needHeroXP[i - 1]) ? 'monotonic' : 'NOT MONOTONIC'}` +
            `, level ${GP.maxHeroLevel} needs ${Math.round(GP.needHeroXP[GP.maxHeroLevel - 1])}`);
console.log();

const warn = [];
const head = ['hero', 'prim', 'str/lvl', 'agi/lvl', 'int/lvl', 'coll']
  .concat(LEVELS.flatMap((l) => [`dmg@${l}`, `hp@${l}`]));
console.log(head.map((h, i) => h.padEnd(i === 0 ? 20 : 10)).join(''));

for (const h of GAME.heroes) {
  const t = TYPES[h.id] || {};
  const u = world.sellUnit(null, eng.players[0], h.id);
  if (!u) { warn.push(`${h.name} (${h.id}): could not be created`); continue; }
  const row = [(h.name || h.id).slice(0, 19), String(t.primary || '??'),
               `${t.str_}/${t.strLvl}`, `${t.agi}/${t.agiLvl}`, `${t.int_}/${t.intLvl}`,
               String(t.collision)];
  for (const lv of LEVELS) {
    u.level = lv;
    world.recalc(u);
    row.push(String(Math.round(u.dmg)), String(Math.round(u.maxHp)));
  }
  console.log(row.map((c, i) => c.padEnd(i === 0 ? 20 : 10)).join(''));

  // things that are almost certainly a data or mapping fault rather than design
  const prim = String(t.primary || '').toUpperCase();
  if (!['STR', 'AGI', 'INT'].includes(prim)) warn.push(`${h.name}: no primary attribute (${t.primary})`);
  if (!(t.hp > 0)) warn.push(`${h.name}: no base life`);
  if ((t.collision || 0) < 8) warn.push(`${h.name}: collision ${t.collision} -- suspiciously small for a hero`);
  if (!(t.moveSpeed > 0)) warn.push(`${h.name}: move speed ${t.moveSpeed}`);
  // a gain the hero never overrode, inherited from the map's base template
  const gains = { STR: t.strLvl || 0, AGI: t.agiLvl || 0, INT: t.intLvl || 0 };
  const off = Object.entries(gains).filter(([k, v]) => k !== prim && v > gains[prim] * 2);
  if (off.length) {
    warn.push(`${h.name}: gains more ${off.map(([k]) => k).join('/')} than its primary ${prim} ` +
              `(${JSON.stringify(gains)}) -- inherited from the base template, not overridden`);
  }
  if (full) {
    for (const k of Object.keys(t).sort()) console.log(`      ${k.padEnd(20)} ${JSON.stringify(t[k])}`);
  }
  world.removeUnit(u);
}

console.log(`\n${warn.length} thing(s) worth a look:`);
for (const w of warn) console.log('  ! ' + w);
