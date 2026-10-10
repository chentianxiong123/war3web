#!/usr/bin/env bash
# Full asset + data pipeline: map file and Warcraft III archives -> public/
#
# Map-agnostic: the .w3x in the working directory is found by tools/mapfile.py
# (override with FOC_MAP). Nothing below names a hero, ability or unit id.
set -euo pipefail
PY=${PY:-.venv/bin/python}

echo "== 1. unpack the map (MPQ, protected)"
$PY tools/names.py
$PY tools/extract_final.py

echo "== 2. map object data"
$PY tools/objdata.py extracted/war3map.w3u extracted/war3map.w3t \
                     extracted/war3map.w3a extracted/war3map.w3h extracted/war3map.w3q \
                     extracted/war3map.w3d extracted/war3map.w3b
$PY tools/w3i.py               # full map info: players/forces/camera/tileset/fog
$PY tools/unitsdoo.py          # pre-placed units: hp/mana/inventory/hero stats
$PY tools/w3r.py               # regions: weather/ambience rectangles
$PY tools/terrain.py
$PY tools/jass_fmt.py
# the day/night light curves, out of Warcraft III's own DNC models
$PY tools/daynight.py
# the ambient themes: MIDI + DLS out of the archives, rendered once to ogg
$PY tools/ambience.py

echo "== 3. Warcraft III archives (patch > expansion > base)"
$PY tools/gamedata.py
$PY tools/slk.py
$PY tools/unittypes.py
$PY tools/extract_blizzard.py
$PY tools/unittypes.py          # rerun: TFT tables are now present
$PY tools/abilities.py
$PY tools/itemtypes.py           # items: Blizzard base + the map's overrides
$PY tools/gameplay.py           # MiscGame.txt + the map's own war3mapMisc.txt
$PY tools/soundsets.py          # per-unit sound sets
# The interface art, which no map ever names: Warcraft III draws the console,
# the command card and the bars itself, so extract_blizzard.py has no reason to
# fetch any of it. Must precede convert_textures.py -- it lands the BLPs in
# war3_extracted/ and the converter is what puts them in the atlas.
$PY tools/extract_ui.py
# The command-card buttons, in full. extract_blizzard.py harvests the art slots the object
# tables name, which covers a model but not a button -- 693 of the archives' unit types name
# a button nothing pulled, so those drew with no icon at all while the art sat in the MPQs.
$PY tools/extract_icons.py

echo "== 4. convert assets"
$PY tools/convert_textures.py
$PY tools/mdx2gltf.py
$PY tools/extract_audio.py
$PY tools/cliffs.py             # a cliff mesh for every layer transition
$PY tools/bake_ground.py        # blend the matching ground tile around cliffs

echo "== 5. compile game data"
$PY tools/compile_game.py
# every object table's icon path, resolved to a URL the client can load. Runs after
# convert_textures.py (which is what put the files on disk) and after compile_game.py, which
# resolves the heroes' own icons itself.
$PY tools/icons.py
# What the command card offers, read from the archives rather than written out: Units\CommandFunc.txt
# for the card's own buttons (art + Buttonpos) and Units\*UnitFunc.txt for every unit type's
# Trains / Builds / Researches / Sellunits. Needs btn_icons.json, so it follows icons.py.
$PY tools/commands.py

echo "== 6. probe the map's own triggers"
# which target each spell needs; derived by casting every hero ability once,
# so it must run after compile_game.py has produced data/game.json
node tools/spell_targets.mjs

echo "== 7. stage into public/"
$PY tools/stage.py
# The console frame: ConsoleUI.fdf joined to war3skins.txt and the texture
# atlas. Needs assets/textures.json, so it follows convert_textures.py; writes
# public/data/console.json, which stage.py does not touch.
$PY tools/uiframe.py
$PY tools/hud_assets.py

echo "== 8. bake the lobby portraits"
# The map ships no hero icons -- every hero shows whatever icon the Warcraft III
# unit it was built from happened to have -- so the lobby draws each hero's own
# model instead. Rendering one means a browser, and a browser means the staged
# assets have to be served: hero_portraits.mjs drives tools/modelview.html over
# HTTP. Hence a server for the length of this step and no longer.
PORT=${FOC_PORT:-8077} node server/index.js >/dev/null 2>&1 &
SRV=$!
trap 'kill $SRV 2>/dev/null || true' EXIT
up=0
for _ in $(seq 60); do
  if node -e "require('net').connect(${FOC_PORT:-8077},'127.0.0.1')
              .on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null
  then up=1; break; fi
  sleep 1
done
[ "$up" = 1 ] || { echo "the server never came up on ${FOC_PORT:-8077}"; exit 1; }
PORT=${FOC_PORT:-8077} node tools/hero_portraits.mjs
kill $SRV 2>/dev/null || true
trap - EXIT

echo "== 9. verify"
# These three can fail now. boot_test and audit used to print their error counts
# and exit 0 whatever they were, so this stage was green over a broken boot.
$PY tools/cliff_test.py | tail -3
node tools/boot_test.mjs
node tools/audit.mjs | tail -8
echo
echo "the full suite is 'npm test' -- it starts its own server and runs everything"
