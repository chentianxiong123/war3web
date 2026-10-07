"""Render data/spell_check.json as a single self-contained page.

    node tools/spell_check.mjs --json      # what each spell does
    node tools/spell_render.mjs            # whether it draws anything
    python3 tools/spell_sheet.py           # -> .tmp/spell_sheet.html
"""
import json, os, datetime

rows = json.load(open('data/spell_check.json'))
game = json.load(open('data/game.json'))

DOES = ['mismatch', 'partial', 'unknown', 'ok', 'passive']
DOES_BLURB = {
    'mismatch': 'the tooltip promises one thing, the cast does another',
    'partial':  'the right kind of thing, but not all of it, or not the stated numbers',
    'unknown':  'no tooltip text to check against',
    'ok':       'does what it says',
    'passive':  'not castable, so nothing to cast',
}
SHOWS = ['no-art', 'invisible', 'model-failed', 'draws', 'morph', 'n/a']
SHOWS_BLURB = {
    'no-art':       'the cast emits no effect for the client to draw',
    'invisible':    'art loads, but nothing reaches the screen',
    'model-failed': 'art is named, but no model loads',
    'draws':        'something visible appears',
    'morph':        'no effect art, because the caster changes form -- the new body is the effect',
    'n/a':          'passive, so nothing is drawn',
}


def shows_of(r):
    v = r.get('render')
    if not r.get('got') or r['got'].get('cast') != 'ok':
        return 'n/a'
    if v is None:
        return 'n/a'
    if v.get('pixels', 0) > 40:
        return 'draws'
    # Metamorphosis carries no effect art in Warcraft III's own data, because
    # the transformation *is* the visual: the hero is swapped for another unit.
    # The bench replays effects into an empty scene and cannot see that, so ask
    # the behaviour measurement instead.
    if r['got'].get('morph'):
        return 'morph'
    if not v.get('asked'):
        return 'no-art'
    if not v.get('spawned'):
        return 'model-failed'
    return 'invisible'


for r in rows:
    r['shows'] = shows_of(r)

rank_d = {v: i for i, v in enumerate(DOES)}
rank_s = {v: i for i, v in enumerate(SHOWS)}
rows.sort(key=lambda r: (min(rank_d.get(r['verdict'], 9), rank_s.get(r['shows'], 9)),
                         rank_d.get(r['verdict'], 9), r['hero'], r['id']))

counts = {}
shows_counts = {}
for r in rows:
    counts[r['verdict']] = counts.get(r['verdict'], 0) + 1
    shows_counts[r['shows']] = shows_counts.get(r['shows'], 0) + 1

# The first run of this audit, before any of it was fixed. Kept as a fixed
# record rather than recomputed: it is what the map did on 2026-08-24, and the
# point of the page is the distance travelled from it.
BASELINE = {'does': {'ok': 57, 'partial': 55, 'mismatch': 7, 'passive': 11},
            'shows': {'draws': 84, 'no-art': 33, 'invisible': 2, 'n/a': 11}}

rendered = sum(1 for r in rows if r.get('render'))
payload = json.dumps({'rows': rows, 'does': DOES, 'shows': SHOWS,
                      'doesBlurb': DOES_BLURB, 'showsBlurb': SHOWS_BLURB,
                      'counts': counts, 'showsCounts': shows_counts,
                      'baseline': BASELINE},
                     ensure_ascii=False, separators=(',', ':'))

TPL = open('tools/spell_sheet.tpl.html', encoding='utf-8').read()
out = (TPL.replace('/*__DATA__*/null', payload)
          .replace('__TOTAL__', str(len(rows)))
          .replace('__HEROES__', str(len(game['heroes'])))
          .replace('__RENDERED__', str(rendered))
          .replace('__DATE__', datetime.date.today().isoformat()))

os.makedirs('.tmp', exist_ok=True)
open('.tmp/spell_sheet.html', 'w', encoding='utf-8').write(out)
print('.tmp/spell_sheet.html  (%d abilities across %d heroes)' % (len(rows), len(game['heroes'])))
print('  does:  ' + '  '.join('%s %d' % (v, counts[v]) for v in DOES if counts.get(v)))
print('  shows: ' + '  '.join('%s %d' % (v, shows_counts[v]) for v in SHOWS if shows_counts.get(v)))
