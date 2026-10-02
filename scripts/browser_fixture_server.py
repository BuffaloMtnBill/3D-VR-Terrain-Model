"""Test-only server: deterministic surface classes, no public land-cover requests.

Run from the project root, then run tests/browser.cjs against port 8001.
The production app on port 8000 remains separate. DEM generation uses its normal
tile cache; maps, ZIP lookup and other feature data are intercepted by the test.
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from terrain_app.landcover import COVER_NAMES
from terrain_app.server import create_app

app = create_app({"TESTING": True})


def fixture_cover(bounds):
    def stripe(index):
        left, right = index/6, (index+1)/6
        return {"outer": [[left, 0], [right, 0], [right, 1], [left, 1], [left, 0]], "holes": []}
    return {"regions": {name: [stripe(index)] for index, name in enumerate(COVER_NAMES)},
            "counts": dict.fromkeys(COVER_NAMES, 1), "bounds": bounds.to_dict(),
            "source": "SYNTHETIC SURFACE FIXTURE FOR TESTING ONLY", "source_url": "", "fetched_at": "2026-10-01T00:00:00Z"}


app.extensions["terrain"]["landcover"].fetch = fixture_cover


def fixture_features(bounds):
    data = json.loads((Path(__file__).resolve().parents[1] / "tests/fixtures/features.json").read_text())
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

if __name__ == "__main__":
    print("TEST FIXTURES ONLY: http://127.0.0.1:8001", flush=True)
    app.run(host="127.0.0.1", port=8001, debug=False, threaded=True)
