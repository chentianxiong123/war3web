"""Unit sound sets: unit type -> the sound files Warcraft III plays for it.

unitUI.slk gives each unit a sound-set name; UnitAckSounds.slk expands
"<set><event>" into the actual files.
"""
import os, sys, json, collections
sys.path.insert(0, os.path.dirname(__file__))
from slk import parse_slk

BASE = 'war3_extracted'
ack = parse_slk(os.path.join(BASE, 'UI/SoundInfo/UnitAckSounds.slk'))
combat = parse_slk(os.path.join(BASE, 'UI/SoundInfo/UnitCombatSounds.slk'))
ui = parse_slk(os.path.join(BASE, 'Units/unitUI.slk'))
uisnd = parse_slk(os.path.join(BASE, 'UI/SoundInfo/UISounds.slk'))
have = json.load(open('assets/sounds.json')) if os.path.exists('assets/sounds.json') else {}

def entry_files(rec):
    base = str(rec.get('DirectoryBase', '') or '').replace('/', '\\')
    out = []
    for f in str(rec.get('FileNames', '') or '').split(','):
        f = f.strip()
        if not f: continue
        key = (base + f).replace('\\', '/').lower()
        web = have.get(key)
        if web: out.append(web)
    return out

sounds = {}
for rec in ack + combat:
    name = str(rec.get('SoundName') or '')
    if not name: continue
    files = entry_files(rec)
    if files:
        sounds[name] = dict(files=files,
                            vol=float(rec.get('Volume', 127) or 127) / 127.0,
                            pitch=float(rec.get('Pitch', 1) or 1))

EVENTS = ['Death', 'What', 'Yes', 'YesAttack', 'Pissed', 'Warcry', 'Ready', 'Wound']
types = json.load(open('data/unittypes.json'))
sets = collections.defaultdict(dict)

# Where each sound set's files live, taken from its UnitAckSounds rows.
SET_DIR = {}
for rec in ack:
    nm = str(rec.get('SoundName') or '')
    base = str(rec.get('DirectoryBase') or '').replace('/', '\\')
    for ev in ('What', 'Yes', 'YesAttack', 'Pissed', 'Warcry', 'Ready'):
        if nm.endswith(ev) and base:
            SET_DIR.setdefault(nm[:-len(ev)], base)
            break

# index the available audio by directory for name-pattern lookups
BY_DIR = collections.defaultdict(list)
for key, web in have.items():
    d, _, f = key.rpartition('/')
    BY_DIR[d + '/'].append((f, web))

def files_named(setname, event):
    """Death/Wound clips have no SLK row; Warcraft III resolves them by name
    within the sound set's own directory, and the naming varies
    (FootmanDeath, JainaOnFootDeath1, HeroArchMageDeath)."""
    base = SET_DIR.get(setname)
    if not base: return []
    d = base.replace('\\', '/').lower()
    ev = event.lower()
    out = [web for f, web in sorted(BY_DIR.get(d, [])) if ev in f]
    return out

def build_for(uid, setname, weapon):
    entry = sets[uid]
    if setname and setname != '-':
        for ev in EVENTS:
            s = sounds.get(setname + ev)
            if s: entry[ev.lower()] = s
        for ev in ('Death', 'Wound'):
            if ev.lower() in entry: continue
            f = files_named(setname, ev)
            if f: entry[ev.lower()] = dict(files=f, vol=1.0, pitch=1.0)
    # weapon impact: what Warcraft III plays when an attack lands
    if weapon and weapon != '-':
        for suffix in ('Flesh', 'Metal', 'Wood', 'Stone', ''):
            s = sounds.get(weapon + suffix)
            if s: entry['hit'] = s; break

for rec in ui:
    build_for(str(rec.get('unitUIID') or ''), str(rec.get('unitSound') or '').strip(),
              str(rec.get('weapType1') or '').strip())
# custom units inherit from their base and may override the weapon sound
for uid, t in types.items():
    build_for(uid, str(t.get('soundSet') or '').strip(), str(t.get('weaponType') or '').strip())
sets = {k: v for k, v in sets.items() if v}

# Warcraft III's own warning when a hero falls -- "Our hero has fallen!"
#
# Nothing in a map's script plays this: the engine does it, off UISounds.slk,
# in the *listening* player's race voice rather than the dead hero's. The table
# has a row per race for your own hero and another for an ally's, plus a
# Generic fallback -- and, tellingly, no row at all for an enemy's, which is
# why Warcraft III is silent when the other side loses one.
# Include unit/town attack advisor lines in the same runtime table.
warn = {}
for rec in uisnd:
    name = str(rec.get('SoundName') or '')
    if not name.startswith(('HeroDies', 'AllyHeroDies', 'UnderAttack', 'TownAttack')):
        continue
    files = entry_files(rec)
    if files:
        # Flags matter as much as the file here. The hero-death rows carry
        # NODUPLICATES, which is what stops "Our hero has fallen" stacking on
        # itself in a fight where heroes die constantly -- which is every fight
        # in this map. MinDistance and MaxDistance are 0, which is the table
        # saying outright that the warning is not a 3D sound.
        warn[name] = dict(files=files,
                          vol=float(rec.get('Volume', 127) or 127) / 127.0,
                          flags=[f for f in str(rec.get('Flags', '') or '').split(',')
                                 if f and f != '0'],
                          prio=int(float(rec.get('Priority', 0) or 0)))

# Every sound label the tables define, for SetSoundParamsFromLabel.
#
# The native takes a sound the script already created from a file and applies
# the row's own volume and pitch on top -- this map does it to the countdown
# tick (ChatroomTimerTick, 80 of 127), the "Fight!!" sting (QuestNew, 80) and
# the intro score (CreditsMusic, 120, which lives in DialogSounds rather than
# UISounds). The labels come from the map's script at run time, so the whole
# table goes rather than a list picked here; it is a few hundred small rows.
labels = {}
for slk in ('UISounds', 'DialogSounds', 'AbilitySounds', 'AmbienceSounds',
            'EnvironmentSounds', 'UnitAckSounds', 'UnitCombatSounds', 'MIDISounds'):
    fp = os.path.join(BASE, 'UI/SoundInfo/%s.slk' % slk)
    if not os.path.exists(fp):
        continue
    for rec in parse_slk(fp):
        name = str(rec.get('SoundName') or '')
        if not name or name in labels:
            continue
        row = dict(vol=float(rec.get('Volume', 127) or 127))
        if rec.get('Pitch') not in (None, ''):
            row['pitch'] = float(rec['Pitch'])
        labels[name] = row

os.makedirs('data', exist_ok=True)
json.dump(labels, open('data/soundlabels.json', 'w'))
json.dump(warn, open('data/uisounds.json', 'w'), indent=1)
json.dump(sets, open('data/soundsets.json', 'w'))
covered = sum(1 for v in sets.values() if v.get('death'))
print('advisor warnings: %d  (%s)' % (len(warn), ', '.join(sorted(warn))))
print('sound entries with audio: %d' % len(sounds))
print('unit types with a sound set: %d  (with a death sound: %d)' % (len(sets), covered))
ex = [u for u in sets if sets[u].get('death')][:5]
for u in ex:
    print('   %-6s %s' % (u, {k: len(v['files']) for k, v in sets[u].items()}))
