p = '/mnt/shared/war3/foc-web/client/js/main.js'
s = open(p).read()
old = 'window.__S = S;               // 诊断:外部查看游戏状态'
new = '''window.__S = S;               // 诊断:外部查看游戏状态
window.__view = view;             // 诊断:外部投影/点选测试'''
if old in s:
    s = s.replace(old, new, 1)
else:
    # fallback: 在 boot 函数后或文件末尾找 view 定义追加
    old2 = 'window.__S = S;'
    assert old2 in s, 'no __S anchor'
    s = s.replace(old2, new2 := 'window.__S = S;\nwindow.__view = view;', 1)
open(p, 'w').write(s)
print('view 暴露已加')