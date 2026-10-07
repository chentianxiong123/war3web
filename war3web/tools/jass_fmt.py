"""Normalise war3map.j (CR line endings) and report its structure."""
import re, collections
raw = open('extracted/war3map.j', 'rb').read().decode('utf-8', 'replace')
src = raw.replace('\r\n', '\n').replace('\r', '\n')
open('extracted/war3map.formatted.j', 'w').write(src)
lines = src.split('\n')
print('lines: %d' % len(lines))
funcs = re.findall(r'^function\s+(\w+)\s+takes', src, re.M)
print('functions: %d   globals block: %s' % (len(funcs), 'yes' if src.startswith('globals') else 'no'))
kinds = collections.Counter()
for l in lines:
    t = l.strip().split('(')[0].split()
    if t: kinds[t[0]] += 1
print('statement keywords:', dict(kinds.most_common(12)))
