import assert from 'node:assert/strict';
import { World } from '../server/world.js';
import { Grid } from '../server/pathing.js';
import { JassEngine } from '../server/jass/engine.js';
import { Room } from '../server/room.js';
function setup() {
  const w=new World(),eng=new JassEngine(w);
  w.grid=new Grid(new Uint8Array(64*32).fill(1),64,32,0,0);
  const create=(p,x,y)=>{const u=w.createUnit(eng.players[p],'hfoo',x,y,0);u.controlled=true;u.abilities.clear();u.attacksEnabled=0;u.hp=u.maxHp=100000;u.order={type:'idle'};return u;};
  const u=create(0,80,160),leader=create(0,600,160),enemy=create(5,800,600);
  const tick=n=>{for(let i=0;i<n;i++)w.step();};
  return {w,u,leader,enemy,tick};
}
{
  const {w,u,tick}=setup();
  w.order(u,{type:'move',x:300,y:160});const first=u.order,route=u.path;
  w.order(u,{type:'move',x:300,y:400},true);
  assert.equal(u.order,first);assert.equal(u.path,route,'queueing preserves current movement');
  tick(130);assert.ok(Math.hypot(u.x-300,u.y-400)<1,'waypoints execute in order');
  assert.equal(u.orderQueue.length,0);
  w.order(u,{type:'move',x:1000,y:400});
  for(let i=0;i<35;i++) assert.equal(w.order(u,{type:'move',x:300,y:400},true),true);
  assert.equal(w.order(u,{type:'move',x:500,y:400},true),false,'bounded queue');
  w.order(u,{type:'stop'});assert.equal(u.orderQueue.length,0);assert.equal(u.path,null);
}
{
  const {w,u,enemy,tick}=setup();u.attacksEnabled=1;
  w.order(u,{type:'attack',target:enemy});
  w.order(u,{type:'move',x:80,y:500},true);
  enemy.alive=false;tick(100);
  assert.ok(Math.hypot(u.x-80,u.y-500)<1,'dead attack target advances to queued move before acquisition');
  w.order(u,{type:'move',x:400,y:500});
  w.order(u,{type:'hold'},true);
  w.killUnit(u,null);assert.equal(u.orderQueue.length,0,'death clears queue');
}
{
  const {w,u,leader,enemy,tick}=setup();
  w.order(u,{type:'follow',target:leader});tick(90);
  assert.equal(u.order.type,'follow');assert.ok(Math.hypot(u.x-leader.x,u.y-leader.y)<=90,'follow approaches leader');
  leader.x=1000;tick(90);assert.ok(u.x>850,'follow tracks a moving leader');
  u.attacksEnabled=1;enemy.x=u.x+20;enemy.y=u.y+40;tick(2);
  assert.equal(u.order.type,'follow','follow does not independently acquire nearby enemies');
  leader.order={type:'attack',targetId:enemy.id};tick(1);
  assert.equal(u.order.type,'attack','follower joins leader attack when in range');
  w.order(u,{type:'follow',target:leader});w.order(u,{type:'move',x:80,y:500},true);
  leader.alive=false;tick(150);assert.ok(Math.hypot(u.x-80,u.y-500)<1,'dead leader releases follow queue');
}
{
  const {w,u,leader}=setup();const room=Object.create(Room.prototype);
  room.world=w;room.phase='playing';room.send=()=>{};
  const player={slot:0,entId:u.id};
  room.command(player,{t:'smart',targetId:leader.id,unitIds:[u.id,leader.id]});
  assert.equal(u.order.type,'follow');assert.equal(leader.order.type,'idle','group leader does not follow itself');
  room.command(player,{t:'move',x:400,y:500,unitIds:[u.id],queue:true});
  assert.equal(u.orderQueue.length,1);assert.equal(u.order.type,'follow');
  room.command({slot:5,entId:u.id},{t:'stop',unitIds:[u.id]});
  assert.equal(u.order.type,'follow','queue/follow preserve ownership checks');
}
{
  const {w,u,enemy,tick}=setup();
  u.order={type:'cast'}; u.cast={prior:{type:'attack',targetId:enemy.id}};
  w.order(u,{type:'move',x:300,y:500},true);
  assert.equal(u.order.type,'cast','queued move leaves active cast intact');
  assert.equal(w.snapshot().ents.find(e=>e.i===u.id).q,1,'snapshot exposes queue count');
  w.dropCast(u,u.cast); tick(130);
  assert.ok(Math.hypot(u.x-300,u.y-500)<1,'queued move takes precedence over resumed attack after cast');
}
{
  const {w,u,enemy,tick}=setup(); u.attacksEnabled=1;
  w.order(u,{type:'move',x:200,y:160});
  w.order(u,{type:'stop'},true);
  w.order(u,{type:'attack',target:enemy},true);
  w.order(u,{type:'move',x:200,y:400},true);
  enemy.alive=false; tick(120);
  assert.ok(Math.hypot(u.x-200,u.y-400)<1,'queued Stop and expired target do not strand later waypoints');
}
console.log('Order queues, follow, cancellation, bounded size and ownership passed');
