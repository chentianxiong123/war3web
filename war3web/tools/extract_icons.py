"""Extract the button art in full, rather than only the buttons something happens to name.

Warcraft III's command-card icons live in two trees the object tables merely point at:

    ReplaceableTextures\\CommandButtons\\      the cast/train buttons, 1092 files
    ReplaceableTextures\\PassiveButtons\\      the passive-skill buttons, 58 files
    ReplaceableTextures\\CommandButtonsDisabled\\  the same art, greyed, 1149 files

The pipeline already had most of this art and did not extract all of it, because
extract_blizzard.py works the other way round: it walks the ability and unit tables and
harvests the art slots it finds in them. That is the right rule for a *model* -- one map's
tables reference what that map draws -- and the wrong one for icons. A button belongs to an
ability whether or not the tables are read for it, and the tables name only a fraction: of
the 839 unit types in the archives, 693 named a button that was never pulled, so every one of
those units drew with no icon at all. The art was in the archives the whole time. This
extracts the trees outright.

CommandButtonsDisabled is Warcraft III's own dimmed copy of the same button, used when the
command is not available. It is extracted too, and disabled art is preferred over the lit
one only when the client says the command cannot be used right now.

Nothing here converts anything -- the files land in war3_extracted/ and convert_textures.py
picks them up on its next run, exactly as extract_ui.py's interface art does.

    python3 tools/extract_icons.py
"""
import collections
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from gamedata import GameData

OUT = 'war3_extracted'
KEEP = ('.blp', '.tga')
TREES = [
    'replaceabletextures\\commandbuttons\\',
    'replaceabletextures\\passivebuttons\\',
    'replaceabletextures\\commandbuttonsdisabled\\',
]

gd = GameData()
LIST = gd.listfile()

saved, missing = 0, 0
sources = collections.Counter()
per_tree = collections.Counter()
for key, name in sorted(LIST.items()):
    tree = next((t for t in TREES if key.lower().startswith(t)), None)
    if not tree or not key.lower().endswith(KEEP):
        continue
    data, src = gd.read(name)
    if data is None:
        missing += 1
        continue
    dst = os.path.join(OUT, name.replace('\\', os.sep))
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(dst, 'wb') as fh:
        fh.write(data)
    saved += 1
    sources[src] += 1
    per_tree[tree] += 1

for t in TREES:
    print('  %-52s %4d' % (t, per_tree[t]))
print('button art: %d saved, %d named by the listfile but not readable' % (saved, missing))
print('from:', dict(sources))