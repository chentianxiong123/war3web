"""Unified unit-type table: Blizzard SLK base + war3map.w3u base overrides + custom units."""
import json, os, re, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from wts import resolve_deep

def num(v, d=0.0):
    if isinstance(v, (int, float)): return float(v)
    if isinstance(v, str):
        s = v.strip()
        try: return float(s)
        except ValueError: return d
    return d

blz = json.load(open('data/blz_units.json'))
w3u = json.load(open('data/war3map.w3u.json'))

def weapon_fields(rec, i):
    return dict(atkTargetsAllowed=str(rec.get('targs%d' % i) or ''),
                weaponKind=str(rec.get('weapTp%d' % i) or ''),
                dmgBase=num(rec.get('dmgplus%d' % i)), dmgDice=num(rec.get('dice%d' % i)),
                dmgSides=num(rec.get('sides%d' % i)), atkCd=num(rec.get('cool%d' % i), 1.5),
                atkRange=num(rec.get('rangeN%d' % i), 90),
                atkType=str(rec.get('atkType%d' % i) or 'normal'),
                attackPoint=num(rec.get('dmgpt%d' % i)), attackBackswing=num(rec.get('backSw%d' % i)),
                # Splash: the WeaponMetaData calls Farea1/Harea1/Qarea1 the full/
                # half/quarter damage radii and Hfact1/Qfact1 their damage
                # factors. None of it crossed before, so a frost wyrm's breath
                # read as a single-target attack and a mortar team's shells
                # splashed nobody.
                splashFull=num(rec.get('Farea%d' % i)),
                splashHalf=num(rec.get('Harea%d' % i)),
                splashQuarter=num(rec.get('Qarea%d' % i)),
                splashHalfFactor=num(rec.get('Hfact%d' % i), 1.0),
                splashQuarterFactor=num(rec.get('Qfact%d' % i), 0.5),
                damageLoss=num(rec.get('damageLoss%d' % i)),
                spillDist=num(rec.get('spillDist%d' % i)),
                spillRadius=num(rec.get('spillRadius%d' % i)),
                targCount=num(rec.get('targCount%d' % i), 1),
                splashTargets=str(rec.get('splashTargs%d' % i) or ''),
                dmgUp=num(rec.get('dmgUp%d' % i)),
                rngBuff=num(rec.get('RngBuff%d' % i)),
                showUI=num(rec.get('showUI%d' % i), 1))

