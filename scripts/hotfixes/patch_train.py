import re

# 1. const.js: Msg 加 TRAIN
p = '/mnt/shared/war3/foc-web/shared/const.js'
s = open(p).read()
old = "  MOVE: 'move', STOP: 'stop', ATTACK: 'attack', CAST: 'cast',"
new = "  MOVE: 'move', STOP: 'stop', ATTACK: 'attack', CAST: 'cast', TRAIN: 'train',"
assert old in s, 'const anchor'
open(p, 'w').write(s.replace(old, new, 1))
print('1. const.js TRAIN 已加')

# 2. room.js: command() 支持 train
p = '/mnt/shared/war3/foc-web/server/room.js'
s = open(p).read()
old = '''    if ([Msg.MOVE, Msg.STOP, 'hold', Msg.ATTACK, 'smart'].includes(m.t)) {'''
new = '''    if (m.t === Msg.TRAIN) {
      // RTS 训练: 选中建筑 -> 训练单位 (Terenas 官方对战)
      const ids = m.unitIds === undefined ? [p.entId] : Array.isArray(m.unitIds) ? m.unitIds.slice(0, 4) : [];
      for (const id of ids) {
        const unit = Number.isInteger(id) && this.world.units.get(id);
        if (!unit || unit.playerIndex !== p.slot || !unit.alive) continue;
        this.world.order(unit, { type: 'train', trainType: m.trainType });
      }
      return;
    }
    if ([Msg.MOVE, Msg.STOP, 'hold', Msg.ATTACK, 'smart'].includes(m.t)) {'''
assert old in s, 'room anchor'
open(p, 'w').write(s.replace(old, new, 1))
print('2. room.js train 已加')

# 3. ui.js: renderSelected 里 htow 显示训练按钮
p = '/mnt/shared/war3/foc-web/client/js/ui.js'
s = open(p).read()
old = '''    if (this.canCommand?.(ent)) this.renderAbilities({ alive: !!ent.a, abilities: [], skillPoints: 0 });
    else $('abilities').replaceChildren();
  }'''
new = '''    if (this.canCommand?.(ent)) {
      if (ent.u === 'htow') {
        // RTS 训练面板 (Terenas 官方对战): 城镇大厅训练单位
        const ab = $('abilities');
        ab.replaceChildren(...TRAIN_BUTTONS.map(([type, name, cost]) => {
          const b = document.createElement('button');
          b.className = 'train-btn';
          b.textContent = `${name} (${cost}金)`;
          b.onclick = () => window.__trainBtn && window.__trainBtn(type);
          return b;
        }));
      } else {
        this.renderAbilities({ alive: !!ent.a, abilities: [], skillPoints: 0 });
      }
    }
    else $('abilities').replaceChildren();
  }

  /** 训练按钮配置: type / 名称 / 费用 (与 server/world.js TRAIN 表一致) */
  static TRAIN_SETUP() { return TRAIN_BUTTONS; }'''
assert old in s, 'ui anchor'
open(p, 'w').write(s.replace(old, new, 1))
print('3. ui.js 训练按钮已加')

# 4. main.js: __trainBtn + 全局按钮表
p = '/mnt/shared/war3/foc-web/client/js/main.js'
s = open(p).read()
old = 'window.__view = view;             // 诊断:外部投影/点选测试'
new = '''window.__view = view;             // 诊断:外部投影/点选测试
const TRAIN_BUTTONS = [['hpea', '农民', 75], ['hfoo', '步兵', 135], ['harr', '弓箭手', 90]];
window.__trainBtn = (type) => { const uids = commandIds(); if (uids.length) net.send({ t: Msg.TRAIN, trainType: type, unitIds: uids }); };'''
if old not in s:
    old = 'window.__S = S;'
    assert old in s, 'main anchor'
    s = s.replace(old, old + '\nwindow.__view = view;\nconst TRAIN_BUTTONS = [["hpea", "农民", 75], ["hfoo", "步兵", 135], ["harr", "弓箭手", 90]];\nwindow.__trainBtn = (type) => { const uids = commandIds(); if (uids.length) net.send({ t: Msg.TRAIN, trainType: type, unitIds: uids }); };', 1)
else:
    s = s.replace(old, new, 1)
open(p, 'w').write(s)
print('4. main.js 训练发送已加')