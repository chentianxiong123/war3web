// Reproduce wave-induced stalls with actual World ticks, not idle unit counts.
import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { JassEngine } from '../server/jass/engine.js';
import { Grid } from '../server/pathing.js';
function fixture() {
  const world = new World(), engine = new JassEngine(world);
  world.grid = new Grid(new Uint8Array(128 * 64).fill(1),128,64,0,0);
  const unit = (player,x,y) => {
    const u=world.createUnit(engine.players[player],'hfoo',x,y,0);
    u.abilities.clear(); u.controlled=true; u.hp=u.maxHp=1e9; u.hpReg=0;
    return u;
  };
  return {world,unit};
}
function measure(world,ticks) {
  const times=[];
  for(let i=0;i<ticks;i++) { const start=performance.now(); world.step(); times.push(performance.now()-start); }
  times.sort((a,b)=>a-b);
  return {meanMs:+(times.reduce((a,b)=>a+b,0)/ticks).toFixed(2),p95Ms:+times[Math.floor(ticks*.95)].toFixed(2),maxMs:+times.at(-1).toFixed(2)};
}
{
  const {world:w,unit}=fixture();
  for(let y=0;y<64;y++) w.grid.walk[y*128+64]=0;
  const target=unit(5,3000,1000); target.order={type:'hold'};
  const movers=Array.from({length:40},(_,i)=>unit(0,100+i%10*90,100+Math.floor(i/10)*90));
  for(const u of movers) u.order={type:'attack',targetId:target.id};
  const attempts=new Map(), route=w.routeUnit.bind(w);
  w.routeUnit=(u,...args)=>{
    const previous=attempts.get(u.id);
    if(previous!=null) assert.ok(w.now-previous>=400-1e-6,'unreachable pursuit honors retry cooldown');
    attempts.set(u.id,w.now); return route(u,...args);
  };
  const stats=measure(w,90);
  assert.equal(attempts.size,40,'FIFO gives every enemy a search');
  assert.ok(movers.every(u=>u.x<2048),'wall remains solid');
  console.log('40 unreachable pursuers:',JSON.stringify(stats));
  // Opening terrain must invalidate neither a persistent failure cache nor a queue.
  for(let y=0;y<64;y++) w.grid.walk[y*128+64]=1;
  w.grid.invalidate();
  measure(w,30);
  assert.ok(movers.some(u=>u.path?.length),'retry sees newly opened terrain');
}
{
  const {world:w,unit}=fixture();
  let searches=0; const path=w.grid.path.bind(w.grid);
  w.grid.path=(...args)=>{ searches++; return path(...args); };
  const u=unit(0,80,80);
  assert.deepEqual(w.routeUnit(u,3800,1800),[[3800,1800]]);
  assert.equal(searches,0,'clear direct routes bypass A*');
  const units=Array.from({length:40},(_,i)=>unit(0,100+i*40,200));
  for(const v of units) { v.order={type:'move',x:3800,y:1800}; w.requestMovementPath(v,3800,1800); }
  let completed=0; const route=w.routeUnit.bind(w);
  w.routeUnit=(...args)=>{ completed++; return route(...args); };
  w.stepMovementPaths();
  assert.ok(completed<=16,'a wave cannot drain the search queue in one tick');
  const waiting=units.find(v=>w.pendingMovementPaths.has(v));
  assert.ok(waiting);
  w.order(waiting,{type:'stop'});
  assert.equal(w.pendingMovementPaths.has(waiting),false,'new command cancels stale queued route');
  while(w.pendingMovementPaths.size) w.stepMovementPaths();
  assert.equal(waiting.path,null,'stale route cannot undo Stop');
}
{
  const {world:w,unit}=fixture();
  const movers=Array.from({length:400},(_,i)=>unit(0,100+(i%40)*45,100+Math.floor(i/40)*100));
  for(const u of movers) { u.attacksEnabled=0; u.order={type:'move',x:3800,y:u.y}; u.path=[[3800,u.y]]; }
  const stats=measure(w,120);
  assert.ok(movers.some(u=>u.x>1900),'crowded movers still make progress');
  console.log('400 moving units:',JSON.stringify(stats));
}
{
  const grid=new Grid(new Uint8Array(256*256).fill(1),256,256,0,0);
  let visited=0; const walkable=grid.walkable.bind(grid);
  grid.walkable=(...args)=>{ visited++; return walkable(...args); };
  assert.equal(grid.clearFootprint(48,48,8000,8000,12),true);
  assert.ok(visited<4000,'long diagonals inspect a narrow band instead of a bounding rectangle');
}
// Optional real-map stress includes JASS timers and the map's initial roster.
if(process.env.MAP_LOAD === '1') {
  const w=new World(),eng=new JassEngine(w); eng.load(); eng.boot();
  const target=w.createUnit(eng.players[5],'H00N',1500,0,0);
  target.controlled=true; target.order={type:'hold'}; target.hp=target.maxHp=1e9; target.abilities.clear();
  for(let i=0;i<400;i++) {
    const cell=w.grid.nearestWalkable(-2500+i%40*90,-800+Math.floor(i/40)*90);
    if(!cell) continue;
    const [x,y]=w.grid.toWorld(...cell),u=w.createUnit(eng.players[0],'hfoo',x,y,0);
    u.controlled=true; u.order={type:'attack',targetId:target.id}; u.abilities.clear();
  }
  const step=w.step.bind(w); w.step=()=>{eng.update(1000/30);return step();};
  console.log('Real map + 400 attackers:',JSON.stringify(measure(w,120)));
}
console.log('Pathfinding load, retry, queue cancellation and terrain reopening checks passed');
