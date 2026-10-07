// Every test in one command, against a server this script starts and stops.
//
// There was no `npm test`. The pipeline's verify stage ran three of these and
// could not fail -- boot_test and audit printed their error counts and exited 0
// regardless -- so a broken boot came out of a full rebuild green. The rest of
// the suite was only ever run by hand, one file at a time, which is also how a
// missing FOC_DEBUG=1 came to look like four unrelated failures in morph_test.
//
//   npm test                    # everything
//   npm test -- render polish   # only tests whose name contains these
//
// PORT (default 8077) and CHROME are passed through. The server is started with
// FOC_DEBUG=1: morph_test needs the level-to-cap key to reach a level-10
// ability, and nothing else cares.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const PORT = process.env.PORT || '8077';
const ROOT = path.resolve(import.meta.dirname, '..');
const TIMEOUT = +(process.env.TEST_TIMEOUT || 600) * 1000;
const filters = process.argv.slice(2).filter((a) => !a.startsWith('-'));

// Nothing is stale any more. Five tests -- sound, spell, match, wincond,
// victory -- used to hardcode hero ids H004/E00T and unit N007 and the chat
// commands '@duel'/'@tome', none of which exist in this map; they died during
// setup and sat skipped, which cost the suite its whole end-to-end half. They
// now take their heroes from tools/testheroes.mjs, drive the map's own kill
// counters, and assert rather than print. Keep this empty: a test that cannot
// run is a test that should be fixed or deleted.
const STALE = {};

// Tests that fail because the *port* has a defect they correctly detect, not
// because the test is broken. These stay in the run and their output is shown,
// but they do not decide the exit code -- a suite that is permanently red is a
// suite nobody reads. Deleting an entry here is the fix, not editing the test.
const KNOWN = {};

const VENV = path.join(ROOT, '.venv/bin/python');
// audit and boot_test are not named *_test.mjs but are what the pipeline
// verifies with; cliff_test is python and needs numpy, so it needs the venv.
const EXTRA = [
  { file: 'boot_test.mjs', cmd: process.execPath, args: ['tools/boot_test.mjs'] },
  { file: 'audit.mjs', cmd: process.execPath, args: ['tools/audit.mjs'] },
  { file: 'cliff_test.py', cmd: VENV, args: ['tools/cliff_test.py'],
    skip: fs.existsSync(VENV) ? null : 'no .venv -- python3 -m venv .venv && .venv/bin/pip install numpy pillow' },
  { file: 'terrain_surface_test.py', cmd: VENV, args: ['tools/terrain_surface_test.py'],
    skip: fs.existsSync(VENV) ? null : 'no .venv -- requires numpy and pillow' },
];

const discovered = fs.readdirSync(path.join(ROOT, 'tools'))
  .filter((f) => f.endsWith('_test.mjs') && f !== 'boot_test.mjs')
  .sort()
  .map((f) => ({ file: f, cmd: process.execPath, args: ['tools/' + f],
                 skip: STALE[f] || null }));

let plan = [...discovered, ...EXTRA];
if (filters.length) plan = plan.filter((t) => filters.some((f) => t.file.includes(f)));
if (!plan.length) { console.error('nothing matched'); process.exit(2); }

/** Is something already answering on the port? */
const portBusy = () => new Promise((res) => {
  const s = net.connect({ host: '127.0.0.1', port: +PORT });
  s.on('connect', () => { s.destroy(); res(true); });
  s.on('error', () => res(false));
});

const run = (cmd, args, env, timeout) => new Promise((res) => {
  const p = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env },
                               stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => { out += d; });
  p.stderr.on('data', (d) => { out += d; });
  const t = setTimeout(() => { p.kill('SIGKILL'); out += '\n[timed out]'; }, timeout);
  p.on('close', (code) => { clearTimeout(t); res({ code, out }); });
  p.on('error', (e) => { clearTimeout(t); res({ code: -1, out: out + '\n' + e.message }); });
});

// ---------------------------------------------------------------- the server
let server = null;
if (await portBusy()) {
  console.log(`using the server already on :${PORT}`);
  console.log('  (start it with FOC_DEBUG=1 or morph_test cannot reach a level-10 ability)\n');
} else {
  console.log(`starting a server on :${PORT} with FOC_DEBUG=1`);
  server = spawn(process.execPath, ['server/index.js'],
                 { cwd: ROOT, env: { ...process.env, PORT, FOC_DEBUG: '1' },
                   stdio: ['ignore', 'ignore', 'inherit'] });
  const until = Date.now() + 60000;
  while (!(await portBusy())) {
    if (Date.now() > until || server.exitCode !== null) {
      console.error('the server never came up'); server.kill(); process.exit(2);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log('  up\n');
}
const stop = () => { if (server && server.exitCode === null) server.kill(); };
process.on('exit', stop);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stop(); process.exit(130); });

// ----------------------------------------------------------------- the suite
const failed = [], skipped = [], known = [];
let passed = 0;
for (const t of plan) {
  if (t.skip) {
    skipped.push(t);
    console.log(`  skip  ${t.file.padEnd(22)} ${t.skip}`);
    continue;
  }
  const t0 = Date.now();
  const { code, out } = await run(t.cmd, t.args, { PORT }, TIMEOUT);
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  // most of these print "N/M checks passed"; show it when they do
  const tally = (out.match(/(\d+)\/(\d+) checks passed/) || [])[0] || '';
  if (code === 0) {
    passed++;
    console.log(`  ok    ${t.file.padEnd(22)} ${String(secs).padStart(4)}s  ${tally}`);
  } else if (KNOWN[t.file]) {
    known.push({ ...t, out });
    console.log(`  known ${t.file.padEnd(22)} ${String(secs).padStart(4)}s  ${KNOWN[t.file]}`);
  } else {
    failed.push({ ...t, out });
    console.log(`  FAIL  ${t.file.padEnd(22)} ${String(secs).padStart(4)}s  ${tally}  (exit ${code})`);
  }
}

for (const f of [...failed, ...known]) {
  console.log(`\n----- ${f.file} -----`);
  console.log(f.out.split('\n').slice(-25).join('\n'));
}

console.log(`\n${passed} passed, ${failed.length} failed, `
            + `${known.length} known-failing, ${skipped.length} skipped`);
for (const k of known) console.log(`  known-failing: ${k.file} -- ${KNOWN[k.file]}`);
stop();
process.exit(failed.length ? 1 : 0);
