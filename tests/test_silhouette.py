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
from terrain_app.routes import prepare_route
from terrain_app.silhouette import (FORMATS, MOUNTS, PRESET_DATA, PRESETS, TEXT_STYLES, SilhouetteOptions, Sources, layout, mesh, outline_json,
                                    part_groups, profile_points, route_profile, silhouette_export, slice_heights, solids, view_layers, with_buildings,
                                    COLOR_LIMIT)

FIXTURES = __import__("pathlib").Path(__file__).parent / "fixtures"


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
    assert colors == ["#112233FF", "#FFFFFFFF"]  # the stand feet share the body's material
    assert [item.attrib["pindex"] for item in objects] == ["0", "1", "0"]
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
    ({"text": "x"*61}, "at most 3 lines"), ({"text": "A\nB\nC\nD"}, "at most 3 lines"), ({"text_style": "paint"}, "text style"), ({"text_align": "top"}, "text position"),
    ({"mount": "glue"}, "mount"), ({"thickness_mm": 50}, "thickness"), ({"text_color": "red"}, "hex color for the text"),
    ({"text": "A", "text_depth": 4, "thickness_mm": 4}, "at least 0.4 mm"), ({"fit": "shelf"}, "fit"),
    ({"source": "route"}, "Upload a GPX route"), ({"layers": [{"position": 10}, {"position": 20}]}, "lamp-base or shadow-box fit"),
    ({"layers": [{"position": 120}], "fit": "box"}, "Layer 1's slice position"), ({"layers": [{"position": 1}]*8, "fit": "box"}, "1 to 7 layers"),
    ({"fit": "lamp", "mount": "stand"}, "set the mount to none"), ({"peg_count": 2.5}, "whole number"), ({"preset": "teapot"}, "presets"),
    ({"fit": "box", "box_depth": 10, "layers": [{"position": p} for p in (10, 30, 50, 70, 90)]}, "too shallow for 5 layers"),
    ({"fit": "lamp", "layer_spacing": 3, "thickness_mm": 2, "layers": [{"position": 10}, {"position": 20}]}, "1.2 mm between"),
    ({"photo_slot": "yes"}, "photo slot must be true or false"),
    ({"thickness_near_mm": .5}, "nearest layer's thickness"), ({"thickness_far_mm": 40}, "farthest layer's thickness"),
    ({"thickness_by_distance": 1}, "Thicker when closer must be true or false"),
    ({"fit": "box", "layers": [{"position": 10, "thickness_mm": 50}]}, "Layer 1's thickness"),
    ({"fit": "lamp", "layer_spacing": 3.8, "thickness_mm": 2, "layers": [{"position": 10, "thickness_mm": 3}, {"position": 20}]}, "layers 1 and 2 \\(3 and 2 mm thick\\)"),
    ({"source": "viewpoint", "view_point": [36.1, -82.1], "view_min_radius_m": 60000}, "minimum distance"),
    ({"color_by_distance": "on"}, "Color by distance must be true or false"), ({"distance_colors": []}, "one to four six-digit hex colors"),
    ({"distance_colors": ["#000000"]*5}, "one to four"), ({"distance_colors": ["green"]}, "one to four"),
    ({"color_zones": True, "fit": "lamp", "layers": [{"position": 10}, {"position": 20}]}, "Color zones need a viewpoint with at least two ridges or bands."),
    ({"color_zones": True, "source": "viewpoint", "view_point": [36.1, -82.1]}, "Color zones need a viewpoint with at least two ridges or bands."),
    ({"color_zones": True, "source": "viewpoint", "view_point": [36.1, -82.1], "fit": "box", "layers": [{"position": 30}, {"position": 100}]},
     "Color zones make one piece; turn off the shadow-box fit or the zones."),
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


# --- Presets, layers, fits, and route profiles -------------------------------------------------------------

def gpx(points, name="Roan 10K", time="2026-05-04T13:00:00Z"):
    items = "".join(f'<trkpt lat="{lat}" lon="{lon}">{"" if ele is None else f"<ele>{ele}</ele>"}<time>{time}</time></trkpt>' for lat, lon, ele in points)
    return f'<?xml version="1.0"?><gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>{name}</name><trkseg>{items}</trkseg></trk></gpx>'.encode()


def course(elevations=True, count=600):
    """About 10.3 km inside the test frame, with two climbs."""
    t = np.linspace(0, 1, count)
    return list(zip(36.09+.045*t, -82.16+.1*t, (900+300*np.sin(t*np.pi*2)**2) if elevations else [None]*count))


@pytest.fixture
def route():
    return prepare_route(gpx(course()))


def preset_payload(name, route=None, **extra):
    """A preset's settings as silhouette.js sends them: the tab thickness rule, layers spread near side first, and a caption."""
    preset = PRESET_DATA["presets"][name]
    payload = {"preset": name, **preset["settings"], "text": "ROAN"}
    rules = preset.get("rules", {})
    if rules.get("tab_thickness"):
        payload["thickness_mm"] = 4.0-.2
    if "layers" in rules:
        rule = rules["layers"]
        positions = np.linspace(rule["high"], rule["low"], rule["count"])  # ew: the near (south) side is the front
        payload["layers"] = [{"position": float(position), "base_mm": payload["base_mm"]+index*rule["step"], "color": "#234e40"}
                             for index, position in enumerate(positions)]
    if payload.get("source") == "viewpoint":  # the ridge test terrain's three ridges, as zones
        payload |= VIEW | {"view_ridges": True, "layers": payload["layers"][:3]}
    if payload.get("source") == "route":
        payload["route_id"] = route["id"]
    if rules.get("caption"):
        payload["text"] = "ROAN 10K\n2026-05-04\n1:02:03" if name in ("race", "box-chart") else "ROAN\n2026"
    if name in ("race", "box-chart", "box-trail"):
        payload["vertical_scale"] = 10
    return payload | extra


