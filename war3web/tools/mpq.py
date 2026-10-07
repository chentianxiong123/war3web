"""Minimal but complete MPQ (MoPaQ) archive reader for Warcraft III .w3x maps.

Implements: storm crypto, hash/block tables, sector decompression with
zlib / bzip2 / PKWARE DCL implode / sparse, and hash-based filename probing
so protected maps (deleted (listfile)) can still be walked.
"""
import struct, zlib, bz2, os, sys

# ---------------------------------------------------------------- storm crypt
_BUF = [0] * 0x500
def _mkbuf():
    seed = 0x00100001
    for i in range(0x100):
        j = i
        while j < 0x500:
            seed = (seed * 125 + 3) % 0x2AAAAB
            t1 = (seed & 0xFFFF) << 16
            seed = (seed * 125 + 3) % 0x2AAAAB
            t2 = (seed & 0xFFFF)
            _BUF[j] = (t1 | t2)
            j += 0x100
_mkbuf()

HASH_TABLE_OFFSET, HASH_NAME_A, HASH_NAME_B, HASH_FILE_KEY = 0, 1, 2, 3

def hash_string(s, htype):
    seed1 = 0x7FED7FED
    seed2 = 0xEEEEEEEE
    for ch in s.upper().replace('/', '\\'):
        c = ord(ch)
        seed1 = _BUF[(htype << 8) + c] ^ ((seed1 + seed2) & 0xFFFFFFFF)
        seed1 &= 0xFFFFFFFF
        seed2 = (c + seed1 + seed2 + (seed2 << 5) + 3) & 0xFFFFFFFF
    return seed1

def decrypt(data, key):
    n = len(data) // 4
    vals = list(struct.unpack('<%dI' % n, data[:n * 4]))
    seed = 0xEEEEEEEE
    for i in range(n):
        seed = (seed + _BUF[0x400 + (key & 0xFF)]) & 0xFFFFFFFF
        ch = vals[i] ^ ((key + seed) & 0xFFFFFFFF)
        key = ((((~key) & 0xFFFFFFFF) << 0x15) + 0x11111111 | (key >> 0x0B)) & 0xFFFFFFFF
        seed = (ch + seed + (seed << 5) + 3) & 0xFFFFFFFF
        vals[i] = ch
    return struct.pack('<%dI' % n, *vals) + data[n * 4:]

# ------------------------------------------------------- PKWARE DCL "explode"
MAXBITS = 13
_LITLEN = bytes([
    11,124,8,7,28,7,188,13,76,4,10,8,12,10,12,10,8,23,8,9,7,6,7,8,7,6,55,8,
    23,24,12,11,7,9,11,12,6,7,22,5,7,24,6,11,9,6,7,22,7,11,38,7,9,8,25,11,8,
    11,9,12,8,12,5,38,5,38,5,11,7,5,6,21,6,10,53,8,7,24,10,27,44,253,253,253,
    252,252,252,13,12,45,12,45,12,61,12,45,44,173])
_LENLEN = bytes([2,35,36,53,38,23])
_DISTLEN = bytes([2,20,53,230,247,151,248])
_BASE = [3,2,4,5,6,7,8,9,10,12,16,24,40,72,136,264]
_EXTRA = [0,0,0,0,0,0,0,0,1,2,3,4,5,6,7,8]

class _Huff:
    __slots__ = ('count', 'symbol')
    def __init__(self, rep, n):
        length = []
        i = 0
        for _ in range(n):
            v = rep[i]; i += 1
            left = (v >> 4) + 1
            length.extend([v & 15] * left)
        self.count = [0] * (MAXBITS + 1)
        for l in length:
            self.count[l] += 1
        offs = [0] * (MAXBITS + 2)
        offs[1] = 0
        for l in range(1, MAXBITS):
            offs[l + 1] = offs[l] + self.count[l]
        self.symbol = [0] * len(length)
        for sym, l in enumerate(length):
            if l:
                self.symbol[offs[l]] = sym
                offs[l] += 1

_LITCODE = _Huff(_LITLEN, len(_LITLEN))
_LENCODE = _Huff(_LENLEN, len(_LENLEN))
_DISTCODE = _Huff(_DISTLEN, len(_DISTLEN))

class _Blast:
    def __init__(self, data):
        self.d = data; self.p = 0; self.bitbuf = 0; self.bitcnt = 0
    def bits(self, need):
        val = self.bitbuf
        while self.bitcnt < need:
            val |= self.d[self.p] << self.bitcnt
            self.p += 1
            self.bitcnt += 8
        self.bitbuf = val >> need
        self.bitcnt -= need
        return val & ((1 << need) - 1)
    def decode(self, h):
        bitbuf = self.bitbuf; left = self.bitcnt
        code = first = index = 0; length = 1
        nexti = 1
        while True:
            while left:
                left -= 1
                code |= (bitbuf & 1) ^ 1
                bitbuf >>= 1
                cnt = h.count[nexti]; nexti += 1
                if code < first + cnt:
                    self.bitbuf = bitbuf
                    self.bitcnt = (self.bitcnt - length) & 7
                    return h.symbol[index + (code - first)]
                index += cnt
                first = (first + cnt) << 1
                code <<= 1
                length += 1
            left = (MAXBITS + 1) - length
            if left == 0:
                raise ValueError('blast: bad code')
            bitbuf = self.d[self.p]; self.p += 1
            if left > 8:
                left = 8

