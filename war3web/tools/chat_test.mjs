// The map's chat commands, and the text its protection destroyed.
//
// war3map.j reaches us with every byte above 127 replaced by an underscore --
// done to the map before we saw it, not by our extraction. The two commands the
// map registers survive as `-__` and `-____`, which a player can type but would
// never guess. server/chatalias.js recovers what they were from the map's own
// quest text and from what each trigger does; this asserts that a player typing
// the real command reaches the trigger.
//
//   node tools/chat_test.mjs        (no server needed)
import fs from 'node:fs';
import path from 'node:path';
import { World } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';
import { CHAT_ALIAS, chatFor } from '../server/chatalias.js';

const ROOT = path.resolve(import.meta.dirname, '..');
let pass = 0; const fails = [];
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fails.push(name); console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
};

const world = new World();
const eng = new JassEngine(world);
const seen = [];
eng.load(); eng.boot();
const tick = (s) => {
  for (let i = 0; i < Math.round(s * 30); i++) {
    eng.update(1000 / 30);
    const ev = world.step();
    if (ev && ev.length) seen.push(...ev);
  }
};
tick(2);

// ------------------------------------------------ what the map registered
console.log('\n-- the script registers two commands, both of them underscores');
{
  const src = fs.readFileSync(path.join(ROOT, 'extracted/war3map.j'), 'latin1');
  const lits = [...new Set([...src.matchAll(/"(-[^"]*)"/g)].map((m) => m[1]))];
  check('the script names exactly two chat commands', lits.length === 2, lits.join(' '));
  check('and both are runs of underscores', lits.every((l) => /^-_+$/.test(l)), lits.join(' '));
  // one underscore per CHARACTER, which is what identifies them: the quest text
  // lists one two-character command and three four-character ones
  check('the aliases point at the literals the script actually registered',
        [...CHAT_ALIAS.values()].every((v) => lits.includes(v)),
        [...CHAT_ALIAS.values()].join(' '));
  for (const [real, literal] of CHAT_ALIAS) {
    check(`${real} is ${literal.length - 1} characters, and its literal ${literal} is ${literal.length - 1} underscores`,
          [...real].length - 1 === literal.length - 1, `${[...real].length - 1} vs ${literal.length - 1}`);
  }
  // the map documents them itself, in a string table that kept its Korean
  const wts = fs.readFileSync(path.join(ROOT, 'extracted/war3map.wts'), 'utf8');
  for (const real of CHAT_ALIAS.keys()) {
    check(`${real} is a command the map's own quest text names`, wts.includes(real));
  }
}

// ------------------------------------------------- and typing one works
console.log('\n-- typing the real command reaches the map\'s trigger');
{
  const fire = (text) => {
    seen.length = 0;
    eng.clientEvents.length = 0;
    world.chat(eng.players[0], text);
    tick(0.3);
    return seen.length + eng.clientEvents.length;
  };
  for (const [real, literal] of CHAT_ALIAS) {
    check(`${real} fires something`, fire(real) > 0);
    check(`and so does ${literal}, for anyone who knows it`, fire(literal) > 0);
  }
  check('a line that is not a command fires nothing', fire('-not a command') === 0);
  check('chatFor leaves ordinary chat alone', chatFor('hello') === 'hello');
}

// ------------------------------- what is NOT recoverable, and why, measured
console.log('\n-- the display text is gone, and this is the measurement that says so');
{
  const src = fs.readFileSync(path.join(ROOT, 'extracted/war3map.j'), 'latin1');
  const wts = fs.readFileSync(path.join(ROOT, 'extracted/war3map.wts'), 'utf8');
  const table = [...wts.matchAll(/STRING (\d+)\s*\{([\s\S]*?)\n\}/g)].map((m) => m[2].trim());
  const skel = (t) => [...t].map((c) => (c.codePointAt(0) > 127 ? '_' : c)).join('');
  const mangled = [...new Set([...src.matchAll(/"([^"]*)"/g)].map((m) => m[1]))]
    .filter((l) => l.length && l.split('_').length - 1 > l.length * 0.3);
  let anyCandidate = 0, unique = 0;
  for (const l of mangled) {
    const cand = table.filter((t) => skel(t) === l);
    if (cand.length) anyCandidate++;
    if (cand.length === 1) unique++;
  }
  check('there are destroyed literals to try to recover', mangled.length > 10,
        `${mangled.length}`);
  // The string table kept its Korean, so matching a literal's skeleton against
  // it is the obvious recovery. It does not work: the table holds object data
  // and quest text, not the messages a trigger prints.
  console.log(`   ${mangled.length} destroyed literals, ${anyCandidate} with any same-shaped`
              + ` string in the table, ${unique} with exactly one`);
  check('and skeleton-matching the string table recovers none of them uniquely',
        unique === 0, `${unique} unique matches`);
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { for (const f of fails) console.log('  - ' + f); process.exit(1); }
