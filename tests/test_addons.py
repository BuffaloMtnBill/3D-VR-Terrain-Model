from collections import Counter
from io import BytesIO
import json
import struct
import time
from xml.etree import ElementTree as ET
from zipfile import ZipFile

import numpy as np
import pytest

from terrain_app import addons
from terrain_app.addons import (PLATFORM_INFO, Model, addon_mesh, apply_addons, check_project, marker_ball, marker_platform, plan_project,
                                print_color_set, project_options, text_outline)
from terrain_app.elevation import Bounds, Terrain
from terrain_app.landcover import COVER_NAMES, face_classes
from terrain_app.mesh import ModelOptions, build_mesh
from terrain_app.print_features import feature_color_parts, from_mesh
from terrain_app.printing import CORE, color_parts, export_3mf
from terrain_app.server import create_app
from terrain_app.studio import downsample, glb

PALETTE = dict(zip(COVER_NAMES, ["#234e40", "#94b578", "#b99570", "#f0ead6", "#234e40", "#b99570"]))
OPTIONS = ModelOptions(size_mm=120, base_percent=10)  # a 12 mm base leaves room for real holes


@pytest.fixture
def terrain():
    rows, columns = np.mgrid[0:24, 0:33]
    heights = (np.sin(columns/5)*40+np.cos(rows/4)*30+400).astype(np.float32)
    return Terrain(Bounds(36.08, -82.165, 36.145, -82.055), heights, 11, 2, "2026-10-01T00:00:00Z")


@pytest.fixture
def cover(terrain):
    def region(left, right):
        return {"outer": [[left, 0], [right, 0], [right, 1], [left, 1], [left, 0]], "holes": []}
    return {"regions": {name: [region(index/6, (index+1)/6)] for index, name in enumerate(COVER_NAMES)}}


def project(*items, balls=False, color=None):
    return project_options({"version": 1, "name": "Test", "marker_balls": {"include": balls, **({"color": color} if color else {})},
                            "addons": [{"id": f"a{index}", "u": .5, "v": .5, **item} for index, item in enumerate(items)]})


def volume(vertices, faces):
    triangles = vertices[faces]
    return np.einsum("ij,ij->i", triangles[:, 0], np.cross(triangles[:, 1], triangles[:, 2])).sum()/6


def assert_closed(vertices, faces):
    edges = Counter(tuple(sorted(edge)) for face in faces for edge in ((face[0], face[1]), (face[1], face[2]), (face[2], face[0])))
    assert set(edges.values()) == {2}
    assert from_mesh(vertices, faces).status().name == "NoError"


def assert_disjoint(parts):
    solids = [part["solid"] for part in parts]
    for index, solid in enumerate(solids):
        assert solid.status().name == "NoError" and solid.volume() > 0
        for other in solids[index+1:]:
            assert (solid ^ other).volume() == pytest.approx(0, abs=1e-3)


@pytest.mark.parametrize("value,message", [
    ("plan", "must be an object"),
    ({"version": 2}, "newer version"),
    ({"addons": [{"type": "laser", "u": .5, "v": .5}]}, "unknown type"),
    ({"addons": [{"type": "hole", "u": 1.5, "v": .5}]}, "between 0 and 1"),
    ({"addons": [{"type": "hole", "u": .5, "v": .5, "params": {"diameter": 31}}]}, "Hole: diameter must be between 0.5 and 30 mm"),
    ({"addons": [{"type": "hole", "u": .5, "v": .5, "params": {"depth": True}}]}, "must be a number"),
    ({"addons": [{"type": "pencil_holder", "u": .5, "v": .5, "params": {"count": 2.5}}]}, "whole number"),
    ({"addons": [{"type": "pocket", "u": .5, "v": .5, "params": {"shape": "star"}}]}, "one of: rect, rounded, oval"),
    ({"addons": [{"type": "plaque", "u": .5, "v": .5, "params": {"text": "x"*61}}]}, "at most 60 characters"),
    ({"addons": [{"type": "plaque", "u": .5, "v": .5, "params": {"text": "a\nb\nc"}}]}, "at most 2 lines"),
    ({"addons": [{"type": "text", "u": .5, "v": .5, "params": {"text": "  "}}]}, "enter the text"),
    ({"addons": [{"type": "plaque", "u": .5, "v": .5, "color": "red"}]}, "hex color"),
    ({"addons": [{"id": "x", "type": "hole", "u": .5, "v": .5}]*2}, "different id"),
    ({"addons": [{"id": f"a{index}", "type": "hole", "u": .5, "v": .5} for index in range(41)]}, "at most 40 add-ons"),
    ({"marker_balls": {"include": "yes"}}, "true or false"),
    ({"marker_balls": {"style": "cube"}}, "ball or platform"),
    ({"marker_balls": {"style": "platform", "top": "tree"}}, "none, terrain, or building"),
    ({"marker_balls": {"style": "platform", "top_area_mm": 90}}, "between 10 and 80 mm"),
    ({"marker_balls": {"style": "platform", "top_exaggeration": .1}}, "between 0.5 and 20"),
    ({"marker_balls": {"style": "platform", "top_color": "white"}}, "platform tops"),
])
def test_project_validation_errors_are_sentences(value, message):
    with pytest.raises(ValueError, match=message):
        project_options(value)


