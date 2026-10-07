// Is the command card four whole columns, or three and a half?
//
// ConsoleUI.fdf ends the right console tile partway through the last column and
// the 0.04-wide corner tile carries the rest -- the same seam that cuts the
// portrait arch in half. Measured tile by tile, Tile03's fourth column comes out
// 0.080 of the tile against ~0.155 for the other three and runs off its right
// edge, so the card drew three full columns and a clipped one, and the buttons
// in it were cut.
//
// The check is the one that fails on a clipped column and passes on a joined
// one: every cell the same width, on an even pitch, none running past the frame.
//
//   node server/index.js &        # port 8077
//   node tools/card_test.mjs
import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';

const PORT = process.env.PORT || 8077;
const results = [];
const check = (name, pass, detail = '') => {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? '  -- ' + detail : ''}`);
};

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
         '--disable-dev-shm-usage', '--disable-crash-reporter', '--disable-breakpad',
         '--no-first-run', `--user-data-dir=.tmp/chrome-card-${process.pid}`],
  defaultViewport: { width: 1440, height: 900 },
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => window.FOC?.consoleSlots != null, { timeout: 90000 });

const out = await page.evaluate(() => {
  const slots = window.FOC.consoleSlots;
  // the styles are CSS percentages; render them to read real pixels back
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;inset:0;pointer-events:none;visibility:hidden';
  document.body.appendChild(host);
  const measure = (st) => {
    const d = document.createElement('div');
    d.style.position = 'absolute';
    Object.assign(d.style, st);
    host.appendChild(d);
    const r = d.getBoundingClientRect();
    return { w: +r.width.toFixed(1), h: +r.height.toFixed(1),
             right: +(innerWidth - r.right).toFixed(1), top: +r.top.toFixed(1) };
  };
  const cells = (slots.cells || []).map(measure);
  const portrait = slots.portrait ? measure(slots.portrait) : null;
  host.remove();
  return { cells, portrait, innerWidth };
});
console.log(JSON.stringify(out.cells));

const c = out.cells;
check('the card is twelve cells', c.length === 12, `${c.length}`);

// every cell the same width: a clipped fourth column is about half the others
const ws = c.map((x) => x.w);
const wMin = Math.min(...ws), wMax = Math.max(...ws);
check('every column is the same width', wMax - wMin < 3,
      `${wMin} .. ${wMax} (a clipped column measured ~37 against ~71)`);

// the fourth column specifically -- indices 3, 7, 11 in row-major order
const col4 = [c[3], c[7], c[11]];
check('the fourth column is as wide as the first',
      col4.every((x) => Math.abs(x.w - c[0].w) < 3),
      col4.map((x) => x.w).join(' ') + ` vs ${c[0].w}`);

// an even pitch across the row is what a joined seam produces and a clipped
// one cannot
const row = [c[0], c[1], c[2], c[3]].map((x) => x.right);
const gaps = row.slice(1).map((r, i) => +(row[i] - r).toFixed(1));
check('the columns sit on an even pitch', Math.max(...gaps) - Math.min(...gaps) < 2,
      gaps.join(' '));

check('nothing runs past the frame', c.every((x) => x.right >= -1),
      `min right ${Math.min(...c.map((x) => x.right))}`);

// the portrait arch is the same seam solved for the other pair of tiles; it
// should not have regressed while the card's was generalised
check('the portrait arch still spans its own seam',
      !!out.portrait && out.portrait.w > 40,
      out.portrait ? `${out.portrait.w}x${out.portrait.h}` : 'missing');

const real = errs.filter((e) => !/404|portraits\//.test(e));
check('no console errors', real.length === 0, real.slice(0, 2).join(' | '));

await browser.close();
const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} checks passed`);
process.exit(bad ? 1 : 0);