def explode(data):
    s = _Blast(data)
    lit = s.bits(8)
    if lit > 1:
        raise ValueError('blast: bad literal flag %d' % lit)
    dict_ = s.bits(8)
    if dict_ < 4 or dict_ > 6:
        raise ValueError('blast: bad dict size %d' % dict_)
    out = bytearray()
    while True:
        if s.bits(1):
            sym = s.decode(_LENCODE)
            ln = _BASE[sym] + s.bits(_EXTRA[sym])
            if ln == 519:
                break
            sym = 2 if ln == 2 else dict_
            dist = s.decode(_DISTCODE) << sym
            dist += s.bits(sym)
            dist += 1
            if dist > len(out):
                raise ValueError('blast: distance too far back')
            start = len(out) - dist
            for k in range(ln):
                out.append(out[start + k])
        else:
            out.append(s.decode(_LITCODE) if lit else s.bits(8))
    return bytes(out)

# ------------------------------------------------------------ decompression
def _sparse_decomp(data):
    out = bytearray(); i = 0
    while i < len(data):
        c = data[i]; i += 1
        if c & 0x80:
            n = (c & 0x7F) + 1
            out += data[i:i + n]; i += n
        else:
            out += b'\x00' * ((c & 0x7F) + 3)
    return bytes(out)

def decompress(data, expected):
    if len(data) >= expected:
        return data
    mask = data[0]
    body = data[1:]
    # Methods are applied in reverse order of compression.
    if mask & 0x20:
        body = _sparse_decomp(body)
    if mask & 0x02:
        body = zlib.decompress(body)
    elif mask & 0x08:
        body = explode(body)
    elif mask & 0x10:
        body = bz2.decompress(body)
    elif mask & 0x01:
        from storm_codec import huffman_decompress
        body = huffman_decompress(body)
    elif not (mask & (0x40 | 0x80 | 0x20)):
        raise ValueError('unknown compression mask 0x%02x' % mask)
    if mask & 0x01 and mask & 0x02:
        from storm_codec import huffman_decompress
        body = huffman_decompress(body)
    if mask & (0x40 | 0x80):
        from storm_codec import adpcm_decompress
        body = adpcm_decompress(body, 2 if mask & 0x80 else 1)
    return body

# --------------------------------------------------------------- the archive
FLAG_IMPLODE     = 0x00000100
FLAG_COMPRESS    = 0x00000200
FLAG_ENCRYPTED   = 0x00010000
FLAG_FIX_KEY     = 0x00020000
FLAG_SINGLE      = 0x01000000
FLAG_DELETED     = 0x02000000
FLAG_SECTOR_CRC  = 0x04000000
FLAG_EXISTS      = 0x80000000

