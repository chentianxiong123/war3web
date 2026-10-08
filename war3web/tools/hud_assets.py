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
overrides = {obj['id']: obj for obj in objects['base'] + objects['custom']}
# Every ability in the archives gets a layout, not only the ones the map's own object data
# overrides. The loop below originally walked `objects` alone, which is right for a hero map
# -- every ability a card shows is one the map overrode -- and empty here: Terenas' .w3x
# declares no abilities of its own, so `out['abilities']` came out with nothing in it and
# every card fell back to laying its buttons out by index. Buttonpos is AbilityFunc's own
# field, so the map's overrides are laid on top of the base where they exist and the base is
# used everywhere else.
for aid, base in defaults.items():
    obj = overrides.get(aid) or {}
    mods = obj.get('mods') or {}
    def point(field, x, y, base=base, mods=mods):
        pair = base.get(field, '0,0').split(',')
        return [int(mods.get(x + ':0', pair[0])), int(mods.get(y + ':0', pair[-1]))]
    out['abilities'][aid] = {
        'button': point('buttonpos', 'abpx', 'abpy'),
        'research': point('researchbuttonpos', 'arpx', 'arpy'),
        'researchHotkey': str(S(mods.get('arhk:0', base.get('researchhotkey', '')))),
    }

# The ability's own text, in the archives' language. It lives in Units\*AbilityStrings.txt,
# one file per race, and in the retail archives it is the Chinese localisation -- these are
# the names and tooltips the game itself shows. Absent these, every card button would label
# itself with its raw ability id (Ahrp, Ahar), which is what a player sees when the data is
# missing. The `Unart` field rides along because it is the same button unlit.
strings = {}
for key, name in gd.listfile().items():
    if not key.startswith('units\\') or not key.endswith('abilitystrings.txt'):
        continue
    raw, _ = gd.read(name)
    current = None
    for line in (raw or b'').decode('utf-8', 'replace').splitlines():
        line = line.strip()
        if line.startswith('[') and line.endswith(']'):
            current = strings.setdefault(line[1:-1], {})
        elif current is not None and '=' in line and not line.startswith('//'):
            k, v = line.split('=', 1)
            current[k.lower()] = v.strip('"')
for aid, kv in strings.items():
    row = {}
    for src, dst in (('name', 'name'), ('tip', 'tip'), ('ubertip', 'tip'),
                     ('untip', 'untip'), ('unubertip', 'unubertip'), ('hotkey', 'hotkey')):
        if kv.get(src):
            row[dst] = str(S(kv[src]))
    if row:
        out.setdefault('strings', {})[aid] = row
for aid, base in defaults.items():
    if base.get('art') and not out.get('strings', {}).get(aid, {}).get('art'):
        out.setdefault('strings', {}).setdefault(aid, {})['art'] = base['art']
    if base.get('unart'):
        out.setdefault('strings', {}).setdefault(aid, {})['unart'] = base['unart']
Path('public/data/hud.json').write_text(json.dumps(out, indent=1, ensure_ascii=False))
print('HUD: %d textures, %d ability layouts, %d ability strings'
      % (len(names), len(out['abilities']), len(out.get('strings', {}))))
