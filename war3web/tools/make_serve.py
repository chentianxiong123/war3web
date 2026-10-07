"""Pack everything the game needs to run, and nothing it does not, into serve/.

The archives are build-time only. war3.mpq and its siblings are 820 MB of source
material that the pipeline reads once to produce data/ and assets/; the running
game never opens them, nor the .w3x, nor anything under tools/. What it does
need is the map's *script*, because the JASS VM executes it verbatim at boot,
and Blizzard's common.j and Blizzard.j alongside it.

    python3 tools/make_serve.py
    scp -r serve/ user@vps:/opt/foc

Then on the VPS see serve/README.md.
"""
import json, os, shutil, sys

OUT = 'serve'

# whole directories, copied as-is
TREES = [
    ('server', 'server'),                 # the simulation and the JASS VM
    ('client', 'client'),                 # the browser client
    ('shared', 'shared'),                 # constants both sides read
    ('public/data', 'public/data'),       # terrain, heights, walkability, cliffs
    ('public/assets', 'public/assets'),   # converted models, textures, sounds
    # FRIZQT__.TTF, the font the whole UI is set in. Left out of the bundle, the
    # deployed game 404s it and the browser falls back to a system face -- the
    # one difference from the real console that nothing here would have failed
    # on, since a missing font is not an error.
    ('public/fonts', 'public/fonts'),
]

# individual files, with the paths the runtime expects them at
FILES = [
    # the map's own script, run verbatim by the VM
    ('extracted/war3map.j', 'extracted/war3map.j'),
    # Blizzard's script library, which the map's script calls into
    ('war3_extracted/Scripts/common.j', 'war3_extracted/Scripts/common.j'),
    ('war3_extracted/Scripts/Blizzard.j', 'war3_extracted/Scripts/Blizzard.j'),
]

# compiled game data the server reads at boot
DATA = ['abilities.json', 'game.json', 'unittypes.json', 'itemtypes.json',
        'soundsets.json', 'gameplay.json', 'spell_targets.json',
        # which buffs draw something -- world.js filters the snapshot through
        # this, and reads it from data/ with no fallback to public/data, so a
        # bundle without it sends no buff art at all and every buff icon on
        # every unit silently disappears
        'buffart.json',
        # engine.js does fall back to public/data for this one, but the pack
        # carries the copy it prefers rather than relying on the fallback
        'ambience.json',
        # the build counter, so the deployed game reports the same build number
        # as the machine it was packed on rather than starting over at 1
        'build.json']

# the bundle is the same product as the source tree, so it carries the same
# version -- server/build.js reads it back out to label the build on screen
VERSION = json.load(open('package.json'))['version']

PACKAGE = {
    'name': 'foc-web-serve',
    'version': VERSION,
    'private': True,
    'type': 'module',
    'description': 'Fight of Characters 7.7b - browser port, runtime only',
    'scripts': {'start': 'node server/index.js'},
    # puppeteer-core and the rest of the toolchain are build-time only
    'dependencies': {'three': '^0.185.1', 'ws': '^8.18.0'},
    'engines': {'node': '>=20'},
}

README = """# FOC Web — running it

Everything here is runtime. The Warcraft III archives (`*.mpq`, ~820 MB) and the
`tools/` pipeline are **not** needed to run the game; they were only used to
produce `public/assets` and `data`.

## Ubuntu

    sudo apt update && sudo apt install -y nodejs npm
    node --version          # needs 20 or newer

If Ubuntu's Node is older than 20:

    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt install -y nodejs

Then:

    cd /opt/foc
    npm install --omit=dev
    PORT=8077 node server/index.js

Open `http://<vps-ip>:8077`.

## As a service

    sudo tee /etc/systemd/system/foc.service >/dev/null <<'UNIT'
    [Unit]
    Description=FOC Web
    After=network.target

    [Service]
    Type=simple
    WorkingDirectory=/opt/foc
    Environment=PORT=8077
    ExecStart=/usr/bin/node server/index.js
    Restart=on-failure
    User=www-data

    [Install]
    WantedBy=multi-user.target
    UNIT
    sudo systemctl enable --now foc
    sudo systemctl status foc

## Notes

- One process serves both the HTTP assets and the WebSocket, on the same port.
- The client pulls a few hundred MB of models on first load; put it behind nginx
  with caching if more than a handful of people will play.
- Open the port: `sudo ufw allow 8077/tcp`.
"""


def copy_tree(src, dst):
    if not os.path.isdir(src):
        print('  MISSING directory:', src)
        return 0
    target = os.path.join(OUT, dst)
    shutil.copytree(src, target, dirs_exist_ok=True)
    n = sum(len(f) for _, _, f in os.walk(target))
    print('  %-22s %d files' % (dst, n))
    return n


def copy_file(src, dst):
    if not os.path.exists(src):
        print('  MISSING file:', src)
        return False
    target = os.path.join(OUT, dst)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    shutil.copy2(src, target)
    return True


if os.path.exists(OUT):
    shutil.rmtree(OUT)
os.makedirs(OUT)

print('packing %s/' % OUT)
for src, dst in TREES:
    copy_tree(src, dst)

for src, dst in FILES:
    if copy_file(src, dst):
        print('  %-22s %.1f KB' % (dst, os.path.getsize(src) / 1024))

got = 0
for name in DATA:
    if copy_file(os.path.join('data', name), os.path.join('data', name)):
        got += 1
print('  %-22s %d of %d' % ('data', got, len(DATA)))

# the client is served from client/, so strip the build-only pages out of it
for junk in ('cliffview.html', 'fxview.html', 'modelview.html'):
    p = os.path.join(OUT, 'client', junk)
    if os.path.exists(p):
        os.remove(p)

json.dump(PACKAGE, open(os.path.join(OUT, 'package.json'), 'w'), indent=2)
open(os.path.join(OUT, 'README.md'), 'w').write(README)

size = sum(os.path.getsize(os.path.join(r, f))
           for r, _, fs in os.walk(OUT) for f in fs)
files = sum(len(f) for _, _, f in os.walk(OUT))
print('\n%s/: %d files, %.0f MB' % (OUT, files, size / 1e6))
print('left behind: the .mpq archives, the .w3x, tools/, and the raw extractions')
