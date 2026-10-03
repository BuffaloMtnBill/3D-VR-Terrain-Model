"""Capture a real DEM for a usable, offline-capable starter preview."""
import argparse
from pathlib import Path
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from terrain_app.elevation import Bounds, ElevationClient
from terrain_app.places import DEFAULT_PLACE, PRESETS
from terrain_app.services import default_cache_dir

root = Path(__file__).resolve().parents[1]
sys.stdout.reconfigure(errors="replace")  # progress messages contain characters some consoles cannot print
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--place", choices=PRESETS, default=DEFAULT_PLACE)
args = parser.parse_args()
bounds = Bounds.from_dict(PRESETS[args.place]["bounds"])
terrain = ElevationClient(default_cache_dir() / "elevation").fetch(bounds, 160, lambda fraction, message: print(message, flush=True))
target = root / "terrain_app" / "data" / f"{args.place}.npz"
target.parent.mkdir(parents=True, exist_ok=True)
np.savez_compressed(target, bounds=np.array([bounds.south, bounds.west, bounds.north, bounds.east, bounds.rotation_deg]),
                    elevations=terrain.elevations, zoom=terrain.zoom,
                    tile_count=terrain.tile_count, fetched_at=terrain.fetched_at)
print(f"Saved real terrain: {terrain.elevations.shape}, {terrain.elevations.min():.1f} to {terrain.elevations.max():.1f} m to {target}")
