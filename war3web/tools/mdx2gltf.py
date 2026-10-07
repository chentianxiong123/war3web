"""Convert Warcraft III MDX models to glTF 2.0 (.glb) with skin + animations."""
import sys, os, json, math, glob, shutil
sys.path.insert(0, os.path.dirname(__file__))
import numpy as np
import mdx
from gltf import GLTF

FPS = 30.0

# ParticleEmitter2 bits in an MDX node's flags word.
PRE2_FLAGS = {
    'unshaded': 0x10000,
    'sortFarZ': 0x20000,
    'lineEmitter': 0x40000,
    'unfogged': 0x80000,
    'modelSpace': 0x100000,
    'xyQuad': 0x200000,
}
TEXIDX = json.load(open('assets/textures.json'))
OUTDIR = 'assets/models'
# How many models may fail before the run is called broken. The archives hold
# the odd malformed MDX; they do not hold hundreds, and a client cannot draw a
# model that was never written.
FAIL_FLOOR = int(os.environ.get('FOC_MODEL_FAIL_FLOOR', '5'))

# ---------------------------------------------------------------- track eval
def track_keys(tr):
    return sorted(tr['keys'], key=lambda k: k[0])

def hermite(a, b, ta, tb, t):
    t2, t3 = t*t, t*t*t
    h1 = 2*t3 - 3*t2 + 1; h2 = t3 - 2*t2 + t
    h3 = -2*t3 + 3*t2;    h4 = t3 - t2
    return h1*a + h2*ta + h3*b + h4*tb

def bezier(a, b, ta, tb, t):
    it = 1 - t
    return it**3*a + 3*t*it*it*ta + 3*t*t*it*tb + t**3*b

def slerp(q0, q1, t):
    d = float(np.dot(q0, q1))
    if d < 0: q1 = -q1; d = -d
    if d > 0.9995: q = q0 + t*(q1-q0)
    else:
        th = math.acos(max(-1.0, min(1.0, d))); s = math.sin(th)
        q = (math.sin((1-t)*th)/s)*q0 + (math.sin(t*th)/s)*q1
    n = np.linalg.norm(q)
    return q/n if n else np.array([0., 0., 0., 1.])

def eval_track(tr, frame, gseqs, is_quat, f0=None, f1=None):
    """Sample a track, evaluated *within one sequence only*.

    MDX packs every sequence onto a single timeline -- a spider's Stand is frames
    10000-11667, its Death 23333-24500, its Decay Flesh 33333-93333 -- and
    Warcraft III plays each sequence in isolation. Interpolating across the whole
    key list instead makes a track with no keys inside the playing sequence blend
    between the key before it and the key after it, so an idle spider slid a
    little further towards its death pose every frame of the loop and snapped
    back when the loop restarted. Keys outside [f0, f1] therefore take no part;
    a track with none inside returns None and the caller falls back to rest.

    Tracks driven by a global sequence are exempt: those run on their own clock
    and are deliberately independent of whichever sequence is playing.
    """
    ks = track_keys(tr)
    if not ks: return None
    g = tr['globalSeq']
    if g >= 0 and g < len(gseqs) and gseqs[g] > 0:
        frame = frame % gseqs[g]
    elif f0 is not None:
        ks = [k for k in ks if f0 <= k[0] <= f1]
        if not ks: return None
    if frame <= ks[0][0]:  return np.array(ks[0][1], np.float64)
    if frame >= ks[-1][0]: return np.array(ks[-1][1], np.float64)
    lo = 0
    for i in range(len(ks)-1):
        if ks[i][0] <= frame <= ks[i+1][0]: lo = i; break
    k0, k1 = ks[lo], ks[lo+1]
    span = k1[0] - k0[0]
    t = 0.0 if span == 0 else (frame - k0[0]) / span
    a = np.array(k0[1], np.float64); b = np.array(k1[1], np.float64)
    ip = tr['interp']
    if ip == 0: return a
    if is_quat:  return slerp(a, b, t)
    if ip == 1:  return a + (b - a) * t
    ta = np.array(k0[3], np.float64) if len(k0) > 3 else a   # outTan of k0
    tb = np.array(k1[2], np.float64) if len(k1) > 2 else b   # inTan of k1
    return (hermite if ip == 2 else bezier)(a, b, ta, tb, t)