def from_blz(rec):
    prim = str(rec.get('Primary', '_')).strip()
    return dict(
        primary=prim,
        **{k + '2': v for k, v in weapon_fields(rec, 2).items()},
        atkTargetsAllowed=str(rec.get('targs1') or ''),
        weaponKind=str(rec.get('weapTp1') or ''),
        movementType=str(rec.get('movetp') or ''),
        flyHeight=num(rec.get('moveHeight'), 0),
        targetAs=str(rec.get('targType') or ''),
        classifications=str(rec.get('type') or ''),
        name=rec.get('_name') or '', icon=rec.get('_icon') or '',
        model=((str(rec.get('file')) + '.mdl') if rec.get('file') and rec.get('file') != '-' else (rec.get('_model') or '')),
        hp=num(rec.get('HP'), 100), mana=num(rec.get('manaN'), 0),
        manaStart=num(rec.get('mana0'), 0),
        hpReg=num(rec.get('regenHP'), 0), manaReg=num(rec.get('regenMana'), 0.01),
        armor=num(rec.get('def'), 0), armorType=str(rec.get('defType', 'none') or 'none'),
        dmgBase=num(rec.get('dmgplus1'), 0), dmgDice=num(rec.get('dice1'), 1),
        dmgSides=num(rec.get('sides1'), 1), atkCd=num(rec.get('cool1'), 1.5),
        atkRange=num(rec.get('rangeN1'), 90), atkType=str(rec.get('atkType1', 'normal')),
        # weapon 1 splash (weapon 2 rides along via the +'2' expansion above)
        splashFull=num(rec.get('Farea1')), splashHalf=num(rec.get('Harea1')),
        splashQuarter=num(rec.get('Qarea1')),
        splashHalfFactor=num(rec.get('Hfact1'), 1.0),
        splashQuarterFactor=num(rec.get('Qfact1'), 0.5),
        damageLoss=num(rec.get('damageLoss1')), spillDist=num(rec.get('spillDist1')),
        spillRadius=num(rec.get('spillRadius1')), targCount=num(rec.get('targCount1'), 1),
        splashTargets=str(rec.get('splashTargs1') or ''),
        dmgUp=num(rec.get('dmgUp1')), rngBuff=num(rec.get('RngBuff1')),
        showUI=num(rec.get('showUI1'), 1),
        moveSpeed=num(rec.get('spd'), 270), turnRate=num(rec.get('turnRate'), 0.6),
        collision=num(rec.get('collision'), 24), scale=num(rec.get('modelScale'), 1) or 1,
        # unitUI.slk keeps two scales and they are not the same thing: modelScale
        # (usca) sizes the art, `scale` (ussc) sizes the selection circle. The
        # Paladin is 1.25 selection against 1.0 model.
        selectScale=num(rec.get('scale'), 1) or 1,
        selZ=num(rec.get('selZ'), 0),
        level=int(num(rec.get('level'), 1)), race=str(rec.get('race', '')),
        isHero=prim in ('STR', 'AGI', 'INT'),
        str_=num(rec.get('STR'), 0), strLvl=num(rec.get('STRplus'), 0),
        agi=num(rec.get('AGI'), 0), agiLvl=num(rec.get('AGIplus'), 0),
        int_=num(rec.get('INT'), 0), intLvl=num(rec.get('INTplus'), 0),
        abilities=[a for a in str(rec.get('abilList', '')).split(',') if a and a != '_'],
        heroAbilities=[a for a in str(rec.get('heroAbilList', '')).split(',') if a and a != '_'],
        # UnitWeapons.slk 'castpt' / 'castbsw' -- how far into the spell
        # animation the ability takes effect, and how long the animation runs
        # on after it (UnitMetaData: "Animation - Cast Point" / "Cast
        # Backswing").  Only the map's own ucpt/ucbs overrides were carried, so
        # 987 of 997 unit types had no cast point at all and every spell landed
        # on the frame it was ordered.  A row of '-' has no spells to time and
        # reads as 0.
        castPoint=num(rec.get('castpt'), 0), castBackswing=num(rec.get('castbsw'), 0),
        attackPoint=num(rec.get('dmgpt1'), 0), attackBackswing=num(rec.get('backSw1'), 0),
        bountyDice=num(rec.get('bountydice'), 0), bountySides=num(rec.get('bountysides'), 0),
        bountyPlus=num(rec.get('bountyplus'), 0),
        isBuilding=int(num(rec.get('isbldg'), 0)),
        weaponType=str(rec.get('weapType1', '') or ''),
        # Warcraft III does not shadow-map a unit: it lays a flat textured quad
        # on the ground beneath it, sized and offset by the unit's own data.
        # `ReplaceableTextures\Shadows\Shadow.blp` is that texture, and 623 of
        # the 837 stock units name one.
        shadow=str(rec.get('unitShadow') or rec.get('buildingShadow') or '').strip(),
        shadowW=num(rec.get('shadowW'), 0), shadowH=num(rec.get('shadowH'), 0),
        shadowX=num(rec.get('shadowX'), 0), shadowY=num(rec.get('shadowY'), 0),
        # The ground decal a building is stamped on -- scorched earth under an
        # orc hut, flagstones under a human one. It names a row in
        # Splats\\UberSplatData.slk, which nothing read because that directory
        # was never extracted.
        uberSplat=str(rec.get('uberSplat') or '').strip(),
        # How long the death animation runs before the corpse starts to decay.
        deathTime=num(rec.get('death'), 3),
        soundSet=str(rec.get('unitSound', '') or ''),
        food=num(rec.get('fused'), 0), sight=num(rec.get('sight'), 1400),
        # UnitBalance.slk: build cost / time / population. A building's fmade
        # is the food it provides (Town Hall 12, Farm 6); '-' means none.
        gold=num(rec.get('goldcost')), lumber=num(rec.get('lumbercost')),
        buildTime=num(rec.get('bldtm')), foodMade=num(rec.get('fmade')) or 0,
        # UnitWeapons.slk 'acquire' -- how far a unit looks for a target on its
        # own.  Warcraft III uses this per unit type, not one global leash.
        acquisitionRange=num(rec.get('acquire'), 500),
        # UnitWeapons.slk 'weapsOn' -- how many of the unit's weapons are turned
        # on.  Blizzard writes 0 on the 250 rows that have no attack, and the
        # map writes it on 103 unit types of its own: dummies that inherit their
        # base's damage and are never meant to swing.  Defaults to 1 rather than
        # to 0 so a unit type with no weapons row at all keeps the attack it has
        # always had here; only a table saying 0 ever takes one away.
        attacksEnabled=int(num(rec.get('weapsOn'), 1)),
        # --- 视野 / 感知 / 防御升级（raw 有但从未带进运行时表）---
        nightSight=num(rec.get('nsight'), 800),
        fatLOS=num(rec.get('fatLOS'), 0),
        minRange=num(rec.get('minRange'), 0),
        defUp=num(rec.get('defUp'), 0),
        # --- 修理（goldRep/lumberRep/reptm: UnitWeapons.slk）---
        goldRepair=num(rec.get('goldRep')),
        lumberRepair=num(rec.get('lumberRep')),
        repairTime=num(rec.get('reptm')),
        # --- 死亡类型（raise/decay 等，决定尸体动画/复生行为）---
        deathType=str(rec.get('deathType') or ''),
        # --- 默认自动施法 / 行为 ---
        autoCast=str(rec.get('auto') or ''),
        canFlee=int(num(rec.get('canFlee'), 0)),
        prio=num(rec.get('prio')),
        points=num(rec.get('points')),
        nameCount=num(rec.get('nameCount')),
        impactZ=num(rec.get('impactZ')),
        propWin=num(rec.get('propWin')),
        # --- 建筑放置约束 ---
        isBuildOn=str(rec.get('isBuildOn') or ''),
        canBuildOn=str(rec.get('canBuildOn') or ''),
        requirePlace=str(rec.get('requirePlace') or ''),
        preventPlace=str(rec.get('preventPlace') or ''),
        # --- 击杀掉落表 / 商店库存 ---
        dropItems=str(rec.get('dropItems') or ''),
        stockMax=num(rec.get('stockMax')), stockRegen=num(rec.get('stockRegen')),
        stockStart=num(rec.get('stockStart')),
    )

