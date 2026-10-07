import json, os, sys, glob

def fix_str(s):
    """乱码字符串 (UTF8 字节被 latin-1 存的) -> 还原 UTF8. 正常字符串不动."""
    if not isinstance(s, str):
        return s
    try:
        b = s.encode('latin-1')
        d = b.decode('utf-8')
        # 转换成功且明显是"乱码形态"才替换: 原串含 >127 的字符且无 CJK
        has_high = any(ord(c) > 127 for c in s)
        if has_high and '\u4e00' > d[0] and any('\u4e00' <= c <= '\u9fff' for c in d):
            return d
        return s
    except Exception:
        return s

def fix_obj(o):
    if isinstance(o, dict):
        return {k: fix_obj(v) for k, v in o.items()}
    if isinstance(o, list):
        return [fix_obj(v) for v in o]
    return fix_str(o)

root = '/mnt/shared/war3/foc-web/data'
total = 0
for f in sorted(glob.glob(root + '/*.json')):
    try:
        d = json.load(open(f, encoding='utf-8'))
    except Exception as e:
        print('skip', os.path.basename(f), e)
        continue
    fixed = fix_obj(d)
    if fixed != d:
        json.dump(fixed, open(f, 'w', encoding='utf-8'), ensure_ascii=False)
        print('fixed:', os.path.basename(f))
        total += 1
print('done,', total, 'files fixed')