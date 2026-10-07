// Two heroes to put in a room together, chosen from the map's own table.
//
// Five tests -- sound, spell, match, wincond, victory -- named 'H004' and
// 'E00T' with the comments "Saber" and "Goku". Neither id is in this map's 26.
// They died during setup before reaching anything they claimed to test, and
// were skipped from the suite rather than fixed, which cost the port its whole
// end-to-end half for as long as they sat there.
//
// So the pair is derived, not written down: the hero with the most learnable
// spells makes the caster, and the next distinct one the target, tie-broken by
// the order the map itself lists them in. A map change cannot silently do this
// again -- if the table were empty these throw, rather than resolving to
// something that does not exist.
//
// The players are 0 and 5. This map allies 0-3 (and 10) against 4-9 (and 11),
// so that pair is genuinely hostile; players 0 and 1 would be teammates and
// every spell would report a clean zero.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

export function testHeroes(game) {
  const G = game || JSON.parse(fs.readFileSync(path.join(ROOT, 'data/game.json'), 'utf8'));
  const ranked = [...G.heroes]
    .map((h, i) => ({ h, n: (h.learnable || []).length, i }))
    .sort((a, b) => (b.n - a.n) || (a.i - b.i));
  if (ranked.length < 2 || ranked[0].n === 0)
    throw new Error('data/game.json carries no hero with learnable abilities');
  return { caster: ranked[0].h, target: ranked[1].h, casterSlot: 0, targetSlot: 5 };
}

/** Buy both into opposing teams and hand back the units. */
export function seatTwo(world, eng, game) {
  const { caster, target, casterSlot, targetSlot } = testHeroes(game);
  const A = world.sellUnit(world.tavernFor(caster.id), eng.players[casterSlot], caster.id);
  const B = world.sellUnit(world.tavernFor(target.id), eng.players[targetSlot], target.id);
  return { A, B, heroA: caster, heroB: target };
}