W3U_MAP = {                       # w3u modification id -> normalized field
 'unam': 'name', 'upro': 'properName', 'unsf': 'suffix', 'umdl': 'model', 'uico': 'icon',
 'uhpm': 'hp', 'umpm': 'mana', 'umpi': 'manaStart', 'uhpr': 'hpReg', 'umpr': 'manaReg',
 'udef': 'armor', 'udty': 'armorType', 'ua1b': 'dmgBase', 'ua1d': 'dmgDice',
 'ua1s': 'dmgSides', 'ua1c': 'atkCd', 'ua1r': 'atkRange', 'ua1t': 'atkType',
 'uaen': 'attacksEnabled',
 'umvt': 'movementType', 'utar': 'targetAs', 'utyp': 'classifications',
 'umvs': 'moveSpeed', 'umvr': 'turnRate', 'ucol': 'collision', 'usca': 'scale',
 'ussc': 'selectScale', 'uslz': 'selZ',
 'ushu': 'shadow', 'ushb': 'shadow', 'ushw': 'shadowW', 'ushh': 'shadowH',
 'ushx': 'shadowX', 'ushy': 'shadowY', 'uubs': 'uberSplat', 'udtm': 'deathTime',
 # ucbs/ucpt are the cast backswing and cast point, not the collision radius:
 # reading ucbs as collision gave every hero the map's 0.1s backswing as its
 # size, and dropped the real ucol overrides entirely
 'ucbs': 'castBackswing', 'ucpt': 'castPoint',
 'udp1': 'attackPoint', 'ubs1': 'attackBackswing',
 'ulev': 'level', 'urac': 'race', 'upra': 'primary', 'ustr': 'str_', 'ustp': 'strLvl',
 'uagi': 'agi', 'uagp': 'agiLvl', 'uint': 'int_', 'uinp': 'intLvl',
 'ubdi': 'bountyDice', 'ubsi': 'bountySides', 'ubba': 'bountyPlus',
 'ubdg': 'isBuilding', 'usid': 'sight', 'uacq': 'acquisitionRange', 'ufoo': 'food', 'umvh': 'flyHeight',
 'ua1m': 'missile', 'ua1z': 'missileSpeed', 'uma1': 'missileArc',
 'usnd': 'soundSet', 'utip': 'tip', 'utub': 'ubertip',
 'usei': 'sellItems', 'useu': 'sellUnits', 'ua1g': 'atkTargetsAllowed', 'uabi': 'abilities',
 # Two different fields, and this map writes both. UnitMetaData.slk settles
 # which is which: ua1w is `weapTp1`, type weaponType -- normal / missile /
 # artillery, how the weapon behaves -- and ucs1 is `weapType1`, type
 # combatSound, which is the impact the game plays when the attack lands.
 # Reading ua1w as the sound overwrote what the base unit inherited with the
 # word "normal", and 'normalFlesh' is not a row in UnitCombatSounds.slk, so
 # every hero the map touched fell silent on contact. The map sets a real
 # combat sound on 42 of its unit types: WoodHeavyBash on 16, MetalHeavyChop
 # on 11, MetalHeavySlice on 4.
 'ucs1': 'weaponType', 'ua1w': 'weaponKind',
 # Required Animation Names.  Only the *.UnitFunc.txt side of this was read, so
 # a map that set the field itself lost it -- which is how Ichigo's Bankai form
 # went unnoticed: O000 is the same ichigo3.mdl asking for "alternateex", and
 # without that token the alternate half of the model is unreachable and he
 # transforms into himself.
 'uani': 'animProps',
 'ua1h': 'splashArea',
 'uhab': 'heroAbilities', 'umh1': 'missileHoming',
}

