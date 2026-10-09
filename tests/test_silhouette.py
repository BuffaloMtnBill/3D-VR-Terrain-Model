from collections import Counter
from io import BytesIO
import json
import struct
import time
from xml.etree import ElementTree as ET
from zipfile import ZipFile

import numpy as np
import pytest

from terrain_app.elevation import Bounds, Terrain
from terrain_app.printing import CORE
from terrain_app.server import create_app
from terrain_app.silhouette import (FORMATS, MOUNTS, TEXT_STYLES, SilhouetteOptions, layout, mesh, outline_json, profile_points,
                                    silhouette_export, slice_heights, solids)


@pytest.fixture
def terrain():
    rows, columns = np.mgrid[0:24, 0:33]
    heights = (np.sin(columns/5)*40+np.cos(rows/4)*30+400).astype(np.float32)
    return Terrain(Bounds(36.08, -82.165, 36.145, -82.055), heights, 11, 2, "2026-10-01T00:00:00Z")


def options(**values):
    return SilhouetteOptions.from_dict(values)


def assert_closed(vertices, faces):
    edges = Counter(tuple(sorted(edge)) for face in faces for edge in ((face[0], face[1]), (face[1], face[2]), (face[2], face[0])))
    assert set(edges.values()) == {2}


def test_slice_matches_the_geography_page_profile(terrain):
    # As profileSamples() in app.js: rows for ew, columns for ns, blended between the two nearest lines.
    distances, values, length = slice_heights(terrain, options(direction="ew", position=50))
    cross = .5*23
    expected = terrain.elevations[11]*(1-(cross-11))+terrain.elevations[12]*(cross-11)
    assert np.allclose(values, expected) and length == pytest.approx(terrain.width) and distances[-1] == pytest.approx(terrain.width)
    _, values, length = slice_heights(terrain, options(direction="ns", position=100))
    assert np.allclose(values, terrain.elevations[:, -1]) and length == pytest.approx(terrain.height)


def test_outline_has_true_proportions_on_its_base(terrain):
    result = outline_json(terrain, options(width_mm=200, vertical_scale=1, base_mm=8))
    outer = np.array(result["outline"]["outer"])
    assert result["width_mm"] == pytest.approx(200) and outer[:, 0].min() == pytest.approx(0) and outer[:, 0].max() == pytest.approx(200)
    assert outer[:, 1].min() == pytest.approx(0) and result["min_profile_mm"] == pytest.approx(8, abs=.01)
    _, values, length = slice_heights(terrain, options())
    relief = (values.max()-values.min())*200/length
    assert result["height_mm"] == pytest.approx(8+relief, rel=.01)
    taller = outline_json(terrain, options(width_mm=200, vertical_scale=3, base_mm=8))
    assert taller["height_mm"]-8 == pytest.approx(3*relief, rel=.01)
    assert result["slice_length_m"] == pytest.approx(length, abs=.01) and result["warnings"] == []


def test_trim_mirror_and_smoothing(terrain):
    full, length = profile_points(terrain, options())
    trimmed, span = profile_points(terrain, options(trim=[25, 75]))
    assert span == pytest.approx(length/2) and trimmed[0, 0] == pytest.approx(0) and trimmed[-1, 0] == pytest.approx(180)
    assert trimmed[:, 1].min() == pytest.approx(8)  # the trimmed slice's own lowest point sits on the base
    mirrored, _ = profile_points(terrain, options(mirror=True))
    # Simplification may keep different points, so compare the mirrored line where the original has its points.
    assert np.allclose(np.interp(180-full[:, 0], mirrored[:, 0], mirrored[:, 1]), full[:, 1], atol=.02)
    smooth, _ = profile_points(terrain, options(smoothing=60))
    assert len(smooth) < len(full) and np.ptp(smooth[:, 1]) < np.ptp(full[:, 1])
    shaped, _ = profile_points(terrain, options(source="shaped", relief="lowland", relief_strength=100))
    assert not np.allclose(np.interp(full[:, 0], shaped[:, 0], shaped[:, 1]), full[:, 1], atol=.1)


