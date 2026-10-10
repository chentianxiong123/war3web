"""MDL (Warcraft III text model) -> the same model dict mdx.py produces.

MDX is the binary the game loads; MDL is the text the object editor and
modelling tools write, and a whole ecosystem of custom models ships as .mdl
(weapons, doodads, campaign edits). The pipeline previously parsed only MDX,
so any such file was silently invisible. This mirrors warsmash's Mdlx* readMdl
token handling and fills the same M structure, so mdx2gltf consumes both.

Supported block set (the surface modders actually use): Version, Model,
Sequences, GlobalSequences, Textures, TextureAnims, Materials, Geoset,
GeosetAnim, Bone, Helper, Attachment, EventObject, ParticleEmitter,
ParticleEmitter2, RibbonEmitter, Camera, Light, CollisionShape, PivotPoints.
Unknown blocks are skipped token-wise rather than rejected.
"""
import re, sys, os

sys.path.insert(0, os.path.dirname(__file__))


class Tokens:
    """MdlTokenInputStream port: whitespace/,/{}/comment delimited tokens."""
    def __init__(self, text):
        self.toks = self._tokenize(text)
        self.i = 0
    def _tokenize(self, t):
        out = []
        i, n = 0, len(t)
        while i < n:
            c = t[i]
            if c in ' \t\r\n,:':
                i += 1
            elif c == '/' and i + 1 < n and t[i + 1] == '/':
                e = t.find('\n', i)
                i = n if e < 0 else e + 1
            elif c == '"':
                e = t.find('"', i + 1)
                out.append(t[i + 1:e if e >= 0 else n])
                i = n if e < 0 else e + 1
            elif c in '{}':
                out.append(c); i += 1
            else:
                j = i
                while j < n and t[j] not in ' \t\r\n,:"{}':
                    j += 1
                out.append(t[i:j]); i = j
        return out
    def peek(self):
        return self.toks[self.i] if self.i < len(self.toks) else None
    def read(self):
        v = self.toks[self.i] if self.i < len(self.toks) else None
        self.i += 1
        return v
    def unread(self):
        self.i = max(0, self.i - 1)
    def expect(self, tok):
        got = self.read()
        if got != tok:
            raise ValueError('expected %r, got %r' % (tok, got))
    def is_block(self, name):
        """`name {` or `name "optional title" {`."""
        if self.i >= len(self.toks) or self.toks[self.i] != name:
            return False
        j = self.i + 1
        if j < len(self.toks) and self.toks[j] != '{':
            j += 1
        return j < len(self.toks) and self.toks[j] == '{'
    def num(self):
        v = self.read()
        if v is None:
            return 0.0
        try:
            return float(v)
        except ValueError:
            return 0.0
    def num_i(self):
        return int(self.num())


def _slice(t):
    """Interior token stream of the block whose opening brace has been
    consumed (assumes the current token stream sits just past '{')."""
    start = t.i
    depth = 1
    while depth and t.i < len(t.toks):
        if t.toks[t.i] == '{':
            depth += 1
        elif t.toks[t.i] == '}':
            depth -= 1
        t.i += 1
    inner = Tokens.__new__(Tokens)
    inner.toks = t.toks[start:t.i - 1]
    inner.i = 0
    return inner


def _block(t, name):
    """Consume `name ["title"] { ... }` and hand the interior tokens back."""
    t.expect(name)
    if t.peek() != '{':
        t.read()  # the block's title string
    t.expect('{')
    return _slice(t)


def _track_tokens(inner, M, node_tracks):
    """Parse the timeline tokens inside a node's { ... } (Translation, Rotation,
    Scaling, Visibility, plus any raw four-letter tracks)."""
    while inner.i < len(inner.toks):
        if inner.peek() is None:
            break
        k = inner.read()
        if k == 'Interpolation':
            node_tracks.setdefault('_interp', [inner.num_i()])
        elif k == 'GlobalSeqId':
            node_tracks.setdefault('_gseq', [inner.num_i()])
        elif k == 'Tags':
            while inner.peek() not in (None, '}') and inner.peek() not in _WORDY:
                inner.i += 1
            if inner.peek() not in (None, '}'):
                continue
        elif k == 'DontInherit':
            # bit list: Scaling, Rotation, Translation
            while inner.peek() and inner.peek() not in ('}') and not inner.is_block(inner.peek()):
                inner.i += 1
        elif inner.peek() == '{':
            # "Translation { 0, { x, y, z }, ... }" -- first value is the frame
            frame = int(inner.num())
            vals = []
            while inner.peek() is not None and inner.peek() != '{' and not inner.is_block(inner.peek()):
                inner.i += 1
            if inner.peek() == '{':
                inner.expect('{')
                while inner.peek() is not None and inner.peek() != '}':
                    vals.append(inner.num())
                inner.expect('}')
            node_tracks.setdefault(k, {'keys': []})['keys'].append([frame, vals])
        else:
            # bare scalar: "Alpha 1," style single value
            node_tracks.setdefault(k, {}).setdefault('scalar', inner.num())


