"""Compile the icon path every object table already carries into a URL the client can load.

Warcraft III stores an icon as a path into its own archives -- ``UnitButtons\\Icons`` and
``ReplaceableTextures\\CommandButtons``, a .blp like every other piece of art. The tables the
pipeline builds keep that path verbatim (``unittypes.json`` -> ``icon``, ``abilities.json``
-> ``art.icon``, ``itemtypes.json`` -> ``icon``), which is right: the path is what the game
itself records, and it is the only spelling of the file that survives a map swap.

Nothing can load it, though. The client wants a URL under the served root, and the .blp has
been converted to .png by the texture step in the meantime. So the last stage of the pipeline
resolves each path against the texture index the converter wrote and emits the URL.

That is what ``compile_game.py``'s ``find_icon`` does for the heroes it compiles into
game.json -- and it is why they draw correctly there while everything else does not: nothing
downstream of it ever ran the same resolution over the abilities, units and items, which is
the whole of a melee map's roster. Doing it here instead, once, for every table at once, is
the same answer with one implementation.

Three tables come out, all in the same shape the client already reads:

    data/icons.json          unit type id  -> icon URL   (was hand-maintained, 140 of 839)
    data/ability_icons.json  ability id    -> icon URL   (was never emitted at all)
    data/item_icons.json     item id       -> icon URL   (was never emitted at all)

A URL is only written when the file it names is actually on disk, so a path nothing ever
extracted cannot become a broken <img>: Warcraft III's own tables name art that shipped in a
retail archive we were not given, and the archives differ by patch. The count of those is
printed rather than swallowed -- it is the honest size of the gap.

    python3 tools/icons.py
"""
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, os.path.dirname(__file__))

ASSETS = Path('assets')
DATA = Path('data')
# Icons are written as paths relative to the served asset root, which is what
# compile_game.py's find_icon already produces for the heroes it compiles into game.json and
# what every client-side consumer expects: they all do `/assets/` + value. Storing a
# full URL here instead would work until the first place that also joins the prefix, and
# then that URL would be served as `/assets//assets/...`.
PREFIX = ''

# Warcraft III matches an art path by basename far more often than by full path: the tables
# name the same button under different trees, and some name it with an extension the index
# does not have. Index on the bare stem, lowercase.
def _stem(path):
    base = str(path).replace('/', '\\').split('\\')[-1]
    return os.path.splitext(base)[0].lower()


# A basename is not unique across the whole art tree, and where it collides the trees are not
# equal. `BTNTemp` is a blank template used as a texture in Textures\, and it is also the
# button an unimplemented command shows; indexed first-wins it resolved to the blank one and
# put an empty square where an icon belongs. The trees that hold a *button* outrank the ones
# that hold a model or a ground tile, and a full path match beats any of them.
BUTTON_TREES = ('replaceabletextures\\commandbuttons\\',
                'replaceabletextures\\passivebuttons\\',
                'unitbuttons\\icons\\',
                'replaceabletextures\\commandbuttonsdisabled\\')


def _rank(path):
    low = str(path).replace('/', '\\').lower()
    for i, tree in enumerate(BUTTON_TREES):
        if low.startswith(tree):
            return i
    return len(BUTTON_TREES)


def load_index():
    """basename stem -> served URL.

    convert_textures.py's own index is the primary source, but it only covers what that
    script converted. hud_assets.py writes straight into assets/textures/ from the
    archives instead, and anything staged by hand lands the same way -- so the tree on disk
    is swept as well. A file that exists but is unindexed is a real button with a real icon,
    and the index is a record of one conversion run, not the truth about the tree.

    A stem can be reached from several places; the best-ranked spelling is kept, so the
    button tree wins over the texture tree and the lit button over the dimmed copy.
    """
    best = {}
    index = json.loads((ASSETS / 'textures.json').read_text())
    for raw, served in index.items():
        best.setdefault(_stem(raw), []).append((_rank(raw), PREFIX + served.lstrip('/')))
    for path in (ASSETS / 'textures').rglob('*'):
        if path.suffix.lower() == '.png':
            rel = path.relative_to(ASSETS).as_posix()
            best.setdefault(_stem(path.name), []).append((_rank(rel), PREFIX + rel))

    # a stem may list a file that is not there any more (the converter rewrites its tree),
    # so the first choice is only taken once it has been checked
    by_stem = {}
    for stem, opts in best.items():
        for rank, url in sorted(opts):
            if (ASSETS / url[len(PREFIX):]).exists():
                by_stem[stem] = url
                break
    print('texture index: %d from textures.json, %d stems after sweeping assets/textures'
          % (len(index), len(by_stem)))
    return by_stem


def resolve(index, path):
    """The URL for one art path, or None when nothing on disk matches it."""
    if not isinstance(path, str) or not path:
        return None
    url = index.get(_stem(path))
    if url and (ASSETS / url[len(PREFIX):]).exists():
        return url
    return None


