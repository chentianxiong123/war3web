"""Terrain surface rules shared by staging, texture baking and verification.

The transition MDX vertices establish the half-layer ramp midpoint. CliffTypes
supplies the matching ground tile. See docs/TERRAIN_PROVENANCE.md.
"""
import numpy as np


def surface_heights(t):
    W, H = t['width'], t['height']
    layers = np.asarray(t['layer']).reshape(H, W)
    flagged = np.asarray(t['flags']).reshape(H, W) & 1
    raised = np.zeros((H, W), dtype=bool)
    for j in range(H - 1):
        for i in range(W - 1):
            ls = layers[j:j + 2, i:i + 2]
            if flagged[j:j + 2, i:i + 2].all() and ls.max() - ls.min() == 1:
                raised[j:j + 2, i:i + 2] |= ls == ls.min()
    return ((np.asarray(t['heights'], dtype=np.float32) - 8192) / 4
            + (layers.ravel() - 2) * 128 + raised.ravel() * 64).astype(np.float32)


def ground_indices(t, cliff_spec, types):
    """Use each cliff's groundTile at its boundary so the atlas blends it out.

    The interior of an open ramp keeps its painted tile. A transition's extra
    cell is covered by its model too and contributes the same boundary tile.
    """
    W, H = t['width'], t['height']
    tiles = list(t['groundTiles'])
    result = np.asarray(t['tex'], dtype=np.int32).reshape(H, W).copy()
    cells = set(cliff_spec['cells'])
    ramps = set(cliff_spec['ramps'])
    for j in range(H):
        for i in range(W):
            around = [(x, y) for x in (i - 1, i) for y in (j - 1, j)
                      if 0 <= x < W - 1 and 0 <= y < H - 1]
            # An open ramp's corners are shared with its side transitions.
            # Only the actual cliff boundary should force the ground texture.
            if any(y * (W - 1) + x in ramps for x, y in around):
                continue
            for x, y in around:
                if y * (W - 1) + x not in cells:
                    continue
                ks = (y * W + x, (y + 1) * W + x, (y + 1) * W + x + 1, y * W + x + 1)
                ci = next((t['cliffTex'][k] for k in ks if t['cliffTex'][k] < len(t['cliffTiles'])), 0)
                if ci >= len(t['cliffTiles']):
                    continue
                tile = types.get(t['cliffTiles'][ci], {}).get('groundTile')
                if not tile or tile == '_':
                    continue
                if tile not in tiles:
                    tiles.append(tile)
                result[j, i] = tiles.index(tile)
                break
    return tiles, result
