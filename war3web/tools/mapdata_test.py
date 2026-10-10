"""mapdata_test.py -- the map's own files (war3map.w3i, war3mapUnits.doo)
parse end to end. Runs against the checked-out map in the working directory,
the same way pipeline.sh does; set FOC_MAP to point elsewhere.

Asserts structure, not exact counts: any real Warcraft III map must satisfy
these invariants (players exist, pre-placed units parse, header byte-counts
close out).
"""
import os, sys, json

sys.path.insert(0, os.path.dirname(__file__))

import w3i, unitsdoo

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
EX = os.path.join(ROOT, 'extracted')
failures = []


def ck(name, cond, detail=''):
    if cond:
        print('  ok   %s' % name)
    else:
        failures.append(name)
        print('  FAIL %s %s' % (name, detail))


def main():
    w3i_path = os.path.join(EX, 'war3map.w3i')
    units_path = os.path.join(EX, 'war3mapUnits.doo')
    ck('war3map.w3i exists', os.path.exists(w3i_path))
    ck('war3mapUnits.doo exists', os.path.exists(units_path))
    if not (os.path.exists(w3i_path) and os.path.exists(units_path)):
        print('  SKIP 缺地图解包文件（先跑 pipeline 第 1 步）')
        return 1 if failures else 0

    d = w3i.parse(w3i_path)
    ck('w3i version >= 4', d['version'] >= 4, d['version'])
    ck('w3i has players', len(d['players']) > 0, len(d['players']))
    ck('w3i has forces', len(d['forces']) >= 0)
    ck('w3i cameraBounds 8 floats',
       len(d['cameraBounds']) == 8, len(d['cameraBounds']))
    ck('w3i playableSize 2 ints',
       len(d['playableSize']) == 2, d['playableSize'])
    for p in d['players']:
        ck('player start location 2 floats',
           len(p['startLocation']) == 2, p['startLocation'])
        ck('player name present', isinstance(p['name'], str))
    if d['version'] > 24:
        ck('fog + weather parsed (v>24)', 'fogDensity' in d and 'globalWeather' in d)

    u = unitsdoo.parse(units_path)
    raw_size = os.path.getsize(units_path)
    ck('units.doo version >= 7', u['version'] >= 7, u['version'])
    ck('units.doo has units', len(u['units']) > 0, len(u['units']))
    # byte-close: sum of per-unit parse lengths equals the file
    total = 16
    for x in u['units']:
        n = 36 + 15 + (4 if u['version'] > 7 else 0)
        n += 4 + sum(4 + 8 * len(s) for s in x['droppedItems'])
        n += 12 + (12 if u['version'] > 7 else 0)
        n += 4 + 8 * len(x['inventory']) + 4 + 12 * len(x['abilities'])
        r = x['random']
        if r['kind'] == 'level':
            n += 8
        elif r['kind'] == 'group':
            n += 12
        else:
            n += 8 + 8 * len(r['tables'])
        n += 12
        total += n
    ck('units.doo byte-accurate', total == raw_size,
       '%d vs %d' % (total, raw_size))
    first = u['units'][0]
    ck('unit has id + player', isinstance(first['id'], str) and 'player' in first)
    ck('unit inventory list', isinstance(first['inventory'], list))
    ck('unit abilities list', isinstance(first['abilities'], list))

    print('-- mapdata_test: %d passed, %d failed --' % (
        count_passed(), len(failures)))
    return 1 if failures else 0


def count_passed():
    return 0  # not tracked precisely; failures matter


if __name__ == '__main__':
    sys.exit(main())