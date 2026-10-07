"""Warcraft III's console, resolved from the game's own layout into one table.

ConsoleUI.fdf says where every piece of the console goes and which slice of
which texture fills it; UI\\war3skins.txt says what those texture names mean for
the race being played. Neither is much use alone, so this joins them and writes
what the client needs to draw the frame.

Two things about the coordinates matter and neither is obvious.

They are not viewport fractions. Warcraft III's screen box is 0.8 wide by 0.6
tall with the origin bottom-left, so a Width of 0.256 is 32% of the screen and a
Height of 0.176 is 29%. The output below is already divided through, so the
client can treat it as plain fractions.

`Anchor CORNER, dx, dy` pins that corner of the piece to the same corner of the
screen, offset. That is what lets one layout fit any aspect ratio: the left
pieces hug the left, the right pieces hug the right, and a wider screen simply
opens a gap in the middle rather than stretching anything.

`TexCoord left, right, top, bottom` is a sub-rectangle of the texture in UV, and
it is how four 512-pixel tiles cover a whole console -- the top strip and the
bottom strip are different bands of the same file.

    python3 tools/uiframe.py            # -> public/data/console.json
"""
import json, os, re, sys
sys.path.insert(0, os.path.dirname(__file__))
from fdf import parse, walk, SCREEN_W, SCREEN_H
from PIL import Image
import numpy as np

SKINS = 'war3_extracted/UI/war3skins.txt'
FRAMES = 'war3_extracted/UI/FrameDef/UI'
TEXIDX = 'assets/textures.json'
OUT = 'public/data/console.json'
# Warcraft III picks the console by the player's race; every unit this map
# gives a player is race human, and Human is also what [Default] names.
RACE = os.environ.get('FOC_UI_RACE', 'Human')


def skins():
    """-> {block: {alias: value}}, with [Default] underneath the race block."""
    out, cur = {}, None
    for line in open(SKINS, encoding='latin-1'):
        line = line.strip()
        m = re.fullmatch(r'\[(\w+)\]', line)
        if m:
            cur = m.group(1)
            out.setdefault(cur, {})
        elif cur and '=' in line and not line.startswith('//'):
            k, _, v = line.partition('=')
            out[cur][k.strip()] = v.strip()
    return out


SKIN = skins()
TEX = json.load(open(TEXIDX))


def resolve(alias):
    """A skin alias -> the converted PNG, or None if the game does not ship it."""
    path = SKIN.get(RACE, {}).get(alias) or SKIN.get('Default', {}).get(alias) or alias
    key = path.replace('/', '\\').lower()
    for cand in (key, key + '.blp', key + '.tga'):
        if cand in TEX:
            return TEX[cand]
    return None


def solid_top(png, uv, cover=0.9, alpha=140):
    """How far down a tile before the art is solid all the way across.

    A black backing behind the console has to stop at the art's own skyline. A
    plain rectangle over the whole piece fills the gaps *between* the battlements
    along the top, which reads as a black bar where the world should be; a
    silhouette of the art alone leaves the world showing through every hole and
    seam below it. So: the silhouette handles the skyline, and a solid rectangle
    starting at the first row that is opaque nearly all the way across handles
    everything under it.

    Returned as a fraction of the piece's height, or None if no row qualifies.
    """
    im = Image.open(os.path.join('assets', png)).convert('RGBA')
    w, h = im.size
    l, r, t, b = uv
    box = im.crop((int(l * w), int(t * h), max(1, int(r * w)), max(1, int(b * h))))
    a = np.asarray(box)[:, :, 3] > alpha
    H, W = a.shape
    rows = np.nonzero(a.sum(1) >= W * cover)[0]
    return float(rows[0] / H) if len(rows) else None


def open_windows(png, uv, count=3, alpha=40, least=0.01):
    """The openings in a tile, largest first.

    One is not enough. The left tile has two -- the minimap and, beside the row
    of round buttons, the arch the unit portrait sits in -- and taking only the
    biggest puts the portrait in the wrong hole. Each one found is masked out
    before looking for the next.
    """
    im = Image.open(os.path.join('assets', png)).convert('RGBA')
    w, h = im.size
    l, r, t, b = uv
    box = im.crop((int(l * w), int(t * h), max(1, int(r * w)), max(1, int(b * h))))
    a = np.asarray(box)[:, :, 3] < alpha
    H, W = a.shape
    out = []
    for _ in range(count):
        rect = _max_rect(a)
        if not rect:
            break
        x0, y0, x1, y1 = rect
        if (x1 - x0) * (y1 - y0) < least * W * H:
            break
        out.append({'x': x0 / W, 'y': y0 / H, 'w': (x1 - x0) / W, 'h': (y1 - y0) / H})
        a[y0:y1, x0:x1] = False
    return out