_WORDY = set('Interpolation GlobalSeqId Tags DontInherit'.split())


def _geom_track(tok, M):
    """`Translation { <t>, {x,y,z} ... }` -> parsed per-sequence timeline."""
    t, tr = tok
    keys = tr.get('keys') or []
    return dict(interp=tr.get('_interp', [0])[0],
                globalSeq=tr.get('_gseq', [-1])[0],
                keys=[[int(k[0]), k[1]] for k in keys])


def parse_mdl(text):
    t = Tokens(text)
    M = dict(path='<mdl>', version=800, model={}, sequences=[], globalSeqs=[],
             textures=[], materials=[], geosets=[], geosetAnims=[], bones=[],
             helpers=[], attachments=[], pivots=[], collisions=[], events=[],
             texAnims=[], particles=[], particles2=[], ribbons=[], lights=[],
             cameras=[])
    while t.peek() is not None:
        name = t.peek()
        if not t.is_block(name):
            # stray scalar at top level (rare); skip
            t.i += 1
            continue
        title = t.toks[t.i + 1] if t.i + 1 < len(t.toks) and t.toks[t.i + 1] != '{' else None
        inner = _block(t, name)
        if name == 'Version':
            if inner.peek() is not None:
                M['version'] = inner.num_i()
        elif name == 'Model':
            M['model']['name'] = inner.read() or ''
            while inner.i < len(inner.toks):
                k = inner.read()
                if k == 'BlendTime':
                    M['model']['blendTime'] = inner.num_i()
                elif k == 'Extent':
                    _skip_extent(inner)
                else:
                    _skip_until_close(inner)
        elif name == 'Sequences':
            while inner.i < len(inner.toks):
                if inner.is_block('Anim'):
                    inner.expect('Anim')
                    nm = inner.read() if inner.peek() != '{' else ''
                    inner.expect('{')
                    b = _slice(inner)
                    seq = dict(name=nm or '', start=0, end=0, moveSpeed=0,
                               nonLooping=0, rarity=0, syncPoint=0,
                               extent=dict(radius=0, min=[0, 0, 0], max=[0, 0, 0]))
                    while b.i < len(b.toks):
                        k = b.read()
                        if k == 'Interval':
                            s = b.num_i(); e = b.num_i()
                            seq['start'], seq['end'] = s, e
                        elif k == 'NonLooping':
                            seq['nonLooping'] = b.num_i()
                        elif k == 'MoveSpeed':
                            seq['moveSpeed'] = b.num()
                        elif k == 'Rarity':
                            seq['rarity'] = b.num()
                        elif k == 'Extent':
                            _skip_extent(b)
                        else:
                            _skip_until_close(b)
                    M['sequences'].append(seq)
                else:
                    _skip_until_close(inner)
        elif name == 'GlobalSequences':
            while inner.peek() is not None:
                M['globalSeqs'].append(inner.num_i())
                inner.read()  # trailing comma token (already separated)
        elif name == 'Textures':
            while inner.i < len(inner.toks):
                if inner.is_block('Bitmap'):
                    b = _block(inner, 'Bitmap')
                    path = ''
                    while b.i < len(b.toks):
                        k = b.read()
                        if k == 'Image':
                            path = b.read() or ''
                        elif k == 'ReplaceableId':
                            b.num_i()
                        else:
                            _skip_until_close(b)
                    M['textures'].append(dict(replaceableId=0, path=path, flags=0))
                else:
                    _skip_until_close(inner)
        elif name == 'TextureAnims':
            while inner.i < len(inner.toks):
                if inner.is_block('TextureAnim'):
                    b = _block(inner, 'TextureAnim')
                    ta = dict(tracks={})
                    while b.i < len(b.toks):
                        k = b.read()
                        if k in ('Translation', 'Rotation', 'Scaling'):
                            _node_tracks(b, M, ta['tracks'], _TEX_TRACK, k)
                        else:
                            _skip_until_close(b)
                    M['texAnims'].append(ta)
                else:
                    _skip_until_close(inner)
        elif name == 'Materials':
            while inner.i < len(inner.toks):
                if inner.is_block('Material'):
                    b = _block(inner, 'Material')
                    mat = dict(priorityPlane=0, flags=0, layers=[])
                    while b.i < len(b.toks):
                        k = b.read()
                        if k == 'PriorityPlane':
                            mat['priorityPlane'] = b.num_i()
                        elif k == 'ConstantColor':
                            mat['flags'] |= 1
                        elif k == 'Layer':
                            L = dict(filterMode=0, shadingFlags=0, textureId=0,
                                     texAnimId=-1, coordId=0, alpha=1, tracks={})
                            while b.i < len(b.toks):
                                kk = b.read()
                                if kk == 'FilterMode':
                                    L['filterMode'] = _filter_mode(b.read())
                                elif kk == 'Shading':
                                    L['shadingFlags'] = b.num_i()
                                elif kk == 'TextureID':
                                    L['textureId'] = b.num_i()
                                elif kk == 'TVertexAnimId':
                                    L['texAnimId'] = b.num_i()
                                elif kk == 'CoordId':
                                    L['coordId'] = b.num_i()
                                elif kk == 'Alpha':
                                    if b.peek() == '{':
                                        _node_tracks(b, M, L['tracks'], _LAYER_TRACK, kk)
                                    else:
                                        L['alpha'] = b.num()
                                elif kk in ('StaticAlpha', 'TextureID'):
                                    pass
                                elif b.is_block('Material'):
                                    pass
                                elif kk == 'Texture':
                                    _skip_until_close(b)
                                else:
                                    _skip_until_close(b)
                            mat['layers'].append(L)
                        else:
                            _skip_until_close(b)
                    M['materials'].append(mat)
                else:
                    _skip_until_close(inner)
        elif name == 'Geoset':
            g = _parse_geoset(inner, M)
            if g is not None:
                M['geosets'].append(g)
        elif name == 'GeosetAnim':
            b = inner
            a = dict(alpha=1, flags=0, color=[1, 1, 1], geosetId=-1, tracks={})
            while b.i < len(b.toks):
                k = b.read()
                if k == 'Alpha':
                    if b.peek() == '{' and _has_nested(b):
                        _node_tracks(b, M, a['tracks'], _GEOA_TRACK, k)
                    else:
                        a['alpha'] = b.num()
                elif k == 'Color':
                    if b.peek() == '{' and _has_nested(b):
                        _node_tracks(b, M, a['tracks'], _GEOA_TRACK, k)
                    else:
                        _vec3(b, a, 'color')
                elif k == 'GeosetId':
                    a['geosetId'] = b.num_i()
                elif k == 'StaticColor':
                    pass
                else:
                    _skip_until_close(b)
            M['geosetAnims'].append(a)
        elif name in ('Bone', 'Helper', 'Attachment', 'EventObject',
                      'CollisionShape', 'Light', 'Camera', 'ParticleEmitter',
                      'ParticleEmitter2', 'RibbonEmitter'):
            _parse_node_block(name, inner, M, title)
        elif name == 'PivotPoints':
            while inner.i < len(inner.toks):
                if inner.peek() == '{':
                    inner.expect('{')
                    p = [inner.num(), inner.num(), inner.num()]
                    inner.expect('}')
                    M['pivots'].append(p)
                else:
                    inner.i += 1
        else:
            _skip_until_close(inner)
    return M


