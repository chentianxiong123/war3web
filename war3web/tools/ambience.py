"""The ambient themes, rendered from Warcraft III's own MIDI and soundbank.

SetAmbientDaySound("CityScapeDay") names a row in UI\\SoundInfo\\MIDISounds.slk,
not in AmbienceSounds.slk, and that row is a pair of files rather than a clip:
a MIDI score and the DLS instrument bank it is played on -- CityScapeDay.mid
against CityScape.dls, both in war3.mpq. Warcraft III renders them through
DirectMusic at play time. Nothing in a browser can do that, so they are rendered
here instead, once, with the game's own bank, and shipped as ordinary audio.

The rendering is FluidSynth's rather than DirectMusic's, so it is the map's own
score and the map's own instruments but not bit-for-bit what the game produces.
That is the one approximation here and it is named rather than hidden.

Map-agnostic: the labels come from the map's own script, so a map naming a
different theme gets that theme and nothing else is rendered.

Needs fluidsynth (2.x, for DLS support) and ffmpeg with libvorbis. Without
fluidsynth this prints what it would have done and writes an empty table, so the
rest of the pipeline is unaffected.
"""
import os, re, sys, json, shutil, subprocess
sys.path.insert(0, os.path.dirname(__file__))
from gamedata import GameData
from slk import parse_slk

OUT_DIR = 'assets/sounds/sound/ambient'
TMP = '.tmp/ambience'
gd = GameData()

rows = {}
for r in parse_slk('war3_extracted/UI/SoundInfo/MIDISounds.slk'):
    lab = str(r.get('SoundLabel') or '').strip()
    if lab:
        rows[lab.lower()] = r

# what the map itself asks for
script = open('extracted/war3map.j', encoding='latin-1').read()
want = []
for fn in ('SetAmbientDaySound', 'SetAmbientNightSound', 'SetAmbientSound'):
    for m in re.finditer(re.escape(fn) + r'\("([^"]*)"\)', script):
        if m.group(1) and m.group(1) not in want:
            want.append(m.group(1))
print('the map asks for %d ambient theme(s): %s' % (len(want), ', '.join(want) or '(none)'))

have_fs = shutil.which('fluidsynth')
have_ff = shutil.which('ffmpeg')
table = {}
if want and (not have_fs or not have_ff):
    print('  fluidsynth or ffmpeg missing -- nothing rendered; the themes stay silent')

os.makedirs(TMP, exist_ok=True)
for label in want:
    row = rows.get(label.lower())
    if not row:
        print('  %-18s no MIDISounds row' % label); continue
    base = str(row.get('DirectoryBase') or '').strip().rstrip('\\')
    mid, dls = str(row.get('MIDIFileName') or ''), str(row.get('DLSFileName') or '')
    if not mid or not dls:
        print('  %-18s row names no MIDI or no bank' % label); continue
    midp, dlsp = base + '\\' + mid, base + '\\' + dls
    md, msrc = gd.read(midp)
    dd, dsrc = gd.read(dlsp)
    if not md or not dd:
        print('  %-18s %s / %s not in the archives' % (label, midp, dlsp)); continue
    if not (have_fs and have_ff):
        continue
    fm, fd = os.path.join(TMP, mid), os.path.join(TMP, dls)
    open(fm, 'wb').write(md)
    if not os.path.exists(fd) or os.path.getsize(fd) != len(dd):
        open(fd, 'wb').write(dd)
    wav = os.path.join(TMP, label + '.wav')
    # -g 1.0 is unity. FluidSynth's own default is 0.2, which is a synthesiser
    # setting rather than anything the game states, and it renders these 14 dB
    # quieter than they should be: the day theme peaks at -28.6 dB at the
    # default and -14.6 dB at unity, with no clipping either way.
    r = subprocess.run(['fluidsynth', '-ni', '-g', '1.0', '-T', 'wav', '-F', wav,
                        '-r', '44100', fd, fm], capture_output=True)
    if r.returncode != 0 or not os.path.exists(wav):
        print('  %-18s fluidsynth failed: %s' % (label, r.stderr.decode()[-120:])); continue
    os.makedirs(OUT_DIR, exist_ok=True)
    ogg = os.path.join(OUT_DIR, label.lower() + '.ogg')
    r2 = subprocess.run(['ffmpeg', '-y', '-hide_banner', '-loglevel', 'error',
                         '-i', wav, '-c:a', 'libvorbis', '-q:a', '3', '-ac', '2', ogg],
                        capture_output=True)
    os.remove(wav)
    if r2.returncode != 0 or not os.path.exists(ogg):
        print('  %-18s ffmpeg failed: %s' % (label, r2.stderr.decode()[-120:])); continue
    # Volume is the row's own, out of 127 the way every other sound table here
    # states it. Channel 15 is Warcraft III's ambient channel.
    table[label] = {
        'file': ogg[len('assets/'):].replace(os.sep, '/'),
        'volume': round(float(row.get('Volume') or 127) / 127.0, 4),
        'source': '%s (%s) + %s (%s)' % (mid, msrc, dls, dsrc),
    }
    print('  %-18s %s  %.1f MB  vol %.2f'
          % (label, table[label]['file'], os.path.getsize(ogg) / 1e6, table[label]['volume']))

os.makedirs('data', exist_ok=True)
json.dump(table, open('data/ambience.json', 'w'), indent=1)
print('ambient themes rendered: %d' % len(table))
