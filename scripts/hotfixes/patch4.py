p = '/mnt/shared/war3/foc-web/server/room.js'
s = open(p).read()
old = '''    const lb = (this.eng?.leaderboards || []).find((b) => b.rows.length);
    if (!lb) {
      // Terenas 官方对战: 脚本不建计分板, 显示玩家资源 (金币/木材)
      const rows = [];'''
new = '''    const lb = (this.eng?.leaderboards || []).find((b) => b.rows.length);
    if (!lb) {
      if (!this.eng) return null;   // 游戏未开始 (join 时也走到这里)
      // Terenas 官方对战: 脚本不建计分板, 显示玩家资源 (金币/木材)
      const rows = [];'''
assert old in s, 'pattern not found'
open(p, 'w').write(s.replace(old, new, 1))
print('eng 判空已加')