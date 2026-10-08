"""Print Studio exports: one pipeline for background jobs, server-side GLB, preview meshes, and the marker ball."""
from dataclasses import replace
import json
import struct

import numpy as np

from .addons import (BALL_INFO, BALL_PATH, PLATFORM_INFO, PLATFORM_PATH, TERRAIN_COLOR, Model, active_addons, apply_addons, marker_ball,
                     marker_platform, plan_project, project_metadata, changes_model)
from .mesh import build_mesh, export_file, export_metadata
from .print_features import feature_color_parts
from .printing import color_parts, export_3mf, model_xml, package_3mf

PREVIEW_GRID = 160  # largest preview grid side; previews trade detail for speed
FORMATS = ("stl", "obj", "3mf", "glb", "png", "csv", "npy", "metadata")
MIMETYPES = {"stl": "STL", "obj": "OBJ", "3mf": "3MF", "glb": "GLB"}


def studio_format(value):
    if value not in FORMATS:
        raise ValueError(f"Choose {', '.join(FORMATS[:-1])}, or metadata as the export format.")
    return value


def downsample(terrain, options, classes=None, limit=PREVIEW_GRID):
    """A coarser copy of the terrain grid with the same bounds; face classes follow each coarse cell's first cell."""
    rows, columns = terrain.elevations.shape
    if max(rows, columns) <= limit:
        return terrain, options, classes
    factor = (max(rows, columns)-1)/(limit-1)
    row_index = np.unique(np.linspace(0, rows-1, max(2, round((rows-1)/factor)+1)).round().astype(int))
    column_index = np.unique(np.linspace(0, columns-1, max(2, round((columns-1)/factor)+1)).round().astype(int))
    small = replace(terrain, elevations=terrain.elevations[np.ix_(row_index, column_index)])
    if classes is not None:
        classes = np.asarray(classes).reshape(rows-1, columns-1, 2)[np.ix_(row_index[:-1], column_index[:-1])].ravel()
    return small, replace(options, smoothing=options.smoothing/factor), classes


def model_parts(terrain, options, palette=None, classes=None, feature_layers=None, feature_data=None, project=None, report=None):
    """Closed parts for a GLB or preview: color parts with the Print palette, otherwise one terrain part."""
    report = report or (lambda fraction, message: None)
    if palette is not None and classes is not None and options.solid:
        report(.1, "Building color parts…")
        parts = color_parts(terrain, options, palette, classes)
        if feature_data is not None and any(style["enabled"] for style in (feature_layers or {}).values()):
            report(.3, "Adding map features…")
            parts, _ = feature_color_parts(terrain, options, palette, parts, feature_layers, feature_data)
        default = palette["dirt"]
    else:
        report(.1, "Building the model…")
        vertices, faces = build_mesh(terrain, options)
        parts, default = [{"color": TERRAIN_COLOR, "name": "Terrain", "vertices": vertices, "faces": faces}], TERRAIN_COLOR
    if active_addons(project):
        if not options.solid:
            raise ValueError("Enable Solid base to add holes, pockets, and other add-ons.")
        report(.6, "Cutting add-ons…")
        model = Model(terrain, options)
        parts = apply_addons(parts, plan_project(project, model, default), model)
    return parts


def linear(color):
    value = np.asarray([int(color[index:index+2], 16) for index in (1, 3, 5)])/255
    return np.where(value <= .04045, value/12.92, ((value+.055)/1.055)**2.4).round(5).tolist()


def glb(parts, extras=None):
    """A binary glTF 2.0 file: one mesh and material per part, Y up, in meters (as the client's GLB export)."""
    document = {"asset": {"version": "2.0", "generator": "Terrain Studio"}, "scene": 0,
                "scenes": [{"name": "Terrain Studio", "nodes": list(range(len(parts))), **({"extras": extras} if extras else {})}],
                "nodes": [], "meshes": [], "materials": [], "accessors": [], "bufferViews": [], "buffers": []}
    blob = bytearray()
    for index, part in enumerate(parts):
        vertices = np.asarray(part["vertices"], dtype=np.float64)
        # Model x right, y toward the top, z up → glTF x right, y up, z toward the viewer (a rotation, so winding holds).
        positions = (np.column_stack((vertices[:, 0], vertices[:, 2], -vertices[:, 1]))/1000).astype("<f4")
        indices = np.asarray(part["faces"]).astype("<u4").ravel()
        for data, target in ((positions, 34962), (indices, 34963)):
            document["bufferViews"].append({"buffer": 0, "byteOffset": len(blob), "byteLength": data.nbytes, "target": target})
            blob += data.tobytes()
            blob += b"\0"*(-len(blob) % 4)
        document["accessors"] += [{"bufferView": 2*index, "componentType": 5126, "count": len(positions), "type": "VEC3",
                                   "min": positions.min(axis=0).tolist(), "max": positions.max(axis=0).tolist()},
                                  {"bufferView": 2*index+1, "componentType": 5125, "count": len(indices), "type": "SCALAR"}]
        document["materials"].append({"name": part["name"], "pbrMetallicRoughness": {
            "baseColorFactor": [*linear(part["color"]), 1], "metallicFactor": 0, "roughnessFactor": .9}})
        document["meshes"].append({"name": part["name"], "primitives": [{"attributes": {"POSITION": 2*index}, "indices": 2*index+1, "material": index}]})
        document["nodes"].append({"name": part["name"], "mesh": index})
    document["buffers"].append({"byteLength": len(blob)})
    text = json.dumps(document, separators=(",", ":")).encode()
    text += b" "*(-len(text) % 4)
    return (struct.pack("<4sII", b"glTF", 2, 28+len(text)+len(blob)) + struct.pack("<I4s", len(text), b"JSON") + text
            + struct.pack("<I4s", len(blob), b"BIN\0") + bytes(blob))


