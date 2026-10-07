"""Extract everything the FOCS map needs from the layered Warcraft III archives."""
import os, re, sys, json, glob, collections
sys.path.insert(0, os.path.dirname(__file__))
from gamedata import GameData

OUT = 'war3_extracted'
gd = GameData()
LIST = gd.listfile()                       # lowercase-key -> original casing

def resolve(path):
    # JASS string literals escape separators, so "a\\b.mdl" means a\b.mdl
    p = str(path).strip().replace('\\\\', '\\').replace('/', '\\').lstrip('\\').lower()
    if p in LIST: return LIST[p]
    root, ext = os.path.splitext(p)
    for alt in ('.mdx', '.mdl', '.blp', '.tga', '.dds'):
        if root + alt in LIST: return LIST[root + alt]
    # MPQ resolves names by hash, so a file can be readable even when no
    # (listfile) entry names it -- several spell effects the script asks for by
    # .mdl are only reachable this way.  Probe the archive directly.
    for alt in (ext, '.mdx', '.mdl', '.blp', '.tga', '.dds'):
        if not alt: continue
        cand = root + alt
        try:
            d, _src = gd.read(cand)
        except Exception:
            continue
        if d:
            LIST[cand] = cand
            return cand
    return None

saved, sources = {}, collections.Counter()
def grab(ap):
    if ap in saved: return True
    d, src = gd.read(ap)
    if d is None: return False
    out = os.path.join(OUT, ap.replace('\\', os.sep))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, 'wb').write(d)
    saved[ap] = out
    sources[src] += 1
    return True

TEXREF = re.compile(rb'[A-Za-z0-9_\-\\/ .()]{4,250}\.(?:blp|tga|dds)', re.I)
def grab_model(ap):
    """A model plus every texture its TEXS chunk names."""
    if not grab(ap): return False
    if not ap.lower().endswith('.mdx'): return True
    for mt in TEXREF.finditer(open(saved[ap], 'rb').read()):
        t = resolve(mt.group(0).decode('latin-1'))
        if t: grab(t)
    return True

# ---- 1. scripts and data tables
for p in ['Scripts\\common.j', 'Scripts\\Blizzard.j', 'Scripts\\common.ai',
          'TerrainArt\\Terrain.slk', 'TerrainArt\\CliffTypes.slk',
          # per-tileset water: surface offset, frame count and animation rate
          'TerrainArt\\Water.slk']:
    grab(p)
tables = 0
for low, orig in LIST.items():
    if not low.endswith(('.slk', '.txt')): continue
    # Splats\ carries UberSplatData.slk -- the ground decal stamped under every
    # building -- and LightningData.slk, which 37 of this map's abilities name a
    # bolt type from. Neither directory was listed, so both systems had no data
    # to work from and simply did not exist.
    if low.startswith(('units\\', 'doodads\\', 'ui\\', 'abilities\\', 'items\\',
                       'splats\\')):
        if grab(orig): tables += 1

# The splat and lightning tables name their own textures, and nothing else in
# the game references them -- no model, no script -- so the art-following pass
# below never reaches them. Read the tables and take what they ask for.
for _tbl in ('Splats\\UberSplatData.slk', 'Splats\\LightningData.slk',
             'Splats\\SplatData.slk', 'Splats\\SpawnData.slk'):
    _p = os.path.join(OUT, _tbl.replace('\\', os.sep))
    if not os.path.exists(_p):
        continue
    try:
        from slk import parse_slk as _ps
        _rows = _ps(_p)
        for _r in (_rows.values() if isinstance(_rows, dict) else _rows):
            _d, _f = str(_r.get('Dir') or ''), str(_r.get('file') or '')
            if _d and _f and _f not in ('-', '_'):
                grab(resolve('%s\\%s' % (_d, _f)) or ('%s\\%s.blp' % (_d, _f)))
    except Exception as _e:
        print('splat/lightning textures: %s' % _e)

# ---- 2. art referenced by the map's object data and script
refs = collections.Counter()
for f in ['war3map.w3u', 'war3map.w3t', 'war3map.w3a', 'war3map.w3h', 'war3map.w3q']:
    d = json.load(open('data/%s.json' % f))
    for tbl in ('base', 'custom'):
        for o in d[tbl]:
            for k, v in o['mods'].items():
                if isinstance(v, str):
                    for mt in re.finditer(r'[^",;]*\.(mdl|mdx|blp|tga)', v, re.I):
                        refs[mt.group(0).strip()] += 1
