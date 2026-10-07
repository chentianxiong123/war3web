"""Stage Classic HUD art and ability button coordinates from the retail/map data."""
import json
from pathlib import Path
from PIL import Image
from gamedata import GameData
from blp import decode
from wts import S

gd = GameData()
names = {key: 'ReplaceableTextures\\CommandButtons\\BTN' + name + '.blp'
         for key, name in dict(move='Move', stop='Stop', hold='HoldPosition',
                               attack='Attack', patrol='Patrol', skill='Skillz', cancel='Cancel').items()}
for key in ('str', 'agi', 'int'):
    names[key] = 'UI\\Widgets\\Console\\Human\\infocard-heroattributes-' + key + '.blp'
for key in ('background', 'border'):
    names['tooltip_' + key] = 'UI\\Widgets\\ToolTips\\Human\\human-tooltip-' + key + '.blp'

out = {'art': {}, 'abilities': {}}
for key, name in names.items():
    data, _ = gd.read(name)
    if data is None:
        raise RuntimeError('Missing HUD asset: ' + name)
    dest = Path('public/assets/ui') / (key + '.png')
    dest.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(decode(data), 'RGBA').save(dest)
    out['art'][key] = '/assets/ui/' + dest.name

# UI fields live in AbilityFunc, independently of the numeric AbilityData SLK.
defaults = {}
for key, name in gd.listfile().items():
    if not key.startswith('units\\') or not key.endswith('abilityfunc.txt'):
        continue
    raw, _ = gd.read(name)
    current = None
    for line in (raw or b'').decode('utf-8', 'replace').splitlines():
        line = line.strip()
        if line.startswith('[') and line.endswith(']'):
            current = defaults.setdefault(line[1:-1], {})
        elif current is not None and '=' in line and not line.startswith('//'):
            k, v = line.split('=', 1)
            current[k.lower()] = v.strip('"')

objects = json.loads(Path('data/war3map.w3a.json').read_text())
for obj in objects['base'] + objects['custom']:
    base = defaults.get(obj['origin'], {})
    mods = obj['mods']
    def point(field, x, y):
        pair = base.get(field, '0,0').split(',')
        return [int(mods.get(x + ':0', pair[0])), int(mods.get(y + ':0', pair[-1]))]
    out['abilities'][obj['id']] = {
        'button': point('buttonpos', 'abpx', 'abpy'),
        'research': point('researchbuttonpos', 'arpx', 'arpy'),
        'researchHotkey': str(S(mods.get('arhk:0', base.get('researchhotkey', '')))),
    }
Path('public/data/hud.json').write_text(json.dumps(out, indent=1))
print('HUD: %d textures, %d ability layouts' % (len(names), len(out['abilities'])))