def _filter_mode(v):
    return {'None': 0, 'Transparent': 1, 'Blend': 2, 'Additive': 3,
            'AddAlpha': 4, 'Modulate': 5, 'Modulate2x': 6}.get(v or '', 0)


def _vec3(b, dst, key):
    b.expect('{')
    dst[key] = [b.num(), b.num(), b.num()]
    b.expect('}')


def _skip_extent(b):
    # Extent { BoundsRadius r, Minimum {x,y,z}, Maximum {x,y,z} }
    while b.i < len(b.toks):
        if b.is_block('Extent'):
            _block(b, 'Extent')
        elif b.peek() == '{':
            _skip_until_close(b)
        elif b.peek() in ('Minimum', 'Maximum', 'BoundsRadius'):
            b.i += 1
            if b.peek() == '{':
                _skip_until_close(b)
            else:
                b.i += 1
        else:
            b.i += 1


def _skip_until_close(b):
    depth = 0
    while b.i < len(b.toks):
        c = b.toks[b.i]
        if c == '{':
            depth += 1
        elif c == '}':
            if depth == 0:
                return
            depth -= 1
        b.i += 1


def _parse_geoset(inner, M):
    g = dict(vertices=[], normals=[], faceTypes=[], faceCounts=[], indices=[],
             vertexGroups=[], matrixGroups=[], matrixIndices=[], materialId=0,
             selectionGroup=0, selectionFlags=0, uvs=[],
             extent=dict(radius=0, min=[0, 0, 0], max=[0, 0, 0]))
    while inner.i < len(inner.toks):
        if inner.is_block('Vertices'):
            b = _block(inner, 'Vertices')
            while b.i < len(b.toks):
                if b.peek() == '{':
                    b.expect('{')
                    g['vertices'] += [b.num(), b.num(), b.num()]
                    b.expect('}')
                else:
                    b.i += 1
        elif inner.is_block('Normals'):
            b = _block(inner, 'Normals')
            while b.i < len(b.toks):
                if b.peek() == '{':
                    b.expect('{')
                    g['normals'] += [b.num(), b.num(), b.num()]
                    b.expect('}')
                else:
                    b.i += 1
        elif inner.is_block('TextureUVs'):
            b = _block(inner, 'TextureUVs')
            if b.is_block('UV'):
                uv = _block(b, 'UV')
                layer = []
                while uv.i < len(uv.toks):
                    if uv.peek() == '{':
                        uv.expect('{')
                        layer += [uv.num(), uv.num()]
                        uv.expect('}')
                    else:
                        uv.i += 1
                g['uvs'].append(layer)
        elif inner.is_block('Groups'):
            b = _block(inner, 'Groups')
            while b.i < len(b.toks):
                if b.peek() == '{':
                    b.expect('{')
                    g['vertexGroups'].append(b.num_i())
                    b.expect('}')
                else:
                    b.i += 1
        elif inner.is_block('MatrixGroup'):
            # MDX stores one int per group -- how many matrix ids that group
            # indexes into -- and the Matrix block holds the flattened ids.
            b = _block(inner, 'MatrixGroup')
            nids = 0
            while b.i < len(b.toks):
                if b.peek() == '{':
                    b.expect('{')
                    while b.peek() is not None and b.peek() != '}':
                        b.num_i()
                        nids += 1
                    b.expect('}')
                else:
                    b.i += 1
            g['matrixGroups'].append(nids)
        elif inner.is_block('Matrix'):
            b = _block(inner, 'Matrix')
            while b.i < len(b.toks):
                if b.peek() == '{':
                    b.expect('{')
                    while b.peek() is not None and b.peek() != '}':
                        g['matrixIndices'].append(b.num_i())
                    b.expect('}')
                else:
                    b.i += 1
        elif inner.is_block('MaterialID'):
            b = _block(inner, 'MaterialID')
            g['materialId'] = b.num_i()
        elif inner.is_block('SelectionGroup'):
            b = _block(inner, 'SelectionGroup')
            g['selectionGroup'] = b.num_i()
        elif inner.is_block('SelectionScaling'):
            b = _block(inner, 'SelectionScaling')
            g['selectionFlags'] = b.num_i()
        elif inner.is_block('Face'):
            _face_block(inner, g)
        elif inner.is_block('GeosetAnim'):
            _block(inner, 'GeosetAnim')
        elif inner.is_block('Extent'):
            _skip_extent(inner)
        else:
            _skip_until_close(inner)
    return g


