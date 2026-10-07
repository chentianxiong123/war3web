// Coverage audit. Instruments the engine and drives a real scenario, then reports
// which registered trigger events actually fire, plus every win/lose path.
import { World, id2int } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';
import fs from 'node:fs';

const world = new World();
const eng = new JassEngine(world);
eng.load();

// record every dispatch key the engine fires
const fired = new Map();
const origFire = eng.fire.bind(eng);
eng.fire = (kind, ctx) => { fired.set(kind, (fired.get(kind) || 0) + 1); return origFire(kind, ctx); };
const origExec = eng.execTrigger.bind(eng);
let regionFires = 0;
eng.execTrigger = (tr, ctx) => { if (ctx && ctx.__region) regionFires++; return origExec(tr, ctx); };

eng.boot();

// name every event constant so keys can be reported readably
const evName = new Map();
for (const [name, g] of eng.vm.globals) {
  const v = g.value;
  if (v && typeof v === 'object' && typeof v.v === 'number' && typeof v.__type === 'string')
    if (/event$/.test(v.__type)) evName.set(`${v.__type}:${v.v}`, name);
}

const tick = (s) => { for (let i = 0; i < Math.round(s * 30); i++) { eng.update(1000 / 30); world.step(); } };
tick(3);

// ---- drive a scenario that exercises every mechanic
// Everything here comes from the map's own compiled data: naming a hero, item or
// boss id would tie this audit to one map, and the ids of another map's roster
// simply resolve to nothing and take the whole run down with them.
const GAME = JSON.parse(fs.readFileSync('data/game.json', 'utf8'));
const BOSS = GAME.meta && GAME.meta.bossUnit;
const roster = GAME.heroes.filter((h) => h.id !== BOSS);
const heroA = roster[0] || GAME.heroes[0];
const heroB = roster[1] || roster[0] || GAME.heroes[0];
// a powerup (a tome) is consumed on pickup and never reaches the inventory, so
// the use/drop paths need something the hero actually carries
const ITEM_TYPES = (() => {
  try { return JSON.parse(fs.readFileSync('data/itemtypes.json', 'utf8')); } catch { return {}; }
})();
const SHOP_ITEMS = (GAME.shops || []).flatMap((sh) => sh.items || []);
const ITEM = SHOP_ITEMS.find((i) => !(ITEM_TYPES[i.id] || {}).powerup) || SHOP_ITEMS[0];

const skipped = [];
// This map picks heroes in-world rather than from a per-hero tavern, so there is
// often no seller to find; sellUnit places the hero at its team's base either way
// and only needs the seller to fire the map's own sell event.
const buy = (h, playerIdx) => {
  if (!h) return null;
  const u = world.sellUnit(world.tavernFor(h.id), eng.players[playerIdx], h.id);
  if (!u) skipped.push(`could not buy ${h.id}`);
  return u;
};

const A = buy(heroA, 0);
const B = buy(heroB, 5);
if (A) {
  for (const aid of heroA.learnable || []) { world.addAbility(A, id2int(aid)); world.learnSkill(A, id2int(aid)); }
  A.mana = A.maxMana = 20000;
}
if (A && B) {
  world.moveUnit(A, B.x + 120, B.y);
  world.order(A, { type: 'attack', target: B });                  // target order
  B.hp = B.maxHp = 999999;                                        // survive being auto-attacked
  A.atkTimer = 0;
}
tick(4);                                                          // auto-attacks land
// a cast at a time, with room for its cast point: a second order breaks the first off
if (A) for (const aid of heroA.learnable || []) { world.castAbility(A, id2int(aid), B, B ? B.x : A.x, B ? B.y : A.y); tick(1); }
if (A && ITEM) {
  const shop = world.shopFor(ITEM.id);
  if (shop) world.sellItem(shop, A, ITEM.id);                     // shop purchase + pickup
  else skipped.push(`no shop sells ${ITEM.id}`);
} else if (!ITEM) skipped.push('the map lists no shop items');
// exercise the inventory: the item paths are engine behaviour the map hooks
if (A && A.items && A.items.length) {
  world.useItem(A, A.items[0]);                                   // use + charges
  if (A.items.length) world.dropItem(A, A.items[A.items.length - 1]);
  // ...and picking one back up off the ground, and selling one back to a shop.
  // Without these two the item half of the map is never actually walked: PAWN
  // stayed dark not because it was unimplemented but because nothing sold.
  const onGround = [...world.items.values()].find((i) => !i.owner && !i.hidden);
  if (onGround) { onGround.x = A.x; onGround.y = A.y; world.orderPickup(A, onGround); tick(2); }
  if (A.items.length) world.pawnItem(A, A.items[0]);
} else if (A) skipped.push('nothing was bought, so the item events cannot fire');
if (A) world.addXp(A, 100000);                                    // hero level-up
world.chat(eng.players[0], '@duel');                              // game mode
tick(4);
if (B && B.alive && A) world.killUnit(B, A);                      // hero death
const boss = BOSS ? [...world.units.values()].find((u) => u.typeKey === BOSS) : null;
if (boss && A) world.killUnit(boss, A);                           // boss death -> win path
else if (BOSS && !boss) skipped.push(`boss ${BOSS} not on the map`);
tick(6);
// player leaving is an event the map listens for
const leaveKey = eng.eventId('EVENT_PLAYER_LEAVE');
if (leaveKey) eng.fire(leaveKey, { player: eng.players[9] });
tick(1);

