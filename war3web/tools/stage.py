"""Stage runtime assets into public/ for the Node server."""
import json, os, shutil, struct, sys
sys.path.insert(0, os.path.dirname(__file__))
import math
import numpy as np
from PIL import Image

PUB = 'public'
os.makedirs(PUB + '/data', exist_ok=True)

# game data
shutil.copy('data/game.json', PUB + '/data/game.json')
# the engine's own hero-death warning; the client picks the row, since which
# one plays depends on who is listening
if os.path.exists('data/ambience.json'):
    shutil.copy('data/ambience.json', PUB + '/data/ambience.json')
if os.path.exists('data/daynight.json'):
    shutil.copy('data/daynight.json', PUB + '/data/daynight.json')
if os.path.exists('data/uisounds.json'):
    shutil.copy('data/uisounds.json', PUB + '/data/uisounds.json')
# every sound label's volume and pitch, for SetSoundParamsFromLabel
if os.path.exists('data/soundlabels.json'):
    shutil.copy('data/soundlabels.json', PUB + '/data/soundlabels.json')
# the model a buff hangs on a unit, and where it hangs it
if os.path.exists('data/buffart.json'):
    shutil.copy('data/buffart.json', PUB + '/data/buffart.json')

# terrain: compact height + tile arrays
t = json.load(open('data/terrain.json'))
w, h = t['width'], t['height']
hs = np.array(t['heights'], np.int16)
layer = np.array(t['layer'], np.uint8)
from terrain_surface import surface_heights
z = surface_heights(t)
open(PUB + '/data/heights.bin', 'wb').write(z.astype(np.float32).tobytes())
open(PUB + '/data/tiles.bin', 'wb').write(np.array(t['tex'], np.uint8).tobytes())

# pathing grid -> walkability bitmap (1 byte/cell)
p = json.load(open('data/pathing.json'))
cells = np.array(p['cells'], np.uint8)
walk = ((cells & 0x02) == 0).astype(np.uint8)      # 0x02 = no-walk


