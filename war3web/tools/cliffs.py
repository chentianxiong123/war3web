"""Cliffs: war3map.w3e layer heights -> a baked cliff mesh, from Warcraft III's own art.

Warcraft III does not draw cliffs as terrain.  The ground mesh only ever covers
cells whose four corners share a *layer height*; where they differ the engine
drops the ground entirely and stamps a prefabricated cliff model over the whole
128x128 cell.  Those models carry the low surface, the rock wall and the high
surface in one piece, so the step is authored art rather than interpolated
geometry -- which is why a height-interpolated terrain renders cliffs as ramps.

Which model is picked comes from the four corner layers, relative to the lowest
of them, as a four-letter code (A = the cell's own base, B = one layer up,
C = two).  The letters run counter-clockwise around the cell, not in raster
order; read off the shipped meshes, each letter's corner is

    letter 1  x=-128 y=  0     south-west
    letter 2  x=-128 y=128     north-west
    letter 3  x=   0 y=128     north-east
    letter 4  x=   0 y=  0     south-east

and the mesh spans x in [-128,0], y in [0,128], so it is placed at the cell's
*south-east* corner.  tools/cliff_test.py checks this the hard way, by holding
every cliff vertex that lands on a terrain grid point against that vertex's own
ground height -- a transposed order shows up there at once.  TerrainArt\\CliffTypes.slk names the model directory per
cliff type ('CityCliffs' for this map's CYsq), and the meshes reference texture
slot 11 -- the replaceable-texture id for "the tileset's cliff texture" -- which
that same table resolves to ReplaceableTextures\\Cliff\\<tileset>_<texFile>.blp,
falling back to the unprefixed name for Lordaeron Summer, the one tileset that
has no recolour of its own.

Open ramps keep their ground surface. Their low flagged vertices sit half a
layer higher, extending the slope into the preceding flat cell. The two-cell
transition models beside them are baked here and both footprint cells are
excluded from the ground mesh. See docs/TERRAIN_PROVENANCE.md.

Output:
  data/cliffs.json   groups, cell lists, counts
  data/cliffs.bin    interleaved float32 pos/normal/uv, one triangle soup
  assets/textures/ReplaceableTextures/Cliff/<texFile>.png
"""
import json, os, struct, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np
from PIL import Image

import mdx
import blp
from gamedata import GameData
from slk import parse_slk

CELL = 128.0                # cliff meshes are authored against a 128-unit cell
LAYER = 128.0               # one cliff layer of relief
BASE_LAYER = 2              # w3e layer 2 is z=0, matching tools/stage.py


def cliff_types():
    """cliffID -> row of TerrainArt\\CliffTypes.slk."""
    p = 'war3_extracted/TerrainArt/CliffTypes.slk'
    if not os.path.exists(p):
        return {}
    return {str(r.get('cliffID') or ''): r for r in parse_slk(p) if r.get('cliffID')}


def classify(t):
    """Every cell of the map, split into cliff cells, ramp cells and flat ground.

    Returns (cliffs, ramps) where a cliff entry carries everything needed to
    place a model: cell index, grid position, code letters, variation, the
    cliff-type id and the z the model sits at.
    """
    W, H = t['width'], t['height']
    lay, det, flg, ctx = t['layer'], t['detail'], t['flags'], t['cliffTex']
    tiles = t['cliffTiles']
    cw = W - 1
    cliffs, ramps = [], []
    for j in range(H - 1):
        for i in range(cw):
            # corner order is the one the meshes are authored in, counter-
            # clockwise from the south-west: SW NW NE SE
            ks = (j * W + i, (j + 1) * W + i, (j + 1) * W + i + 1, j * W + i + 1)
            ls = [lay[k] for k in ks]
            if len(set(ls)) == 1:
                continue
            if all(flg[k] & 1 for k in ks):
                ramps.append(j * cw + i)          # a ramp keeps its sloped ground
                continue
            lo = min(ls)
            # 0xF is w3e's "no cliff texture here" sentinel; fall back around the
            # cell rather than indexing past the end of the map's cliff list.
            idx = next((ctx[k] for k in ks if ctx[k] < len(tiles)), 0)
            cliffs.append(dict(
                cell=j * cw + i, i=i, j=j,
                code=''.join(chr(ord('A') + min(l - lo, 2)) for l in ls),
                variation=det[ks[0]] >> 5,        # w3e details byte: bits 5-7
                cliffId=tiles[idx] if idx < len(tiles) else (tiles[0] if tiles else ''),
                layer=lo))
    return cliffs, ramps


