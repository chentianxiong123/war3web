"""Bake the ground texture from Warcraft III's real tileset art + the map's tile data.

Ground textures are atlases of 64x64 variations (4x4, or 8x4 for the extended ones).
war3map.w3e gives, per terrain vertex, the ground-texture index and a details byte
that selects which variation is drawn.
"""
import json, os
import numpy as np
from PIL import Image

SUB = 64          # source variation size inside the atlas
# Texels per terrain cell in the baked map. This was 32, which resampled
# Blizzard's own 64x64 variations down to half size and threw the other half
# away -- and it showed against the cliffs, which carry a 256px texture over a
# single 128-unit cell and so stayed eight times sharper than the ground they
# meet. 64 is the source art's own resolution: no loss, and nothing invented.
# Going higher would only upscale, which adds file size and no detail.
PX = int(os.environ.get('FOC_GROUND_PX', '64'))

# tileID -> (directory, file) for every tileset, straight from TerrainArt\Terrain.slk
def _terrain_table():
    import sys as _s
    _s.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from slk import parse_slk
    p = 'war3_extracted/TerrainArt/Terrain.slk'
    if not os.path.exists(p):
        return {}
    out = {}
    for r in parse_slk(p):
        tid = str(r.get('tileID') or '')
        d = str(r.get('dir') or '').replace('\\', '/')
        f = str(r.get('file') or '')
        if tid and d and f:
            out[tid] = (d, f)
    return out

TERRAIN = _terrain_table()

def atlas_path(tile_id):
    e = TERRAIN.get(tile_id)
    if not e:
        return None
    d, f = e
    return os.path.join('assets/textures', d, f + '.png')

def load_atlas(tile_id):
    """Every variation of a tileset atlas, RGBA -- the alpha carries the blend mask."""
    p = atlas_path(tile_id)
    if not p or not os.path.exists(p): return None
    im = Image.open(p).convert('RGBA')
    w, h = im.size
    cols, rows = w // SUB, h // SUB
    a = np.asarray(im)
    tiles = [a[r*SUB:(r+1)*SUB, c*SUB:(c+1)*SUB] for r in range(rows) for c in range(cols)]
    return tiles, cols


# A tileset atlas is a grid of 64x64 variations.  Slot 0 is the plain interior
# tile; the rest are the corner-blend masks Warcraft III feathers one texture
# into another with.  Read off the alpha of the real art, the index decomposes
# as: the row selects the top corners, the column the bottom ones.
TL, TR, BL, BR = 8, 4, 2, 1

def mask_slot(mask, cols):
    return (mask >> 2) * cols + (mask & 3)

def bake(out='assets/textures/_ground.png'):
    t = json.load(open('data/terrain.json'))
    W, H = t['width'], t['height']
    from cliffs import cliff_types
    from terrain_surface import ground_indices
    with open('data/cliffs.json') as f:
        cliff_spec = json.load(f)
    ground, tex = ground_indices(t, cliff_spec, cliff_types())
    det = np.array(t['detail'], np.uint8).reshape(H, W)
    atlases, ncols, misses = {}, {}, []
    for i, tid in enumerate(ground):
        a = load_atlas(tid)
        if a is None:
            misses.append(tid); atlases[i] = None; ncols[i] = 4
        else:
            atlases[i], ncols[i] = a
    cw, ch = W - 1, H - 1
    img = np.zeros((ch * PX, cw * PX, 3), np.uint8)

    cache = {}
    def sub(ti, var):
        """One variation, resized to a cell, as float RGBA."""
        key = (ti, var)
        if key in cache: return cache[key]
        a = atlases.get(ti)
        if not a:
            v = np.dstack([np.full((PX, PX, 3), 110, np.float32),
                           np.full((PX, PX, 1), 255, np.float32)])
        else:
            im = Image.fromarray(a[var % len(a)]).resize((PX, PX), Image.LANCZOS)
            v = np.asarray(im).astype(np.float32)
        cache[key] = v
        return v

    # Warcraft III paints a cell by stacking its corner textures in tileset
    # order: the lowest one fills the cell, then each higher one is laid over it
    # through the blend mask for the corners it occupies.  Drawing only slot 0
    # leaves every boundary a hard square edge.
    blended = 0
    for j in range(ch):
        src_j = ch - 1 - j                    # w3e row 0 is the south edge
        for i in range(cw):
            c = {TL: int(tex[src_j + 1, i]),     TR: int(tex[src_j + 1, i + 1]),
                 BL: int(tex[src_j, i]),         BR: int(tex[src_j, i + 1])}
            order = sorted(set(c.values()))
            base = sub(order[0], 0)[..., :3].copy()
            if len(order) > 1:
                blended += 1
                for ti in order[1:]:
                    mask = 0
                    for bit, t in c.items():
                        if t == ti: mask |= bit
                    over = sub(ti, mask_slot(mask, ncols.get(ti, 4)))
                    al = over[..., 3:4] / 255.0
                    base = base * (1.0 - al) + over[..., :3] * al
            img[j*PX:(j+1)*PX, i*PX:(i+1)*PX] = np.clip(base, 0, 255).astype(np.uint8)
    print('blended cells: %d of %d (%.1f%%)' % (blended, cw*ch, 100.0*blended/(cw*ch)))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    Image.fromarray(img).save(out, optimize=True)
    print('baked %s  %dx%d  from real tileset art' % (out, img.shape[1], img.shape[0]))
    used = sorted(set(int(x) for x in tex.ravel()))
    print('tiles used:', {ground[k]: (TERRAIN.get(ground[k], ('?', '?'))[1]) for k in used if k < len(ground)})
    if misses: print('WARNING no atlas for:', misses)

if __name__ == '__main__':
    bake()
