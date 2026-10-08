"""Compile what a unit produces and what the command card's own buttons are, from the archives.

Nothing here is written by hand. A hand-written table covers the race it was written for and
misses the other three, and it misses them quietly: the card simply shows too little, with
nothing to say so. This reads the relationships Warcraft III itself stores, which are in the
`Units\\*Func.txt` profiles and in one file that is nothing but the command card:

    Units\\CommandFunc.txt          the card's own buttons -- Move, Stop, Hold Position,
                                    Attack, Patrol, Rally, Cancel, Build -- each with the art
                                    it draws and the Buttonpos it occupies. Eighteen rows,
                                    every one of them a cell on the card.

    Units\\*UnitFunc.txt            per unit type: `Trains` (what a building produces),
                                    `Researches` (what it upgrades), `Uses` (what a shop
                                    sells), `Upgrades`. All four races, 267 types.

So the card is read rather than authored: a Barracks draws the Footman, the Knight and the
Paladin because `Trains=hfoo,hrif,hkni` says so, and if a map's own object data changes the
list the card follows. The hard-coded version had a Barracks training a footman and an
archer -- an archer is a Tier-2 unit a Barracks does not have in Warcraft III at all, and
the Paladin it was missing is one of the three it does.
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))
from slk import parse_profile

UNITS = Path('war3_extracted/Units')
DATA = Path('data')

# CommandFunc names its art the way it did when the tables were written -- CommandMove,
# CommandStop. The 1.27 archives the map was unpacked from ship the same buttons under the
# BTN prefix: BTNMove.blp is there and CommandMove.blp is not. So a name is looked up as
# written and then with its leading Command swapped for BTN, and a card button that finds
# neither is left without art rather than given a substitute that is not its own.
COMMAND_ART_ALT = 'Command', 'BTN'


def find_art(art_index, name):
    if not name:
        return None
    low = str(name).lower()
    if low in art_index:
        return art_index[low]
    if low.startswith(COMMAND_ART_ALT[0].lower()):
        # the index is keyed by the archives' own lowercase file stems
        swapped = COMMAND_ART_ALT[1].lower() + low[len(COMMAND_ART_ALT[0]):]
        if swapped in art_index:
            return art_index[swapped]
    return None


# Human only needs one set: CommandFunc is shared, and the four Build* rows differ by race
# in their art alone.
LIST_FIELDS = {'Trains': 'trains', 'Researches': 'researches', 'Upgrades': 'upgrades',
               'Sellunits': 'sellsUnits', 'Sellitems': 'sellsItems', 'Builds': 'builds',
               'Makeitems': 'makes'}
COMMANDS = {
    'CmdMove': 'move', 'CmdStop': 'stop', 'CmdHoldPos': 'hold', 'CmdAttack': 'attack',
    'CmdAttackGround': 'attackGround', 'CmdPatrol': 'patrol', 'CmdBuild': 'build',
    'CmdBuildHuman': 'buildHuman', 'CmdBuildOrc': 'buildOrc',
    'CmdBuildNightElf': 'buildNightElf', 'CmdBuildUndead': 'buildUndead',
    'CmdCancel': 'cancel', 'CmdCancelBuild': 'cancel', 'CmdCancelTrain': 'cancel',
    'CmdCancelRevive': 'cancel', 'CmdRally': 'rally', 'CmdPurchase': 'purchase',
    'CmdSelectSkill': 'skill',
}


def list_fields(value):
    """`hfoo,hrif,hkni` -> the ids. Warcraft III separates with commas and allows spaces."""
    if not isinstance(value, str):
        return []
    return [v.strip() for v in value.split(',') if v.strip() and len(v.strip()) == 4]


def buttonpos(value):
    """`3,0` -> [3, 0]; the cell the game puts this button in on the four-by-three card."""
    try:
        x, y = str(value).split(',')
        return [int(x), int(y)]
    except (ValueError, AttributeError):
        return None


def main():
    # ---- the card's own buttons
    cmd_src = UNITS / 'CommandFunc.txt'
    commands = {}
    if cmd_src.exists():
        art_index = json.loads(Path('data/btn_icons.json').read_text()) \
            if (DATA / 'btn_icons.json').exists() else {}
        for cid, row in parse_profile(str(cmd_src)).items():
            key = COMMANDS.get(cid)
            if not key:
                continue
            commands[key] = {
                'icon': find_art(art_index, row.get('Art')),
                'cell': buttonpos(row.get('Buttonpos') or row.get('ButtonPos')),
            }
    # A row that has no cell in CommandFunc still draws one -- the game falls back to
    # filling the card -- so it is given none of its own and the client lays it out.
    (DATA / 'commands.json').write_text(json.dumps(dict(sorted(commands.items())), indent=1))
    withArt = sum(1 for v in commands.values() if v['icon'])
    withCell = sum(1 for v in commands.values() if v['cell'])
    print('  %-14s %4d commands, %d with art, %d with a cell'
          % ('command card', len(commands), withArt, withCell))

    # ---- what each unit type produces, researches, sells
    units = json.loads((DATA / 'unittypes.json').read_text())
    profiles = {}
    for path in sorted(UNITS.glob('*UnitFunc.txt')):
        for uid, row in parse_profile(str(path)).items():
            profiles.setdefault(uid, {}).update(row)
    filled = {k: 0 for k in LIST_FIELDS.values()}
    for uid, row in profiles.items():
        target = units.get(uid)
        if not target:
            continue
        for src, dst in LIST_FIELDS.items():
            got = list_fields(row.get(src))
            if got:
                target[dst] = got
                filled[dst] += 1
    (DATA / 'unittypes.json').write_text(json.dumps(units, indent=1, ensure_ascii=False))
    print('  %-14s %4d types' % ('unit types', len(units)))
    for dst, n in filled.items():
        print('  %-14s %4d' % ('  ' + dst, n))

    # The card itself only needs a handful of columns from each type: what it is called, what
    # it draws, what it costs and what it offers. unittypes.json is 1.2 MB of the whole table
    # and would go over the wire for every client to read a dozen fields out of, so the card's
    # own table is written alongside it. Same ids, same values -- nothing is decided here.
    CARD_FIELDS = ('name', 'icon', 'gold', 'buildTime', 'isBuilding', 'foodMade',
                   'mana', 'manaStart', 'abilities', 'trains', 'researches', 'builds',
                   'sellsUnits', 'sellsItems')
    card = {uid: {f: row[f] for f in CARD_FIELDS if f in row} for uid, row in units.items()}
    (DATA / 'unit_card.json').write_text(json.dumps(dict(sorted(card.items())), indent=1,
                                                  ensure_ascii=False))
    print('  %-14s %4d types -> unit_card.json'
          % ('card types', len(card)))

    # The command card only ever offers what exists, so the counts worth knowing are these:
    # how many buildings produce something at all, and how many units a card can hold.
    producers = sum(1 for u in units.values() if u.get('trains'))
    biggest = max((len(u.get('trains') or []) for u in units.values()), default=0)
    shops = sum(1 for u in units.values() if u.get('sellsUnits'))
    builders = sum(1 for u in units.values() if u.get('builds'))
    print('  buildings that train: %d, most offered by one: %d, shops: %d, builders: %d'
          % (producers, biggest, shops, builders))


if __name__ == '__main__':
    main()