from collections import Counter
from io import BytesIO
import json
import time
from xml.etree import ElementTree as ET
from zipfile import ZipFile

import numpy as np
import pytest

from terrain_app.elevation import Bounds, Terrain, selection_coordinates
from terrain_app.landcover import COVER_NAMES, LandCoverClient, cover_class, face_classes, prepare_cover, print_colors
from terrain_app.mesh import ModelOptions, build_mesh
from terrain_app.printing import CORE, color_parts, export_3mf
from terrain_app.server import create_app

PALETTE = dict(zip(COVER_NAMES, ["#234e40", "#94b578", "#b99570", "#f0ead6", "#234e40", "#b99570"]))


@pytest.fixture
def terrain():
    heights = np.arange(6*13, dtype=np.float32).reshape(6, 13)+100
    return Terrain(Bounds(36.08, -82.165, 36.145, -82.055), heights, 11, 2, "2026-10-01T00:00:00Z")


@pytest.fixture
def cover(terrain):
    def region(left, right):
        return {"outer": [[left, 0], [right, 0], [right, 1], [left, 1], [left, 0]], "holes": []}
    return {"regions": {name: [region(index/6, (index+1)/6)] for index, name in enumerate(COVER_NAMES)},
            "counts": dict.fromkeys(COVER_NAMES, 1), "bounds": terrain.bounds.to_dict(),
            "source": "© OpenStreetMap contributors", "source_url": "https://www.openstreetmap.org/copyright"}


@pytest.mark.parametrize("tags,name", [({"natural": "wood"}, "dark_foliage"), ({"landuse": "forest"}, "dark_foliage"),
    ({"natural": "grassland"}, "light_foliage"), ({"landuse": "meadow"}, "light_foliage"),
    ({"natural": "bare_rock"}, "dirt"), ({"natural": "glacier"}, "snow"),
    ({"natural": "water"}, "water"), ({"building": "yes"}, "buildings"), ({"building": "no"}, None)])
def test_osm_surface_classes(tags, name):
    assert cover_class(tags) == name


def test_color_classification_is_discrete_and_preserves_both_triangle_orders(terrain, cover):
    rows, columns = terrain.elevations.shape
    classes = face_classes(cover, rows, columns)
    expected = np.repeat(np.arange(6), 4).tolist()
    assert classes.tolist() == expected*(rows-1)
    assert set(classes.tolist()) == set(range(6))


def test_water_islands_and_building_priority_preserve_land_color(cover):
    region = {"outer": [[.2, .2], [.8, .2], [.8, .8], [.2, .8], [.2, .2]],
              "holes": [[[.4, .4], [.6, .4], [.6, .6], [.4, .6], [.4, .4]]]}
    cover["regions"] = {name: [] for name in COVER_NAMES}
    cover["regions"]["dark_foliage"] = [{"outer": [[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]], "holes": []}]
    cover["regions"]["water"] = [region]
    classes = face_classes(cover, 13, 13).reshape(12, 12, 2)
    assert classes[3, 3, 0] == COVER_NAMES.index("water")
    assert classes[6, 6, 0] == COVER_NAMES.index("dark_foliage")
    assert classes[0, 0, 0] == COVER_NAMES.index("dark_foliage")
    cover["regions"]["buildings"] = [{"outer": region["outer"], "holes": []}]
    assert face_classes(cover, 13, 13).reshape(12, 12, 2)[6, 6, 0] == COVER_NAMES.index("buildings")


@pytest.mark.parametrize("angle", [0, 35, -90])
def test_mapped_print_polygons_align_with_rotated_selection(terrain, angle):
    terrain.bounds = Bounds(**terrain.bounds.to_dict(), rotation_deg=angle)
    u, v = np.array([0, 1, 1, 0, 0]), np.array([0, 0, 1, 1, 0])
    longitude, latitude = selection_coordinates(terrain.bounds, u, v)
    way = {"type": "way", "id": 10, "tags": {"natural": "wood"},
           "geometry": [{"lon": x, "lat": y} for x, y in zip(longitude, latitude)]}
    result = prepare_cover({"elements": [way]}, terrain.bounds)
    assert result["counts"]["dark_foliage"] == 1
    assert np.all(face_classes(result, *terrain.elevations.shape) == 0)


def test_unmapped_ground_uses_dirt_and_incomplete_response_is_an_error(terrain):
    result = prepare_cover({"elements": []}, terrain.bounds)
    assert np.all(face_classes(result, *terrain.elevations.shape) == COVER_NAMES.index("dirt"))
    with pytest.raises(ValueError, match="did not finish"):
        prepare_cover({"elements": [], "remark": "timeout"}, terrain.bounds)


