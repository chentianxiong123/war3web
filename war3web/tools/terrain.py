"""war3map.w3e (terrain), war3map.wpm (pathing), war3map.doo (doodads) -> JSON."""
import struct, json, os, sys

def w3e(path):
    b = open(path, 'rb').read()
    assert b[:4] == b'W3E!', b[:4]
    ver, = struct.unpack_from('<i', b, 4)
    tileset = chr(b[8])
    custom, = struct.unpack_from('<i', b, 9)
    o = 13
    ng, = struct.unpack_from('<i', b, o); o += 4
    ground = [b[o+i*4:o+i*4+4].decode('latin-1') for i in range(ng)]; o += ng*4
    nc, = struct.unpack_from('<i', b, o); o += 4
    cliff = [b[o+i*4:o+i*4+4].decode('latin-1') for i in range(nc)]; o += nc*4
    w, h, cx, cy = struct.unpack_from('<iiff', b, o); o += 16
    n = w*h
    heights = [0]*n; water = [0]*n; tex = [0]*n; flags = [0]*n
    cliffTex = [0]*n; layer = [0]*n; detail = [0]*n
    for i in range(n):
        gh, wl, f_t, d, c_l = struct.unpack_from('<hHBBB', b, o + i*7)
        heights[i] = gh
        water[i] = wl & 0x3FFF
        flags[i] = (f_t >> 4) & 0xF
        tex[i] = f_t & 0xF
        detail[i] = d
        cliffTex[i] = (c_l >> 4) & 0xF
        layer[i] = c_l & 0xF
    return dict(version=ver, tileset=tileset, custom=bool(custom),
                groundTiles=ground, cliffTiles=cliff, width=w, height=h,
                offsetX=cx, offsetY=cy, tileSize=128,
                heights=heights, water=water, tex=tex, flags=flags,
                cliffTex=cliffTex, layer=layer, detail=detail)

def wpm(path):
    b = open(path, 'rb').read()
    assert b[:4] == b'MP3W', b[:4]
    ver, w, h = struct.unpack_from('<iii', b, 4)
    return dict(version=ver, width=w, height=h, cells=list(b[16:16+w*h]))

def doo(path):
    b = open(path, 'rb').read()
    assert b[:4] == b'W3do', b[:4]
    ver, sub, n = struct.unpack_from('<iii', b, 4)
    o = 16
    items = []
    for _ in range(n):
        tid = b[o:o+4].decode('latin-1'); o += 4
        variation, x, y, z, rot, sx, sy, sz = struct.unpack_from('<ifffffff', b, o); o += 32
        flags = b[o]; life = b[o+1]; o += 2
        if sub >= 11:
            o += 4                                    # item table pointer
            nsets, = struct.unpack_from('<i', b, o); o += 4
            for _s in range(nsets):
                ni, = struct.unpack_from('<i', b, o); o += 4
                o += ni*8
        eid, = struct.unpack_from('<i', b, o); o += 4
        items.append(dict(id=tid, variation=variation, x=round(x,2), y=round(y,2),
                          z=round(z,2), rot=round(rot,5),
                          sx=round(sx,4), sy=round(sy,4), sz=round(sz,4),
                          flags=flags, life=life))
    sver, ns = struct.unpack_from('<ii', b, o); o += 8
    special = []
    for _ in range(ns):
        sid = b[o:o+4].decode('latin-1'); o += 4
        sz_, sx_, sy_ = struct.unpack_from('<iii', b, o); o += 12
        special.append(dict(id=sid, z=sz_, x=sx_, y=sy_))
    return dict(version=ver, sub=sub, doodads=items, special=special,
                consumed=o, total=len(b))

if __name__ == '__main__':
    os.makedirs('data', exist_ok=True)
    t = w3e('extracted/war3map.w3e')
    json.dump(t, open('data/terrain.json','w'))
    print('terrain %dx%d verts  tileset=%s ground=%s cliff=%s' % (
        t['width'], t['height'], t['tileset'], t['groundTiles'], t['cliffTiles']))
    hs=[h for h in t['heights']]
    print('  raw height range', min(hs), max(hs), ' layers', min(t['layer']), max(t['layer']))
    print('  world span X %.0f..%.0f  Y %.0f..%.0f' % (
        t['offsetX'], t['offsetX']+(t['width']-1)*128,
        t['offsetY'], t['offsetY']+(t['height']-1)*128))
    p = wpm('extracted/war3map.wpm')
    json.dump(p, open('data/pathing.json','w'))
    print('pathing %dx%d' % (p['width'], p['height']))
    d = doo('extracted/war3map.doo')
    json.dump(d, open('data/doodads.json','w'))
    print('doodads %d, special %d (consumed %d/%d bytes)' % (
        len(d['doodads']), len(d['special']), d['consumed'], d['total']))
    import collections
    print('  top doodad types:', collections.Counter(x['id'] for x in d['doodads']).most_common(12))
