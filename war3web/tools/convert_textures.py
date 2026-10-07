import os, sys, glob, json, traceback
sys.path.insert(0, os.path.dirname(__file__))
from blp import decode
from PIL import Image
import numpy as np

ROOTS = [('extracted', ''), ('war3_extracted', '')]
DST = 'assets/textures'
ok, fail, index = 0, [], {}
srcs = []
for root, pref in ROOTS:
    for p in glob.glob(root + '/**/*.*', recursive=True):
        if os.path.splitext(p)[1].lower() in ('.blp', '.tga'):
            srcs.append((p, os.path.join(pref, os.path.relpath(p, root))))
for p, rel in srcs:
    ext = os.path.splitext(p)[1].lower()
    out = os.path.join(DST, os.path.splitext(rel)[0] + '.png')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    try:
        if ext == '.blp':
            rgba = decode(open(p, 'rb').read())
            im = Image.fromarray(rgba, 'RGBA')
        else:
            im = Image.open(p).convert('RGBA')
        if np.asarray(im)[:, :, 3].min() == 255:
            im = im.convert('RGB')
        im.save(out, optimize=True)
        index[rel.replace(os.sep, '\\').lower()] = os.path.relpath(out, 'assets').replace(os.sep, '/')
        ok += 1
    except Exception as e:
        fail.append((rel, str(e)))
os.makedirs('assets', exist_ok=True)
json.dump(index, open('assets/textures.json', 'w'), indent=1)
print('converted %d textures, %d failed' % (ok, len(fail)))
for f in fail[:15]: print('  FAIL', f)