def stamp_destructable_pathing(walk, pw, ph, channel=0):
    """Block the cells the map's destructables stand on.

    war3map.wpm is the *terrain's* pathing, and the World Editor bakes ordinary
    doodads into it -- the city low walls read 202, no-walk, straight from the
    file. Destructables are not baked in, because Warcraft III stamps their
    footprint at runtime and lifts it again when they die: the stone walls, all
    six gates and the trees read 64 or 72, walkable, and were walked through.

    The footprint is a TGA named per type in pathTex, one pixel per 32-unit
    pathing cell, with the flags in the colour channels -- red unwalkable, green
    unflyable, blue unbuildable. So a 10x2 StoneWall1Path is a 320x64 bar and
    Gate2Path is a 22x22 diagonal band. Red and green are staged separately for ground and flight movement.

    Warcraft III keeps a stamped footprint square to the grid, so the rotation
    is taken to the nearest quarter turn rather than interpolated.

    The turn is measured from 270 degrees, the editor's default facing, which is
    the orientation a footprint is authored in. Measured from zero every one
    came out a quarter turn off -- a wall running north-south stamped an
    east-west bar through its own middle, which blocks its centre and leaves an
    eight-cell hole to either side of it, so the line of walls read as a row of
    detached stubs and was walked straight between.

    Only destructables are stamped, and the two halves of that rule are visible
    in the map's own file: every one of the 214 ordinary doodads placed here is
    already no-walk in war3map.wpm, because the editor baked it in, and not one
    of the 361 destructables is. Stamping the doodads as well would be stamping
    them twice, at a rotation the editor has already applied.
    """
    from PIL import Image as _Image
    sys.path.insert(0, 'tools')
    from slk import parse_slk as _pslk
    doo = json.load(open('data/doodads.json'))['doodads']

    def _f(_v, _d=0.0):
        try:
            return float(_v)
        except (TypeError, ValueError):
            return _d

    def _tex(_r, _c):
        _v = str(_r.get(_c) or '').strip()
        return _v if _v and _v.lower() not in ('_', '-', 'none') else None

    stats = {}
    for _r in _pslk('war3_extracted/Units/DestructableData.slk'):
        _i = str(_r.get('DestructableID') or '')
        _pt = _tex(_r, 'pathTex')
        if not _i or not _pt:
            continue
        stats[_i] = {
            'tex': _pt,
            # what the wreckage still blocks: the gates' death footprint is
            # their two posts, so a broken gate is a hole with rubble either
            # side of it rather than clear ground
            'dead': _tex(_r, 'pathTexDeath'),
            'hp': _f(_r.get('HP')),
            # DestructableData's own selectable flag: only the six gates carry
            # it. The walls, the trees and the pathing blockers are 0, and
            # Warcraft III will not let a click land on one of those.
            'sel': int(_f(_r.get('selectable'))),
            'targ': str(_r.get('targType') or ''),
            'rad': _f(_r.get('radius')),
            'armor': str(_r.get('armor') or ''),
            'death': _tex(_r, 'deathSnd'),
        }
    tex_of = {_i: _v['tex'] for _i, _v in stats.items()}

    masks = {}
    def mask_for(rel):
        if rel in masks:
            return masks[rel]
        cand = os.path.join('war3_extracted', os.path.splitext(rel)[0].replace('\\', os.sep))
        m = None
        for ext in ('.tga', '.blp', '.png'):
            if os.path.exists(cand + ext):
                a = np.asarray(_Image.open(cand + ext).convert('RGB'))
                m = a[:, :, channel] > 127            # red: unwalkable; green: unflyable
                break
        masks[rel] = m
        return m

    ox, oy, PC = t['offsetX'], t['offsetY'], 32.0
    DEFAULT_FACING = math.radians(270.0)
    blocked, placed_n, missing = 0, 0, set()
    # Every cell each placement claims, kept per placement rather than merged.
    # Warcraft III lifts a destructable's footprint when it dies, and two
    # neighbouring walls share cells where their bars overlap, so a cell may only
    # open once nothing left standing still claims it.
    stamps = []
    # what the bare terrain allows, kept before anything is stamped into it: a
    # cell the terrain itself blocks must not be handed back when whatever
    # stands on it dies
    terrain_ok = walk.copy()

    def cells_of(d, rel):
        """The pathing cells one placement's footprint covers."""
        m = mask_for(rel)
        if m is None:
            missing.add(rel)
            return None
        # nearest quarter turn from the editor's default facing, counter-
        # clockwise like the game's own rotation
        k = int(round((float(d.get('rot') or 0) - DEFAULT_FACING) / (math.pi / 2))) % 4
        mm = np.rot90(m, k)
        mh, mw = mm.shape
        # the footprint is centred on the doodad, and image row 0 is its north edge
        x0 = int(round((d['x'] - ox) / PC - mw / 2.0))
        y0 = int(round((d['y'] - oy) / PC - mh / 2.0))
        out = []
        for r in range(mh):
            wy = y0 + (mh - 1 - r)              # flip: image y grows downward
            if wy < 0 or wy >= ph:
                continue
            row = mm[r]
            for c in range(mw):
                wx = x0 + c
                if 0 <= wx < pw and row[c]:
                    out.append(wy * pw + wx)
        return out

    for di, d in enumerate(doo):
        st = stats.get(d['id'])
        if not st:
            continue
        claimed = cells_of(d, st['tex'])
        if claimed is None:
            continue
        placed_n += 1
        for i in claimed:
            if walk[i]:
                walk[i] = 0
                blocked += 1
        rec = {'d': di, 'id': d['id'], 'x': d['x'], 'y': d['y'],
               'r': d.get('rot') or 0, 'hp': st['hp'], 'life': d.get('life', 100),
               'sel': st['sel'], 'targ': st['targ'], 'rad': st['rad'],
               'armor': st['armor'], 'c': claimed,
               'w': [i for i in claimed if terrain_ok[i]]}
        if st['dead']:
            rec['k'] = cells_of(d, st['dead']) or []
        if st['death']:
            rec['snd'] = st['death']
        stamps.append(rec)
    if missing:
        print('WARNING no pathing footprint for:', sorted(missing)[:4])
    json.dump(stamps, open(PUB + ('/data/flydestructables.json' if channel else '/data/destructables.json'), 'w'), separators=(',', ':'))
    sel = sum(1 for s in stamps if s['sel'])
    print('destructables: %d placements stamped, %d cells newly blocked, %d selectable'
          % (placed_n, blocked, sel))
    return walk


