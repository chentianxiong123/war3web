"""Parser for Blizzard's SLK data tables, plus the Units\\*Func.txt / *Strings.txt pairs."""
import re, os, json, sys, collections

def parse_slk(path):
    rows = {}
    r = c = 1
    with open(path, encoding='utf-8', errors='replace') as f:
        for line in f:
            line = line.rstrip('\r\n')
            if not line or line[0] not in 'CBFOPE': continue
            if line[0] != 'C' and line[0] != 'F': continue
            val = None
            for part in line.split(';')[1:]:
                if not part: continue
                t, rest = part[0], part[1:]
                if t == 'X': c = int(rest)
                elif t == 'Y': r = int(rest)
                elif t == 'K':
                    if rest.startswith('"'): val = rest.strip('"')
                    else:
                        try: val = int(rest)
                        except ValueError:
                            try: val = float(rest)
                            except ValueError: val = rest
            if val is not None:
                rows.setdefault(r, {})[c] = val
    if not rows: return []
    hdr = rows.get(1, {})
    cols = {ci: str(name) for ci, name in hdr.items()}
    out = []
    for ri in sorted(rows):
        if ri == 1: continue
        rec = {}
        for ci, v in rows[ri].items():
            key = cols.get(ci)
            if key: rec[key] = v
        if rec: out.append(rec)
    return out

def parse_profile(path):
    """Units\\*Func.txt style: [UNITID] key=value blocks."""
    out = {}
    cur = None
    with open(path, encoding='utf-8', errors='replace') as f:
        for line in f:
            line = line.strip()
            if line.startswith('[') and line.endswith(']'):
                cur = line[1:-1]; out.setdefault(cur, {})
            elif cur and '=' in line and not line.startswith('//'):
                k, v = line.split('=', 1)
                out[cur][k.strip()] = v.strip()
    return out

if __name__ == '__main__':
    base = 'war3_extracted/Units'
    tables = {}
    for name in ['UnitData', 'UnitBalance', 'unitUI', 'UnitWeapons', 'UnitAbilities', 'ItemData', 'AbilityData']:
        p = os.path.join(base, name + '.slk')
        if os.path.exists(p):
            tables[name] = parse_slk(p)
            print('%-14s %5d rows, %d fields' % (name, len(tables[name]),
                  len(tables[name][0]) if tables[name] else 0))
    # merge unit tables on their id column
    def idof(rec):
        for k in ('unitID', 'unitBalanceID', 'unitUIID', 'unitWeapID', 'unitAbilID'):
            if k in rec: return str(rec[k])
        return None
    units = collections.defaultdict(dict)
    for tname in ['UnitData', 'UnitBalance', 'unitUI', 'UnitWeapons', 'UnitAbilities']:
        for rec in tables.get(tname, []):
            uid = idof(rec)
            if uid: units[uid].update(rec)
    # names / art from the *Func / *Strings profiles
    prof = {}
    for f in os.listdir(base):
        if f.endswith('Func.txt') or f.endswith('Strings.txt'):
            for k, v in parse_profile(os.path.join(base, f)).items():
                prof.setdefault(k, {}).update(v)
    for uid, rec in units.items():
        if uid in prof:
            p = prof[uid]
            if 'Name' in p: rec['_name'] = p['Name']
            if 'model' in p: rec['_model'] = p['model']
            if 'Art' in p: rec['_icon'] = p['Art']
    os.makedirs('data', exist_ok=True)
    json.dump(units, open('data/blz_units.json', 'w'))
    json.dump(tables.get('AbilityData', []), open('data/blz_abilities.json', 'w'))
    json.dump(tables.get('ItemData', []), open('data/blz_items.json', 'w'))
    print('\nmerged %d Blizzard unit types -> data/blz_units.json' % len(units))
    creeps = [u for u, r in units.items() if str(r.get('race', '')).lower() == 'creeps']
    print('creep-race unit types: %d' % len(creeps))
    lv = collections.Counter(int(str(r.get("level",0)).replace("-","0") or 0) for u, r in units.items()
                             if str(r.get('race','')).lower() == 'creeps')
    print('creeps by level:', dict(sorted(lv.items())))
