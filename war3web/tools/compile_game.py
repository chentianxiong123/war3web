"""Compile extracted map data into a single game-data file for the server/client."""
import json, re, os, sys, glob, collections

# the string table and its helpers live in tools/wts.py, shared with the unit
# and item tables so all three resolve references the same way
from wts import S, clean

def map_info():
    """Name / author / description / player-hint straight out of war3map.w3i."""
    b = open('extracted/war3map.w3i', 'rb').read()
    ver = int.from_bytes(b[0:4], 'little')
    # int version, int saves, int editorVersion, [4 ints game version if >= 28]
    o = 12 + (16 if ver >= 28 else 0)
    out = {}
    def cstr(off):
        e = b.index(b'\x00', off)
        return b[off:e].decode('utf-8', 'replace'), e + 1
    for key in ('name', 'author', 'description', 'players'):
        out[key], o = cstr(o)
    return out

W3I = map_info()

MODELS = json.load(open('assets/models.json'))
TEX = json.load(open('assets/textures.json'))
MODEL_BY_LOWER = {k.lower(): k for k in MODELS}

def find_model(p):
    """Resolve an art path to a converted model.

    Map imports are keyed by bare name, game assets by their archive path, and
    the object data's casing does not always match the file's.
    """
    if not isinstance(p, str) or not p.strip().strip('-'):
        return None
    q = p.strip().replace('\\\\', '\\').replace('/', '\\').lstrip('\\')
    q = os.path.splitext(q)[0]
    if q.lower() in MODEL_BY_LOWER:
        return MODEL_BY_LOWER[q.lower()]
    base = q.split('\\')[-1]
    if base.lower() in MODEL_BY_LOWER:
        return MODEL_BY_LOWER[base.lower()]
    for k_low, k in MODEL_BY_LOWER.items():
        if k_low.split('\\')[-1] == base.lower():
            return k
    return None

def find_icon(p):
    if not isinstance(p, str): return None
    base = os.path.splitext(p.replace('/', '\\').split('\\')[-1])[0].lower()
    for k, v in TEX.items():
        if os.path.splitext(k.split('\\')[-1])[0] == base: return v
    return None

U = json.load(open('data/war3map.w3u.json'))
A = json.load(open('data/war3map.w3a.json'))
T = json.load(open('data/war3map.w3t.json'))
units = {o['id']: o for o in U['custom'] + U['base']}
abils = {o['id']: o for o in A['custom'] + A['base']}
# Abilities the map's own triggers react to.  Several heroes carry a castable
# ability in their innate list rather than their learnable one (Gaara's Q is
# 'A05P', while the learnable 'A05K' only supplies its level), so the innate has
# to reach the hotkey bar or the spell can never be cast.
_JS = open('extracted/war3map.j', encoding='latin-1').read()
SPELL_TRIGGERED = set(re.findall(r"GetSpellAbilityId\(\)\s*==\s*'(....)'", _JS))
# reqLevel / levelSkip come pre-resolved (w3a override, else the Blizzard SLK)
ABIL_TABLE = json.load(open('data/abilities.json'))
# the fully resolved unit table (Blizzard .slk + the map's base and custom overrides)
UNIT_TABLE = json.load(open('data/unittypes.json'))
ITEM_TABLE = json.load(open('data/itemtypes.json'))


# ---------------------------------------------------------------- translation
# A hand translation overlay, kept out of the extraction entirely: the map's own
# strings stay exactly as they were and the English is emitted alongside them, so
# the client can show either and nothing here invents map content.
try:
    TR = json.load(open('data/translations.ko-en.json', encoding='utf-8'))
except OSError:
    TR = {}
TR_NAMES = TR.get('names', {})
TR_TITLES = TR.get('titles', {})
TR_LINES = TR.get('lines', {})


def en_name(v):
    return TR_NAMES.get(str(v).strip()) if isinstance(v, str) else None


def en_title(v):
    return TR_TITLES.get(str(v).strip()) if isinstance(v, str) else None


def en_desc(v):
    """Translate a description line by line, keeping any line we have no entry for."""
    if not isinstance(v, str) or not v.strip():
        return None
    out, hit = [], False
    for line in v.split('\n'):
        s = line.strip()
        if not s:
            out.append('')
            continue
        t = TR_LINES.get(s)
        if t is not None:
            hit = True
        out.append(t if t is not None else s)
    return '\n'.join(out) if hit else None


