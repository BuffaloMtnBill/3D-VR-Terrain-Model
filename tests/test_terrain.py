from collections import Counter
from io import BytesIO
import json
import struct
import time

import numpy as np
from PIL import Image
import pytest

from terrain_app.elevation import Bounds, ElevationClient, Terrain, choose_zoom, decode_terrarium, grid_shape, pixel_coordinates, tile_extent
from terrain_app.mesh import ModelOptions, binary_stl, build_mesh, export_file, smooth_elevations
from terrain_app.server import create_app, load_example
from terrain_app.places import DEFAULT_PLACE, PRESETS


@pytest.fixture
def terrain():
    heights = np.array([[10, 14, 23, 14, 10], [11, 20, 55, 21, 12], [10, 15, 26, 14, 11], [9, 12, 15, 12, 8]], dtype=np.float32)
    return Terrain(Bounds(37.695, -119.665, 37.785, -119.525), heights, 11, 4, "2026-09-30T00:00:00Z")


@pytest.fixture
def application(tmp_path):
    app = create_app({"TESTING": True, "CACHE_DIR": tmp_path / "tiles"})
    yield app
    app.extensions["terrain"]["executor"].shutdown(wait=True)


@pytest.mark.parametrize("value", [0, 1234.25, -122.125, 32767.5])
def test_terrarium_decodes_signed_fractional_meters(value):
    encoded = value + 32768
    rgb = [int(encoded // 256), int(encoded % 256), round((encoded % 1) * 256)]
    assert decode_terrarium(Image.new("RGB", (1, 1), tuple(rgb)))[0, 0] == value


@pytest.mark.parametrize("bounds", [
    {"south": 0, "north": 0, "west": 1, "east": 2},
    {"south": 86, "north": 87, "west": 1, "east": 2},
    {"south": 0, "north": 1, "west": 179, "east": -179},
    {"south": 0, "north": .00001, "west": 0, "east": .00001},
    {"south": 0, "north": 5, "west": 0, "east": 5},
    {"south": float("nan"), "north": 1, "west": 0, "east": 1},
])
def test_invalid_selections_are_rejected(bounds):
    with pytest.raises(ValueError):
        Bounds.from_dict(bounds)


def test_grid_preserves_geographic_aspect_ratio(terrain):
    rows, columns = grid_shape(terrain.bounds, 160)
    assert max(rows, columns) == 160
    assert abs((columns-1)/(rows-1) - terrain.width/terrain.height) < .01
    zoom = choose_zoom(terrain.bounds, rows, columns)
    x0, y0, x1, y1 = tile_extent(terrain.bounds, zoom)
    assert (x1-x0+1)*(y1-y0+1) <= 64


def test_sampling_uses_pixel_centers_and_is_continuous_across_tile_seams(tmp_path, terrain, monkeypatch):
    client = ElevationClient(tmp_path)

    def tile(zoom, x, y):
        yy, xx = np.mgrid[0:256, 0:256]
        return (x*256+xx + (y*256+yy)*2).astype(np.float32)

    monkeypatch.setattr(client, "tile", tile)
    result = client.fetch(terrain.bounds, 96)
    rows, columns = result.elevations.shape
    lons, lats = np.meshgrid(np.linspace(terrain.bounds.west, terrain.bounds.east, columns),
                             np.linspace(terrain.bounds.north, terrain.bounds.south, rows))
    px, py = pixel_coordinates(lons, lats, result.zoom)
    np.testing.assert_allclose(result.elevations, px-.5+(py-.5)*2, atol=.02)
    assert np.all(result.elevations[:, 1:] > result.elevations[:, :-1])


def test_rotated_sampling_follows_the_rectangle_instead_of_its_envelope(tmp_path, terrain, monkeypatch):
    bounds = Bounds(**terrain.bounds.to_dict(), rotation_deg=90)
    client = ElevationClient(tmp_path)
    downloaded = []

    def tile(zoom, x, y):
        downloaded.append((x, y))
        yy, xx = np.mgrid[0:256, 0:256]
        return (x*256+xx + (y*256+yy)*2).astype(np.float32)

    monkeypatch.setattr(client, "tile", tile)
    result = client.fetch(bounds, 96)
    assert result.elevations.shape == grid_shape(terrain.bounds, 96)
    assert result.width == terrain.width and result.height == terrain.height
    west, north = pixel_coordinates(bounds.west, bounds.north, result.zoom)
    east, south = pixel_coordinates(bounds.east, bounds.south, result.zoom)
    rows, columns = result.elevations.shape
    x = (west+east)/2 - np.linspace(-.5, .5, rows)[:, None]*(south-north)
    y = (north+south)/2 + np.linspace(-.5, .5, columns)[None, :]*(east-west)
    np.testing.assert_allclose(result.elevations, x-.5+2*(y-.5), atol=.02)
    assert np.all(np.diff(result.elevations, axis=0) < 0)
    assert np.all(np.diff(result.elevations, axis=1) > 0)
    x0, y0, x1, y1 = tile_extent(bounds, result.zoom)
    assert set(downloaded) == {(x, y) for y in range(y0, y1+1) for x in range(x0, x1+1)}
    vertices, faces = build_mesh(result, ModelOptions())
    assert_closed_and_outward(vertices, faces)


@pytest.mark.parametrize("angle", [-135, -45, 30, 90, 180])
def test_rotated_footprint_preserves_projected_lengths_and_right_angles(terrain, angle):
    bounds = Bounds(**terrain.bounds.to_dict(), rotation_deg=angle)
    bounds.validate()
    x, y = pixel_coordinates(*bounds.corners, 0)
    corners = np.column_stack((x, y))
    sides = np.roll(corners, -1, axis=0)-corners
    west, north = pixel_coordinates(bounds.west, bounds.north, 0)
    east, south = pixel_coordinates(bounds.east, bounds.south, 0)
    np.testing.assert_allclose(np.linalg.norm(sides, axis=1), [east-west, south-north, east-west, south-north], atol=1e-12)
    assert np.dot(sides[0], sides[1]) == pytest.approx(0, abs=1e-12)
    extent = bounds.geographic_extent
    longitude, latitude = bounds.corners
    assert extent.west == longitude.min() and extent.east == longitude.max()
    assert extent.south == latitude.min() and extent.north == latitude.max()


@pytest.mark.parametrize("value", [181, -181, float("nan"), float("inf"), "invalid"])
def test_invalid_rotation_is_rejected(terrain, value):
    with pytest.raises(ValueError):
        Bounds.from_dict(terrain.bounds.to_dict() | {"rotation_deg": value})


@pytest.mark.parametrize("bounds", [
    {"south": 0, "north": .02, "west": 179.998, "east": 179.999, "rotation_deg": 45},
    {"south": 84.999, "north": 85.05, "west": 0, "east": 1, "rotation_deg": 90},
])
def test_rotated_footprint_cannot_cross_geographic_limits(bounds):
    with pytest.raises(ValueError, match="rotated selection"):
        Bounds.from_dict(bounds)


def test_rotated_exports_retain_the_footprint_and_array_orientation(terrain):
    terrain.bounds = Bounds(**terrain.bounds.to_dict(), rotation_deg=35)
    for format in ("metadata", "png", "obj"):
        content, _, _ = export_file(terrain, ModelOptions(), format, "Credits")
        if format == "metadata":
            metadata = json.load(content)
        elif format == "png":
            metadata = json.loads(Image.open(content).info["terrain_metadata"])
        else:
            line = next(line for line in content.read().decode().splitlines() if line.startswith("# Metadata: "))
            metadata = json.loads(line.removeprefix("# Metadata: "))
        assert metadata["bounds"]["rotation_deg"] == 35
        assert len(metadata["footprint"]) == 4
        assert metadata["heightmap"]["north_up"] is False
        assert "selection top to bottom" in metadata["grid_orientation"]


def test_cache_avoids_network_requests(tmp_path, monkeypatch):
    path = tmp_path / "11" / "344" / "792.png"
    path.parent.mkdir(parents=True)
    Image.new("RGB", (256, 256), (128, 0, 0)).save(path)
    monkeypatch.setattr("terrain_app.elevation.requests.get", lambda *_args, **_kwargs: pytest.fail("A cached tile should not use the network"))
    assert np.all(ElevationClient(tmp_path).tile(11, 344, 792) == 0)


def test_smoothing_reduces_spikes_without_mutating_source(terrain):
    original = terrain.elevations.copy()
    smoothed = smooth_elevations(terrain, 1.5)
    assert smoothed.max() < terrain.elevations.max()
    assert smoothed.min() > terrain.elevations.min()
    np.testing.assert_array_equal(terrain.elevations, original)
    np.testing.assert_array_equal(smooth_elevations(terrain, 0), original)


def assert_closed_and_outward(vertices, faces):
    edges = np.concatenate((faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]))
    counts = Counter(tuple(sorted(edge)) for edge in edges)
    assert set(counts.values()) == {2}, "Each undirected edge must appear exactly twice"
    directed = Counter(map(tuple, edges))
    assert all(directed[(b, a)] == count for (a, b), count in directed.items()), "Shared edges must have opposite winding"
    triangles = vertices[faces]
    normals = np.cross(triangles[:, 1]-triangles[:, 0], triangles[:, 2]-triangles[:, 0])
    assert np.all(np.linalg.norm(normals, axis=1) > 0), "No degenerate triangles"
    volume = np.einsum("ij,ij->i", triangles[:, 0], np.cross(triangles[:, 1], triangles[:, 2])).sum()/6
    assert volume > 0, "Closed mesh must have positive signed volume"


@pytest.mark.parametrize("exaggeration,smoothing", [(1, 0), (8, 2), (.1, 5)])
def test_solid_mesh_is_watertight_and_scaled_in_millimeters(terrain, exaggeration, smoothing):
    opts = ModelOptions(exaggeration=exaggeration, smoothing=smoothing, size_mm=180)
    vertices, faces = build_mesh(terrain, opts)
    assert_closed_and_outward(vertices, faces)
    assert np.ptp(vertices[:, :2], axis=0).max() == pytest.approx(180)
    assert vertices[:, 2].min() == 0
    surface_count = terrain.elevations.size
    assert vertices[:surface_count, 2].min() == pytest.approx(180 * opts.base_percent/100)
    top_faces = faces[:2*(terrain.elevations.shape[0]-1)*(terrain.elevations.shape[1]-1)]
    top = vertices[top_faces]
    assert np.all(np.cross(top[:, 1]-top[:, 0], top[:, 2]-top[:, 0])[:, 2] > 0)


def test_flat_terrain_still_has_a_valid_solid_base(terrain):
    terrain.elevations[:] = -50
    vertices, faces = build_mesh(terrain, ModelOptions())
    assert_closed_and_outward(vertices, faces)
    assert np.ptp(vertices[:terrain.elevations.size, 2]) == 0


def test_surface_only_has_expected_open_boundary(terrain):
    vertices, faces = build_mesh(terrain, ModelOptions(solid=False))
    assert len(vertices) == terrain.elevations.size
    assert len(faces) == (terrain.elevations.shape[0]-1)*(terrain.elevations.shape[1]-1)*2
    edges = np.concatenate((faces[:, [0, 1]], faces[:, [1, 2]], faces[:, [2, 0]]))
    counts = Counter(tuple(sorted(edge)) for edge in edges)
    assert sum(count == 1 for count in counts.values()) == 2*sum(terrain.elevations.shape)-4


def test_binary_stl_has_complete_triangle_records(terrain):
    vertices, faces = build_mesh(terrain, ModelOptions())
    content = binary_stl(vertices, faces)
    count = struct.unpack("<I", content[80:84])[0]
    assert count == len(faces)
    assert len(content) == 84+50*count
    assert b"units mm" in content[:80]


@pytest.mark.parametrize("format", ["npy", "csv"])
def test_raw_files_preserve_original_heights(terrain, format):
    content, _, filename = export_file(terrain, ModelOptions(exaggeration=10, smoothing=3), format, "Source credits")
    assert filename.endswith("." + format)
    heights = np.load(content, allow_pickle=False) if format == "npy" else np.loadtxt(content, delimiter=",")
    np.testing.assert_allclose(heights, terrain.elevations, atol=.00005)


def test_standalone_heightmap_embeds_its_decoding_metadata(terrain):
    content, mimetype, filename = export_file(terrain, ModelOptions(exaggeration=10, smoothing=3), "png", "Source credits ©")
    assert mimetype == "image/png" and filename == "heightmap.png"
    image = Image.open(content)
    metadata = json.loads(image.info["terrain_metadata"])
    pixels = np.asarray(image)
    restored = metadata["min_m"]+pixels/65535*(metadata["max_m"]-metadata["min_m"])
    np.testing.assert_allclose(restored, terrain.elevations, atol=(metadata["max_m"]-metadata["min_m"])/65535)
    assert metadata["bounds"] == terrain.metadata()["bounds"]
    assert image.info["attribution"] == "Source credits ©"


def test_obj_has_embedded_metadata_and_standalone_geometry(terrain):
    content, _, filename = export_file(terrain, ModelOptions(size_mm=150), "obj", "Terrain source credits")
    text = content.read().decode()
    assert filename == "terrain.obj"
    assert "# Terrain source credits" in text
    metadata_line = next(line for line in text.splitlines() if line.startswith("# Metadata: "))
    assert json.loads(metadata_line.removeprefix("# Metadata: "))["model_options"]["size_mm"] == 150
    vertices = np.array([[float(value) for value in line.split()[1:]] for line in text.splitlines() if line.startswith("v ")])
    faces = np.array([[int(value)-1 for value in line.split()[1:]] for line in text.splitlines() if line.startswith("f ")])
    assert np.ptp(vertices[:, :2], axis=0).max() == pytest.approx(150)
    assert_closed_and_outward(vertices, faces)


def test_optional_metadata_file_preserves_settings(terrain):
    content, mimetype, filename = export_file(terrain, ModelOptions(size_mm=120, smoothing=2), "metadata", "Credits")
    assert filename == "terrain-metadata.json" and mimetype == "application/json"
    metadata = json.load(content)
    assert metadata["model_options"]["size_mm"] == 120
    assert metadata["model_options"]["smoothing"] == 2
    assert metadata["attribution"] == "Credits"


@pytest.mark.parametrize("options", [{"exaggeration": 0}, {"smoothing": -1}, {"base_percent": 0}, {"size_mm": 0}, {"solid": "false"}, {"smoothing": float("inf")}])
def test_invalid_model_options_are_rejected(options):
    with pytest.raises(ValueError):
        ModelOptions.from_dict(options)


def test_real_bundled_example_is_present():
    terrain = load_example()
    assert terrain is not None
    assert terrain.bounds == Bounds.from_dict(PRESETS[DEFAULT_PLACE]["bounds"])
    assert terrain.elevations.shape == (117, 160)
    assert 850 < terrain.elevations.min() < 950
    assert 1850 < terrain.elevations.max() < 1950
    assert terrain.tile_count == 2
    vertices, faces = build_mesh(terrain, ModelOptions(smoothing=1))
    assert_closed_and_outward(vertices, faces)


def test_default_location_and_terrain_map_are_consistent(application):
    client = application.test_client()
    config = client.get("/api/config").get_json()
    assert config["default_place"] == "roan"
    assert {"roan", "rainier", "yosemite", "fuji", "canyon", "alps"} <= config["presets"].keys()
    assert client.get("/api/terrain/example").get_json()["bounds"] == config["presets"]["roan"]["bounds"]
    assert config["map_tile_url"] == "https://tile.opentopomap.org/{z}/{x}/{y}.png"
    assert config["map_max_native_zoom"] == 17
    assert "OpenTopoMap" in config["map_attribution"]
    assert config["street_tile_url"] == "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
    html = client.get("/").get_data(as_text=True)
    assert '<option value="roan" selected>Roan Mountain, USA</option>' in html
    assert '<option value="rainier">Mount Rainier, USA</option>' in html
    assert '<h2 id="landscape-title">Roan Mountain</h2>' in html


def test_http_example_smoothing_export_and_validation(application):
    client = application.test_client()
    assert client.get("/").status_code == 200
    raw = client.get("/api/terrain/example").get_json()
    smooth = client.get("/api/terrain/example?smoothing=2").get_json()
    assert raw["rows"]*raw["columns"] == len(raw["elevations"])
    assert smooth["surface_max_m"] < raw["surface_max_m"]
    assert client.get("/api/terrain/example?smoothing=nan").status_code == 400
    assert client.get("/api/terrain/missing").status_code == 404
    assert client.post("/api/terrain", json={"bounds": {}}).status_code == 400
    assert client.post("/api/terrain", json={"bounds": raw["bounds"], "resolution": 384.5}).status_code == 400
    response = client.post("/api/export/example", json={"format": "stl", "size_mm": 150})
    assert response.status_code == 200
    assert response.mimetype == "model/stl"
    assert "filename=terrain.stl" in response.headers["Content-Disposition"]
    count = struct.unpack("<I", response.data[80:84])[0]
    assert len(response.data) == 84+50*count
    records = np.frombuffer(response.data, offset=84, dtype=[("normal", "<f4", (3,)), ("vertices", "<f4", (3, 3)), ("attribute", "<u2")])
    assert np.ptp(records["vertices"].reshape(-1, 3)[:, :2], axis=0).max() == pytest.approx(150)
    assert client.post("/api/export/example", json={"format": "unsupported"}).status_code == 400


@pytest.mark.parametrize("format,extension,mimetype", [
    ("obj", "obj", "text/plain"), ("png", "png", "image/png"),
    ("csv", "csv", "text/csv"), ("npy", "npy", "application/octet-stream"),
    ("metadata", "json", "application/json"),
])
def test_http_downloads_are_native_files(application, format, extension, mimetype):
    response = application.test_client().post("/api/export/example", json={"format": format})
    assert response.status_code == 200 and response.mimetype == mimetype
    disposition = response.headers["Content-Disposition"]
    assert disposition.startswith("attachment;") and disposition.endswith("." + extension)
    assert not response.data.startswith(b"PK")


def test_attribution_is_available_as_an_optional_text_download(application):
    response = application.test_client().get("/api/attribution?download=1")
    assert response.status_code == 200 and response.mimetype == "text/plain"
    assert "filename=terrain-credits.txt" in response.headers["Content-Disposition"]
    assert b"U.S. Geological Survey" in response.data


def test_http_rejects_foreign_origin_and_form_posts(application):
    client = application.test_client()
    assert client.post("/api/terrain", json={}, headers={"Origin": "https://example.com"}).status_code == 403
    assert client.post("/api/terrain", data="bad").status_code == 415


def test_background_download_lifecycle(application, terrain, monkeypatch):
    def fetch(bounds, resolution, progress):
        assert resolution == 96
        assert bounds == terrain.bounds
        progress(.5, "Downloading test tiles")
        return terrain
    monkeypatch.setattr(application.extensions["terrain"]["client"], "fetch", fetch)
    client = application.test_client()
    response = client.post("/api/terrain", json={"bounds": terrain.metadata()["bounds"], "resolution": 96})
    assert response.status_code == 202
    identifier = response.get_json()["id"]
    for _ in range(100):
        status = client.get(f"/api/jobs/{identifier}").get_json()
        if status["state"] == "ready":
            break
        time.sleep(.01)
    assert status["state"] == "ready"
    assert client.get(f"/api/terrain/{identifier}").get_json()["elevations"] == terrain.elevations.ravel().tolist()


def test_failed_download_returns_a_visible_error(application, terrain, monkeypatch):
    def fetch(*_args):
        raise ValueError("Elevation service is offline")
    monkeypatch.setattr(application.extensions["terrain"]["client"], "fetch", fetch)
    client = application.test_client()
    result = client.post("/api/terrain", json={"bounds": terrain.metadata()["bounds"]}).get_json()
    for _ in range(100):
        status = client.get(f"/api/jobs/{result['id']}").get_json()
        if status["state"] == "error":
            break
        time.sleep(.01)
    assert status["state"] == "error"
    assert status["message"] == "Elevation service is offline"
    assert client.get(f"/api/terrain/{result['id']}").status_code == 404


def three_dep_response(monkeypatch, surface, calls=None):
    """Answer exportImage requests with a plane or function of Web Mercator meters."""
    def get(url, params, **_kwargs):
        xmin, ymin, xmax, ymax = map(float, params["bbox"].split(","))
        width, height = map(int, params["size"].split(","))
        x = xmin + (np.arange(width) + .5) * (xmax - xmin) / width
        y = ymax - (np.arange(height) + .5) * (ymax - ymin) / height
        buffer = BytesIO()
        Image.fromarray(surface(*np.meshgrid(x, y)).astype(np.float32)).save(buffer, "TIFF")
        if calls is not None:
            calls.append(params)
        return type("Response", (), {"content": buffer.getvalue(), "headers": {"Content-Type": "image/tiff"},
                                     "raise_for_status": lambda self: None})()
    monkeypatch.setattr("terrain_app.elevation.requests.get", get)


@pytest.mark.parametrize("rotation", [0, 30])
def test_three_dep_samples_mercator_raster_at_pixel_centers(tmp_path, monkeypatch, rotation):
    from terrain_app.elevation import ThreeDepClient, mercator_meters, selection_coordinates
    bounds = Bounds(36.09, -82.13, 36.12, -82.09, rotation)
    calls = []
    plane = lambda x, y: 1500 + (x + 9_141_000) * .01 - (y - 4_313_000) * .02
    three_dep_response(monkeypatch, plane, calls)
    client = ThreeDepClient(tmp_path)
    result = client.fetch(bounds, 96)
    rows, columns = result.elevations.shape
    u, v = np.meshgrid(np.linspace(0, 1, columns), np.linspace(0, 1, rows))
    np.testing.assert_allclose(result.elevations, plane(*mercator_meters(*selection_coordinates(bounds, u, v))), atol=.02)
    metadata = result.metadata()
    assert metadata["source_id"] == "usgs3dep" and "3DEP" in metadata["source"]
    assert metadata["tile_pixel_spacing_m"] == pytest.approx(metadata["grid_spacing_m"] / 2, rel=.01)
    assert calls[0]["bboxSR"] == calls[0]["imageSR"] == 3857 and max(map(int, calls[0]["size"].split(","))) <= 1200
    client.fetch(bounds, 96)
    assert len(calls) == 1  # the second extraction reads the cached raster


def test_three_dep_rejects_missing_coverage(tmp_path, monkeypatch):
    from terrain_app.elevation import ThreeDepClient
    bounds = Bounds(36.09, -82.13, 36.12, -82.09)
    three_dep_response(monkeypatch, lambda x, y: np.where(x > -9_141_000, -9999, 1500))
    with pytest.raises(ValueError, match="choose Mapzen"):
        ThreeDepClient(tmp_path / "edge").fetch(bounds, 96)
    def truncated(url, params, **_kwargs):
        width, height = map(int, params["size"].split(","))
        buffer = BytesIO()
        Image.fromarray(np.zeros((height, width), dtype=np.float32)).save(buffer, "TIFF")
        return type("Response", (), {"content": buffer.getvalue()[:800], "headers": {"Content-Type": "image/tiff"},
                                     "raise_for_status": lambda self: None})()
    monkeypatch.setattr("terrain_app.elevation.requests.get", truncated)
    with pytest.raises(ValueError, match="choose Mapzen"):
        ThreeDepClient(tmp_path / "empty").fetch(bounds, 96)
    assert not list((tmp_path / "empty").rglob("*.tif"))  # an unreadable answer is never cached


def test_terrain_request_selects_its_elevation_source(application, terrain, monkeypatch):
    used = []
    clients = application.extensions["terrain"]["clients"]
    for name in clients:
        monkeypatch.setattr(clients[name], "fetch", lambda *_args, name=name: used.append(name) or terrain)
    client = application.test_client()
    bounds = terrain.metadata()["bounds"]
    assert client.post("/api/terrain", json={"bounds": bounds, "source": "lidar"}).status_code == 400
    for source in ("usgs3dep", None):
        identifier = client.post("/api/terrain", json={"bounds": bounds, **({"source": source} if source else {})}).get_json()["id"]
        for _ in range(100):
            if client.get(f"/api/jobs/{identifier}").get_json()["state"] == "ready":
                break
            time.sleep(.01)
    assert used == ["usgs3dep", "mapzen"]
    assert set(client.get("/api/config").get_json()["elevation_sources"]) == {"mapzen", "usgs3dep"}
    assert client.get("/api/terrain/example").get_json()["source_id"] == "mapzen"


def test_downloads_are_decoded_only_as_their_expected_image_format(tmp_path, monkeypatch):
    from terrain_app.elevation import ThreeDepClient
    gif, png = BytesIO(), BytesIO()
    Image.new("RGB", (256, 256)).save(gif, "GIF")
    Image.new("F", (100, 100)).save(png, "TIFF")
    response = lambda content: type("Response", (), {"content": content, "headers": {"Content-Type": "image/tiff"},
                                                     "raise_for_status": lambda self: None})()
    monkeypatch.setattr("terrain_app.elevation.requests.get", lambda *_a, **_k: response(gif.getvalue()))
    with pytest.raises(ValueError, match="Could not download"):
        ElevationClient(tmp_path / "tiles").tile(11, 344, 792)
    with pytest.raises(ValueError, match="choose Mapzen"):
        ThreeDepClient(tmp_path / "3dep").fetch(Bounds(36.09, -82.13, 36.12, -82.09), 96)
    assert not list(tmp_path.rglob("*.png")) and not list(tmp_path.rglob("*.tif"))


def test_feature_jobs_cannot_delay_terrain_jobs(application):
    pools = application.extensions["terrain"]["executor"]
    assert pools.terrain is not pools.features
