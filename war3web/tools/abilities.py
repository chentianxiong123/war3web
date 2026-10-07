"""Ability table: every ability's base (Blizzard) behaviour + real per-level numbers.

A map's `war3map.w3a` overrides an ability field by the four-character *metadata*
id the World Editor uses, not by anything derivable from the ability's own code.
`Units\\AbilityMetaData.slk` is the table that maps one to the other: it gives the
`AbilityData.slk` column each id writes (`Data`, `UnitID`, `Cool`, ...), which
data slot (`data` 1 = DataA, 2 = DataB ...) and whether the field repeats per
level.

That indirection matters because the interesting fields are *shared* between
abilities rather than named after them.  Every summon in the game -- Serpent
Ward, Feral Spirit, Locust Swarm, Inferno -- stores what it summons in `Hwe1`,
`Ulsu`, `Uin4`, `Osf1` and friends, all of which write the `UnitID` column.
Deriving field names from the ability code instead (`ANsg` -> `Nsg1`) silently
finds nothing for exactly those, so the summon count and unit type never reach
the runtime and the spell casts with no effect.
"""
import json, os, sys, glob, collections, re
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from slk import parse_slk
from wts import resolve_deep

w3a = json.load(open('data/war3map.w3a.json'))
blz = json.load(open('data/blz_abilities.json'))
BLZ = {str(r.get('alias')): r for r in blz}

def num(v, d=None):
    if isinstance(v, (int, float)): return float(v)
    if isinstance(v, str):
        try: return float(v.strip())
        except ValueError: return d
    return d

def text(v):
    """A field's value as a non-empty string, or None. '-' is Blizzard's blank."""
    if v is None: return None
    s = str(v).strip()
    return None if s in ('', '-', '_') else s


# AbilityMetaData.slk: field id -> which AbilityData column it writes
META = {}
for _r in parse_slk('war3_extracted/Units/AbilityMetaData.slk'):
    _id = text(_r.get('ID'))
    if _id:
        META[_id] = dict(field=text(_r.get('field')) or '',
                         data=int(num(_r.get('data'), 0) or 0),
                         repeat=int(num(_r.get('repeat'), 0) or 0),
                         type=text(_r.get('type')) or '')

def ability_func():
    """Units\\*AbilityFunc.txt, as ability id -> {field: value}.

    AbilityData.slk carries none of this: not the order string, and not a single
    art field.  Both live here, which is why reading only the .slk leaves every
    ability with no visual and no dependable way to tell a passive from an
    instant.
    """
    out = collections.defaultdict(dict)
    for p in glob.glob('war3_extracted/Units/*AbilityFunc.txt'):
        cur = None
        for line in open(p, encoding='latin-1', errors='replace'):
            line = line.strip()
            mm = re.match(r'^\[([^\]]+)\]$', line)
            if mm:
                cur = mm.group(1)
                continue
            if cur and '=' in line:
                k, _, v = line.partition('=')
                k, v = k.strip().lower(), v.strip().strip('"')
                if v and v not in ('_', '-') and k not in out[cur]:
                    out[cur][k] = v
    return out


FUNC = ability_func()

# An ability that can be ordered has an order string; a passive has none.  This
# is the one dependable "can it be cast" signal -- `targs` is empty for instant
# abilities as readily as for passives, so reading that as passive disables
# every self-cast summon in the game.
ORDERS = {a: d.get('order') or d.get('orderon') or ''
          for a, d in FUNC.items() if d.get('order') or d.get('orderon')}

# ...except that an order string is not quite proof on its own.  Warcraft III
# gives its passive skills one too -- Attribute Bonus answers to
# `attributemodskill` -- because the skill tree needs something to name.  What
# separates them is the icon: Blizzard files passive art under
# ReplaceableTextures\PassiveButtons, and nothing castable lives there.  Without
# this the engine "casts" a permanent stat bonus and, finding a number in its
# data, throws it at the target as damage.
PASSIVE_ART = {a for a, d in FUNC.items()
               if 'passivebuttons' in str(d.get('art') or '').lower()}

