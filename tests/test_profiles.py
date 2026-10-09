import json
import math
import time

import numpy as np
import pytest

from terrain_app.elevation import Bounds, Terrain
from terrain_app.profiles import (
    band, band_edges, profile_json, profile_options, ridgeline, ridges, skyline_profile, viewpoint
)
from terrain_app.silhouette import SilhouetteOptions, outline_json
from terrain_app.server import create_app


BOUNDS = Bounds(36.08, -82.165, 36.145, -82.055)


def to_point(u, v):
    """Convert frame fractions to a (latitude, longitude) point."""
    south, west, north, east = BOUNDS.south, BOUNDS.west, BOUNDS.north, BOUNDS.east
    lat = north - v * (north - south)
    lon = west + u * (east - west)
    return (lat, lon)


@pytest.fixture
def app(tmp_path):
    """Create Flask app for testing."""
    app = create_app({"TESTING": True, "CACHE_DIR": tmp_path / "tiles"})
    return app


def test_ridgeline_follows_ridge():
    """Ridgeline stays on a high ridge when crossing a frame."""
    # Build terrain: 60 rows × 80 columns, all 100 m, with a high ridge at row 10
    heights = np.full((60, 80), 100, dtype=np.float32)
    heights[10, :] = 500  # High ridge band along row 10
    terrain = Terrain(BOUNDS, heights, 11, 2, "2026-10-01T00:00:00Z")

    # Start at u=0.05, v=10/59; end at u=0.95, v=10/59 (both on the ridge)
    start = to_point(0.05, 10/59)
    end = to_point(0.95, 10/59)

    result = ridgeline(terrain, start, end)

    # Every point on the ridge path should be >= 499 m
    assert np.all(result["heights"] >= 499), "Path should stay on the ridge"

    # The saddle should be approximately the ridge height
    assert result["saddle"] == pytest.approx(500, abs=1)

    # Path length should be about 90% of terrain width
    expected_length = 0.9 * terrain.width
    assert pytest.approx(expected_length, rel=0.01) == result["length"]


def test_ridgeline_prefers_high_detour():
    """Ridgeline prefers a high detour over a short low way."""
    # Build terrain: 60 rows × 80 columns, all 100 m
    heights = np.full((60, 80), 100, dtype=np.float32)

    # Create a U-shaped ridge:
    # Row 5 from column 5 to 75 (top of U)
    heights[5, 5:76] = 400
    # Column 5 from row 5 to 55 (left side of U)
    heights[5:56, 5] = 400
    # Column 75 from row 5 to 55 (right side of U)
    heights[5:56, 75] = 400

    terrain = Terrain(BOUNDS, heights, 11, 2, "2026-10-01T00:00:00Z")

    # Start at (u=5/79, v=55/59), end at (u=75/79, v=55/59)
    start = to_point(5/79, 55/59)
    end = to_point(75/79, 55/59)

    result = ridgeline(terrain, start, end)

    # The saddle should be the ridge height (the minimum that the path maintains)
    assert result["saddle"] == pytest.approx(400, abs=1)

    # The path should climb up and over the U (smallest v value should be near row 5/59)
    min_v = result["path"][:, 1].min()
    assert min_v <= 7/59 + 0.01, "Path should climb over the U-shaped ridge"

    # Every grid cell the path visits is on the ridge; only samples cutting a corner of the one-cell-wide U dip.
    cells = np.rint(result["path"]*[79, 59]).astype(int)
    assert heights[cells[:, 1], cells[:, 0]].min() >= 399, "Path should stay on the high ridge"
    assert np.mean(result["heights"] < 399) < .02


def test_ridgeline_errors():
    """Ridgeline raises ValueError for invalid inputs."""
    heights = np.full((60, 80), 100, dtype=np.float32)
    terrain = Terrain(BOUNDS, heights, 11, 2, "2026-10-01T00:00:00Z")

    # Point outside the frame
    outside = (36.0, -82.0)  # Outside BOUNDS
    inside = to_point(0.5, 0.5)

    with pytest.raises(ValueError, match="outside the generated area"):
        ridgeline(terrain, outside, inside)

    # Two points too close together
    close_start = to_point(0.5, 0.5)
    close_end = to_point(0.5001, 0.5001)

    with pytest.raises(ValueError, match="farther apart"):
        ridgeline(terrain, close_start, close_end)


