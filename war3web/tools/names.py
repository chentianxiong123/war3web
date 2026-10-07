import os, re, sys, json, collections
sys.path.insert(0, os.path.dirname(__file__))
from mpq import MPQ, hash_string, HASH_FILE_KEY, crack_key, FLAG_ENCRYPTED, FLAG_COMPRESS, FLAG_IMPLODE

from mapfile import MAP
m = MPQ(MAP)
used = sorted({e[4] for e in m.hash_table if e[4] != 0xFFFFFFFF and e[3] != 0xFFFF})
blocks, keys = {}, {}
for bi in used:
    pos, cs, fs, fl = m.block_table[bi]
    if fl & FLAG_ENCRYPTED and fl & (FLAG_COMPRESS | FLAG_IMPLODE):
        nsec = (fs + m.sector_size - 1) // m.sector_size
        k = crack_key(m.raw[m.base+pos:m.base+pos+8], m.sector_size, nsec + 1)
        if k is not None: keys[bi] = (k + 1) & 0xFFFFFFFF
    d = m.read_block_cracked(bi)
    if d is not None: blocks[bi] = d
want = {k: bi for bi, k in keys.items()}

STR = re.compile(rb"[\x20-\x7E]{3,120}")
raw_strings = set()
for d in blocks.values():
    for mt in STR.finditer(d):
        s = mt.group(0).decode('latin-1')
        raw_strings.add(s)
        # split on separators that commonly bound a path inside binary blobs
        for part in re.split(r'[\x00",;<>|*?]+', s):
            part = part.strip()
            if part: raw_strings.add(part)

raw_strings |= set("""war3map.w3e war3map.w3i war3map.wpm war3map.doo war3mapUnits.doo
war3map.w3r war3map.w3c war3map.w3s war3map.w3u war3map.w3t war3map.w3b war3map.w3d
war3map.w3a war3map.w3h war3map.w3q war3map.wts war3map.shd war3map.mmp war3map.j
war3map.imp war3mapMap.blp war3mapMap.b00 war3mapPreview.tga war3mapPreview.blp
war3map.wtg war3map.wct war3map.w3o war3map.w3v war3mapMisc.txt war3mapSkin.txt
war3mapExtra.txt conversation.json (listfile) (attributes) (signature)
war3mapMap.tga war3mapPath.tga common.j blizzard.j war3map.dat""".split())

EXTS = ['.mdx', '.mdl', '.blp', '.tga', '.mp3', '.wav', '.txt', '.json']
def variants(s):
    s = s.replace('/', '\\')
    base = s.split('\\')[-1]
    yield base
    root, ext = os.path.splitext(base)
    if ext.lower() in ('.mdl', '.mdx'):
        yield root + '.mdx'; yield root + '.mdl'
    if ext.lower() in ('.tga', '.blp', '.dds'):
        yield root + '.blp'; yield root + '.tga'
    if not ext:
        for e in EXTS: yield base + e
    # trailing-garbage trim: many object-data fields are fixed width
    for cut in range(1, min(len(base), 12)):
        yield base[:-cut]

found = {}
tested = set()
for s in raw_strings:
    for v in variants(s):
        if not v or v in tested: continue
        tested.add(v)
        k = hash_string(v, HASH_FILE_KEY)
        if k in want and want[k] not in found:
            found[want[k]] = v
print('tested %d candidate names, newly resolved %d of %d blocks' % (len(tested), len(found), len(keys)))
unresolved = [bi for bi in keys if bi not in found]
print('unresolved:', len(unresolved))
for bi in unresolved[:8]:
    print('  block', bi, blocks[bi][:4], len(blocks[bi]))
json.dump({str(k): v for k, v in found.items()}, open('extracted/_names.json', 'w'), indent=1)
