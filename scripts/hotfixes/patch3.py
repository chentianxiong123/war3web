p = '/mnt/shared/war3/foc-web/server/room.js'
s = open(p).read()
old = '''    const lb = (this.eng?.leaderboards || []).find((b) => b.rows.length);
    if (!lb) return null;
    return { kind: 'leaderboard', title: lb.title,
             rows: lb.rows.map((r) => ({ label: r.label, value: r.value, p: r.p })) };
  }'''
new = '''    const lb = (this.eng?.leaderboards || []).find((b) => b.rows.length);
    if (!lb) {
      // Terenas 官方对战: 脚本不建计分板, 显示玩家资源 (金币/木材)
      const rows = [];
      for (const p of this.players.values()) {
        const ph = this.eng.players[p.slot];
        rows.push({ label: p.name,
                    gold: Math.round(ph?.gold ?? 0),
                    lumber: Math.round(ph?.lumber ?? 0) });
      }
      const teams = rows.map((r) => ({ label: r.label, value: r.gold }));
      return { kind: 'multiboard', title: 'Terenas Stand', cols: ['Player', 'Gold', 'Lumber'],
               rows: rows.map((r) => [r.label, r.gold, r.lumber]), teams };
    }
    return { kind: 'leaderboard', title: lb.title,
             rows: lb.rows.map((r) => ({ label: r.label, value: r.value, p: r.p })) };
  }'''
assert old in s, 'pattern not found'
open(p, 'w').write(s.replace(old, new, 1))
print('资源板已加')