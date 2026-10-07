// A dropped player gets their seat back.
//
// The socket goes; the room holds the seat for a grace period and tells the
// script nothing; the client reconnects with the token its WELCOME carried and
// is handed the same seat, the same hero and the running match. Only when
// nobody comes back does the drop become what Warcraft III would have made of
// it at once: EVENT_PLAYER_LEAVE for the map's own triggers.
//
// Two halves. The room is driven in-process with fake sockets and a 400 ms
// grace, so the expiry can be tested without waiting a minute; the browser
// half closes a real client's socket against a live server and checks the
// page reattaches without a reload.
//
//   PORT=8077 node tools/rejoin_test.mjs
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';

process.env.FOC_REJOIN_GRACE_MS = '400';
const { Room } = await import('../server/room.js');

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = process.env.PORT || 8077;
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------ the room
const ws = () => ({ readyState: 1, out: [], send(s) { this.out.push(JSON.parse(s)); } });
const last = (w, t) => [...w.out].reverse().find((m) => m.t === t);
const room = new Room('rejoin');
const wa = ws(), wb = ws();
const pa = room.join(wa, 'Alpha');
const pb = room.join(wb, 'Bravo');
const hello = wa.out[0];
check('WELCOME carries a seat token', hello.t === 'welcome' && typeof hello.token === 'string' && hello.token.length > 16);
const heroId = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/game.json'), 'utf8')).heroes[0].id;
for (const [p] of [[pa], [pb]]) { room.handle(p, { t: 'pickHero', heroId }); room.handle(p, { t: 'ready', ready: true }); }
clearInterval(room.loop); room.loop = null;
room.stepLoop();
check('the match is running with both seated', room.phase === 'playing' && pa.entId != null && pb.entId != null);
const entA = pa.entId;
const leaveKey = room.eng.eventId('EVENT_PLAYER_LEAVE');
const fired = [];
const origFire = room.eng.fire.bind(room.eng);
room.eng.fire = (k, ctx) => { fired.push(k); return origFire(k, ctx); };

room.leave(pa);
const st1 = last(wb, 'state');
check('a drop mid-match keeps the seat and marks it away',
      room.players.has(pa.id) && !pa.ws && !!pa.dropTimer
      && st1.players.some((x) => x.id === pa.id && !x.connected && x.away));
check('and tells the script nothing yet', !fired.includes(leaveKey));

const wa2 = ws();
const back = room.join(wa2, 'Alpha', hello.token);
room.stepLoop();
check('reconnecting with the token returns the same seat', back === pa && pa.ws === wa2 && !pa.dropTimer);
const w2 = wa2.out[0];
check('with a WELCOME naming the same player and the running match',
      w2.t === 'welcome' && w2.you === pa.id && w2.token === hello.token && w2.phase === 'playing');
check('the same hero', pa.entId === entA && wa2.out.some((m) => m.t === 'hero' && m.h && m.h.id === entA));
check('and the scenery replayed', wa2.out.some((m) => m.t === 'event' && m.ev.some((e) => e.t === 'textTag' || e.t === 'fog' || e.t === 'dnc' || e.t === 'music' || e.t === 'tag')) || pa.tagsSent,
      `tagsSent=${pa.tagsSent}`);
check('everyone sees the seat connected again', last(wb, 'state').players.some((x) => x.id === pa.id && x.connected && !x.away));
check('still without a leave event', !fired.includes(leaveKey));

const stranger = room.join(ws(), 'Charlie', 'not-a-token');
check('a wrong token gets a fresh seat, not someone else\'s', stranger && stranger.id !== pa.id && stranger.id !== pb.id);
room.leave(stranger);

room.leave(pa);
await wait(700);
check('a seat nobody reclaims becomes a leave after the grace period', fired.includes(leaveKey) && pa.token === null);
const late = room.join(ws(), 'Alpha', hello.token);
check('and the old token no longer opens it', late && late.id !== pa.id);
room.leave(late);
room.leave(pb);
await wait(700);
check('a match nobody is in or coming back to is reset', room.phase === 'lobby' && !room.eng);

