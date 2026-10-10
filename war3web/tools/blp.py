"""BLP1 + BLP2 (Warcraft III) decoder -> RGBA numpy array / PNG.

BLP1 is the format the checked-out archives all use; BLP2 is what any
1.30+/Reforged or third-party texture brings in. blp2 has its own header and
S3TC/DXT payloads, so before this file a single BLP2 texture crashed the
whole asset pipeline at decode time. Both formats share the to_png contract.
"""
import struct, io, os, sys
import numpy as np
from PIL import Image

# --------------------------------------------------------------- DXT blocks

def _565(v):
    """16-bit RGB565 -> (r, g, b) in 0..255."""
    r = (v >> 11) & 0x1F
    g = (v >> 5) & 0x3F
    b = v & 0x1F
    return (r << 3 | r >> 2, g << 2 | g >> 4, b << 3 | b >> 2)


def _dxt1_colors(c0, c1):
    """12 flattened RGB values (4 colors x 3); the 4th is black in 3-color
    mode, where index 3 means transparent."""
    a, b = _565(c0), _565(c1)
    out = list(a) + list(b)
    if c0 > c1:
        out += [(2 * a[0] + b[0]) // 3, (2 * a[1] + b[1]) // 3, (2 * a[2] + b[2]) // 3,
                (a[0] + 2 * b[0]) // 3, (a[1] + 2 * b[1]) // 3, (a[2] + 2 * b[2]) // 3]
    else:
        out += [(a[0] + b[0]) // 2, (a[1] + b[1]) // 2, (a[2] + b[2]) // 2,
                0, 0, 0]
    return out


def _dxt1_block(b, o):
    """8-byte DXT1 block -> 4x4 RGBA (index 3 is transparent when 3-color mode)."""
    c0, c1 = struct.unpack_from('<HH', b, o)
    colors = _dxt1_colors(c0, c1)
    out = np.zeros((4, 4, 4), np.uint8)
    for y in range(4):
        row = b[o + 4 + y]
        for x in range(4):
            i = (row >> (2 * x)) & 3
            out[y, x, 0] = colors[i * 3]
            out[y, x, 1] = colors[i * 3 + 1]
            out[y, x, 2] = colors[i * 3 + 2]
            out[y, x, 3] = 0 if (len(colors) == 12 and i == 3) else 255
    return out


def _dxt3_block(b, o):
    """16-byte DXT3 block: 4-bit alphas then a 4-color DXT1 payload."""
    c0, c1 = struct.unpack_from('<HH', b, o + 8)
    colors = _dxt1_colors(c0, c1)
    out = np.zeros((4, 4, 4), np.uint8)
    for y in range(4):
        for x in range(4):
            i = (b[o + 4 + y] >> (2 * x)) & 3
            a = (b[o + y * 2 + (x >> 1)] >> (4 * (x & 1))) & 0xF
            out[y, x, 0] = colors[i * 3]
            out[y, x, 1] = colors[i * 3 + 1]
            out[y, x, 2] = colors[i * 3 + 2]
            out[y, x, 3] = a << 4 | a
    return out


def _dxt5_block(b, o):
    """16-byte DXT5 block: 8-step alpha ladder then a 4-color DXT1 payload."""
    a0, a1 = b[o], b[o + 1]
    if a0 > a1:
        ladder = [a0, a1] + [(6 * a0 + a1) // 7, (5 * a0 + 2 * a1) // 7,
                             (4 * a0 + 3 * a1) // 7, (3 * a0 + 4 * a1) // 7,
                             (2 * a0 + 5 * a1) // 7, (a0 + 6 * a1) // 7]
    else:
        ladder = [a0, a1] + [(4 * a0 + a1) // 5, (3 * a0 + 2 * a1) // 5,
                             (2 * a0 + 3 * a1) // 5, (a0 + 4 * a1) // 5,
                             0, 255]
    bits = int.from_bytes(b[o + 2:o + 8], 'little')
    c0, c1 = struct.unpack_from('<HH', b, o + 8)
    colors = _dxt1_colors(c0, c1)
    out = np.zeros((4, 4, 4), np.uint8)
    for i in range(16):
        x, y = i & 3, i >> 2
        ai = (bits >> (3 * i)) & 7
        ci = (b[o + 12 + y] >> (2 * x)) & 3
        out[y, x, 0] = colors[ci * 3]
        out[y, x, 1] = colors[ci * 3 + 1]
        out[y, x, 2] = colors[ci * 3 + 2]
        out[y, x, 3] = ladder[ai]
    return out


# ------------------------------------------------------------------ BLP1

def _blp1(data):
    comp, flags, w, h, ptype, psub = struct.unpack_from('<IIIIII', data, 4)
    offs = struct.unpack_from('<16I', data, 28)
    sizes = struct.unpack_from('<16I', data, 92)
    if comp == 0:                                     # JPEG
        hlen, = struct.unpack_from('<I', data, 156)
        hdr = data[160:160+hlen]
        jpg = hdr + data[offs[0]:offs[0]+sizes[0]]
        im = Image.open(io.BytesIO(jpg))
        a = np.asarray(im.convert('CMYK') if im.mode != 'CMYK' else im)
        # BLP stores JPEG components as B,G,R,A and inverted by the CMYK reader
        a = 255 - a
        rgba = np.dstack([a[:, :, 2], a[:, :, 1], a[:, :, 0], a[:, :, 3]])
        if flags & 8 == 0 and ptype == 5:
            rgba[:, :, 3] = 255
        return rgba[:h, :w].astype(np.uint8)
    elif comp == 1:                                   # paletted
        pal = np.frombuffer(data[156:156+1024], dtype=np.uint8).reshape(256, 4)
        n = w * h
        idx = np.frombuffer(data[offs[0]:offs[0]+n], dtype=np.uint8)
        out = np.zeros((n, 4), np.uint8)
        out[:, 0] = pal[idx, 2]; out[:, 1] = pal[idx, 1]; out[:, 2] = pal[idx, 0]
        if ptype in (3, 4) and sizes[0] >= n*2:
            out[:, 3] = np.frombuffer(data[offs[0]+n:offs[0]+2*n], dtype=np.uint8)
        else:
            out[:, 3] = 255
        return out.reshape(h, w, 4)
    raise ValueError('unsupported BLP1 compression %d' % comp)


# ------------------------------------------------------------------ BLP2

_BLP2_BLOCKS = {2: (_dxt1_block, 8), 3: (_dxt3_block, 16), 4: (_dxt5_block, 16)}


def _blp2(data):
    comp, = struct.unpack_from('<I', data, 4)
    flags = data[8]
    w, h = struct.unpack_from('<II', data, 12)
    offs = struct.unpack_from('<16I', data, 20)
    sizes = struct.unpack_from('<16I', data, 84)

    if comp == 0:                                     # JPEG (plain payload)
        jpg = data[offs[0]:offs[0] + sizes[0]]
        im = Image.open(io.BytesIO(jpg)).convert('RGBA')
        return np.asarray(im)[:h, :w].astype(np.uint8)

    if comp == 1:                                     # uncompressed
        if flags & 2:                                 # palette-indexed
            pal = np.frombuffer(data[148:148+1024], dtype=np.uint8).reshape(256, 4)
            n = w * h
            idx = np.frombuffer(data[offs[0]:offs[0]+n], dtype=np.uint8)
            out = np.zeros((n, 4), np.uint8)
            out[:, 0] = pal[idx, 2]; out[:, 1] = pal[idx, 1]; out[:, 2] = pal[idx, 0]
            out[:, 3] = 255
            return out.reshape(h, w, 4)
        raw = np.frombuffer(data[offs[0]:offs[0] + w * h * 4],
                            dtype=np.uint8).reshape(h, w, 4)
        out = raw.copy()                              # B,G,R,A -> R,G,B,A
        out[:, :, 0] = raw[:, :, 2]; out[:, :, 2] = raw[:, :, 0]
        return out

    block, bsize = _BLP2_BLOCKS.get(comp, (None, None))
    if block is None:
        raise ValueError('unsupported BLP2 compression %d' % comp)

    bw, bh = (w + 3) // 4, (h + 3) // 4
    out = np.zeros((bh * 4, bw * 4, 4), np.uint8)
    o = offs[0]
    for by in range(bh):
        for bx in range(bw):
            blk = block(data, o)
            o += bsize
            out[by*4:by*4+4, bx*4:bx*4+4] = blk
    return out[:h, :w]


def decode(data):
    if data[:4] == b'BLP1':
        return _blp1(data)
    if data[:4] == b'BLP2':
        return _blp2(data)
    raise ValueError('not a BLP file: %r' % data[:4])


def to_png(src, dst):
    rgba = decode(open(src, 'rb').read())
    im = Image.fromarray(rgba, 'RGBA')
    if (rgba[:, :, 3] == 255).all():
        im = im.convert('RGB')
    os.makedirs(os.path.dirname(dst) or '.', exist_ok=True)
    im.save(dst, optimize=True)
    return im.size


if __name__ == '__main__':
    src = sys.argv[1] if len(sys.argv) > 1 else 'extracted/war3mapMap.blp'
    dst = sys.argv[2] if len(sys.argv) > 2 else \
        os.path.splitext(os.path.basename(src))[0] + '.png'
    print(to_png(src, dst))