EXPECTED = {
    "custom": ["Silhouette", "Text"],
    "glow-edge": ["Silhouette", "Text"],
    "glow-stencil": ["Silhouette"],
    "glow-layers": ["Layer 1 (front) · 2.0 mm", "Text", "Layer 2 · 2.0 mm", "Layer 3 (back) · 2.0 mm", "Comb base"],
    "glow-clouds": ["Layer 1 (front) · 2.0 mm", "Text", "Layer 2 · 2.0 mm", "Layer 3 · 2.0 mm", "Layer 4 · Clouds (back) · 2.0 mm", "Comb base"],
    "glow-skyline": ["Silhouette"],
    "box-diorama": ["Layer 1 (front) · 2.0 mm", "Text", "Layer 2 · 2.0 mm", "Layer 3 · 2.0 mm", "Layer 4 · 2.0 mm", "Layer 5 (back) · 2.0 mm",
                    "Spacer comb (left)", "Spacer comb (right)"],
    "box-trail": ["Silhouette", "Text", "Spacer comb (left)", "Spacer comb (right)"],
    "box-chart": ["Silhouette", "Text", "Markings", "Spacer comb (left)", "Spacer comb (right)"],
    "box-anniversary": ["Silhouette", "Spacer comb (left)", "Spacer comb (right)"],
    "race": ["Silhouette", "Text", "Markings"],
    "flat-zones": ["Zone 1 (nearest)", "Zone 2", "Zone 3 (farthest)", "Text", "Stand feet"],
}


def test_every_preset_is_listed_once():
    listed = [name for group in PRESET_DATA["groups"] for name in group["presets"]]
    assert sorted(listed+["custom"]) == sorted(PRESETS) and set(EXPECTED) == set(PRESETS)
    assert [group["name"] for group in PRESET_DATA["groups"]] == ["Glow lamps", "Shadow boxes", "Flat pieces", "Race profile"]


@pytest.mark.parametrize("name", PRESETS)
def test_every_preset_makes_closed_named_parts(terrain, route, name):
    buildings = json.loads((FIXTURES / "features.json").read_text())["layers"]["buildings"]
    choice = SilhouetteOptions.from_dict(preset_payload(name, route))
    terrain = ridge_terrain() if choice.source == "viewpoint" else terrain
    shapes = layout(terrain, choice, Sources(route, buildings))
    parts = solids(terrain, choice, shapes)
    assert [part for part, _, _ in parts] == EXPECTED[name], shapes["warnings"]
    for part, _, solid in parts:
        assert solid.status().name == "NoError" and solid.volume() > 0, part
        assert_closed(*mesh(solid))
        if part not in ("Text", "Markings", "Stand feet") and not part.startswith("Zone"):  # two feet; a zone may show in several places
            assert len(solid.decompose()) == 1, part
    assert not [warning for warning in shapes["warnings"] if "trimmed" in warning or "need a base" in warning or "printer bed" in warning]
    # Parts lie side by side on the bed, never overlapping (inlays sit inside their own part).
    boxes = [solid.bounding_box() for part, _, solid in parts if part not in ("Text", "Markings") and not part.startswith("Zone")]
    for index, a in enumerate(boxes):
        assert min(a[2], a[5]) >= -1e-6 or name == "custom"
        for b in boxes[index+1:]:
            assert a[3] <= b[0]+1e-6 or b[3] <= a[0]+1e-6 or a[4] <= b[1]+1e-6 or b[4] <= a[1]+1e-6


def test_lamp_tab_fits_the_slot(terrain):
    edge = SilhouetteOptions.from_dict(preset_payload("glow-edge"))
    body = solids(terrain, edge)[0][2]
    x0, y0, z0, x1, y1, z1 = body.bounding_box()
    assert y0 == pytest.approx(-8) and z1 == pytest.approx(3.8)  # the tab drops 8 mm, as thick as the whole panel
    tab = body ^ cube_between((-1, -6, -1), (200, -2, 10))  # 4 mm of the tab: 159.6 × 3.8 mm, centered under the 180 mm piece
    assert tab.volume() == pytest.approx(159.6*3.8*4, rel=1e-3) and tab.bounding_box()[0] == pytest.approx(10.2)
    data = outline_json(terrain, edge)
    assert data["fit"]["tab"]["x1"]-data["fit"]["tab"]["x0"] == pytest.approx(159.6) and data["parts"][0]["name"] == "Silhouette with lamp tab"
    narrow = outline_json(terrain, SilhouetteOptions.from_dict(preset_payload("glow-edge", width_mm=120)))
    assert any("narrower than the lamp's slot" in warning for warning in narrow["warnings"])
    stencil = outline_json(terrain, SilhouetteOptions.from_dict(preset_payload("glow-stencil")))
    assert any("thinner than the 3.8 mm tab" in note for note in stencil["notes"])


def cube_between(low, high):
    from manifold3d import Manifold
    return Manifold.cube(tuple(b-a for a, b in zip(low, high))).translate(low)


def test_layered_glow_comb_base_slots_match_the_layers(terrain):
    choice = SilhouetteOptions.from_dict(preset_payload("glow-layers"))
    data = outline_json(terrain, choice)
    comb = data["fit"]["comb_base"]
    assert len(comb["slots"]) == 3 and comb["slot_width"] == pytest.approx(2.3) and np.diff(comb["slots"]) == pytest.approx([6, 6])
    assert [layer["base_mm"] for layer in data["layers"]] == [14, 22, 30] and [layer["y"] for layer in data["layers"]] == [3, 3, 3]
    # Front to back: each layer's back face is 6 mm further back, and the rear ridges stand taller.
    assert np.diff([layer["z"] for layer in data["layers"]]) == pytest.approx([-6, -6])
    assert data["layers"][0]["height_mm"] < data["layers"][2]["height_mm"]
    assert layout(terrain, choice)["text"].bounds[1] >= 5.5  # the caption stays above the comb's 5 mm slots
    base = [solid for name, _, solid in solids(terrain, choice) if name == "Comb base"][0]
    x0, y0, z0, x1, y1, z1 = base.bounding_box()
    assert x1-x0 == pytest.approx(170) and z1 == pytest.approx(8+8)  # printed upside down: the tab stands on top
    assert base.slice(2).area() == pytest.approx(170*comb["depth"]-3*170*2.3, rel=1e-3)  # the slots, open on the bed