def en_tip(tip, ko, en):
    """Tooltips read "<name>(<hotkey>) - [Level N]", with pieces often missing.

    The name in a tooltip is usually a shortened form of the ability's own name
    ("잠영사수" for "소환술-잠영사수"), so the tooltip is rebuilt from its parts
    rather than substituting the full name into it.  The hotkey and the level
    tag are each optional, and this map spells the level tag "레벨l" as often as
    "레벨".
    """
    if not isinstance(tip, str) or not tip.strip():
        return None
    m = re.match(r'^\s*(?P<nm>.*?)\s*(?:\((?P<key>[^)]*)\))?\s*'
                 r'(?:-\s*\[\s*(?:레벨l?|Level)\s*(?P<lv>\d+)\s*\])?\s*$', tip)
    if not m or not m.group('nm'):
        return TR_LINES.get(tip.strip())
    name = (TR_NAMES.get(m.group('nm')) or TR_LINES.get(m.group('nm'))
            or en or TR_NAMES.get(str(ko).strip()))
    if not name:
        return None
    out = name
    if m.group('key'):
        out += '(%s)' % m.group('key')
    if m.group('lv'):
        out += ' - [Level %s]' % m.group('lv')
    return out


def _art(entry, slot):
    """One art slot off an ability-table entry; a field may list several models."""
    v = ((entry or {}).get('art') or {}).get(slot)
    if not v:
        return None
    first = str(v).split(',')[0].strip()
    return first or None


items = {o['id']: o for o in T['custom'] + T['base']}

# ------------------------------------------------------------ ability archetypes
ARCH = {
 'AHtb':'aoe_nuke_slow','AOws':'aoe_stun','AUim':'line_stun','AOsh':'line_nuke',
 'AUcs':'line_nuke','AEfk':'aoe_nuke','AUfn':'aoe_nuke_slow','AOcl':'chain_nuke',
 'AHbz':'channel_aoe','AUls':'summon_swarm','AUin':'summon_infernal','AEbl':'blink',
 'AHhb':'heal','AOhw':'heal','AHad':'aura','AOae':'aura','AEar':'aura','AUau':'aura',
 'AEme':'morph','AHmt':'morph','ANbr':'breath','ANbf':'breath','ACtb':'aoe_nuke',
 'ANcs':'aoe_nuke','ANcf':'aoe_nuke','AHtc':'shield','Asph':'shield','ACbh':'buff_self',
 'AUdc':'target_nuke','AOsf':'target_nuke','AHfs':'target_nuke','ANdr':'drain',
 'ANin':'target_nuke','AOmi':'summon_images','AUim2':'line_stun','Aspy':'passive',
 'ANsl':'slow','AUsl':'slow','AHpx':'passive','AIs6':'passive','AId0':'passive',
 'AIl1':'passive','AItx':'passive','AIa6':'passive','Apig':'dummy','AUsm':'passive',
 'AOcr':'passive','AHca':'passive','AEev':'passive','ACcl':'passive',
}
def arch(origin):
    if origin in ARCH: return ARCH[origin]
    if origin.startswith('AI'): return 'passive'
    if origin.startswith('A'): return 'target_nuke'
    return 'passive'

def lvl_get(mods, key, lvl, default=None):
    for k in ('%s:%d' % (key, lvl), '%s:0' % key, key):
        if k in mods: return mods[k]
    return default