def test_project_defaults_come_from_the_catalog():
    result = project({"type": "nail_marker", "rotation_deg": 370})
    addon = result["addons"][0]
    assert addon["params"] == {"hole_diameter": 1.8, "depth": 24.4} and addon["rotation_deg"] == 10
    assert result["marker_balls"] == {"include": False, "color": "#c0392b", "style": "ball", "top": "none", "top_color": "#c0392b",
                                      "top_area_mm": 30, "top_exaggeration": None}
    assert project_options(None) is None
    catalog = addons.catalog()
    assert catalog["order"][0] == "hole" and catalog["types"]["plaque"]["kind"] == "mixed"
    assert catalog["types"]["pocket"]["params"]["shape"]["choices"] == ["rect", "rounded", "oval"]


CASES = [
    ("hole", {"diameter": 5, "depth": 6}, -1),
    ("nail_marker", {"depth": 6}, -1),
    ("pencil_holder", {"diameter": 6, "depth": 8, "count": 3, "spacing": 9, "tilt_deg": 15}, -1),
    ("photo_slot", {"width": 30, "depth": 6, "lean_deg": 10}, -1),
    ("pocket", {"shape": "rounded", "width": 30, "length": 20, "depth": 3}, -1),
    ("pocket", {"shape": "oval", "width": 30, "length": 20, "depth": 3}, -1),
    ("coaster", {"diameter": 40, "depth": 2}, -1),
    ("groove", {"length": 40, "width": 6, "depth": 5, "angle_deg": 20}, -1),
    ("magnet", {}, -1),
    ("hanging", {"style": "keyhole"}, -1),
    ("hanging", {"style": "hole"}, -1),
    ("plaque", {"mode": "flatten", "width": 40, "length": 20}, -1),
    ("plaque", {"mode": "raise", "width": 40, "length": 20, "raise": 2, "text": "Hi", "text_style": "deboss"}, 1),
    ("plaque", {"mode": "level", "width": 40, "length": 20, "text": "Hi", "text_style": "emboss"}, 0),
    ("text", {"text": "Lynnville, TN", "text_style": "emboss", "base": "follow"}, 1),
    ("text", {"text": "Lynnville, TN", "text_style": "deboss", "base": "flat"}, -1),
]


@pytest.mark.parametrize("kind,params,direction", CASES)
def test_every_addon_makes_a_closed_solid_and_changes_volume(terrain, kind, params, direction):
    original = volume(*build_mesh(terrain, OPTIONS))
    vertices, faces = addon_mesh(terrain, OPTIONS, project({"type": kind, "rotation_deg": 25, "params": params}))
    assert_closed(vertices, faces)
    change = volume(vertices, faces)-original
    if direction:
        assert np.sign(change) == direction and abs(change) > 1
    else:
        assert abs(change) > 1e-3  # leveling removes and adds material
    assert np.ptp(vertices[:, :2], axis=0) == pytest.approx(np.ptp(build_mesh(terrain, OPTIONS)[0][:, :2], axis=0))


def test_hole_volume_and_depth_follow_the_surface(terrain):
    model = Model(terrain, OPTIONS)
    plan = plan_project(project({"type": "hole", "params": {"diameter": 4, "depth": 5, "chamfer": 0}}), model, "#827254")[0]
    assert plan["floor_z"] == pytest.approx(model.at([(0, 0)])[0]-5)
    vertices, faces = addon_mesh(terrain, OPTIONS, project({"type": "hole", "params": {"diameter": 4, "depth": 5, "chamfer": 0}}))
    removed = volume(*build_mesh(terrain, OPTIONS))-volume(vertices, faces)
    assert removed == pytest.approx(np.pi*4*5, rel=.03)  # a polygonal cylinder under a gently sloping surface
    assert vertices[:, 2].min() == 0


