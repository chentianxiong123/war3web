// What build is this? -- the version tag in the corner of the screen.
//
// There is no build step to hang a number off. The client is served as source
// and tools/make_serve.py copies files rather than compiling them, so there is
// no moment in the pipeline that could stamp a counter into an artefact. The
// stamp is therefore taken from the code itself: hash every file the runtime
// actually runs, and if that hash is not the one recorded in data/build.json,
// this is a new build and the counter moves on.
//
// The result rises exactly when the code changes and never when it does not --
// restarting the server twice on an untouched tree shows the same build both
// times -- and it survives the trip to the VPS, because the counter file is
// packed alongside the source and the copied source hashes the same.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const STAMP = path.join(ROOT, 'data', 'build.json');
// what the running game is made of: the client, the simulation and the JASS VM.
// Not data/ or public/ -- those are the map's, and rebuilding the map is not a
// new build of the engine.
const TREES = ['client', 'server', 'shared'];
const EXT = new Set(['.js', '.html', '.css']);
// The model/cliff/fx benches live under client/ but tools/make_serve.py strips
// them out of the bundle. Counting them would make the deployed tree hash
// differently from the tree it was packed from, so the VPS would report a build
// one higher than the machine that built it -- precisely when you are comparing
// the two. Skip them, and this list stays in step with make_serve.py's.
const NOT_SHIPPED = new Set(['cliffview.html', 'fxview.html', 'modelview.html']);

function sources() {
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (EXT.has(path.extname(e.name)) && !NOT_SHIPPED.has(e.name)) out.push(p);
    }
  };
  for (const t of TREES) {
    const p = path.join(ROOT, t);
    if (fs.existsSync(p)) walk(p);
  }
  return out;
}

function version() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '0';
  } catch { return '0'; }
}

function digest() {
  const h = crypto.createHash('sha256');
  for (const f of sources()) {
    h.update(path.relative(ROOT, f).replace(/\\/g, '/'));   // so the name counts too
    h.update(fs.readFileSync(f));
  }
  return h.digest('hex').slice(0, 8);
}

export const BUILD = (() => {
  let hash;
  try { hash = digest(); } catch { hash = '????????'; }

  let prev = null;
  try { prev = JSON.parse(fs.readFileSync(STAMP, 'utf8')); } catch { /* first run */ }

  const same = prev && prev.hash === hash;
  const stamp = {
    v: version(),
    // the build number: unchanged while the code is, one higher the first time
    // it is not
    n: same ? prev.n : ((prev && prev.n) || 0) + 1,
    hash,
    // when this build was first seen, not when the server happened to start
    t: same && prev.t ? prev.t : new Date().toISOString(),
  };

  // A read-only deployment simply keeps showing what was packed, which is the
  // right answer there anyway: nothing on the VPS edits the source.
  try {
    fs.mkdirSync(path.dirname(STAMP), { recursive: true });
    fs.writeFileSync(STAMP, `${JSON.stringify(stamp, null, 2)}\n`);
  } catch { /* not writable; the number still holds for this run */ }

  return stamp;
})();
