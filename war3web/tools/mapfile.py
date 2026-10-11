"""Locate the Warcraft III map this pipeline should build.

Resolution order:
  1. $WAR3_MAP
  2. the only .w3x/.w3m in the working directory
  3. the most recently modified one, reported explicitly
"""
import os, glob, sys


def find_map(explicit=None):
    if explicit:
        if not os.path.exists(explicit):
            raise SystemExit('map not found: %s' % explicit)
        return explicit
    env = os.environ.get('WAR3_MAP')
    if env:
        if not os.path.exists(env):
            raise SystemExit('WAR3_MAP does not exist: %s' % env)
        return env
    maps = sorted(glob.glob('*.w3x') + glob.glob('*.w3m'),
                  key=os.path.getmtime, reverse=True)
    if not maps:
        raise SystemExit('no .w3x/.w3m in the working directory; set WAR3_MAP')
    if len(maps) > 1:
        print('note: %d maps present, using the newest: %s  (set WAR3_MAP to override)'
              % (len(maps), maps[0]), file=sys.stderr)
    return maps[0]


MAP = find_map(sys.argv[1] if len(sys.argv) > 1 and sys.argv[1].endswith(('.w3x', '.w3m')) else None)

if __name__ == '__main__':
    print(MAP)
