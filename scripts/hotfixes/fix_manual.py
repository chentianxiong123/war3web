import json

# 手工映射: 乱码字段路径 -> 正确中文 (从 UTF8 前缀 + 物品上下文推断)
FIXES = {
    ('game.json', '/items/mcou/n'): '勇气勋章',
    ('game.json', '/items/ankh/n'): '重生十字章',
    ('game.json', '/items/tgrh/n'): '小型的大厅',
    ('game.json', '/items/glsk/n'): '古尔丹之颅',
    ('game.json', '/items/crdt/n'): '死亡领主皇冠',
    ('game.json', '/items/stpg/n'): '时钟企鹅',
    ('itemtypes.json', '/mcou/name'): '勇气勋章',
    ('itemtypes.json', '/mcou/tip'): '购买勇气勋章',
    ('itemtypes.json', '/ankh/name'): '重生十字章',
    ('itemtypes.json', '/tgrh/name'): '小型的大厅',
    ('itemtypes.json', '/glsk/name'): '古尔丹之颅',
    ('itemtypes.json', '/glsk/tip'): '购买古尔丹之颅',
    ('itemtypes.json', '/skrt/description'): '灵魂宴会-吞噬者',
    ('itemtypes.json', '/crdt/name'): '死亡领主皇冠',
    ('itemtypes.json', '/stpg/name'): '时钟企鹅',
}

def get_path(o, path):
    for part in path.split('/')[1:]:
        if part.startswith('['):
            o = o[int(part[1:-1])]
        else:
            o = o[part]
    return o

for fname, fixes in {k[0]: {} for k in FIXES}.items():
    p = f'/mnt/shared/war3/foc-web/data/{fname}'
    d = json.load(open(p, encoding='utf-8'))
    n = 0
    for (fn, path), val in FIXES.items():
        if fn != fname: continue
        get_path(d, path)
        o = d
        parts = path.split('/')[1:]
        for part in parts[:-1]:
            if part.startswith('['): o = o[int(part[1:-1])]
            else: o = o[part]
        last = parts[-1]
        o[last] = val
        n += 1
    json.dump(d, open(p, 'w', encoding='utf-8'), ensure_ascii=False)
    print(fname, f'手工修复 {n} 字段')

# 验证
import glob
def is_bad(s):
    if not isinstance(s, str): return False
    return any(ord(c) > 127 for c in s) and not any('\u4e00' <= c <= '\u9fff' for c in s)
tot = 0
for f in sorted(glob.glob('/mnt/shared/war3/foc-web/data/*.json')):
    d = json.load(open(f, encoding='utf-8'))
    def walk(o):
        global tot
        if isinstance(o, dict):
            for v in o.values(): walk(v)
        elif isinstance(o, list):
            for v in o: walk(v)
        elif is_bad(o): tot += 1
    walk(d)
print('剩余总乱码:', tot)