def test_cover_cache_is_reused_without_network_requests(tmp_path, terrain, cover, monkeypatch):
    from terrain_app.services import cache_json
    import hashlib
    key = hashlib.sha256(json.dumps(terrain.bounds.to_dict(), sort_keys=True).encode()).hexdigest()
    cache_json(tmp_path / f"{key}.json", cover)
    monkeypatch.setattr("terrain_app.landcover.requests.post", lambda *_args, **_kwargs: pytest.fail("Unexpected request"))
    assert LandCoverClient(tmp_path).fetch(terrain.bounds) == cover


def volume(vertices, faces):
    triangles = vertices[faces]
    return np.einsum("ij,ij->i", triangles[:, 0], np.cross(triangles[:, 1], triangles[:, 2])).sum()/6


def test_four_color_parts_are_closed_and_partition_the_original_solid(terrain, cover):
    options = ModelOptions(size_mm=150)
    classes = face_classes(cover, *terrain.elevations.shape)
    parts = color_parts(terrain, options, PALETTE, classes)
    assert len(parts) == 4
    assert any(part["name"] == "Dark foliage / Water" for part in parts)
    total_volume = 0
    for part in parts:
        faces, vertices = part["faces"], part["vertices"]
        edges = Counter(tuple(sorted(edge)) for face in faces for edge in ((face[0], face[1]), (face[1], face[2]), (face[2], face[0])))
        assert set(edges.values()) == {2}, "Every color part must be closed"
        normals = np.cross(vertices[faces[:, 1]]-vertices[faces[:, 0]], vertices[faces[:, 2]]-vertices[faces[:, 0]])
        assert np.all(np.linalg.norm(normals, axis=1) > 0)
        assert volume(vertices, faces) > 0
        total_volume += volume(vertices, faces)
    assert total_volume == pytest.approx(volume(*build_mesh(terrain, options)), rel=1e-10)
    combined = np.concatenate([part["vertices"] for part in parts])
    assert np.ptp(combined[:, :2], axis=0).max() == pytest.approx(150)
    assert combined[:, 2].min() == 0


def test_equal_colors_merge_into_one_solid_part(terrain, cover):
    palette = dict.fromkeys(COVER_NAMES, "#123456")
    parts = color_parts(terrain, ModelOptions(), palette, face_classes(cover, *terrain.elevations.shape))
    assert len(parts) == 1
    assert volume(parts[0]["vertices"], parts[0]["faces"]) == pytest.approx(volume(*build_mesh(terrain, ModelOptions())))


def test_3mf_is_a_native_model_with_materials_and_assembly_components(terrain, cover):
    file, mime, filename = export_3mf(terrain, ModelOptions(), PALETTE, face_classes(cover, *terrain.elevations.shape), "OSM credits")
    assert mime == "model/3mf" and filename == "terrain-print.3mf"
    with ZipFile(file) as archive:
        assert set(archive.namelist()) == {"[Content_Types].xml", "_rels/.rels", "3D/3dmodel.model"}
        model = ET.fromstring(archive.read("3D/3dmodel.model"))
    ns = {"m": CORE}
    assert model.attrib["unit"] == "millimeter"
    assert len(model.findall("m:resources/m:basematerials/m:base", ns)) == 4
    assert len(model.findall("m:resources/m:object/m:components/m:component", ns)) == 4
    assert len(model.findall("m:resources/m:object/m:mesh", ns)) == 4
    metadata = json.loads(model.find("m:metadata[@name='Description']", ns).text)
    assert metadata["print_palette"] == PALETTE
    assert model.find("m:metadata[@name='Copyright']", ns).text == "OSM credits"


def test_print_export_rejects_open_base_and_more_than_four_colors(terrain, cover):
    classes = face_classes(cover, *terrain.elevations.shape)
    with pytest.raises(ValueError, match="Solid base"):
        color_parts(terrain, ModelOptions(solid=False), PALETTE, classes)
    palette = {name: f"#{index:06x}" for index, name in enumerate(COVER_NAMES)}
    with pytest.raises(ValueError, match="four colors"):
        color_parts(terrain, ModelOptions(), palette, classes)


@pytest.mark.parametrize("colors", [{}, {**PALETTE, "water": "blue"}, {**PALETTE, "extra": "#ffffff"}])
def test_print_palette_validation(colors):
    with pytest.raises(ValueError):
        print_colors(colors)