def printable_features():
    return {"layers": {"roads": [{"id": "road", "kind": "primary", "lines": [[[0, .5], [1, .5]]], "polygons": []}]}}


def test_cuts_go_through_feature_inlays_and_fills_join_their_color(terrain, cover):
    classes = face_classes(cover, *terrain.elevations.shape)
    styles = {"roads": {"enabled": True, "color": "#ffffff"}}
    base = color_parts(terrain, OPTIONS, dict.fromkeys(COVER_NAMES, "#123456"), np.zeros_like(classes))
    parts, _ = feature_color_parts(terrain, OPTIONS, PALETTE, base, styles, printable_features())
    road = next(part for part in parts if part["color"] == "#ffffff")
    model = Model(terrain, OPTIONS)
    plans = plan_project(project({"type": "hole", "params": {"diameter": 6, "depth": 4}}), model, PALETTE["dirt"])
    result = apply_addons(parts, plans, model)
    assert result[[part["color"] for part in result].index("#ffffff")]["solid"].volume() < road["solid"].volume()
    assert_disjoint(result)
    # A fill in a new color is a new part; in an existing color it merges into that part.
    raised = {"type": "plaque", "u": .3, "v": .3, "params": {"mode": "raise", "width": 20, "length": 10}}
    for color, count in (("#ff0000", 3), ("#ffffff", 2)):
        plans = plan_project(project({**raised, "color": color}), model, PALETTE["dirt"])
        result = apply_addons(parts, plans, model)
        assert len(result) == count and color in [part["color"] for part in result]
        assert_disjoint(result)
        assert sum(part["solid"].volume() for part in result) > sum(part["solid"].volume() for part in parts)
        for part in result:
            assert_closed(part["vertices"], part["faces"])


def test_3mf_with_addons_metadata_and_marker_balls(terrain, cover):
    classes = face_classes(cover, *terrain.elevations.shape)
    plan = project({"type": "nail_marker", "params": {"depth": 6}}, {"type": "nail_marker", "u": .2, "params": {"depth": 6}},
                   {"type": "plaque", "u": .7, "v": .7, "color": "#f0ead6", "params": {"mode": "raise", "width": 20, "length": 10}}, balls=True, color="#234e40")
    file, _, _ = export_3mf(terrain, OPTIONS, PALETTE, classes, "OSM", project=plan)
    with ZipFile(file) as archive:
        model = ET.fromstring(archive.read("3D/3dmodel.model"))
    ns = {"m": CORE}
    metadata = json.loads(model.find("m:metadata[@name='Description']", ns).text)
    assert metadata["project"]["name"] == "Test" and len(metadata["project"]["addons"]) == 3 and metadata["marker_balls"] == 2
    items = model.findall("m:build/m:item", ns)
    assert len(items) == 3 and "transform" in items[1].attrib
    width = np.ptp(build_mesh(terrain, OPTIONS)[0][:, 0])
    ball_x = float(items[1].attrib["transform"].split()[9])
    assert ball_x - np.ptp(marker_ball()[0][:, 0])/2 >= width/2+3.9
    # The ball shares the dark-foliage color, so it reuses that material instead of adding a fifth.
    bases = model.findall("m:resources/m:basematerials/m:base", ns)
    ball = next(item for item in model.findall("m:resources/m:object", ns) if item.attrib["name"] == "Marker ball")
    assert "Marker ball" not in [base.attrib["name"] for base in bases]
    assert bases[int(ball.attrib["pindex"])].attrib["displaycolor"] == "#234E40FF"
    with pytest.raises(ValueError, match="add-on material, and nail markers"):
        export_3mf(terrain, OPTIONS, PALETTE, classes, "OSM", project=project({"type": "nail_marker"}, balls=True, color="#ff0000"))


