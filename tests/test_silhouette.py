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
                                    part_groups, profile_points, route_profile, silhouette_export, slice_heights, solids, with_buildings)

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
    ({"text": "x"*61}, "at most 3 lines"), ({"text": "A\nB\nC\nD"}, "at most 3 lines"), ({"text_style": "paint"}, "text style"), ({"text_align": "top"}, "text position"),
    ({"mount": "glue"}, "mount"), ({"thickness_mm": 50}, "thickness"), ({"text_color": "red"}, "hex color for the text"),
    ({"text": "A", "text_depth": 4, "thickness_mm": 4}, "at least 0.4 mm"), ({"fit": "shelf"}, "fit"),
    ({"source": "route"}, "Upload a GPX route"), ({"layers": [{"position": 10}, {"position": 20}]}, "lamp-base or shadow-box fit"),
    ({"layers": [{"position": 120}], "fit": "box"}, "Layer 1's slice position"), ({"layers": [{"position": 1}]*8, "fit": "box"}, "1 to 7 layers"),
    ({"fit": "lamp", "mount": "stand"}, "set the mount to none"), ({"peg_count": 2.5}, "whole number"), ({"preset": "teapot"}, "presets"),
    ({"fit": "box", "box_depth": 10, "layers": [{"position": p} for p in (10, 30, 50, 70, 90)]}, "too shallow for 5 layers"),
    ({"fit": "lamp", "layer_spacing": 3, "thickness_mm": 2, "layers": [{"position": 10}, {"position": 20}]}, "1.2 mm between"),
    ({"photo_slot": "yes"}, "photo slot must be true or false"),
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
    "glow-layers": ["Layer 1 (front)", "Text", "Layer 2", "Layer 3 (back)", "Comb base"],
    "glow-skyline": ["Silhouette"],
    "box-diorama": ["Layer 1 (front)", "Text", "Layer 2", "Layer 3", "Layer 4", "Layer 5 (back)", "Spacer comb (left)", "Spacer comb (right)"],
    "box-trail": ["Silhouette", "Text", "Spacer comb (left)", "Spacer comb (right)"],
    "box-chart": ["Silhouette", "Text", "Markings", "Spacer comb (left)", "Spacer comb (right)"],
    "box-anniversary": ["Silhouette", "Spacer comb (left)", "Spacer comb (right)"],
    "race": ["Silhouette", "Text", "Markings"],
}


def test_every_preset_is_listed_once():
    listed = [name for group in PRESET_DATA["groups"] for name in group["presets"]]
    assert sorted(listed+["custom"]) == sorted(PRESETS) and set(EXPECTED) == set(PRESETS)
    assert [group["name"] for group in PRESET_DATA["groups"]] == ["Glow lamps", "Shadow boxes", "Race profile"]


@pytest.mark.parametrize("name", PRESETS)
def test_every_preset_makes_closed_named_parts(terrain, route, name):
    buildings = json.loads((FIXTURES / "features.json").read_text())["layers"]["buildings"]
    choice = SilhouetteOptions.from_dict(preset_payload(name, route))
    shapes = layout(terrain, choice, Sources(route, buildings))
    parts = solids(terrain, choice, shapes)
    assert [part for part, _, _ in parts] == EXPECTED[name], shapes["warnings"]
    for part, _, solid in parts:
        assert solid.status().name == "NoError" and solid.volume() > 0, part
        assert_closed(*mesh(solid))
        if part not in ("Text", "Markings"):
            assert len(solid.decompose()) == 1, part
    assert not [warning for warning in shapes["warnings"] if "trimmed" in warning or "need a base" in warning or "printer bed" in warning]
    # Parts lie side by side on the bed, never overlapping (inlays sit inside their own part).
    boxes = [solid.bounding_box() for part, _, solid in parts if part not in ("Text", "Markings")]
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
        assert names == ["01-layer-1-front.stl", "02-layer-2.stl", "03-layer-3.stl", "04-layer-4.stl", "05-layer-5-back.stl",
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