def place_transitions(t, cliffs, models, types):
    """Fit the archive's two-cell transition meshes to the terrain corners.

    L/H labels name a ramp edge, not a one-cell footprint. Choose its anchor
    by checking the model's four *outer* corners against the layer grid. This
    uses the actual geometry rather than assuming that all models extend in
    the same direction. See docs/TERRAIN_PROVENANCE.md for measurements.
    """
    W, H = t['width'], t['height']
    cw = W - 1
    occupied, transitions = set(), []
    for c in cliffs:
        i, j = c['i'], c['j']
        ks = (j * W + i, (j + 1) * W + i, (j + 1) * W + i + 1, j * W + i + 1)
        ramp = [bool(t['flags'][k] & 1) for k in ks]
        edge = [n for n in range(4) if ramp[n]]
        ls = [t['layer'][k] - c['layer'] for k in ks]
        if (len(edge) != 2 or (edge[1] - edge[0]) % 2 == 0
                or sorted(ls[n] for n in edge) != [0, 1] or max(ls) > 1):
            continue
        directory = types.get(c['cliffId'], {}).get('rampModelDir')
        if not directory:
            continue
        code = ''.join(('L' if l == 0 else 'H') if r else chr(65 + l)
                       for r, l in zip(ramp, ls))
        path = models.path(directory, code, 0)
        if not path:
            continue
        model = models.get(path)
        if not model or not model['geosets']:
            continue
        verts = np.concatenate([np.asarray(g['vertices']).reshape(-1, 3) for g in model['geosets']])
        low, high = verts.min(axis=0), verts.max(axis=0)
        size = np.rint((high[:2] - low[:2]) / CELL).astype(int)
        if tuple(size) not in ((2, 1), (1, 2)):
            continue
        corners = []
        for x in (low[0], high[0]):
            for y in (low[1], high[1]):
                at = verts[(abs(verts[:, 0] - x) < .02) & (abs(verts[:, 1] - y) < .02)]
                if not len(at):
                    break
                corners.append((x, y, float(at[:, 2].max())))
        if len(corners) != 4:
            continue
        fits = []
        # The H endpoint stays on the flagged high terrain vertex. L sits
        # halfway across the mesh's two-cell span, not at its outer low edge.
        high_corner = next(n for n in edge if ls[n] == 1)
        high_xy = ((0, 0), (0, 1), (1, 1), (1, 0))[high_corner]
        model_high = [high[a] if high_xy[a] else low[a] for a in (0, 1)]
        for x0 in range(i - size[0] + 1, i + 1):
            for y0 in range(j - size[1] + 1, j + 1):
                if x0 < 0 or y0 < 0 or x0 + size[0] >= W or y0 + size[1] >= H:
                    continue
                ox, oy = x0 - low[0] / CELL, y0 - low[1] / CELL
                if (abs(ox + model_high[0] / CELL - i - high_xy[0]) > .001
                        or abs(oy + model_high[1] / CELL - j - high_xy[1]) > .001):
                    continue
                error = max(abs(z - (t['layer'][round(oy + y / CELL) * W + round(ox + x / CELL)]
                                     - c['layer']) * LAYER) for x, y, z in corners)
                if error < .5:
                    cells = [y * cw + x for y in range(y0, y0 + size[1])
                             for x in range(x0, x0 + size[0])]
                    fits.append(dict(c, model=path, code=code, i=round(ox) - 1,
                                     j=round(oy), cells=cells, transition=True))
        # Ambiguous or intersecting footprints stay ordinary cliffs. Never
        # remove ground for a model whose placement has not been established.
        if len(fits) == 1 and not occupied.intersection(fits[0]['cells']):
            transitions.append(fits[0])
            occupied.update(fits[0]['cells'])
    return [c for c in cliffs if c['cell'] not in occupied] + transitions


class Models:
    """Cliff meshes, pulled from the archives and parsed once each."""

    def __init__(self, gd):
        self.gd = gd
        self.list = gd.listfile()
        self.cache = {}
        self.fallbacks = 0

    def path(self, model_dir, code, variation):
        """The highest variation at or below the requested one that exists.

        Warcraft III clamps here too: a code with two variations drawn with
        variation 2 falls back rather than going missing.
        """
        for v in range(variation, -1, -1):
            p = 'Doodads\\Terrain\\%s\\%s%s%d.mdx' % (model_dir, model_dir, code, v)
            if p.lower() in self.list or self.gd.read(p)[0] is not None:
                if v != variation:
                    self.fallbacks += 1
                return p
        return None

    def get(self, ap):
        """Parse a cliff mesh, saving the raw .mdx alongside the other art."""
        if ap in self.cache:
            return self.cache[ap]
        data, _src = self.gd.read(ap)
        if data is None:
            self.cache[ap] = None
            return None
        out = os.path.join('war3_extracted', ap.replace('\\', os.sep))
        os.makedirs(os.path.dirname(out), exist_ok=True)
        open(out, 'wb').write(data)
        M = mdx.parse(out)
        self.cache[ap] = M
        return M