# The art a spell shows.  Warcraft III fires these itself, without the map's
# script asking: Targetart at what was hit, Casterart on the caster, and so on.
# `Targetart` alone covers 321 abilities -- it is the summoning puff, the strike
# flash, the buff glow -- so skipping it leaves most spells visually silent.
ART_FUNC = {'casterart': 'caster', 'targetart': 'target', 'specialart': 'special',
            'effectart': 'effect', 'areaeffectart': 'area', 'missileart': 'missile',
            # `Art` is the command-card icon. It rides along here so it gets the
            # same treatment as the models: Blizzard's for the base, the map's
            # override on top. compile_game.py was reading the override alone,
            # which left 14 of the 130 hero abilities with a blank button.
            'art': 'icon',
            'lightningeffect': 'lightning', 'animnames': 'anim',
            # how the missile flies, for when it is given travel time
            'missilespeed': 'missileSpeed', 'missilearc': 'missileArc',
            'missilehoming': 'missileHoming'}
# the same art, as the map's own w3a overrides name it
ART_W3A = {'acat': 'caster', 'atat': 'target', 'asat': 'special', 'aeat': 'effect',
           'aaea': 'area', 'amat': 'missile', 'alig': 'lightning', 'aani': 'anim',
           'aart': 'icon',
           'amsp': 'missileSpeed', 'amac': 'missileArc', 'amho': 'missileHoming'}


# Buffs have no MetaData.slk in the archives -- Warcraft III keeps the buff
# field ids fixed in the object format itself, so they are written out here.
# ...and only the art ones. `ftac` next door is the target *attachment count*
# and `fta0` an attachment point, so a map that sets them will happily hand you
# "1" as a model path if the map is written too loosely.
BUFF_ART_FIELDS = {'ftat': 'target', 'fsat': 'special', 'feat': 'effect',
                   'faea': 'area', 'fmat': 'missile', 'flig': 'lightning'}
# Where the art hangs, which is not art and so cannot go through is_model().
# Warcraft III takes an attachment point as a token list -- "right,hand" is the
# hand bone on the right side -- and `ftac` says how many points to use, so one
# buff can hang the same model off both hands.
BUFF_POINT_FIELDS = {'fta0': 0, 'fta1': 1, 'fta2': 2, 'fta3': 3, 'fta4': 4, 'fta5': 5}


def is_model(v):
    v = str(v or '')
    return '\\' in v or v.lower().endswith(('.mdl', '.mdx'))


def buff_art_table():
    """Art for every buff: Blizzard's, then the map's edits, then its own buffs.

    The map does not reuse Blizzard's buffs; it derives its own (B002 from BNms)
    and hangs its overrides there. As with units and items, the two w3h tables
    are independent -- a custom buff inherits its origin's *defaults*, not the
    map's edits to that origin.
    """
    out = {}
    for bid, d in FUNC.items():
        if not bid.startswith('B'):
            continue
        art = {}
        for k, slot in ART_FUNC.items():
            if d.get(k): art[slot] = d[k]
        pts = {}
        for k, i in BUFF_POINT_FIELDS.items():
            if d.get(k): pts[i] = d[k]
        if d.get('ftac'): art['count'] = int(num(d['ftac'], 1) or 1)
        if pts: art['points'] = [pts[i] for i in sorted(pts)]
        if art: out[bid] = art

    def apply(dst, mods):
        pts = {}
        for key, raw in mods.items():
            fid = key.split(':')[0]
            v = text(raw)
            slot = BUFF_ART_FIELDS.get(fid)
            if slot and v is not None and (slot == 'lightning' or is_model(v)):
                dst[slot] = v
            elif fid in BUFF_POINT_FIELDS and v:
                pts[BUFF_POINT_FIELDS[fid]] = v
            elif fid == 'ftac' and v is not None:
                dst['count'] = int(num(v, 1) or 1)
        if pts:
            # the map's points replace the origin's outright rather than merging,
            # which is how the object editor treats a repeated field
            dst['points'] = [pts[i] for i in sorted(pts)]
        return dst

    try:
        w3h = json.load(open('data/war3map.w3h.json'))
    except (OSError, ValueError):
        return out
    defaults = {bid: dict(a) for bid, a in out.items()}
    for o in w3h.get('base', []):
        apply(out.setdefault(o['id'], {}), o['mods'])
    for o in w3h.get('custom', []):
        out[o['id']] = apply(dict(defaults.get(o['origin']) or {}), o['mods'])
    return out


