import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';
const browser=await puppeteer.launch({executablePath:CHROME,headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader','--use-gl=swiftshader','--disable-dev-shm-usage'],defaultViewport:{width:1280,height:800}});
try {
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${process.env.PORT||8077}/?room=minimap-${Date.now()}`);
  await page.waitForFunction(()=>window.FOC?.S.booted && !document.getElementById('lobby').classList.contains('hidden'),{timeout:90000});
  await page.click('.hcard[data-id="H00C"]');await page.click('#btnReady');
  await page.waitForFunction(()=>FOC.S.hero && FOC.S.ents.has(FOC.S.hero.id),{timeout:60000});
  const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await frames();
  await page.evaluate(()=>{FOC.net.ws.onmessage=()=>{};window.sent=[];FOC.net.send=m=>{if(m.t!=='ping')sent.push(m);};});
  const target=()=>page.evaluate(()=>({x:FOC.view.camTarget.x,y:-FOC.view.camTarget.z}));
  const near=(a,b)=>assert.ok(Math.hypot(a.x-b.x,a.y-b.y)<1,`${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  async function mapPoint(rx,ry) {
    const box=await (await page.$('#mmcanvas')).boundingBox();
    const b=await page.evaluate(()=>FOC.S.bounds);
    // MouseEvent client coordinates are integer CSS pixels in Chromium.
    const cx=Math.floor(box.x+box.width*rx),cy=Math.floor(box.y+box.height*ry);
    return {cx,cy,x:b.minX+(b.maxX-b.minX)*(cx-box.x)/box.width,y:b.maxY-(b.maxY-b.minY)*(cy-box.y)/box.height};
  }
  for(const [width,height,dpr] of [[1280,800,1],[1000,700,2]]) {
    await page.setViewport({width,height,deviceScaleFactor:dpr});await frames();
    const p=await mapPoint(.4,.45);
    await page.mouse.click(p.cx,p.cy);await frames();near(await target(),p);
    assert.equal(await page.evaluate(()=>sent.length),0,'minimap navigation does not move units');
    await page.evaluate(()=>{const e=FOC.S.ents.get(FOC.S.hero.id);e.x+=100;e.y+=100;});
    await frames();near(await target(),p); // no automatic hero-follow
  }
  let p=await mapPoint(.3,.3),q=await mapPoint(.6,.6);
  await page.mouse.move(p.cx,p.cy);await page.mouse.down();await page.mouse.move(q.cx,q.cy,{steps:4});await page.mouse.up();
  await frames();near(await target(),q);
  await page.evaluate(()=>FOC.view.panTo(0,0,10));
  await page.mouse.click(p.cx,p.cy);assert.equal(await page.evaluate(()=>FOC.view.scriptPan),null,'manual navigation cancels scripted pan');
  await page.keyboard.down('Shift');await page.mouse.click(q.cx,q.cy,{button:'right'});await page.keyboard.up('Shift');
  let message=await page.evaluate(()=>sent.at(-1));near(message,q);assert.equal(message.t,'move');assert.equal(message.queue,true);
  assert.deepEqual(message.unitIds,await page.evaluate(()=>[FOC.S.hero.id]));
  await page.click('[data-command="attack"]');await page.mouse.click(p.cx,p.cy);
  message=await page.evaluate(()=>sent.at(-1));near(message,p);assert.equal(message.attack,true,'attack order becomes attack-move on minimap');
  const count=await page.evaluate(()=>sent.length);
  await page.click('[data-command="move"]');await page.mouse.click(q.cx,q.cy,{button:'right'});
  assert.equal(await page.evaluate(()=>sent.length),count,'right-click cancels aiming before ordering');
  // Screen-relative keyboard and edge pan, with no movement after blur.
  const center=await mapPoint(.5,.5);await page.mouse.click(center.cx,center.cy);await page.mouse.move(500,250);
  let before=await target();await page.keyboard.down('ArrowRight');await new Promise(r=>setTimeout(r,120));await page.keyboard.up('ArrowRight');
  assert.ok((await target()).x>before.x,'right arrow pans camera');
  before=await target();await page.mouse.move(999,250);await new Promise(r=>setTimeout(r,120));await page.mouse.move(500,250);
  assert.ok((await target()).x>before.x,'right screen edge pans camera');
  await page.keyboard.down('ArrowRight');await page.evaluate(()=>dispatchEvent(new Event('blur')));await frames();
  before=await target();await frames();near(await target(),before);await page.keyboard.up('ArrowRight');
  await page.evaluate(()=>dispatchEvent(new Event('focus')));
  await page.keyboard.press('Enter');before=await target();await page.keyboard.press('ArrowRight');await frames();near(await target(),before);await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(()=>FOC.view.cameraFootprint().length),4,'camera outline has four map-plane corners');
  await page.screenshot({path:'/tmp/wc3-minimap.png'});
  assert.deepEqual(errors,[]);
  console.log('Minimap navigation, drag, queued orders, camera controls and high-DPI mapping passed');
} finally {await browser.close();}
