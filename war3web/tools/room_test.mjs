// A long-lived server hands late joiners the same team.
//
// It takes a while to show up, which is why it reads as flakiness: duo_test
// passes on a fresh server and fails on one that has seen a dozen matches. This
// drives that history deliberately -- join, play, disconnect, repeat -- and then
// checks that two fresh players still land on opposite sides.
//
//   PORT=8077 node tools/room_test.mjs
import WebSocket from 'ws';

const PORT = process.env.PORT || 8077;
const ROUNDS = +(process.env.ROUNDS || 6);
const ROOM = `roomtest${Date.now()}`;

let pass = 0, fail = 0;
const check = (ok, what, detail = '') => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? '  -- ' + detail : ''}`);
  ok ? pass++ : fail++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** One client: join, optionally pick and ready up, report what it was given. */
function client(name, { pick = false } = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?room=${ROOM}`);
    const st = { name, ws, slot: null, team: null, you: null, players: [] };
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name })));
    ws.on('message', (b) => {
      const m = JSON.parse(b);
      if (m.t === 'welcome') {
        st.you = m.you;
        if (pick) {
          const h = m.heroes.find((x) => x.model);
          ws.send(JSON.stringify({ t: 'pickHero', heroId: h.id }));
          setTimeout(() => ws.send(JSON.stringify({ t: 'ready', ready: true })), 200);
        }
        setTimeout(() => resolve(st), 500);
      } else if (m.t === 'state') {
        st.players = m.players;
        const me = m.players.find((x) => x.id === st.you);
        if (me) { st.slot = me.slot; st.team = me.team; }
      }
    });
    ws.on('error', () => resolve(st));
  });
}

// wear the room in: matches that start, run and empty out
for (let r = 0; r < ROUNDS; r++) {
  const a = await client(`Wear${r}A`, { pick: true });
  const b = await client(`Wear${r}B`, { pick: true });
  await wait(900);
  a.ws.close(); b.ws.close();
  await wait(400);
}
console.log(`drove ${ROUNDS} rounds through one room\n`);

const a = await client('Alpha');
const b = await client('Bravo');
await wait(700);
const slots = [0, 1, 2, 3, 4, 5, 6, 7, 10, 11];
check(slots.includes(a.slot), 'first joiner gets a real player slot', `slot=${a.slot}`);
check(slots.includes(b.slot), 'second joiner gets a real player slot', `slot=${b.slot}`);
check(a.slot !== b.slot, 'they do not share a slot', `${a.slot} / ${b.slot}`);
check(a.team !== b.team, 'they are on opposite teams', `team ${a.team} / ${b.team}`);
const ghosts = a.players.filter((p) => !p.connected);
check(ghosts.length === 0, 'the room kept no disconnected players',
      `${ghosts.length} still listed`);

// and the other half: the map has ten slots and no eleventh
const held = [a, b];
for (let i = 0; i < 8; i++) held.push(await client(`Filler${i}`));
await wait(600);
const seated = new Set(held.map((c) => c.slot).filter((x) => x != null));
check(seated.size === 10, 'ten players seat on ten distinct slots', `${seated.size} distinct`);

const over = await new Promise((resolve) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?room=${ROOM}`);
  const st = { refused: false, closed: false, slot: undefined };
  ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name: 'Eleventh' })));
  ws.on('message', (b2) => {
    const m = JSON.parse(b2);
    if (m.t === 'error') st.refused = true;
    if (m.t === 'welcome') st.slot = 'welcomed';
  });
  ws.on('close', () => { st.closed = true; resolve(st); });
  setTimeout(() => resolve(st), 1500);
});
check(over.refused, 'an eleventh joiner is told the arena is full');
check(over.slot !== 'welcomed', 'and is not seated', over.slot ?? 'not seated');

for (const c of held) c.ws.close();
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
