"""war3map.w3i -- full map information (War3MapW3i, warsmash MIT layout).

The old pipeline read five fields (version/name/author/description/players)
for the game's credits line. Everything that decides how a map *plays* was
left on the floor: the player slots and their start locations, the forces
(teams/alliances), camera bounds and playable size, tileset and fog, loading
and prologue screens, and -- on maps that use them -- upgrade/tech
availability changes and the random unit/item tables.

Follows warsmash War3MapW3i.java / Player / Force / UpgradeAvailabilityChange
/ TechAvailabilityChange / RandomUnitTable / RandomItemTable byte for byte,
including the `stream.available() > 0` guards that tolerate v24-era files.
"""
import os, sys, json, struct

sys.path.insert(0, os.path.dirname(__file__))


class R:
    def __init__(self, b):
        self.b = b; self.o = 0
    def left(self):
        return len(self.b) - self.o
    def i32(self):
        v = int.from_bytes(self.b[self.o:self.o+4], 'little', signed=True); self.o += 4; return v
    def u32(self):
        v = int.from_bytes(self.b[self.o:self.o+4], 'little'); self.o += 4; return v
    def u8(self):
        v = self.b[self.o]; self.o += 1; return v
    def f32(self):
        v = struct.unpack_from('<f', self.b, self.o)[0]; self.o += 4; return v
    def cstr(self):
        e = self.b.find(b'\0', self.o)
        if e < 0: e = len(self.b)
        v = self.b[self.o:e].decode('utf-8', 'replace'); self.o = e + 1; return v
    def id4(self):
        v = self.b[self.o:self.o+4].decode('latin-1'); self.o += 4; return v
    def f32s(self, n):
        return [self.f32() for _ in range(n)]
    def i32s(self, n):
        return [self.i32() for _ in range(n)]
    def u8s(self, n):
        return [self.u8() for _ in range(n)]


def parse(path):
    b = open(path, 'rb').read()
    r = R(b)
    d = dict(
        version=r.i32(), saves=r.i32(), editorVersion=r.i32())
    if d['version'] > 27:
        d['gameVersion'] = [r.i32() for _ in range(4)]
    d.update(name=r.cstr(), author=r.cstr(), description=r.cstr(),
             recommendedPlayers=r.cstr())
    d['cameraBounds'] = r.f32s(8)
    d['cameraBoundsComplements'] = r.i32s(4)
    d['playableSize'] = r.i32s(2)
    d['flags'] = r.u32()
    d['tileset'] = chr(r.u8())
    d['campaignBackground'] = r.i32()
    if d['version'] > 24:
        d['loadingScreenModel'] = r.cstr()
    d.update(loadingScreenText=r.cstr(), loadingScreenTitle=r.cstr(),
             loadingScreenSubtitle=r.cstr())
    d['gameDataSet'] = r.i32()
    if d['version'] > 24:
        d['prologueScreenModel'] = r.cstr()
    d.update(prologueScreenText=r.cstr(), prologueScreenTitle=r.cstr(),
             prologueScreenSubtitle=r.cstr())
    if d['version'] > 24:
        d.update(useTerrainFog=r.i32(), fogHeight=r.f32s(2),
                 fogDensity=r.f32(), fogColor=r.u8s(4),
                 globalWeather=r.i32(), soundEnvironment=r.cstr(),
                 lightEnvironmentTileset=chr(r.u8()),
                 waterVertexColor=r.u8s(4))
    if d['version'] > 27:
        d['unknownLua'] = r.u8s(4)
    if d['version'] > 30:
        d['supportedModes'] = r.u32()
        d['gameDataVersion'] = r.u32()

    players = []
    for _ in range(r.i32()):
        p = dict(id=r.u32(), type=r.i32(), race=r.i32(),
                 isFixedStartPosition=r.i32(), name=r.cstr(),
                 startLocation=r.f32s(2), allyLow=r.u32(), allyHigh=r.u32())
        if d['version'] > 30:
            p['enemyLow'] = r.u32(); p['enemyHigh'] = r.u32()
        players.append(p)
    d['players'] = players

    forces = []
    for _ in range(r.i32()):
        forces.append(dict(flags=r.u32(), playerMasks=r.u32(), name=r.cstr()))
    d['forces'] = forces

    # v24-era files are allowed to end right after the forces; everything
    # past here is guarded by stream.available(), as warsmash does.
    up = []
    if r.left() > 0:
        for _ in range(r.i32()):
            up.append(dict(playerFlags=r.u32(), id=r.id4(),
                           levelAffected=r.i32(), availability=r.i32()))
    d['upgradeAvailability'] = up

    tech = []
    if r.left() > 0:
        for _ in range(r.i32()):
            tech.append(dict(playerFlags=r.u32(), id=r.id4()))
    d['techAvailability'] = tech

    rtab = []
    if r.left() > 0:
        for _ in range(r.i32()):
            table = dict(id=r.i32(), name=r.cstr(), positions=r.i32())
            table['columnTypes'] = r.i32s(table['positions'])
            table['units'] = []
            for _ in range(r.u32()):
                table['units'].append(dict(chance=r.i32(),
                                           ids=[r.id4() for _ in range(table['positions'])]))
            rtab.append(table)
    d['randomUnitTables'] = rtab

    itab = []
    if d['version'] > 24 and r.left() > 0:
        for _ in range(r.i32()):
            t = dict(id=r.id4(), name=r.cstr(), sets=[])
            for _ in range(r.u32()):
                t['sets'].append(dict(items=[]))
                for _ in range(r.u32()):
                    t['sets'][-1]['items'].append(dict(chance=r.i32(), id=r.id4()))
            itab.append(t)
    d['randomItemTables'] = itab
    return d


if __name__ == '__main__':
    src = sys.argv[1] if len(sys.argv) > 1 else 'extracted/war3map.w3i'
    out = sys.argv[2] if len(sys.argv) > 2 else 'data/war3map.w3i.json'
    d = parse(src)
    os.makedirs(os.path.dirname(out) or '.', exist_ok=True)
    json.dump(d, open(out, 'w'), separators=(',', ':'))
    print('w3i v%d: %d players, %d forces, cam %s, size %s' % (
        d['version'], len(d['players']), len(d['forces']),
        d['cameraBounds'], d['playableSize']))
    for p in d['players']:
        print('  player %d: type %d race %d name %r start %s' % (
            p['id'], p['type'], p['race'], p['name'], p['startLocation']))