def ability(aid):
    o = abils.get(aid)
    if not o: return None
    m = o['mods']
    # How many ranks the ability really has.
    #
    # 'alev' is what the author writes when they want a count of their own, and
    # when they want one rank they write 1 -- A05V and A05P both do. When the
    # field is absent, Warcraft III falls back to the BASE ability's own level
    # count, and tools/abilities.py has always done that; this table did not,
    # so it stamped maxLvl 1 on every ability whose author left 'alev' alone.
    # server/room.js gates learnSkill on THIS number, so 34 abilities across 20
    # of the 26 heroes -- 11 of them ultimates -- could never be raised past
    # rank 1, and the trigger that copies a rank onto a dummy always read 1.
    # The fallback reads the count abilities.py already resolved rather than
    # re-deriving it, so the two tables cannot drift apart again.
    nlev = lvl_get(m, 'alev', 0, None)
    if nlev is None:
        nlev = len((ABIL_TABLE.get(aid) or {}).get('levels') or []) or 1
    nlev = int(nlev) or 1
    dprefix = o['origin'][1:] if len(o['origin']) == 4 else o['origin']
    levels = []
    for L in range(1, int(nlev) + 1):
        lv = dict(cooldown=lvl_get(m, 'acdn', L, 0), mana=lvl_get(m, 'amcs', L, 0),
                  range=lvl_get(m, 'aran', L, 0), area=lvl_get(m, 'aare', L, 0),
                  duration=lvl_get(m, 'adur', L, 0), heroDuration=lvl_get(m, 'ahdu', L, 0),
                  castTime=lvl_get(m, 'acas', L, 0))
        for d in range(1, 5):
            v = lvl_get(m, '%s%d' % (dprefix, d), L)
            if v is not None: lv['data%d' % d] = v
        levels.append(lv)
    gate = ABIL_TABLE.get(aid) or {}
    return dict(id=aid, origin=o['origin'], archetype=arch(o['origin']),
                # what hero level unlocks rank 1, and how many levels between ranks
                reqLevel=int(gate.get('reqLevel') or 0),
                levelSkip=int(gate.get('levelSkip') or 0),
                maxLvl=len(levels) or 1,
                name=clean(lvl_get(m, 'anam', 0, aid)),
                tip=clean(lvl_get(m, 'atp1', 1, '')),
                desc=clean(lvl_get(m, 'aub1', 1, '')),
                # the same text in English, when the overlay has it
                nameEn=en_name(clean(lvl_get(m, 'anam', 0, aid))),
                tipEn=en_tip(clean(lvl_get(m, 'atp1', 1, '')),
                             clean(lvl_get(m, 'anam', 0, aid)),
                             en_name(clean(lvl_get(m, 'anam', 0, aid)))),
                descEn=en_desc(clean(lvl_get(m, 'aub1', 1, ''))),
                # The map's own icon, else Warcraft III's for the base. Reading
                # only the map's mods here left 14 hero abilities blank -- Blink,
                # Mirror Image, Reincarnation and the rest all have an `Art` line
                # in Units\*AbilityFunc.txt that the map simply does not override.
                # Same fix the effect models above already got.
                icon=find_icon(lvl_get(m, 'aart', 0) or _art(gate, 'icon')),
                hotkey=clean(lvl_get(m, 'ahky', 0, '')), levels=levels,
                targets=lvl_get(m, 'atar', 1, ''),
                # Ability art comes from the table, which reads Warcraft III's
                # own Units\*AbilityFunc.txt and lays the map's overrides on top.
                # Reading only the map's `mods` here saw art for 13 of 130 hero
                # abilities, because FOC almost always overrides just the icon.
                effectModel=(find_model(_art(gate, 'effect'))
                             or find_model(_art(gate, 'target'))
                             or find_model(_art(gate, 'caster'))
                             or find_model(_art(gate, 'special'))),
                missileModel=find_model(_art(gate, 'missile')))

def _sold(field):
    """Units whose object data lists things for sale -> {unitId: [ids]}."""
    out = {}
    for o in U['custom'] + U['base']:
        lst = [x.strip() for x in str(o['mods'].get(field, '')).split(',') if x.strip()]
        if lst:
            out[o['id']] = lst
    return out

TAVERNS = {k: ','.join(v) for k, v in _sold('useu').items()}   # sells units -> tavern
SHOP_IDS = _sold('usei')                                       # sells items -> shop