def _face_block(inner, g):
    b = _block(inner, 'Face')
    while b.i < len(b.toks):
        if b.is_block('Triangles'):
            tb = _block(b, 'Triangles')
            while tb.i < len(tb.toks):
                if tb.peek() == '{':
                    tb.expect('{')
                    while tb.peek() is not None and tb.peek() != '}':
                        g['indices'].append(tb.num_i())
                    tb.expect('}')
                    g['faceTypes'] += [4]
                    g['faceCounts'] += [len(g['indices']) - sum(g['faceCounts'])]
                else:
                    tb.i += 1
        else:
            _skip_until_close(b)


_NODE_TRACK = {'Translation': 'KGTR', 'Rotation': 'KGRT', 'Scaling': 'KGSC',
               'Visibility': 'KATV'}
_GEOA_TRACK = {'Alpha': 'KGAO', 'Color': 'KGAC'}
_TEX_TRACK = {'Translation': 'KTAT', 'Rotation': 'KTAR', 'Scaling': 'KTAS'}
_LAYER_TRACK = {'Alpha': 'KMTA'}
_EMIT2_TRACK = {'Speed': 'KP2S', 'Variation': 'KP2R', 'Latitude': 'KP2L',
                'Gravity': 'KP2G', 'EmissionRate': 'KP2E', 'Length': 'KP2N',
                'Width': 'KP2W', 'Visibility': 'KP2V'}