// A held match is held for its own players. Somebody new arriving while every
// seat is away gets a lobby, not a running game of ghosts -- which is also
// what keeps one test's abandoned match from swallowing the next test's client.
{
  const r2 = new Room('rejoin2');
  const wx = ws(), wy = ws();
  const px = r2.join(wx, 'X'), py = r2.join(wy, 'Y');
  for (const p of [px, py]) { r2.handle(p, { t: 'pickHero', heroId }); r2.handle(p, { t: 'ready', ready: true }); }
  clearInterval(r2.loop); r2.loop = null;
  r2.leave(px); r2.leave(py);
  check('a match everyone dropped from is still held for them', r2.phase === 'playing' && !!px.dropTimer);
  const wz = ws();
  const pz = r2.join(wz, 'Zed');
  check('but a newcomer without a token finds a lobby, not the ghosts',
        pz && r2.phase === 'lobby' && wz.out[0].phase === 'lobby' && !r2.players.has(px.id),
        `phase ${r2.phase}`);
  const wx2 = ws();
  const px2 = r2.join(wx2, 'X', px.token);
  check('and a dropped player coming back after that gets a fresh seat', px2 && px2.id !== px.id);
}

// ------------------------------------------------------------ the browser
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
         '--disable-dev-shm-usage', `--user-data-dir=.tmp/chrome-rejoin-${process.pid}`,
         '--disable-crash-reporter', '--disable-breakpad', '--no-first-run'],
  defaultViewport: { width: 1000, height: 700 },
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push(String(e.message)));
await page.goto(`http://127.0.0.1:${PORT}/?room=rejoin${process.pid}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => document.getElementById('loading').classList.contains('hidden'), { timeout: 90000 });
await page.evaluate(() => { const c = [...document.querySelectorAll('.hcard:not(.nomodel)')]; (c[0] || document.querySelector('.hcard')).click(); });
await wait(700);
await page.$eval('#btnReady', (b) => b.click());
await page.waitForFunction(() => !document.getElementById('hud').classList.contains('hidden'), { timeout: 60000 });
await wait(5000);
const before = await page.evaluate(() => ({ you: window.FOC.S.you, hero: window.FOC.S.hero?.id, ents: window.FOC.S.ents.size, token: window.FOC.net.token }));
check('a live client holds its token and a hero', !!before.token && before.hero != null && before.ents > 0, JSON.stringify(before));
await page.evaluate(() => window.FOC.net.ws.close());
await wait(300);
const shown = await page.evaluate(() => !document.getElementById('disconnected').classList.contains('hidden'));
check('closing the socket puts the notice up', shown);
let back2 = null;
for (let i = 0; i < 40 && !(back2 && back2.open && back2.hidden); i++) {
  await wait(250);
  back2 = await page.evaluate(() => ({
    open: window.FOC.net.ws?.readyState === 1,
    hidden: document.getElementById('disconnected').classList.contains('hidden'),
    you: window.FOC.S.you, hero: window.FOC.S.hero?.id, ents: window.FOC.S.ents.size,
    phase: window.FOC.S.phase, hud: !document.getElementById('hud').classList.contains('hidden'),
    log: document.getElementById('log').textContent }));
}
check('the client reconnects on its own and takes the notice down', !!back2 && back2.open && back2.hidden, JSON.stringify({ open: back2?.open, hidden: back2?.hidden }));
check('as the same player, in the same match, with the same hero',
      back2 && back2.you === before.you && back2.hero === before.hero && back2.phase === 'playing' && back2.hud,
      JSON.stringify({ you: [before.you, back2?.you], hero: [before.hero, back2?.hero], phase: back2?.phase }));
check('the world it already had is still there', back2 && back2.ents > 0, `${back2?.ents} entities`);
check('and it says so', !!back2 && /reconnected/.test(back2.log));
check('no console errors', errs.length === 0, errs.slice(0, 2).join(' | '));
await browser.close();

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
