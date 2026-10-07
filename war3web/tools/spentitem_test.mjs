// A spent item still worked, for ever.
//
// `uses` is the map's own count -- a Potion of Greater Healing says 1 -- and an
// item's charges are seeded from it. But useItem applied the effect BEFORE
// spending a charge, and never refused an item already at zero. So a potion
// healed its full amount on every use no matter how many it had left.
//
// It compounds: spending the last charge DROPS the item rather than destroying
// it, so the empty potion lay on the ground to be picked up and drunk again.
// Whether an exhausted item should be destroyed is NOT settled by the archives
// -- 'perishable' appears in WorldEditStrings only as a label, with no
// statement of what it does -- so that half is left alone and recorded.
//
//   node tools/spentitem_test.mjs        (no server needed)
import fs from 'node:fs';
import path from 'node:path';
import { World } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};
const items = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/itemtypes.json'), 'utf8'));

// the map's own numbers
check('the map gives a greater healing potion exactly one use',
      items.pghe && items.pghe.uses === 1, `uses ${items.pghe?.uses}`);
const limited = Object.values(items).filter((v) => (v.uses || 0) > 0).length;
const unlimited = Object.values(items).filter((v) => !(v.uses || 0)).length;
check('and the table has both limited and unlimited items', limited > 0 && unlimited > 0,
      `${limited} with uses, ${unlimited} without`);

const world = new World();
const eng = new JassEngine(world);
eng.load(); eng.boot();
const hero = [...world.units.values()].find((u) => u.isHero && u.alive)
          || world.createUnit(eng.players[0], 'H00M', 0, 0, 0);

// -------------------------------------------------- a one-use potion
const potion = { typeKey: 'pghe', name: 'Potion of Greater Healing', charges: 1, abilities: ['AIh2'] };
hero.items = [potion];
hero.maxHp = Math.max(hero.maxHp, 5000);
hero.hp = 1;
check('the first use heals', world.useItem(hero, potion, null) === true && hero.hp > 1,
      `hp ${hero.hp.toFixed(0)}`);
check('and spends the charge', potion.charges === 0);
check('and takes it out of the inventory', !hero.items.includes(potion));

// the map's own bug made this the exploit: pick the empty potion back up
hero.items.push(potion);
hero.hp = 1;
const again = world.useItem(hero, potion, null);
check('using it again is refused', again === false);
check('and heals nothing', hero.hp === 1, `hp ${hero.hp.toFixed(0)}`);

// -------------------------------------------------- an unlimited item
// An item whose type declares no uses is not a consumable: charges 0 means "no
// limit" here, not "spent", so it must keep working.
const permId = Object.keys(items).find((k) => !(items[k].uses || 0) && (items[k].abilities || []).length);
const perm = { typeKey: permId, name: items[permId].name, charges: 0,
               abilities: items[permId].abilities };
hero.items = [perm];
check('an item type with no uses exists to test', !!permId, `${permId} ${items[permId]?.name}`);
check('and using it is not refused', world.useItem(hero, perm, null) === true);
check('twice', world.useItem(hero, perm, null) === true);

// -------------------------------------------------- the open question
const wes = fs.readFileSync(path.join(ROOT, 'war3_extracted/UI/WorldEditStrings.txt'), 'latin1');
const label = /WESTRING_UEVAL_IPER=(.*)/.exec(wes);
check('the archives name "perishable" but never say what it does',
      !!label && /perishable/i.test(label[1]) && !/destroy|remove|charge/i.test(label[1]),
      `"${label?.[1].trim()}" -- so destroy-on-exhaustion stays unimplemented`);

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