def test_surface_job_and_native_print_download_use_saved_model_bounds(tmp_path, terrain, cover, monkeypatch):
    app = create_app({"TESTING": True, "CACHE_DIR": tmp_path / "tiles"})
    try:
        app.extensions["terrain"]["jobs"]["print"] = {"state": "ready", "terrain": terrain, "accessed": time.monotonic()}
        calls = []
        def fetch(bounds):
            calls.append(bounds)
            return cover
        monkeypatch.setattr(app.extensions["terrain"]["landcover"], "fetch", fetch)
        client = app.test_client()
        assert client.post("/api/export/print", json={"format": "3mf", "print_palette": PALETTE}).status_code == 400
        assert client.post("/api/landcover/print", json={}).status_code == 202
        for _ in range(100):
            result = client.get("/api/landcover/print").get_json()
            if result["state"] == "ready":
                break
            time.sleep(.01)
        assert result["face_classes"] == face_classes(cover, *terrain.elevations.shape).tolist()
        assert calls == [terrain.bounds]
        assert client.post("/api/landcover/print", json={}).status_code == 200
        response = client.post("/api/export/print", json={"format": "3mf", "print_palette": PALETTE})
        assert response.status_code == 200 and response.mimetype == "model/3mf"
        assert "terrain-print.3mf" in response.headers["Content-Disposition"]
        with ZipFile(BytesIO(response.data)) as archive:
            assert "3D/3dmodel.model" in archive.namelist()
        assert client.post("/api/landcover/missing", json={}).status_code == 404
        assert client.post("/api/landcover/print", json={}, headers={"Origin": "https://example.com"}).status_code == 403
        assert client.post("/api/export/print", json={"format": "metadata", "print_palette": PALETTE}).get_json()["print_palette"] == PALETTE
    finally:
        app.extensions["terrain"]["executor"].shutdown(wait=True)


def printable_fixture():
    from terrain_app.features import LAYER_NAMES
    ring = [[.4, .4], [.6, .4], [.6, .6], [.4, .6], [.4, .4]]
    return {"layers": {name: [{"id": name, "kind": "primary" if name == "roads" else "river", "height_m": 20,
                "lines": [[[.1, .2], [.9, .8]]], "polygons": [{"outer": ring, "holes": []}] if name in {"water", "buildings"} else []}]
            for name in LAYER_NAMES}}


def assert_closed_parts(parts):
    from terrain_app.print_features import union
    solids = []
    for part in parts:
        solid = part["solid"]
        assert solid.volume() > 0
        assert volume(part["vertices"], part["faces"]) == pytest.approx(solid.volume(), rel=1e-10)
        edges = Counter(tuple(sorted(edge)) for face in part["faces"] for edge in ((face[0], face[1]), (face[1], face[2]), (face[2], face[0])))
        assert set(edges.values()) == {2}
        solids.append(solid)
    assert sum(solid.volume() for solid in solids) == pytest.approx(union(solids).volume(), rel=1e-6)
    for index, solid in enumerate(solids):
        for other in solids[index+1:]:
            assert (solid ^ other).volume() == pytest.approx(0, abs=1e-3)  # below 0.001 mm³ boolean roundoff


@pytest.mark.parametrize("name", ["roads", "railways", "borders", "water", "cities", "parks", "at", "buildings"])
def test_every_feature_is_printable_and_unchecked_layers_are_absent(terrain, name):
    from terrain_app.print_features import feature_color_parts
    options = ModelOptions()
    palette = dict.fromkeys(COVER_NAMES, "#123456")
    classes = np.zeros(2*(terrain.elevations.shape[0]-1)*(terrain.elevations.shape[1]-1), dtype=np.uint8)
    base = color_parts(terrain, options, palette, classes)
    styles = {name: {"enabled": True, "color": "#ffffff"}}
    result, counts = feature_color_parts(terrain, options, palette, base, styles, printable_fixture())
    assert len(result) == 2 and counts[name] == 1
    assert_closed_parts(result)
    total = sum(volume(part["vertices"], part["faces"]) for part in result)
    if name == "buildings":
        assert total > volume(*build_mesh(terrain, options))
    else:
        assert total == pytest.approx(volume(*build_mesh(terrain, options)), rel=1e-6)
    styles[name]["enabled"] = False
    disabled, _ = feature_color_parts(terrain, options, palette, base, styles, printable_fixture())
    assert len(disabled) == 1 and disabled[0]["color"] == "#123456"
    np.testing.assert_array_equal(disabled[0]["faces"], base[0]["faces"])