def test_viewpoint_sees_mountain():
    """Viewpoint detects a tall mountain in the direction of the bearing."""
    # Build terrain: 80 rows × 80 columns, all 100 m
    heights = np.full((80, 80), 100, dtype=np.float32)

    # Add a tall block near the east edge (rows 35–45, columns 70–79)
    heights[35:46, 70:80] = 2000

    terrain = Terrain(BOUNDS, heights, 11, 2, "2026-10-01T00:00:00Z")

    # Viewpoint at frame center
    center = to_point(0.5, 0.5)

    # Looking east (bearing 90)
    view = viewpoint(terrain, center, bearing=90, fov=60, eye_m=2.0)

    # Should see a tall peak (max angle > 5 degrees)
    assert view["angles"].max() > 5, "Should detect the tall mountain"

    # The maximum angle should be in the eastern direction (within 15 degrees of bearing 90)
    max_idx = np.argmax(view["angles"])
    max_azimuth = view["azimuths"][max_idx]
    assert abs(max_azimuth - 90) < 15, "Peak should be in the east direction"

    # Looking west (bearing 270) should see nothing tall
    view_west = viewpoint(terrain, center, bearing=270, fov=60, eye_m=2.0)
    assert view_west["angles"].max() < 1, "Looking west should not see the eastern mountain"


def test_earth_curvature_lowers_far_terrain():
    """Earth curvature and refraction lower the angle of distant terrain."""
    # Flat terrain, all 100 m
    heights = np.full((80, 80), 100, dtype=np.float32)
    terrain = Terrain(BOUNDS, heights, 11, 2, "2026-10-01T00:00:00Z")

    # Viewpoint at center, facing east with eye at ground level
    center = to_point(0.5, 0.5)
    view = viewpoint(terrain, center, bearing=90, fov=60, eye_m=0)

    # All angles should be <= 0 (horizon drops)
    assert np.all(view["angles"] <= 0), "All angles should be non-positive (horizon drops)"

    # The farthest step should have a lower angle than the nearest step
    # Find finite angles in the first row (first azimuth) of the table
    finite_angles = view["table"][0, np.isfinite(view["table"][0, :])]
    if len(finite_angles) > 1:
        nearest_idx = 0
        farthest_idx = len(finite_angles) - 1
        assert finite_angles[farthest_idx] < finite_angles[nearest_idx], \
            "Farthest terrain should have lower angle than nearest"


def test_depth_bands():
    """Depth bands separate near and far terrain."""
    # Build terrain: 80 rows × 80 columns, all 100 m
    heights = np.full((80, 80), 100, dtype=np.float32)

    # Tall block near center (rows 38–42, columns 44–46) = near hill 300 m
    heights[38:43, 44:47] = 300

    # Tall block far away (rows 35–45, columns 70–79) = far mountain 2000 m
    heights[35:46, 70:80] = 2000

    terrain = Terrain(BOUNDS, heights, 11, 2, "2026-10-01T00:00:00Z")

    # Viewpoint at frame center
    center = to_point(0.5, 0.5)
    view = viewpoint(terrain, center, bearing=90, fov=60, eye_m=2.0)

    # Get depth bands
    edges = band_edges(3)
    assert edges == pytest.approx([0.0, 1/9, 4/9, 1.0])

    near_band = band(view, edges[0], edges[1])
    mid_band = band(view, edges[1], edges[2])
    far_band = band(view, edges[2], edges[3])

    # Near band should include the close hill
    assert near_band.max() > 0, "Near band should see the close hill"

    # Far band should include the tall mountain
    assert far_band.max() > 5, "Far band should see the tall mountain"


def test_skyline_profile_geometry():
    """Skyline profile converts angles to cylinder coordinates."""
    # All angles at 0 degrees
    angles = np.zeros(10)
    profile_x, profile_y, width_mm = skyline_profile(angles, 60)

    # Y should be all zeros
    assert np.allclose(profile_y, 0), "Zero angles should have zero y"

    # X should span from 0 to radians(fov)*SKYLINE_RADIUS_M
    from terrain_app.profiles import SKYLINE_RADIUS_M
    expected_width = np.radians(60) * SKYLINE_RADIUS_M
    assert width_mm == pytest.approx(expected_width)
    assert profile_x[0] == pytest.approx(0)
    assert profile_x[-1] == pytest.approx(expected_width)

    # Test with 45-degree angle
    angles_45 = np.full(10, 45)
    profile_x_45, profile_y_45, _ = skyline_profile(angles_45, 60)

    # At 45 degrees, tan(45°) = 1, so y = SKYLINE_RADIUS_M
    assert profile_y_45[0] == pytest.approx(SKYLINE_RADIUS_M, rel=0.01)


