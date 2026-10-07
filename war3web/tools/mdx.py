"""Warcraft III MDX (version 800) model parser."""
import struct, sys, os, json

TRACK_SPEC = {          # tag -> (n components, 'f' float | 'i' int)
    'KGTR': (3, 'f'), 'KGRT': (4, 'f'), 'KGSC': (3, 'f'),
    'KMTF': (1, 'i'), 'KMTA': (1, 'f'), 'KMTE': (1, 'f'),
    'KGAO': (1, 'f'), 'KGAC': (3, 'f'),
    # Visibility tracks are floats, not integers. Read as an int, a plain 1.0
    # comes back as 1065353216 -- the bit pattern of 1.0f -- which is a value no
    # comparison against 0 or 1 can survive. Nothing consumed these until now,
    # so the mistake sat harmless; gating an emitter on one exposes it.
    'KATV': (1, 'f'),
    'KTAT': (3, 'f'), 'KTAR': (4, 'f'), 'KTAS': (3, 'f'),
    'KLAS': (1, 'f'), 'KLAE': (1, 'f'), 'KLAC': (3, 'f'), 'KLAI': (1, 'f'),
    'KLBI': (1, 'f'), 'KLBC': (3, 'f'), 'KLAV': (1, 'f'),
    'KPEE': (1, 'f'), 'KPEG': (1, 'f'), 'KPLN': (1, 'f'), 'KPLT': (1, 'f'),
    'KPEL': (1, 'f'), 'KPES': (1, 'f'), 'KPEV': (1, 'f'),
    'KP2S': (1, 'f'), 'KP2R': (1, 'f'), 'KP2L': (1, 'f'), 'KP2G': (1, 'f'),
    'KP2E': (1, 'f'), 'KP2N': (1, 'f'), 'KP2W': (1, 'f'), 'KP2V': (1, 'f'),
    'KRHA': (1, 'f'), 'KRHB': (1, 'f'), 'KRAL': (1, 'f'), 'KRCO': (3, 'f'),
    'KRTX': (1, 'i'), 'KRVS': (1, 'f'),
    'KCTR': (1, 'f'), 'KTTR': (1, 'f'), 'KCRL': (1, 'i'),
}

class R:
    def __init__(s, b, o=0, end=None):
        s.b, s.o, s.end = b, o, len(b) if end is None else end
    def left(s): return s.end - s.o
    def i(s):
        v, = struct.unpack_from('<i', s.b, s.o); s.o += 4; return v
    def u(s):
        v, = struct.unpack_from('<I', s.b, s.o); s.o += 4; return v
    def h(s):
        v, = struct.unpack_from('<H', s.b, s.o); s.o += 2; return v
    def f(s):
        v, = struct.unpack_from('<f', s.b, s.o); s.o += 4; return round(v, 6)
    def fs(s, n):
        v = struct.unpack_from('<%df' % n, s.b, s.o); s.o += 4*n
        return [round(x, 6) for x in v]
    def tag(s):
        v = s.b[s.o:s.o+4].decode('latin-1'); s.o += 4; return v
    def peek(s):
        return s.b[s.o:s.o+4].decode('latin-1') if s.left() >= 4 else ''
    def fixed(s, n):
        v = s.b[s.o:s.o+n]; s.o += n
        return v.split(b'\x00')[0].decode('utf-8', 'replace')
    def skip(s, n): s.o += n

def read_track(r):
    tag = r.tag()
    nc, ty = TRACK_SPEC[tag]
    nkeys = r.i(); interp = r.i(); gseq = r.i()
    keys = []
    for _ in range(nkeys):
        fr = r.i()
        val = r.fs(nc) if ty == 'f' else [r.i() for _ in range(nc)]
        k = [fr, val if nc > 1 else val[0]]
        if interp > 1:
            it = r.fs(nc) if ty == 'f' else [r.i() for _ in range(nc)]
            ot = r.fs(nc) if ty == 'f' else [r.i() for _ in range(nc)]
            k += [it if nc > 1 else it[0], ot if nc > 1 else ot[0]]
        keys.append(k)
    return tag, dict(interp=interp, globalSeq=gseq, keys=keys)