def seq_track_vec(tr, seqs, default, dim, gseqs=()):
    """A vector track, per sequence -- or on its own clock if it has one.

    Texture animations translate in UV, so their keys are vectors rather than
    the scalars every other per-sequence track here carries.

    They also break the scoping rule the rest of this file follows. 55 of the 87
    texture-animation tracks in this map are driven by a *global sequence*: they
    run on a clock of their own, looping every `gseqs[i]` milliseconds no matter
    which animation is playing. That is how a beam flows continuously while its
    model stands, walks and attacks. Scoping those to the playing sequence finds
    no keys inside it and yields a still image -- which is what the first cut of
    this did to the Firelord.

    Returns (entries, step). `entries` is either one per sequence, or a single
    `{'g': seconds, 'k': [...]}` for a track that keeps its own time.
    """
    keys = track_keys(tr) if tr else []
    step = (tr['interp'] == 0) if tr else False
    if not keys:
        return [list(default)] * len(seqs), step

    def val(k):
        return [round(float(x), 5) for x in np.atleast_1d(k[1])[:dim]]

    g = tr['globalSeq']
    if 0 <= g < len(gseqs) and gseqs[g] > 0:
        return dict(g=round(gseqs[g] / 1000.0, 4),
                    k=[[round(k[0] / 1000.0, 4)] + val(k) for k in keys]), step

    out = []
    for s in seqs:
        s0, s1 = s['start'], s['end']
        ks = [k for k in keys if s0 <= k[0] <= s1]
        if not ks:
            out.append(list(default))
            continue
        vals = [val(k) for k in ks]
        if all(v == vals[0] for v in vals):
            out.append(vals[0])
        else:
            out.append([[round((k[0] - s0) / 1000.0, 4)] + v
                        for k, v in zip(ks, vals)])
    return out, step


def seq_track(tr, seqs, default, gseqs=()):
    """Sample one animation track per sequence, the way the engine scopes it.

    Returns (entries, step). One entry per sequence: a constant where the value
    holds still for the whole sequence, or [[t_seconds, value], ...] where it
    moves. A sequence the track leaves unkeyed falls back to `default` -- for a
    visibility track that is 1, for an emission rate the emitter's static rate.

    `step` reports the track's interpolation mode, which is not decoration:
    1753 of this map's 1758 emitter-visibility tracks and 721 of its 1064
    emission-rate tracks are stored as MDLINTERP_DONT_INTERP, meaning the value
    *holds* until the next key. Handing the client bare keys to interpolate
    between turns every one of those steps into a ramp -- a rate that should
    jump 0 -> 500 instead slides there over the gap.

    Hermite and bezier tracks are resampled here rather than passed on, because
    the curve math already lives in this file and the client should not have to
    carry a second copy of it. Linear keys need neither.
    """
    keys = track_keys(tr) if tr else []
    interp = tr['interp'] if tr else 1
    step = interp == 0
    out = []
    for s in seqs:
        s0, s1 = s['start'], s['end']
        ks = [k for k in keys if s0 <= k[0] <= s1]
        if not ks:
            out.append(default)
            continue
        vals = [float(np.atleast_1d(k[1])[0]) for k in ks]
        if len(set(vals)) == 1:
            out.append(round(vals[0], 4))
            continue
        if interp >= 2:
            # curved: sample it here so a straight line between the samples is
            # close enough, and the client keeps one interpolation rule
            f0, f1 = ks[0][0], ks[-1][0]
            n = max(2, min(120, int((f1 - f0) / 1000.0 * FPS) + 1))
            pts = []
            for fr in np.linspace(f0, f1, n):
                v = eval_track(tr, fr, gseqs, False, s0, s1)
                pts.append([round((fr - s0) / 1000.0, 4),
                            round(float(np.atleast_1d(v)[0]), 4)])
            out.append(pts)
        else:
            out.append([[round((k[0] - s0) / 1000.0, 4), round(v, 4)]
                        for k, v in zip(ks, vals)])
    return out, step



def _pair(name, res):
    """seq_track returns (entries, step); spread both into the extras dict."""
    entries, step = res
    return {name: entries, name + 'Step': step}


def seq_visibility(tr, seqs, gseqs=()):
    """An emitter's on/off switch, resolved per sequence.

    Warcraft III scopes every animation track to the sequence being played, and
    an emitter's visibility track is mostly a list of the sequences it is *off*
    for: across this map's models, 8594 of the 10381 keyed (emitter, sequence)
    pairs hold zero for the whole sequence, and only 1787 vary within one.
    Reading the track as a single timeline -- or ignoring it, which is what the
    client did -- leaves all 8594 emitting during Stand, so idle units smoked,
    bled and burned continuously.

    Returns one entry per sequence: a constant, or [[t_seconds, value], ...]
    for the sequences where the emitter actually switches partway through.

    A sequence with no keys falls back to 1, which is the track's default and
    also what the client did for every sequence before any of this existed, so
    the ~11% of pairs landing there keep the behaviour they already had.
    """
    return seq_track(tr, seqs, 1.0, gseqs)

# ---------------------------------------------------------------- textures
ASSET_BASE = ''   # client sets GLTFLoader resourcePath to /assets/

def _replaceable(kind):
    """Warcraft III's real team-colour / team-glow textures, if extracted."""
    for n in ('00', '01'):
        rel = 'textures/ReplaceableTextures/%s/%s%s.png' % (kind, kind, n)
        if os.path.exists(os.path.join('assets', rel)):
            return ASSET_BASE + rel
    return ASSET_BASE + ('textures/_teamcolor.png' if kind == 'TeamColor'
                         else 'textures/_teamglow.png')

