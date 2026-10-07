"""Minimal glTF 2.0 / GLB writer."""
import json, struct
import numpy as np

CT = {'b': 5120, 'B': 5121, 'h': 5122, 'H': 5123, 'I': 5125, 'f': 5126}
NP = {'b': np.int8, 'B': np.uint8, 'h': np.int16, 'H': np.uint16, 'I': np.uint32, 'f': np.float32}
NCOMP = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4, 'MAT4': 16}

class GLTF:
    def __init__(self):
        self.j = dict(asset=dict(version='2.0', generator='foc-mdx2gltf'),
                      scene=0, scenes=[dict(nodes=[])], nodes=[], meshes=[],
                      materials=[], textures=[], images=[], samplers=[],
                      accessors=[], bufferViews=[], buffers=[], skins=[], animations=[])
        self.bin = bytearray()

    def _view(self, data, target=None):
        while len(self.bin) % 4: self.bin.append(0)
        off = len(self.bin)
        self.bin += data
        v = dict(buffer=0, byteOffset=off, byteLength=len(data))
        if target: v['target'] = target
        self.j['bufferViews'].append(v)
        return len(self.j['bufferViews']) - 1

    def acc(self, arr, type_, fmt, target=None, minmax=False, normalized=False):
        a = np.ascontiguousarray(np.asarray(arr, NP[fmt]))
        n = a.size // NCOMP[type_]
        v = self._view(a.tobytes(), target)
        d = dict(bufferView=v, componentType=CT[fmt], count=int(n), type=type_)
        if normalized: d['normalized'] = True
        if minmax:
            r = a.reshape(n, NCOMP[type_])
            d['min'] = [float(x) for x in r.min(0)]
            d['max'] = [float(x) for x in r.max(0)]
        self.j['accessors'].append(d)
        return len(self.j['accessors']) - 1

    def image(self, uri):
        self.j['images'].append(dict(uri=uri))
        return len(self.j['images']) - 1

    def sampler(self, wrap_s=10497, wrap_t=10497):
        s = dict(magFilter=9729, minFilter=9987, wrapS=wrap_s, wrapT=wrap_t)
        for i, e in enumerate(self.j['samplers']):
            if e == s: return i
        self.j['samplers'].append(s)
        return len(self.j['samplers']) - 1

    def texture(self, image_idx, sampler_idx):
        t = dict(source=image_idx, sampler=sampler_idx)
        for i, e in enumerate(self.j['textures']):
            if e == t: return i
        self.j['textures'].append(t)
        return len(self.j['textures']) - 1

    def save(self, path):
        self.j['buffers'] = [dict(byteLength=len(self.bin))]
        for k in list(self.j):
            if isinstance(self.j[k], list) and not self.j[k] and k != 'scenes':
                del self.j[k]
        js = json.dumps(self.j, separators=(',', ':')).encode()
        js += b' ' * ((4 - len(js) % 4) % 4)
        bn = bytes(self.bin) + b'\x00' * ((4 - len(self.bin) % 4) % 4)
        glb = (struct.pack('<III', 0x46546C67, 2, 12 + 8 + len(js) + 8 + len(bn))
               + struct.pack('<II', len(js), 0x4E4F534A) + js
               + struct.pack('<II', len(bn), 0x004E4942) + bn)
        open(path, 'wb').write(glb)
        return len(glb)