def geoset_texture(M, geo):
    """The texture a geoset draws with: a real path, or a replaceable-id slot."""
    mats = M['materials']
    mid = geo.get('materialId', 0)
    if not (0 <= mid < len(mats)) or not mats[mid]['layers']:
        return None
    tid = mats[mid]['layers'][0]['textureId']
    if not (0 <= tid < len(M['textures'])):
        return None
    tex = M['textures'][tid]
    return tex['path'].strip() or ('#%d' % tex['replaceableId'])


def bake(t, cliffs, models, texture_for):
    """Every cliff cell's mesh, transformed to world space and merged.

    Warcraft III is z-up with +y north; the client is y-up with north at -z, so
    (x, y, z) -> (x, z, -y).  That is a rotation, so triangle winding carries
    over untouched.
    """
    OX, OY, TS = t['offsetX'], t['offsetY'], t['tileSize']
    groups = {}                       # texture -> list of float32 vertex rows
    skipped = []
    for c in cliffs:
        M = models.get(c['model'])
        if M is None:
            skipped.append(c)
            continue
        # the mesh spans x in [-128,0] and y in [0,128]: place it south-east
        ox = OX + (c['i'] + 1) * TS
        oy = OY + c['j'] * TS
        oz = (c['layer'] - BASE_LAYER) * LAYER
        for geo in M['geosets']:
            key = texture_for(geo_tex := geoset_texture(M, geo), c['cliffId'])
            V = np.asarray(geo['vertices'], np.float32).reshape(-1, 3)
            N = np.asarray(geo['normals'], np.float32).reshape(-1, 3)
            UV = (np.asarray(geo['uvs'][0], np.float32).reshape(-1, 2)
                  if geo['uvs'] else np.zeros((len(V), 2), np.float32))
            if len(N) != len(V):
                N = np.tile(np.array([0, 0, 1], np.float32), (len(V), 1))
            idx = np.asarray(geo['indices'], np.int32)
            P = V[idx]
            Nn = N[idx]
            T = UV[idx]
            world = np.empty_like(P)
            world[:, 0] = P[:, 0] + ox
            world[:, 1] = P[:, 2] + oz
            world[:, 2] = -(P[:, 1] + oy)
            norm = np.empty_like(Nn)
            norm[:, 0] = Nn[:, 0]
            norm[:, 1] = Nn[:, 2]
            norm[:, 2] = -Nn[:, 1]
            groups.setdefault(key, []).append(
                np.concatenate([world, norm, T], axis=1).astype(np.float32))
    return groups, skipped


def save_texture(gd, ap, dst):
    """Pull a .blp out of the archives and write it as a PNG for the client."""
    data, _src = gd.read(ap)
    if data is None:
        return None
    raw = os.path.join('war3_extracted', ap.replace('\\', os.sep))
    os.makedirs(os.path.dirname(raw), exist_ok=True)
    open(raw, 'wb').write(data)
    rgba = blp.decode(data)
    im = Image.fromarray(rgba, 'RGBA')
    if (rgba[:, :, 3] == 255).all():
        im = im.convert('RGB')
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    im.save(dst, optimize=True)
    return im.size


