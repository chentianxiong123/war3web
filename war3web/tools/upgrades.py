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
                 'effects': effects}

os.makedirs('data', exist_ok=True)
json.dump(out, open('data/upgrades.json', 'w'), ensure_ascii=False, indent=1)
print('upgrades.json:', len(out), '个升级')
hu = [k for k, v in out.items() if v['race'] == 'human']
print('人族:', hu[:12])
for c in hu[:3]:
    print(' ', c, out[c]['name'][:20], out[c]['costs'][:2], [e['name'] for e in out[c]['effects']])