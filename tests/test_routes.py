from io import BytesIO
import json
import time
from xml.etree import ElementTree as ET
from zipfile import ZipFile

import numpy as np
import pytest

from terrain_app.elevation import Bounds, Terrain
from terrain_app.landcover import COVER_NAMES, face_classes
from terrain_app.printing import CORE
from terrain_app.routes import RouteStore, along, gpx_segments, prepare_route, route_lines, route_options
from terrain_app.server import create_app

PALETTE = dict(zip(COVER_NAMES, ["#234e40", "#94b578", "#b99570", "#f0ead6", "#234e40", "#b99570"]))
BOUNDS = Bounds(36.08, -82.165, 36.145, -82.055)


def gpx(points, name="Morning hike", namespace="http://www.topografix.com/GPX/1/1", tag="trk", time=None):
    point = "trkpt" if tag == "trk" else "rtept"
    stamp = f"<time>{time}</time>" if time else ""
    items = "".join(f'<{point} lat="{lat}" lon="{lon}">{"" if ele is None else f"<ele>{ele}</ele>"}{stamp}</{point}>' for lat, lon, ele in points)
    body = f"<trk><name>{name}</name><trkseg>{items}</trkseg></trk>" if tag == "trk" else f"<rte><name>{name}</name>{items}</rte>"
    return f'<?xml version="1.0"?><gpx version="1.1" xmlns="{namespace}">{body}</gpx>'.encode()


def diagonal(count=400):
    t = np.linspace(0, 1, count)
    return list(zip(36.09+.04*t, -82.15+.08*t, 1000+200*np.sin(t*np.pi)))


@pytest.fixture
def terrain():
    heights = np.arange(16*20, dtype=np.float32).reshape(16, 20)+100
    return Terrain(BOUNDS, heights, 11, 2, "2026-10-01T00:00:00Z")


@pytest.fixture
def cover(terrain):
    def region(left, right):
        return {"outer": [[left, 0], [right, 0], [right, 1], [left, 1], [left, 0]], "holes": []}
    return {"regions": {name: [region(index/6, (index+1)/6)] for index, name in enumerate(COVER_NAMES)},
            "counts": dict.fromkeys(COVER_NAMES, 1), "bounds": terrain.bounds.to_dict(), "schema_version": 2}


def test_gpx_tracks_routes_and_namespaces_parse():
    segments, name, started = gpx_segments(gpx(diagonal(5), time="2026-05-04T13:00:00Z"))
    assert name == "Morning hike" and len(segments) == 1 and len(segments[0]) == 5 and segments[0][0][2] == pytest.approx(1000)
    assert started == "2026-05-04T13:00:00Z"
    segments, _, started = gpx_segments(gpx(diagonal(3), namespace="http://www.topografix.com/GPX/1/0", tag="rte"))
    assert len(segments[0]) == 3 and started is None


@pytest.mark.parametrize("content,message", [(b"not xml", "not valid GPX"), (b"<kml/>", "not a GPX file"),
                                             (gpx([]), "no track or route points")])
def test_bad_gpx_explains_the_problem(content, message):
    with pytest.raises(ValueError, match=message):
        gpx_segments(content)


def test_route_stats_simplification_and_display():
    route = prepare_route(gpx(diagonal(4000), time="2026-05-04T13:00:00Z"), "hike.gpx")
    assert route["points"] == 4000 and 8000 < route["distance_m"] < 9000
    assert route["gain_m"] == pytest.approx(200, abs=4)  # climb counted once, noise ignored
    assert route["date"] == "2026-05-04" and route["has_elevation"] and route["elevation_range_m"] == pytest.approx(200, abs=2)
    assert route["schema_version"] == 2 and route["display"][0][0] == pytest.approx([36.09, -82.15])
    assert route["bounds"]["south"] == pytest.approx(36.09) and route["bounds"]["east"] == pytest.approx(-82.07)
    # The straight ground track alone would simplify to its two ends; the stored profile keeps the hill to within a meter.
    stored = np.asarray(route["segments"][0], dtype=np.float64)
    assert 2 < len(stored) < 400 and stored.shape[1] == 3
    t = np.linspace(0, 1, 4000)
    full = np.column_stack((-82.15+.08*t, 36.09+.04*t))
    assert np.allclose(np.interp(along(full), along(stored), stored[:, 2]), 1000+200*np.sin(t*np.pi), atol=2.5)  # the ends average half a window
    flat = prepare_route(gpx([(lat, lon, None) for lat, lon, _ in diagonal(400)]))
    assert len(flat["segments"][0]) == 2 and flat["segments"][0][0][2] is None and not flat["has_elevation"] and flat["date"] is None