def read_extent(r):
    return dict(radius=r.f(), min=r.fs(3), max=r.fs(3))

def read_node(r):
    base = r.o; end = base + r.i()
    n = dict(name=r.fixed(80), objectId=r.i(), parentId=r.i(), flags=r.u(), tracks={})
    while r.o < end:
        t, tr = read_track(r)
        n['tracks'][t] = tr
    r.o = end
    return n

def parse(path):
    b = open(path, 'rb').read()
    assert b[:4] == b'MDLX'
    M = dict(path=path, version=0, model={}, sequences=[], globalSeqs=[], textures=[],
             materials=[], geosets=[], geosetAnims=[], bones=[], helpers=[],
             attachments=[], pivots=[], collisions=[], events=[], texAnims=[],
             particles=[], particles2=[], ribbons=[], lights=[], cameras=[])
    o = 4
    while o + 8 <= len(b):
        tag = b[o:o+4].decode('latin-1')
        size, = struct.unpack_from('<i', b, o+4)
        r = R(b, o+8, o+8+size)
        if tag == 'VERS': M['version'] = r.i()
        elif tag == 'MODL':
            M['model'] = dict(name=r.fixed(80), animFile=r.fixed(260),
                              extent=read_extent(r), blendTime=r.i())
        elif tag == 'SEQS':
            while r.left() >= 132:
                M['sequences'].append(dict(
                    name=r.fixed(80), start=r.i(), end=r.i(), moveSpeed=r.f(),
                    nonLooping=r.i(), rarity=r.f(), syncPoint=r.i(),
                    extent=read_extent(r)))
        elif tag == 'GLBS':
            while r.left() >= 4: M['globalSeqs'].append(r.i())
        elif tag == 'TEXS':
            while r.left() >= 268:
                M['textures'].append(dict(replaceableId=r.i(), path=r.fixed(260), flags=r.u()))
        elif tag == 'MTLS':
            while r.left() > 0:
                base = r.o; end = base + r.i()
                mat = dict(priorityPlane=r.i(), flags=r.u(), layers=[])
                assert r.tag() == 'LAYS'
                for _ in range(r.i()):
                    lbase = r.o; lend = lbase + r.i()
                    L = dict(filterMode=r.i(), shadingFlags=r.u(), textureId=r.i(),
                             texAnimId=r.i(), coordId=r.i(), alpha=r.f(), tracks={})
                    while r.o < lend:
                        t, tr = read_track(r); L['tracks'][t] = tr
                    r.o = lend
                    mat['layers'].append(L)
                r.o = end
                M['materials'].append(mat)
        elif tag == 'GEOS':
            while r.left() > 0:
                base = r.o; end = base + r.i()
                g = {}
                assert r.tag() == 'VRTX'; g['vertices'] = r.fs(3 * r.i())
                assert r.tag() == 'NRMS'; g['normals'] = r.fs(3 * r.i())
                assert r.tag() == 'PTYP'; g['faceTypes'] = [r.i() for _ in range(r.i())]
                assert r.tag() == 'PCNT'; g['faceCounts'] = [r.i() for _ in range(r.i())]
                assert r.tag() == 'PVTX'; g['indices'] = [r.h() for _ in range(r.i())]
                assert r.tag() == 'GNDX'
                nv = r.i(); g['vertexGroups'] = list(r.b[r.o:r.o+nv]); r.skip(nv)
                assert r.tag() == 'MTGC'; g['matrixGroups'] = [r.i() for _ in range(r.i())]
                assert r.tag() == 'MATS'; g['matrixIndices'] = [r.i() for _ in range(r.i())]
                g['materialId'] = r.i(); g['selectionGroup'] = r.i(); g['selectionFlags'] = r.i()
                g['extent'] = read_extent(r)
                for _ in range(r.i()): read_extent(r)
                assert r.tag() == 'UVAS'
                nlay = r.i(); g['uvs'] = []
                for _ in range(nlay):
                    assert r.tag() == 'UVBS'
                    g['uvs'].append(r.fs(2 * r.i()))
                r.o = end
                M['geosets'].append(g)
        elif tag == 'GEOA':
            while r.left() > 0:
                base = r.o; end = base + r.i()
                a = dict(alpha=r.f(), flags=r.u(), color=r.fs(3), geosetId=r.i(), tracks={})
                while r.o < end:
                    t, tr = read_track(r); a['tracks'][t] = tr
                r.o = end
                M['geosetAnims'].append(a)
        elif tag == 'BONE':
            while r.left() > 0:
                n = read_node(r); n['geosetId'] = r.i(); n['geosetAnimId'] = r.i()
                n['type'] = 'bone'; M['bones'].append(n)
        elif tag == 'HELP':
            while r.left() > 0:
                n = read_node(r); n['type'] = 'helper'; M['helpers'].append(n)
        elif tag == 'ATCH':
            while r.left() > 0:
                obase = r.o; oend = obase + r.i()      # outer inclusiveSize
                n = read_node(r); n['type'] = 'attachment'
                n['attachPath'] = r.fixed(260)
                n['attachmentId'] = r.i()
                while r.o < oend and r.peek() in TRACK_SPEC:
                    t, tr = read_track(r); n['tracks'][t] = tr
                r.o = oend
                M['attachments'].append(n)
        elif tag == 'PIVT':
            while r.left() >= 12: M['pivots'].append(r.fs(3))
        elif tag == 'CLID':
            while r.left() > 0:
                n = read_node(r); n['type'] = 'collision'
                n['shape'] = r.i()
                nv = 2 if n['shape'] != 2 else 1
                n['verts'] = [r.fs(3) for _ in range(nv)]
                if n['shape'] in (2, 3): n['radius'] = r.f()
                M['collisions'].append(n)
        elif tag == 'EVTS':
            while r.left() > 0:
                n = read_node(r); n['type'] = 'event'
                if r.peek() == 'KEVT':
                    r.tag(); nk = r.i(); r.i()
                    n['times'] = [r.i() for _ in range(nk)]
                M['events'].append(n)
        elif tag == 'TXAN':
            while r.left() > 0:
                base = r.o; end = base + r.i(); t = dict(tracks={})
                while r.o < end:
                    k, tr = read_track(r); t['tracks'][k] = tr
                r.o = end; M['texAnims'].append(t)
        elif tag == 'PRE2':
            # ParticleEmitter2 -- the whole visual of most spell effects. A great
            # many Warcraft III effect models carry no geometry at all: strip the
            # emitters and DeathAndDecayDamage, CloudOfFog, FlameStrikeTarget and
            # eighty others convert to a valid, entirely empty scene.
            while r.left() > 0:
                obase = r.o; oend = obase + r.i()
                n = read_node(r); n['type'] = tag
                n.update(
                    speed=r.f(), variation=r.f(), latitude=r.f(), gravity=r.f(),
                    lifespan=r.f(), emissionRate=r.f(), length=r.f(), width=r.f(),
                    filterMode=r.u(), rows=r.u(), columns=r.u(), headOrTail=r.u(),
                    tailLength=r.f(), time=r.f())
                n['segmentColor'] = [r.fs(3) for _ in range(3)]
                n['segmentAlpha'] = [r.b[r.o + k] for k in range(3)]; r.skip(3)
                n['segmentScaling'] = r.fs(3)
                n['headInterval'] = [r.u() for _ in range(3)]
                n['headDecayInterval'] = [r.u() for _ in range(3)]
                n['tailInterval'] = [r.u() for _ in range(3)]
                n['tailDecayInterval'] = [r.u() for _ in range(3)]
                n.update(textureId=r.i(), squirt=r.u(),
                         priorityPlane=r.i(), replaceableId=r.u())
                while r.o + 4 <= oend and r.peek() in TRACK_SPEC:
                    k, tr = read_track(r); n['tracks'][k] = tr
                r.o = oend
                M['particles2'].append(n)
                M['particles'].append(n)
        elif tag == 'RIBB':
            # RibbonEmitter -- a trail. The emitter is a point on the skeleton
            # (a sword tip, a hand) and the game leaves a strip behind it as the
            # animation drags it through space: 326 of them across 128 models
            # here, which is most of what a swing looks like.
            while r.left() > 0:
                obase = r.o; oend = obase + r.i()
                n = read_node(r); n['type'] = tag
                n.update(heightAbove=r.f(), heightBelow=r.f(), alpha=r.f())
                n['color'] = r.fs(3)
                n.update(lifespan=r.f(), textureSlot=r.u(), emissionRate=r.u(),
                         rows=r.u(), columns=r.u(), materialId=r.i(), gravity=r.f())
                while r.o + 4 <= oend and r.peek() in TRACK_SPEC:
                    k, tr = read_track(r); n['tracks'][k] = tr
                r.o = oend
                M['ribbons'].append(n)
                M['particles'].append(n)
        elif tag == 'LITE':
            while r.left() > 0:
                obase = r.o; oend = obase + r.i()
                n = read_node(r); n['type'] = tag
                n['lightType'] = r.i()
                n.update(attStart=r.f(), attEnd=r.f())
                n['color'] = r.fs(3)
                n['intensity'] = r.f()
                n['ambColor'] = r.fs(3)
                n['ambIntensity'] = r.f()
                while r.o + 4 <= oend and r.peek() in TRACK_SPEC:
                    k, tr = read_track(r); n['tracks'][k] = tr
                r.o = oend
                M['lights'].append(n)
                M['particles'].append(n)
        elif tag == 'PREM':
            # ParticleEmitter1 -- the older kind, which throws *models* rather
            # than sprites: the blood and gut chunks a creep bursts into.
            while r.left() > 0:
                obase = r.o; oend = obase + r.i()
                n = read_node(r); n['type'] = tag
                n.update(emissionRate=r.f(), gravity=r.f(),
                         longitude=r.f(), latitude=r.f())
                n['spawnModel'] = r.fixed(260)
                n.update(lifespan=r.f(), initVelocity=r.f())
                while r.o + 4 <= oend and r.peek() in TRACK_SPEC:
                    k, tr = read_track(r); n['tracks'][k] = tr
                r.o = oend
                M['particles2'].append(n)
                M['particles'].append(n)
        elif tag in ('RIBB_UNUSED',):
            # node hierarchy matters (objectIds/parents); type-specific data skipped
            while r.left() > 0:
                obase = r.o; oend = obase + r.i()
                n = read_node(r); n['type'] = tag
                r.o = oend
                M['particles'].append(n)
        # CAMS holds no scene nodes
        o += 8 + size
    return M

if __name__ == '__main__':
    import glob, collections
    bad = []
    stats = collections.Counter()
    for p in sorted(glob.glob('extracted/**/*.md[xl]', recursive=True)):
        try:
            M = parse(p)
            stats['ok'] += 1
            stats['geosets'] += len(M['geosets'])
            stats['bones'] += len(M['bones'])
            stats['seqs'] += len(M['sequences'])
            tris = sum(len(g['indices'])//3 for g in M['geosets'])
            stats['tris'] += tris
        except Exception as e:
            bad.append((os.path.basename(p), '%s: %s' % (type(e).__name__, e)))
    print('parsed OK: %d   failed: %d' % (stats['ok'], len(bad)))
    print('totals: %d geosets, %d bones, %d sequences, %d triangles' % (
        stats['geosets'], stats['bones'], stats['seqs'], stats['tris']))
    for n, e in bad: print('  FAIL %-34s %s' % (n, e))
