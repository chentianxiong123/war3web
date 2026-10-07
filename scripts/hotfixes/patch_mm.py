p = '/mnt/shared/war3/foc-web/client/style.css'
s = open(p).read()
old = "#minimap{position:absolute;left:10px;bottom:10px;border:1px solid var(--line);\n  border-radius:8px;overflow:hidden;background:#05060a}"
new = "#minimap{position:absolute;left:12px;bottom:12px;width:248px;height:150px;border:1px solid var(--line);\n  border-radius:8px;overflow:hidden;background:#05060a}"
assert old in s, 'css anchor'
open(p, 'w').write(s.replace(old, new, 1))
print('minimap 容器固定尺寸 248x150')