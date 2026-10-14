from collections import Counter
from dataclasses import replace
import json
import time

import numpy as np
import pytest

from terrain_app.addons import Model, addon_mesh, project_options
from terrain_app.elevation import Bounds, Terrain, geographic_coordinates, pixel_coordinates
from terrain_app.landcover import COVER_NAMES
from terrain_app.mesh import ModelOptions, build_mesh, export_file
from terrain_app.printing import color_parts
from terrain_app.server import create_app
from terrain_app.studio import model_parts


@pytest.fixture
def oval():
    rows, columns = np.mgrid[0:18, 0:24]
    return Terrain(Bounds(36, -82, 36.05, -81.92, rotation_deg=32, shape="oval"),
                   (900+50*np.sin(columns/4)+40*np.cos(rows/4)).astype(np.float32), 11, 0, "2026-10-13T00:00:00Z")


def circle_bounds():
    x, y = pixel_coordinates(-82, 36, 0)
    west, north = geographic_coordinates(x-.03, y-.03, 0)
    east, south = geographic_coordinates(x+.03, y+.03, 0)
    return Bounds(float(south), float(west), float(north), float(east), rotation_deg=-23, shape="circle")


def assert_closed(vertices, faces):
    edges = Counter(tuple(sorted(edge)) for face in faces for edge in ((face[0], face[1]), (face[1], face[2]), (face[2], face[0])))
    assert set(edges.values()) == {2}
    tris = vertices[faces]
    assert np.linalg.norm(np.cross(tris[:, 1]-tris[:, 0], tris[:, 2]-tris[:, 0]), axis=1).min() > 1e-10


def volume(vertices, faces):
    tris = vertices[faces]
    return np.einsum("ij,ij->i", tris[:, 0], np.cross(tris[:, 1], tris[:, 2])).sum()/6


@pytest.mark.parametrize("shape", ["oval", "circle"])
def test_round_footprints_are_closed_clipped_and_preserve_rotation(oval, shape):
    if shape == "circle":
        oval.bounds = circle_bounds()
    oval.bounds.validate()
    assert Bounds.from_dict(oval.bounds.to_dict()) == oval.bounds
    assert oval.metadata()["bounds"]["shape"] == shape
    assert len(oval.metadata()["footprint"]) == 128
    vertices, faces = build_mesh(oval, ModelOptions())
    assert_closed(vertices, faces)
    w, h = np.ptp(vertices[:, :2], axis=0)
    assert np.max((vertices[:, 0]/(w/2))**2+(vertices[:, 1]/(h/2))**2) <= 1+1e-9
    if shape == "circle":
        assert w == pytest.approx(h)
    flat = replace(oval, elevations=np.ones_like(oval.elevations)*10)
    vertices, faces = build_mesh(flat, ModelOptions())
    # The inscribed polygon differs from the exact ellipse by less than 0.05%.
    assert volume(vertices, faces) == pytest.approx(np.pi*w*h/4*5.4, rel=.0005)
    rect = replace(flat, bounds=replace(flat.bounds, shape="rectangle"))
    assert volume(*build_mesh(flat, ModelOptions())) < volume(*build_mesh(rect, ModelOptions()))


def test_oval_surface_only_keeps_only_the_terrain_top(oval):
    vertices, faces = build_mesh(oval, ModelOptions(solid=False))
    tris = vertices[faces]
    normals = np.cross(tris[:, 1]-tris[:, 0], tris[:, 2]-tris[:, 0])
    assert np.all(normals[:, 2] > 0)
    assert np.ptp(vertices[:, :2], axis=0).max() == pytest.approx(180)


@pytest.mark.parametrize("disconnected", [False, True])
def test_color_parts_partition_the_oval_and_studio_keeps_the_footprint(oval, disconnected):
    rows, columns = oval.elevations.shape
    classes = np.repeat(np.tile(np.arange(columns-1)*4//(columns-1), rows-1), 2)
    if disconnected:
        classes = np.arange((rows-1)*(columns-1)*2) % 4
    palette = dict(zip(COVER_NAMES, ["#112233", "#445566", "#778899", "#aabbcc", "#112233", "#445566"]))
    choice = ModelOptions()
    parts = color_parts(oval, choice, palette, classes)
    for part in parts:
        assert_closed(part["vertices"], part["faces"])
    assert sum(volume(part["vertices"], part["faces"]) for part in parts) == pytest.approx(volume(*build_mesh(oval, choice)), rel=1e-7)
    plain = model_parts(oval, choice)
    assert volume(plain[0]["vertices"], plain[0]["faces"]) == pytest.approx(volume(*build_mesh(oval, choice)))


def test_addons_sample_the_original_grid_but_keep_material_on_the_oval(oval):
    choice = ModelOptions()
    model = Model(oval, choice)
    assert model.top.shape == (18, 24, 3)
    assert model.frame.area/(model.width*model.height) == pytest.approx(np.pi/4, rel=.0005)
    project = project_options({"addons": [{"id": "pad", "type": "plaque", "u": .9, "v": .1, "rotation_deg": 0,
                "params": {"width": 50, "length": 30, "mode": "raise", "raise": 5, "text": ""}}]})
    vertices, faces = addon_mesh(oval, choice, project)
    assert_closed(vertices, faces)
    assert np.max((vertices[:, 0]/(model.width/2))**2+(vertices[:, 1]/(model.height/2))**2) <= 1+1e-8


def test_bounds_reject_unknown_shapes_and_non_circular_circle_axes(oval):
    with pytest.raises(ValueError, match="selection shape"):
        Bounds.from_dict(oval.bounds.to_dict() | {"shape": "triangle"})
    with pytest.raises(ValueError, match="equal width and height"):
        Bounds.from_dict(oval.bounds.to_dict() | {"shape": "circle"})


def test_shape_and_rotation_reach_api_and_export_metadata(oval, tmp_path):
    app = create_app({"TESTING": True, "CACHE_DIR": tmp_path})
    extension = app.extensions["terrain"]
    extension["jobs"]["oval"] = {"state": "ready", "terrain": oval, "accessed": time.monotonic()}
    try:
        client = app.test_client()
        surface = client.get("/api/terrain/oval").get_json()
        assert surface["bounds"]["shape"] == "oval" and surface["bounds"]["rotation_deg"] == 32
        assert len(surface["footprint"]) == 128
        content, _, _ = export_file(oval, ModelOptions(), "metadata", "credits")
        saved = json.load(content)
        assert saved["bounds"] == oval.bounds.to_dict()
        response = client.post("/api/export/oval", json={"format": "stl", "options": {}})
        assert response.status_code == 200 and response.mimetype == "model/stl"
    finally:
        extension["executor"].shutdown(wait=True)