def hero(uid):
    o = units.get(uid)
    if not o: return None
    m = o['mods']
    learn = [x.strip() for x in str(m.get('uhab', '')).split(',') if x.strip()]
    base = [x.strip() for x in str(m.get('uabi', '')).split(',') if x.strip()]
    ab = learn + [b for b in base if b not in learn and b != 'AInv']
    innate = [b for b in base if b != 'AInv' and b not in learn and b in SPELL_TRIGGERED]
    castable = learn + innate
    U = UNIT_TABLE.get(uid) or {}
    return dict(id=uid, name=clean(m.get('upro', m.get('unam', uid))),
                title=clean(m.get('unam', '')),
                titleEn=en_title(clean(m.get('unam', ''))),
                model=find_model(m.get('umdl')), modelPath=m.get('umdl'),
                icon=find_icon(m.get('uico')),
                scale=m.get('usca', 1.0), selectScale=m.get('ussc', 1.0),
                # Stats come from the unit table, which has already resolved the
                # whole chain: Blizzard's .slk, then the map's overrides to those
                # base types, then the hero's own.  Reading the hero's `mods`
                # alone sees only what it overrode itself and falls back to a
                # guess for the rest -- this map templates its heroes on a
                # heavily modified base, so that guess is wrong far more often
                # than it is right.
                hp=U.get('hp', 500), mana=U.get('mana', 200),
                hpReg=U.get('hpReg', 0.5), manaReg=U.get('manaReg', 0.02),
                armor=U.get('armor', 0), armorType=U.get('armorType', ''),
                dmgBase=U.get('dmgBase', 20), dmgDice=U.get('dmgDice', 1),
                dmgSides=U.get('dmgSides', 1),
                atkCd=U.get('atkCd', 2.0), atkRange=U.get('atkRange', 100),
                atkType=U.get('atkType', ''), missile=find_model(U.get('missile')),
                missileSpeed=U.get('missileSpeed', 0), missileArc=U.get('missileArc', 0),
                moveSpeed=U.get('moveSpeed', 300), turnRate=U.get('turnRate', 0.6),
                collision=U.get('collision', 32), primary=U.get('primary', 'STR'),
                str_=U.get('str_', 20), strLvl=U.get('strLvl', 2.0),
                agi=U.get('agi', 20), agiLvl=U.get('agiLvl', 2.0),
                int_=U.get('int_', 20), intLvl=U.get('intLvl', 2.0),
                abilities=[a for a in (ability(x) for x in ab) if a],
                abilityIds=ab, learnable=learn, innate=innate, castable=castable,
                passive=[b for b in base if b != 'AInv' and b not in innate],
                hasInventory='AInv' in base)

def picker_roster(jass):
    """Maps that pick heroes in-world stand one hero of each type on a pad,
    owned by neutral-passive. That placement is the real roster."""
    out = []
    for m in re.finditer(r"CreateUnit\w*\(\s*Player\((\d+)\)\s*,\s*'(\w{4})'", jass):
        if int(m.group(1)) == 15:
            out.append(m.group(2))
    # the script usually assigns Player(15) to a local first
    for var in set(re.findall(r'set (\w+)=Player\(15\)', jass)):
        for m in re.finditer(r"CreateUnit\w*\(\s*%s\s*,\s*'(\w{4})'" % re.escape(var), jass):
            out.append(m.group(1))
    seen, uniq = set(), []
    for uid in out:
        t = units.get(uid)
        if not t or uid in seen:
            continue
        mods = t['mods']
        if 'uhab' in mods or 'upro' in mods or 'ustr' in mods:   # hero-shaped
            seen.add(uid); uniq.append(uid)
    return uniq

PICKER = picker_roster(open('extracted/war3map.formatted.j',
                            encoding='utf-8', errors='replace').read())
if len(PICKER) >= 8:
    TAVERNS = {'picker': ','.join(PICKER)}
    print('roster taken from the in-world hero picker: %d heroes' % len(PICKER))

roster = []
for tav, lst in TAVERNS.items():
    for uid in lst.split(','):
        h = hero(uid)
        if h:
            h['tavern'] = tav
            h['custom'] = uid in {o['id'] for o in U['custom']}
            roster.append(h)

def item(iid):
    o = items.get(iid)
    if not o: return None
    m = o['mods']
    # Stats come from the resolved item table, which has already folded the
    # Blizzard base in.  Reading the item's own overrides alone left every stock
    # item the map merely re-priced -- the stat tomes, most of the shop -- with
    # no abilities, no icon and no model, which is to say doing nothing.
    I = ITEM_TABLE.get(iid) or {}
    return dict(id=iid, name=clean(I.get('name', m.get('unam', iid))),
                icon=find_icon(I.get('icon')),
                gold=I.get('gold', 0), lumber=I.get('lumber', 0),
                tip=clean(I.get('tip', '')), desc=clean(I.get('ubertip', '')),
                level=I.get('level', 1), charges=I.get('uses', 0),
                itemClass=I.get('itemClass', ''), usable=I.get('usable', 0),
                abilities=list(I.get('abilities') or []),
                model=find_model(I.get('model')))

# Every item type, not just the ones a shop stocks: an item lying in the world
# can be anything a trigger dropped or a recipe produced, and the client needs a
# model and a name for whatever it is handed.
items_all = {}
for iid, I in ITEM_TABLE.items():
    mdl = find_model(I.get('model'))
    if not mdl and not I.get('name'):
        continue
    items_all[iid] = dict(n=clean(I.get('name', iid)), m=mdl,
                          i=find_icon(I.get('icon')), g=I.get('gold', 0),
                          p=1 if I.get('powerup') else 0)

