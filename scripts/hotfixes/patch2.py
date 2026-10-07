p = '/mnt/shared/war3/foc-web/server/room.js'
s = open(p).read()
old = '''      const fs = require('fs');
      const dist = {};'''
new = '''      const dist = {};'''
assert old in s, 'pattern not found'
open(p, 'w').write(s.replace(old, new, 1))
print('fixed: remove require, use existing fs import')