# --- Printability of lamp and box panels --------------------------------------------------------------------

def test_printable_trims_thin_spikes_and_keeps_square_corners():
    from shapely.geometry import Polygon
    from terrain_app.silhouette import printable
    # A 100 × 20 mm panel with a 0.6 mm wide, 15 mm tall spike, a 6 mm wide peak, and a hair-thin neck to a blob.
    panel = Polygon([(0, 0), (100, 0), (100, 20), (80.6, 20), (80.3, 35), (80, 20), (66, 20), (63, 30), (60, 20),
                     (30.4, 20), (30.4, 26), (34, 26), (34, 32), (28, 32), (28, 26), (30.2, 26), (30.2, 20), (0, 20)])
    assert panel.is_valid
    kept, removed = printable(panel, 1.0)
    assert removed > 1 and kept.bounds == pytest.approx((0, 0, 100, 30), abs=.6), "The spike and the islanded blob go; the peak stays"
    assert kept.bounds[3] < 31 and kept.intersects(Polygon([(62.5, 28), (63.5, 28), (63.5, 29), (62.5, 29)]))
    assert all(kept.covers(Polygon([(x, y), (x+.01, y), (x+.01, y+.01), (x, y+.01)])) for x, y in ((0, 0), (99.99, 0))), "The base's corners stay square"
    assert printable(panel, 0)[0] is panel


def test_lamp_panels_trim_slivers_and_report_it(terrain):
    # Gentle ground sampled 400 times across, with a one-sample needle: under 1 mm wide on a 170 mm panel.
    spiky = np.tile((np.sin(np.arange(400)/40)*30+400).astype(np.float32), (24, 1))
    spiky[:, 200] += 300
    needle = Terrain(terrain.bounds, spiky, 11, 2, "2026-10-01T00:00:00Z")
    trimmed = layout(needle, SilhouetteOptions.from_dict(preset_payload("glow-edge", width_mm=170, vertical_scale=1)))
    kept = layout(needle, SilhouetteOptions.from_dict(preset_payload("glow-edge", width_mm=170, vertical_scale=1, min_feature_mm=0)))
    assert trimmed["layers"][0]["height"] < kept["layers"][0]["height"]-2, "The needle is trimmed off"
    assert any("narrower than 1 mm were trimmed" in note for note in trimmed["notes"])
    assert not any("trimmed" in note for note in kept["notes"])
    plain = layout(needle, options(vertical_scale=1))  # a flat piece without a fit is left as drawn
    assert plain["layers"][0]["outline"].bounds[3] == pytest.approx(plain["layers"][0]["points"][:, 1].max())
    assert kept["layers"][0]["outline"].bounds[3] == pytest.approx(kept["layers"][0]["points"][:, 1].max())


def test_comb_clearance_and_chamfered_slot_mouths(terrain):
    loose = outline_json(terrain, SilhouetteOptions.from_dict(preset_payload("glow-layers", comb_clearance=.5)))
    assert loose["fit"]["comb_base"]["slot_width"] == pytest.approx(2.5)
    box = outline_json(terrain, SilhouetteOptions.from_dict(preset_payload("box-diorama", comb_clearance=.1)))
    assert [slot["width"] for slot in box["fit"]["combs"]["slots"] if slot["kind"] == "layer"][0] == pytest.approx(box["layers"][0]["thickness_mm"]+.1)
    with pytest.raises(ValueError, match="comb slot clearance"):
        SilhouetteOptions.from_dict(preset_payload("glow-layers", comb_clearance=2))
    choice = SilhouetteOptions.from_dict(preset_payload("glow-layers"))
    base = [solid for name, _, solid in solids(terrain, choice) if name == "Comb base"][0]
    # At the bed each of the 3 slots is 2 × 0.4 mm wider (the chamfer); above it, the plain 2.3 mm slot.
    assert base.slice(.02).area() == pytest.approx(base.slice(2).area()-3*170*(.8-.04), rel=2e-3)
    assert base.slice(.6).area() == pytest.approx(base.slice(2).area(), rel=1e-4)


def test_hidden_rear_panel_is_flagged(terrain):
    twins = layout(terrain, SilhouetteOptions.from_dict(preset_payload("glow-layers", layers=[{"position": 50, "base_mm": 14}, {"position": 50, "base_mm": 14}])))
    assert any("Layer 2 (back) barely shows" in warning for warning in twins["warnings"])
    assert not any("barely shows" in warning for warning in layout(terrain, SilhouetteOptions.from_dict(preset_payload("glow-layers")))["warnings"])


def test_diorama_combs_box_fit_and_height_limit(terrain):
    choice = SilhouetteOptions.from_dict(preset_payload("box-diorama", photo_slot=True, led_channel=True))
    assert choice.width_mm == 199
    data = outline_json(terrain, choice)
    slots = data["fit"]["combs"]["slots"]
    assert [slot["kind"] for slot in slots] == ["layer"]*5+["led", "photo"] and data["fit"]["combs"]["length"] == 39.5
    assert all(b["center"]-b["width"]/2-(a["center"]+a["width"]/2) >= 1.2-1e-9 for a, b in zip(slots, slots[1:]))
    assert slots[0]["width"] == pytest.approx(2.3) and slots[5] | {"center": 0} == {"kind": "led", "center": 0, "width": 5, "depth": 2}
    assert [part["name"] for part in data["parts"]] == ["Layer 1 (front)", "Layer 2", "Layer 3", "Layer 4", "Layer 5 (back)", "Spacer comb"]
    assert data["parts"][-1]["count"] == 2 and data["fit"]["box"] == {"width": 200, "height": 150, "depth": 40}
    tall = outline_json(terrain, SilhouetteOptions.from_dict(preset_payload("box-diorama", box_height=40, vertical_scale=10)))
    assert any("box's inner height" in warning for warning in tall["warnings"])
    assert max(layer["height_mm"] for layer in tall["layers"]) == pytest.approx(40-3-.5)