def _max_rect(a):
    """Largest all-True rectangle in a binary mask, by histogram per row."""
    if not a.any():
        return None
    H, W = a.shape
    heights = np.zeros(W, dtype=int)
    best = (0, 0, 0, 0, 0)
    for y in range(H):
        heights = np.where(a[y], heights + 1, 0)
        stack = []
        for x in range(W + 1):
            cur = heights[x] if x < W else 0
            start = x
            while stack and stack[-1][1] >= cur:
                sx, sh = stack.pop()
                area = sh * (x - sx)
                if area > best[0]:
                    best = (area, sx, y - sh + 1, x, y + 1)
                start = sx
            stack.append((start, cur))
    return best[1:] if best[0] else None


def open_window(png, uv, alpha=40):
    """The largest fully transparent rectangle in a texture's UV window.

    The console art carries its own layout: each tile is a stone frame around a
    hole, and the hole is where the minimap, the portrait and the command card
    go. Measuring the hole is exact and survives a re-skin; typing coordinates
    read off a screenshot is neither.

    Returned as fractions of the piece, so the client can place a panel from the
    piece's own box at any resolution.
    """
    im = Image.open(os.path.join('assets', png)).convert('RGBA')
    w, h = im.size
    l, r, t, b = uv
    box = im.crop((int(l * w), int(t * h), max(1, int(r * w)), max(1, int(b * h))))
    a = np.asarray(box)[:, :, 3] < alpha            # True where the frame is open
    if not a.any():
        return None
    H, W = a.shape
    # maximal rectangle over a binary mask, by histogram per row
    heights = np.zeros(W, dtype=int)
    best = (0, 0, 0, 0, 0)                          # area, x0, y0, x1, y1
    for y in range(H):
        heights = np.where(a[y], heights + 1, 0)
        stack = []
        for x in range(W + 1):
            cur = heights[x] if x < W else 0
            start = x
            while stack and stack[-1][1] >= cur:
                sx, sh = stack.pop()
                area = sh * (x - sx)
                if area > best[0]:
                    best = (area, sx, y - sh + 1, x, y + 1)
                start = sx
            stack.append((start, cur))
    if not best[0]:
        return None
    _, x0, y0, x1, y1 = best
    return {'x': x0 / W, 'y': y0 / H, 'w': (x1 - x0) / W, 'h': (y1 - y0) / H}


def open_grid(png, uv, alpha=40, min_run=6):
    """The grid of holes in a tile, as cell rectangles in piece fractions.

    The command card is not one window but twelve, so the largest-rectangle
    measure above finds a thin strip above them instead. A regular grid gives
    itself away in projection: the columns that are open somewhere and the rows
    that are open somewhere cross at exactly the cells.
    """
    im = Image.open(os.path.join('assets', png)).convert('RGBA')
    w, h = im.size
    l, r, t, b = uv
    box = im.crop((int(l * w), int(t * h), max(1, int(r * w)), max(1, int(b * h))))
    a = np.asarray(box)[:, :, 3] < alpha
    if not a.any():
        return []
    H, W = a.shape

    def runs(mask, least):
        out, start = [], None
        for i, v in enumerate(list(mask) + [False]):
            if v and start is None:
                start = i
            elif not v and start is not None:
                if i - start >= least:
                    out.append((start, i))
                start = None
        return out

    # a column counts as part of a cell when a good part of it is open
    cols = runs(a.sum(0) > H * 0.25, min_run)
    rows = runs(a.sum(1) > W * 0.25, min_run)
    if len(cols) < 2 or len(rows) < 2:
        return []
    # The open strip along a tile's own edge is not a cell -- it is the seam
    # where this tile meets the next one.
    rows = [(r0, r1) for r0, r1 in rows if r0 > 0 and r1 < H]
    if not rows:
        return []
    # A command card's rows are equal; the top one only measures short because
    # the tile's own UV window cuts into it. Give every row the tallest row's
    # height, keeping its bottom edge where the art puts it.
    tall = max(r1 - r0 for r0, r1 in rows)
    rows = [(r1 - tall, r1) for r0, r1 in rows]
    return [{'x': c0 / W, 'y': r0 / H, 'w': (c1 - c0) / W, 'h': (r1 - r0) / H}
            for r0, r1 in rows for c0, c1 in cols]


