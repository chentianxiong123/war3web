import sys
p = '/mnt/shared/war3/foc-web/server/room.js'
s = open(p).read()
old = '''    this.bootReport = this.eng.boot();
    console.log(`[${this.id}] map script booted in ${Date.now() - t0}ms: ` +
      `${this.eng.triggers.length} triggers, ${this.eng.timers.length} timers, ` +
      `${this.world.units.size} units, ${this.bootReport.errors.length} errors`);'''
new = '''    this.bootReport = this.eng.boot();
    console.log(`[${this.id}] map script booted in ${Date.now() - t0}ms: ` +
      `${this.eng.triggers.length} triggers, ${this.eng.timers.length} timers, ` +
      `${this.world.units.size} units, ${this.bootReport.errors.length} errors`);
    // 诊断: 单位 owner 分布 (Terenas 接线)
    try {
      const fs = require('fs');
      const dist = {};
      for (const u of this.world.units.values()) dist[u.playerIndex] = (dist[u.playerIndex] || 0) + 1;
      fs.appendFileSync('/tmp/focs_diag.log', new Date().toISOString() + ' owner:' + JSON.stringify(dist) + '\\n');
      const mine = [...this.world.units.values()].filter(u => [0,1].includes(u.playerIndex));
      fs.appendFileSync('/tmp/focs_diag.log', ' p0/1 units: ' + mine.map(u => u.typeKey + '@' + u.playerIndex).slice(0, 20).join(',') + '\\n');
    } catch (e) { console.log('diag fail', e.message); }'''
assert old in s, 'pattern not found'
open(p, 'w').write(s.replace(old, new, 1))
print('diagnostic added')