# Keep the second weapon independent, including map overrides.
for fid, field in list(W3U_MAP.items()):
    if fid.startswith('ua1'):
        W3U_MAP['ua2' + fid[3:]] = field + '2'
for fid, field in [('udp2', 'attackPoint2'), ('ubs2', 'attackBackswing2'),
                   ('uma2', 'missileArc2'), ('umh2', 'missileHoming2')]:
    W3U_MAP[fid] = field

def unit_func():
    """Units\\*UnitFunc.txt -> {unitId: {field: value}}.

    A unit's missile art, speed, arc and homing flag live here and in no .slk, so
    reading only the tables leaves every ranged unit in the game with no missile
    at all -- 301 of them on this map, against the 9 the map happens to override
    itself.
    """
    import glob
    out = {}
    for path in glob.glob('war3_extracted/Units/*UnitFunc.txt'):
        cur = None
        for line in open(path, encoding='latin-1', errors='replace'):
            line = line.strip()
            m = re.match(r'^\[([^\]]+)\]$', line)
            if m:
                cur = m.group(1)
                continue
            if not cur or '=' not in line:
                continue
            k, _, v = line.partition('=')
            k, v = k.strip().lower(), v.strip().strip('"')
            if v and v not in ('_', '-'):
                out.setdefault(cur, {}).setdefault(k, v)
    return out


FUNC = unit_func()
# the first weapon's missile, as Warcraft III names it in the func files
FUNC_MAP = {'missileart': 'missile', 'missilespeed': 'missileSpeed',
            'missilearc': 'missileArc', 'missilehoming': 'missileHoming',
            # Warcraft III's "Required Animation Names": the tokens a unit is
            # allowed to use beyond the animation being asked for. This is how
            # one model serves several units -- the Scout Tower, Guard Tower and
            # Arcane Tower are all HumanTower.mdl, and only "upgrade,first" vs
            # "upgrade,third" tells them apart. Without it every one of them
            # draws as the plain scout tower.
            'animprops': 'animProps'}


def func_defaults(uid):
    src = FUNC.get(uid) or {}
    out = {}
    for k, field in FUNC_MAP.items():
        v = src.get(k)
        if v is None:
            continue
        # missile art is a path and animProps a token list; the rest are numbers
        if field == 'animProps':
            out[field] = v
        else:
            parts = str(v).split(',')
            out[field] = parts[0] if field == 'missile' else num(parts[0], 0)
            second = parts[1] if len(parts) > 1 else parts[0]
            out[field + '2'] = second if field == 'missile' else num(second, 0)
    return out


types = {}
for uid, rec in blz.items():
    types[uid] = from_blz(rec)
    types[uid].update(func_defaults(uid))
    types[uid]['id'] = uid
    types[uid]['origin'] = uid

# 中文版 1.27 的 UnitData.slk 缺少 harr(弓箭手)/hpri(牧师) 两行 (解包源缺失),
# 但这两单位是人族标准单位。这里用暴雪官方公开数值补上 (与英文版 UnitData.slk
# 一致): 弓箭手 75金/20木/20s/HP245/攻17-18/射程500; 牧师 135金/10木/20s/HP325/
# 法力235/无攻击。模型: 牧师 Human/Priest/Priest.mdx 已解包, 弓箭手模型在官方为
# units/human/archer (源包缺失, 先用牧师弹道可用的通用占位路径, 渲染回退单位模型)。
def _official(uid, base, **kw):
    t = dict(types[base])
    t['id'] = uid
    t['origin'] = 'official'
    t.update(kw)
    return t

