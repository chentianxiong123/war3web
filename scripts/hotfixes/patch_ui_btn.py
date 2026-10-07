p = '/mnt/shared/war3/foc-web/client/js/ui.js'
s = open(p).read()
anchor = "export class UI {" if 'export class UI' in s else None
# 找类定义的起始, 在文件顶部加常量
if 'const TRAIN_BUTTONS' in s:
    print('already there')
else:
    head = "// RTS 训练按钮 (Terenas 官方对战): type / 名称 / 费用\nconst TRAIN_BUTTONS = [['hpea', '农民', 75], ['hfoo', '步兵', 135], ['harr', '弓箭手', 90]];\n\n"
    # 找到第一个 import/export 或第一个非注释行
    lines = s.split('\n')
    idx = 0
    for i, ln in enumerate(lines):
        if ln.startswith('import ') or (i > 0 and ln.startswith('export ')):
            idx = i
            break
    else:
        idx = 0
    lines.insert(idx, head)
    open(p, 'w').write('\n'.join(lines))
    print('TRAIN_BUTTONS added to ui.js top')