def test_skyline_raises_the_slice_to_building_tops(terrain):
    buildings = json.loads((FIXTURES / "features.json").read_text())["layers"]["buildings"]
    choice = SilhouetteOptions.from_dict(preset_payload("glow-skyline", source="true", vertical_scale=20))
    distances, values, _ = slice_heights(terrain, choice, 35)
    raised, tops, count = with_buildings(terrain, choice, 35, distances, values, buildings)
    assert count >= 1
    inside = (raised > .73*terrain.width) & (raised < .84*terrain.width)
    outside = (raised < .71*terrain.width) | (raised > .86*terrain.width)
    ground = np.interp(raised[inside], distances, values)
    assert (tops[inside]-ground).min() >= 12 and (tops[inside]-ground).max() == pytest.approx(900, abs=5)  # the fixture's 900 m part
    assert np.allclose(tops[outside], np.interp(raised[outside], distances, values))
    without = with_buildings(terrain, choice, 70, distances, values, buildings)[2]
    assert without == 0  # the slice misses them
    plain = layout(terrain, choice, Sources())
    assert "Turn on the Buildings map layer and wait for it to load to include buildings." in plain["warnings"]


def test_route_profile_follows_gpx_elevations(terrain, route):
    distances, heights, length = route_profile(terrain, route)
    assert length == pytest.approx(route["distance_m"], rel=.002) and heights.max() == pytest.approx(1200, abs=3)
    choice = SilhouetteOptions.from_dict({"source": "route", "route_id": route["id"], "width_mm": 200, "vertical_scale": 10})
    data = outline_json(terrain, choice, Sources(route))
    assert data["profile"] == "route" and data["slice_length_m"] == pytest.approx(length, abs=.01)
    # True proportions at the chosen width, times the scale: 300 m of climb over 10.3 km at 200 mm.
    assert data["height_mm"]-8 == pytest.approx(300*200/length*10, rel=.02)
    trimmed = outline_json(terrain, SilhouetteOptions.from_dict({**asdict_payload(choice), "trim": [0, 50]}), Sources(route))
    assert trimmed["slice_length_m"] == pytest.approx(length/2, abs=.01)


def asdict_payload(choice):
    return {"source": choice.source, "route_id": choice.route_id, "width_mm": choice.width_mm, "vertical_scale": choice.vertical_scale}


def test_route_without_elevations_samples_the_terrain_or_explains(terrain):
    flat = prepare_route(gpx(course(elevations=False)))
    distances, heights, _ = route_profile(terrain, flat)
    assert heights.min() >= terrain.elevations.min()-1e-3 and heights.max() <= terrain.elevations.max()+1e-3 and len(heights) > 30
    far = prepare_route(gpx([(lat+1, lon, None) for lat, lon, _ in course(elevations=False)]))
    with pytest.raises(ValueError, match="no elevations; re-export it with elevation or frame the whole route"):
        route_profile(terrain, far)
    old = {**far, "schema_version": 1, "segments": [[point[:2] for point in segment] for segment in far["segments"]]}
    with pytest.raises(ValueError, match="Upload the GPX file again"):
        route_profile(terrain, old)


def test_multi_line_caption_ticks_start_finish_and_pegs(terrain, route):
    race = SilhouetteOptions.from_dict(preset_payload("race", route, units="m"))
    shapes = layout(terrain, race, Sources(route))
    assert shapes["ticks"] == 10  # every whole kilometer of a 10.3 km route, not the start
    x0, y0, x1, y1 = shapes["text"].bounds
    assert y1-y0 == pytest.approx(3*5+2*3, abs=.3)  # three stacked lines of 5 mm capitals, 1.6 × apart
    assert [mark["kind"] for mark in shapes["mounts"]].count("peg") == 3 and [mark["kind"] for mark in shapes["mounts"]].count("keyhole") == 2
    pegs = [mark for mark in shapes["mounts"] if mark["kind"] == "peg"]
    assert all(not Point_buffer(peg).intersects(shapes["text"]) for peg in pegs)
    # START at the left end, FINISH at the right; mirrored, they swap.
    marks = shapes["markings"]
    assert marks.bounds[0] < 30 and marks.bounds[2] > 190  # clear of the keyholes at each end
    body = solids(terrain, race, shapes)[0][2]
    assert body.bounding_box()[5] == pytest.approx(race.thickness_mm+20)  # pegs stand out of the front face
    miles = layout(terrain, SilhouetteOptions.from_dict(preset_payload("race", route, units="ft")), Sources(route))
    assert miles["ticks"] == 6  # 6.4 miles
    cycling = layout(terrain, SilhouetteOptions.from_dict(preset_payload("race", route, units="m", tick_every=10)), Sources(route))
    assert cycling["ticks"] == 1 and any("No distance ticks" in w for w in layout(terrain, SilhouetteOptions.from_dict(
        preset_payload("race", route, units="m", tick_every=20)), Sources(route))["warnings"])
    crowded = layout(terrain, SilhouetteOptions.from_dict(preset_payload("race", route, base_mm=20)), Sources(route))
    assert any("need a base of at least" in warning for warning in crowded["warnings"])
    left = layout(terrain, options(text="ONE\nTWO LONGER", text_align="left", base_mm=20))["text"]
    assert left.bounds[0] == pytest.approx(3, abs=.05)


def Point_buffer(peg):
    from shapely.geometry import Point
    return Point(peg["x"], peg["y"]).buffer(peg["d"]/2)


def test_summit_pin_hole(terrain, route):
    trail = SilhouetteOptions.from_dict(preset_payload("box-trail", route))
    shapes = layout(terrain, trail, Sources(route))
    pin = shapes["pin"]
    assert pin and pin["d"] == 1.8 and pin["y1"]-pin["y0"] == pytest.approx(10)
    drilled = solids(terrain, trail, shapes)[0][2]
    plain = solids(terrain, SilhouetteOptions.from_dict(preset_payload("box-trail", route, summit_pin=False)), None, Sources(route))[0][2]
    assert plain.volume()-drilled.volume() == pytest.approx(np.pi*.9**2*10, rel=.05)
    thin = layout(terrain, SilhouetteOptions.from_dict(preset_payload("box-trail", route, thickness_mm=2.4)), Sources(route))
    assert thin["pin"] is None and any("summit pin hole" in warning for warning in thin["warnings"])