BUFF_ART = buff_art_table()


def art_for(base, mods, levels=()):
    """The ability's art: Blizzard's for the base, with the map's overrides on top.

    Warcraft III splits an ability from the buff it applies -- `ANms` the Mana
    Shield ability, `BNms` the Mana Shield buff -- and for anything whose visual
    persists on the unit, the art sits on the *buff*: `[ANms]` names only an
    icon, while `Targetart=...ManaShieldCaster.mdl` is over in `[BNms]`.  Reading
    the ability section alone leaves those spells silent, which is what happened
    to Mana Shield, Entangling Roots, Soul Burn, Wind Walk and Locust Swarm here.
    The ability's own art still wins where it has any; the buff only fills gaps.
    """
    out = {}
    for k, slot in ART_FUNC.items():
        v = FUNC.get(base, {}).get(k)
        if v: out[slot] = v
    # every buff this ability can apply, across its levels
    buffs = []
    for lv in levels:
        for b in str(lv.get('buff') or '').split(','):
            b = b.strip()
            if b and b not in buffs: buffs.append(b)
    if not buffs and base[:1] == 'A':
        buffs.append('B' + base[1:])         # the convention, when no BuffID is set
    if base[:1] == 'A' and ('B' + base[1:]) not in buffs:
        buffs.append('B' + base[1:])         # the convention, as a last resort
    for b in buffs:
        for slot, v in BUFF_ART.get(b, {}).items():
            if slot not in out and v: out[slot] = v
        for k, slot in ART_FUNC.items():
            if slot in out: continue
            v = FUNC.get(b, {}).get(k)
            if v: out[slot] = v
    for fid, slot in ART_W3A.items():
        for key in ('%s:0' % fid, '%s:1' % fid):
            v = text(mods.get(key))
            if v is not None:
                out[slot] = v
                break
    return out

NUMERIC_TYPES = {'int', 'unreal', 'real', 'bool'}
# AbilityData column -> the per-level key the runtime reads.  Anything not here
# (icons, tooltips, hotkeys, button positions) is presentation the server never
# needs; the client gets those from compile_game.py.
FIELD_SLOT = {'Cool': 'cooldown', 'Cost': 'mana', 'Rng': 'range', 'Area': 'area',
              'Dur': 'duration', 'HeroDur': 'heroDuration', 'Cast': 'castTime',
              'UnitID': 'unit', 'BuffID': 'buff', 'targs': 'targets'}


def blz_levels(base):
    r = BLZ.get(base)
    if not r: return []
    n = int(num(r.get('levels'), 1) or 1)
    out = []
    for L in range(1, n + 1):
        lv = dict(targets=text(r.get('targs%d' % L)) or '', cooldown=num(r.get('Cool%d' % L), 0) or 0,
                  mana=num(r.get('Cost%d' % L), 0) or 0,
                  range=num(r.get('Rng%d' % L), 0) or 0,
                  area=num(r.get('Area%d' % L), 0) or 0,
                  duration=num(r.get('Dur%d' % L), 0) or 0,
                  heroDuration=num(r.get('HeroDur%d' % L), 0) or 0,
                  castTime=num(r.get('Cast%d' % L), 0) or 0)
        # TFT AbilityData.slk names data fields Data<Letter><Level>: DataA1, DataB1...
        for f, letter in enumerate('ABCDEFGHI', start=1):
            v = r.get('Data%s%d' % (letter, L))
            if v is None or text(v) is None:
                v = r.get('Data%d%d' % (f, L))            # older layout
            n_ = num(v)
            if n_ is not None: lv['data%d' % f] = n_
            elif text(v) is not None: lv['data%d' % f] = text(v)
        # what a summon summons, and the buff it applies, live in their own columns
        for col, slot in (('UnitID', 'unit'), ('BuffID', 'buff')):
            v = text(r.get('%s%d' % (col, L)))
            if v is not None: lv[slot] = v
        out.append(lv)
    return out


