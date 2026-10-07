p = '/mnt/shared/war3/foc-web/client/js/main.js'
s = open(p).read()
old = '''  for (const e of m.s.ents) {
    seen.add(e.i);'''
new = '''  for (const e of m.s.ents) {
    seen.add(e.i);
    if (e.u === 'htow') console.log('DIAG htow raw:', JSON.stringify({ i: e.i, p: e.p, x: e.x, y: e.y }));
    if (e.u === 'hpea') console.log('DIAG hpea raw:', JSON.stringify({ i: e.i, p: e.p }));'''
assert old in s, 'pattern not found'
open(p, 'w').write(s.replace(old, new, 1))
print('client 诊断已加')