def test_multi_part_stl_zip_3mf_and_svg_groups(terrain):
    choice = SilhouetteOptions.from_dict(preset_payload("box-diorama"))
    content, mimetype, filename = silhouette_export(terrain, choice, "stl", "credits")
    assert mimetype == "application/zip" and filename == "silhouette-parts.zip"
    with ZipFile(BytesIO(content)) as archive:
        names = archive.namelist()
        assert names == ["01-layer-1-front-2-0-mm.stl", "02-layer-2-2-0-mm.stl", "03-layer-3-2-0-mm.stl", "04-layer-4-2-0-mm.stl", "05-layer-5-back-2-0-mm.stl",
                         "06-spacer-comb-left.stl", "07-spacer-comb-right.stl", "credits.txt"]
        stl = archive.read(names[0])
        assert len(stl) == 84+50*struct.unpack("<I", stl[80:84])[0]
    content, _, _ = silhouette_export(terrain, choice, "3mf", "credits")
    with ZipFile(BytesIO(content)) as archive:
        model = ET.fromstring(archive.read("3D/3dmodel.model"))
    ns = {"m": CORE}
    objects = [item.attrib["name"] for item in model.findall("m:resources/m:object", ns) if item.find("m:mesh", ns) is not None]
    assert objects == [f"Color {index+1}: {name}" for index, name in enumerate(EXPECTED["box-diorama"])]
    svg = ET.fromstring(silhouette_export(terrain, choice, "svg", "credits")[0])
    groups = [item.attrib["id"] for item in svg if item.tag.endswith("g")]
    assert groups == ["layer-1", "layer-2", "layer-3", "layer-4", "layer-5", "spacer-comb"]
    assert [item.attrib["id"] for item in svg.find("{http://www.w3.org/2000/svg}g") if item.tag.endswith("g")] == ["text"]
    assert [item.attrib["data-name"] for item in svg if item.tag.endswith("g")][:2] == ["Layer 1 (front) · 2.0 mm", "Layer 2 · 2.0 mm"]
    single, mimetype, _ = silhouette_export(terrain, SilhouetteOptions.from_dict(preset_payload("glow-edge")), "stl", "credits")
    assert mimetype == "model/stl" and len(single) == 84+50*struct.unpack("<I", single[80:84])[0]
    tab_svg = ET.fromstring(silhouette_export(terrain, SilhouetteOptions.from_dict(preset_payload("glow-edge")), "svg", "credits")[0])
    data = outline_json(terrain, SilhouetteOptions.from_dict(preset_payload("glow-edge")))
    assert float(tab_svg.attrib["viewBox"].split()[3]) == pytest.approx(data["height_mm"]+8, abs=.01)  # the tab hangs below
    settings = json.loads(silhouette_export(terrain, choice, "json", "credits")[0])
    assert settings["preset"] == "box-diorama" and len(settings["settings"]["layers"]) == 5 and settings["parts"][-1]["count"] == 2


def test_route_and_skyline_endpoints(client, tmp_path):
    uploaded = client.post("/api/routes", json={"gpx": gpx(course()).decode(), "filename": "roan.gpx"}).get_json()
    assert uploaded["date"] == "2026-05-04" and uploaded["has_elevation"]
    body = {"source": "route", "route_id": uploaded["id"], "vertical_scale": 10, "text": "ROAN 10K\n2026-05-04", "base_mm": 16}
    response = client.post("/api/silhouette/t/outline", json=body)
    assert response.status_code == 200 and response.get_json()["profile"] == "route"
    missing = client.post("/api/silhouette/t/outline", json={**body, "route_id": "f"*24})
    assert missing.status_code == 400 and "Upload the GPX file again" in missing.get_json()["error"]
    zipped = client.post("/api/silhouette/t/export", json={**preset_payload("glow-layers"), "format": "stl"})
    assert zipped.status_code == 200 and zipped.mimetype == "application/zip" and "silhouette-parts.zip" in zipped.headers["Content-Disposition"]
    skyline = client.post("/api/silhouette/t/outline", json=preset_payload("glow-skyline")).get_json()
    assert "Turn on the Buildings map layer and wait for it to load to include buildings." in skyline["warnings"]
    extension = client.application.extensions["terrain"]
    buildings = json.loads((FIXTURES / "features.json").read_text())
    extension["building_jobs"]["t"] = {"state": "ready", "data": buildings}
    loaded = client.post("/api/silhouette/t/outline", json=preset_payload("glow-skyline", position=35)).get_json()
    assert not any("Buildings map layer" in warning for warning in loaded["warnings"])


# --- Viewpoint ridges and thickness by distance --------------------------------------------------------------

def ridge_terrain():
    """Flat ground with three north–south ridges east of the viewpoint (u = 0.05), each farther and higher than the last."""
    heights = np.full((80, 80), 100, dtype=np.float32)
    for column, top in ((22, 300), (44, 600), (68, 1000)):
        heights[:, column-1:column+2] = top
    return Terrain(Bounds(36.08, -82.165, 36.145, -82.055), heights, 11, 2, "2026-10-01T00:00:00Z")


VIEW = {"source": "viewpoint", "view_point": [36.1125, -82.1595], "view_bearing": 90, "view_fov": 60}


def ridge_glow(count=3, **extra):
    return preset_payload("glow-layers", **VIEW, view_ridges=True, thickness_by_distance=True, thickness_near_mm=3, thickness_far_mm=1.5,
                          layers=[{"position": 50, "base_mm": 14+8*index, "color": "#234e40"} for index in range(count)]) | extra