def main():
    t = json.load(open('data/terrain.json'))
    gd = GameData()
    types = cliff_types()
    cliffs, ramps = classify(t)
    print('cells %dx%d: %d cliff, %d ramp (ramps keep their sloped ground)'
          % (t['width'] - 1, t['height'] - 1, len(cliffs), len(ramps)))
    if not cliffs:
        json.dump(dict(width=t['width'] - 1, height=t['height'] - 1, groups=[],
                       cells=[], ramps=ramps, verts=0, tris=0),
                  open('data/cliffs.json', 'w'))
        open('data/cliffs.bin', 'wb').write(b'')
        print('no cliffs on this map')
        return

    # cliff type -> model directory and the texture its meshes stand in for
    used = sorted({c['cliffId'] for c in cliffs})
    tex_png, model_dir = {}, {}
    for cid in used:
        row = types.get(cid)
        if not row:
            print('WARNING unknown cliff type %r, falling back to Cliffs' % cid)
            model_dir[cid] = 'Cliffs'
            tex_png[cid] = None
            continue
        model_dir[cid] = str(row.get('cliffModelDir') or 'Cliffs')
        d = str(row.get('texDir') or 'ReplaceableTextures\\Cliff').replace('/', '\\')
        f = str(row.get('texFile') or 'Cliff0')
        # CliffTypes.slk names the texture unqualified, but every tileset bar
        # Lordaeron Summer ships its own recolour as <tileset>_<texFile>.blp.
        # Taking the bare name gives a Cityscape map grassy Lordaeron cliffs.
        ap = rel = None
        for cand in ('%s\\%s_%s.blp' % (d, t['tileset'], f), '%s\\%s.blp' % (d, f)):
            if gd.read(cand)[0] is not None:
                ap = cand
                rel = 'textures/%s.png' % os.path.splitext(cand.replace('\\', '/'))[0]
                break
        size = save_texture(gd, ap, os.path.join('assets', rel)) if ap else None
        tex_png[cid] = rel
        print('  %s: models Doodads\\Terrain\\%s, texture %s %s'
              % (cid, model_dir[cid], ap or '%s\\%s.blp MISSING' % (d, f),
                 ('%dx%d' % size) if size else ''))

    models = Models(gd)
    cliffs = place_transitions(t, cliffs, models, types)
    missing = set()
    for c in cliffs:
        if c.get('transition'):
            continue
        p = models.path(model_dir[c['cliffId']], c['code'], c['variation'])
        if p is None:
            missing.add((c['cliffId'], c['code']))
            p = models.path(model_dir[c['cliffId']], c['code'], 0)
        c['model'] = p

    # a geoset's replaceable slot 11 is "this tileset's cliff texture"
    def texture_for(slot, cliff_id):
        if slot in (None, '#11', '#0'):
            return tex_png.get(cliff_id) or 'textures/ReplaceableTextures/Cliff/Cliff0.png'
        if slot.startswith('#'):
            return tex_png.get(cliff_id) or 'textures/ReplaceableTextures/Cliff/Cliff0.png'
        return 'textures/' + os.path.splitext(slot.replace('\\', '/'))[0] + '.png'

    groups, skipped = bake(t, [c for c in cliffs if c.get('model')], models, texture_for)

    blob, meta = [], []
    off = 0
    for tex in sorted(groups):
        arr = np.concatenate(groups[tex], axis=0)
        meta.append(dict(texture=tex, start=off, count=len(arr)))
        blob.append(arr)
        off += len(arr)
    allv = np.concatenate(blob, axis=0) if blob else np.zeros((0, 8), np.float32)
    open('data/cliffs.bin', 'wb').write(allv.astype('<f4').tobytes())

    drawn = [c for c in cliffs if c.get('model')]
    out = dict(width=t['width'] - 1, height=t['height'] - 1,
               groups=meta, cells=sorted({cell for c in drawn for cell in c.get('cells', [c['cell']])}), ramps=ramps,
               transitions=[dict(model=c['model'], cells=c['cells'], i=c['i'], j=c['j'])
                            for c in drawn if c.get('transition')],
               verts=int(len(allv)), tris=int(len(allv) // 3), stride=8)
    json.dump(out, open('data/cliffs.json', 'w'))

    codes = len({(c['cliffId'], c['code'], c['variation']) for c in drawn})
    print('models: %d distinct code+variation, %d parsed, %d variation fallbacks'
          % (codes, len(models.cache), models.fallbacks))
    if missing:
        print('WARNING no mesh for:', sorted(missing))
    if skipped:
        print('WARNING %d cells had no usable mesh' % len(skipped))
    print('baked data/cliffs.bin: %d triangles, %d vertices, %.0f KB in %d group(s)'
          % (len(allv) // 3, len(allv), allv.nbytes / 1024, len(meta)))
    for m in meta:
        print('   %-52s %6d verts' % (m['texture'], m['count']))
    if len(allv):
        print('   world bbox x %.0f..%.0f  y %.0f..%.0f  z %.0f..%.0f'
              % (allv[:, 0].min(), allv[:, 0].max(),
                 allv[:, 1].min(), allv[:, 1].max(),
                 allv[:, 2].min(), allv[:, 2].max()))


if __name__ == '__main__':
    main()
