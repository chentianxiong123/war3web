// The strip along the top: is it the game's own layout, with real values in it?
//
// The frame art was always drawn and the strip was empty. Warcraft III hangs
// Quests/Menu/Allies/Chat off the left of it (UpperButtonBar.fdf) and gold,
// lumber and supply off the right (ResourceBar.fdf) -- frames the console layout
// never mentions, because the game anchors them to the screen rather than to the
// console.
//
// What is worth asserting is what could be faked: that the numbers are the
// server's and not placeholders, and that each button actually opens the thing
// it names rather than being art that swallows the click.
//
//   node server/index.js &        # port 8077
//   node tools/topbar_test.mjs
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
         '--no-first-run', `--user-data-dir=.tmp/chrome-topbar-${process.pid}`],
  defaultViewport: { width: 1440, height: 900 },
});
const page = await browser.newPage();
const errs = [];
page.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text().slice(0, 200)); });
const bad404 = [];
page.on('response', (r) => { if (r.status() >= 400 && /\/assets\/textures\//.test(r.url())) bad404.push(r.url()); });

await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => !document.getElementById('lobby').classList.contains('hidden'),
                           { timeout: 60000 });
await page.evaluate(() => {
  const c = [...document.querySelectorAll('.hcard:not(.nomodel)')];
  (c[0] || document.querySelector('.hcard'))?.click();
});
await new Promise((r) => setTimeout(r, 600));
await page.$eval('#btnReady', (b) => b.click());
await page.waitForFunction(() => !document.getElementById('hud').classList.contains('hidden'),
                           { timeout: 60000 });
await page.waitForFunction(() => window.FOC?.S?.hero != null, { timeout: 60000 });
await new Promise((r) => setTimeout(r, 1500));

const out = await page.evaluate(() => {
  const host = document.getElementById('uitop');
  const px = (el) => { const r = el.getBoundingClientRect(); return { w: +r.width.toFixed(1), h: +r.height.toFixed(1), x: +r.x.toFixed(1) }; };
  const icons = [...host.querySelectorAll('.rbicon')].map((n) => ({
    img: getComputedStyle(n).backgroundImage.replace(/^url\("?|"?\)$/g, ''), ...px(n),
  }));
  const texts = [...host.querySelectorAll('.rbtext')].map((n) => n.textContent);
  const btns = [...host.querySelectorAll('.ubbtn')].map((n) => ({
    label: n.textContent, off: n.classList.contains('off'), disabled: n.disabled,
    img: getComputedStyle(n).backgroundImage.replace(/^url\("?|"?\)$/g, ''), ...px(n),
  }));
  return { icons, texts, btns, hero: { gold: window.FOC.S.hero.gold, lumber: window.FOC.S.hero.lumber } };
});
console.log(JSON.stringify(out, null, 1));

check('the resource icons are the game\'s own art', out.icons.length === 3
      && out.icons.every((i) => /Resource(Gold|Lumber|Supply)\.png$/.test(i.img)),
      out.icons.map((i) => i.img.split('/').pop()).join(' '));
check('the icons have a box to draw in', out.icons.every((i) => i.w > 4 && i.h > 4),
      out.icons.map((i) => `${i.w}x${i.h}`).join(' '));
check('the readouts show the server\'s numbers, not placeholders',
      out.texts[0] === String(out.hero.gold) && out.texts[1] === String(out.hero.lumber),
      `gold ${out.texts[0]}=${out.hero.gold}, lumber ${out.texts[1]}=${out.hero.lumber}`);
check('all four buttons are there', out.btns.length === 4,
      out.btns.map((b) => b.label).join(' '));
check('they carry the layout\'s button art', out.btns.every((b) => /buttonstates2\.png$/.test(b.img)),
      out.btns.map((b) => b.img.split('/').pop()).slice(0, 1).join(''));
// Quests was greyed out while the quest natives were stubs. They are not any
// more -- CreateQuest/QuestSetTitle/QuestSetDescription keep real quests and the
// snapshot carries them -- so all four buttons lead somewhere and none of them
// is drawn from the layout's disabled art.
check('all four buttons are live, none drawn disabled',
      out.btns.every((b) => !b.off && !b.disabled),
      out.btns.map((b) => `${b.label}:${b.off ? 'off' : 'on'}`).join(' '));
check('the buttons run left to right in the layout\'s order',
      out.btns.every((b, i) => i === 0 || b.x > out.btns[i - 1].x),
      out.btns.map((b) => b.x).join(' '));

// Each button opens its own panel -- Warcraft III's F9/F10/F11, and the chat
// line for Chat. Asserting the click reaches a panel that names itself, rather
// than that a handler was called: a button wired to the wrong dialog passes the
// second and fails this.
const opened = await page.evaluate(async () => {
  const click = (label) => [...document.querySelectorAll('#uitop .ubbtn')]
    .find((n) => new RegExp(label).test(n.textContent))?.click();
  const out = {};
  for (const [label, want] of [['Quests', 'Quests'], ['Menu', 'Main Menu'], ['Allies', 'Allies']]) {
    click(label);
    const dlg = document.querySelector('#wcDialog [role="dialog"]');
    out[label] = { got: dlg?.getAttribute('aria-label') || null, want };
    window.FOC.ui.closeDialog();
  }
  click('Chat');
  const chat = document.getElementById('wcChat');
  out.Chat = { got: chat && !chat.classList.contains('hidden'), want: true };
  return out;
});
for (const [label, r] of Object.entries(opened)) {
  check(`${label} opens what it names`, r.got === r.want, `${r.got} vs ${r.want}`);
}

check('no missing textures', bad404.length === 0, bad404.slice(0, 2).join(' '));
const real = errs.filter((e) => !/404|portraits\//.test(e));
check('no console errors', real.length === 0, real.slice(0, 2).join(' | '));

await browser.close();
const bad = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - bad}/${results.length} checks passed`);
process.exit(bad ? 1 : 0);