if 'harr' not in types:
    types['harr'] = _official('harr', 'hfoo', name='弓箭手', gold=75, lumber=20, buildTime=20,
        hp=245, dmgBase=17, dmgDice=1, dmgSides=2, atkCd=2.1, atkRange=500, moveSpeed=270,
        armor=0, armorType='light', weaponType='missile', attacksEnabled=1, food=2,
        attackPoint=0.35, attackBackswing=0.4, acquisitionRange=600,
        model='units/human/archer/archer.mdl',
        icon='ReplaceableTextures\\CommandButtons\\BTNArcher.blp')
if 'hpri' not in types:
    types['hpri'] = _official('hpri', 'hsor', name='牧师', gold=135, lumber=10, buildTime=20,
        hp=325, mana=235, manaStart=75, attacksEnabled=0, weaponType='none', moveSpeed=270,
        armor=0, armorType='medium', food=2, acquisitionRange=600,
        # 官方牧师技能: 治疗/心灵之火/驱散 (中文版 slk 的能力列残缺, 这里是暴雪公开设定)
        abilities=['Ahea', 'Ainf', 'Adis'],
        model='units/human/priest/priest.mdl',
        icon='ReplaceableTextures\\CommandButtons\\BTNPriest.blp')
# 女巫的技能列同样残缺 — 官方: 减速/变羊/隐身
if 'hsor' in types and not any(a in ('Aslo', 'Aply', 'Aivs') for a in (types['hsor'].get('abilities') or [])):
    types['hsor']['abilities'] = ['Aslo', 'Aply', 'Aivs']

def apply_mods(t, mods):
    for k, v in mods.items():
        f = W3U_MAP.get(k)
        if not f: continue
        if f in ('abilities', 'heroAbilities', 'sellItems', 'sellUnits'):
            t[f] = [x.strip() for x in str(v).split(',') if x.strip() and x.strip() != '_']
        elif f.removesuffix('2') in ('name', 'properName', 'suffix', 'model', 'icon', 'race', 'armorType', 'primary',
                   'atkType', 'missile', 'soundSet', 'tip', 'ubertip', 'weaponType', 'weaponKind',
                   'uberSplat',
                   'animProps',
                   'atkTargetsAllowed', 'movementType', 'targetAs', 'classifications'):
            t[f] = v
        else:
            t[f] = num(v, t.get(f, 0)) if not isinstance(v, str) else num(v, t.get(f, 0))
    return t

# Warcraft III keeps the two w3u tables independent.  The "original" table edits
# the standard units; a custom unit inherits the *default* values of its base, not
# the author's edits to that base.  Chaining them hands a hero whatever was done
# to the standard unit it was built from -- and this map edits Ulic, Obla, Oshd
# and Hmkg into 700-damage, 7500-life templates for its own use elsewhere, which
# gave exactly the five heroes derived from them 150-760 base damage while the
# other twenty-one sat on Blizzard's 0.
defaults = {uid: dict(t) for uid, t in types.items()}

for o in w3u['base']:                       # overrides to Blizzard unit types
    t = types.setdefault(o['id'], dict(from_blz({}), id=o['id'], origin=o['id']))
    apply_mods(t, o['mods'])
for o in w3u['custom']:                     # new unit types derived from a base
    src = defaults.get(o['origin']) or types.get(o['origin'])
    t = dict(src) if src else dict(from_blz({}))
    t['id'] = o['id']; t['origin'] = o['origin']
    apply_mods(t, o['mods'])
    if t.get('heroAbilities'): t['isHero'] = True
    types[o['id']] = t

os.makedirs('data', exist_ok=True)
# The editor stores authored text in war3map.wts and leaves a TRIGSTR_ pointer
# in the object data; resolve them here so nothing downstream shows the pointer.
types = resolve_deep(types)
json.dump(types, open('data/unittypes.json', 'w'))
heroes = [t for t in types.values() if t.get('isHero')]
creeps = [t for t in types.values() if str(t.get('race','')).lower() == 'creeps']
print('unit types: %d  (heroes %d, creep-race %d)' % (len(types), len(heroes), len(creeps)))
import collections
lv = collections.Counter(t['level'] for t in creeps)
print('creeps by level:', dict(sorted(lv.items())))
FIELDS = ('name', 'hp', 'mana', 'level', 'acquisitionRange', 'model')
custom = [t for t in heroes if t['id'] != t.get('origin') or t['id'] not in blz]
if custom:
    print('sample custom hero:', {k: custom[0].get(k) for k in FIELDS})
if creeps:
    print('sample creep:', {k: creeps[0].get(k) for k in FIELDS})
acq = collections.Counter(t.get('acquisitionRange') for t in types.values())
print('acquisition ranges:', dict(sorted(acq.most_common(5))))