def _has_nested(t):
    """True when the stream at '{' opens a timeline (`{ frame, { v... }, }`)
    rather than a plain value block (`{ x, y, z }`)."""
    i = t.i
    if i >= len(t.toks) or t.toks[i] != '{':
        return False
    j = i + 1
    if j < len(t.toks) and t.toks[j] != '{':
        j += 1
    return j < len(t.toks) and t.toks[j] == '{'


def _node_tracks(b, M, tracks, trmap, tname):
    """Consume one MDL timeline, `tname { frame, { values... }, ... }` (one or
    more frame groups), plus any Interpolation/GlobalSeqId that follows,
    writing into the MDX-track-shaped dict."""
    key = trmap.get(tname, tname)
    trd = tracks.setdefault(key, {})
    if b.peek() == '{':
        b.expect('{')
        keys = trd.setdefault('keys', [])
        while b.peek() is not None and b.peek() != '}':
            frame = b.num_i() if b.peek() != '{' else 0
            if b.peek() == '{':
                b.expect('{')
                vals = []
                while b.peek() is not None and b.peek() != '}':
                    vals.append(b.num())
                b.expect('}')
            else:
                vals = [b.num()] if b.peek() not in (None, '}') else []
            keys.append([frame, vals])
        b.expect('}')
    else:
        trd.setdefault('scalar', b.num())
    while b.peek() in ('Interpolation', 'GlobalSeqId'):
        k = b.read()
        if k == 'Interpolation':
            trd['interp'] = b.num_i()
        else:
            trd['globalSeq'] = b.num_i()
    # MDL omits Interpolation/GlobalSeqId entirely on most tracks; default to
    # Linear and "owned by no global sequence" as an MDX track header would.
    trd.setdefault('interp', 1)
    trd.setdefault('globalSeq', -1)
    return tracks