def test_version_one_route_files_still_load(tmp_path):
    store = RouteStore(tmp_path)
    route = prepare_route(gpx(diagonal()))
    old = {**route, "schema_version": 1, "segments": [[point[:2] for point in segment] for segment in route["segments"]]}
    (tmp_path / f"{route['id']}.json").write_text(json.dumps(old))
    loaded = store.load(route["id"])
    assert loaded["schema_version"] == 1 and route_lines(loaded, BOUNDS) == route_lines(route, BOUNDS)
    assert store.save(gpx(diagonal()))["schema_version"] == 2 and len(store.load(route["id"])["segments"][0][0]) == 3


def test_route_lines_follow_and_clip_to_any_frame():
    route = prepare_route(gpx(diagonal()))
    lines = route_lines(route, BOUNDS)
    assert len(lines) == 1 and all(0 <= value <= 1 for point in lines[0] for value in point)
    # Resizing the frame keeps the route in place on the ground: here it is clipped at the frame edge.
    small = Bounds(36.08, -82.165, 36.11, -82.11)
    clipped = route_lines(route, small)
    assert clipped and max(point[0] for point in clipped[0]) == pytest.approx(1, abs=1e-4)  # it leaves near the corner
    assert route_lines(route, Bounds(40, -80, 40.1, -79.9)) == []


def test_route_options_validation():
    assert route_options(None) is None and route_options({"enabled": False}) is None
    assert route_options({"enabled": True, "id": "a"*24, "color": "#FF0000", "width_mm": 2})["color"] == "#ff0000"
    for bad, message in [({"enabled": True, "id": "../x", "color": "#ff0000"}, "Upload the GPX route again"),
                         ({"enabled": True, "id": "a"*24, "color": "red"}, "hex color"),
                         ({"enabled": True, "id": "a"*24, "color": "#ff0000", "width_mm": 20}, "between")]:
        with pytest.raises(ValueError, match=message):
            route_options(bad)


def test_route_upload_lines_and_3mf_route_part(tmp_path, terrain, cover):
    app = create_app({"TESTING": True, "CACHE_DIR": tmp_path / "tiles"})
    try:
        extension = app.extensions["terrain"]
        extension["jobs"]["print"] = {"state": "ready", "terrain": terrain, "accessed": time.monotonic()}
        extension["cover_jobs"]["print"] = {"state": "ready", "data": {"face_classes": face_classes(cover, *terrain.elevations.shape).tolist()}}
        client = app.test_client()
        assert client.post("/api/routes", data=gpx(diagonal()), content_type="application/gpx+xml").status_code == 415
        uploaded = client.post("/api/routes", json={"gpx": gpx(diagonal()).decode(), "filename": "hike.gpx"})
        assert uploaded.status_code == 200
        route = uploaded.get_json()
        assert "segments" not in route and route["name"] == "Morning hike"
        assert client.get(f"/api/routes/{route['id']}").get_json()["id"] == route["id"]
        assert client.get("/api/routes/" + "0"*24).status_code == 404
        assert len(client.get(f"/api/routes/{route['id']}/lines/print").get_json()["lines"]) == 1
        style = {"id": route["id"], "enabled": True, "color": "#c0392b", "width_mm": 2.5}
        five = client.post("/api/export/print", json={"format": "3mf", "print_palette": PALETTE, "route": style})
        assert five.status_code == 400 and "four colors" in five.get_json()["error"]
        style["color"] = "#f0ead6"  # shares the snow color
        response = client.post("/api/export/print", json={"format": "3mf", "print_palette": PALETTE, "route": style})
        assert response.status_code == 200
        with ZipFile(BytesIO(response.data)) as archive:
            model = ET.fromstring(archive.read("3D/3dmodel.model"))
        names = [base.attrib["name"] for base in model.findall(f"{{{CORE}}}resources/{{{CORE}}}basematerials/{{{CORE}}}base")]
        assert any("Route" in name for name in names)
        description = json.loads(model.find(f"{{{CORE}}}metadata[@name='Description']").text)
        assert description["feature_layers"]["route"]["width_mm"] == 2.5
        missing = {**style, "id": "f"*24}
        assert "Upload the GPX file again" in client.post("/api/export/print", json={"format": "3mf", "print_palette": PALETTE, "route": missing}).get_json()["error"]
    finally:
        app.extensions["terrain"]["executor"].shutdown(wait=True)


def test_restart_endpoint_replies_then_restarts(tmp_path):
    restarted = []
    app = create_app({"TESTING": True, "CACHE_DIR": tmp_path / "tiles", "RESTART": lambda: restarted.append(True)})
    try:
        client = app.test_client()
        assert client.post("/api/restart", data="{}", content_type="text/plain").status_code == 415
        assert client.post("/api/restart", json={}, headers={"Origin": "https://example.com"}).status_code == 403
        response = client.post("/api/restart", json={})
        assert response.status_code == 202 and response.get_json() == {"restarting": True}
        for _ in range(40):
            if restarted:
                break
            time.sleep(.05)
        assert restarted == [True]
    finally:
        app.extensions["terrain"]["executor"].shutdown(wait=True)
