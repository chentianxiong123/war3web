"""Check the baked cliff mesh against the terrain it has to meet.

The cliff mesh and the ground mesh are built from the same w3e data by different
paths, so they only line up if the corner order, the cell the model is placed
over and its base height are all right. Wherever a cliff vertex meets visible
ground, its height must equal that vertex's surface height. Shared model grid
vertices must also agree where a transition covers the ground. A corner
order that is transposed, or a placement off by one cell, breaks this
immediately.
"""
import json, sys
import numpy as np
from terrain_surface import surface_heights

t = json.load(open('data/terrain.json'))
W, H, TS = t['width'], t['height'], t['tileSize']
OX, OY = t['offsetX'], t['offsetY']
hs = np.array(t['heights'], np.int16).astype(np.float32)
lay = np.array(t['layer'], np.uint8).astype(np.float32)
Z = surface_heights(t)

spec = json.load(open('data/cliffs.json'))
V = np.fromfile('data/cliffs.bin', '<f4').reshape(-1, spec['stride'])
print('cliff mesh: %d vertices, %d triangles' % (len(V), len(V) // 3))

# client space is (x, up, -y); go back to Warcraft III world coords
wx, up, wy = V[:, 0], V[:, 1], -V[:, 2]
fi = (wx - OX) / TS
fj = (wy - OY) / TS
on = (np.abs(fi - np.round(fi)) < 1e-3) & (np.abs(fj - np.round(fj)) < 1e-3)
i = np.round(fi[on]).astype(int)
j = np.round(fj[on]).astype(int)
inside = (i >= 0) & (i < W) & (j >= 0) & (j < H)
i, j, zc = i[inside], j[inside], up[on][inside]
zg = Z[j * W + i]
d = np.abs(zc - zg)
# Adjacent models must agree with one another even where no ground is drawn.
# This catches a bad transition-to-cliff join hidden by the exposure mask.
seams = {}
for ci, cj, height in zip(i, j, zc):
    seams.setdefault((int(ci), int(cj)), []).append(float(height))
split = {k: max(v) - min(v) for k, v in seams.items() if max(v) - min(v) > .5}
print('shared cliff grid points with inconsistent heights: %d' % len(split))
# Transition models introduce internal grid points (the half-height ramp
# ridge) that have no ground beneath them. Validate the seam where ground
# actually meets the model, not hidden grid heights inside its footprint.
cells = set(spec['cells'])
cw = W - 1
exposed = np.array([any(0 <= x < W - 1 and 0 <= y < H - 1 and y * cw + x not in cells
                       for x in (ci - 1, ci) for y in (cj - 1, cj)) for ci, cj in zip(i, j)])
d = d[exposed]
print('vertices landing on a terrain grid point: %d of %d (%.1f%%)'
      % (len(d), len(V), 100.0 * len(d) / len(V)))
tol = 0.5
bad = d > tol
print('height mismatch > %.1f: %d (%.2f%%)   max %.2f  mean %.4f'
      % (tol, int(bad.sum()), 100.0 * bad.mean(), float(d.max()), float(d.mean())))

# every cell the mesh covers must be one the ground mesh left out, and vice versa
covered = set()
for a in range(0, len(V), 3):
    tri = V[a:a + 3]
    cx = (tri[:, 0].mean() - OX) / TS
    cy = (-tri[:, 2].mean() - OY) / TS
    covered.add((int(np.floor(cy + 1e-6)) * cw) + int(np.floor(cx + 1e-6)))
print('cells declared: %d, cells the triangles actually cover: %d, difference: %d'
      % (len(cells), len(covered), len(cells ^ covered)))

# a cliff cell must be one whose corners differ in layer, and not a ramp
lay2 = lay.reshape(H, W)
wrong = 0
transition_cells = {c for tr in spec.get('transitions', []) for c in tr['cells']}
for c in sorted(cells):
    cj, ci = divmod(c, cw)
    corners = {lay2[cj, ci], lay2[cj + 1, ci], lay2[cj, ci + 1], lay2[cj + 1, ci + 1]}
    if len(corners) == 1 and c not in transition_cells:
        wrong += 1
print('flat cells covered without a transition model (should be 0): %d' % wrong)

ok = (not bad.any()) and not (cells ^ covered) and wrong == 0 and not split
print('\n%s' % ('PASS' if ok else 'FAIL'))
sys.exit(0 if ok else 1)
