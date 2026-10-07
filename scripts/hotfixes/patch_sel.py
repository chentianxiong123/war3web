p = '/mnt/shared/war3/foc-web/client/js/main.js'
s = open(p).read()
anchor = "window.__trainBtn = (type) => { const uids = commandIds(); if (uids.length) net.send({ t: Msg.TRAIN, trainType: type, unitIds: uids }); };"
add = anchor + "\nwindow.__setSelection = (ids) => setSelection(ids);   // 测试/调试: 选中单位"
if 'window.__setSelection' in s:
    print('already there')
elif anchor in s:
    open(p, 'w').write(s.replace(anchor, add, 1))
    print('setSelection exposed')
else:
    # fallback: 在文件末尾追加 (setSelection 是函数声明, 具名 function 可提升, 但这里是 const 箭头... 用函数声明)
    tail = "\nwindow.__setSelection = (ids) => setSelection(ids);\n"
    open(p, 'a').write(tail)
    print('appended fallback')