@pytest.mark.parametrize("style", TEXT_STYLES)
@pytest.mark.parametrize("mount", MOUNTS)
def test_every_text_style_and_mount_makes_closed_solids(terrain, style, mount):
    choice = options(text="ROAN BOARD", text_style=style, mount=mount, base_mm=14, text_size=6)
    parts = solids(terrain, choice)
    names = [name for name, _, _ in parts]
    assert names == ["Silhouette"]+(["Text"] if style != "stencil" else [])+(["Stand feet"] if mount == "stand" else [])
    for name, _, solid in parts:
        assert solid.status().name == "NoError" and solid.volume() > 0
        assert_closed(*mesh(solid))
    body = parts[0][2]
    assert len(body.decompose()) == 1, "letters' counters stay attached, even as a stencil"
    if mount == "stand":
        assert len(parts[-1][2].decompose()) == 2
    plain = solids(terrain, options(base_mm=14, mount=mount))[0][2]
    if style == "emboss":
        assert body.volume() == pytest.approx(plain.volume())
        assert parts[1][2].bounding_box()[2] == pytest.approx(4)  # raised from the front face
    else:
        assert body.volume() < plain.volume()


def test_mount_holes_and_their_fallback(terrain):
    holes = outline_json(terrain, options(mount="holes", base_mm=8))
    assert len(holes["outline"]["holes"]) == 2 and [item["kind"] for item in holes["mount"]] == ["hole", "hole"]
    keyholes = outline_json(terrain, options(mount="keyholes", base_mm=4, vertical_scale=.5))
    assert keyholes["outline"]["holes"] == [] and "Raise the base" in keyholes["warnings"][0]
    stand = outline_json(terrain, options(mount="stand"))
    assert [item["kind"] for item in stand["mount"]] == ["foot", "foot"] and stand["outline"]["holes"] == []


def test_text_layout_and_warnings(terrain):
    left = layout(terrain, options(text="ROAN", text_align="left"))["text"].bounds
    right = layout(terrain, options(text="ROAN", text_align="right"))["text"].bounds
    assert left[0] == pytest.approx(3, abs=.05) and right[2] == pytest.approx(177, abs=.05)
    result = outline_json(terrain, options(text="ROAN MOUNTAIN STATE PARK", text_size=12))
    assert any("trimmed" in warning for warning in result["warnings"])
    assert any("3 mm" in warning for warning in outline_json(terrain, options(text="ROAN", text_size=2.5))["warnings"])
    assert any("printer bed" in warning for warning in outline_json(terrain, options(width_mm=300))["warnings"])
    assert any("cannot draw" in warning for warning in outline_json(terrain, options(text="ROAN 山"))["warnings"])


