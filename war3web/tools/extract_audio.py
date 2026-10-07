"""Extract Warcraft III audio (Huffman+ADPCM) and encode it for the browser.

Decoding and encoding are both CPU-bound and independent per file, so they run
across a process pool.

Two different things used to be counted as one number called "unavailable": a
path the listfile names that is not actually in any archive, which is normal and
expected, and ffmpeg refusing to encode, which is not. An ffmpeg built without
libvorbis produces zero of the 6 192 sounds and every one of them lands in the
same bucket -- so the pipeline printed "unavailable: 6192" and exited 0. They
are separated below, ffmpeg's own words are kept for the first few failures, and
a run that encodes nothing is an error rather than a report.
"""
import os, sys, subprocess, json
from concurrent.futures import ProcessPoolExecutor
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

OUT = 'war3_extracted'
WEB = 'assets/sounds'
# How many encode failures are tolerable before the run is called broken. The
# archives do hold the occasional malformed clip; they do not hold hundreds.
FLOOR = int(os.environ.get('FOC_AUDIO_FAIL_FLOOR', '20'))
_gd = None


def gd():
    global _gd
    if _gd is None:
        from gamedata import GameData
        _gd = GameData()
    return _gd


def one(ap):
    """Decode one archive path and encode it to ogg.

    -> (key, webpath|None, why) where `why` is '' on success, 'absent' when no
    archive holds the path, and ffmpeg's own message when the encode failed.
    """
    rel = ap.replace('\\', '/')
    key = rel.lower()
    web = os.path.join(WEB, os.path.splitext(key)[0] + '.ogg')
    if os.path.exists(web) and os.path.getsize(web) > 0:
        return key, os.path.relpath(web, 'assets').replace(os.sep, '/'), ''
    try:
        data, _src = gd().read(ap)
    except Exception:
        return key, None, 'absent'
    if not data:
        return key, None, 'absent'
    raw = os.path.join(OUT, ap.replace('\\', os.sep))
    os.makedirs(os.path.dirname(raw), exist_ok=True)
    with open(raw, 'wb') as f:
        f.write(data)
    os.makedirs(os.path.dirname(web), exist_ok=True)
    try:
        r = subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', raw,
                            '-c:a', 'libvorbis', '-q:a', '2', '-ar', '22050', web],
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    except FileNotFoundError:
        return key, None, 'ffmpeg is not installed'
    if r.returncode == 0 and os.path.exists(web) and os.path.getsize(web) > 0:
        return key, os.path.relpath(web, 'assets').replace(os.sep, '/'), ''
    msg = (r.stderr or b'').decode('utf8', 'replace').strip().replace('\n', ' ')
    return key, None, msg[:200] or ('ffmpeg exit %d, no output' % r.returncode)


def main():
    from gamedata import GameData
    listing = GameData().listfile()
    audio = sorted(orig for low, orig in listing.items()
                   if low.endswith(('.wav', '.mp3')))
    os.makedirs(WEB, exist_ok=True)
    print('audio paths to try: %d' % len(audio), flush=True)
    index, absent, broken = {}, 0, []
    workers = max(2, min(14, (os.cpu_count() or 4) - 2))
    with ProcessPoolExecutor(max_workers=workers) as ex:
        for n, (key, web, why) in enumerate(ex.map(one, audio, chunksize=8), 1):
            if web:
                index[key] = web
            elif why == 'absent':
                absent += 1
            else:
                broken.append((key, why))
            if n % 500 == 0:
                print('  %d/%d  (%d ok, %d not in the archives, %d failed to encode)'
                      % (n, len(audio), len(index), absent, len(broken)), flush=True)
    json.dump(index, open('assets/sounds.json', 'w'), indent=0)
    size = sum(os.path.getsize(os.path.join(r, f))
               for r, _, fs in os.walk(WEB) for f in fs)
    print('converted/available: %d, not in the archives: %d, failed to encode: %d'
          % (len(index), absent, len(broken)))
    print('web audio: %.1f MB' % (size / 1e6))
    for k, why in broken[:10]:
        print('  FAIL %s: %s' % (k, why))
    if len(broken) > 10:
        print('  ... and %d more' % (len(broken) - 10))
    # A handful of odd files is the archives' business; a wall of them is ours,
    # and almost always one cause -- no ffmpeg, or an ffmpeg with no libvorbis.
    if broken and (len(broken) > FLOOR or not index):
        print('\naudio conversion failed: %d file(s) would not encode.' % len(broken))
        print('ffmpeg with libvorbis is required -- check `ffmpeg -encoders | grep vorbis`.')
        sys.exit(1)


if __name__ == '__main__':
    main()
