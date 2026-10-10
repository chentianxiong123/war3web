"""war3mapUnits.doo -- the map's pre-placed units (PlacedUnitList/W3do).

This is the file every map author's placed units, items, heroes and their
per-instance state live in: who owns the unit, how much HP/mana it has, its
inventory, hero level and stats, per-instance ability levels and autocast,
dropped-item tables and random unit tables.

The engine previously ran on CreateUnit() regexes over war3map.j, which only
sees script-spawned units and only id/x/y/facing. Editor-placed units -- and
everything about any unit's instance state -- had no source at all.

Layout follows warsmash Unit.java (MIT, Etheller et al), byte for byte:
  magic 'W3do'  version int32  unknown uint32  count int32
  per unit: id4cc variation loc[3] angle scale[3]
            [skinId4cc if game version >= 1.32]
            flags u8 player int32 unknown u16 hp int32 mana int32
            [version>7: droppedItemTable int32]
            droppedSets  (count, each: count, each: id4cc chance)
            gold int32 targetAcq float heroLevel int32
            [version>7: heroStr/Agi/Int int32 x3]
            inventory (count, each: slot int32 id4cc)
            abilities (count, each: id4cc autocast int32 level int32)
            randomFlag int32
              | 0: level[3] u8 itemClass u8
              | 1: unitGroup u32 posInGroup u32
              | 2: randomTables (count, each: id4cc chance)
            customTeamColor int32 waygate int32 creationNumber int32
"""
import os, sys, json

sys.path.insert(0, os.path.dirname(__file__))


def parse(path):
    b = open(path, 'rb').read()
    assert b[:4] == b'W3do', 'not a placed-unit list: %r' % b[:4]
    o = 4
    def i32():
        nonlocal o
        v = int.from_bytes(b[o:o+4], 'little', signed=True); o += 4; return v
    def u32():
        nonlocal o
        v = int.from_bytes(b[o:o+4], 'little'); o += 4; return v
    def u16():
        nonlocal o
        v = int.from_bytes(b[o:o+2], 'little'); o += 2; return v
    def u8():
        nonlocal o
        v = b[o]; o += 1; return v
    def f32():
        nonlocal o
        v = struct_unpack_f(b[o:o+4]); o += 4; return v
    def id4():
        nonlocal o
        v = b[o:o+4].decode('latin-1'); o += 4; return v
    version = i32()
    unknown = u32()
    n = i32()
    units = []
    for _ in range(n):
        uid, variation = id4(), i32()
        loc = [f32(), f32(), f32()]
        angle, scale = f32(), [f32(), f32(), f32()]
        # skinId exists only for game version >= 1.32; the caller passes the
        # w3i game version here. terenas (w3i v25) predates it, so skip.
        flags = u8()
        player = i32()
        unk = u16()
        hp, mana = i32(), i32()
        dropped_item_table = i32() if version > 7 else 0
        dropped = []
        for _ in range(u32()):
            items = []
            for _ in range(u32()):
                items.append(dict(id=id4(), chance=i32()))
            dropped.append(items)
        gold = i32()
        target_acq = f32()
        hero_level = i32()
        stats = [i32(), i32(), i32()] if version > 7 else [None] * 3
        inv = []
        for _ in range(u32()):
            inv.append(dict(slot=i32(), id=id4()))
        abils = []
        for _ in range(u32()):
            abils.append(dict(id=id4(), autocast=i32(), level=i32()))
        rflag = i32()
        random = None
        if rflag == 0:
            random = dict(kind='level', level=[u8(), u8(), u8()], itemClass=u8())
        elif rflag == 1:
            random = dict(kind='group', unitGroup=u32(), positionInGroup=u32())
        elif rflag == 2:
            tbl = []
            for _ in range(u32()):
                tbl.append(dict(id=id4(), chance=i32()))
            random = dict(kind='tables', tables=tbl)
        units.append(dict(
            id=uid, variation=variation, x=loc[0], y=loc[1], z=loc[2],
            angle=round(angle, 5), scale=[round(v, 5) for v in scale],
            flags=flags, player=player, unknown=unk, hp=hp, mana=mana,
            droppedItemTable=dropped_item_table, droppedItems=dropped,
            gold=gold, targetAcquisition=round(target_acq, 5),
            heroLevel=hero_level,
            heroStr=stats[0], heroAgi=stats[1], heroInt=stats[2],
            inventory=inv, abilities=abils, randomFlag=rflag,
            random=random, customTeamColor=i32(), waygate=i32(),
            creationNumber=i32()))
    return dict(version=version, unknown=unknown, units=units)


def struct_unpack_f(raw):
    import struct
    return struct.unpack('<f', raw)[0]


if __name__ == '__main__':
    src = sys.argv[1] if len(sys.argv) > 1 else 'extracted/war3mapUnits.doo'
    out = sys.argv[2] if len(sys.argv) > 2 else 'data/war3map.units.json'
    data = parse(src)
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    json.dump(data, open(out, 'w'), separators=(',', ':'))
    print('%d pre-placed units, version %d -> %s' % (len(data['units']), data['version'], out))