shops = []
for sid, ids in SHOP_IDS.items():
    o = units.get(sid)
    label = clean(o['mods'].get('unam', sid)) if o else sid
    shops.append(dict(id=sid, name=label,
                      items=[i for i in (item(x) for x in ids) if i]))

# ------------------------------------------------------------------ map layout
jass = open('extracted/war3map.formatted.j', encoding='utf-8', errors='replace').read()
spawns = []
for m in re.finditer(r"CreateUnit\(\s*\w+\s*,\s*'(\w{4})'\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)", jass):
    uid, x, y, f = m.group(1), float(m.group(2)), float(m.group(3)), float(m.group(4))
    o = units.get(uid)
    spawns.append(dict(id=uid, x=x, y=y, facing=f,
                       name=clean(o['mods'].get('unam', uid)) if o else uid,
                       model=find_model(o['mods'].get('umdl')) if o else None,
                       scale=(o['mods'].get('usca', 1.0) if o else 1.0)))
cam = re.search(r'SetCameraBounds\((-?[\d.]+)\+[^,]+,(-?[\d.]+)\+[^,]+,(-?[\d.]+)-[^,]+,(-?[\d.]+)-', jass)
bounds = dict(minX=float(cam.group(1)), minY=float(cam.group(2)),
              maxX=float(cam.group(3)), maxY=float(cam.group(4))) if cam else None

# hero voice lines: FOCS names its imported mp3s after the character
VOICE_PREFIX = {
 'Goku': ['goku'], 'Naruto Uzumaki': ['naruto', 'n'], 'Sasuke Uchiha': ['saske'],
 'Ichigo Kurosaki': ['ich', 'ic'], 'Kikyo': ['kikyo'], 'Lina Inverse': ['lina'],
 'Louise la Valliere': ['louise'], 'Hatsune Miku': ['miku'], 'Momo': ['momo'],
 'Kanade Tachibana': ['kanade'], 'Pain': ['pain'], 'Tony Stark': ['ironman'],
 'Arcueid Brunestud': ['arc'], 'Optimus Prime': ['gao', 'ga'],
 'Fate Testarossa': ['feit', 'fa'], 'Kazuma Yagami': ['kz'],
 'Gilgamesh': ['enumaelish', 'gate of bivilon', 'heavenschains'],
 'Shana': ['sha'], 'Alucard': ['syotgun'], 'Sesshomaru': ['wolflord'],
 'Itachi Uchiha': ['itachi'], 'Byakuya Kuchiki': ['lk'],
 'Rukia Kuchiki': ['lukia'], 'Nanoha Takamachi': ['negi'],
}
GENERIC_SFX = ['b', 'i', 'k', 's', 'se', 'sew', 'chd', 'cgd', 'akad', 'el', 'ba', 'ggggg']

def voice_files(heroname, all_sounds):
    pres = VOICE_PREFIX.get(heroname)
    if not pres: return []
    out = []
    for f in all_sounds:
        base = os.path.splitext(f)[0].lower()
        stem = base.rstrip('0123456789')
        for p_ in pres:
            if stem == p_:
                out.append(f); break
    return sorted(out)

sound_files = sorted(f for f in os.listdir('public/assets/sounds')) if os.path.isdir('public/assets/sounds') else []
for h in roster:
    h['voices'] = voice_files(h['name'], sound_files)
generic = sorted(f for f in sound_files
                 if os.path.splitext(f)[0].lower().rstrip('0123456789') in GENERIC_SFX)

sounds = {}
for m in re.finditer(r'set (\w+)=CreateSound\("([^"]+)"', jass):
    sounds[m.group(1)] = m.group(2).replace('\\\\', '/').replace('\\', '/')