@pytest.mark.parametrize("fit", ["lamp", "box"])
def test_cloud_panel_is_extra_rear_piece_with_a_slot_and_closed_exports(fit):
    terrain = ridge_terrain()
    payload = ridge_glow(fit=fit, box_depth=70, box_height=180, clouds=True, cloud_color="#f0ead6")
    choice = SilhouetteOptions.from_dict(payload)
    plain = outline_json(terrain, SilhouetteOptions.from_dict(payload | {"clouds": False}))
    data = outline_json(terrain, choice)
    assert len(data["layers"]) == len(plain["layers"])+1
    cloud = data["layers"][-1]
    assert cloud["kind"] == "cloud" and "Clouds (back)" in cloud["name"]
    assert "distance_m" not in cloud and "distance_range_m" not in cloud
    assert cloud["color"] == "#f0ead6" and cloud["thickness_mm"] == plain["layers"][-1]["thickness_mm"]
    for before, after in zip(plain["layers"], data["layers"]):
        assert before["outline"] == after["outline"] and before["thickness_mm"] == after["thickness_mm"]
    assert cloud["z"] < min(layer["z"] for layer in data["layers"][:-1])
    slots = data["fit"]["comb_base"]["slots"] if fit == "lamp" else [slot for slot in data["fit"]["combs"]["slots"] if slot["kind"] == "layer"]
    assert len(slots) == 4
    assert len(cloud["outline"]["outer"]) > 80 and cloud["outline"]["holes"] == []
    for name, _, solid in solids(terrain, choice):
        vertices, faces = mesh(solid)
        assert_closed(vertices, faces)
        assert solid.volume() > 0
    content, _, _ = silhouette_export(terrain, choice, "stl", "Synthetic test terrain")
    with ZipFile(BytesIO(content)) as archive:
        assert any("cloud" in name.lower() and name.endswith('.stl') for name in archive.namelist())


def test_clouds_require_separate_layers_and_validate_color():
    with pytest.raises(ValueError, match="Clouds need separate"):
        options(clouds=True)
    with pytest.raises(ValueError, match="Cloud background"):
        options(clouds="yes")
    with pytest.raises(ValueError, match="hex color"):
        options(cloud_color="white")


def test_distance_regions_match_the_ridges_and_bands():
    terrain = ridge_terrain()
    ridges_data = outline_json(terrain, SilhouetteOptions.from_dict(ridge_glow()))
    ranges = [layer["distance_range_m"] for layer in ridges_data["layers"]]
    assert ranges[0][0] == 0 and ranges[-1][1] == ridges_data["view_farthest_m"]
    assert all(left[1] == right[0] for left, right in zip(ranges, ranges[1:]))
    assert all(near <= layer["distance_m"] <= far for layer, (near, far) in zip(ridges_data["layers"], ranges))
    payload = ridge_glow(view_ridges=False, view_min_radius_m=1000,
                         layers=[{"position": value, "base_mm": 14+8*index} for index, value in enumerate((11.1,44.4,100))])
    bands = outline_json(terrain, SilhouetteOptions.from_dict(payload))
    maximum = bands["view_farthest_m"]
    assert bands["layers"][0]["distance_range_m"][0] >= min(1000, maximum*.111)-.1
    assert bands["layers"][1]["distance_range_m"] == pytest.approx([maximum*.111,maximum*.444],abs=.1)
    assert bands["layers"][-1]["distance_range_m"][1] == maximum


def test_ridge_layers_are_thicker_when_closer():
    terrain = ridge_terrain()
    data = outline_json(terrain, SilhouetteOptions.from_dict(ridge_glow()))
    distances = [layer["distance_m"] for layer in data["layers"]]
    thicknesses = [layer["thickness_mm"] for layer in data["layers"]]
    assert np.diff(distances).min() > 1000 and [round(ridge["distance_m"]) for ridge in data["ridges"]] == [round(value) for value in distances]
    assert thicknesses[0] == 3 and thicknesses[-1] == 1.5 and 1.5 < thicknesses[1] < 3 and thicknesses == [round(value, 1) for value in thicknesses]
    # Log distance: the middle ridge (~4.6 km between ~2.1 and ~7.6) sits a little past halfway.
    middle = 3-1.5*np.log(distances[1]/distances[0])/np.log(distances[2]/distances[0])
    assert thicknesses[1] == pytest.approx(middle, abs=.051)
    assert [part["size"][2] for part in data["parts"][:3]] == thicknesses and data["thickness_mm"] == 3
    # The comb's slots are each layer's thickness plus 0.3 mm, 6 mm apart; each layer's back face sits in its slot.
    comb = data["fit"]["comb_base"]
    assert comb["slot_widths"] == pytest.approx([t+.3 for t in thicknesses]) and np.diff(comb["slots"]) == pytest.approx([6, 6])
    for layer, center in zip(data["layers"], comb["slots"]):
        assert layer["z"] == pytest.approx(comb["depth"]/2-center-layer["thickness_mm"]/2, abs=.002)
    choice = SilhouetteOptions.from_dict(ridge_glow())
    parts = {name: solid for name, _, solid in solids(terrain, choice)}
    assert [name for name in parts if name.startswith("Layer")] == [f"Layer 1 (front) · 3.0 mm", f"Layer 2 · {thicknesses[1]:.1f} mm", "Layer 3 (back) · 1.5 mm"]
    for name, thickness in zip([name for name in parts if name.startswith("Layer")], thicknesses):
        x0, y0, z0, x1, y1, z1 = parts[name].bounding_box()
        assert z1-z0 == pytest.approx(thickness)
    base = parts["Comb base"]
    assert base.slice(2).area() == pytest.approx(choice.width_mm*(comb["depth"]-sum(comb["slot_widths"])), rel=1e-3)
    # An explicit thickness wins for its layer; without "thicker when closer" every layer is thickness_mm.
    own = outline_json(terrain, SilhouetteOptions.from_dict(ridge_glow(layers=[{"position": 50, "base_mm": 14+8*index, **({"thickness_mm": 2.4} if index == 1 else {})}
                                                                               for index in range(3)])))
    assert [layer["thickness_mm"] for layer in own["layers"]] == [3, 2.4, 1.5]
    flat = outline_json(terrain, SilhouetteOptions.from_dict(ridge_glow(thickness_by_distance=False)))
    assert [layer["thickness_mm"] for layer in flat["layers"]] == [2, 2, 2]
    settings = json.loads(silhouette_export(terrain, choice, "json", "credits")[0])
    assert [layer["thickness_mm"] for layer in settings["layers"]] == thicknesses and settings["settings"]["view_ridges"] is True