def test_checks_report_breakthrough_proud_nails_underside_and_colors(terrain):
    plan = project({"id": "deep", "type": "hole", "params": {"depth": 60}},
                   {"id": "nail", "type": "nail_marker", "u": .2, "v": .2, "params": {"depth": 5}},
                   {"id": "magnet", "type": "magnet", "u": .8, "v": .8, "params": {"depth": 20}},
                   {"id": "edge", "type": "hole", "u": 0, "v": .5, "params": {"depth": 2}},
                   {"id": "pad", "type": "plaque", "u": .8, "v": .2, "color": "#ff0000", "params": {"mode": "raise"}})
    result = check_project(terrain, OPTIONS, plan, PALETTE, {}, "3mf", 100)
    by_id = {}
    for check in result["checks"]:
        by_id.setdefault(check["addon_id"], []).append(check)
    assert by_id["deep"][0]["level"] == "error" and "break through the bottom" in by_id["deep"][0]["message"]
    assert any("stand 19.4 mm proud" in check["message"] for check in by_id["nail"])
    assert any(check["level"] == "error" and "top surface" in check["message"] for check in by_id["magnet"])
    assert any("past the model edge" in check["message"] for check in by_id["edge"])
    assert result["colors"] == 5 and any(check["level"] == "error" and "5 colors" in check["message"] for check in by_id[None])
    assert any("printer bed" in check["message"] for check in by_id[None])
    levels = {entry["id"]: entry.get("level") for entry in result["addons"]}
    assert levels["deep"] == "error" and levels["nail"] == "warning"
    deep = next(entry for entry in result["addons"] if entry["id"] == "deep")
    assert deep["floor_z"] == pytest.approx(deep["z_ref"]-60, abs=1e-3)
    assert check_project(terrain, OPTIONS, project({"type": "hole", "params": {"depth": 2}}), PALETTE, {}, "3mf")["checks"] == []


def test_nail_breakthrough_suggests_a_thicker_base(terrain):
    result = check_project(terrain, ModelOptions(size_mm=250, base_percent=8), project({"type": "nail_marker"}), None, {}, "stl")
    messages = " ".join(check["message"] for check in result["checks"])
    assert "proud" not in messages and "raise the base to" in messages


def test_text_outline_has_polygons_with_holes_and_reports_missing_glyphs():
    outline = text_outline("Lynnville, TN", 6)
    assert len(outline["polygons"]) >= 12 and 50 < outline["width"] < 70 and outline["height"] > 6
    assert any(polygon["holes"] for polygon in text_outline("Bob", 6)["polygons"])
    assert text_outline("A一", 6)["missing"] == ["一"]
    assert text_outline("   ", 6)["polygons"] == []


def test_preview_downsampling_keeps_bounds_and_classes(terrain, cover):
    classes = face_classes(cover, *terrain.elevations.shape)
    small, options, small_classes = downsample(terrain, OPTIONS, classes, limit=12)
    assert max(small.elevations.shape) <= 12 and small.bounds == terrain.bounds
    assert len(small_classes) == 2*(small.elevations.shape[0]-1)*(small.elevations.shape[1]-1)
    assert np.ptp(build_mesh(small, options)[0][:, 0]) == pytest.approx(np.ptp(build_mesh(terrain, OPTIONS)[0][:, 0]))


def test_glb_is_valid_binary_gltf():
    vertices, faces = marker_ball()
    content = glb([{"color": "#ff0000", "name": "Ball", "vertices": vertices, "faces": faces}], {"note": "test"})
    magic, version, length = struct.unpack_from("<4sII", content)
    assert magic == b"glTF" and version == 2 and length == len(content) and length % 4 == 0
    size, kind = struct.unpack_from("<I4s", content, 12)
    document = json.loads(content[20:20+size])
    assert kind == b"JSON" and document["accessors"][0]["count"] == len(vertices)
    assert document["accessors"][0]["max"][1] == pytest.approx(vertices[:, 2].max()/1000, rel=1e-6)  # z up → y up
    assert document["materials"][0]["pbrMetallicRoughness"]["baseColorFactor"] == [1, 0, 0, 1]


@pytest.fixture
def studio(tmp_path, terrain, cover):
    app = create_app({"TESTING": True, "CACHE_DIR": tmp_path / "tiles"})
    extension = app.extensions["terrain"]
    extension["jobs"]["t"] = {"state": "ready", "terrain": terrain, "accessed": time.monotonic()}
    yield app.test_client(), extension, cover
    extension["executor"].shutdown(wait=True)


def run_job(client, payload, identifier="t"):
    response = client.post(f"/api/studio/{identifier}/export", json=payload)
    assert response.status_code == 202, response.get_json()
    job = response.get_json()["job"]
    for _ in range(500):
        status = client.get(f"/api/studio/jobs/{job}").get_json()
        if status["state"] in ("ready", "error"):
            break
        time.sleep(.01)
    return job, status