walk = stamp_destructable_pathing(walk, p['width'], p['height'])
open(PUB + '/data/walk.bin', 'wb').write(walk.tobytes())
fly = ((cells & 0x04) == 0).astype(np.uint8)
fly = stamp_destructable_pathing(fly, p['width'], p['height'], channel=1)
open(PUB + '/data/fly.bin', 'wb').write(fly.tobytes())

# Water: the w3e flag nibble sets bit 0x4 on a submerged vertex, and a tile
# shows water when any of its four corners is flagged.  This map's two bases sit
# inside a moat, drawn as a one-vertex-wide ring, so "any corner" is what makes
# the ring solid rather than leaving it as a dotted line.
wflag = np.array(t['flags'], np.uint8) & 0x4
wraw = np.array(t['water'], np.int32)
# The water level is absolute -- unlike ground height it carries no cliff-layer
# term.  Adding one put the surface on the trench floor instead of level with
# the bank: the moat is cut to -256 and filled to 0, flush with the ground.
wz = (wraw.astype(np.float32) - 8192.0) / 4.0
grid = wflag.reshape(h, w) > 0
zg = wz.reshape(h, w)
corner = grid[:-1, :-1] | grid[:-1, 1:] | grid[1:, :-1] | grid[1:, 1:]
# Per-tileset water settings live in TerrainArt\\Water.slk, keyed <tileset>Sha:
# 'height' is the surface offset in cliff-layer units, 'numTex'/'texRate' drive
# the animation.  Without these the surface sits too high and animates too fast.
def water_params(tileset):
    import re as _re
    out = dict(height=-0.7 * 128, numTex=45, texRate=15, lighting=1)
    try:
        txt = open('war3_extracted/TerrainArt/Water.slk', encoding='latin-1').read()
    except OSError:
        return out
    cols, rows, x, y = {}, {}, 0, 0
    for line in txt.replace('\r\n', '\n').split('\n'):
        m = _re.match(r'C;X(\d+)(?:;Y(\d+))?;K(.*)$', line)
        if not m:
            continue
        x = int(m.group(1))
        if m.group(2):
            y = int(m.group(2))
        rows.setdefault(y, {})[x] = m.group(3).strip('"')
    hdr = rows.get(1, {})
    for yy, r in rows.items():
        rec = {hdr.get(k, k): v for k, v in r.items()}
        if rec.get('waterID') == '%sSha' % tileset:
            def num(k, d):
                try: return float(rec.get(k))
                except (TypeError, ValueError): return d
            out = dict(height=num('height', -0.7) * 128.0,
                       numTex=int(num('numTex', 45)),
                       texRate=num('texRate', 15),
                       lighting=int(num('lighting', 1)))
            break
    return out

wparams = water_params(t['tileset'])
print('water params (%sSha): surface offset %.1f, %d frames @ %.0f fps'
      % (t['tileset'], wparams['height'], wparams['numTex'], wparams['texRate']))

cells, cellz = [], []
for j, i in zip(*np.nonzero(corner)):
    cells.append(int(j) * (w - 1) + int(i))
    # the surface sits at the highest flagged corner of the tile
    zs = [zg[j + dj, i + di] for dj in (0, 1) for di in (0, 1)
          if grid[j + dj, i + di]]
    cellz.append(round(float(max(zs)), 2))