js = open('extracted/war3map.j', encoding='latin-1').read()
for mt in re.finditer(r'"([^"]*\.(?:mdl|mdx|blp|tga))"', js, re.I):
    refs[mt.group(1)] += 1

missing = collections.Counter()
for p in refs:
    ap = resolve(p)
    if ap: grab_model(ap)
    else: missing[p] += refs[p]

# ---- 2b. the art Warcraft III plays for an ability itself
# Casterart/Targetart/Missileart and friends live in Units\*AbilityFunc.txt, not
# in AbilityData.slk, so nothing above reaches them: the map only names art it
# overrides, and it usually overrides only the icon.  Without this a spell keeps
# whatever the map's trigger adds by hand and loses everything the engine would
# have drawn -- the summoning puff, the missile, the strike flash.
ART_KEYS = ('casterart', 'targetart', 'specialart', 'effectart',
            'areaeffectart', 'missileart', 'lightningeffect')


def ability_art_refs():
    """Art paths for every ability this map can actually reach."""
    want = set()
    for f in ['war3map.w3a']:
        try:
            d = json.load(open('data/%s.json' % f))
        except OSError:
            continue
        for tbl in ('base', 'custom'):
            for o in d[tbl]:
                want.add(o['origin'])
                want.add(o['id'])
    for t in (json.load(open('data/unittypes.json'))
              if os.path.exists('data/unittypes.json') else {}).values():
        for a in (t.get('abilities') or []) + (t.get('heroAbilities') or []):
            want.add(a)
    # Items grant their powers through abilities too, and those live only in the
    # item table -- nothing above reaches AIsm and the rest, so every shop item's
    # effect art went unextracted.
    for it in (json.load(open('data/itemtypes.json'))
               if os.path.exists('data/itemtypes.json') else {}).values():
        for a in (it.get('abilities') or []):
            want.add(a)
    # An ability whose effect persists keeps its art on the *buff* it applies:
    # [ANms] names only an icon, and Targetart=...ManaShieldCaster.mdl sits in
    # [BNms] next door. Warcraft III pairs them by convention, A... <-> B..., and
    # the map derives its own buffs from Blizzard's, so both ends are wanted.
    for a in list(want):
        if a[:1] in ('A', 'a'):
            want.add('B' + a[1:])
    try:
        w3h = json.load(open('data/war3map.w3h.json'))
        for tbl in ('base', 'custom'):
            for o in w3h.get(tbl, []):
                want.add(o['id'])
                want.add(o['origin'])
    except (OSError, ValueError):
        pass
    out = collections.Counter()
    for fp in glob.glob(os.path.join(OUT, 'Units', '*AbilityFunc.txt')):
        cur = None
        for line in open(fp, encoding='latin-1', errors='replace'):
            line = line.strip()
            mm = re.match(r'^\[([^\]]+)\]$', line)
            if mm:
                cur = mm.group(1)
                continue
            if not cur or cur not in want or '=' not in line:
                continue
            k, _, v = line.partition('=')
            if k.strip().lower() not in ART_KEYS:
                continue
            # an art field can list several models, comma separated
            for one in v.strip().strip('"').split(','):
                one = one.strip()
                if one and one not in ('_', '-'):
                    out[one] += 1
    return out


art_hits = 0
for p in ability_art_refs():
    ap = resolve(p)
    if ap and grab_model(ap):
        art_hits += 1
    elif not ap:
        missing[p] += 1
print('ability art models: %d grabbed from *AbilityFunc.txt' % art_hits)

# ---- 2c. every art path the resolved ability table actually names
# The section above derives its own set of ability and buff ids and reads the
# .txt files directly, which means anything it fails to derive is never asked
# for -- and 27 spell effects were sitting unread in archives already on disk
# because of it.  data/abilities.json is the authoritative answer to "what will
# the runtime ask to draw", so harvest that instead of guessing again.
def resolved_art_refs():
    out = collections.Counter()
    try:
        table = json.load(open('data/abilities.json'))
    except (OSError, ValueError):
        return out
    skip = {'anim', 'missileSpeed', 'missileArc', 'missileHoming', 'lightning'}
    for a in table.values():
        for slot, v in (a.get('art') or {}).items():
            if slot in skip:
                continue
            for one in str(v).split(','):
                one = one.strip()
                if one and one not in ('_', '-') and one.lower() != 'none':
                    out[one] += 1
    return out


