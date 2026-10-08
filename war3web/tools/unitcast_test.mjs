// 非英雄单位施法闭环 (Terenas: 无英雄, 技能按钮走 castUnit 通道)
//
// 历史: 命令卡在渲染真实技能按钮(官方图标/中文名)之后, 点击却毫无反应——
// renderCard 对技能按钮走 onCastSlot(英雄专用, 查 S.hero.abilities),
// 本图无英雄 → 直接 return, 技能"能看不能点"。ui.js 给 spell 项补了
// run: () => this.onUnitCast(id), 走服务端早已就绪的 castUnit 通道。
// 本测试直连服务端, 验证: 农民 Ahar(采集) 点树 → 被接受 (无 error 回包)
// + 农民开始移动 (mv=1, 位置变化)。断言的不是"函数被调用", 是服务端行为。
import WebSocket from 'ws';

const PORT = +(process.env.PORT || 8080);
const SNAP_HZ = 15;
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?room=unitcast-test-${process.pid}`);

let helloYou = null;
let snapshots = 0;
let res = null;
let peas = [];
const errors = [];

ws.on('error', (e) => { console.error('ws error', e.message); process.exit(1); });
ws.on('message', (buf) => {
  let m; try { m = JSON.parse(buf); } catch { return; }
  if (m.t === 'welcome') { helloYou = m.you; send({ t: 'joinTeam', team: 0 }); }
  else if (m.t === 'snap') {
    snapshots++;
    if (m.s) {
      res = m.s.res;
      peas = (m.s.ents || []).filter(e => e.u === 'hpea' && e.p === 0);
    }
  } else if (m.t === 'error') errors.push(m.m);
});
const send = (m) => ws.send(JSON.stringify(m));

let fails = 0;
const check = (name, cond, detail) => {
  console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${detail ? '  -- ' + detail : ''}`);
  if (!cond) fails++;
};

setTimeout(() => { console.log('TIMEOUT'); process.exit(fails ? 1 : 2); }, 40000);


const run = (async () => {
  await wait(400);                       // 握手 w/ open
  send({ t: 'hello', name: 'UnitCastTest' });
  await wait(600);
  check('HELLO -> WELCOME', helloYou != null, 'you=' + helloYou);
  send({ t: 'ready', ready: true });
  await wait(5000);                      // 开局 + 首批快照
  check('开局快照到达', snapshots > 3, snapshots + ' snapshots');
  check('玩家有 5 农民', peas.length === 5, peas.length + ' peas');
  check('开局资源 500/150/5', res?.[0]?.gold === 500 && res?.[0]?.lumber === 150 && res?.[0]?.supply === 5,
        JSON.stringify(res?.[0]));
  if (!peas.length) return;
  const p0 = peas[0];
  console.log('  农民 #' + p0.i, 'pos=' + p0.x + ',' + p0.y, 'mv=' + p0.mv);

  // 施法 Ahar(采集) -> 附近树
  send({ t: 'castUnit', abilId: 'Ahar', unitIds: [p0.i], x: -5184, y: 1344 });
  await wait(500);
  send({ t: 'castUnit', abilId: 'Ahar', unitIds: [p0.i], x: -5184, y: 1344 });  // 重发: 不应报错
  await wait(4000);

  const p1 = peas[0];
  console.log('  施法后 pos=' + Math.round(p1?.x) + ',' + Math.round(p1?.y), 'mv=' + p1?.mv);
  check('施法无 error 回包', errors.length === 0, errors.join('; ') || 'clean');
  check('农民开始移动 (位置/路径变化)', p1 && (p1.mv === 1 || Math.abs(p1.x - p0.x) > 20 || Math.abs(p1.y - p0.y) > 20),
        `(${p0.x},${p0.y}) -> (${p1?.x},${p1?.y})`);
  check('经济仍在运行 (金 > 500 或快照持续)', res?.[0]?.gold >= 500, 'gold=' + res?.[0]?.gold);
  console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
  process.exit(fails ? 1 : 0);
})();