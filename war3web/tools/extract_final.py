import os, re, sys, json, collections
sys.path.insert(0, os.path.dirname(__file__))
from mpq import MPQ, hash_string, HASH_FILE_KEY, crack_key, FLAG_ENCRYPTED, FLAG_COMPRESS, FLAG_IMPLODE

OUT = 'extracted'
from mapfile import MAP
m = MPQ(MAP)
used = sorted({e[4] for e in m.hash_table if e[4] != 0xFFFFFFFF and e[3] != 0xFFFF})
blocks = {}
for bi in used:
    d = m.read_block_cracked(bi)
    if d is not None:
        blocks[bi] = d
names = {int(k): v for k, v in json.load(open('extracted/_names.json')).items()}

# recover directory prefixes from full paths present in the data
PATH_RE = re.compile(rb"[A-Za-z0-9_\-\.\\/ \(\)\[\]!&'#@+,~]{2,200}\."
                     rb"(mdx|mdl|blp|tga|mp3|wav|txt|json|j|doo|w3[eiuptabdhqcrsov]|wts|wtg|wct|shd|mmp|wpm|imp)", re.I)
full = {}
for d in blocks.values():
    for mt in PATH_RE.finditer(d):
        s = mt.group(0).decode('latin-1').strip().replace('/', '\\').lstrip('\\')
        if '\\' in s:
            full.setdefault(s.split('\\')[-1].lower(), s)

INTERNAL = re.compile(r'^(war3map|war3mapmap|war3mappreview|war3mapunits|war3mapmisc|war3mapskin|war3mapextra|conversation|\(|scripts)', re.I)
manifest, stats = [], collections.Counter()
for bi, d in sorted(blocks.items()):
    n = names.get(bi)
    if n:
        path = full.get(n.lower(), n)
        if '\\' not in path and not INTERNAL.match(path):
            path = 'war3mapImported\\' + path
    else:
        h = d[:4]
        ext = ('.mdx' if h == b'MDLX' else '.blp' if h[:3] == b'BLP' else
               '.mp3' if h[:3] == b'ID3' or h[:2] == b'\xff\xfb' else '.bin')
        path = 'war3mapImported\\_unnamed_%03d%s' % (bi, ext)
    p = os.path.join(OUT, path.replace('\\', os.sep))
    os.makedirs(os.path.dirname(p) or '.', exist_ok=True)
    open(p, 'wb').write(d)
    stats[os.path.splitext(path)[1].lower()] += 1
    manifest.append(dict(block=bi, path=path, size=len(d), name_recovered=bool(n)))
json.dump(manifest, open(os.path.join(OUT, 'manifest.json'), 'w'), indent=1)
print('extracted %d files' % len(manifest))
for e, c in stats.most_common(): print('  %-6s %d' % (e or '(none)', c))
