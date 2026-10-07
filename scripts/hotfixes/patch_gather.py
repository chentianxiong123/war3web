import re
p = '/mnt/shared/war3/foc-web/server/world.js'
s = open(p).read()

# 1. step() 里插入 stepGathers + stepTraining 调用 (stepMovementPaths 之后)
old = '''  step() {
    this.now += this.dt * 1000;
    this.tick++;
    this.rebuildBins();
    this.stepMovementPaths();'''
new = '''  step() {
    this.now += this.dt * 1000;
    this.tick++;
    this.rebuildBins();
    this.stepMovementPaths();
    this.stepGathers();
    this.stepTraining();'''
assert old in s, 'step anchor not found'
s = s.replace(old, new, 1)

# 2. order() 加 'train' 支持 (stop/hold 处理之后)
old2 = '''    if (name === 'hold') { u.order = { type: 'hold' }; u.path = null; return true; }'''
new2 = '''    if (name === 'hold') { u.order = { type: 'hold' }; u.path = null; return true; }
    // RTS 训练 (Terenas 官方对战): 建筑训练单位
    if (/train/i.test(name)) {
      const tr = o.trainType || (typeof o.type === 'string' && /^[a-z]{4}$/.test(o.type) ? o.type : null);
      if (!tr || !TRAIN[tr]) return false;
      const ph = this.playerOf(u);
      if (!ph || (ph.gold || 0) < TRAIN[tr].cost) return false;
      u.training = { type: tr, until: this.now + TRAIN[tr].time };
      return true;
    }'''
assert old2 in s, 'order anchor not found'
s = s.replace(old2, new2, 1)

# 3. 加 TRAIN 表 + stepGathers + stepTraining 方法 (放在 order 方法之后找锚点: orderQueue 相关后的某方法前)
old3 = '''  playerOf(u) { return this.jass && u ? this.jass.players[u.playerIndex] : null; }'''
new3 = '''  playerOf(u) { return this.jass && u ? this.jass.players[u.playerIndex] : null; }

  // ---------------------------------------------------------- RTS 经济 (Terenas 官方对战补丁)
  stepGathers() {
    for (const u of this.units.values()) {
      if (!u.alive || u.paused || u.hidden || u.typeKey !== 'hpea' || u.playerIndex > 1) continue;
      const g = u.gather;
      if (g && g.mineId) {
        const mine = this.units.get(g.mineId);
        if (!mine || !mine.alive) { u.gather = null; continue; }
        if (g.phase === 'toMine') {
          if (Math.hypot(u.x - mine.x, u.y - mine.y) < 96) {
            g.phase = 'mining'; g.until = this.now + 1800;   // 挖矿 1.8s
            u.order = { type: 'idle' }; u.path = null;
          } else if (u.order.type !== 'move') {
            this.order(u, { type: 'move', x: mine.x, y: mine.y });
          }
        } else if (g.phase === 'mining') {
          if (this.now >= g.until) {
            const base = [...this.units.values()]
              .find((b) => b.alive && b.typeKey === 'htow' && b.playerIndex === u.playerIndex);
            if (!base) { u.gather = null; continue; }
            g.phase = 'toBase'; g.baseId = base.id;
            this.order(u, { type: 'move', x: base.x, y: base.y });
          }
        } else if (g.phase === 'toBase') {
          const base = this.units.get(g.baseId);
          if (base && Math.hypot(u.x - base.x, u.y - base.y) < 110) {
            const p = this.playerOf(u);
            if (p) p.gold = (p.gold || 0) + 10;              // WC3: 每趟 10 金
            u.gather = { mineId: mine.id, phase: 'toMine' };
          }
        }
      } else if (u.order.type === 'idle' && !u.path) {
        // 空闲农民自动找最近金矿 (WC3 默认行为)
        const mine = [...this.units.values()]
          .filter((m) => m.alive && m.typeKey === 'ngol')
          .sort((a, b) => Math.hypot(a.x - u.x, a.y - u.y) - Math.hypot(b.x - u.x, b.y - u.y))[0];
        if (mine) {
          u.gather = { mineId: mine.id, phase: 'toMine' };
          this.order(u, { type: 'move', x: mine.x, y: mine.y });
        }
      }
    }
  }

  stepTraining() {
    for (const u of this.units.values()) {
      if (!u.alive || u.paused || u.typeKey !== 'htow' || u.playerIndex > 1) continue;
      const tr = u.training;
      if (!tr) continue;
      if (this.now >= tr.until) {
        u.training = null;
        const ph = this.playerOf(u);
        if (ph) ph.gold = (ph.gold || 0) - TRAIN[tr.type].cost;
        const u2 = this.createUnit(ph, tr.type, u.x + (Math.random() - 0.5) * 90, u.y - 100, 180);
        if (this.jass) {
          const k = this.jass.eventId('EVENT_PLAYER_UNIT_TRAIN_FINISH');
          if (k != null) this.jass.fire(k, { unit: u, player: ph, trainedUnit: u2 });
        }
      }
    }
  }'''
assert old3 in s, 'playerOf anchor not found'
s = s.replace(old3, new3, 1)

# 4. TRAIN 常量 (WC3 真实: 费用/训练时间) — 放在 TYPES 声明后
old4 = "export const TYPES = readJSON('data/unittypes.json');"
new4 = '''export const TYPES = readJSON('data/unittypes.json');
// WC3 真实训练数据 (unittypes.json 未提取这些列, 用官方常数)
export const TRAIN = {
  hpea: { cost: 75,  time: 14000 },   // 农民 75金 14s
  hfoo: { cost: 135, time: 21000 },   // 步兵 135金 21s
  harr: { cost: 90,  time: 18000 },   // 弓箭手 90金 18s
};'''
assert old4 in s, 'TYPES anchor not found'
s = s.replace(old4, new4, 1)

open(p, 'w').write(s)
print('world.js 经济补丁已写入')