"""Test-only server: deterministic surface classes, no public land-cover requests.

Run from the project root, then run tests/browser.cjs against port 8001.
The production app on port 8000 remains separate. DEM generation uses its normal
tile cache; maps, ZIP lookup and other feature data are intercepted by the test.
"""
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from terrain_app.landcover import COVER_NAMES
from terrain_app.server import create_app
from terrain_app.elevation import Terrain, grid_shape

ROOT = Path(__file__).resolve().parents[1]
# Fixed landscapes and terrain, so editing the app's own list never changes what the browser test sees.
LANDSCAPES = {
    "roan": {"name": "Roan Mountain", "label": "Roan Mountain, USA",
             "bounds": {"south": 36.080, "west": -82.165, "north": 36.145, "east": -82.055}},
    "rainier": {"name": "Mount Rainier", "label": "Mount Rainier, USA",
                "bounds": {"south": 46.775, "west": -121.865, "north": 46.930, "east": -121.645}},
    "fuji": {"name": "Mount Fuji", "label": "Mount Fuji, Japan",
             "bounds": {"south": 35.29, "west": 138.66, "north": 35.43, "east": 138.81}},
}
app = create_app({"TESTING": True, "LANDSCAPES": LANDSCAPES, "DEFAULT_LANDSCAPE": "roan",
                  "EXAMPLE_PATH": ROOT / "tests" / "fixtures" / "roan.npz"})


def fixture_cover(bounds):
    def stripe(index):
        left, right = index/6, (index+1)/6
        return {"outer": [[left, 0], [right, 0], [right, 1], [left, 1], [left, 0]], "holes": []}
    return {"regions": {name: [stripe(index)] for index, name in enumerate(COVER_NAMES)},
            "counts": dict.fromkeys(COVER_NAMES, 1), "bounds": bounds.to_dict(),
            "source": "SYNTHETIC SURFACE FIXTURE FOR TESTING ONLY", "source_url": "", "fetched_at": "2026-10-01T00:00:00Z"}


app.extensions["terrain"]["landcover"].fetch = fixture_cover


def fixture_features(bounds):
    data = json.loads((Path(__file__).resolve().parents[1] / "tests/fixtures/features.json").read_text(encoding="utf-8"))
    data["bounds"] = bounds.to_dict()
    return data


def fixture_buildings(bounds):
    data = fixture_features(bounds)
    data["layers"] = {name: features if name == "buildings" else [] for name, features in data["layers"].items()}
    return data


def fixture_other_features(bounds):
    data = fixture_features(bounds)
    data["layers"]["buildings"] = []
    return data


app.extensions["terrain"]["features"].fetch = fixture_other_features
app.extensions["terrain"]["features"].fetch_buildings = fixture_buildings
# The VR head start: recorded, never downloaded (GET /api/test/prefetched lists the areas, for the browser tests).
prefetched = []
app.extensions["terrain"]["features"].prefetch = lambda bounds, buildings=False: prefetched.append({**bounds.to_dict(), "buildings": buildings}) or True
app.add_url_rule("/api/test/prefetched", "test_prefetched", lambda: {"areas": prefetched})


def fixture_water(bounds):
    data = fixture_features(bounds)
    features = [{**feature, "id": f"usgs/{index}", "name": "USGS TEST CREEK"} for index, feature in enumerate(data["layers"]["water"])]
    return {"water": features, "source": "USGS TEST FIXTURE", "source_url": "https://www.usgs.gov/3d-hydrography-program", "bounds": bounds.to_dict()}


app.extensions["terrain"]["hydrography"].fetch = fixture_water

# Circle/oval interaction tests exercise generation without querying a public DEM service.
for source, client in app.extensions["terrain"]["clients"].items():
    original_fetch = client.fetch
    def shape_terrain(bounds, resolution, progress=None, source=source, original=original_fetch):
        if bounds.shape == "rectangle":
            return original(bounds, resolution, progress)
        rows, columns = grid_shape(bounds, resolution)
        y, x = np.mgrid[0:rows, 0:columns]
        elevations = (900+200*np.sin(x/columns*np.pi)*np.cos(y/rows*np.pi)).astype(np.float32)
        return Terrain(bounds, elevations, 11, 0, "2026-10-13T00:00:00Z", source=source)
    client.fetch = shape_terrain

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8001   # scripts/run-browser-tests.cjs may pick another
    print(f"TEST FIXTURES ONLY: http://127.0.0.1:{port}", flush=True)
    app.run(host="127.0.0.1", port=port, debug=False, threaded=True)