def _cliff_texture():
    """Replaceable slot 11: "this tileset's cliff texture".

    The same slot the cliff meshes use, resolved the same way -- TerrainArt\\
    CliffTypes.slk names the texture unqualified and every tileset bar Lordaeron
    Summer ships its own recolour as <tileset>_<texFile>.blp, so the bare name
    would hand a Cityscape map grassy Lordaeron cliffs. tools/cliffs.py does this
    for the terrain; it runs after this script, so its output cannot be read and
    the table is read again here.

    It is not only cliffs that ask for the slot. Doodads built to sit against the
    terrain use it too, and with an empty path and no handling they came out
    untextured -- flat white. On this map that is the two city entrance gates.
    """
    import json as _json
    from slk import parse_slk
    try:
        t = _json.load(open('data/terrain.json'))
    except OSError:
        return None
    tileset = str(t.get('tileset') or '')
    cliffs = t.get('cliffTiles') or []
    # Which cliff type, when a map declares more than one? The one the terrain
    # actually uses. This map lists CYdi and CYsq, but its cliffTex is CYsq on
    # 4321 vertices against CYdi on 37, and the cliff meshes are drawn with
    # CYsq's Y_Cliff1 -- taking the first entry instead would texture the gates
    # with a cliff that appears almost nowhere on the map.
    import collections as _c
    seen = _c.Counter(v for v in (t.get('cliffTex') or []) if v < len(cliffs))
    order = [cliffs[i] for i, _ in seen.most_common()] or cliffs
    rows = {str(r.get('cliffID') or ''): r
            for r in parse_slk('war3_extracted/TerrainArt/CliffTypes.slk')}
    for cid in order:
        row = rows.get(cid)
        if not row:
            continue
        d = str(row.get('texDir') or 'ReplaceableTextures\\Cliff').replace('/', '\\')
        f = str(row.get('texFile') or 'Cliff0')
        for cand in ('%s\\%s_%s.blp' % (d, tileset, f), '%s\\%s.blp' % (d, f)):
            k = cand.lower()
            if k in TEXIDX:
                return ASSET_BASE + TEXIDX[k]
    return None


_CLIFF_TEX = None


def tex_uri(path, replaceable):
    global _CLIFF_TEX
    if replaceable == 1: return _replaceable('TeamColor')
    if replaceable == 2: return _replaceable('TeamGlow')
    if replaceable == 11:
        if _CLIFF_TEX is None:
            _CLIFF_TEX = _cliff_texture() or ''
        return _CLIFF_TEX or None
    if not path: return None
    key = path.replace('/', '\\').lower()
    base = key.split('\\')[-1]
    if key in TEXIDX: return ASSET_BASE + TEXIDX[key]
    for k, v in TEXIDX.items():
        if k.split('\\')[-1] == base: return ASSET_BASE + v
    # Blizzard-internal texture we don't own: substitute a neutral one
    return None

def pick_layer(M, mat):
    """Which of a material's layers is the surface you actually see.

    Warcraft III materials are stacked, and its usual way of team-colouring a
    unit is an underlay: layer 0 is the flat TeamColor swatch, and the real skin
    is blended over it so the colour shows only through the skin's transparent
    parts. Taking layer 0 -- the first one in the file -- therefore renders the
    team colour *instead of* the character. It is not a rare shape: 412 of this
    map's 1151 models are built that way, which is why Byakuya, who wears a white
    haori, arrived as a solid red silhouette.

    So: the surface is the topmost layer with a real texture. If every layer is
    replaceable the material genuinely is team-coloured -- a banner, a glow --
    and the first layer stands.

    Returns (layer, texture uri, team) where `team` is the replaceable id of a
    team texture that sits underneath, or 0.
    """
    layers = mat.get('layers') or []
    if not layers:
        return None, None, 0

    def tex_of(L):
        i = L['textureId']
        return M['textures'][i] if 0 <= i < len(M['textures']) else None

    t0 = tex_of(layers[0])
    under = t0['replaceableId'] if (t0 and t0['replaceableId'] in (1, 2)) else 0
    if under:
        # the underlay case: the skin is one of the layers stacked on top
        for L in reversed(layers[1:]):
            t = tex_of(L)
            if t and t['replaceableId'] not in (1, 2) and t['path']:
                return L, tex_uri(t['path'], t['replaceableId']), under
    # Otherwise layer 0 is the surface and anything above it is an overlay -- a
    # glow, a shimmer. Picking the top layer there would render the overlay and
    # throw the character away, which is the very mistake this exists to avoid.
    L = layers[0]
    return L, (tex_uri(t0['path'], t0['replaceableId']) if t0 else None), under


FILTER_ALPHA = {0: 'OPAQUE', 1: 'MASK', 2: 'BLEND', 3: 'BLEND', 4: 'BLEND', 5: 'BLEND', 6: 'BLEND'}
FILTER_NAME  = {0: 'none', 1: 'transparent', 2: 'blend', 3: 'additive',
                4: 'addalpha', 5: 'modulate', 6: 'modulate2x'}