def compile_table(index, table, *fields, name=''):
    """{id: url} for the first of `fields` that resolves to a real file.

    A field is a path into the row, so ``('icon',)`` reads the flat column unittypes.json and
    itemtypes.json carry while ``('art', 'icon')`` reads abilities.json's nested one.
    """
    out, unresolved = {}, []
    for key, row in table.items():
        if not isinstance(row, dict):
            continue
        for path in fields:
            node = row
            for step in path:
                if not isinstance(node, dict):
                    node = None
                    break
                node = node.get(step)
            url = resolve(index, node)
            if url:
                out[key] = url
                break
            if node:
                unresolved.append((key, node))
    if unresolved:
        print('  %-14s %4d named an art path with no file behind it' % (name, len(unresolved)))
    return out


def main():
    index = load_index()

    specs = [
        ('icons.json', 'unittypes.json', (('icon',),), 'units'),
        ('ability_icons.json', 'abilities.json', (('art', 'icon'),), 'abilities'),
        ('item_icons.json', 'itemtypes.json', (('icon',),), 'items'),
    ]

    DATA.mkdir(parents=True, exist_ok=True)
    total, missing = 0, 0
    for out_name, table_name, fields, label in specs:
        path = DATA / table_name
        if not path.exists():
            print('  %-14s no %s -- skipped' % (label, table_name))
            continue
        table = json.loads(path.read_text())
        compiled = compile_table(index, table, *fields, name=label)
        rows = len(table) if isinstance(table, dict) else 0
        missing += rows - len(compiled)
        total += len(compiled)
        flat = dict(sorted(compiled.items()))
        (DATA / out_name).write_text(json.dumps(flat, indent=1, ensure_ascii=False))
        print('  %-14s %4d of %4d -> %s' % (label, len(flat), rows, out_name))

    print('icons: %d resolved, %d with no art on disk' % (total, missing))
    button_icons(index)
    ability_meta(index)


def button_icons(index):
    """Every button the archives name, by bare name, so a command can ask for its own.

    The object tables say what a *unit* draws -- unittypes.json's icon column, abilities'
    art.icon -- but a command is not in any table. Move, Stop, Hold Position, Attack,
    Patrol, Build and Cancel are named by the engine rather than by data, and the only place
    they are written down is the button art itself: ReplaceableTextures\\CommandButtons\\
    BTNMove.blp, BTNStop.blp and the rest, which extract_icons.py now pulls in full.

    A previous run of the pipeline kept a second copy of seven of these under public/assets/ui/
    written by tools/hud_assets.py, and the card asked for them there. Same files, decoded
    twice into two places, one of which no build step can rebuild -- so the card named an
    icon that a rebuilt tree would not have. They are looked up here instead, from the
    archives' own names.

    The whole directory is listed, not just the commands: the card also needs the cancel
    button, the hero-skill button, and whatever a map's own triggers ask for.

    Keys are lowercase bare names, so the caller writes BTN_ICONS.btnmove.
    """
    out = {}
    for path in (ASSETS / 'textures/ReplaceableTextures/CommandButtons').glob('*.png'):
        out[path.stem.lower()] = 'textures/ReplaceableTextures/CommandButtons/' + path.name
    for tree in ('PassiveButtons',):
        d = ASSETS / 'textures/ReplaceableTextures' / tree
        if d.is_dir():
            for path in d.glob('*.png'):
                out[path.stem.lower()] = f'textures/ReplaceableTextures/{tree}/' + path.name
    if not out:
        print('  %-14s no CommandButtons directory -- run tools/extract_icons.py' % 'button art')
        return
    (DATA / 'btn_icons.json').write_text(json.dumps(dict(sorted(out.items())), indent=1))
    print('  %-14s %4d -> btn_icons.json' % ('button art', len(out)))


LEVEL_FIELDS = ('mana', 'cooldown', 'range', 'castTime', 'area', 'duration')


def ability_meta(index):
    """One file holding everything a command-card button needs, so the client fetches once.

    An ability button is drawn from the art, the name, the cost and the cooldown, and a
    button that cannot be cast is greyed -- which means the cost and the cooldown have to be
    on the client as well as the server. abilities.json carries all of it, but it also
    carries every data slot of every level of 800 abilities, four times the size, none of
    which the card draws. The name and the tooltip are not here either: those are the
    archives' own localised text and tools/hud_assets.py writes it to hud.json, which the
    card already reads.

    Levels are kept rather than flattened to the first: a priest's Heal costs more at rank
    three, and the button has to grey out on the real number. Three ranks is what any
    command card in the game ever shows.
    """
    path = DATA / 'abilities.json'
    if not path.exists():
        print('  %-14s no abilities.json -- skipped' % 'ability card')
        return
    table = json.loads(path.read_text())
    out = {}
    for aid, row in table.items():
        levels = []
        for lv in (row.get('levels') or [])[:3]:
            levels.append({k: lv.get(k) for k in LEVEL_FIELDS})
        out[aid] = {
            'icon': resolve(index, (row.get('art') or {}).get('icon')),
            'base': row.get('base') or aid,
            'targets': row.get('targets') or '',
            'order': row.get('order') or '',
            'passive': bool(row.get('passiveArt')),
            'levels': levels,
        }
    (DATA / 'ability_meta.json').write_text(json.dumps(dict(sorted(out.items())), indent=1))
    print('  %-14s %4d -> ability_meta.json' % ('ability card', len(out)))


if __name__ == '__main__':
    main()