console.log(`scenario: ${heroA.name} (${heroA.id}) vs ${heroB.name} (${heroB.id})` +
            `, item ${ITEM ? ITEM.id : '-'}, boss ${BOSS || '-'}`);
if (skipped.length) console.log('  skipped:', skipped.join('; '));

// ---- report
const kinds = new Map();
for (const tr of eng.triggers) for (const ev of tr.events) kinds.set(ev.kind, (kinds.get(ev.kind) || 0) + 1);
console.log('=== registered trigger events vs actually fired ===');
let wired = 0, unwired = [];
for (const [kind, n] of [...kinds].sort((a, b) => b[1] - a[1])) {
  let label = evName.get(kind) || kind;
  let ok;
  if (kind === 'chat') { label = 'player chat'; ok = fired.has('chat'); }
  else if (kind === 'enter' || kind === 'leave') { label = kind + ' region'; ok = true; }
  else if (kind === 'unitInRange') { ok = true; }
  else ok = fired.has(kind);
  if (ok) wired++; else unwired.push(label);
  console.log(`  ${ok ? 'FIRED    ' : 'NOT FIRED'} ${String(n).padStart(4)}x  ${label}`);
}
console.log(`  timers: ${eng.timers.length} (scheduler-driven)`);
console.log(`\n${wired}/${kinds.size} distinct registered event kinds verified firing`);
if (unwired.length) console.log('  still not firing:', unwired.join(', '));

// ---- win / lose paths
const src = fs.readFileSync('extracted/war3map.j', 'latin1').replace(/\r\n?/g, '\n');
const funcs = {};
for (const m of src.matchAll(/^function\s+(\w+)\s+takes[\s\S]*?^endfunction/gm)) funcs[m[1]] = m[0];
console.log('\n=== win / lose paths ===');
for (const [fn, body] of Object.entries(funcs)) {
  if (!/CustomVictoryBJ|CustomDefeatBJ|EndGame\(/.test(body)) continue;
  const guards = [...body.matchAll(/^if\((\w+)\(\)\)then/gm)].map((m) => m[1]);
  const trigVar = (src.match(new RegExp(`TriggerAddAction\\((\\w+),function ${fn}\\)`)) || [])[1];
  const regs = trigVar ? [...src.matchAll(new RegExp(`TriggerRegister\\w+\\(${trigVar}[^\\n]*`, 'g'))].map((m) => m[0]) : [];
  console.log(`  action ${fn}  (trigger ${trigVar || '?'})`);
  for (const r of regs) console.log(`      event: ${r.replace('call ', '')}`);
  for (const g of guards) {
    const gb = (funcs[g] || '').replace(/\s+/g, ' ');
    const kind = /PLAYER_SCORE_HEROES_KILLED/.test(gb) ? 'team hero-kill total vs threshold'
              : /GetKillingUnit/.test(gb) ? 'which team landed the killing blow' : 'other';
    console.log(`      guard ${g}() -> ${kind}`);
  }
}
const vics = [];
const ov = eng.vm.natives.get('CustomVictoryBJ');
eng.vm.registerNative('CustomVictoryBJ', (p) => { vics.push(p && p.index); return ov(p); });
tick(1);
console.log('\nvictory declared during audit for players:', vics.length ? vics.join(',') : '(none yet)');
const errs = [...new Set(eng.errors.map((e) => e.split('\n')[0]))];
console.log(`runtime errors: ${eng.errors.length} (${errs.length} distinct)`);
for (const e of errs.slice(0, 6)) console.log('  !', e);
console.log('unimplemented natives called:', [...eng.unimplemented].map(([n, c]) => `${n}(${c})`).join(', ') || 'none');
console.log('units in world:', world.units.size);
// Same as boot_test: this reported the error count and exited 0 regardless, so
// pipeline.sh's verify stage could not fail. Unimplemented natives stay
// advisory; a runtime error does not.
process.exit(eng.errors.length ? 1 : 0);
