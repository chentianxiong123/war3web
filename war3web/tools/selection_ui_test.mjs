// Real input handlers and console; deterministic entities isolate selection from combat.
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true,
  args: ['--no-sandbox','--enable-unsafe-swiftshader','--use-gl=swiftshader','--disable-dev-shm-usage'],
  defaultViewport: {width:1280,height:800} });
try {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${process.env.PORT || 8077}/?room=selection-test`, {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => window.FOC && document.getElementById('loading').classList.contains('hidden'), {timeout:90000});
  await page.click('.hcard[data-id="H00C"]');
  await page.waitForFunction(() => FOC.ui.selected === 'H00C');
  await page.click('#btnReady');
  await page.waitForFunction(() => FOC.S.hero && FOC.S.ents.has(FOC.S.hero.id), {timeout:60000});
  await page.evaluate(async () => {
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const {S,net,view} = FOC;
    net.ws.onmessage = () => {};
    window.sent = []; net.send = m => { if (m.t !== 'ping') sent.push(m); };
    const hero = S.ents.get(S.hero.id);
    window.ids = [hero.i, 990001, 990002];
    S.ents.set(ids[1], {...hero,i:ids[1],u:'hfoo',k:2,name:'Owned unit'});
    S.ents.set(ids[2], {...hero,i:ids[2],p:S.slot+1,t:99,name:'Enemy'});
    view.pickEntity = nx => ({id: nx < -.2 ? ids[0] : nx < .3 ? ids[1] : ids[2]});
    view.pickItem = () => null; view.pickGround = () => ({x:100,y:100});
    view.pickDoodad = () => null;
    window.focusCalls = []; const focus = view.focus.bind(view); view.focus = (...args) => { if (args[2]) focusCalls.push(args); return focus(...args); };
  });
  const order = async () => { await page.mouse.click(600,300,{button:'right'}); return page.evaluate(() => sent.filter(m => ['move','attack','smart'].includes(m.t)).at(-1)); };
  await page.mouse.click(200,300);
  await page.keyboard.down('Shift'); await page.mouse.click(600,300); await page.keyboard.up('Shift');
  let m = await order();
  const ids = await page.evaluate(() => window.ids);
  assert.deepEqual(m.unitIds,[ids[0],ids[1]],'Shift-click adds owned unit to commands');
  assert.equal(await page.$$eval('.selection-group button', b => b.length),2);
  assert.equal(m.t,'smart','unit right-click uses a smart order');
  await page.keyboard.down('Shift'); m = await order(); await page.keyboard.up('Shift');
  assert.equal(m.queue,true,'Shift-right-click queues the smart order');
  await page.keyboard.down('Shift'); await page.click('[data-command="hold"]'); await page.keyboard.up('Shift');
  assert.deepEqual(await page.evaluate(() => sent.at(-1)),{t:'hold',unitIds:[ids[0],ids[1]],queue:true});
  await page.click('[data-command="move"]');
  await page.keyboard.down('Shift'); await page.mouse.click(700,300); await page.keyboard.up('Shift');
  assert.equal(await page.evaluate(() => sent.at(-1).queue),true,'aimed command queues on Shift-click');

  await page.keyboard.press('Tab');
  assert.equal(await page.$eval('#pname2',e=>e.textContent),'Owned unit','Tab activates next type');
  assert.equal(await page.$$eval('.selection-group button',nodes=>nodes.length),2,'Tab keeps whole selection');
  assert.equal(await page.$$eval('.active-subgroup',nodes=>nodes.map(n=>Number(n.dataset.unitId))).then(ids=>ids[0]),ids[1]);
  m = await order(); assert.deepEqual(m.unitIds,[ids[0],ids[1]],'subgroup retains group-wide basic commands');
  await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
  assert.equal(await page.evaluate(() => FOC.ui.unitSel),null,'Shift+Tab restores hero card');
  // All six physical numpad keys use inventory slots even with navigation key values.
  await page.evaluate(() => {
    FOC.S.hero.items = Array.from({length:6},(_,slot)=>({slot,id:'test-item-'+slot,name:'Item '+slot,charges:1,targeted:slot===0}));
    FOC.ui.updateHero(FOC.S.hero);
    window.itemKey = (code,key='Home',repeat=false) => dispatchEvent(new KeyboardEvent('keydown',{code,key,repeat,bubbles:true,cancelable:true}));
  });
  const beforeItem=await page.evaluate(()=>sent.length);
  await page.evaluate(()=>itemKey('Numpad7'));
  assert.equal(await page.evaluate(()=>FOC.S.itemPending),0,'Numpad7 arms a targeted item with Num Lock off');
  assert.equal(await page.evaluate(()=>sent.length),beforeItem,'aimed item is not used before targeting');
  await page.keyboard.press('Escape');
  for (const [code,slot] of [['Numpad8',1],['Numpad4',2],['Numpad5',3],['Numpad1',4],['Numpad2',5]]) {
    await page.evaluate(code=>itemKey(code,'1'),code);
    assert.deepEqual(await page.evaluate(()=>sent.at(-1)),{t:'useItem',slot});
  }
  let itemCount=await page.evaluate(()=>sent.length);
  await page.evaluate(()=>itemKey('Numpad8','8',true));
  assert.equal(await page.evaluate(()=>sent.length),itemCount,'held key does not repeatedly use items');
  await page.keyboard.press('Tab');
  assert.equal(await page.$eval('#pname2',e=>e.textContent),'Owned unit');
  await page.evaluate(()=>itemKey('Numpad8','8'));
  assert.equal(await page.evaluate(()=>sent.length),itemCount,'inactive hero inventory cannot be used');
  await page.keyboard.down('Shift'); await page.keyboard.press('Tab'); await page.keyboard.up('Shift');
  await page.keyboard.press('F10');
  await page.evaluate(()=>[...document.querySelectorAll('#wcDialog button')].find(b=>b.textContent==='Scoreboard').click());
  assert.equal(await page.$eval('#score',e=>e.classList.contains('hidden')),false,'scoreboard remains accessible through menu');
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('#score',e=>e.classList.contains('hidden')),true);
  await page.keyboard.down('Control'); await page.keyboard.press('1'); await page.keyboard.up('Control');
  await page.mouse.click(600,300);
  m = await order(); assert.deepEqual(m.unitIds,[ids[1]],'nonhero can receive orders');
  assert.equal(await page.$eval('[data-command="stop"]', b => b.getAttribute('aria-disabled')), 'false');
  const stopBox = await (await page.$('[data-command="stop"]')).boundingBox();
  await page.mouse.move(stopBox.x + stopBox.width/2, stopBox.y + stopBox.height/2);
  await page.mouse.down();
  await page.evaluate(() => FOC.ui.renderSelected(FOC.S.ents.get(ids[1])));
  await page.mouse.up();
  assert.deepEqual(await page.evaluate(() => sent.at(-1)),{t:'stop',unitIds:[ids[1]]},'snapshot refresh preserves command-button clicks');
  await page.keyboard.press('s');
  assert.deepEqual(await page.evaluate(() => sent.at(-1)),{t:'stop',unitIds:[ids[1]]});
  await page.keyboard.press('1');
  m = await order(); assert.deepEqual(m.unitIds,[ids[0],ids[1]],'group recall restores selection');
  await page.keyboard.down('Shift'); await page.mouse.click(600,300); await page.keyboard.up('Shift');
  m = await order(); assert.deepEqual(m.unitIds,[ids[0]],'Shift-click removes selected unit');
  await page.mouse.click(950,300);
  const count = await page.evaluate(() => sent.length);
  await order(); assert.equal(await page.evaluate(() => sent.length),count,'enemy selection cannot issue hero orders');
  await page.keyboard.press('F1');
  assert.equal(await page.evaluate(() => focusCalls.length),0,'first F1 only selects');
  await page.keyboard.press('F1');
  assert.equal(await page.evaluate(() => focusCalls.length),1,'second F1 centers');
  // Project the real entity coordinates, then drag around them using actual mouse events.
  const point = await page.evaluate(async () => {
    const THREE = await import('three');
    const {toX,toZ} = await import('/js/render.js');
    const e = FOC.S.ents.get(ids[0]);
    const p = new THREE.Vector3(toX(e.x),FOC.view.heightAt(e.x,e.y),toZ(e.y)).project(FOC.view.camera);
    return {x:(p.x+1)*innerWidth/2,y:(1-p.y)*innerHeight/2};
  });
  await page.mouse.move(point.x-30,point.y-30); await page.mouse.down();
  await page.mouse.move(point.x+30,point.y+30,{steps:5});
  assert.equal(await page.$eval('#selectionBox',e=>e.style.display),'block');
  await page.mouse.up();
  m = await order(); assert.deepEqual(m.unitIds,[ids[0],ids[1]],'box selects owned units only');
  assert.equal(await page.$eval('#selectionBox',e=>e.style.display),'none');
  await page.screenshot({path:'/tmp/wc3-selection.png'});
  // Shop selection must still replace the card after emptying the unit group.
  await page.evaluate(() => {
    const shop = [...FOC.S.ents.values()].find(e => FOC.shopFor({id:e.i})?.items.length);
    if (!shop) throw new Error('Fixture needs a shop');
    FOC.view.pickEntity = () => ({id:shop.i});
  });
  await page.mouse.click(600,300);
  assert.ok(await page.$$eval('.shopitem', nodes => nodes.length), 'shop card remains available');
  await page.keyboard.press('Escape');
  assert.ok(await page.$('[data-command="stop"]'), 'Escape restores hero card');
  await page.evaluate(() => { FOC.view.pickEntity = () => null; });
  await page.mouse.click(600,300);
  assert.equal(await page.$eval('#unitPortrait',e=>e.style.visibility),'hidden','empty selection clears portrait');
  assert.equal(await page.$$eval('#abilities > *',nodes=>nodes.length),0,'empty selection clears command card');
  assert.deepEqual(errors,[]);
  console.log('Selection UI: Shift, box, groups, ownership, command card and F1 passed');
} finally { await browser.close(); }
