import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';
const SP = process.env.SP || '/tmp';
const b = await puppeteer.launch({ executablePath: CHROME, headless: true,
  args: ['--no-sandbox','--enable-unsafe-swiftshader','--use-gl=swiftshader','--disable-dev-shm-usage'],
  defaultViewport: { width: 1440, height: 900 } });
const page = await b.newPage();
const errs = [];
page.on('pageerror', e => errs.push(e.message));
await page.goto('http://127.0.0.1:8080/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForFunction(() => !document.getElementById('lobby').classList.contains('hidden'), { timeout: 30000 });
await new Promise(r => setTimeout(r, 800));

const read = () => page.evaluate(() => ({
  tabs: [...document.querySelectorAll('#tavtabs button')].map(b => b.textContent),
  active: [...document.querySelectorAll('#tavtabs button')].findIndex(b => b.classList.contains('on')),
  heroes: [...document.querySelectorAll('#heroGrid .nm')].map(n => n.textContent),
}));

const before = await read();
console.log('tabs:', before.tabs.join(' | '));
let allOk = true;
for (let i = 0; i < before.tabs.length; i++) {
  await page.evaluate((i) => document.querySelectorAll('#tavtabs button')[i].click(), i);
  await new Promise(r => setTimeout(r, 250));
  const s = await read();
  const ok = s.active === i;
  if (!ok) allOk = false;
  console.log(`click "${before.tabs[i]}" -> active=${s.active === -1 ? 'none' : before.tabs[s.active]} ${ok ? 'OK' : 'WRONG'}  first heroes: ${s.heroes.slice(0,3).join(', ')}`);
}
// a lobby re-render (state update) must not reset the tab
await page.evaluate(() => document.querySelectorAll('#tavtabs button')[2].click());
await new Promise(r => setTimeout(r, 200));
await page.evaluate(() => { const n = document.getElementById('pname'); n.value = 'Tester'; n.dispatchEvent(new Event('change')); });
await page.click('#btnTeam1');
await new Promise(r => setTimeout(r, 600));
const after = await read();
console.log(`after a state re-render, active tab = ${after.active === -1 ? 'none' : before.tabs[after.active]} (expected ${before.tabs[2]}) ${after.active === 2 ? 'OK' : 'WRONG'}`);
if (after.active !== 2) allOk = false;
console.log('page errors:', errs.length, errs.slice(0,3));
console.log(allOk ? 'RESULT: tab selector works' : 'RESULT: still broken');
await page.screenshot({ path: `${SP}/shot_tabs.png` });
await b.close();
