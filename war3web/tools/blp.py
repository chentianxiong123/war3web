"""BLP1 (Warcraft III) decoder -> RGBA numpy array / PNG."""
import struct, io, os, sys, glob
import numpy as np
from PIL import Image

def decode(data):
    assert data[:4] == b'BLP1', 'not BLP1'
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
    raise ValueError('unsupported BLP compression %d' % comp)

def to_png(src, dst):
    rgba = decode(open(src, 'rb').read())
    im = Image.fromarray(rgba, 'RGBA')
    if (rgba[:, :, 3] == 255).all():
        im = im.convert('RGB')
    os.makedirs(os.path.dirname(dst) or '.', exist_ok=True)
    im.save(dst, optimize=True)
    return im.size

if __name__ == '__main__':
    # A decoder is more use as a converter than as one machine's demo: this
    # block hardcoded a scratchpad path, username and session id and all.
    #
    #   python3 tools/blp.py <in.blp> [out.png]
    src = sys.argv[1] if len(sys.argv) > 1 else 'extracted/war3mapMap.blp'
    dst = sys.argv[2] if len(sys.argv) > 2 else \
        os.path.splitext(os.path.basename(src))[0] + '.png'
    print(to_png(src, dst))
