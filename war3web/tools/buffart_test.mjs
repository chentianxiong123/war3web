// Does a buff draw the model Warcraft III hangs on the unit?
//
// A buff carries a Target Attachment model and the point it hangs from -- and
// `ftat` is a model *list*, one per point, which is how Thorny Shield hangs
// four shields. None of it had ever been drawn.
//
// Ichigo is the case worth testing: this map stamps B001 on him by casting
// Frost Armor off a dummy purely to name the buff, his attack trigger then
// tests for it, and B001 says DeathCoilMissile at "head". That mask is the
// visible half of his bug report.
//
// Two halves, because the failure can be in either: the server has to tell a
// client the unit has the buff at all, and the client has to hang the model off
// the right bone and take it down again.
//
//   FOC_DEBUG=1 PORT=8077 node server/index.js &
//   node tools/buffart_test.mjs
import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';
import { World } from '../server/world.js';
import { execute, entry } from '../server/abilities.js';
import fs from 'node:fs';

const PORT = process.env.PORT || 8077;
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};

const table = JSON.parse(fs.readFileSync('data/buffart.json', 'utf8'));
const B = 'B001';                                  // Ichigo's Hollow form
check('the buff table is compiled', Object.keys(table).length > 0,
      `${Object.keys(table).length} buffs with art`);
check(`${B} names a model and a point`,
      !!table[B]?.target?.length && !!table[B]?.points?.length,
      `${table[B]?.target?.join(', ')} at ${table[B]?.points?.join(', ')}`);
check('a multi-model buff kept its whole list',
      Object.values(table).some((a) => a.target.length > 1),
      `${Object.values(table).filter((a) => a.target.length > 1).length} buffs hang more than one`);

// ---------------------------------------------------------------- the server
const world = new World();
const hero = [...world.units.values()].find((u) => u.isHero)
          || world.createUnit(world.player?.(0) ?? 0, 'H00C', 0, 0, 0);
let snapBefore = null, snapAfter = null, snapCleared = null;
if (hero) {
  snapBefore = world.snapshot().ents.find((e) => e.i === hero.id);
  world.applyBuff(hero, { kind: 'armor', code: B, armor: 0, until: world.now + 60000 });
  snapAfter = world.snapshot().ents.find((e) => e.i === hero.id);
  hero.buffs = [];
  snapCleared = world.snapshot().ents.find((e) => e.i === hero.id);
}
check('a unit with no buff carries no buff field', !!snapBefore && snapBefore.b === undefined,
      snapBefore ? JSON.stringify(snapBefore.b) : 'no unit');
check('a buff with art reaches the snapshot',
      !!snapAfter && Array.isArray(snapAfter.b) && snapAfter.b.includes(B),
      snapAfter ? JSON.stringify(snapAfter.b) : 'no unit');
check('and leaves it when the buff goes', !!snapCleared && snapCleared.b === undefined,
      snapCleared ? JSON.stringify(snapCleared.b) : 'no unit');

// Through the ability rather than straight to applyBuff. This map stamps B001
// by casting Frost Armor off a dummy purely to name the buff, so if that path
// stops carrying the code the mask goes and nothing above would notice.
let viaCast = null;
if (hero) {
  hero.buffs = [];
  const ab = entry('A02R');                        // 호로화 -- the Hollow form
  if (ab) execute(world, hero, ab, 1, { target: hero });
  viaCast = (hero.buffs || []).map((b) => b.code).filter(Boolean);
}
check('casting the map\'s own transform stamps the buff by id',
      Array.isArray(viaCast) && viaCast.includes(B),
      viaCast ? `buffs on him: ${viaCast.join(', ') || '(none carried a code)'}` : 'no hero');

// ---------------------------------------------------------------- the client
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
         '--disable-dev-shm-usage', '--disable-crash-reporter', '--disable-breakpad',
         '--no-first-run', `--user-data-dir=.tmp/chrome-buffart-${process.pid}`],
  defaultViewport: { width: 520, height: 520 },
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
await page.goto(`http://127.0.0.1:${PORT}/tools/modelview.html`,
                { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => window.ready === true, { timeout: 120000 });

const out = await page.evaluate(async ({ code, table }) => {
  const view = window.view;
  await window.showUnit('ichigo3', 0, 1, 'H00C');
  const v = [...view.views.values()][0];
  if (!v) return { error: 'no view' };
  const id = [...view.views.keys()][0];
  const before = view.effects.size;

  view.syncBuffArt(id, [code], table);
  for (let i = 0; i < 60 && view.effects.size === before; i++)
    await new Promise((r) => setTimeout(r, 100));
  const attached = view.effects.size - before;
  // which node did it land on, and is that node the head rather than the root?
  let parentName = null, isRoot = null, depth = 0;
  for (const [fx, e] of view.effects) {
    if (!String(fx).startsWith('buff:')) continue;
    parentName = e.parent?.name || '(unnamed)';
    isRoot = e.parent === v.root;
    for (let o = e.parent; o; o = o.parent) depth++;
  }
  view.syncBuffArt(id, [], table);
  await new Promise((r) => setTimeout(r, 200));
  const afterRemove = [...view.effects.keys()].filter((k) => String(k).startsWith('buff:')).length;
  return { attached, parentName, isRoot, depth, afterRemove };
}, { code: B, table });

console.log(JSON.stringify(out, null, 1));
if (out.error) { console.log('ABORT ' + out.error); await browser.close(); process.exit(1); }

check('the buff hangs a model on the unit', out.attached > 0, `${out.attached} effect(s)`);
check('and hangs it off the named bone, not the root',
      out.isRoot === false && /head/i.test(out.parentName || ''),
      `parent = ${out.parentName}`);
check('losing the buff takes the model down', out.afterRemove === 0,
      `${out.afterRemove} left attached`);
check('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
await browser.close();
process.exit(passed === results.length ? 0 : 1);