def test_profile_options_validation():
    """Profile options validates mode, bounds, and parameters."""
    # Missing mode
    with pytest.raises(ValueError, match="ridgeline or viewpoint"):
        profile_options({})

    # Invalid mode
    with pytest.raises(ValueError, match="ridgeline or viewpoint"):
        profile_options({"mode": "invalid"})

    # Ridgeline with bad start point
    with pytest.raises(ValueError, match="first ridgeline point"):
        profile_options({"mode": "ridgeline", "start": [95, 0], "end": [36.09, -82.1]})

    # Viewpoint with bad FOV
    with pytest.raises(ValueError, match="field of view"):
        profile_options({"mode": "viewpoint", "point": [36.1, -82.1], "fov": 5})

    # Viewpoint with bad bands
    with pytest.raises(ValueError, match="Depth bands"):
        profile_options({"mode": "viewpoint", "point": [36.1, -82.1], "bands": 6})

    # Valid viewpoint fills in defaults
    result = profile_options({"mode": "viewpoint", "point": [36.1, -82.1]})
    assert result["bearing"] == pytest.approx(0.0)
    assert result["fov"] == pytest.approx(120.0)
    assert result["eye_m"] == pytest.approx(2.0)
    assert result["bands"] == 1


def test_profile_api_ridgeline(app, tmp_path):
    """HTTP POST /api/profile/<id> returns ridgeline profile."""
    try:
        # Create test terrain
        heights = np.arange(16*20, dtype=np.float32).reshape(16, 20) + 100
        terrain = Terrain(BOUNDS, heights, 11, 2, "2026-10-01T00:00:00Z")

        # Inject terrain into app
        app.extensions["terrain"]["jobs"]["print"] = {
            "state": "ready",
            "terrain": terrain,
            "accessed": time.monotonic()
        }

        client = app.test_client()

        # Valid ridgeline request
        request_data = {
            "mode": "ridgeline",
            "start": [36.08 + 0.01, -82.165 + 0.02],
            "end": [36.08 + 0.03, -82.165 + 0.06]
        }

        response = client.post("/api/profile/print", json=request_data)
        assert response.status_code == 200
        data = response.get_json()

        # Check required keys
        required_keys = {"path", "distances", "heights", "length_m", "highest_m", "lowest_m"}
        assert all(key in data for key in required_keys)

        # Distances and heights should have same length
        assert len(data["distances"]) == len(data["heights"])

        # Valid viewpoint request
        viewpoint_data = {
            "mode": "viewpoint",
            "point": [36.1, -82.1],
            "bearing": 45,
            "fov": 90,
            "eye_m": 2,
            "bands": 3
        }

        response = client.post("/api/profile/print", json=viewpoint_data)
        assert response.status_code == 200
        data = response.get_json()

        # Check required keys for viewpoint
        assert all(key in data for key in {"angles", "azimuths", "bands", "rays"})
        assert len(data["bands"]) == 3
        assert len(data["bands"][0]) == len(data["angles"])

        # Unknown terrain ID
        response = client.post("/api/profile/unknown_id", json=request_data)
        assert response.status_code == 404

        # Bad mode
        response = client.post("/api/profile/print", json={"mode": "invalid"})
        assert response.status_code == 400

    finally:
        app.extensions["terrain"]["executor"].shutdown(wait=True)


def test_silhouette_ridgeline_integration(app, tmp_path):
    """POST /api/silhouette/<id>/outline with ridgeline source."""
    try:
        # Create test terrain
        heights = np.full((60, 80), 100, dtype=np.float32)
        heights[10, :] = 500  # High ridge
        terrain = Terrain(BOUNDS, heights, 11, 2, "2026-10-01T00:00:00Z")

        # Inject terrain into app
        app.extensions["terrain"]["jobs"]["print"] = {
            "state": "ready",
            "terrain": terrain,
            "accessed": time.monotonic()
        }

        client = app.test_client()

        # Ridgeline silhouette request
        ridge_start = to_point(0.05, 10/59)
        ridge_end = to_point(0.95, 10/59)

        payload = {
            "source": "ridgeline",
            "ridge_start": list(ridge_start),
            "ridge_end": list(ridge_end)
        }

        response = client.post("/api/silhouette/print/outline", json=payload)
        assert response.status_code == 200
        data = response.get_json()

        # Check result
        assert "width_mm" in data
        assert data["width_mm"] == pytest.approx(180)

    finally:
        app.extensions["terrain"]["executor"].shutdown(wait=True)


