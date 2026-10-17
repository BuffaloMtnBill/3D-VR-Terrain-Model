"""Low-resolution relief for the VR map: a small height grid for each map tile, from the elevation tiles the
generator already downloads and caches.

A map tile at zoom z is sampled from the elevation tile three zooms coarser (at most zoom 15, the finest Terrarium
has), where it covers 32 × 32 pixels: the grid then matches the map's detail, sibling tiles share their edge
pixels, and one elevation download serves up to 64 map tiles.
"""
from collections import OrderedDict
from threading import Lock

import numpy as np

MAX_ELEVATION_ZOOM = 15
COARSER = 3
SIZES = (9, 17, 33)


class ReliefTiles:
    def __init__(self, client, cached_tiles=64):
        self.client = client
        self.cached_tiles = cached_tiles
        self._tiles = OrderedDict()
        self._lock = Lock()

    def _elevation(self, zoom, x, y):
        key = (zoom, x, y)
        with self._lock:
            if key in self._tiles:
                self._tiles.move_to_end(key)
                return self._tiles[key]
        try:
            heights = self.client.tile(zoom, x, y)
        except ValueError as error:
            if "missing data" not in str(error):
                raise
            heights = None   # open sea and other gaps: flat
        with self._lock:
            self._tiles[key] = heights
            while len(self._tiles) > self.cached_tiles:
                self._tiles.popitem(last=False)
        return heights

    def grid(self, zoom, x, y, size=17):
        """Heights in meters on a size × size grid from the tile's north-west corner to its south-east corner
        (both edges included, so neighbours meet), and whether the area had elevation data."""
        if size not in SIZES:
            raise ValueError(f"Relief grids are {', '.join(map(str, SIZES))} points across.")
        if not (0 <= zoom <= 22 and 0 <= y < 2**zoom):
            raise ValueError("That map tile does not exist.")
        x %= 2**zoom
        source = max(0, min(MAX_ELEVATION_ZOOM, zoom - COARSER))
        shift = zoom - source
        heights = self._elevation(source, x >> shift, y >> shift)
        if heights is None:
            return np.zeros((size, size), dtype=np.float32), False
        # The map tile's place inside the elevation tile, in elevation pixels (pixel centers at i + 0.5).
        span = 256 / 2**shift
        left, top = (x - ((x >> shift) << shift)) * span, (y - ((y >> shift) << shift)) * span
        along = np.linspace(0, span, size)
        columns = np.clip(left + along - .5, 0, 255)
        rows = np.clip(top + along - .5, 0, 255)
        c0, r0 = np.floor(columns).astype(int), np.floor(rows).astype(int)
        c1, r1 = np.minimum(c0 + 1, 255), np.minimum(r0 + 1, 255)
        fc, fr = (columns - c0)[None, :], (rows - r0)[:, None]
        top_row = heights[np.ix_(r0, c0)] * (1 - fc) + heights[np.ix_(r0, c1)] * fc
        bottom_row = heights[np.ix_(r1, c0)] * (1 - fc) + heights[np.ix_(r1, c1)] * fc
        return (top_row * (1 - fr) + bottom_row * fr).astype(np.float32), True