def blue_grid(png, uv, min_run=6):
    """The inventory slots, which are art rather than holes.

    Warcraft III fills the empty inventory with human-inventory-slotfiller, a
    blue pack on every slot, so unlike the command card these cells are opaque
    and the transparency measure cannot see them. They are, however, the only
    strongly blue thing on the console, which finds them exactly.
    """
    im = Image.open(os.path.join('assets', png)).convert('RGBA')
    w, h = im.size
    l, r, t, b = uv
    box = im.crop((int(l * w), int(t * h), max(1, int(r * w)), max(1, int(b * h))))
    a = np.asarray(box).astype(int)
    m = (a[:, :, 3] > 200) & (a[:, :, 2] > a[:, :, 0] + 25) & (a[:, :, 2] > a[:, :, 1] + 15)
    if m.sum() < 200:
        return []
    H, W = m.shape

    def runs(mask, least):
        out, start = [], None
        for i, v in enumerate(list(mask) + [False]):
            if v and start is None:
                start = i
            elif not v and start is not None:
                if i - start >= least:
                    out.append((start, i))
                start = None
        return out

    def merge(rs, gap):
        # the pack drawn on a filler is blue in patches, so one slot projects as
        # several runs; anything closer than a slot's border is the same slot
        out = []
        for a, b in rs:
            if out and a - out[-1][1] <= gap:
                out[-1] = (out[-1][0], b)
            else:
                out.append((a, b))
        return out

    cols = merge(runs(m.sum(0) > H * 0.15, min_run), max(3, W // 40))
    rows = merge(runs(m.sum(1) > W * 0.10, min_run), max(3, H // 40))
    if not cols or not rows:
        return []
    return [{'x': c0 / W, 'y': r0 / H, 'w': (c1 - c0) / W, 'h': (r1 - r0) / H}
            for r0, r1 in rows for c0, c1 in cols]


def piece(t):
    p = t['props']
    anchor = p.get('Anchor')
    if not isinstance(anchor, list) or len(anchor) < 3:
        return None
    tex = resolve(p.get('File', ''))
    if not tex:
        return None
    uv = p.get('TexCoord')
    uv = [float(x) for x in uv] if isinstance(uv, list) and len(uv) == 4 else [0, 1, 0, 1]
    return {
        't': tex,
        # widths against 0.8 and heights against 0.6, so the client sees plain
        # fractions of the viewport
        'w': float(p.get('Width', 0)) / SCREEN_W,
        'h': float(p.get('Height', 0)) / SCREEN_H,
        'a': str(anchor[0]),
        'dx': float(anchor[1]) / SCREEN_W,
        'dy': float(anchor[2]) / SCREEN_H,
        'uv': uv,
        'alpha': p.get('AlphaMode', ''),
        # where the frame is open, as fractions of this piece
        'slot': open_window(tex, uv),
        'slots': open_windows(tex, uv),
        'solid': solid_top(tex, uv),
        'cells': open_grid(tex, uv),
        'inv': blue_grid(tex, uv),
    }


def frame(fdf_name, frame_name):
    blocks = parse(open(os.path.join(FRAMES, fdf_name), encoding='latin-1').read())
    top = next((b for b in walk(blocks) if b.get('name') == frame_name), None)
    if not top:
        return []
    return [x for x in (piece(t) for t in top['children'] if t['type'] == 'Texture') if x]


def top_bars():
    """The strip along the top: Warcraft III's resource readout and menu buttons.

    Two frames the console layout does not mention, because the game anchors
    them to the screen itself rather than to the console: ResourceBar.fdf pins
    gold, lumber and supply to the top right, UpperButtonBar.fdf puts Quests,
    Menu, Allies and Chat along the top left.

    Both are read here rather than measured off the art, because neither is a
    picture -- the resource bar is icons and right-justified numbers at named
    offsets, and the button bar is four copies of one template laid end to end.
    The button template carries its own normal/pushed/disabled art, which is how
    a button with nothing behind it can be drawn the way the game draws it
    instead of being left out.

    Blizzard commented out the upkeep *icon* in their own ResourceBar.fdf and
    left the text; that is reproduced rather than corrected.
    """
    def blocks_of(fdf):
        return parse(open(os.path.join(FRAMES, fdf), encoding='latin-1').read())

    def named(blocks, name):
        return next((b for b in walk(blocks) if b.get('name') == name), None)

    # ---- resources: icon textures and the text anchors beside them
    rb = blocks_of('ResourceBar.fdf')
    frm = named(rb, 'ResourceBarFrame')
    icon_h = 0.01640625
    for b in walk(rb):
        if b.get('name') == 'ResourceBarIconTemplate':
            icon_h = float(b['props'].get('Height', icon_h))
    res = {'w': float((frm or {}).get('props', {}).get('Width', 0.338)) / SCREEN_W,
           'h': float((frm or {}).get('props', {}).get('Height', 0.0218)) / SCREEN_H,
           'items': []}
    if frm:
        pending = None
        for ch in frm['children']:
            p = ch['props']
            if ch['type'] == 'Texture':
                a = p.get('Anchor')
                if not isinstance(a, list) or len(a) < 3:
                    continue
                pending = {'t': resolve(p.get('File', '')),
                           'ix': float(a[1]) / SCREEN_W,
                           'iy': float(a[2]) / SCREEN_H,
                           'iw': icon_h / SCREEN_W, 'ih': icon_h / SCREEN_H}
            elif ch['type'] == 'String':
                a = p.get('Anchor')
                if not isinstance(a, list) or len(a) < 3:
                    continue
                key = (ch.get('name') or '').replace('ResourceBar', '').replace('Text', '').lower()
                item = dict(pending or {'t': None, 'ix': 0, 'iy': 0, 'iw': 0, 'ih': 0})
                item.update(key=key, tx=float(a[1]) / SCREEN_W, ty=float(a[2]) / SCREEN_H,
                            just=str(p.get('FontJustificationH', 'JUSTIFYRIGHT')))
                res['items'].append(item)
                pending = None

    # ---- buttons: one template, four instances, laid left to right
    ub = blocks_of('UpperButtonBar.fdf')
    tpl = named(ub, 'UpperButtonBarButtonTemplate')
    tp = (tpl or {}).get('props', {})
    bar = named(ub, 'UpperButtonBarFrame')
    btn = {'w': float(tp.get('Width', 0.085)) / SCREEN_W,
           'h': float(tp.get('Height', 0.022)) / SCREEN_H,
           'normal': resolve(str(tp.get('NormalTexture', '')).strip('"')),
           'pushed': resolve(str(tp.get('PushedTexture', '')).strip('"')),
           'disabled': resolve(str(tp.get('DisabledTexture', '')).strip('"')),
           'buttons': []}
    # NormalTexture names a Texture *block* in this same file, not a skin alias:
    # the block carries the alias in File and the slice of the sheet in TexCoord.
    # All four states are bands of one buttonstates texture, so both have to be
    # followed or the button draws the whole sheet.
    decl = {}
    for b in walk(ub):
        if b['type'] == 'Texture' and b.get('name'):
            c = b['props'].get('TexCoord')
            decl[b['name']] = {
                't': resolve(str(b['props'].get('File', '')).strip('"')),
                'uv': [float(x) for x in c] if isinstance(c, list) and len(c) == 4 else [0, 1, 0, 1],
            }
    for slot in ('normal', 'pushed', 'disabled'):
        ref = str(tp.get({'normal': 'NormalTexture', 'pushed': 'PushedTexture',
                          'disabled': 'DisabledTexture'}[slot], '')).strip('"')
        btn[slot] = decl.get(ref, {'t': None, 'uv': [0, 1, 0, 1]})
    if bar:
        x = 0.002 / SCREEN_W                       # the first button's TOPLEFT offset
        for ch in bar['children']:
            if ch['type'] != 'Frame':
                continue
            name = (ch.get('name') or '').replace('UpperButtonBar', '').replace('Button', '')
            btn['buttons'].append({'key': name.lower(), 'label': name, 'x': x})
            x += btn['w']
    return res, btn


RES_BAR, BTN_BAR = top_bars()

out = {'race': RACE, 'console': frame('ConsoleUI.fdf', 'ConsoleUI'),
       'resourceBar': RES_BAR, 'buttonBar': BTN_BAR,
       # the dark backing behind the console's open arches; without it the world
       # shows through the middle of the bar
       'background': resolve('ConsoleBackground')}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump(out, open(OUT, 'w'), indent=1)
print('console pieces: %d  (race %s)' % (len(out['console']), RACE))
for p in out['console']:
    sl = p['slot']
    print('  %-11s %5.1f%% x %5.1f%%  at %+0.3f %+0.3f  %-18s %-30s %s'
          % (p['a'], p['w'] * 100, p['h'] * 100, p['dx'], p['dy'], p['t'].split('/')[-1],
             ('open %.0f%%x%.0f%% at %.0f%%,%.0f%%'
              % (sl['w'] * 100, sl['h'] * 100, sl['x'] * 100, sl['y'] * 100)) if sl else '-',
             '%d cells' % len(p['cells']) if p['cells'] else ''))
print('background:', out['background'])