def convert(path, out_dir=OUTDIR, name=None):
    M = mdx.parse(path)
    name = name or os.path.splitext(os.path.basename(path))[0]
    g = GLTF()
    nodes = M['bones'] + M['helpers'] + M['attachments'] + M['collisions'] + M['events'] + M['particles']
    nodes.sort(key=lambda n: n['objectId'])
    pivots = M['pivots']
    nid = {n['objectId']: i + 1 for i in range(len(nodes)) for n in [nodes[i]]}   # +1 for root

    # root: Z-up (MDX) -> Y-up (glTF)
    q = [-math.sin(math.pi/4), 0.0, 0.0, math.cos(math.pi/4)]
    g.j['nodes'].append(dict(name='MDX_ROOT', rotation=q, children=[]))
    g.j['scenes'][0]['nodes'] = [0]

    def pivot(i):
        return np.array(pivots[i], np.float64) if i < len(pivots) else np.zeros(3)

    for n in nodes:
        p = pivot(n['objectId'])
        pp = pivot(n['parentId']) if n['parentId'] >= 0 else np.zeros(3)
        nd = dict(name=n['name'] or ('obj%d' % n['objectId']),
                  translation=[float(x) for x in (p - pp)], children=[])
        # glTF has no particles, so the emitter rides along as extras and the
        # client rebuilds it. Without this, the ~80 effect models that are made
        # of nothing but emitters convert to a valid and completely empty scene.
        if n.get('type') == 'PRE2':
            tex = None
            if 0 <= n['textureId'] < len(M['textures']):
                t = M['textures'][n['textureId']]
                tex = tex_uri(t.get('path'), t.get('replaceableId'))
            nd['extras'] = dict(w3particle=dict(
                speed=n['speed'], variation=n['variation'], latitude=n['latitude'],
                gravity=n['gravity'], lifespan=n['lifespan'],
                rateStatic=n['emissionRate'],
                length=n['length'], width=n['width'], filter=n['filterMode'],
                rows=max(1, n['rows']), cols=max(1, n['columns']),
                headOrTail=n['headOrTail'], tailLength=n['tailLength'],
                squirt=n['squirt'], texture=tex,
                # The node flags word carries the emitter's shape and space, and
                # no bit of it was ever decoded. 385 of this map's emitters are
                # line emitters, 223 emit in model space -- following the bone
                # instead of being left behind -- and 666 are unshaded.
                **{k: bool(n['flags'] & v) for k, v in PRE2_FLAGS.items()},
                color=n['segmentColor'], alpha=[a / 255.0 for a in n['segmentAlpha']],
                scale=n['segmentScaling'],
                **_pair('vis', seq_visibility(n['tracks'].get('KP2V'),
                                              M['sequences'], M['globalSeqs'])),
                # An emitter's rate is usually animated, and where it is, the
                # static `emissionRate` beside it is 0: 1057 of this map's 2517
                # ParticleEmitter2s are in that state -- every large death
                # explosion, every building blast, the fire and frost breath
                # missiles. Reading the static number makes all of them emit
                # exactly nothing, forever.
                **_pair('rate', seq_track(n['tracks'].get('KP2E'), M['sequences'],
                                          round(float(n['emissionRate']), 4),
                                          M['globalSeqs']))))
        # An event object fires at a keyframe: blood hits the ground, a foot
        # lands, a body part is thrown, a sound plays. The node's name is a
        # four-character kind and a four-character id into one of Warcraft III's
        # tables -- SPLxHBS1 is Human Blood Small 1 in SplatData.slk, SNDxDHLS a
        # sound in AnimLookups.slk -- and its KEVT track says when. 827 of this
        # map's 1101 models carry these and the fire times were being dropped,
        # so none of it could ever happen: no blood, no footprints, no impacts.
        if n.get('type') == 'event' and len(n.get('name') or '') >= 8:
            nm = n['name']
            fires = []
            for s in M['sequences']:
                s0, s1 = s['start'], s['end']
                fires.append([round((t - s0) / 1000.0, 4)
                              for t in (n.get('times') or []) if s0 <= t <= s1])
            if any(fires):
                nd['extras'] = dict(w3event=dict(
                    kind=nm[:3], id=nm[4:8], at=fires))
        # ParticleEmitter1 throws whole models -- bones, guts, feathers -- so
        # what it needs carried across is the name of the thing it throws.
        if n.get('type') == 'PREM' and n.get('spawnModel'):
            nd['extras'] = dict(w3spray=dict(
                rate=n['emissionRate'], gravity=n['gravity'],
                longitude=n['longitude'], latitude=n['latitude'],
                lifespan=n['lifespan'], speed=n['initVelocity'],
                model=n['spawnModel'],
                **_pair('vis', seq_visibility(n['tracks'].get('KPEV'),
                                              M['sequences'], M['globalSeqs']))))
        # An omni light. Directional ones belong to the day/night cycle models,
        # which nothing here uses, so only point lights are carried across.
        if n.get('type') == 'LITE' and n.get('lightType') == 0:
            nd['extras'] = dict(w3light=dict(
                color=n['color'], intensity=n['intensity'],
                attStart=n['attStart'], attEnd=n['attEnd'],
                **_pair('vis', seq_visibility(n['tracks'].get('KLAV'),
                                              M['sequences'], M['globalSeqs']))))
        # A ribbon is a trail dragged behind a point on the skeleton, and its
        # look comes from a *material* rather than a texture directly, so the
        # same layer rule that picks a mesh's surface picks the ribbon's.
        if n.get('type') == 'RIBB':
            mat = M['materials'][n['materialId']] if 0 <= n['materialId'] < len(M['materials']) else None
            L, uri, _team = pick_layer(M, mat) if mat else (None, None, 0)
            nd['extras'] = dict(w3ribbon=dict(
                above=n['heightAbove'], below=n['heightBelow'],
                alpha=n['alpha'], color=n['color'], lifespan=n['lifespan'],
                rate=max(1, n['emissionRate']), rows=max(1, n['rows']),
                cols=max(1, n['columns']), slot=n['textureSlot'],
                gravity=n['gravity'], texture=uri,
                filter=(L['filterMode'] if L else 0),
                **_pair('vis', seq_visibility(n['tracks'].get('KRVS'),
                                              M['sequences'], M['globalSeqs']))))
        g.j['nodes'].append(nd)
    for n in nodes:
        parent = 0 if n['parentId'] < 0 else nid[n['parentId']]
        g.j['nodes'][parent]['children'].append(nid[n['objectId']])
    for nd in g.j['nodes']:
        if not nd['children']: del nd['children']

    # skin: inverse bind = translate(-pivot)
    ibm = np.zeros((len(nodes), 16), np.float32)
    joints = []
    for i, n in enumerate(nodes):
        p = pivot(n['objectId'])
        m = np.eye(4, dtype=np.float32)
        m[:3, 3] = -p
        ibm[i] = m.T.reshape(16)          # glTF is column-major
        joints.append(nid[n['objectId']])
    skin = dict(joints=joints, inverseBindMatrices=g.acc(ibm.reshape(-1), 'MAT4', 'f'), skeleton=0)
    g.j['skins'].append(skin)

    # ------------------------------------------------------------- materials
    matmap, matmeta = {}, []
    for mi, mat in enumerate(M['materials']):
        L, uri, team = pick_layer(M, mat)
        if L and 0 <= L['textureId'] < len(M['textures']):
            t = M['textures'][L['textureId']]
        fm = L['filterMode'] if L else 0
        sh = L['shadingFlags'] if L else 0
        # A skin lifted off a team-colour underlay has nothing left beneath it,
        # so blending it would show the world through the character. Alpha-test
        # instead: solid where the skin is, gone where it is not.
        if team and fm == 2: fm = 1
        pbr = dict(metallicFactor=0.0, roughnessFactor=0.85)
        if uri:
            pbr['baseColorTexture'] = dict(index=g.texture(g.image(uri), g.sampler()))
        d = dict(name='mat%d' % mi, pbrMetallicRoughness=pbr,
                 alphaMode=FILTER_ALPHA.get(fm, 'OPAQUE'),
                 doubleSided=bool(sh & 0x10))
        if d['alphaMode'] == 'MASK': d['alphaCutoff'] = 0.35
        if sh & 0x1 and uri:                      # unshaded -> emissive
            d['emissiveFactor'] = [1.0, 1.0, 1.0]
            d['emissiveTexture'] = pbr.get('baseColorTexture')
        g.j['materials'].append(d)
        matmap[mi] = len(g.j['materials']) - 1
        # A layer can bind a texture animation, which slides, turns or stretches
        # its UVs while a sequence plays. That is how a beam flows along its own
        # length, a portal turns and an aura crawls -- 83 layers across 39 of
        # this map's models ask for one, and nothing carried it across, so all of
        # them drew a still image.
        uv = None
        ai = L.get('texAnimId', -1) if L else -1
        if 0 <= ai < len(M['texAnims']):
            ta = M['texAnims'][ai]['tracks']
            t_e, t_s = seq_track_vec(ta.get('KTAT'), M['sequences'], (0.0, 0.0), 2,
                                     M['globalSeqs'])
            r_e, r_s = seq_track_vec(ta.get('KTAR'), M['sequences'], (0.0, 0.0, 0.0, 1.0), 4,
                                     M['globalSeqs'])
            s_e, s_s = seq_track_vec(ta.get('KTAS'), M['sequences'], (1.0, 1.0), 2,
                                     M['globalSeqs'])
            uv = dict(t=t_e, tStep=t_s, r=r_e, rStep=r_s, s=s_e, sStep=s_s)
        matmeta.append(dict(filter=FILTER_NAME.get(fm, 'none'), unshaded=bool(sh & 0x1),
                            twoSided=bool(sh & 0x10), noDepthTest=bool(sh & 0x40),
                            noDepthSet=bool(sh & 0x80), priority=mat['priorityPlane'],
                            texture=uri, teamColor=team, uv=uv))

    # -------------------------------------------------------------- geosets
    prims, geometa = [], []
    for gi, geo in enumerate(M['geosets']):
        V = np.array(geo['vertices'], np.float32).reshape(-1, 3)
        N = np.array(geo['normals'], np.float32).reshape(-1, 3)
        UV = (np.array(geo['uvs'][0], np.float32).reshape(-1, 2)
              if geo['uvs'] else np.zeros((len(V), 2), np.float32))
        IDX = np.array(geo['indices'], np.uint32)
        # skin weights
        offs, acc_ = [], 0
        for c in geo['matrixGroups']:
            offs.append((acc_, c)); acc_ += c
        J = np.zeros((len(V), 4), np.uint16)
        W = np.zeros((len(V), 4), np.float32)
        boneIndex = {n['objectId']: i for i, n in enumerate(nodes)}
        for vi in range(len(V)):
            grp = geo['vertexGroups'][vi] if vi < len(geo['vertexGroups']) else 0
            if grp >= len(offs): grp = 0
            o, c = offs[grp]
            ids = geo['matrixIndices'][o:o+c][:4]
            if not ids: ids = [nodes[0]['objectId']]
            for k, b in enumerate(ids):
                J[vi, k] = boneIndex.get(b, 0)
            W[vi, :len(ids)] = 1.0 / len(ids)
        prim = dict(attributes=dict(
                        POSITION=g.acc(V.reshape(-1), 'VEC3', 'f', 34962, minmax=True),
                        NORMAL=g.acc(N.reshape(-1), 'VEC3', 'f', 34962),
                        TEXCOORD_0=g.acc(UV.reshape(-1), 'VEC2', 'f', 34962),
                        JOINTS_0=g.acc(J.reshape(-1), 'VEC4', 'H', 34962),
                        WEIGHTS_0=g.acc(W.reshape(-1), 'VEC4', 'f', 34962)),
                    indices=g.acc(IDX, 'SCALAR', 'I', 34963), mode=4)
        if geo['materialId'] in matmap: prim['material'] = matmap[geo['materialId']]
        prims.append(prim)
        geometa.append(dict(material=geo['materialId'], tris=len(IDX)//3,
                            extent=geo['extent'], selectionGroup=geo['selectionGroup']))
    g.j['meshes'].append(dict(name=name, primitives=prims))
    g.j['nodes'].append(dict(name='mesh', mesh=0, skin=0))
    g.j['nodes'][0].setdefault('children', []).append(len(g.j['nodes']) - 1)

    # ------------------------------------------------------------ animations
    gseqs = M['globalSeqs']
    seqmeta = []
    # Every channel any sequence touches has to appear in *all* of them.  glTF
    # nodes are shared between animations, so a node the playing clip does not
    # animate simply keeps whatever the last clip left there -- the same trap the
    # geoset-alpha handling documents.  Warcraft III models make it bite hard:
    # Decay Flesh is the last sequence in the file and settles a corpse into the
    # ground, so a spider standing still inherited the decay pose and sank.
    animated = set()
    for _sq in M['sequences']:
        for _n in nodes:
            for _tag, _path in (('KGTR', 'translation'), ('KGRT', 'rotation'), ('KGSC', 'scale')):
                _tr = _n['tracks'].get(_tag)
                if _tr and _tr['keys']:
                    animated.add((_n['objectId'], _path))
    for si, seq in enumerate(M['sequences']):
        f0, f1 = seq['start'], seq['end']
        dur_ms = max(1, f1 - f0)
        nsamp = max(2, min(600, int(dur_ms / 1000.0 * FPS) + 1))
        times = np.linspace(f0, f1, nsamp)
        samplers, channels = [], []
        for n in nodes:
            ni = nid[n['objectId']]
            p = pivot(n['objectId'])
            pp = pivot(n['parentId']) if n['parentId'] >= 0 else np.zeros(3)
            rest_t = p - pp
            for tag, path_, dim, default, isq in (
                    ('KGTR', 'translation', 3, np.zeros(3), False),
                    ('KGRT', 'rotation', 4, np.array([0., 0., 0., 1.]), True),
                    ('KGSC', 'scale', 3, np.ones(3), False)):
                if (n['objectId'], path_) not in animated:
                    continue                           # nothing ever moves it
                tr = n['tracks'].get(tag)
                rest = rest_t if path_ == 'translation' else default
                if not tr or not tr['keys']:
                    # this sequence leaves the channel alone, but another one does
                    # not: pin it to rest so the clip cannot inherit that pose
                    vals = np.tile(np.asarray(rest, np.float32), (2, 1))
                    ts = np.array([f0, f1], float)
                else:
                    vals = np.zeros((nsamp, dim), np.float32)
                    inrange = False
                    for k, fr in enumerate(times):
                        v = eval_track(tr, fr, gseqs, isq, f0, f1)
                        if v is None:
                            v = default                # no keys inside this sequence
                        else:
                            inrange = True
                        if path_ == 'translation': v = v + rest_t
                        vals[k] = v
                    if not inrange:
                        vals = np.tile(np.asarray(rest, np.float32), (2, 1))
                        ts = np.array([f0, f1], float)
                    else:
                        ts = times
                    if np.allclose(vals, vals[0], atol=1e-6):
                        vals = vals[:2].copy()         # constant: two keys is enough
                        ts = np.array([f0, f1], float)
                ta = g.acc((ts - f0) / 1000.0, 'SCALAR', 'f')
                va = g.acc(vals.reshape(-1), 'VEC4' if dim == 4 else 'VEC3', 'f')
                samplers.append(dict(input=ta, output=va, interpolation='LINEAR'))
                channels.append(dict(sampler=len(samplers)-1,
                                     target=dict(node=ni, path=path_)))
        if channels:
            g.j['animations'].append(dict(name=seq['name'], samplers=samplers, channels=channels))
        seqmeta.append(dict(name=seq['name'], start=f0, end=f1,
                            duration=dur_ms/1000.0, loop=not bool(seq['nonLooping']),
                            moveSpeed=seq['moveSpeed'], rarity=seq['rarity'],
                            hasAnim=bool(channels), extent=seq['extent']))

    # ---------------------------------------------- per-sequence geoset alpha
    # Warcraft III evaluates animation tracks *scoped to the playing sequence*:
    # keys outside [seq.start, seq.end] never apply, and a sequence holding no
    # keys for a track falls back to the object's static value.  Sampling the
    # raw track at seq.start instead carries the previous sequence's trailing
    # value forward -- which hid the gnoll's body geosets during Walk, because
    # its last key belongs to Decay Bone 60s earlier.
    ngeo = len(M['geosets'])
    geo_of_anim = {}
    for a in M['geosetAnims']:
        if 0 <= a['geosetId'] < ngeo:
            geo_of_anim[a['geosetId']] = a

    def _scalar(v):
        try: return float(np.atleast_1d(v)[0])
        except Exception: return float(v)

    for sm, seq in zip(seqmeta, M['sequences']):
        s0, s1 = seq['start'], seq['end']
        alphas, curves = [], []
        for gi in range(ngeo):
            a = geo_of_anim.get(gi)
            if a is None:
                alphas.append(1.0); curves.append(None); continue
            tr = a['tracks'].get('KGAO')
            keys = [k for k in track_keys(tr) if s0 <= k[0] <= s1] if tr else []
            if not keys:
                alphas.append(round(float(a['alpha']), 4)); curves.append(None)
                continue
            pts = [[round((k[0] - s0) / 1000.0, 4), round(_scalar(k[1]), 4)]
                   for k in keys]
            alphas.append(pts[0][1])
            # only worth animating when the value actually moves in-sequence
            curves.append(pts if len({v for _, v in pts}) > 1 else None)
        sm['geosetAlpha'] = alphas
        if any(c for c in curves):
            sm['geosetAlphaCurve'] = curves

        # The material's own alpha over the sequence (KMTA), which is a
        # different track from the geoset's and the one that dissolves a corpse:
        # 133 of 250 unit models animate it across Decay Flesh / Decay Bone and
        # 70 of those take it to zero. Read off the layer pick_layer chose, so it
        # is the alpha of the surface actually drawn rather than of an underlay.
        malphas, mcurves = [], []
        for mat in M['materials']:
            L, _uri, _team = pick_layer(M, mat)
            tr = (L.get('tracks') or {}).get('KMTA') if L else None
            mkeys = [k for k in track_keys(tr) if s0 <= k[0] <= s1] if tr else []
            if not mkeys:
                malphas.append(round(float(L['alpha']), 4) if L else 1.0)
                mcurves.append(None)
                continue
            pts = [[round((k[0] - s0) / 1000.0, 4), round(_scalar(k[1]), 4)]
                   for k in mkeys]
            malphas.append(pts[0][1])
            mcurves.append(pts if len({v for _, v in pts}) > 1 else None)
        if any(a != 1.0 for a in malphas) or any(mcurves):
            sm['matAlpha'] = malphas
        if any(mcurves):
            sm['matAlphaCurve'] = mcurves

    # ------------------------------------------------- geoset visibility meta
    geoanim = []
    for a in M['geosetAnims']:
        tr = a['tracks'].get('KGAO')
        keys = [[k[0], k[1]] for k in track_keys(tr)] if tr else []
        geoanim.append(dict(geosetId=a['geosetId'], alpha=a['alpha'],
                            color=a['color'], useColor=bool(a['flags'] & 1),
                            alphaKeys=keys,
                            globalSeq=(tr['globalSeq'] if tr else -1)))

    os.makedirs(out_dir, exist_ok=True)
    safe = name.replace('\\', '~')
    size = g.save(os.path.join(out_dir, safe + '.glb'))
    meta = dict(name=name, source=os.path.basename(path), version=M['version'],
                modelName=M['model'].get('name'), extent=M['model'].get('extent'),
                sequences=seqmeta, materials=matmeta, geosets=geometa,
                geosetAnims=geoanim,
                attachments=[dict(name=a['name'], id=a['attachmentId'],
                                  objectId=a['objectId'], parentId=a['parentId'])
                             for a in M['attachments']],
                collisions=[dict(shape=c['shape'], verts=c['verts'],
                                 radius=c.get('radius')) for c in M['collisions']],
                bones=[dict(name=n['name'], objectId=n['objectId'],
                            parentId=n['parentId'], type=n['type']) for n in nodes],
                glbBytes=size)
    json.dump(meta, open(os.path.join(out_dir, safe + '.json'), 'w'), separators=(',', ':'))
    return meta

