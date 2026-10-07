"""Warcraft III gameplay constants for custom games (Custom_V1\\Units\\MiscGame.txt),
plus the engine's own floating-text settings (UI\\MiscData.txt).

The second file is what the engine prints for itself rather than what a map
prints with a text tag: the bounty gold over a body, the gold and lumber a
harvester carries in, "miss", and the crit/bash/mana-burn numbers. Each is a
colour, a velocity, a lifetime and a fade start, in exactly the units
SetTextTagColor / SetTextTagVelocity / SetTextTagLifespan / SetTextTagFadepoint
take -- so they can be handed to the same machinery the map's own tags use.
"""
import os, sys, json, re
sys.path.insert(0, os.path.dirname(__file__))
from gamedata import GameData

gd = GameData()
data = None
for p in ['Custom_V1\\Units\\MiscGame.txt', 'Custom_V0\\Units\\MiscGame.txt',
          'Units\\MiscGame.txt']:
    d, src = gd.read(p)
    if d:
        data = d.decode('latin-1'); source = '%s (%s)' % (p, src); break
if data is None:
    raise SystemExit('MiscGame.txt not found in the archives')

def parse_misc(text, into):
    for line in text.replace('\r\n', '\n').split('\n'):
        line = line.strip()
        if not line or line.startswith('//') or '=' not in line:
            continue
        k, v = line.split('=', 1)
        into[k.strip()] = v.split('//')[0].strip()
    return into


cfg = parse_misc(data, {})

# The map ships its own gameplay constants (war3mapMisc.txt) and they win over
# anything in the archives -- this map raises MaxHeroLevel to 50 and rewrites
# every hero stat bonus, so reading only the Blizzard tables gets them all wrong.
MAP_MISC = 'extracted/war3mapMisc.txt'
overrides = {}
if os.path.exists(MAP_MISC):
    parse_misc(open(MAP_MISC, encoding='latin-1').read(), overrides)
    changed = {k: (cfg.get(k), v) for k, v in overrides.items() if cfg.get(k) != v}
    cfg.update(overrides)
    source += ' + %s (%d overrides)' % (MAP_MISC, len(overrides))
    print('map gameplay overrides (%d):' % len(changed))
    for k in sorted(changed):
        was, now = changed[k]
        print('   %-22s %s -> %s' % (k, was, now))

# "Damage bonus lists: SMALL, MEDIUM, LARGE, FORT, NORMAL, HERO, DIVINE, NONE"
ARMOR_ORDER = ['small', 'medium', 'large', 'fort', 'normal', 'hero', 'divine', 'none']
ATTACK_TYPES = ['normal', 'pierce', 'siege', 'magic', 'chaos', 'spells', 'hero']
table = {}
for at in ATTACK_TYPES:
    raw = cfg.get('DamageBonus' + at.capitalize())
    if not raw:
        continue
    vals = [float(x) for x in raw.split(',')]
    table[at] = {ARMOR_ORDER[i]: vals[i] for i in range(min(len(vals), len(ARMOR_ORDER)))}

def curve(seed_key, prefix, seed_default, n=100):
    """MiscGame.txt documents these tables as f(x) = A*f(x-1) + B*x + C, seeded
    with the matching base entry.  Verified against GrantNormalXP, which
    reproduces Warcraft III's creep experience table exactly."""
    seed = cfg.get(seed_key, seed_default)
    # a few entries ship as an explicit comma list for the first levels
    vals = [float(x) for x in str(seed).split(',')] if ',' in str(seed) else [float(seed)]
    A = num(prefix + 'FormulaA', 1.0)
    B = num(prefix + 'FormulaB', 0.0)
    C = num(prefix + 'FormulaC', 0.0)
    while len(vals) < n:
        x = len(vals) + 1
        vals.append(A * vals[-1] + B * x + C)
    return [round(v, 3) for v in vals]


def num(k, d):
    try: return float(cfg.get(k, d))
    except (TypeError, ValueError): return d

# experience: how much a level costs, and what a kill grants
needHeroXP = curve('NeedHeroXP', 'NeedHeroXP', 200)
grantHeroXP = curve('GrantHeroXP', 'GrantHeroXP', 100)
grantNormalXP = curve('GrantNormalXP', 'GrantNormalXP', 25)

