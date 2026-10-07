import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { CHROME } from './chrome.mjs';
const browser=await puppeteer.launch({executablePath:CHROME,headless:true,args:['--no-sandbox','--enable-unsafe-swiftshader','--use-gl=swiftshader','--disable-dev-shm-usage'],defaultViewport:{width:1280,height:800}});
try {
  const page=await browser.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${process.env.PORT||8077}/?room=alerts-${Date.now()}`);
  await page.waitForFunction(()=>window.FOC?.S.booted && !document.getElementById('lobby').classList.contains('hidden'),{timeout:90000});
  await page.click('.hcard[data-id="H00C"]');await page.click('#btnReady');
  await page.waitForFunction(()=>FOC.S.hero && FOC.S.ents.has(FOC.S.hero.id),{timeout:60000});
  const frames=()=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  await frames();
  await page.evaluate(()=>{FOC.net.ws.onmessage=()=>{};window.sent=[];FOC.net.send=m=>{if(m.t!=='ping')sent.push(m);};});
  await page.mouse.move(500,250);
  const target=()=>page.evaluate(()=>({x:FOC.view.camTarget.x,y:-FOC.view.camTarget.z}));
  const near=(a,b)=>assert.ok(Math.hypot(a.x-b.x,a.y-b.y)<1,JSON.stringify({a,b}));
  await page.evaluate(()=>{
    const {S,net}=FOC;
    window.emit=ev=>net.handlers.get('event')({ev:[ev]});
    window.unit=(id,x,y,p,t,k=2)=>S.ents.set(id,{i:id,x,y,p,t,k});
    window.team=S.ents.get(S.hero.id).t;
    unit(990001,100,200,S.slot,team);
    unit(990002,200,200,99,team===0?1:0);
    unit(990003,300,400,98,team);
  });
  // Empty history leaves camera alone, even when hero is selected.
  let before=await target();await page.keyboard.press('Space');near(await target(),before);
  await page.evaluate(()=>{
    emit({t:'dmg',id:990001,src:990003,amt:20}); // friendly
    emit({t:'dmg',id:990001,src:990002,amt:0});
    emit({t:'dmg',id:990002,src:990001,amt:20}); // enemy victim
  });
  await page.keyboard.press('Space');near(await target(),before);
  await page.evaluate(()=>emit({t:'dmg',id:990001,src:990002,amt:20}));
  await page.keyboard.press('Space');near(await target(),{x:100,y:200});
  await page.evaluate(()=>{
    FOC.S.ents.get(990001).x=300;
    emit({t:'dmg',id:990001,src:990002,amt:20});
    unit(990004,-400,-500,98,team,1);
    emit({t:'death',id:990004});
    FOC.S.ents.delete(990004);
  });
  // Recall an empty group: Space must work without a hero selection.
  await page.keyboard.press('9');
  await page.keyboard.press('Space');near(await target(),{x:-400,y:-500});
  await page.evaluate(()=>dispatchEvent(new KeyboardEvent('keydown',{key:' ',code:'Space',repeat:true})));
  near(await target(),{x:-400,y:-500});
  await page.keyboard.press('Space');near(await target(),{x:100,y:200});
  await page.keyboard.press('Space');near(await target(),{x:-400,y:-500});
  await page.keyboard.press('F10');await page.keyboard.press('Space');near(await target(),{x:-400,y:-500});await page.keyboard.press('Escape');
  await page.keyboard.press('Enter');await page.keyboard.press('Space');near(await target(),{x:-400,y:-500});await page.keyboard.press('Escape');
  await page.evaluate(()=>FOC.S.cinematic=true);
  await page.keyboard.press('Space');near(await target(),{x:-400,y:-500});
  await page.evaluate(()=>{FOC.S.cinematic=false;FOC.view.panTo(0,0,10);});
  await page.keyboard.press('Space');near(await target(),{x:100,y:200});
  assert.equal(await page.evaluate(()=>FOC.view.scriptPan),null);
  assert.equal(await page.evaluate(()=>sent.length),0,'alert navigation never issues unit orders');
  const voices = await page.evaluate(async()=>{
    const {S,audio}=FOC, played=[];
    audio.playUI=(path,vol,flags)=>played.push({path,vol,flags});
    const fire=(x,building=false)=>{
      unit(990005,x,0,S.slot,team);
      S.ents.get(990005).isBuilding=building;
      emit({t:'dmg',id:990005,src:990002,amt:20});
    };
    S.hero.race='human';
    fire(3000); fire(3000); // only accepted alerts speak
    fire(5000,true);
    S.hero.race='unknown';fire(7000);
    const keys=['UnderAttackHuman','TownAttackHuman','UnderAttackGeneric'];
    return {
      count:played.length,
      matches:keys.map((k,i)=>S.uiSounds[k].files.includes(played[i]?.path) &&
        S.uiSounds[k].vol===played[i]?.vol &&
        JSON.stringify(S.uiSounds[k].flags)===JSON.stringify(played[i]?.flags)),
      statuses:await Promise.all(keys.flatMap(k=>S.uiSounds[k].files).map(f=>fetch('/assets/'+f).then(r=>r.status)))
    };
  });
  assert.equal(voices.count,3,'suppressed alerts do not play additional voices');
  assert.deepEqual(voices.matches,[true,true,true],'race, building, fallback and table parameters');
  assert.ok(voices.statuses.every(s=>s===200),'advisor audio files are served');
  await page.screenshot({path:'/tmp/wc3-alerts.png'});
  assert.deepEqual(errors,[]);
  console.log('Alert event filtering, saved positions, Space cycling and modal guards passed');
} finally {await browser.close();}