def test_studio_job_api_exports_every_model_format(studio, terrain):
    client, extension, cover = studio
    plan = {"version": 1, "name": "Desk", "addons": [{"id": "h", "type": "hole", "u": .5, "v": .5, "params": {"depth": 4}}],
            "marker_balls": {"include": False}}
    options = {"size_mm": 120, "base_percent": 10}
    response = client.post("/api/studio/t/export", json={**options, "format": "3mf", "print_palette": PALETTE, "project": plan})
    assert response.status_code == 400 and "surface colors to load" in response.get_json()["error"]
    assert client.post("/api/studio/t/export", json={"format": "dxf"}).status_code == 400
    assert client.post("/api/studio/gone/export", json={"format": "stl"}).status_code == 404
    job, status = run_job(client, {**options, "format": "stl", "project": plan})
    assert status == {"state": "ready", "progress": 1, "message": "Ready to download.", "filename": "terrain.stl"}
    file = client.get(f"/api/studio/jobs/{job}/file")
    assert file.mimetype == "model/stl" and "terrain.stl" in file.headers["Content-Disposition"]
    plain = client.post("/api/export/t", json={**options, "format": "stl"}).data
    assert struct.unpack_from("<I", file.data, 80)[0] > struct.unpack_from("<I", plain, 80)[0]
    assert client.post("/api/export/t", json={**options, "format": "stl", "project": plan}).data == file.data
    extension["cover_jobs"]["t"] = {"state": "ready", "data": {"face_classes": face_classes(cover, *terrain.elevations.shape).tolist()}}
    job, status = run_job(client, {**options, "format": "3mf", "print_palette": PALETTE, "project": {**plan, "marker_balls": {"include": True}}})
    assert status["state"] == "ready"
    with ZipFile(BytesIO(client.get(f"/api/studio/jobs/{job}/file").data)) as archive:
        assert json.loads(ET.fromstring(archive.read("3D/3dmodel.model")).find(f"{{{CORE}}}metadata[@name='Description']").text)["project"]["name"] == "Desk"
    job, status = run_job(client, {**options, "format": "glb", "print_palette": PALETTE, "project": plan})
    content = client.get(f"/api/studio/jobs/{job}/file").data
    assert content[:4] == b"glTF" and len(json.loads(content[20:20+struct.unpack_from("<I", content, 12)[0]])["meshes"]) == 4
    job, status = run_job(client, {**options, "format": "3mf", "preview": True, "project": plan})
    preview = client.get(f"/api/studio/jobs/{job}/file").get_json()
    part = preview["parts"][0]
    assert part["color"] == "#827254" and len(part["positions"]) % 3 == 0 and max(part["indices"]) < len(part["positions"])//3
    job, status = run_job(client, {"size_mm": 120, "base_percent": 1, "format": "stl",
                                   "project": {"addons": [{"type": "coaster", "u": .5, "v": .5, "params": {"diameter": 200, "depth": 20}}]}})
    assert status["state"] in ("ready", "error")  # a huge coaster may remove the whole model; either way the job finishes
    assert client.get("/api/studio/jobs/missing").status_code == 404


def test_studio_check_catalog_text_and_marker_ball_endpoints(studio):
    client, _, _ = studio
    catalog = client.get("/api/studio/catalog")
    assert list(catalog.get_json()["types"]) == list(addons.TYPES)
    assert list(json.loads(catalog.data)["types"]["hole"]["params"]) == ["diameter", "depth", "chamfer"]
    assert catalog.get_json()["marker_ball"]["exposed_nail_length"] == 24.4 and catalog.get_json()["font"] == "DejaVu Sans Bold"
    result = client.post("/api/studio/t/check", json={"size_mm": 120, "base_percent": 10, "format": "3mf", "print_palette": PALETTE,
                                                       "project": {"addons": [{"id": "n", "type": "nail_marker", "u": .5, "v": .5}]}}).get_json()
    assert set(result) >= {"checks", "colors", "addons"} and result["colors"] == 4 and result["addons"][0]["id"] == "n"
    assert client.post("/api/studio/t/check", json={"bed_mm": 5}).status_code == 400
    outline = client.post("/api/studio/t/text-outline", json={"text": "Lynnville, TN", "text_size": 6}).get_json()
    assert outline["polygons"] and outline["width"] > 0
    stl = client.get("/api/studio/marker-ball?format=stl")
    assert stl.mimetype == "model/stl" and len(stl.data) == 84+50*struct.unpack_from("<I", stl.data, 80)[0]
    three = client.get("/api/studio/marker-ball?format=3mf&color=%2300ff00")
    with ZipFile(BytesIO(three.data)) as archive:
        model = ET.fromstring(archive.read("3D/3dmodel.model"))
    assert model.find(f"{{{CORE}}}resources/{{{CORE}}}basematerials/{{{CORE}}}base").attrib["displaycolor"] == "#00FF00FF"
    assert client.get("/api/studio/marker-ball?format=blend").data == (addons.DATA / "templates" / "marker-ball.blend").read_bytes()
    assert client.get("/api/studio/marker-ball?format=3mf&color=green").status_code == 400
    assert client.get("/api/studio/marker-ball?format=dwg").status_code == 400