def test_3mf_feature_colors_share_materials_and_overlaps_are_partitioned(terrain, cover):
    from terrain_app.features import LAYER_NAMES
    from terrain_app.print_features import feature_color_parts
    options = ModelOptions()
    styles = {name: {"enabled": True, "color": PALETTE[COVER_NAMES[index%6]]} for index, name in enumerate(LAYER_NAMES)}
    classes = face_classes(cover, *terrain.elevations.shape)
    result, _ = feature_color_parts(terrain, options, PALETTE, color_parts(terrain, options, PALETTE, classes), styles, printable_fixture())
    assert len(result) <= 4
    assert_closed_parts(result)
    file, _, _ = export_3mf(terrain, options, PALETTE, classes, "OSM", styles, printable_fixture())
    with ZipFile(file) as archive:
        model = ET.fromstring(archive.read("3D/3dmodel.model"))
    ns = {"m": CORE}
    metadata = json.loads(model.find("m:metadata[@name='Description']", ns).text)
    assert all(metadata["feature_counts"][name] == 1 for name in LAYER_NAMES)
    assert metadata["feature_layers"] == styles
    assert len(model.findall("m:resources/m:basematerials/m:base", ns)) <= 4
    names = " / ".join(part["name"] for part in metadata["color_parts"])
    assert "Buildings" in names and "AT" in names and "Roads" in names


def test_print_features_honor_road_and_water_detail(terrain):
    from terrain_app.print_features import selected_features
    data = printable_fixture()
    data["layers"]["roads"].append({"kind": "service"})
    data["layers"]["water"].extend([{"kind": "stream"}, {"kind": "pond", "area_m2": 50}, {"kind": "lake", "area_m2": 50000}])
    styles = {name: {"enabled": True, "color": "#123456", "detail": 0} for name in ("roads", "water")}
    filtered = selected_features(data, styles, terrain)
    assert len(filtered["roads"]) == 1
    assert [feature["kind"] for feature in filtered["water"]] == ["river", "lake"]
    for style in styles.values():
        style["detail"] = 100
    assert len(selected_features(data, styles, terrain)["water"]) == 4


def test_features_require_loaded_data_and_combined_colors_must_fit_four(terrain, cover):
    classes = face_classes(cover, *terrain.elevations.shape)
    styles = {"at": {"enabled": True, "color": PALETTE["snow"]}}
    with pytest.raises(ValueError, match="map features to load"):
        export_3mf(terrain, ModelOptions(), PALETTE, classes, "OSM", styles)
    styles["at"]["color"] = "#ff0000"
    with pytest.raises(ValueError, match="enabled map features"):
        export_3mf(terrain, ModelOptions(), PALETTE, classes, "OSM", styles, printable_fixture())


def test_feature_export_api_uses_loaded_features_for_saved_terrain(tmp_path, terrain, cover):
    app = create_app({"TESTING": True, "CACHE_DIR": tmp_path / "tiles"})
    try:
        extension = app.extensions["terrain"]
        extension["jobs"]["print"] = {"state": "ready", "terrain": terrain, "accessed": time.monotonic()}
        extension["cover_jobs"]["print"] = {"state": "ready", "data": {"face_classes": face_classes(cover, *terrain.elevations.shape).tolist()}}
        payload = {"format": "3mf", "print_palette": PALETTE, "feature_layers": {"at": {"enabled": True, "color": PALETTE["snow"]}}}
        client = app.test_client()
        response = client.post("/api/export/print", json=payload)
        assert response.status_code == 400 and "map features to load" in response.get_json()["error"]
        extension["feature_jobs"]["print"] = {"state": "ready", "data": printable_fixture()}
        response = client.post("/api/export/print", json=payload)
        assert response.status_code == 200
        with ZipFile(BytesIO(response.data)) as archive:
            model = ET.fromstring(archive.read("3D/3dmodel.model"))
        metadata = json.loads(model.find(f"{{{CORE}}}metadata[@name='Description']").text)
        assert metadata["feature_counts"]["at"] == 1
    finally:
        app.extensions["terrain"]["executor"].shutdown(wait=True)


def test_collinear_boolean_contacts_are_retriangulated_without_holes():
    from terrain_app.print_features import clean_collinear_faces
    vertices = np.array([[0, 0, 0], [1, 0, 0], [.5, 0, 0], [0, 1, 0], [0, 0, 1]], dtype=np.float64)
    faces = np.array([[0, 3, 2], [2, 3, 1], [0, 2, 1], [0, 1, 4], [0, 4, 3], [1, 3, 4]], dtype=np.uint64)
    cleaned = clean_collinear_faces(vertices, faces)
    triangles = vertices[cleaned]
    assert np.all(np.linalg.norm(np.cross(triangles[:, 1]-triangles[:, 0], triangles[:, 2]-triangles[:, 0]), axis=1) > 0)
    edges = Counter(tuple(sorted(edge)) for face in cleaned for edge in ((face[0], face[1]), (face[1], face[2]), (face[2], face[0])))
    assert set(edges.values()) == {2}
    assert volume(vertices, cleaned) == pytest.approx(volume(vertices, faces))