def spray_model_refs():
    """The models ParticleEmitter1 throws -- bones, guts, feathers.

    They are named inside the emitter chunk rather than in any .slk or .txt, so
    nothing else in this file goes looking for them.
    """
    out = collections.Counter()
    import mdx as _mdx
    for fp in (glob.glob(os.path.join(OUT, '**', '*.mdx'), recursive=True)
               + glob.glob('extracted/**/*.mdx', recursive=True)):
        try:
            M = _mdx.parse(fp)
        except Exception:
            continue
        for n in M['particles']:
            if n.get('type') == 'PREM' and n.get('spawnModel'):
                out[n['spawnModel']] += 1
    return out


resolved_hits = resolved_missing = 0
for p in resolved_art_refs():
    ap = resolve(p)
    if ap and grab_model(ap):
        resolved_hits += 1
    else:
        resolved_missing += 1
        missing[p] += 1
print('ability art named by the resolved table: %d grabbed, %d not in any archive'
      % (resolved_hits, resolved_missing))

spray_hits = 0
for p in spray_model_refs():
    ap = resolve(p)
    if ap and grab_model(ap):
        spray_hits += 1
    elif not ap:
        missing[p] += 1
print('particle spray models: %d grabbed' % spray_hits)

# ---- 2d. item icons and ground models
# ItemData.slk carries the model file; the icon is in Units\ItemFunc.txt, the same
# .slk/.txt split the units and abilities use.  Without these the shop draws blank
# squares for every stock item the map merely re-prices.
def item_art_refs():
    out = collections.Counter()
    fp = os.path.join(OUT, 'Units', 'ItemFunc.txt')
    if os.path.exists(fp):
        cur = None
        for line in open(fp, encoding='latin-1', errors='replace'):
            line = line.strip()
            mm = re.match(r'^\[([^\]]+)\]$', line)
            if mm:
                cur = mm.group(1)
                continue
            if cur and '=' in line:
                k, _, v = line.partition('=')
                if k.strip().lower() == 'art':
                    v = v.strip().strip('"')
                    if v and v not in ('_', '-'):
                        out[v] += 1
    # the model an item uses when it is lying on the ground
    slk = os.path.join(OUT, 'Units', 'ItemData.slk')
    if os.path.exists(slk):
        from slk import parse_slk as _ps
        for r in _ps(slk):
            f = str(r.get('file') or '').strip()
            if f and f not in ('_', '-'):
                out[f] += 1
    return out


item_hits = 0
for p in item_art_refs():
    ap = resolve(p)
    if ap and grab_model(ap):
        item_hits += 1
    elif not ap:
        missing[p] += 1
print('item icons and models: %d grabbed' % item_hits)

# ---- 3. a model for every unit type the script can spawn
types = json.load(open('data/unittypes.json')) if os.path.exists('data/unittypes.json') else {}
for uid, t in types.items():
    mp = t.get('model')
    if not mp or not str(mp).strip('-'): continue
    ap = resolve(mp)
    if ap: grab_model(ap)
    else: missing[str(mp)] += 1

# ---- 3c. the missile each unit type throws
# Missileart lives in Units\*UnitFunc.txt, not in any .slk, so nothing above
# reaches it: 301 of this map's unit types are ranged and only the handful the
# map overrides itself would otherwise have a missile model at all.  Read the
# func files straight from disk -- step 1 has already put them there, and
# unittypes.json has not necessarily been rebuilt against them yet.
def unit_missile_refs():
    spawnable = set(types) if types else set()
    out = collections.Counter()
    for fp in glob.glob(os.path.join(OUT, 'Units', '*UnitFunc.txt')):
        cur = None
        for line in open(fp, encoding='latin-1', errors='replace'):
            line = line.strip()
            mm = re.match(r'^\[([^\]]+)\]$', line)
            if mm:
                cur = mm.group(1)
                continue
            if not cur or '=' not in line:
                continue
            if spawnable and cur not in spawnable:
                continue
            k, _, v = line.partition('=')
            if k.strip().lower() not in ('missileart', 'missileart2'):
                continue
            for one in v.strip().strip('"').split(','):
                one = one.strip()
                if one and one not in ('_', '-'):
                    out[one] += 1
    return out


missile_hits = 0
for p in unit_missile_refs():
    ap = resolve(p)
    if ap and grab_model(ap):
        missile_hits += 1
    elif not ap:
        missing[p] += 1
print('unit missile models: %d grabbed from *UnitFunc.txt' % missile_hits)

