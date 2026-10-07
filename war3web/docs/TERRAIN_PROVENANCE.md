# Terrain transition work — 2026-09-07

The source implementation is in `tools/cliffs.py`, `tools/terrain_surface.py`
and `tools/bake_ground.py`. The generated meshes, textures and map data remain
local, ignored assets; they are not licensed by this project's MIT license.

## Local evidence

The local retail archives supply `TerrainArt/CliffTypes.slk`, which names
`rampModelDir` and `groundTile` separately from the ordinary cliff model directory.
For this map those fields name CityCliffTrans and Ysqd.

Measurements of the transition MDX files establish that these models occupy
two cells (256 by 128 units, or 128 by 256), with a midpoint at height 64 between
heights 0 and 128. L is that midpoint, while H stays at the high terrain vertex.
The four letters follow the same SW/NW/NE/SE ordering as the existing cliff code.

The new placement matcher keeps H at its authored grid vertex and accepts a
placement only when all four outer model corners match the terrain layer grid.
It rejects ambiguous or overlapping placements and leaves ordinary cliffs in
place when no matching model exists. Every accepted footprint is recorded so
the ground renderer removes both cells, including the flat half of the wedge.

The staging path raises the low vertices of an open, fully flagged ramp by
half a layer. Its preceding flat cell supplies the lower half of the slope.
This is checked against the transition vertices, rather than only comparing
two uses of the height formula. Ground immediately around cliffs uses the
cliff type's matching tile through the existing atlas blend masks.

## External reference and licensing

WarsmashModEngine's `Terrain.java` was consulted to cross-check terrain behavior:

- https://github.com/Retera/WarsmashModEngine/blob/master/core/src/com/etheller/warsmash/viewer5/handlers/w3x/environment/Terrain.java
- License checked: https://github.com/Retera/WarsmashModEngine/blob/master/LICENSE
- Upstream notice: MIT License, Copyright (c) 2020 Retera.

The full notice is retained in `THIRD_PARTY_NOTICES.md`. The Java file is not
vendored. The Python geometry matcher was written for this project's existing
MDX pipeline; it is not a translation of the external terrain loader.
The reference-informed surface behavior is explicitly attributed here. This
is not a claim of clean-room development or a license audit of that entire
upstream project. No code from its separately credited `calculateRamps`
routine was used.

## Verification

`tools/cliff_test.py` checks exposed terrain/model grid joins, agreement between
adjacent model heights, and actual triangle coverage against the omitted
ground cells. Hidden grid points within a transition are checked against other
models, not against the original flat ground that the transition replaces.

`tools/terrain_surface_test.py` checks the real map's transition footprints,
ramp midpoint geometry, preserved source data and boundary tile selection.
`tools/terrain_visual_test.mjs` checks the browser geometry, ground heights and
rendering; its screenshots are local verification artifacts.