def test_stl_3mf_svg_and_json_files(terrain):
    choice = options(text="ROAN", text_style="emboss", mount="stand", text_color="#ffffff", body_color="#112233")
    content, mimetype, filename = silhouette_export(terrain, choice, "stl", "credits")
    count = struct.unpack("<I", content[80:84])[0]
    assert mimetype == "model/stl" and filename == "silhouette.stl" and len(content) == 84+50*count
    content, _, _ = silhouette_export(terrain, choice, "3mf", "credits")
    with ZipFile(BytesIO(content)) as archive:
        model = ET.fromstring(archive.read("3D/3dmodel.model"))
    ns = {"m": CORE}
    objects = [item for item in model.findall("m:resources/m:object", ns) if item.find("m:mesh", ns) is not None]
    assert [item.attrib["name"] for item in objects] == ["Color 1: Silhouette", "Color 2: Text", "Color 3: Stand feet"]
    colors = [item.attrib["displaycolor"] for item in model.findall("m:resources/m:basematerials/m:base", ns)]
    assert colors == ["#112233FF", "#FFFFFFFF", "#112233FF"]
    stencil, _, _ = silhouette_export(terrain, options(text="ROAN", text_style="stencil"), "3mf", "credits")
    with ZipFile(BytesIO(stencil)) as archive:
        model = ET.fromstring(archive.read("3D/3dmodel.model"))
    assert len([item for item in model.findall("m:resources/m:object", ns) if item.find("m:mesh", ns) is not None]) == 1
    svg, mimetype, _ = silhouette_export(terrain, options(text="ROAN", mount="holes", width_mm=150), "svg", "credits")
    root = ET.fromstring(svg)
    assert mimetype == "image/svg+xml" and root.attrib["width"] == "150.000mm" and root.attrib["viewBox"].startswith("0 0 150.000 ")
    paths = [item for item in root.iter() if item.tag.endswith("path")]
    assert len(paths) == 2 and paths[0].attrib["d"].count("M") == 3  # outline and two wall holes, then the text
    settings = json.loads(silhouette_export(terrain, choice, "json", "credits")[0])
    assert settings["settings"]["text"] == "ROAN" and settings["size_mm"]["width"] == 180 and settings["kind"] == "silhouette"
    with pytest.raises(ValueError, match="stl, 3mf, svg, or json"):
        silhouette_export(terrain, choice, "obj", "credits")


@pytest.mark.parametrize("value,message", [
    ([], "settings as an object"), ({"direction": "up"}, "slice direction"), ({"position": 120}, "slice position"),
    ({"trim": [50, 40]}, "start before the end"), ({"trim": [10, 12]}, "at least 5 percent"), ({"width_mm": 20}, "piece width"),
    ({"vertical_scale": 0}, "vertical scale"), ({"base_mm": True}, "base height"), ({"smoothing": "a"}, "Smoothing"),
    ({"source": "lidar"}, "profile source"), ({"relief": "steep"}, "elevation profile"), ({"mirror": "yes"}, "Mirror"),
    ({"text": "x"*61}, "one line"), ({"text_style": "paint"}, "text style"), ({"text_align": "top"}, "text position"),
    ({"mount": "glue"}, "mount"), ({"thickness_mm": 50}, "thickness"), ({"text_color": "red"}, "hex color for the text"),
    ({"text": "A", "text_depth": 4, "thickness_mm": 4}, "at least 0.4 mm"),
])
def test_validation_errors_are_sentences(value, message):
    with pytest.raises(ValueError, match=message):
        SilhouetteOptions.from_dict(value)


@pytest.fixture
def client(tmp_path, terrain):
    app = create_app({"TESTING": True, "CACHE_DIR": tmp_path / "tiles"})
    extension = app.extensions["terrain"]
    extension["jobs"]["t"] = {"state": "ready", "terrain": terrain, "accessed": time.monotonic()}
    yield app.test_client()
    extension["executor"].shutdown(wait=True)


def test_silhouette_endpoints(client):
    response = client.post("/api/silhouette/t/outline", json={"direction": "ns", "position": 30, "text": "ROAN", "mount": "holes"})
    assert response.status_code == 200
    data = response.get_json()
    assert {"outline", "text", "mount", "width_mm", "height_mm", "min_profile_mm", "warnings"} <= set(data) and data["text"]
    for format in FORMATS:
        response = client.post("/api/silhouette/t/export", json={"format": format, "text": "ROAN", "thickness_mm": 5})
        assert response.status_code == 200 and response.mimetype == FORMATS[format][0]
        assert f"filename={FORMATS[format][1]}" in response.headers["Content-Disposition"]
    assert client.post("/api/silhouette/t/export", json={"format": "obj"}).status_code == 400
    bad = client.post("/api/silhouette/t/outline", json={"width_mm": 1})
    assert bad.status_code == 400 and bad.get_json()["error"].endswith(".")
    assert client.post("/api/silhouette/missing/outline", json={}).status_code == 404
    assert client.post("/api/silhouette/t/outline", data="{}", content_type="text/plain").status_code == 415