def derive_rules(jass):
    """Win rules the map defines for itself. Maps express these differently:
    some use Warcraft III's PLAYER_SCORE_HEROES_KILLED, others keep their own
    counters; some register a per-unit death event for the boss, others test
    the dying unit against a stored handle."""
    funcs = {m.group(1): m.group(0) for m in
             re.finditer(r'^function\s+(\w+)\s+takes.*?^endfunction', jass, re.M | re.S)}

    def unit_type_of(var):
        m = re.search(r"set %s=\s*CreateUnit\w*\([^,]+,'(\w{4})'" % re.escape(var), jass)
        return m.group(1) if m else None

    # --- boss: a per-unit death registration, or a death condition on a stored unit
    boss = None
    m = re.search(r'TriggerRegisterUnitEvent\(\w+,(\w+),EVENT_UNIT_DEATH\)', jass)
    if m:
        boss = unit_type_of(m.group(1))
    if not boss:
        for body in funcs.values():
            c = re.search(r'GetDyingUnit\(\)==(\w+)\)', body)
            if c:
                boss = unit_type_of(c.group(1))
                if boss:
                    break

    # --- kill threshold: either the engine score or the map's own counter
    def as_int(tok):
        return ord(tok) if len(tok) == 1 and not tok.isdigit() else int(tok)
    kills = None
    for pat in (r"PLAYER_SCORE_HEROES_KILLED\)[^)]*\)*\s*>=\s*'(\w)'",
                r"PLAYER_SCORE_HEROES_KILLED[\s\S]{0,400}?>=\s*(\d+)"):
        mm = re.search(pat, jass)
        if mm:
            kills = as_int(mm.group(1)); break
    if kills is None:
        # a counter global compared against a constant inside a boolean guard
        cnt = collections.Counter()
        for body in funcs.values():
            if 'returns boolean' not in body:
                continue
            for g, lit in re.findall(r"return\((\w+)\s*==\s*'(\w)'\)", body):
                if re.search(r'set %s=\(?%s\+1' % (re.escape(g), re.escape(g)), jass):
                    cnt[as_int(lit)] += 1
            for g, lit in re.findall(r"return\((\w+)\s*>=\s*(\d+)\)", body):
                if re.search(r'set %s=\(?%s\+1' % (re.escape(g), re.escape(g)), jass):
                    cnt[int(lit)] += 1
        if cnt:
            kills = cnt.most_common(1)[0][0]

    starts = [(int(a), float(b), float(c)) for a, b, c in
              re.findall(r'DefineStartLocation\((\d+),(-?[\d.]+),(-?[\d.]+)\)', jass)]
    teams = {}
    for pid, t in re.findall(r'SetPlayerTeam\(Player\((\d+)\),(\d+)\)', jass):
        teams.setdefault(int(t), []).append(int(pid))
    return boss, kills, starts, teams

boss_unit, kills_to_win, start_locs, team_map = derive_rules(jass)
pick_loc = [start_locs[0][1], start_locs[0][2]] if start_locs else [0.0, 0.0]
alt_loc = next(([x, y] for i, x, y in start_locs if [x, y] != pick_loc), pick_loc)

game = dict(
    meta=dict(name=clean(W3I.get('name') or 'Warcraft III map'),
              author=clean(W3I.get('author') or ''),
              objective=clean(W3I.get('description') or ''),
              credits=clean(W3I.get('players') or ''),
              teams=[dict(id=t, name='Team %d' % (t + 1), players=p)
                     for t, p in sorted(team_map.items()) if t < 2] or
                    [dict(id=0, name='Team 1', players=[0, 1, 2, 3, 4]),
                     dict(id=1, name='Team 2', players=[5, 6, 7, 8, 9])],
              killsToWin=kills_to_win or 100, bossUnit=boss_unit,
              startLoc=dict(pick=pick_loc, center=alt_loc)),
    bounds=bounds, heroes=roster, shops=shops, items=items_all, spawns=spawns, sounds=sounds,
    sfx=dict(generic=generic, all=sound_files))

os.makedirs('data', exist_ok=True)
json.dump(game, open('data/game.json', 'w'), indent=1)
print('heroes: %d (custom %d, with model %d)' % (
    len(roster), sum(1 for h in roster if h['custom']), sum(1 for h in roster if h['model'])))
print('abilities on heroes: %d' % sum(len(h['abilities']) for h in roster))
print('shops: %s' % [(s['name'], len(s['items'])) for s in shops])
print('item types on the wire: %d (%d with a ground model)'
      % (len(items_all), sum(1 for i in items_all.values() if i['m'])))
print('spawn entities: %d, sounds bound: %d' % (len(spawns), len(sounds)))
print('bounds:', bounds)
arch_count = collections.Counter(a['archetype'] for h in roster for a in h['abilities'])
print('ability archetypes:', dict(arch_count.most_common()))
print('\nsample roster:')
for h in roster[:6]:
    print('  %-18s %-26s model=%-18s hp=%s abils=%d' % (
        h['name'][:18], h['title'][:26], str(h['model'])[:18], h['hp'], len(h['abilities'])))