# ---- 3b. models for every doodad/destructable the map actually places
def placed_doodad_models():
    from slk import parse_slk
    try:
        placed = {d['id'] for d in json.load(open('data/doodads.json'))['doodads']}
    except Exception:
        return []
    table, tex, path = {}, {}, {}
    for f, idk in ((os.path.join(OUT, 'Doodads/Doodads.slk'), 'doodID'),
                   (os.path.join(OUT, 'Units/DestructableData.slk'), 'DestructableID')):
        if os.path.exists(f):
            for r in parse_slk(f):
                i = str(r.get(idk) or '')
                if i:
                    table[i] = str(r.get('file') or '')
                    # DestructableData's texFile: the texture a *replaceable*
                    # slot stands for. grab_model only follows textures a
                    # model's TEXS chunk names, and a replaceable slot names
                    # nothing -- so without this the tree textures are never
                    # pulled and the trees draw with no texture at all.
                    tf = str(r.get('texFile') or '').strip()
                    if tf and tf not in ('_', '-'):
                        tex[i] = tf
                    # pathTex: the footprint a destructable blocks. Warcraft III
                    # stamps it into the pathing map at runtime, which is why
                    # the editor does not bake it into war3map.wpm and why the
                    # walls and gates were walked straight through.
                    # pathTexDeath is the footprint the wreckage leaves once it
                    # is destroyed -- a broken gate is a hole with rubble in it,
                    # not clear ground -- so both are needed to open one.
                    for _c in ('pathTex', 'pathTexDeath'):
                        pt = str(r.get(_c) or '').strip()
                        if pt and pt.lower() not in ('_', '-', 'none', ''):
                            path.setdefault(i, []).append(pt)
    return ([table[i] for i in placed if table.get(i)],
            [tex[i] for i in placed if tex.get(i)],
            [p for i in placed for p in path.get(i, ())])

dood_models = 0
_dood_files, _dood_tex, _dood_path = placed_doodad_models()
dood_tex = 0
for tp in _dood_tex:
    ap = resolve(tp)
    if ap and grab(ap):
        dood_tex += 1
dood_path = 0
for pp in _dood_path:
    ap = resolve(pp)
    if ap and grab(ap):
        dood_path += 1
for fp in _dood_files:
    # doodads come in numbered variations (Cactus0.mdx, Cactus1.mdx ...); the
    # SLK gives the stem and war3map.doo's `variation` picks one
    got = False
    for suffix in [''] + [str(n) for n in range(8)]:
        ap = resolve(fp + suffix)
        if ap and grab_model(ap):
            got = True
    if got:
        dood_models += 1
print('doodad replaceable textures: %d grabbed from texFile, %d pathing footprints from pathTex'
      % (dood_tex, dood_path))

# ---- 4. this map's tileset, plus UI and team-colour sets
def tileset_dirs():
    """Directories holding the ground/cliff art the map's own w3e asks for."""
    dirs = set()
    try:
        t = json.load(open('data/terrain.json'))
    except Exception:
        return dirs
    from slk import parse_slk
    terr = os.path.join(OUT, 'TerrainArt/Terrain.slk')
    cliffs = os.path.join(OUT, 'TerrainArt/CliffTypes.slk')
    if os.path.exists(terr):
        rows = {str(r.get('tileID')): r for r in parse_slk(terr)}
        for tid in t.get('groundTiles', []):
            r = rows.get(tid)
            if r and r.get('dir'):
                dirs.add(str(r['dir']).replace('/', '\\').lower())
    if os.path.exists(cliffs):
        rows = {str(r.get('cliffID')): r for r in parse_slk(cliffs)}
        for cid in t.get('cliffTiles', []):
            r = rows.get(cid) or rows.get(cid[1:])
            if r and r.get('dir'):
                dirs.add(str(r['dir']).replace('/', '\\').lower())
    return dirs

TILESET_DIRS = tileset_dirs()
extra = 0
for low, orig in LIST.items():
    keep = any(low.startswith(d) for d in TILESET_DIRS)
    if not keep:
        keep = (low.startswith('terrainart\\cliff')
                or low.startswith('replaceabletextures\\teamcolor')
                or low.startswith('replaceabletextures\\teamglow')
                or low.startswith('replaceabletextures\\selectionscaling')
                or low.startswith('replaceabletextures\\shadows'))
    if keep and grab(orig):
        extra += 1

print('extracted %d files (%d data tables, %d tileset/UI, %d doodad models)'
      % (len(saved), tables, extra, dood_models))
print('by archive:', dict(sources))
print('unresolved art references: %d distinct (%d uses)' % (len(missing), sum(missing.values())))
for p, c in missing.most_common(10): print('   %3dx %s' % (c, p))
json.dump({'saved': sorted(saved), 'missing': dict(missing.most_common())},
          open('data/war3_assets.json', 'w'), indent=1)