def test_marker_ball_template_is_a_closed_solid():
    vertices, faces = marker_ball()
    assert_closed(vertices, faces)
    assert vertices[:, 2].min() == pytest.approx(0) and np.abs(vertices[:, :2].mean(axis=0)).max() < 1


def test_exports_without_add_ons_are_unchanged(terrain, cover):
    classes = face_classes(cover, *terrain.elevations.shape)
    empty = project()
    def model(**extra):
        file, _, _ = export_3mf(terrain, OPTIONS, PALETTE, classes, "OSM", **extra)
        with ZipFile(file) as archive:
            return archive.read("3D/3dmodel.model")
    assert model() == model(project=empty)
    from terrain_app.mesh import export_file
    for format in ("stl", "obj", "metadata"):
        assert export_file(terrain, OPTIONS, format, "x")[0].getvalue() == export_file(terrain, OPTIONS, format, "x", project=empty)[0].getvalue()


def test_overlap_checks_use_placed_footprints(terrain):
    # Regression: hole/slot footprints were left at the model center, so distant add-ons "overlapped"
    # and a hole inside a pocket did not.
    options = ModelOptions(size_mm=180, base_percent=3, exaggeration=2)
    hole = {"id": "h", "type": "hole", "u": .52, "v": .77, "params": {"diameter": 7}}
    far = {"id": "p", "type": "pencil_holder", "u": .85, "v": .10, "params": {"count": 3, "depth": 10}}
    inside = {"id": "k", "type": "pocket", "u": .5, "v": .84, "params": {"depth": 3}}
    def overlaps(*items):
        result = check_project(terrain, options, project_options({"addons": list(items)}), None, {}, "stl")
        return [check["message"] for check in result["checks"] if "overlaps" in check["message"]]
    assert overlaps(far, hole) == []
    assert overlaps(inside, hole) == ["Hole overlaps pocket."]
    model = Model(terrain, options)
    plan = plan_project(project_options({"addons": [hole]}), model, "#827254")[0]
    assert plan["footprint"].centroid.x == pytest.approx(.02*model.width, abs=.01)
    assert plan["footprint"].centroid.y == pytest.approx(-.27*model.height, abs=.01)


def platforms(*markers, top="none", top_color=None, include=True, **extra):
    balls = {"include": include, "color": "#234e40", "style": "platform", "top": top, **({"top_color": top_color} if top_color else {}), **extra}
    return project_options({"marker_balls": balls, "addons": [{"id": f"n{index}", "type": "nail_marker", "u": u, "v": v}
                                                              for index, (u, v) in enumerate(markers)]})


def read_3mf(file):
    with ZipFile(file) as archive:
        model = ET.fromstring(archive.read("3D/3dmodel.model"))
    ns = {"m": CORE}
    objects = {item.attrib["id"]: item for item in model.findall("m:resources/m:object", ns)}
    def mesh(item):
        vertices = np.array([[float(vertex.attrib[axis]) for axis in "xyz"] for vertex in item.findall("m:mesh/m:vertices/m:vertex", ns)])
        faces = np.array([[int(face.attrib[name]) for name in ("v1", "v2", "v3")] for face in item.findall("m:mesh/m:triangles/m:triangle", ns)])
        return vertices, faces
    return model, ns, objects, mesh


def test_marker_platform_template_is_a_closed_solid():
    vertices, faces = marker_platform()
    assert_closed(vertices, faces)
    assert from_mesh(vertices, faces).genus() == 0
    assert vertices[:, 2].min() == pytest.approx(0) and vertices[:, 2].max() == pytest.approx(PLATFORM_INFO["deck_top_z"], abs=1e-4)
    assert np.ptp(vertices[:, 0]) == pytest.approx(PLATFORM_INFO["deck_size"], abs=.01)
    assert PLATFORM_INFO["exposed_nail_length"] > 24 and PLATFORM_INFO["nail"]["head_size_assumed"] is True


