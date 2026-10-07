import WebSocket from 'ws';
const URL = `ws://127.0.0.1:${process.env.PORT || 8080}/ws?room=test`;
const log = (...a) => console.log(...a);

function bot(name, heroPick, team) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    const st = { name, hero: null, snaps: 0, events: {}, heroes: [], you: null, ent: null, dmgDealt: 0 };
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name })));
    ws.on('message', (b) => {
      const m = JSON.parse(b);
      if (m.t === 'welcome') {
        st.you = m.you; st.heroes = m.heroes;
        const h = m.heroes.filter((x) => x.model)[heroPick];
        st.pick = h;
        ws.send(JSON.stringify({ t: 'joinTeam', team }));
        ws.send(JSON.stringify({ t: 'pickHero', heroId: h.id }));
        setTimeout(() => ws.send(JSON.stringify({ t: 'ready', ready: true })), 300);
      } else if (m.t === 'hero') {
        st.hero = m.h; st.ent = m.h.id;
      } else if (m.t === 'snap') {
        st.snaps++;
        st.lastSnap = m.s;
      } else if (m.t === 'event') {
        for (const e of m.ev) st.events[e.t] = (st.events[e.t] || 0) + 1;
      } else if (m.t === 'state') {
        st.phase = m.phase; st.kills = m.kills;
      }
    });
    st.ws = ws;
    setTimeout(() => resolve(st), 800);
  });
}

const [a, b] = await Promise.all([bot('Alpha', 0, 0), bot('Bravo', 1, 1)]);
await new Promise((r) => setTimeout(r, 2000));
for (const s of [a, b]) if (!s.ent) { s.ws.send(JSON.stringify({ t: 'ready', ready: true })); }
await new Promise((r) => setTimeout(r, 800));
log(`phase=${a.phase}  A picked ${a.pick.name} (${a.pick.id})  B picked ${b.pick.name}`);
log(`A hero entity=${a.ent} lvl=${a.hero?.level} hp=${a.hero?.maxHp} abilities=${a.hero?.abilities.length}`);
log('A abilities:', a.hero?.abilities.map((x) => `${x.name}[${x.archetype}]`).join(', '));

// learn every skill then drive both heroes at each other and spam casts
for (const s of [0, 1, 2, 3]) { a.ws.send(JSON.stringify({ t: 'learn', slot: s })); b.ws.send(JSON.stringify({ t: 'learn', slot: s })); }
await new Promise((r) => setTimeout(r, 400));
log(`A after learn: skillPoints=${a.hero.skillPoints} levels=${a.hero.abilities.map((x) => x.lvl).join('')}`);

// move toward each other
const ea = a.lastSnap.ents.find((e) => e.i === a.ent);
const eb = b.lastSnap.ents.find((e) => e.i === b.ent);
log(`A at (${ea.x},${ea.y})  B at (${eb.x},${eb.y})`);
a.ws.send(JSON.stringify({ t: 'move', x: eb.x, y: eb.y, attack: true }));
b.ws.send(JSON.stringify({ t: 'move', x: ea.x, y: ea.y, attack: true }));
await new Promise((r) => setTimeout(r, 2500));

// force combat: attack order + casts
a.ws.send(JSON.stringify({ t: 'attack', targetId: b.ent }));
b.ws.send(JSON.stringify({ t: 'attack', targetId: a.ent }));
for (let i = 0; i < 12; i++) {
  const tb = b.lastSnap.ents.find((e) => e.i === b.ent);
  const ta = a.lastSnap.ents.find((e) => e.i === a.ent);
  for (const s of [0, 1, 2, 3]) {
    a.ws.send(JSON.stringify({ t: 'cast', slot: s, x: tb?.x, y: tb?.y, targetId: b.ent }));
    b.ws.send(JSON.stringify({ t: 'cast', slot: s, x: ta?.x, y: ta?.y, targetId: a.ent }));
  }
  await new Promise((r) => setTimeout(r, 500));
}

const fa = a.lastSnap.ents.find((e) => e.i === a.ent);
const fb = b.lastSnap.ents.find((e) => e.i === b.ent);
log('\n--- results ---');
log(`snapshots A=${a.snaps} B=${b.snaps}`);
log(`A hp ${fa.h}/${fa.H} lvl ${fa.l}   B hp ${fb.h}/${fb.H} lvl ${fb.l}`);
log(`A moved to (${fa.x},${fa.y})  B moved to (${fb.x},${fb.y})`);
log('events A:', JSON.stringify(a.events));
log('events B:', JSON.stringify(b.events));
log(`entities in world: ${a.lastSnap.ents.length}, kills ${JSON.stringify(a.lastSnap.kills)}`);
const boss = a.lastSnap.ents.find((e) => e.k === 2 && e.H > 20000);
log('boss present:', !!boss, boss ? `hp ${boss.h}/${boss.H} at (${boss.x},${boss.y})` : '');
a.ws.close(); b.ws.close();
process.exit(0);
