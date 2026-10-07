"""Parser for Warcraft III object-editor data (.w3u .w3t .w3b .w3h .w3a .w3d .w3q)."""
import struct, json, sys, os

LEVELED = {'.w3a', '.w3d', '.w3q'}   # mods carry level/variation + data-pointer

class R:
    def __init__(s, b): s.b, s.o = b, 0
    def i(s):
        v = struct.unpack_from('<i', s.b, s.o)[0]; s.o += 4; return v
    def f(s):
        v = struct.unpack_from('<f', s.b, s.o)[0]; s.o += 4; return v
    def id4(s):
        v = s.b[s.o:s.o+4]; s.o += 4; return v.decode('latin-1')
    def cstr(s):
        e = s.b.index(b'\x00', s.o)
        v = s.b[s.o:e].decode('utf-8', 'replace'); s.o = e + 1; return v

def parse(path):
    leveled = os.path.splitext(path)[1].lower() in LEVELED
    r = R(open(path, 'rb').read())
    version = r.i()
    out = {'version': version, 'base': [], 'custom': []}
    for table in ('base', 'custom'):
        n = r.i()
        for _ in range(n):
            oid, nid = r.id4(), r.id4()
            nsets = r.i() if version >= 3 else 1
            obj = {'origin': oid.strip('\x00'),
                   'id': (nid.strip('\x00') or oid.strip('\x00')), 'mods': {}}
            for _s in range(nsets):
                if version >= 3:
                    for _ in range(r.i()): r.id4()
                for _ in range(r.i()):
                    mid, vt = r.id4(), r.i()
                    lvl = 0
                    if leveled:
                        lvl = r.i(); r.i()
                    val = r.i() if vt == 0 else (round(r.f(), 6) if vt in (1, 2) else r.cstr())
                    r.i()
                    obj['mods']['%s:%d' % (mid, lvl) if leveled else mid] = val
            out[table].append(obj)
    return out

if __name__ == '__main__':
    os.makedirs('data', exist_ok=True)
    for p in sys.argv[1:]:
        d = parse(p)
        out = os.path.join('data', os.path.basename(p) + '.json')
        json.dump(d, open(out, 'w'), indent=1)
        print('%-18s v%d  base=%-5d custom=%-5d -> %s' % (
            os.path.basename(p), d['version'], len(d['base']), len(d['custom']), out))
