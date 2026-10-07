"""The day/night colour curves, out of Warcraft III's own DNC models.

SetDayNightModels names two MDX files -- a terrain one and a unit one -- and
they are not scenery: each carries a single light called FDirectSun whose colour
(KLAC) and ambient colour (KLBC) are animated across a sequence that IS the day.
This map asks for DNCLordaeron, and the renderer had been lighting the world with
three constants of its own instead (a hemisphere at 0xa9c2e8/0x2a2620 and a
directional at 0xfff0d8, all at 1.15).

Only the colours and intensities are carried through. The light's rotation
(KGRT) is a single static key and the axis convention that turns that quaternion
into a world direction is not something these files state, so the renderer keeps
the sun position it already had rather than a guess.

Written by hand rather than through mdx2gltf because there is no geometry here to
convert: the whole model is one light and one particle emitter.
"""
import os, sys, json, glob
sys.path.insert(0, os.path.dirname(__file__))
import mdx

OUT = {}
roots = sorted(glob.glob('war3_extracted/Environment/DNC/*/*/*.mdx'))
for p in roots:
    try:
        m = mdx.parse(p)
    except Exception as e:
        print('  skipped %s (%s)' % (p, e)); continue
    lights = m.get('lights') or []
    seqs = m.get('sequences') or []
    if not lights or not seqs:
        print('  skipped %s (no light or no sequence)' % p); continue
    L, seq = lights[0], seqs[0]
    start, end = float(seq['start']), float(seq['end'])
    span = max(1.0, end - start)

    def curve(code):
        tr = (L.get('tracks') or {}).get(code)
        if not tr: return []
        out = []
        for k in tr['keys']:
            t, v = k[0], k[1]
            if not isinstance(v, list) or len(v) < 3: continue
            hour = 24.0 * (float(t) - start) / span
            out.append([round(max(0.0, min(24.0, hour)), 4),
                        round(v[0], 5), round(v[1], 5), round(v[2], 5)])
        out.sort(key=lambda r: r[0])
        return out

    # the model path as the script names it, lower-cased with backslashes --
    # the same shape server/jass/engine.js hands to the client
    rel = p.replace('war3_extracted' + os.sep, '').replace(os.sep, '\\')
    key = os.path.splitext(rel)[0].lower()
    OUT[key] = {
        'color': curve('KLAC'),
        'ambient': curve('KLBC'),
        'intensity': round(float(L.get('intensity') or 1.0), 4),
        'ambIntensity': round(float(L.get('ambIntensity') or 0.0), 4),
        'name': L.get('name') or '',
    }

os.makedirs('data', exist_ok=True)
json.dump(OUT, open('data/daynight.json', 'w'), indent=1)
print('day/night curves for %d models' % len(OUT))
for k, v in OUT.items():
    print('  %-58s %d colour keys, %d ambient, sun %.2f amb %.2f'
          % (k, len(v['color']), len(v['ambient']), v['intensity'], v['ambIntensity']))
