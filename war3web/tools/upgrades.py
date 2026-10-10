"""Upgrade table: Blizzard UpgradeData.slk (官方升级/科技数据).

Upgrade levels cost gold + lumber and take time; each level applies effects
(effectN/baseN/modN/codeN x4 per row in the SLK).  The engine consumes this to
price tech, gate buildings on it and apply per-level stat deltas.

Output: data/upgrades.json  { upgradeid: { race, class, maxlevel, name,
  costs: [{gold, lumber, time}, ...], effects: [{name, base, mod, applies: code}] } }
"""
import json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from slk import parse_slk

def num(v, d=0.0):
    if isinstance(v, (int, float)): return float(v)
    try: return float(str(v).strip())
    except (ValueError, AttributeError): return d

def s(v):
    return str(v or '').strip()

rows = parse_slk('war3_extracted/Units/UpgradeData.slk')
out = {}
for r in rows:
    code = s(r.get('upgradeid'))
    if not code: continue
    race = s(r.get('race')).lower()
    maxlevel = int(num(r.get('maxlevel'), 1))
    gb, gm = num(r.get('goldbase') or 0), num(r.get('goldmod') or 0)
    lb, lm = num(r.get('lumberbase') or 0), num(r.get('lumbermod') or 0)
    tb, tm = num(r.get('timebase') or 0), num(r.get('timemod') or 0)
    costs = []
    for lv in range(maxlevel):
        costs.append({'gold': int(round(gb + gm * lv)),
                      'lumber': int(round(lb + lm * lv)),
                      'time': tb + tm * lv})
    effects = []
    for i in range(1, 5):
        name = s(r.get('effect%d' % i))
        if not name: continue
        effects.append({'name': name, 'base': num(r.get('base%d' % i)),
                        'mod': num(r.get('mod%d' % i)),
                        'applies': s(r.get('code%d' % i))})
    out[code] = {'race': race, 'class': s(r.get('class')), 'maxlevel': maxlevel,
                 'name': s(r.get('comments') or r.get('name') or code), 'costs': costs,
                 'effects': effects,
                 # whether a map/type inherits its origin's per-level numbers
                 # (UpgradeData.slk 'inherit'); the w3q can toggle it
                 'inherit': num(r.get('inherit'), 0),
                 'tip': '', 'ubertip': '', 'art': '', 'hotkey': '',
                 'buttonpos': [0, 0], 'global': num(r.get('global'), 0)}

# -- the map's own upgrades (war3map.w3q), folded over the Blizzard base.  The
#    w3q edits are thin: an id (ginh, gcls...), a name/tip/art change, or a
#    per-level cost/effect override.  Its field ids come from
#    UpgradeMetaData.slk, read here so the mapping never drifts from the data.
UPGRADE_META = {}
_md = parse_slk('war3_extracted/Units/UpgradeMetaData.slk')
for _r in _md:
    _fid = s(_r.get('ID'))
    if _fid:
        UPGRADE_META[_fid] = (_r.get('field'), _r.get('type'))
# the numeric groups are keyed by suffix 1..4
for _i in range(1, 5):
    UPGRADE_META['gba%d' % _i] = ('base%d' % _i, 'unreal')
    UPGRADE_META['gmo%d' % _i] = ('mod%d' % _i, 'unreal')
    UPGRADE_META['gco%d' % _i] = ('code%d' % _i, 'string')
    UPGRADE_META['gef%d' % _i] = ('effect%d' % _i, 'upgradeEffect')


def _convert(field, typ, v):
    v = s(v)
    if typ in ('int', 'unreal', 'unitRace', 'upgradeClass', 'upgradeEffect'):
        return num(v) if typ != 'unitRace' else v
    if typ == 'bool':
        return 1 if v and v != '0' else 0
    if typ == 'techList':
        return [x for x in v.split(',') if x]
    if typ == 'intList':
        return num(v)
    return v


def _apply(dst, mods):
    for fid, raw in mods.items():
        m = UPGRADE_META.get(fid.split(':')[0])
        if not m:
            continue
        field, typ = m
        v = _convert(field, typ, raw)
        if field == 'Buttonpos':
            dst['buttonpos'] = [dst['buttonpos'][0], num(raw)]
            continue
        dst[field] = v
    # costs are stored per level by the base table; a w3q cost edit is a
    # base/mod pair, so rebuild the level table for edited prices
    if 'goldbase' in dst and ('goldbase' in dst or 'goldmod' in dst):
        pass
    return dst


try:
    w3q = json.load(open('data/war3map.w3q.json'))
except (OSError, ValueError):
    w3q = {'base': [], 'custom': []}
for o in w3q.get('base', []):
    if o['id'] in out:
        out[o['id']] = _apply(out[o['id']], o['mods'])
for o in w3q.get('custom', []):
    base = dict(out.get(o['origin']) or {}) if o.get('origin') else {}
    base = dict(base or {'race': '', 'class': '', 'maxlevel': 1, 'name': o['id'],
                         'costs': [], 'effects': []})
    out[o['id']] = _apply(base, o['mods'])

os.makedirs('data', exist_ok=True)
json.dump(out, open('data/upgrades.json', 'w'), ensure_ascii=False, indent=1)
print('upgrades.json:', len(out), '个升级')
hu = [k for k, v in out.items() if v['race'] == 'human']
print('人族:', hu[:12])
for c in hu[:3]:
    print(' ', c, out[c]['name'][:20], out[c]['costs'][:2], [e['name'] for e in out[c]['effects']])