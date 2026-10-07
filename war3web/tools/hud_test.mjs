import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';
const browser = await puppeteer.launch({executablePath:CHROME,headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader','--use-gl=swiftshader','--disable-dev-shm-usage'],defaultViewport:{width:1440,height:900}});
try {
  const page = await browser.newPage(), errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('response',r=>{if(r.status()>=400 && /\/assets\/ui\/|\/data\/hud/.test(r.url()))errors.push(`${r.status()} ${r.url()}`)});
  await page.goto(`http://127.0.0.1:${process.env.PORT||8077}/?room=hud-${Date.now()}`);
  await page.waitForFunction(()=>window.FOC?.S?.heroes?.length && !document.getElementById('lobby').classList.contains('hidden'),{timeout:60000});
  await page.$eval('.hcard',n=>n.click());
  await page.$eval('#btnReady',n=>n.click());
  await page.waitForFunction(()=>window.FOC?.S?.hero && window.FOC.ui.hudData?.art?.move,{timeout:60000});
  await page.waitForFunction(()=>document.querySelector('[data-command="skill"]'));
  assert.deepEqual(await page.$$eval('[data-command]',ns=>ns.map(n=>n.dataset.command).filter(n=>!n.startsWith('ability-'))),['move','stop','hold','attack','patrol','skill']);
  assert.equal(await page.$eval('#hud',n=>getComputedStyle(n).fontFamily.includes('Friz Quadrata')),true);
  assert.equal(await page.$eval('#abilities',n=>!!n.querySelector('.skillnote,.up')),false);
  await page.waitForFunction(()=>document.getElementById('loading').classList.contains('hidden'),{timeout:90000});
  await page.click('[data-command="skill"]');
  assert.equal(await page.$eval('#abilities',n=>!!n.querySelector('[data-command="cancel"]')),true);
  const ability=await page.$eval('[data-command^="ability-"]:not(.unavailable)',n=>n.dataset.command);
  await page.click(`[data-command="${ability}"]`);
  await page.waitForFunction(()=>window.FOC.S.hero.skillPoints===0);
  assert.equal(await page.$eval('#abilities',n=>!!n.querySelector('[data-command="cancel"]')),false);
  // Intercept only the transport to assert the actual canvas/keyboard routing.
  await page.evaluate(()=>{const {net}=window.FOC;window.hudSent=[];const send=net.send.bind(net);net.send=m=>{window.hudSent.push(m);send(m)};});
  await page.click('#view',{offset:{x:1000,y:350}});
  assert.equal(await page.evaluate(()=>window.hudSent.some(m=>m.t==='move')),false,'left click must not move');
  // Ground selection now clears the group; explicitly select the hero before ordering.
  await page.keyboard.press('F1');
  await page.mouse.click(1000,350,{button:'right'});
  assert.equal(await page.evaluate(()=>window.hudSent.some(m=>m.t==='move'&&!m.attack)),true,'right click moves without attack-move');
  await page.click('[data-command="hold"]');
  assert.equal(await page.evaluate(()=>window.hudSent.some(m=>m.t==='hold')),true);
  await page.click('[data-command="attack"]');await page.mouse.click(1000,350);
  assert.equal(await page.evaluate(()=>window.hudSent.some(m=>m.t==='move'&&m.attack)),true);
  await page.click('[data-command="patrol"]');await page.mouse.click(1000,350);
  assert.equal(await page.evaluate(()=>window.hudSent.some(m=>m.t==='move'&&m.patrol)),true);
  await page.keyboard.press('Enter');await page.keyboard.type('HUD chat check');await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(()=>window.hudSent.some(m=>m.t==='chat'&&m.text==='HUD chat check')),true);
  for(const key of ['F9','F10','F11']) {await page.keyboard.press(key);assert.equal(await page.$('#wcDialog')!==null,true);await page.keyboard.press('Escape');}
  await page.hover('[data-command="move"]');
  assert.equal(await page.$eval('#wcTooltip',n=>!n.classList.contains('hidden')&&n.textContent.includes('Move (M)')),true);
  for(const [width,height] of [[1440,900],[1024,768],[1920,1080]]) {
    await page.setViewport({width,height});
    await page.evaluate(()=>window.FOC.refitConsole());
    const bounds=await page.$$eval('#abilities .slot',ns=>ns.map(n=>{const r=n.getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height}}));
    assert.ok(bounds.every(r=>r.x>=0&&r.y>=0&&r.x+r.w<=width+1&&r.y+r.h<=height+1),'card inside viewport');
    for(let i=0;i<bounds.length;i++)for(let j=i+1;j<bounds.length;j++) {
      const a=bounds[i],b=bounds[j];assert.ok(a.x+a.w<=b.x+1||b.x+b.w<=a.x+1||a.y+a.h<=b.y+1||b.y+b.h<=a.y+1,'no overlapping card cells');
    }
  }
  await page.setViewport({width:1440,height:900});await page.mouse.move(800,400);
  await page.screenshot({path:'/tmp/wc3-hud.png'});
  assert.deepEqual(errors,[]);
  console.log('HUD passed: command menu, learn flow, controls, chat, dialogs, tooltips, three viewport sizes; no page/asset errors.');
} finally {await browser.close();}