def _parse_node_block(name, inner, M, title=None):
    if name == 'ParticleEmitter2':
        n = dict(type='PRE2', name=title or '', objectId=-1, parentId=-1, flags=0,
                 tracks={}, speed=0, variation=0, latitude=0, gravity=0,
                 lifespan=0, emissionRate=0, length=0, width=0,
                 filterMode=0, rows=1, columns=1, headOrTail=0, tailLength=0,
                 time=0, segmentColor=[[1, 1, 1]] * 3, segmentAlpha=[255] * 3,
                 segmentScaling=[1, 1, 1],
                 headInterval=[0, 0, 0], headDecayInterval=[0, 0, 0],
                 tailInterval=[0, 0, 0], tailDecayInterval=[0, 0, 0],
                 textureId=0, squirt=1, priorityPlane=0, replaceableId=0)
        _parse_emitter2(inner, n, M)
        M['particles2'].append(n)
        M['particles'].append(n)
        return
    n = dict(type=name, name=title or '', objectId=-1, parentId=-1, flags=0, tracks={})
    while inner.i < len(inner.toks):
        k = inner.read()
        if k == 'ObjectId':
            n['objectId'] = inner.num_i()
        elif k == 'Parent':
            n['parentId'] = inner.num_i()
        elif k == 'GeosetId':
            inner.num_i()
        elif k == 'GeosetAnimId':
            inner.num_i()
        elif k in ('Translation', 'Rotation', 'Scaling', 'Visibility'):
            _node_tracks(inner, M, n['tracks'], _NODE_TRACK, k)
        elif name == 'Camera' and k in ('Position', 'Target'):
            _vec3(inner, n, 'position' if k == 'Position' else 'targetPosition')
        elif name == 'Camera' and k == 'FieldOfView':
            n['fieldOfView'] = inner.num()
        elif name == 'Camera' and k == 'FarClip':
            n['farClippingPlane'] = inner.num()
        elif name == 'Camera' and k == 'NearClip':
            n['nearClippingPlane'] = inner.num()
        elif k == 'Interpolation':
            # block-level: applies to every track on this node
            ip = inner.num_i()
            for _t in n['tracks'].values():
                if 'keys' in _t:
                    _t['interp'] = ip
        elif k == 'GlobalSeqId':
            gs = inner.num_i()
            for _t in n['tracks'].values():
                if 'keys' in _t:
                    _t['globalSeq'] = gs
        elif k == 'DontInherit':
            # Scaling, Rotation, Translation flags; skip the word list
            while inner.peek() is not None and inner.peek() != '}' and not inner.is_block(inner.peek()):
                inner.i += 1
        else:
            _skip_until_close(inner)
    if name == 'Bone':
        M['bones'].append(n)
    elif name == 'Helper':
        M['helpers'].append(n)
    elif name == 'Attachment':
        M['attachments'].append(n)
    elif name == 'EventObject':
        M['events'].append(n)
    elif name == 'CollisionShape':
        M['collisions'].append(n)
    elif name == 'Light':
        M['lights'].append(n)
    elif name == 'Camera':
        M['cameras'].append(n)
    else:
        M['particles'].append(n)


_EMIT2_FIELD = {'Speed': 'speed', 'Variation': 'variation', 'Latitude': 'latitude',
                'Gravity': 'gravity', 'LifeSpan': 'lifespan',
                'EmissionRate': 'emissionRate', 'Length': 'length', 'Width': 'width'}


def _parse_emitter2(inner, n, M):
    while inner.i < len(inner.toks):
        k = inner.read()
        if k == 'ObjectId':
            n['objectId'] = inner.num_i()
        elif k == 'Parent':
            n['parentId'] = inner.num_i()
        elif k in _EMIT2_FIELD:
            if inner.peek() == '{':
                _node_tracks(inner, M, n['tracks'], _EMIT2_TRACK, k)
            else:
                n[_EMIT2_FIELD[k]] = inner.num()
        elif k == 'Visibility':
            _node_tracks(inner, M, n['tracks'], _EMIT2_TRACK, k)
        elif k == 'FilterMode':
            n['filterMode'] = _filter_mode(inner.read())
        elif k == 'Rows':
            n['rows'] = inner.num_i()
        elif k == 'Columns':
            n['columns'] = inner.num_i()
        elif k == 'HeadOrTail':
            n['headOrTail'] = inner.num_i()
        elif k == 'TailLength':
            n['tailLength'] = inner.num()
        elif k == 'Time':
            n['time'] = inner.num()
        elif k == 'SegmentColor':
            seg = []
            for _ in range(3):
                if inner.peek() == '{':
                    inner.expect('{')
                    seg.append([inner.num(), inner.num(), inner.num()])
                    inner.expect('}')
            if seg:
                n['segmentColor'] = seg
        elif k == 'Alpha':
            n['segmentAlpha'] = [int(inner.num())] * 3
        elif k == 'ParticleTextureID':
            n['textureId'] = inner.num_i()
        elif k == 'Squirt':
            n['squirt'] = inner.num_i()
        elif k == 'PriorityPlane':
            n['priorityPlane'] = inner.num_i()
        elif k == 'ReplaceableId':
            n['replaceableId'] = inner.num_i()
        else:
            _skip_until_close(inner)


def parse(path):
    return parse_mdl(open(path, encoding='utf-8', errors='replace').read())


if __name__ == '__main__':
    import json
    for p in sys.argv[1:] or ['sample.mdl']:
        try:
            M = parse(p)
            print('%s: v%d, %d geosets, %d bones, %d seqs, %d mats, %d texs' % (
                os.path.basename(p), M['version'], len(M['geosets']),
                len(M['bones']), len(M['sequences']), len(M['materials']),
                len(M['textures'])))
        except Exception as e:
            print('FAIL %s: %s: %s' % (p, type(e).__name__, e))