def test_3mf_with_marker_platforms_and_terrain_tops(terrain, cover):
    classes = face_classes(cover, *terrain.elevations.shape)
    plan = platforms((.3, .5), (.7, .5), top="terrain", top_color="#f0ead6", top_exaggeration=4)
    file, _, _ = export_3mf(terrain, OPTIONS, PALETTE, classes, "OSM", project=plan)
    model, ns, objects, mesh = read_3mf(file)
    metadata = json.loads(model.find("m:metadata[@name='Description']", ns).text)
    assert metadata["marker_platforms"] == {"count": 2, "top": "terrain", "tops_printed": 2}
    items = model.findall("m:build/m:item", ns)
    assert len(items) == 3  # the model and one platform-and-top assembly per nail marker
    platform = next(item for item in objects.values() if item.attrib["name"] == "Marker platform")
    bases = model.findall("m:resources/m:basematerials/m:base", ns)
    assert len(bases) == 4 and bases[int(platform.attrib["pindex"])].attrib["displaycolor"] == "#234E40FF"
    width = np.ptp(build_mesh(terrain, OPTIONS)[0][:, 0])
    deck = PLATFORM_INFO["deck_top_z"]
    for item in items[1:]:
        assembly = objects[item.attrib["objectid"]]
        components = [component.attrib["objectid"] for component in assembly.findall("m:components/m:component", ns)]
        assert components[0] == platform.attrib["id"] and len(components) == 2
        top = objects[components[1]]
        assert bases[int(top.attrib["pindex"])].attrib["displaycolor"] == "#F0EAD6FF"
        vertices, faces = mesh(top)
        assert_closed(vertices, faces)
        assert volume(vertices, faces) > 0  # outward-facing, not inside out
        assert vertices[:, 2].min() == pytest.approx(deck, abs=1e-6) and vertices[:, 2].max() > deck+1.2
        assert np.hypot(vertices[:, 0], vertices[:, 1]).max() <= PLATFORM_INFO["deck_size"]/2-PLATFORM_INFO["deck_chamfer"]
        transform = [float(value) for value in item.attrib["transform"].split()]
        assert transform[:9] == [1, 0, 0, 0, 1, 0, 0, 0, 1] and transform[9]-PLATFORM_INFO["deck_size"]/2 >= width/2+3.9
    # Bare platforms are turned deck down onto the bed.
    file, _, _ = export_3mf(terrain, OPTIONS, PALETTE, classes, "OSM", project=platforms((.3, .5), (.7, .5)))
    model, ns, objects, mesh = read_3mf(file)
    items = model.findall("m:build/m:item", ns)
    assert len(items) == 3 and all(objects[item.attrib["objectid"]].attrib["name"] == "Marker platform" for item in items[1:])
    vertices, _ = mesh(objects[items[1].attrib["objectid"]])
    transform = [float(value) for value in items[1].attrib["transform"].split()]
    assert transform[:9] == [1, 0, 0, 0, -1, 0, 0, 0, -1]
    placed = -vertices[:, 2]+transform[11]
    assert placed.min() == pytest.approx(0, abs=1e-4) and placed.max() == pytest.approx(deck, abs=1e-4)


def test_platform_buildings_and_their_fallback(terrain, cover):
    classes = face_classes(cover, *terrain.elevations.shape)
    house = {"id": "way/1", "polygons": [{"outer": [[.29, .49], [.31, .49], [.31, .51], [.29, .51], [.29, .49]], "holes": []}],
             "height_m": 12, "min_height_m": 0}
    near = {"id": "way/2", "polygons": [{"outer": [[.6, .6], [.61, .6], [.61, .61], [.6, .61], [.6, .6]], "holes": []}], "height_m": 3}
    plan = platforms((.3, .5), (.7, .5), (.6005, .6105), top="building")
    file, _, _ = export_3mf(terrain, OPTIONS, PALETTE, classes, "OSM", project=plan, buildings=[house, near])
    model, ns, objects, mesh = read_3mf(file)
    items = model.findall("m:build/m:item", ns)
    names = [objects[item.attrib["objectid"]].attrib["name"] for item in items[1:]]
    assert names == ["Nail marker 1: platform and top", "Marker platform", "Nail marker 3: platform and top"]
    deck = PLATFORM_INFO["deck_top_z"]
    for item in (items[1], items[3]):
        top = objects[objects[item.attrib["objectid"]].findall("m:components/m:component", ns)[1].attrib["objectid"]]
        vertices, faces = mesh(top)
        assert_closed(vertices, faces)
        assert volume(vertices, faces) > 0  # outward-facing, not inside out
        assert vertices[:, 2].min() == pytest.approx(deck, abs=1e-6) and vertices[:, 2].max() >= deck+4-1e-6
        assert np.hypot(vertices[:, 0], vertices[:, 1]).max() <= PLATFORM_INFO["deck_size"]/2-PLATFORM_INFO["deck_chamfer"]-1.5+1e-6
    checks = check_project(terrain, OPTIONS, plan, PALETTE, {}, "3mf", buildings=[house, near])["checks"]
    assert [check["addon_id"] for check in checks if "No mapped building at nail marker 2; the platform prints bare." in check["message"]] == ["n1"]
    unloaded = check_project(terrain, OPTIONS, plan, PALETTE, {}, "3mf")["checks"]
    assert any("Turn on the Buildings map layer" in check["message"] for check in unloaded)
    with pytest.raises(ValueError, match="Buildings map layer"):
        export_3mf(terrain, OPTIONS, PALETTE, classes, "OSM", project=plan)


