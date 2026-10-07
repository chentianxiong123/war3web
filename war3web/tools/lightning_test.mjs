// Does a spell that names a lightning type actually draw one?
//
// Chain lightning, mana burn, drain, forked lightning: Warcraft III draws the
// bolt itself from a row in Splats\LightningData.slk rather than playing a
// model. 37 of this map's abilities name a type and nine are hero spells, and
// the Lightningeffect field was read by nothing -- so a Rikujokoro landed its
// damage with nothing drawn between caster and target.
//
// This casts a hero ability that names a bolt and checks the whole chain: the
// server emits the event, the client builds a strip, the strip has geometry,
// it crackles rather than sitting still, and it clears itself when its Duration
// runs out.
//
//   node server/index.js &        # port 8077
//   node tools/lightning_test.mjs
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';
import { World, id2int } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';

const PORT = process.env.PORT || 8077;
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};

// ---- server half: does casting one emit the event?
const ABIL = JSON.parse(fs.readFileSync('data/abilities.json', 'utf8'));
const TYPES = JSON.parse(fs.readFileSync('data/unittypes.json', 'utf8'));
const withBolt = new Set(Object.keys(ABIL).filter((k) => {
  const a = ABIL[k].art;
  const v = a && a.lightning;
  return v && v !== '_' && v !== '-';
}));

const world = new World();
const eng = new JassEngine(world);
eng.load(); eng.boot();
for (let i = 0; i < 60; i++) { eng.update(1000 / 30); world.step(); }

// find any unit type that owns one of these, and give it a target
let caster = null, abilId = null;
for (const [uid, t] of Object.entries(TYPES)) {
  const owned = [...(t.abilities || []), ...(t.heroAbilities || [])].find((a) => withBolt.has(a));
  if (!owned) continue;
  const u = world.createUnit(eng.players[0], uid, 0, 0, 0);
  if (!u) continue;
  caster = u; abilId = owned; break;
}
const victim = caster ? world.createUnit(eng.players[5], 'nfoh', 150, 0, 0) : null;
let emitted = [];
if (caster && victim) {
  world.addAbility(caster, id2int(abilId));
  world.setAbilityLevel(caster, id2int(abilId), 1);
  caster.mana = caster.maxMana = 9999;
  // ability art is emitted by World, which keeps its own queue -- the engine's
  // is a different one and draining that instead finds nothing at all
  world.flushEvents();
  world.castAbility(caster, id2int(abilId), victim, victim.x, victim.y);
  // The bolt is drawn at the spell's EFFECT, which comes at the caster's cast
  // point rather than on the tick it was ordered. The queue is emptied every
  // tick on its way to the clients, so it is read from each step's own return
  // rather than after the fact -- stepping first and reading afterwards finds
  // nothing, which looks exactly like "the cast emitted no lightning".
  for (let i = 0; i < 30 && !emitted.length; i++) {
    eng.update(1000 / 30);
    emitted = world.step().filter((e) => e.t === 'lightning');
  }
}
console.log('abilities naming a bolt: %d', withBolt.size);
console.log('cast %s from %s -> %d lightning event(s)',
            abilId, caster?.typeKey, emitted.length);
if (emitted.length) console.log('  event:', JSON.stringify(emitted[0]));

check('abilities name a bolt type', withBolt.size > 0, `${withBolt.size}`);
check('casting one emits a lightning event', emitted.length > 0,
      emitted.length ? emitted[0].code : 'none emitted');

// ---- client half: does it become geometry that moves and then clears?
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
         '--disable-dev-shm-usage', '--disable-crash-reporter', '--disable-breakpad',
         '--no-first-run', `--user-data-dir=.tmp/chrome-lit-${process.pid}`],
  defaultViewport: { width: 520, height: 640 },
});
const page = await browser.newPage();
await page.setCacheEnabled(false);
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
await page.goto(`http://127.0.0.1:${PORT}/tools/modelview.html`,
                { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => window.ready === true, { timeout: 120000 });

const out = await page.evaluate(async (code) => {
  const view = window.view;
  view.boltTable = await fetch('/data/lightning.json').then((r) => r.json());
  const spec = view.boltTable[code] || view.boltTable.CLPB;
  view.spawnBolt({ code: spec === view.boltTable[code] ? code : 'CLPB',
                   x1: 0, y1: 0, x2: 900, y2: 300 });
  const b = view.bolts[0];
  if (!b) return { spawned: false, table: Object.keys(view.boltTable).length };
  const shots = [];
  for (let i = 0; i < 30; i++) {
    view.stepBolts(1 / 30);
    if (view.bolts[0]) {
      const p = view.bolts[0].geo.attributes.position.array;
      shots.push([...p.slice(0, 18)].map((x) => +x.toFixed(2)).join(','));
    }
  }
  const drawn = b.geo.drawRange.count;
  // and it must clear itself once its Duration runs out
  for (let i = 0; i < 30 * 6; i++) view.stepBolts(1 / 30);
  return { spawned: true, table: Object.keys(view.boltTable).length,
           indices: drawn, distinctShapes: new Set(shots).size,
           remaining: view.bolts.length, life: spec?.life };
}, emitted[0]?.code || 'CLPB');

console.log(JSON.stringify(out, null, 1));
check('the bolt table reached the client', out.table > 0, `${out.table} types`);
check('a bolt becomes geometry', out.spawned && out.indices > 0, `${out.indices} indices`);
check('it crackles rather than sitting still', out.distinctShapes > 1,
      `${out.distinctShapes} distinct shapes across 30 frames`);
check('it clears itself when its duration runs out', out.remaining === 0,
      `${out.remaining} left after ${out.life}s`);
check('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
await browser.close();
process.exit(passed === results.length ? 0 : 1);
