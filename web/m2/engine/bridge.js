// 引擎接线桥: 把 foc-web 的 JASS VM + world.js 引擎接进浏览器
// 数据从 ./focdata/ 预加载到 window.__DATA (env.js 同步读), 逻辑零改动
// 注意: 引擎模块(abilities.js 顶层读数据)必须在 loadEngineData 之后才 import, 故用动态 import

const DATA_FILES = [
  'data/unittypes.json', 'data/itemtypes.json', 'data/game.json',
  'data/soundsets.json', 'data/buffart.json', 'data/gameplay.json',
  'data/abilities.json',
  'public/data/terrain.json', 'public/data/walk.bin', 'public/data/fly.bin',
  'public/data/flydestructables.json', 'public/data/destructables.json',
  'public/data/heights.bin',
  'extracted/war3map.wts', 'extracted/war3map.j',
  'war3_extracted/Scripts/common.j', 'war3_extracted/Scripts/Blizzard.j',
];

async function loadEngineData() {
  window.__DATA = {};
  await Promise.all(DATA_FILES.map(async (f) => {
    const r = await fetch('./focdata/' + f);
    if (!r.ok) { console.warn('引擎数据缺失: ' + f); return; }
    window.__DATA[f] = f.endsWith('.bin') ? await r.arrayBuffer() : await r.text();
  }));
}

export async function bootEngine(log) {
  await loadEngineData();
  const { JassEngine } = await import('./engine.js');
  const { World } = await import('./world.js');
  const world = new World();
  const eng = new JassEngine(world);
  eng.load();
  // 玩家槽位: 前 2 个为真人 (仿 room.start, 必须在 boot 前设置)
  for (let i = 0; i < 2 && i < eng.players.length; i++) {
    const ph = eng.players[i];
    ph.name = 'Player' + (i + 1);
    ph.controller = 0;      // MAP_CONTROL_USER
    ph.slotState = 1;       // PLAYING
  }
  const t0 = performance.now();
  const report = eng.boot();
  log(`🧩 引擎启动 ${Math.round(performance.now() - t0)}ms: ${eng.triggers.length} triggers, ` +
      `${eng.timers.length} timers, ${world.units.size} 单位, ${report.errors.length} errors`);
  if (report.errors.length) console.warn('boot errors:', report.errors.slice(0, 5));
  return { world, eng };
}

// 每帧驱动: eng.update(ms) -> world.step() 产出事件 (仿 room.stepLoop)
export function startTick(world, eng, log) {
  let last = performance.now();
  setInterval(() => {
    const now = performance.now();
    const dt = Math.min(50, now - last);
    last = now;
    try {
      eng.update(dt);
      const events = world.step();
      if (events.length) log(`⚔️ tick 事件: ${events.map(e => e.t).slice(0, 6).join(',')}`);
    } catch (e) { console.error('tick error:', e); }
  }, 16);
}
