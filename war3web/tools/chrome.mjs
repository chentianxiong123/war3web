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

const CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/snap/bin/chromium',
  '/var/lib/flatpak/exports/bin/org.chromium.Chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
];

function find() {
  if (process.env.CHROME) return process.env.CHROME;
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