def test_ridge_layers_in_a_box_and_their_errors():
    terrain = ridge_terrain()
    payload = preset_payload("box-diorama", **VIEW, view_ridges=True, thickness_by_distance=True, thickness_near_mm=3, thickness_far_mm=1.2,
                             layers=[{"position": 50, "base_mm": 9+8*index, "color": "#234e40"} for index in range(3)])
    data = outline_json(terrain, SilhouetteOptions.from_dict(payload))
    slots = [slot for slot in data["fit"]["combs"]["slots"] if slot["kind"] == "layer"]
    assert [slot["width"] for slot in slots] == pytest.approx([layer["thickness_mm"]+.3 for layer in data["layers"]])
    assert [layer["thickness_mm"] for layer in data["layers"]][::2] == [3, 1.2]
    # Slots that would run together, a box too shallow for the thick layers, and more layers than ridges.
    with pytest.raises(ValueError, match="layers 1 and 2"):
        outline_json(terrain, SilhouetteOptions.from_dict(ridge_glow(layer_spacing=3.8)))
    with pytest.raises(ValueError, match="too shallow for 3 layers"):
        outline_json(terrain, SilhouetteOptions.from_dict(payload | {"box_depth": 12, "thickness_near_mm": 4}))
    with pytest.raises(ValueError, match="Only 3 separate ridges are visible from this viewpoint; use 3 layers or lower the minimum distance."):
        outline_json(terrain, SilhouetteOptions.from_dict(ridge_glow(4, preset="custom", fit="box")))
    with pytest.raises(ValueError, match="Only 2 separate ridges"):
        outline_json(terrain, SilhouetteOptions.from_dict(ridge_glow(view_min_radius_m=3000)))
    beyond = outline_json(terrain, SilhouetteOptions.from_dict(ridge_glow(2, view_min_radius_m=3000)))
    assert [round(layer["distance_m"]/1000) for layer in beyond["layers"]] == [5, 8]
    # Out to: the layered glow ends at the cutoff, so the farthest ridge is no layer.
    cut = outline_json(terrain, SilhouetteOptions.from_dict(ridge_glow(2, view_max_radius_m=6000)))
    assert [round(layer["distance_m"]/1000) for layer in cut["layers"]] == [2, 5] and cut["view_farthest_m"] <= 6000
    with pytest.raises(ValueError, match="Only 2 separate ridges"):
        outline_json(terrain, SilhouetteOptions.from_dict(ridge_glow(view_max_radius_m=6000)))
    assert SilhouetteOptions.from_dict(ridge_glow()).view_max_radius_m == 0


def test_distance_bands_honor_the_minimum_distance():
    # A low hill ~500 m east of the viewpoint and a mountain at the frame's edge.
    heights = np.full((80, 80), 100, dtype=np.float32)
    heights[38:43, 44:47] = 300
    heights[35:46, 70:80] = 2000
    terrain = Terrain(Bounds(36.08, -82.165, 36.145, -82.055), heights, 11, 2, "2026-10-01T00:00:00Z")
    payload = {"source": "viewpoint", "view_point": [36.1125, -82.11], "view_bearing": 90, "view_fov": 60, "fit": "box",
               "thickness_by_distance": True, "layers": [{"position": 30}, {"position": 100}]}
    near = view_layers(terrain, SilhouetteOptions.from_dict(payload))
    cleared = view_layers(terrain, SilhouetteOptions.from_dict(payload | {"view_min_radius_m": 1000}))
    assert near["angles"][0].max() > 1 and cleared["angles"][0].max() < near["angles"][0].max()-1
    assert cleared["angles"][1].max() == pytest.approx(near["angles"][1].max())  # the far band is beyond the radius either way
    assert cleared["distances"][0] > near["distances"][0] and near["ridges"] is None
    data = outline_json(terrain, SilhouetteOptions.from_dict(payload | {"view_min_radius_m": 1000}))
    assert [layer["thickness_mm"] for layer in data["layers"]] == [3, 1.5] and data["ridges"] == []
    single = view_layers(terrain, SilhouetteOptions.from_dict({k: v for k, v in payload.items() if k != "layers"} | {"view_min_radius_m": 1000}))
    assert len(single["angles"]) == 1 and single["angles"][0].max() == pytest.approx(cleared["angles"][1].max())


# --- Colors by distance and color zones ----------------------------------------------------------------------

def bases_and_objects(content):
    with ZipFile(BytesIO(content)) as archive:
        model = ET.fromstring(archive.read("3D/3dmodel.model"))
    ns = {"m": CORE}
    bases = [base.attrib["displaycolor"] for base in model.findall("m:resources/m:basematerials/m:base", ns)]
    objects = [item for item in model.findall("m:resources/m:object", ns) if item.find("m:mesh", ns) is not None]
    return bases, {item.attrib["name"].split(": ", 1)[1]: bases[int(item.attrib["pindex"])] for item in objects}


PALE = ["#112233", "#445566", "#778899", "#aabbcc"]


