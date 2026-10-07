// Does every ability on the command card have a button to draw?
//
// Fourteen did not, and the reason is worth keeping written down because it is
// the second time the same mistake was made in the same function.
//
// compile_game.py read the icon straight off the map's own overrides:
//
//     icon=find_icon(lvl_get(m, 'aart', 0))
//
// FOC sets `aart` on 173 abilities, so that covers most of them -- but an
// ability the map does not rename keeps Warcraft III's icon, which lives in
// Units\*AbilityFunc.txt as `Art=` and never appears in the map's mods at all.
// Eneru's 전광 is Blink, Buu's 분신술 is Mirror Image, Orochimaru's revive is
// Reincarnation; each had a perfectly good icon sitting in the archives and a
// blank button on screen. The comment three lines below that call described
// exactly this fix having already been made for the effect *models*, which is
// how the models came to be right while the icon was left behind.
//
// The fix has two halves and this checks both, because the first alone still
// left three blank: the ability table now carries `icon` as an art slot, so
// Blizzard's is there with the map's override on top -- and because
// extract_blizzard.py harvests every art slot in that table, the icons the map
// never mentions now get pulled out of the MPQs and converted too. They had
// never been extracted, so resolving the name was not enough to draw it.
//
//   node tools/icon_test.mjs        (no server needed)
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));

const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};

const GAME = read('data/game.json');
const ABILS = read('data/abilities.json');

// ------------------------------------------------- what the card actually shows
const card = [];
for (const h of GAME.heroes) for (const a of h.abilities || []) card.push({ h, a });
check('the roster puts abilities on the command card', card.length > 100,
      `${card.length} across ${GAME.heroes.length} heroes`);

const blank = card.filter(({ a }) => !a.icon);
check('every one of them names an icon', blank.length === 0,
      blank.length ? blank.map(({ h, a }) => `${h.name}/${a.id}`).join(', ') : `${card.length} of ${card.length}`);

// Naming one is not having one: the file has to have survived extraction and
// conversion, which is the half that was still broken after the table was fixed.
const missing = card.filter(({ a }) => a.icon &&
  !fs.existsSync(path.join(ROOT, 'public/assets', a.icon)));
check('and the file it names is staged and on disk', missing.length === 0,
      missing.length ? missing.slice(0, 4).map(({ a }) => `${a.id} -> ${a.icon}`).join(', ')
                     : `${card.length} files present`);

// ------------------------------------------------------- the fallback itself
// The point of the fix: an ability the map never renames still gets Warcraft
// III's own icon rather than nothing.
const noOverride = card.filter(({ a }) => {
  const e = ABILS[a.id];
  return e && e.art && e.art.icon && a.icon;
});
check('the ability table carries the icon as an art slot',
      Object.values(ABILS).filter((e) => e.art && e.art.icon).length > 500,
      `${Object.values(ABILS).filter((e) => e.art && e.art.icon).length} of ${Object.keys(ABILS).length} abilities`);

// The four that were blank for want of a fallback, named so a regression says
// which half broke rather than just "a number went down".
const WAS_BLANK = {
  A01U: 'BTNBlink',          // Eneru 전광
  AOmi: 'BTNMirrorImage',    // 마인부우 분신술
  A01K: 'PASBTNReincarnation', // Orochimaru's revive
  A027: 'BTNBlizzard',       // Gilgamesh 보구의 비
};
for (const [aid, want] of Object.entries(WAS_BLANK)) {
  const got = card.find(({ a }) => a.id === aid);
  check(`${aid} falls back to Warcraft III's ${want}`,
        !!got && new RegExp(want, 'i').test(got.a.icon || ''),
        got ? String(got.a.icon) : 'not on any command card');
}

// -------------------------------------------------- the map's own imported art
// Two abilities use art shipped inside the .w3x rather than a Blizzard button,
// and they are the ones a wrong lookup would quietly replace with a stock icon.
const imported = card.filter(({ a }) => /HeroBuu/i.test(a.icon || ''));
check('an ability with the map\'s own imported icon keeps it',
      imported.length > 0,
      imported.map(({ h, a }) => `${h.name}/${a.name} -> ${a.icon}`).join(', ') || 'none found');

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
process.exit(passed === results.length ? 0 : 1);