def make_team_textures():
    from PIL import Image
    os.makedirs('assets/textures', exist_ok=True)
    Image.new('RGB', (8, 8), (200, 40, 40)).save('assets/textures/_teamcolor.png')
    Image.new('RGBA', (8, 8), (255, 120, 120, 90)).save('assets/textures/_teamglow.png')

def key_for(path):
    """Map assets keep their bare name; Blizzard assets keep their archive path."""
    if path.startswith('war3_extracted'):
        rel = os.path.relpath(path, 'war3_extracted').replace(os.sep, '\\')
        return os.path.splitext(rel)[0].lower()
    return os.path.splitext(os.path.basename(path))[0]

if __name__ == '__main__':
    make_team_textures()
    # match the extension case-insensitively: the map's own imports keep whatever
    # casing the author used, and a plain '*.mdx' glob silently skips ".MDX"
    def find_mdx(root):
        out = []
        for base, _dirs, names in os.walk(root):
            for n in names:
                if n.lower().endswith('.mdx'):
                    out.append(os.path.join(base, n))
        return sorted(out)
    files = find_mdx('extracted') + find_mdx('war3_extracted')
    # Cliff and ramp meshes are terrain, not units or doodads: nothing ever
    # spawns one, and tools/cliffs.py has already baked them into the cliff
    # mesh.  Converting them here would add ~200 .glb the client never asks for.
    # These four directory names are the only ones CliffTypes.slk ever names,
    # for every tileset.
    CLIFF_DIRS = ('cliffs', 'citycliffs', 'clifftrans', 'citycliffTrans'.lower())
    files = [p for p in files
             if os.path.basename(os.path.dirname(p)).lower() not in CLIFF_DIRS]
    force = '--force' in sys.argv
    # rebuild a model only when its source or this converter is newer than the
    # output; the archives contribute ~800 models that rarely change
    self_mtime = max(os.path.getmtime(__file__), os.path.getmtime(
        os.path.join(os.path.dirname(__file__), 'mdx.py')))
    index, fails, skipped, built = {}, [], 0, 0
    for p in files:
        try:
            name = key_for(p)
            safe = name.replace('\\', '~')
            glb = os.path.join(OUTDIR, safe + '.glb')
            meta_p = os.path.join(OUTDIR, safe + '.json')
            if (not force and os.path.exists(glb) and os.path.exists(meta_p)
                    and os.path.getmtime(glb) > max(os.path.getmtime(p), self_mtime)):
                m = json.load(open(meta_p))
                m['glbBytes'] = os.path.getsize(glb)
                skipped += 1
                index[m['name']] = dict(glb='models/%s.glb' % safe,
                                        meta='models/%s.json' % safe,
                                        tris=sum(x['tris'] for x in m['geosets']),
                                        seqs=[x['name'] for x in m['sequences']],
                                        bytes=m['glbBytes'])
                continue
            m = convert(p, OUTDIR, name=name)
            built += 1
            safe = m['name'].replace('\\', '~')
            index[m['name']] = dict(glb='models/%s.glb' % safe,
                                    meta='models/%s.json' % safe,
                                    tris=sum(x['tris'] for x in m['geosets']),
                                    seqs=[s['name'] for s in m['sequences']],
                                    bytes=m['glbBytes'])
        except Exception as e:
            import traceback
            fails.append((os.path.basename(p), '%s: %s' % (type(e).__name__, e)))
    json.dump(index, open('assets/models.json', 'w'), indent=1)
    tot = sum(v['bytes'] for v in index.values())
    print('converted %d, reused %d, indexed %d (%.1f MB glb), %d failed'
          % (built, skipped, len(index), tot / 1e6, len(fails)))
    for n, e in fails[:20]: print('  FAIL', n, e)
    if len(fails) > 20:
        print('  ... and %d more' % (len(fails) - 20))
    # This used to print its failures and exit 0, so a rebuild that converted
    # nothing still came out of pipeline.sh green -- and the client 404s on
    # every model that was never written. One stray MDX is the archives'
    # business; a wall of them is a broken converter or a missing dependency.
    if len(fails) > FAIL_FLOOR or not index:
        print('\nmodel conversion failed: %d of %d model(s) would not convert.'
              % (len(fails), len(files)))
        sys.exit(1)