def test_distance_palette_groups_layers_nearest_first(terrain):
    payload = preset_payload("box-diorama", color_by_distance=True, distance_colors=PALE, text_color="#aabbcc",
                             layers=[{"position": p, "color": "#ff0000"} for p in (90, 78, 66, 54, 42, 30, 18)])
    choice = SilhouetteOptions.from_dict(payload)
    data = outline_json(terrain, choice)
    # Seven layers in four contiguous groups, as even as possible, nearest (front) first; the combs take the farthest color.
    assert [layer["color"] for layer in data["layers"]] == ["#112233"]*2+["#445566"]*2+["#778899"]*2+["#aabbcc"]
    assert data["colors"] == PALE and not any("four colors" in warning for warning in data["warnings"])
    bases, parts = bases_and_objects(silhouette_export(terrain, choice, "3mf", "credits")[0])
    assert len(bases) == 4 and parts["Spacer comb (left)"] == "#AABBCCFF" and parts["Text"] == "#AABBCCFF"
    assert parts["Layer 2 · 2.0 mm"] == parts["Layer 1 (front) · 2.0 mm"] == "#112233FF"
    # Fewer layers than colors use the nearest ones; a caption in its own color would be a fifth filament.
    two = outline_json(terrain, SilhouetteOptions.from_dict(payload | {"layers": payload["layers"][:2]}))
    assert [layer["color"] for layer in two["layers"]] == ["#112233", "#445566"]
    fifth = SilhouetteOptions.from_dict(payload | {"text_color": "#ffffff"})
    assert COLOR_LIMIT in outline_json(terrain, fifth)["warnings"]
    with pytest.raises(ValueError, match="Use at most four colors: share the text color with one of the distance colors."):
        silhouette_export(terrain, fifth, "3mf", "credits")
    assert silhouette_export(terrain, SilhouetteOptions.from_dict(payload | {"text_color": "#ffffff", "text_style": "stencil"}), "3mf", "credits")
    # Off, every layer keeps its own color.
    assert {layer["color"] for layer in outline_json(terrain, SilhouetteOptions.from_dict(payload | {"color_by_distance": False}))["layers"]} == {"#ff0000"}


def zone_options(**extra):
    return SilhouetteOptions.from_dict(VIEW | {"view_ridges": True, "color_zones": True, "thickness_by_distance": True, "thickness_near_mm": 4,
                                               "thickness_far_mm": 1.6, "vertical_scale": 3, "text": "ROAN", "distance_colors": PALE, "text_color": "#aabbcc",
                                               "layers": [{"position": 50}]*3} | extra)


def test_color_zones_tile_one_stepped_piece():
    terrain = ridge_terrain()
    choice = zone_options()
    shapes = layout(terrain, choice)
    zones = shapes["zones"]
    assert [zone["name"] for zone in zones] == ["Zone 1 (nearest)", "Zone 2", "Zone 3 (farthest)"] and len(shapes["layers"]) == 1
    assert [zone["thickness"] for zone in zones][::2] == [4, 1.6] and 1.6 < zones[1]["thickness"] < 4
    # The zones tile the piece: their areas add up to its outline, and none overlaps another.
    assert sum(zone["polygon"].area for zone in zones) == pytest.approx(shapes["outline"].area, rel=1e-6)
    for index, a in enumerate(zones):
        for b in zones[index+1:]:
            assert a["polygon"].intersection(b["polygon"]).area < 1e-6
    assert zones[0]["polygon"].contains(shapes["text"])  # the caption sits on the nearest zone's base strip
    parts = solids(terrain, choice, shapes)
    assert [name for name, _, _ in parts] == ["Zone 1 (nearest)", "Zone 2", "Zone 3 (farthest)", "Text"]
    for (name, _, solid), zone in zip(parts, zones):
        assert solid.status().name == "NoError" and solid.bounding_box()[2] == pytest.approx(0)  # a shared flat back
        assert solid.bounding_box()[5] == pytest.approx(zone["thickness"])  # stepped: nearer zones stand thicker
        assert_closed(*mesh(solid))
    for index, (_, _, a) in enumerate(parts[:3]):
        for _, _, b in parts[index+1:3]:
            assert (a ^ b).volume() < 1e-3
    data = outline_json(terrain, choice)
    assert [zone["thickness_mm"] for zone in data["zones"]] == [zone["thickness"] for zone in zones] and data["thickness_mm"] == 4
    assert data["parts"] == [{"name": "Silhouette", "size": [180, pytest.approx(data["height_mm"], abs=.1), 4], "count": 1}]
    assert data["colors"] == PALE  # three zones and the caption
    # 3MF: one part per color; STL: one merged solid; SVG: a group per zone in its color.
    bases, colors = bases_and_objects(silhouette_export(terrain, choice, "3mf", "credits")[0])
    assert colors == {"Zone 1 (nearest)": "#112233FF", "Zone 2": "#445566FF", "Zone 3 (farthest)": "#778899FF", "Text": "#AABBCCFF"} and len(bases) == 4
    stl, mimetype, _ = silhouette_export(terrain, choice, "stl", "credits")
    assert mimetype == "model/stl"
    from manifold3d import Manifold
    merged = Manifold.batch_boolean([solid for _, _, solid in parts[:3]], __import__("manifold3d").OpType.Add)
    assert len(merged.decompose()) == 1
    svg = ET.fromstring(silhouette_export(terrain, choice, "svg", "credits")[0])
    groups = [(item.attrib["id"], item[0].attrib["fill"]) for item in svg if item.tag.endswith("g")]
    assert groups == [("zone-1", "#112233"), ("zone-2", "#445566"), ("zone-3", "#778899"), ("text", "#aabbcc")]
    # Thicker when closer off: one thickness; two ridges sharing a color make one part.
    flat = layout(terrain, zone_options(thickness_by_distance=False, thickness_mm=3))
    assert {zone["thickness"] for zone in flat["zones"]} == {3}
    shared = solids(terrain, zone_options(distance_colors=["#112233", "#445566"]))
    assert [name for name, _, _ in shared] == ["Zones 1, 2", "Zone 3 (farthest)", "Text"]  # 2 + 1, nearest first


def test_color_zones_with_the_lamp_tab_and_mounts():
    terrain = ridge_terrain()
    lamp = zone_options(fit="lamp", text_style="engrave", text_depth=.6)
    data = outline_json(terrain, lamp)
    assert data["fit"]["tab"] and data["fit"]["comb_base"] is None and data["parts"][0]["name"] == "Silhouette with lamp tab"
    body = solids(terrain, lamp)[0][2]
    assert body.bounding_box()[1] == pytest.approx(-8)  # the tab hangs from the nearest zone
    for mount in ("holes", "keyholes", "stand"):
        choice = zone_options(mount=mount, base_mm=16, distance_colors=PALE[:3])
        for name, _, solid in solids(terrain, choice):
            assert solid.status().name == "NoError", (mount, name)
        if mount != "stand":
            assert len(outline_json(terrain, choice)["outline"]["holes"]) == 2