def test_platform_checks_spacing_nail_depth_and_top_colors(terrain):
    plan = platforms((.3, .5), (.33, .5), top="terrain", top_color="#ff0000")
    result = check_project(terrain, OPTIONS, plan, PALETTE, {}, "3mf")
    messages = [check["message"] for check in result["checks"]]
    assert "Platforms at markers 1 and 2 would touch; space them at least 30 mm apart." in messages
    proud = PLATFORM_INFO["exposed_nail_length"]-24.4
    assert any(f"stand {proud:.1f} mm proud" in message for message in messages)
    assert result["colors"] == 5 and "#ff0000" in print_color_set(PALETTE, {}, plan)
    assert any("5 colors" in message and "nail markers" in message for message in messages)
    assert "#ff0000" not in print_color_set(PALETTE, {}, platforms((.3, .5), top="terrain", top_color="#ff0000", include=False))
    with pytest.raises(ValueError, match="nail markers"):
        export_3mf(terrain, OPTIONS, PALETTE, None, "OSM", project=plan)


def test_marker_platform_endpoint(studio):
    client, _, _ = studio
    assert client.get("/api/studio/catalog").get_json()["marker_platform"]["deck_top_z"] == PLATFORM_INFO["deck_top_z"]
    stl = client.get("/api/studio/marker-platform?format=stl")
    assert stl.mimetype == "model/stl" and stl.data == (addons.DATA / "templates" / "marker-platform.stl").read_bytes()
    three = client.get("/api/studio/marker-platform?format=3mf&color=%2300ff00")
    assert "marker-platform.3mf" in three.headers["Content-Disposition"]
    model, ns, objects, mesh = read_3mf(BytesIO(three.data))
    vertices, faces = mesh(next(iter(objects.values())))
    assert_closed(vertices, faces)
    assert vertices[:, 2].min() == pytest.approx(0, abs=1e-4) and volume(vertices, faces) > 0  # deck down, still outward-facing
    assert client.get("/api/studio/marker-platform?format=blend").data == (addons.DATA / "templates" / "marker-platform.blend").read_bytes()
    assert client.get("/api/studio/marker-platform?format=3mf&color=green").status_code == 400
    assert client.get("/api/studio/marker-platform?format=dwg").status_code == 400


def test_finished_exports_save_into_models(studio, tmp_path):
    client, extension, cover = studio
    client.application.config["MODELS_DIR"] = tmp_path / "Models"
    jobs = extension["studio_jobs"]
    jobs["m"] = dict(state="ready", progress=1, message="", content=b"solid terrain", mimetype="model/stl",
                     filename="terrain-120mm.stl", finished=time.monotonic())
    jobs["p"] = dict(jobs["m"], filename="heights.png")
    first = client.post("/api/studio/jobs/m/save", json={})
    again = client.post("/api/studio/jobs/m/save", json={"name": "Desk relief"})
    assert first.get_json()["name"] == "terrain-120mm.stl" and again.get_json()["name"] == "Desk relief.stl"
    assert (tmp_path / "Models" / "VR Terrain" / "terrain-120mm.stl").read_bytes() == b"solid terrain"
    assert client.post("/api/studio/jobs/p/save", json={}).status_code == 400    # not a model
    assert client.post("/api/studio/jobs/gone/save", json={}).status_code == 404
    # Only this computer may write files: a request from the network is refused.
    remote = client.post("/api/studio/jobs/m/save", json={}, environ_base={"REMOTE_ADDR": "192.168.0.50"})
    assert remote.status_code == 403
