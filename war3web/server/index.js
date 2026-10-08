import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { Room } from './room.js';
import { Msg } from '../shared/const.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.glb': 'model/gltf-binary', '.mp3': 'audio/mpeg', '.bin': 'application/octet-stream',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.ttf': 'font/ttf' };

// The working directory itself is deliberately not served: it also holds the
// map, the Blizzard archives and the server source, none of which belong on
// the wire. The client reaches exactly two subtrees by absolute path -- its
// /shared imports and the /three import map -- so those URL prefixes alone
// are mapped to the directories they really live under.
const STATIC_DIRS = ['client', 'public'];
const STATIC_TREES = { '/shared/': '.', '/three/': 'node_modules', '/assets/': '.' };
// The bench pages -- modelview, cliffview, fxview -- sit in tools/ beside the
// scripts that drive them, and every browser-driven test loads one. Closing the
// project root took them off the wire with everything else it was meant to
// close, which left those tests unable to reach the thing they test. They are
// the only files under tools/ that go anywhere: the .py and .mjs next to them
// are source, and make_serve.py strips even these three from a deploy.
const BENCH_PAGE = /^\/tools\/[A-Za-z0-9_.-]+\.html$/;

function resolveFile(urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath.split('?')[0]); }
  catch { return null; }                       // bad %-escape is a 404, not a crash
  if (rel === '/' ) rel = '/index.html';
  rel = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const dirs = [...STATIC_DIRS];
  // STATIC_TREES keys are Unix-style ('/shared/', '/three/'); on Windows
  // path.normalize turns '/' into '\\', so compare both sides normalized.
  for (const [pre, d] of Object.entries(STATIC_TREES)) {
    if (rel.startsWith(path.normalize(pre))) dirs.push(d);
  }
  if (BENCH_PAGE.test(rel)) dirs.push('.');
  for (const d of dirs) {
    const p = path.join(ROOT, d, rel);
    if (p.startsWith(path.join(ROOT, d)) && fs.existsSync(p) && fs.statSync(p).isFile()) return p;
  }
  return null;
}

const server = http.createServer((req, res) => {
  const file = resolveFile(req.url);
  if (!file) { res.writeHead(404); res.end('Not found'); return; }
  const ext = path.extname(file).toLowerCase();
  const stat = fs.statSync(file);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream',
                       'Content-Length': stat.size,
                       // assets are rebuilt as the map pipeline is re-run, so never
                       // let a browser hold a stale model/texture/data file
                       'Cache-Control': 'no-cache, no-store, must-revalidate' });
  fs.createReadStream(file).pipe(res);
});

const rooms = new Map();
const getRoom = (id) => {
  if (!rooms.has(id)) rooms.set(id, new Room(id));
  return rooms.get(id);
};

const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  const room = getRoom(url.searchParams.get('room') || 'arena');
  let player = null;
  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf); } catch { return; }
    // JSON.parse('null') parses fine; reading m.t off it would not
    if (!m || typeof m !== 'object') return;
    if (!player) {
      if (m.t !== Msg.HELLO) return;
      // join returns null for a full room, having already told the client why
      player = room.join(ws, m.name, typeof m.token === 'string' ? m.token.slice(0, 64) : null);
      return;
    }
    try { room.handle(player, m); } catch (e) { console.error('handle', m.t, e.message); }
  });
  // an emptied room is dropped from the map, or a client reconnecting with a
  // fresh ?room= each time would grow it without bound
  const drop = () => { room.leave(player); if (!room.players.size) rooms.delete(room.id); };
  ws.on('close', drop);
  ws.on('error', drop);
});

server.listen(PORT, HOST, () => {
  console.log(`War3Web server listening on http://${HOST}:${PORT}  (ws: /ws)`);
});