out = dict(
    source=source,
    damageBonus=table,
    armorOrder=ARMOR_ORDER,
    defenseArmor=num('DefenseArmor', 0.06),
    # A creep that strays 'GuardDistance' from where it spawned starts thinking
    # about going home; past 'MaxGuardDistance' it always does.
    guardDistance=num('GuardDistance', 600),
    maxGuardDistance=num('MaxGuardDistance', 1000),
    guardReturnTime=num('GuardReturnTime', 5),
    callForHelp=num('CallForHelp', 600),
    creepCallForHelp=num('CreepCallForHelp', 600),
    etherealDamageBonus=[float(x) for x in cfg.get('EtherealDamageBonus', '0,0,0,1.66,0,1.66,0').split(',')],
    heroReviveBase=num('HeroReviveBase', 0),
    heroReviveLevelFactor=num('HeroReviveLevelFactor', 0),
    heroReviveTimeBase=num('HeroReviveTimeBase', 0),
    heroReviveTimeFactor=num('HeroReviveTimeFactor', 0),
    strAttackBonus=num('StrAttackBonus', 1),
    strHitPointBonus=num('StrHitPointBonus', 19),
    strRegenBonus=num('StrRegenBonus', 0.05),
    agiDefenseBonus=num('AgiDefenseBonus', 0.14),
    agiAttackSpeedBonus=num('AgiAttackSpeedBonus', 0.02),
    intManaBonus=num('IntManaBonus', 15),
    intRegenBonus=num('IntRegenBonus', 0.05),
    needHeroXP=needHeroXP,
    grantHeroXP=grantHeroXP,
    grantNormalXP=grantNormalXP,
    heroExpRange=num('HeroExpRange', 1200),
    maxHeroLevel=int(num('MaxHeroLevel', 10)),
    maxUnitLevel=int(num('MaxUnitLevel', 20)),
    heroAbilityLevelSkip=int(num('HeroAbilityLevelSkip', 2)),
    globalExperience=int(num('GlobalExperience', 0)),
    buildingKillsGiveExp=int(num('BuildingKillsGiveExp', 0)),
    summonedKillFactor=num('SummonedKillFactor', 0.5),
    heroFactorXP=[float(x) for x in str(cfg.get('HeroFactorXP', '80,70,60,50,0')).split(',')],
    minUnitSpeed=num('MinUnitSpeed', 150),
    maxUnitSpeed=num('MaxUnitSpeed', 400),
    agiDefenseBase=num('AgiDefenseBase', -2),
    missDamageReduction=num('MissDamageReduction', 0.5),
    chanceToMiss=num('ChanceToMiss', 0),
    agiMoveBonus=num('AgiMoveBonus', 0),
    # A corpse's three ages: the death animation runs for the unit's own
    # `death` time, then Decay Flesh for DecayTime, then the bones linger for
    # BoneDecayTime. Blizzard's defaults are 2 and 88; this map overrides the
    # bone time to 6, which is why its corpses clear quickly.
    boneDecayTime=num('BoneDecayTime', 88),
    decayTime=num('DecayTime', 2),
    structureDecayTime=num('StructureDecayTime', 30),
    pawnItemRate=num('PawnItemRate', 0.5),
)
# ---------------------------------------------------------------- text tags
# UI\MiscData.txt, the engine's own text tags. Colours are listed A,R,G,B --
# alpha first -- while SetTextTagColor takes R,G,B,A, so they are reordered
# here rather than at the point of use. Velocity is listed x,y and then a third
# figure that is 100 for every one of the eight, so it separates nothing and is
# carried through untouched rather than guessed at.
misc_ui, ui_src = gd.read('UI\\MiscData.txt')
textTags = {}
if misc_ui:
    ui = parse_misc(misc_ui.decode('latin-1'), {})
    for key in ['Gold', 'Lumber', 'Bounty', 'Miss', 'CriticalStrike',
                'ShadowStrike', 'ManaBurn', 'Bash']:
        col = ui.get(key + 'TextColor')
        vel = ui.get(key + 'TextVelocity')
        if not col or not vel:
            continue
        a, r, g, bl = [int(x) for x in col.split(',')[:4]]
        v = [float(x) for x in vel.split(',')]
        textTags[key[0].lower() + key[1:]] = {
            'color': [r, g, bl, a],
            'vx': v[0], 'vy': v[1],
            'life': float(ui.get(key + 'TextLifetime', 0)),
            'fade': float(ui.get(key + 'TextFadeStart', 0)),
        }
    source += ' + UI\\MiscData.txt (%s, %d text tags)' % (ui_src, len(textTags))

# The word the engine prints for a miss is localisable and lives with the rest
# of the interface strings, so it is read rather than spelled out here.
gs, gs_src = gd.read('UI\\FrameDef\\GlobalStrings.fdf')
if gs and 'miss' in textTags:
    m = re.search(r'^\s*MISS\s+"([^"]*)"', gs.decode('latin-1'), re.M)
    if m:
        textTags['miss']['text'] = m.group(1)
        source += ' + GlobalStrings.fdf (%s)' % gs_src
out['textTags'] = textTags

# ---------------------------------------------------------------- the music
#
# SetMapMusic("Music", true, 0) is what this map asks for, twice, and nothing
# played.  "Music" is not a row in any of the SoundInfo tables -- it names the
# standard playlist, which Warcraft III keeps in UI\WorldEditData.txt under
# [MusicFiles] and which is what the World Editor's own music dropdown lists.
# The list is carried here so the engine can resolve the label without reading
# a UI file at runtime; the paths go through the same sound index every other
# sound does, so a track the archives did not supply simply is not listed.
wed, wed_src = gd.read('UI\\WorldEditData.txt')
music = []
if wed:
    txt = wed.decode('latin-1')
    sect = re.search(r'^\[MusicFiles\]\s*$(.*?)^\[', txt, re.M | re.S)
    if sect:
        for line in sect.group(1).splitlines():
            m = re.match(r'\s*(\d+)\s*=\s*([^,\r\n]+)', line)
            if m and not line.strip().startswith('//'):
                music.append(m.group(2).strip())
out['music'] = music

os.makedirs('data', exist_ok=True)
json.dump(out, open('data/gameplay.json', 'w'), indent=1)
print('  music playlist: %d tracks from UI\\WorldEditData.txt [MusicFiles]' % len(music))
print('gameplay constants from %s' % source)
for k, v in textTags.items():
    print('   %-16s rgba=%s vel=%s,%s life=%s fade=%s'
          % (k, v['color'], v['vx'], v['vy'], v['life'], v['fade']))
print('  damage table: %d attack types x %d armor types' % (len(table), len(ARMOR_ORDER)))
for at in ATTACK_TYPES:
    if at in table:
        print('    %-7s %s' % (at, ' '.join('%s=%.2f' % (a[:4], table[at][a]) for a in ARMOR_ORDER)))
print('  hero stat bonuses: STR hp=%.0f atk=%.0f  AGI def=%.2f as=%.3f  INT mana=%.0f'
      % (out['strHitPointBonus'], out['strAttackBonus'], out['agiDefenseBonus'],
         out['agiAttackSpeedBonus'], out['intManaBonus']))