print('water tiles: %d of %d  (%d flagged vertices)'
      % (len(cells), (w - 1) * (h - 1), int((wflag > 0).sum())))

terr = dict(width=w, height=h, tileSize=t['tileSize'],
            offsetX=t['offsetX'], offsetY=t['offsetY'],
            groundTiles=t['groundTiles'], cliffTiles=t['cliffTiles'],
            tileset=t['tileset'],
            pathWidth=p['width'], pathHeight=p['height'],
            pathCell=(t['tileSize'] * (w - 1)) / p['width'],
            minZ=float(z.min()), maxZ=float(z.max()),
            water=dict(cells=cells, z=cellz, **wparams))
json.dump(terr, open(PUB + '/data/terrain.json', 'w'))

# cliffs: the baked cliff mesh and the cells it covers (tools/cliffs.py).
# The ground mesh skips those cells -- in Warcraft III the cliff model carries
# the surface on both levels, so drawing ground there too is what turns a step
# into a ramp.
if os.path.exists('data/cliffs.json'):
    shutil.copy('data/cliffs.json', PUB + '/data/cliffs.json')
    shutil.copy('data/cliffs.bin', PUB + '/data/cliffs.bin')
    _c = json.load(open('data/cliffs.json'))
    print('cliffs: %d cells, %d ramp cells, %d triangles, %d KB'
          % (len(_c['cells']), len(_c['ramps']), _c['tris'],
             os.path.getsize('data/cliffs.bin') // 1024))
else:
    print('cliffs: none staged (run tools/cliffs.py)')

# doodads
d = json.load(open('data/doodads.json'))
json.dump(d['doodads'], open(PUB + '/data/doodads.json', 'w'))

# ground texture is produced by tools/bake_ground.py (real tile indices)

# copy models + textures + converted game audio.
# The destination is rebuilt from scratch so assets from a previously built map
# are never left behind.
for sub in ('models', 'textures', 'sounds'):
    src, dst = 'assets/' + sub, PUB + '/assets/' + sub
    if os.path.isdir(dst):
        shutil.rmtree(dst)
    os.makedirs(dst, exist_ok=True)
    for root, _, files in os.walk(src):
        for f in files:
            s = os.path.join(root, f)
            r = os.path.relpath(s, src)
            o = os.path.join(dst, r)
            os.makedirs(os.path.dirname(o), exist_ok=True)
            shutil.copy(s, o)
shutil.copy('assets/models.json', PUB + '/assets/models.json')
shutil.copy('assets/textures.json', PUB + '/assets/textures.json')
# ...and the sound index, without which the engine cannot map a sound the map
# names ("Sound\\Music\\mp3Music\\HumanX1.mp3") to the file that was actually
# converted, and hands the client the raw archive path instead. It only ever
# worked in the source tree because the engine finds assets/sounds.json there;
# public/ has to stand on its own for a deployment to work.
if os.path.exists('assets/sounds.json'):
    shutil.copy('assets/sounds.json', PUB + '/assets/sounds.json')

# sounds the map imported: served flat by file name.  MP3s pass through, but
# Warcraft III also imports ADPCM .wav, which no browser decodes -- those are
# transcoded, so the script's file name no longer matches the staged one and an
# index has to carry the mapping.
import subprocess
os.makedirs(PUB + '/assets/sounds', exist_ok=True)
n = 0
imported = {}
for root, _, files in os.walk('extracted'):
    for f in files:
        ext = os.path.splitext(f)[1].lower()
        if ext == '.mp3':
            shutil.copy(os.path.join(root, f), PUB + '/assets/sounds/' + f)
            imported[f.lower()] = f
            n += 1
        elif ext == '.wav':
            ogg = os.path.splitext(f)[0] + '.ogg'
            dst = PUB + '/assets/sounds/' + ogg
            r = subprocess.run(['ffmpeg', '-v', 'quiet', '-y',
                                '-i', os.path.join(root, f),
                                '-c:a', 'libvorbis', '-q:a', '2', '-ar', '22050', dst],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            if r.returncode == 0 and os.path.exists(dst) and os.path.getsize(dst):
                imported[f.lower()] = ogg
                n += 1
json.dump(imported, open('assets/imported_sounds.json', 'w'), indent=0)
shutil.copy('assets/imported_sounds.json', PUB + '/assets/imported_sounds.json')

print('terrain %dx%d verts, path %dx%d (cell %.0f), z %.1f..%.1f' % (
    w, h, p['width'], p['height'], terr['pathCell'], terr['minZ'], terr['maxZ']))
print('walkable cells: %d / %d (%.0f%%)' % (walk.sum(), walk.size, 100*walk.mean()))
print('staged: %d sounds, %d models, doodads %d' % (
    n, len(json.load(open('assets/models.json'))), len(d['doodads'])))

# ---- unit type -> renderable model, for every type the script can spawn
import json as _json
types = _json.load(open('data/unittypes.json'))
models = _json.load(open('assets/models.json'))
have = {k.lower(): k for k in models}
def resolve_model(p):
    """Return the file-safe glb basename the converter wrote for this art path."""
    if not p or not str(p).strip('-'): return None
    q = str(p).replace('/', '\\')
    q = q[:q.rfind('.')] if '.' in q.split('\\')[-1] else q
    key = None
    if q.lower() in have: key = have[q.lower()]
    else:
        base = q.split('\\')[-1]
        if base.lower() in have: key = have[base.lower()]
        else:
            for k in models:
                if k.split('\\')[-1].lower() == base.lower(): key = k; break
    if key is None: return None
    return key.replace('\\', '~')
um = {}
hit = 0
for uid, t in types.items():
    m = resolve_model(t.get('model'))
    if m: hit += 1
    # Warcraft III's shadow is a flat textured quad under the unit, not a
    # shadow map, and each unit names its own image, size and offset.
    sh = str(t.get('shadow') or '').strip()
    um[uid] = dict(m=m, s=t.get('scale', 1) or 1,
                   n=t.get('properName') or t.get('name') or uid,
                   h=1 if t.get('isHero') else 0,
                   b=1 if t.get('isBuilding') else 0,
                   r=t.get('collision', 24),
                   # Locust marks a unit the player can never see or touch: the
                   # invisible dummies a map casts its spells through. They must
                   # not get the stand-in mesh a real unit gets for missing art.
                   l=1 if 'Aloc' in (t.get('abilities') or []) else 0,
                   sh=sh if sh not in ('', '-', '_') else None,
                   sw=t.get('shadowW', 0), shh=t.get('shadowH', 0),
                   sx=t.get('shadowX', 0), sy=t.get('shadowY', 0),
                   # the ground decal this building is stamped on
                   us=(str(t.get('uberSplat') or '').strip() or None),
                   # Required Animation Names: which variant of a shared model
                   # this unit is (the Arcane Tower is HumanTower "upgrade,third")
                   an=(str(t.get('animProps') or '').strip().lower() or None),
                   # the selection circle's own scale, which is not the model's:
                   # the Paladin is 1.25 selection against 1.0 model
                   ss=t.get('selectScale', 1) or 1, sz=t.get('selZ', 0) or 0)

# ---------------------------------------------------------------- ubersplats
# Warcraft III stamps a ground decal under every building -- scorched earth,
# flagstones, the glowing ring under an altar. The unit names a row in
# Splats\UberSplatData.slk, that row names a texture and a scale, and none of it
# was reachable because the Splats directory was never extracted.
from slk import parse_slk as _splat_slk
_texidx = json.load(open('assets/textures.json'))
_have = {k.lower(): v for k, v in _texidx.items()}


def _splat_tex(dirname, fname):
    if not fname:
        return None
    key = ('%s\\%s' % (dirname, fname)).replace('/', '\\').lower()
    if key in _have:
        return _have[key]
    base = key.split('\\')[-1]
    for k, v in _have.items():
        if k.split('\\')[-1] == base or k.split('\\')[-1] == base + '.blp':
            return v
    return None


def _num(r, k, d=0.0):
    try:
        return float(r.get(k))
    except (TypeError, ValueError):
        return d


splats = {}
_sp = 'war3_extracted/Splats/UberSplatData.slk'
if os.path.exists(_sp):
    _rows = _splat_slk(_sp)
    for row in (_rows.values() if isinstance(_rows, dict) else _rows):
        name = str(row.get('Name') or '').strip()
        if not name or name == 'INIT':
            continue
        tex = _splat_tex(str(row.get('Dir') or ''), str(row.get('file') or ''))
        if not tex:
            continue
        splats[name] = dict(t=tex, s=float(row.get('Scale') or 1),
                            b=int(row.get('BlendMode') or 0),
                            # an ubersplat fades in, holds, then decays
                            birth=_num(row, 'BirthTime', 1),
                            hold=_num(row, 'PauseTime', 0),
                            decay=_num(row, 'Decay', 2))
json.dump(splats, open(PUB + '/data/ubersplats.json', 'w'))

# ------------------------------------------------------- event-object tables
# An MDX event object names a kind and an id -- SPLxHBS1, SNDxDHLS -- and the id
# indexes one of these. SplatData carries both the blood splats and the
# footprints (they share the table), SpawnData the models an animation throws,
# and AnimLookups maps a sound event to a sound label.
def _rows_of(path, key='Name'):
    if not os.path.exists(path):
        return {}
    r = _splat_slk(path)
    it = r.values() if isinstance(r, dict) else r
    return {str(x.get(key) or ''): x for x in it}


evsplats = {}
for name, r in _rows_of('war3_extracted/Splats/SplatData.slk').items():
    if not name or name == 'INIT':
        continue
    tex = _splat_tex(str(r.get('Dir') or ''), str(r.get('file') or ''))
    if not tex:
        continue
    evsplats[name] = dict(
        t=tex, rows=int(_num(r, 'Rows', 1)) or 1, cols=int(_num(r, 'Columns', 1)) or 1,
        s=_num(r, 'Scale', 50), b=int(_num(r, 'BlendMode', 0)),
        life=_num(r, 'Lifespan', 2), decay=_num(r, 'Decay', 10),
        # which cells of the atlas it walks through while living, then decaying
        uv=[int(_num(r, 'UVLifespanStart')), int(_num(r, 'UVLifespanEnd')),
            int(_num(r, 'UVDecayStart')), int(_num(r, 'UVDecayEnd'))],
        # the colour ramp, start -> middle -> end, alpha included
        c=[[_num(r, 'StartR', 255), _num(r, 'StartG', 255), _num(r, 'StartB', 255), _num(r, 'StartA', 255)],
           [_num(r, 'MiddleR', 255), _num(r, 'MiddleG', 255), _num(r, 'MiddleB', 255), _num(r, 'MiddleA', 255)],
           [_num(r, 'EndR', 255), _num(r, 'EndG', 255), _num(r, 'EndB', 255), _num(r, 'EndA', 0)]])
json.dump(evsplats, open(PUB + '/data/splats.json', 'w'))

spawns = {}
for name, r in _rows_of('war3_extracted/Splats/SpawnData.slk').items():
    m = str(r.get('Model') or '')
    if name and name != 'INIT' and m and m not in ('-', '_', 'INIT'):
        spawns[name] = m
json.dump(spawns, open(PUB + '/data/spawns.json', 'w'))

# ------------------------------------------------------------------ lightning
# Chain lightning, mana burn, drain, forked lightning: Warcraft III draws the
# bolt itself from a row in Splats\LightningData.slk, which names the texture
# and how the strip is built -- how wide, how long a segment, how far each joint
# is thrown off the straight line, and how long it lives. 37 of this map's
# abilities name a type and nine of those are hero spells, all of which cast
# with no beam at all until now.
lightning = {}
for name, r in _rows_of('war3_extracted/Splats/LightningData.slk').items():
    if not name or name == 'INIT':
        continue
    tex = _splat_tex(str(r.get('Dir') or ''), str(r.get('file') or ''))
    if not tex:
        continue
    lightning[name] = dict(
        t=tex,
        w=_num(r, 'Width', 40),
        seg=max(8.0, _num(r, 'AvgSegLen', 100)),
        # how far a joint is thrown off the straight line between the ends
        noise=_num(r, 'NoiseScale', 0),
        uv=_num(r, 'TexCoordScale', 1),
        life=_num(r, 'Duration', 2),
        c=[_num(r, 'R', 255) / 255.0, _num(r, 'G', 255) / 255.0,
           _num(r, 'B', 255) / 255.0, _num(r, 'A', 255) / 255.0])
json.dump(lightning, open(PUB + '/data/lightning.json', 'w'))
print('lightning: %d bolt types with a converted texture' % len(lightning))

# A sound event names a four-character id; AnimLookups turns that into a label
# and AnimSounds turns the label into files and the numbers that place them.
# Resolve the whole chain here so the client fetches one table and does no
# lookups of its own -- 1370 of these fire across the map's models.
_snd_index = json.load(open('assets/sounds.json')) if os.path.exists('assets/sounds.json') else {}


def _sound_files(rec):
    """DirectoryBase + FileNames -> converted web paths.

    Lifted from tools/soundsets.py:entry_files, which already does this join for
    the unit sound sets, with two things that table did not need:

      - six rows write a DirectoryBase with no trailing separator
        (Units\\Creeps\\HEROGoblinALCHEMIST + AlchemistDeath.wav). Joining them
        blind produces a path that exists nowhere.
      - `_` appears as a placeholder meaning "no file".

    A name that resolves to nothing is dropped rather than passed on: some rows
    are stale and name files that are not in the game at all -- NatureTouch.wav
    is one -- and the client must fall silent, not ask for a 404.
    """
    base = str(rec.get('DirectoryBase', '') or '').replace('/', '\\').rstrip()
    if base and not base.endswith('\\'):
        base += '\\'
    out = []
    for f in str(rec.get('FileNames', '') or '').split(','):
        f = f.strip()
        if not f or f == '_':
            continue
        web = _snd_index.get((base + f).replace('\\', '/').lower())
        if web:
            out.append(web)
    return out


_anim_rows = _rows_of('war3_extracted/UI/SoundInfo/AnimSounds.slk', 'SoundName')
animsounds, _silent = {}, 0
for name, r in _rows_of('war3_extracted/UI/SoundInfo/AnimLookups.slk', 'AnimSoundEvent').items():
    lbl = str(r.get('SoundLabel') or '')
    if not name or not lbl or lbl in ('-', '_'):
        continue
    row = _anim_rows.get(lbl)
    files = _sound_files(row) if row else []
    if not files:
        _silent += 1
        continue
    animsounds[name] = dict(
        f=files,
        # Warcraft III stores volume 0-127. Several takes per label is how a
        # footstep avoids repeating identically; the client picks one.
        vol=round(_num(row, 'Volume', 127) / 127.0, 4),
        pitch=round(_num(row, 'Pitch', 1) or 1, 4),
        pitchVar=round(_num(row, 'PitchVariance', 0), 4),
        # the distances that decide whether a sound is worth hearing from here
        min=_num(row, 'MinDistance', 0),
        max=_num(row, 'MaxDistance', 0),
        cutoff=_num(row, 'DistanceCutoff', 0),
        prio=_num(row, 'Priority', 0))
json.dump(animsounds, open(PUB + '/data/animsounds.json', 'w'))
print('event tables: %d splats, %d spawn models, %d animation sounds '
      '(%d ids name a sound the game does not ship)'
      % (len(evsplats), len(spawns), len(animsounds), _silent))
print('ubersplats: %d types with a converted texture, %d units reference one'
      % (len(splats), sum(1 for v in um.values() if v.get('us'))))

_json.dump(um, open(PUB + '/data/unitmodels.json', 'w'))
print('unit->model map: %d types, %d with a converted model, %d with a shadow'
      % (len(um), hit, sum(1 for v in um.values() if v['sh'])))


# ---- doodad metadata: real model + scale for every placed doodad type
import sys as _sys
_sys.path.insert(0, 'tools')
from slk import parse_slk as _slk
_dood = {}
for _f, _idk in (('war3_extracted/Doodads/Doodads.slk', 'doodID'),
                 ('war3_extracted/Units/DestructableData.slk', 'DestructableID')):
    if os.path.exists(_f):
        for _r in _slk(_f):
            _id = str(_r.get(_idk) or '')
            if _id:
                _dood[_id] = dict(file=str(_r.get('file') or ''),
                                  scale=float(_r.get('defScale') or 1) or 1.0,
                                  name=str(_r.get('Name') or _id),
                                  # what this type's replaceable slot stands for
                                  tex=str(_r.get('texFile') or '').strip())
_meta = {}
for _d in d['doodads']:
    _e = _dood.get(_d['id'], {})
    _fileo = _e.get('file', '')
    _invisible = (not _fileo) or 'losblocker' in _fileo.lower()         or 'intentionallyleftblank' in _fileo.lower()
    _variants = []
    if not _invisible:
        for _n in range(8):
            _rm = resolve_model(_fileo + str(_n))
            _variants.append(_rm)
        while _variants and _variants[-1] is None:
            _variants.pop()
    # The texture a replaceable slot stands for, per destructable *type*.
    #
    # Warcraft III shares one model across many types and swaps only the
    # texture -- lordaerontree is used by five destructables with five
    # different tree textures -- so this cannot live in the converted model,
    # and the geoset that asks for it arrives with no texture at all. The
    # trees drew nothing until the client was given this to put back.
    _tf = (_e.get('tex') or '').replace('/', '\\')
    _texpng = None
    if _tf and _tf not in ('_', '-'):
        _stem = os.path.splitext(_tf)[0].lower()
        for _cand in (_stem + '.blp', _stem + '.tga', _tf.lower()):
            if _cand in _have:
                _texpng = _have[_cand]
                break
    _meta[_d['id']] = dict(file=_fileo, visible=not _invisible, tex=_texpng,
                           m=(resolve_model(_fileo) if not _invisible else None)
                             or next((v for v in _variants if v), None),
                           v=_variants,
                           s=_e.get('scale', 1.0), n=_e.get('name', _d['id']))
_json.dump(_meta, open(PUB + '/data/doodadmeta.json', 'w'))
_vis = [v for v in _meta.values() if v['visible']]
print('doodad types placed: %d, visible: %d, with a converted model: %d'
      % (len(_meta), len(_vis), sum(1 for v in _vis if v['m'])))

# ---------------------------------------------------------------- fonts
# Warcraft III sets its floating text in the typeface UI\war3skins.txt names as
# TextTagFont, which is Friz Quadrata. Substituting a web font changes both the
# look and the metrics, so the real file is staged and the client @font-faces
# it. Only the roman is needed: every font role in war3skins.txt names this one
# file, and the other five in Fonts\ are the CJK faces for localised builds.
_FONT_SRC = 'war3_extracted/Fonts/FRIZQT__.TTF'
if os.path.exists(_FONT_SRC):
    os.makedirs(PUB + '/fonts', exist_ok=True)
    shutil.copy(_FONT_SRC, PUB + '/fonts/FRIZQT__.TTF')
    print('font: FRIZQT__.TTF staged (%d bytes)' % os.path.getsize(_FONT_SRC))
else:
    print('font: FRIZQT__.TTF missing -- run tools/extract_ui.py')
