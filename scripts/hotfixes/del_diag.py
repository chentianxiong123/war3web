p = '/mnt/shared/war3/foc-web/client/js/main.js'
s = open(p).read()
old = """    if (e.u === 'htow') console.log('DIAG htow raw:', JSON.stringify({ i: e.i, p: e.p, x: e.x, y: e.y }));
    if (e.u === 'hpea') console.log('DIAG hpea raw:', JSON.stringify({ i: e.i, p: e.p }));"""
assert old in s, 'diag anchor'
open(p, 'w').write(s.replace(old, ''))
print('DIAG 日志已删')