class MPQ:
    def __init__(self, path, mmap_file=None):
        import mmap as _mmap
        self.f = open(path, 'rb')
        big = os.fstat(self.f.fileno()).st_size > 64 << 20
        if mmap_file or (mmap_file is None and big):
            raw = _mmap.mmap(self.f.fileno(), 0, access=_mmap.ACCESS_READ)
        else:
            raw = self.f.read()
        self.raw = raw
        off = raw.find(b'MPQ\x1a')
        if off < 0:
            raise ValueError('no MPQ header')
        self.base = off
        (_, _hsz, self.archive_size, self.fmt, self.sector_shift,
         hpos, bpos, hsize, bsize) = struct.unpack_from('<4sIIHHIIII', raw, off)
        self.sector_size = 512 << self.sector_shift
        ht = bytearray(raw[off + hpos: off + hpos + hsize * 16])
        bt = bytearray(raw[off + bpos: off + bpos + bsize * 16])
        ht = decrypt(bytes(ht), hash_string('(hash table)', HASH_FILE_KEY))
        bt = decrypt(bytes(bt), hash_string('(block table)', HASH_FILE_KEY))
        self.hash_table = [struct.unpack_from('<IIHHI', ht, i * 16) for i in range(hsize)]
        self.block_table = [struct.unpack_from('<IIII', bt, i * 16) for i in range(bsize)]
        self.hsize = hsize

    def find(self, name):
        idx = hash_string(name, HASH_TABLE_OFFSET) & (self.hsize - 1)
        a = hash_string(name, HASH_NAME_A)
        b = hash_string(name, HASH_NAME_B)
        for i in range(self.hsize):
            e = self.hash_table[(idx + i) & (self.hsize - 1)]
            if e[3] == 0xFFFF and e[4] == 0xFFFFFFFF:
                return None            # empty & never used -> stop
            if e[0] == a and e[1] == b and e[4] != 0xFFFFFFFF:
                return e[4]
        return None

    def read(self, name):
        bi = self.find(name)
        if bi is None or bi >= len(self.block_table):
            return None
        return self.read_block(bi, name)

    def read_block(self, bi, name):
        pos, csize, fsize, flags = self.block_table[bi]
        if not (flags & FLAG_EXISTS) or fsize == 0:
            return b''
        start = self.base + pos
        key = None
        if flags & FLAG_ENCRYPTED:
            plain = name.replace('/', '\\').split('\\')[-1]
            key = hash_string(plain, HASH_FILE_KEY)
            if flags & FLAG_FIX_KEY:
                key = ((key + pos) ^ fsize) & 0xFFFFFFFF
        if flags & FLAG_SINGLE:
            data = self.raw[start:start + csize]
            if key is not None:
                data = decrypt(data, key)
            if flags & (FLAG_COMPRESS | FLAG_IMPLODE) and csize < fsize:
                data = explode(data) if (flags & FLAG_IMPLODE and not flags & FLAG_COMPRESS) \
                       else decompress(data, fsize)
            return data[:fsize]
        if not (flags & (FLAG_COMPRESS | FLAG_IMPLODE)):
            data = self.raw[start:start + fsize]
            if key is not None:
                data = decrypt(data, key)
            return data[:fsize]
        # multi-sector
        nsec = (fsize + self.sector_size - 1) // self.sector_size
        ntab = nsec + 1
        if flags & FLAG_SECTOR_CRC:
            ntab += 1
        tab = self.raw[start:start + ntab * 4]
        if key is not None:
            tab = decrypt(tab, (key - 1) & 0xFFFFFFFF)
        offs = struct.unpack('<%dI' % ntab, tab[:ntab * 4])
        out = bytearray()
        for i in range(nsec):
            sd = self.raw[start + offs[i]: start + offs[i + 1]]
            if key is not None:
                sd = decrypt(sd, (key + i) & 0xFFFFFFFF)
            want = min(self.sector_size, fsize - len(out))
            if len(sd) < want:
                if flags & FLAG_IMPLODE and not (flags & FLAG_COMPRESS):
                    sd = explode(sd)
                else:
                    sd = decompress(sd, want)
            out += sd[:want]
        return bytes(out[:fsize])

# ------------------------------------------------- key cracking (no filename)
def crack_key(enc_table, sector_size, ntab):
    """Recover a file's encryption key from its encrypted sector-offset table."""
    e0, e1 = struct.unpack_from('<II', enc_table, 0)
    p0 = ntab * 4
    S = (e0 ^ p0) - 0xEEEEEEEE
    cands = []
    for b in range(0x100):
        k = (S - _BUF[0x400 + b]) & 0xFFFFFFFF
        if (k & 0xFF) != b:
            continue
        # verify against second offset
        seed = (0xEEEEEEEE + _BUF[0x400 + (k & 0xFF)]) & 0xFFFFFFFF
        c0 = e0 ^ ((k + seed) & 0xFFFFFFFF)
        if c0 != p0:
            continue
        k2 = ((((~k) & 0xFFFFFFFF) << 0x15) + 0x11111111 | (k >> 0x0B)) & 0xFFFFFFFF
        seed = (c0 + seed + (seed << 5) + 3) & 0xFFFFFFFF
        seed2 = (seed + _BUF[0x400 + (k2 & 0xFF)]) & 0xFFFFFFFF
        c1 = e1 ^ ((k2 + seed2) & 0xFFFFFFFF)
        if p0 < c1 <= p0 + sector_size:
            cands.append(k)
    return cands[0] if len(cands) >= 1 else None

def read_block_cracked(self, bi):
    """Read a block whose filename is unknown, by cracking its key."""
    pos, csize, fsize, flags = self.block_table[bi]
    start = self.base + pos
    if not (flags & FLAG_ENCRYPTED):
        return self.read_block(bi, '')
    if not (flags & (FLAG_COMPRESS | FLAG_IMPLODE)):
        return None
    nsec = (fsize + self.sector_size - 1) // self.sector_size
    ntab = nsec + 1 + (1 if flags & FLAG_SECTOR_CRC else 0)
    key = crack_key(self.raw[start:start + 8], self.sector_size, ntab)
    if key is None:
        return None
    # crack_key returns the table key, which is filekey-1
    tab = decrypt(self.raw[start:start + ntab * 4], key)
    offs = struct.unpack('<%dI' % ntab, tab[:ntab * 4])
    fkey = (key + 1) & 0xFFFFFFFF  # noqa
    out = bytearray()
    for i in range(nsec):
        sd = decrypt(self.raw[start + offs[i]: start + offs[i + 1]], (fkey + i) & 0xFFFFFFFF)
        want = min(self.sector_size, fsize - len(out))
        if len(sd) < want:
            try:
                sd = decompress(sd, want)
            except Exception:
                return None
        out += sd[:want]
    return bytes(out[:fsize])

MPQ.read_block_cracked = read_block_cracked