def test_silhouette_viewpoint_integration(app, tmp_path):
    """POST /api/silhouette/<id>/outline with viewpoint source and multiple layers."""
    try:
        # Create test terrain
        heights = np.full((80, 80), 100, dtype=np.float32)
        heights[35:46, 70:80] = 2000
        heights[38:43, 44:47] = 300
        terrain = Terrain(BOUNDS, heights, 11, 2, "2026-10-01T00:00:00Z")

        # Inject terrain into app
        app.extensions["terrain"]["jobs"]["print"] = {
            "state": "ready",
            "terrain": terrain,
            "accessed": time.monotonic()
        }

        client = app.test_client()

        center = to_point(0.5, 0.5)

        # Viewpoint with 2 layers
        payload = {
            "source": "viewpoint",
            "view_point": list(center),
            "view_bearing": 90,
            "view_fov": 60,
            "fit": "box",
            "layers": [
                {"position": 30, "base_mm": 8, "color": "#334433"},
                {"position": 100, "base_mm": 14, "color": "#aabbaa"}
            ],
            "thickness_mm": 2
        }

        response = client.post("/api/silhouette/print/outline", json=payload)
        assert response.status_code == 200
        data = response.get_json()

        # Check result has 2 layers
        assert len(data["layers"]) == 2

        # Layers with reversed positions should fail (not in ascending order)
        bad_payload = {**payload, "layers": [
            {"position": 100, "base_mm": 14, "color": "#aabbaa"},
            {"position": 30, "base_mm": 8, "color": "#334433"}
        ]}

        response = client.post("/api/silhouette/print/outline", json=bad_payload)
        assert response.status_code == 400
        assert "distance bands" in response.get_json()["error"]

        # Ridgeline with 2 layers should fail (ridgeline only supports 1 layer)
        ridge_payload = {
            "source": "ridgeline",
            "ridge_start": list(to_point(0.05, 0.5)),
            "ridge_end": list(to_point(0.95, 0.5)),
            "fit": "box",
            "layers": [
                {"position": 30, "base_mm": 8, "color": "#334433"},
                {"position": 100, "base_mm": 14, "color": "#aabbaa"}
            ]
        }

        response = client.post("/api/silhouette/print/outline", json=ridge_payload)
        assert response.status_code == 400
        assert "single layer" in response.get_json()["error"]

    finally:
        app.extensions["terrain"]["executor"].shutdown(wait=True)


def three_ridges():
    """Flat ground with three north–south ridges east of a viewpoint at u = 0.05, each farther and higher than the last."""
    heights = np.full((80, 80), 100, dtype=np.float32)
    for column, top in ((22, 300), (44, 600), (68, 1000)):
        heights[:, column-1:column+2] = top
    return Terrain(BOUNDS, heights, 11, 2, "2026-10-01T00:00:00Z")


def test_ridges_finds_separate_ridgelines_nearest_first():
    terrain = three_ridges()
    view = viewpoint(terrain, to_point(.05, .5), bearing=90, fov=60, eye_m=2.0)
    found = ridges(view, 3)
    # The ridges stand ~2.1, 4.6, and 7.6 km east (wider off-axis, where the rays cross them at a slant).
    assert [round(ridge["distance_m"]/1000) for ridge in found] == [2, 5, 8]
    assert all(ridge["coverage"] > .5 for ridge in found) and np.diff([ridge["distance_m"] for ridge in found]).min() > 0
    assert found[0]["angles"].max() > 0 and (found[2]["angles"] > found[1]["angles"]).mean() > .5
    # Asking for more finds no more: one ridge seen at varying distances is not two.
    assert len(ridges(view, 6)) == 3
    beyond = ridges(viewpoint(terrain, to_point(.05, .5), bearing=90, fov=60, eye_m=2.0, min_radius_m=3000), 3)
    assert [round(ridge["distance_m"]/1000) for ridge in beyond] == [5, 8] and beyond[0]["near_m"] == 3000


def test_viewpoint_at_the_frame_edge_sees_inward():
    """A summit on the frame's edge is a common viewpoint: directions that leave the frame see nothing, the rest work."""
    heights = np.full((60, 80), 100, dtype=np.float32)
    heights[:, 60:70] = 900
    terrain = Terrain(BOUNDS, heights, 11, 2, "2026-10-01T00:00:00Z")
    view = viewpoint(terrain, to_point(0, .5), 90, 360, 2.0)
    assert view["angles"].max() > 1
    assert (view["angles"] == -90).any(), "Directions straight out of the frame have no terrain"