def preview(parts, model_size):
    """Mesh parts for the studio's 'Preview cuts' view, in model millimeters (x right, y toward the top, z up)."""
    return json.dumps({"units": "mm", "axes": "x right, y toward the model top, z up; centered on x/y, floor at z = 0",
                       "size_mm": model_size,
                       "parts": [{"color": part["color"], "name": part["name"],
                                  "positions": np.round(np.asarray(part["vertices"], dtype=np.float64), 3).ravel().tolist(),
                                  "indices": np.asarray(part["faces"]).astype(np.int64).ravel().tolist()} for part in parts]},
                      separators=(",", ":")).encode()


def studio_export(terrain, options, format, attribution, *, palette=None, classes=None, feature_layers=None, feature_data=None,
                  project=None, preview_mesh=False, progress=None, buildings=None):
    """Return (bytes, mimetype, filename) for a Print Studio export job.

    palette/classes enable color parts (3MF requires them); feature_data is the loaded map features;
    buildings is the loaded building layer, for buildings printed on marker platforms."""
    report = progress or (lambda fraction, message: None)
    if preview_mesh:
        # Map features are left out: the studio draws its own, and thousands of buildings would make previews slow.
        terrain, options, classes = downsample(terrain, options, classes)
        parts = model_parts(terrain, options, palette, classes, project=project, report=report)
        report(.9, "Preparing the preview…")
        size = np.ptp(np.concatenate([part["vertices"] for part in parts])[:, :2], axis=0).round(3).tolist()
        return preview(parts, size), "application/json", "terrain-preview.json"
    if format == "3mf":
        if palette is None or classes is None:
            raise ValueError("Select the Print palette and choose its surface colors before exporting 3MF.")
        content, mimetype, filename = export_3mf(terrain, options, palette, classes, attribution, feature_layers, feature_data, project, report,
                                                 buildings=buildings)
        return content.getvalue(), mimetype, filename
    if format == "glb":
        parts = model_parts(terrain, options, palette, classes, feature_layers, feature_data, project, report)
        report(.9, "Writing GLB…")
        extras = export_metadata(terrain, options) | {"mesh_units": "meters", "attribution": attribution}
        if changes_model(project):
            extras["project"] = project_metadata(project)
        return glb(parts, extras), "model/gltf-binary", "terrain.glb"
    report(.1, "Cutting add-ons…" if active_addons(project) and format in ("stl", "obj") else "Building the model…")
    content, mimetype, filename = export_file(terrain, options, format, attribution, feature_layers, palette, project)
    report(.9, f"Writing {MIMETYPES.get(format, format.upper())}…")
    return content.getvalue(), mimetype, filename


def marker_ball_file(format, color, kind="ball"):
    """The bundled marker ball (or platform): the STL or Blender source as shipped, or a one-color 3MF."""
    path, info, mesh, name = ((PLATFORM_PATH, PLATFORM_INFO, marker_platform, "platform") if kind == "platform"
                              else (BALL_PATH, BALL_INFO, marker_ball, "ball"))
    if format == "stl":
        return path.read_bytes(), "model/stl", f"marker-{name}.stl"
    if format == "blend":
        return path.with_suffix(".blend").read_bytes(), "application/x-blender", f"marker-{name}.blend"
    if format == "3mf":
        vertices, faces = mesh()
        if kind == "platform":  # turned over about x (a rotation, so winding holds): deck down on the bed, no supports
            vertices = vertices*(1, -1, -1)+(0, 0, info["deck_top_z"])
        part = {"color": color, "name": f"Marker {name}", "vertices": vertices, "faces": faces}
        model = model_xml([part], info, f"Terrain Studio marker {name}", title=f"Terrain Studio marker {name}")
        return package_3mf(model).getvalue(), "model/3mf", f"marker-{name}.3mf"
    raise ValueError(f"Choose stl, 3mf, or blend for the marker {name}.")


def marker_platform_file(format, color):
    return marker_ball_file(format, color, "platform")
