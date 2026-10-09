// Where Chromium is.
//
// puppeteer-core deliberately ships no browser, so every tool here has to name
// one -- and twenty-one of them named /usr/bin/chromium outright. That is an
// Arch path. Debian installs /usr/bin/chromium-browser, Fedora and Flatpak put
// it elsewhere again, and a Mac has neither, so the repo's whole browser-driven
// half -- including hero_portraits.mjs, which the pipeline needs -- failed on
// any machine but the one it was written on, with puppeteer's own error rather
// than a useful one.
//
//   CHROME=/path/to/chrome node tools/shot.mjs
//
// $CHROME wins if it is set. Otherwise the first of these that exists is used.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CANDIDATES = [
  // Linux / macOS
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
  '/var/lib/flatpak/exports/bin/org.chromium.Chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  // Windows
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

// Browsers installed with `npm exec browsers install chrome@stable` land in
// ~/.cache/puppeteer/chrome/<buildId>/chrome-win64/chrome.exe, so a single
// install serves every tool in the repo (no per-tool downloads).
function findInPuppeteerCache() {
  const root = path.join(os.homedir(), '.cache', 'puppeteer', 'chrome');
  let builds;
  try { builds = fs.readdirSync(root); } catch { return null; }
  for (const build of builds) {
    for (const p of [
      path.join(root, build, 'chrome-win64', 'chrome.exe'),
      path.join(root, build, 'chrome.exe'),
    ]) {
      try { if (fs.existsSync(p)) return p; } catch { /* keep looking */ }
    }
  }
  return null;
}

function find() {
  if (process.env.CHROME) return process.env.CHROME;
  // A browser explicitly installed into the puppeteer cache (e.g. a dedicated
  // headless Chromium) beats whatever the OS happens to ship.
  const cached = findInPuppeteerCache();
  if (cached) return cached;
  for (const p of CANDIDATES) { try { if (fs.existsSync(p)) return p; } catch { /* keep looking */ } }
  return null;
}

const found = find();
if (!found) {
  console.error('No Chromium found. Install one, or set CHROME to its path:\n  ' +
                CANDIDATES.join('\n  '));
  process.exit(2);
}

/** The browser executable puppeteer-core should launch. */
export const CHROME = found;
