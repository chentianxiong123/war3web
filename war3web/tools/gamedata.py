"""Layered Warcraft III archive access.

Warcraft III resolves a file against its archives in priority order, with the
patch overriding the expansion, which overrides the base game.
"""
import os, sys
sys.path.insert(0, os.path.dirname(__file__))
from mpq import MPQ

# highest priority first; the *local* archives hold audio and localised text
ORDER = ['War3Patch.mpq', 'War3xlocal.mpq', 'War3x.mpq', 'War3local.mpq', 'war3.mpq']

class GameData:
    def __init__(self, root='.'):
        self.archives = []
        for name in ORDER:
            p = os.path.join(root, name)
            if os.path.exists(p):
                self.archives.append((name, MPQ(p)))
        if not self.archives:
            raise SystemExit('no Warcraft III archives found')

    def read(self, path):
        for name, m in self.archives:
            try:
                d = m.read(path)
            except Exception:
                d = None
            if d is not None:
                return d, name
        return None, None

    def listfile(self):
        """Union of every archive's listfile, plus names only some archives declare."""
        names = {}
        for name, m in self.archives:
            lf = m.read('(listfile)')
            if not lf:
                continue
            for line in lf.decode('latin-1').replace('\r\n', '\n').split('\n'):
                line = line.strip()
                if line:
                    names.setdefault(line.lower().replace('/', '\\'), line)
        return names

    def which(self, path):
        for name, m in self.archives:
            if m.find(path) is not None:
                return name
        return None

if __name__ == '__main__':
    gd = GameData()
    print('archives:', ', '.join(n for n, _ in gd.archives))
    lf = gd.listfile()
    print('union listfile entries:', len(lf))
    for n in ['Scripts\\common.j', 'Scripts\\Blizzard.j', 'Units\\UnitData.slk',
              'Buildings\\Other\\Tavern\\Tavern.mdx', 'TerrainArt\\Dalaran\\Dalaran_WhiteMarble.blp']:
        d, src = gd.read(n)
        print('  %-52s %s' % (n, ('%7d bytes from %s' % (len(d), src)) if d else 'MISSING'))