def apply_mods(m, levels):
    """Fold every w3a override into the per-level dicts, via AbilityMetaData."""
    unknown = collections.Counter()
    for key, raw in m.items():
        fid, _, lv = key.partition(':')
        md = META.get(fid)
        if md is None:
            unknown[fid] += 1
            continue
        if md['field'] == 'Data':
            slot = 'data%d' % (md['data'] or 1)
        else:
            slot = FIELD_SLOT.get(md['field'])
        if not slot:
            continue                                   # art, tooltips, hotkeys
        val = num(raw) if md['type'] in NUMERIC_TYPES else None
        if val is None:
            val = text(raw)
            if val is None:
                if slot == 'targets': val = ''
                else: continue
        L = int(num(lv, 0) or 0)
        # level 0 (or a field that does not repeat) applies to every level
        idx = range(len(levels)) if (L == 0 or md['repeat'] == 0) else [L - 1]
        for i in idx:
            if 0 <= i < len(levels): levels[i][slot] = val
    return unknown

table = {}
unknown_fields = collections.Counter()
for tbl in ('base', 'custom'):
    for o in w3a[tbl]:
        base = o['origin']
        m = o['mods']
        nlev = int(num(m.get('alev:0'), None) or num(m.get('alev:1'), None)
                   or num((BLZ.get(base) or {}).get('levels'), 1) or 1)
        defaults = blz_levels(base)
        levels = [dict(defaults[min(L - 1, len(defaults) - 1)]) if defaults else {}
                  for L in range(1, max(1, nlev) + 1)]
        unknown_fields += apply_mods(m, levels)
        name = m.get('anam:0') or m.get('anam:1') or (BLZ.get(base) or {}).get('comments') or o['id']
        b = BLZ.get(base) or {}
        # 'arlv' = hero level required before the ability can be learned at all,
        # 'alsk' = hero levels between successive ranks.  Warcraft III gates the
        # skill tree on these, not on a fixed every-other-level rule.
        def gate(key, col, dflt):
            for k in ('%s:0' % key, '%s:1' % key):
                if k in m:
                    v = num(m[k])
                    if v is not None: return int(v)
            v = num(b.get(col))
            return int(v) if v is not None else dflt
        table[o['id']] = dict(id=o['id'], base=base, name=str(name),
                              # The SLK column is targs1..targs4, one per level;
                              # there is no bare 'targs', so this fallback never
                              # fired and `targets` came out empty for 971 of the
                              # 1046 abilities. That is not cosmetic: isPassive
                              # falls through to targets when an ability declares
                              # no order string, and Blizzard writes Order= for
                              # only some abilities -- so an ability with neither
                              # was read as passive and its execute()short-circuited
                              # before doing anything. Zoro's A03H is the one a
                              # player meets: alone among the map's three Awfb
                              # abilities it sets no atar:1, so it lost its own
                              # 100 damage at ranks 2 and 3.
                              # text() is used for the blank test because '-' and
                              # '_' are Blizzard's empty markers in this column
                              # and treating either as a real target list would
                              # make every passive in the file castable.
                              targets=levels[0].get('targets', '') if levels else '',
                              # 'aord' is the map's own order-string override.  Exactly one
                              # ability here sets it -- A06D, the captured Monster Ball, which
                              # answers to 'summoning' where its AIrr base says 'roar' -- but
                              # taking the base's string for it would name an order the map
                              # does not use.
                              order=str(m.get('aord:0') or ORDERS.get(base, '')),
                              passiveArt=base in PASSIVE_ART,
                              art=art_for(base, m, levels),
                              reqLevel=gate('arlv', 'reqLevel', 0),
                              levelSkip=gate('alsk', 'levelSkip', 0),
                              hero=int(num(b.get('hero'), 0) or 0),
                              levels=levels)

