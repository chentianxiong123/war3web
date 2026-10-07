"""Unified item table: Blizzard ItemData.slk + war3map.w3t overrides.

Items inherit exactly the way units do, and for the same reason it matters: this
map's shop is built almost entirely out of Blizzard items with one field changed.
"Strength +2" is a Tome of Strength with a new price -- the map overrides `igol`
and nothing else -- so the ability that actually grants the strength, `AIsm`, is
only ever named by the Blizzard base. Reading the item's own overrides alone
leaves it with no abilities at all, which is to say it does nothing when bought.

Field ids come from Units\\UnitMetaData.slk, whose item rows are flagged
`useItem=1`; there is no separate ItemMetaData in the archives. The names, icons
and tooltips of stock items live in Units\\ItemFunc.txt and ItemStrings.txt
rather than the .slk, the same split the ability tables use.
"""
import json, os, re, sys, glob, collections
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from slk import parse_slk
from wts import resolve_deep


def num(v, d=0.0):
    if isinstance(v, (int, float)): return float(v)
    if isinstance(v, str):
        try: return float(v.strip())
        except ValueError: return d
    return d


def text(v):
    if v is None: return None
    s = str(v).strip()
    return None if s in ('', '-', '_') else s


# --- what each four-character override id writes, per Warcraft III's own table
META = {}
for r in parse_slk('war3_extracted/Units/UnitMetaData.slk'):
    fid = text(r.get('ID'))
    if fid and str(r.get('useItem') or '') == '1':
        META[fid] = str(r.get('field') or '')

# AbilityData/ItemData column -> the key the runtime reads
COLUMN = {
    'Name': 'name', 'Tip': 'tip', 'Ubertip': 'ubertip', 'Description': 'description',
    'Art': 'icon', 'Hotkey': 'hotkey', 'abilList': 'abilities', 'goldcost': 'gold',
    'lumbercost': 'lumber', 'Level': 'level', 'uses': 'uses', 'file': 'model',
    'class': 'itemClass', 'usable': 'usable', 'pawnable': 'pawnable',
    'perishable': 'perishable', 'powerup': 'powerup', 'sellable': 'sellable',
    'droppable': 'droppable', 'stockMax': 'stockMax', 'stockRegen': 'stockRegen',
    'stockStart': 'stockStart', 'cooldownID': 'cooldownId', 'ignoreCD': 'ignoreCooldown',
    'scale': 'scale', 'armor': 'armorType', 'HP': 'hp', 'morph': 'morph', 'prio': 'priority',
}
LIST_FIELDS = {'abilities'}
STRING_FIELDS = {'name', 'tip', 'ubertip', 'description', 'icon', 'hotkey',
                 'model', 'itemClass', 'armorType', 'cooldownId'}


def item_func():
    """Units\\ItemFunc.txt -- the art and button data the .slk does not carry."""
    out = collections.defaultdict(dict)
    for path in glob.glob('war3_extracted/Units/ItemFunc.txt'):
        cur = None
        for line in open(path, encoding='latin-1', errors='replace'):
            line = line.strip()
            m = re.match(r'^\[([^\]]+)\]$', line)
            if m:
                cur = m.group(1)
                continue
            if not cur or '=' not in line:
                continue
            k, _, v = line.partition('=')
            k, v = k.strip().lower(), v.strip().strip('"')
            if v and v not in ('_', '-') and k not in out[cur]:
                out[cur][k] = v
    return out


def item_strings():
    """Units\\ItemStrings.txt -- stock item names and tooltips."""
    out = collections.defaultdict(dict)
    p = 'war3_extracted/Units/ItemStrings.txt'
    if not os.path.exists(p):
        return out
    cur = None
    for line in open(p, encoding='latin-1', errors='replace'):
        line = line.strip()
        m = re.match(r'^\[([^\]]+)\]$', line)
        if m:
            cur = m.group(1)
            continue
        if not cur or '=' not in line:
            continue
        k, _, v = line.partition('=')
        k, v = k.strip().lower(), v.strip().strip('"')
        if v and k not in out[cur]:
            out[cur][k] = v
    return out


FUNC, STRINGS = item_func(), item_strings()


def from_blz(rec, iid):
    """A stock item, as Blizzard defines it across the .slk and the .txt files."""
    out = {}
    for col, key in COLUMN.items():
        v = rec.get(col)
        if text(v) is None:
            continue
        out[key] = text(v) if key in STRING_FIELDS or key in LIST_FIELDS else num(v)
    for src, keys in ((FUNC.get(iid, {}), ('art', 'buttonpos')),
                      (STRINGS.get(iid, {}), ('name', 'tip', 'ubertip', 'description', 'hotkey'))):
        for k, v in src.items():
            key = {'art': 'icon'}.get(k, k)
            if key in COLUMN.values() and key not in out and text(v) is not None:
                out[key] = text(v)
    out['abilities'] = [x.strip() for x in str(out.get('abilities', '')).split(',')
                        if x.strip() and x.strip() != '_']
    return out


def apply_mods(t, mods):
    for k, v in mods.items():
        fid = k.split(':')[0]
        col = META.get(fid)
        key = COLUMN.get(col)
        if not key:
            continue
        if key in LIST_FIELDS:
            t[key] = [x.strip() for x in str(v).split(',') if x.strip() and x.strip() != '_']
        elif key in STRING_FIELDS:
            t[key] = v
        else:
            t[key] = num(v, t.get(key, 0))
    return t


blz = {str(r.get('itemID')): r for r in json.load(open('data/blz_items.json')) if r.get('itemID')}
w3t = json.load(open('data/war3map.w3t.json'))

items = {}
for iid, rec in blz.items():
    items[iid] = from_blz(rec, iid)
    items[iid]['id'] = iid
    items[iid]['origin'] = iid

# as for units: the two tables are independent, and a custom item inherits the
# stock item's *default* values rather than the author's edits to that stock item
item_defaults = {iid: dict(t) for iid, t in items.items()}

for o in w3t['base']:                       # overrides to stock items
    t = items.setdefault(o['id'], dict(id=o['id'], origin=o['id'], abilities=[]))
    apply_mods(t, o['mods'])
for o in w3t['custom']:                     # new items derived from a stock one
    src = item_defaults.get(o['origin']) or items.get(o['origin'])
    t = dict(src) if src else dict(abilities=[])
    t['abilities'] = list(t.get('abilities') or [])
    t['id'] = o['id']; t['origin'] = o['origin']
    apply_mods(t, o['mods'])
    items[o['id']] = t

os.makedirs('data', exist_ok=True)
# authored text lives in war3map.wts behind a TRIGSTR_ pointer
items = resolve_deep(items)
json.dump(items, open('data/itemtypes.json', 'w'))
print('item table: %d entries (%d stock, %d from the map)'
      % (len(items), len(blz), len(w3t['custom'])))
custom = [items[o['id']] for o in w3t['custom']]
print('  custom items with abilities : %d of %d' % (sum(1 for i in custom if i.get('abilities')), len(custom)))
print('  custom items with an icon   : %d' % sum(1 for i in custom if i.get('icon')))
print('  custom items with a model   : %d' % sum(1 for i in custom if i.get('model')))
print('  inherited (not overridden) abilities: %d'
      % sum(1 for o in w3t['custom'] if 'iabi' not in o['mods'] and items[o['id']].get('abilities')))
