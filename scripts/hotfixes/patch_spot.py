p = '/mnt/shared/war3/foc-web/server/world.js'
s = open(p).read()

# stepGathers 里: 用可走点探测替代固定偏移 (+90/-90 撞到碰撞也卡)
old = '''        if (g.phase === 'toMine') {
          if (Math.hypot(u.x - mine.x, u.y - mine.y) < 130) {
            g.phase = 'mining'; g.until = this.now + 1800;   // 挖矿 1.8s
            u.order = { type: 'idle' }; u.path = null;
          } else if (u.order.type !== 'move') {
            this.order(u, { type: 'move', x: mine.x + 90, y: mine.y - 90 });
          }'''
new = '''        if (g.phase === 'toMine') {
          if (Math.hypot(u.x - mine.x, u.y - mine.y) < 140) {
            g.phase = 'mining'; g.until = this.now + 1800;   // 挖矿 1.8s
            u.order = { type: 'idle' }; u.path = null;
          } else if (u.order.type !== 'move') {
            const sp = this.walkSpotNear(mine.x, mine.y, u);
            if (sp) this.order(u, { type: 'move', x: sp[0], y: sp[1] });
          }'''
assert old in s, 'toMine anchor'
s = s.replace(old, new, 1)

old2 = '''      } else if (g.phase === 'toBase') {
          const base = this.units.get(g.baseId);
          if (base && Math.hypot(u.x - base.x, u.y - base.y) < 110) {
            const p = this.playerOf(u);
            if (p) p.gold = (p.gold || 0) + 10;              // WC3: 每趟 10 金
            u.gather = { mineId: mine.id, phase: 'toMine' };
          }
        }'''
new2 = '''      } else if (g.phase === 'toBase') {
          const base = this.units.get(g.baseId);
          if (base && Math.hypot(u.x - base.x, u.y - base.y) < 140) {
            const p = this.playerOf(u);
            if (p) p.gold = (p.gold || 0) + 10;              // WC3: 每趟 10 金
            u.gather = { mineId: mine.id, phase: 'toMine' };
          }
        }'''
assert old2 in s, 'toBase anchor'
s = s.replace(old2, new2, 1)

# 加 walkSpotNear 方法 (找目标附近可走点, 递增探测)
old3 = '''  stepTraining() {'''
new3 = '''  // 找 (cx,cy) 附近第一个可走的点 (递增半径探测)
  walkSpotNear(cx, cy, u) {
    const grid = this.movementGrid(u);
    const offs = [[-80, -80], [80, -80], [-80, 80], [80, 80],
                  [0, -120], [0, 120], [-120, 0], [120, 0],
                  [-130, -130], [130, -130], [-130, 130], [130, 130],
                  [0, -160], [0, 160], [-160, 0], [160, 0]];
    for (const [dx, dy] of offs) {
      const x = cx + dx, y = cy + dy;
      if (grid.clearFootprint(x, y, x, y, u.radius)) return [x, y];
    }
    return null;   // 全不可走 (不该发生)
  }

  stepTraining() {'''
assert old3 in s, 'stepTraining anchor'
s = s.replace(old3, new3, 1)

open(p, 'w').write(s)
print('可走点探测已写入')