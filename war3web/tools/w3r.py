"""war3map.w3r -- the map's regions, war3map.w3r (warsmash Region.java layout).

Regions are the rectangular areas the trigger editor names ("The Ancient's
Grove", "Keeper's Edge") and the map can attach weather/ambience to. The old
pipeline had no source for any of it at all.

Layout: version int32, count int32, then per region
  left/bottom/right/top float32 x4, name cstr, creationNumber int32,
  weatherId 4cc, ambientId cstr, color u8 x4.

Maps without regions (Terenas ships a zero-byte file) parse to an empty list.
"""
import os, sys, json, struct

sys.path.insert(0, os.path.dirname(__file__))


def parse(path):
    raw = open(path, 'rb').read()
    # a zero-byte w3r is "no regions", not corruption
    if not raw:
        return dict(version=0, regions=[])
    r = type('R', (), {})()
    r.b, r.o = raw, 0
    def i32():
        v = int.from_bytes(r.b[r.o:r.o+4], 'little', signed=True); r.o += 4; return v
    def f32():
        v = struct.unpack_from('<f', r.b, r.o)[0]; r.o += 4; return v
    def cstr():
        e = r.b.index(b'\x00', r.o)
        v = r.b[r.o:e].decode('utf-8', 'replace'); r.o = e + 1; return v
    def id4():
        v = r.b[r.o:r.o+4].decode('latin-1'); r.o += 4; return v
    ver = i32()
    regions = []
    for _ in range(i32()):
        reg = dict(left=f32(), bottom=f32(), right=f32(), top=f32(),
                   name=cstr(), creationNumber=i32(), weatherId=id4(),
                   ambientId=cstr())
        reg['color'] = list(r.b[r.o:r.o+4]); r.o += 4
        regions.append(reg)
    return dict(version=ver, regions=regions)


if __name__ == '__main__':
    src = sys.argv[1] if len(sys.argv) > 1 else 'extracted/war3map.w3r'
    out = sys.argv[2] if len(sys.argv) > 2 else 'data/war3map.w3r.json'
    d = parse(src)
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    json.dump(d, open(out, 'w'), separators=(',', ':'))
    print('%d regions (v%d) -> %s' % (len(d['regions']), d['version'], out))