# base abilities the map never customised still need entries (units carry them directly)
for alias, r in BLZ.items():
    if alias in table: continue
    table[alias] = dict(id=alias, base=alias, name=str(r.get('comments') or alias),
                        targets=text(r.get('targs1')) or '',
                        order=ORDERS.get(alias, ''),
                        passiveArt=alias in PASSIVE_ART,
                        art=art_for(alias, {}, blz_levels(alias)),
                        reqLevel=int(num(r.get('reqLevel'), 0) or 0),
                        levelSkip=int(num(r.get('levelSkip'), 0) or 0),
                        hero=int(num(r.get('hero'), 0) or 0),
                        levels=blz_levels(alias))

os.makedirs('data', exist_ok=True)
# authored names and tooltips live in war3map.wts behind a TRIGSTR_
# pointer; resolve them so the runtime never sees the pointer
table = resolve_deep(table)
json.dump(table, open('data/abilities.json', 'w'))

# The buff art table, on its own rather than only folded into each ability's.
#
# Warcraft III hangs a model on a unit for as long as a buff is on it, at the
# attachment point the buff names -- Ichigo's Hollow form is DeathCoilMissile at
# "head". That is a different thing from the cast-time art art_for() already
# merges, and it needs the buff keyed by its own id, so it gets its own file.
# Only the buffs that actually carry a target model are worth writing.
# `ftat` is a model *list*, one per attachment point, which is why it pairs with
# `ftac` and the fta0..N points: Thorny Shield hangs four shields, Bloodlust two.
# Taken whole it is not a path and resolves to nothing.
buffart = {}
for _b, _a in BUFF_ART.items():
    if not _a.get('target'):
        continue
    _r = dict(_a)
    _r['target'] = [m.strip() for m in str(_a['target']).split(',') if m.strip()]
    buffart[_b] = _r
json.dump(buffart, open('data/buffart.json', 'w'), indent=1)
_pts = sum(1 for a in buffart.values() if a.get('points'))
_multi = sum(1 for a in buffart.values() if len(a['target']) > 1)
print('buffs with target art: %d  (%d name an attachment point, %d hang more than one model)'
      % (len(buffart), _pts, _multi))
print('ability table: %d entries' % len(table))
if unknown_fields:
    print('  w3a fields with no AbilityMetaData row: %d distinct -> %s'
          % (len(unknown_fields), dict(unknown_fields.most_common(6))))
_summon = {k: v for k, v in table.items()
           if any(l.get('unit') for l in v['levels'])}
print('  abilities carrying a summoned unit type: %d' % len(_summon))
_cast = [a for a in table.values() if a['order']]
print('  castable (have an order string): %d of %d' % (len(_cast), len(table)))
_art = [a for a in table.values() if a['art']]
_slots = collections.Counter(k for a in table.values() for k in a['art'])
print('  carrying effect art: %d  (%s)' % (len(_art), dict(_slots.most_common())))
import collections
gated = [a for a in table.values() if a['reqLevel'] or a['levelSkip']]
print('  with a learn gate (reqLevel/levelSkip): %d' % len(gated))
print('  reqLevel  values:', dict(sorted(collections.Counter(a['reqLevel'] for a in table.values()).most_common(6))))
print('  levelSkip values:', dict(sorted(collections.Counter(a['levelSkip'] for a in table.values()).most_common(6))))

# which base behaviours actually appear on units/heroes?
types = json.load(open('data/unittypes.json'))
used = collections.Counter()
for t in types.values():
    for a in (t.get('abilities') or []) + (t.get('heroAbilities') or []):
        e = table.get(a)
        if e: used[e['base']] += 1
print('distinct base behaviours reachable from unit types: %d' % len(used))
for b, c in used.most_common(30):
    nm = (BLZ.get(b) or {}).get('comments', '')
    print('   %-6s %-4d %s' % (b, c, nm))
