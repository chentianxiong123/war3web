"""Pull Warcraft III's own interface art and layout out of the archives.

tools/extract_blizzard.py takes what the *map* names, and a map never names the
interface: Warcraft III draws the console, the command card, the selection
circles and the bars itself, so nothing in war3map.j mentions them. That left
the one part of the game's art the pipeline had no reason to fetch -- and it is
the part that makes the screen look like Warcraft III.

Both halves are in there. The art is ordinary BLP; the *layout* is `.fdf`, a
text format that carries real coordinates:

    Texture {
        File "ConsoleTexture01",
        Width 0.256, Height 0.032,
        TexCoord 0, 1, 0, 0.125,
        Anchor TOPLEFT, 0, 0,
    }

so the console can be rebuilt from the game's own numbers rather than measured
off a screenshot. `File` names a skin alias, which UI\\war3skins.txt resolves
per race -- Human is the default, and this map's units are all race human.

Models are deliberately skipped. Several of these pieces ship as .mdx as well
(HumanUI.mdx, HpBarConsole.mdl), which is how Warcraft III animates them, but
what we need is the flat art the same skin file names alongside them
(SimpleHpBarConsole=...human-healthbar-fill.blp). Pulling the models would put
interface geometry through mdx2gltf for nothing.

Everything lands in war3_extracted/, so convert_textures.py picks the art up on
its next run with no change, and stage.py stages it.

    python3 tools/extract_ui.py
"""
import os, sys, collections
sys.path.insert(0, os.path.dirname(__file__))
from gamedata import GameData

OUT = 'war3_extracted'
KEEP = ('.blp', '.tga', '.fdf', '.toc', '.txt', '.ttf')

TREES = [
    'ui\\console\\',                    # the console bar itself, per race
    'ui\\widgets\\console\\',           # command buttons, borders, hero glow
    'ui\\feedback\\',                   # hp/mana/xp bar fills, resource icons
    'ui\\framedef\\',                   # the layout: what goes where, in .fdf
    'ui\\minimap\\',                    # minimap frame and unit icons
    'ui\\cursor\\',                     # the mouse pointer
    'replaceabletextures\\selection\\', # SelectionCircle small/med/large
    # The game's own typefaces. UI\war3skins.txt names one per role and they
    # are all FRIZQT__.TTF -- including TextTagFont, which is what the floating
    # text is set in. Drawing that text in a substitute is the difference
    # between "Warcraft III" and "a web page about Warcraft III".
    'fonts\\',
]

gd = GameData()
LIST = gd.listfile()

saved, missing = 0, 0
sources = collections.Counter()
per_tree = collections.Counter()
for key, name in sorted(LIST.items()):
    tree = next((t for t in TREES if key.startswith(t)), None)
    if not tree or not key.endswith(KEEP):
        continue
    data, src = gd.read(name)
    if data is None:
        missing += 1
        continue
    dst = os.path.join(OUT, name.replace('\\', os.sep))
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    open(dst, 'wb').write(data)
    saved += 1
    sources[src] += 1
    per_tree[tree] += 1

for t in TREES:
    print('  %-34s %4d' % (t, per_tree[t]))
print('interface files: %d saved, %d named by the listfile but not readable' % (saved, missing))
print('from:', dict(sources))
