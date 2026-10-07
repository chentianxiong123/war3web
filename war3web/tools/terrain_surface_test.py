"""Check ramp placement against archive geometry and rotated map fixtures."""
import copy
import json
import numpy as np
from cliffs import classify, cliff_types, Models, place_transitions
from gamedata import GameData
from terrain_surface import surface_heights, ground_indices

t = json.load(open('data/terrain.json'))
original = copy.deepcopy(t)
spec = json.load(open('data/cliffs.json'))
models, types = Models(GameData()), cliff_types()
W, H = t['width'], t['height']
transitions = spec['transitions']
assert len(transitions) == 12, 'all twelve flagged transition edges in this map have art'
footprints = [c for tr in transitions for c in tr['cells']]
assert len(footprints) == len(set(footprints)) == 24
assert not set(footprints).intersection(spec['ramps'])

heights = surface_heights(t)
raw = (np.asarray(t['heights']) - 8192) / 4 + (np.asarray(t['layer']) - 2) * 128
raised = np.flatnonzero(heights != raw)
assert len(raised) == 6, 'three midpoint vertices on each base ramp'
assert np.all(heights[raised] - raw[raised] == 64)
# This checks the baked art, independently of the staging height formula.
v = np.fromfile('data/cliffs.bin', '<f4').reshape(-1, spec['stride'])
midpoints_on_art = 0
for k in raised:
    j, i = divmod(int(k), W)
    at = v[(abs(v[:, 0] - (t['offsetX'] + i * 128)) < .02)
           & (abs(v[:, 2] + t['offsetY'] + j * 128) < .02)]
    if len(at):
        assert np.all(abs(at[:, 1] - heights[k]) < .02)
        midpoints_on_art += 1
assert midpoints_on_art == 4, 'the two ends of each ramp meet transition ridges'

# Rotate the terrain rather than the implementation's orientation table. The
# archive models must cover the same cells in all four compass directions.
fields = ['layer', 'detail', 'flags', 'cliffTex', 'heights', 'tex']
mask = np.zeros((H - 1, W - 1), dtype=bool)
mask.ravel()[footprints] = True
for turns in (1, 2, 3):
    rt = dict(t)
    for field in fields:
        a = np.rot90(np.asarray(t[field]).reshape(H, W), turns)
        rt[field] = a.ravel().tolist()
    rt['height'], rt['width'] = a.shape
    cs, _ = classify(rt)
    placed = place_transitions(rt, cs, models, types)
    actual = {c for tr in placed if tr.get('transition') for c in tr['cells']}
    expected = set(np.flatnonzero(np.rot90(mask, turns).ravel()))
    assert actual == expected, f'transition footprints rotate correctly: {turns * 90} degrees'

ground, indices = ground_indices(t, spec, types)
cliff_tiles = {ground.index(types[c['cliffId']]['groundTile']) for c in classify(t)[0]}
changed = indices.ravel() != np.asarray(t['tex'])
assert changed.any(), 'the cliff boundary was previously using unrelated ground art'
assert set(indices.ravel()[changed]).issubset(cliff_tiles)
# Every changed point borders actual cliff geometry. Distant painted ground
# and the ramp interior are preserved.
covered = set(spec['cells'])
for k in np.flatnonzero(changed):
    j, i = divmod(int(k), W)
    assert any(0 <= x < W - 1 and 0 <= y < H - 1 and y * (W - 1) + x in covered
               for x in (i - 1, i) for y in (j - 1, j))
for c in spec['ramps']:
    j, i = divmod(c, W - 1)
    for k in (j * W + i, j * W + i + 1, (j + 1) * W + i, (j + 1) * W + i + 1):
        assert indices.ravel()[k] == t['tex'][k]
assert t == original, 'source map data must not be mutated'
print('PASS: 12 transitions, 24 disjoint cells, six ramp midpoints, three rotations, boundary tiles and source preservation')
