"""Native 3MF assemblies of closed terrain parts sharing up to four colors."""
from io import BytesIO
import json
from xml.etree import ElementTree as ET
from zipfile import ZipFile, ZIP_DEFLATED

import numpy as np

from .landcover import COVER_NAMES, COVER_LABELS
from .mesh import build_mesh, export_metadata
from .print_features import feature_color_parts

CORE = "http://schemas.microsoft.com/3dmanufacturing/core/2015/02"


def color_parts(terrain, options, palette, classes):
    if not options.solid:
        raise ValueError("Enable Solid base to export separate closed color parts.")
    if len(set(palette.values())) > 4:
        raise ValueError("Share colors between surface types to use at most four colors in 3MF.")
    vertices, faces = build_mesh(terrain, options)
    count = terrain.elevations.size
    # Python's mesh stores the first triangle of every cell before the second.
    top_faces = faces[:len(classes)]
    ordered = np.concatenate((classes[0::2], classes[1::2]))
    colors = np.asarray([palette[name] for name in COVER_NAMES])[ordered]
    top = vertices[:count]
    floor = top.copy()
    floor[:, 2] = 0
    all_vertices = np.concatenate((top, floor))
    parts = []
    for color in dict.fromkeys(palette.values()):
        triangles = top_faces[colors == color]
        if not len(triangles):
            continue
        edges = np.concatenate((triangles[:, [0, 1]], triangles[:, [1, 2]], triangles[:, [2, 0]]))
        _, inverse, counts = np.unique(np.sort(edges, axis=1), axis=0, return_inverse=True, return_counts=True)
        border = edges[counts[inverse] == 1]
        a, b = border.T
        walls = np.concatenate((np.column_stack((a, a+count, b)), np.column_stack((b, a+count, b+count))))
        part_faces = np.concatenate((triangles, triangles[:, ::-1]+count, walls))
        used, indices = np.unique(part_faces, return_inverse=True)
        names = [COVER_LABELS[index] for index, name in enumerate(COVER_NAMES) if palette[name] == color]
        parts.append({"color": color, "name": " / ".join(names), "vertices": all_vertices[used], "faces": indices.reshape(-1, 3)})
    return parts


def export_3mf(terrain, options, palette, classes, attribution, feature_layers=None, feature_data=None):
    feature_layers = feature_layers or {}
    colors = set(palette.values()) | {style["color"] for style in feature_layers.values() if style["enabled"]}
    if len(colors) > 4:
        raise ValueError("Use at most four colors across the Print palette and enabled map features. Share feature colors with the palette.")
    parts = color_parts(terrain, options, palette, classes)
    feature_counts = {}
    if any(style["enabled"] for style in feature_layers.values()):
        if feature_data is None:
            raise ValueError("Wait for selected map features to load before exporting 3MF.")
        parts, feature_counts = feature_color_parts(terrain, options, palette, parts, feature_layers, feature_data)
    ET.register_namespace("", CORE)
    def add(parent, tag, attributes=None, text=None):
        child = ET.SubElement(parent, f"{{{CORE}}}{tag}", attributes or {})
        child.text = text
        return child
    model = ET.Element(f"{{{CORE}}}model", {"unit": "millimeter", "{http://www.w3.org/XML/1998/namespace}lang": "en-US"})
    add(model, "metadata", {"name": "Application"}, "Terrain Studio")
    add(model, "metadata", {"name": "Title"}, "Terrain Studio four-color landscape")
    metadata = export_metadata(terrain, options) | {"print_palette": palette, "feature_layers": feature_layers or {},
                "surface_source": "OpenStreetMap", "feature_counts": feature_counts, "feature_inlay_depth_mm": .6, "color_parts": [{"color": part["color"], "name": part["name"]} for part in parts]}
    add(model, "metadata", {"name": "Description"}, json.dumps(metadata))
    add(model, "metadata", {"name": "Copyright"}, attribution)
    resources = add(model, "resources")
    materials = add(resources, "basematerials", {"id": "1"})
    for index, part in enumerate(parts):
        add(materials, "base", {"name": part["name"], "displaycolor": part["color"].upper()+"FF"})
        object = add(resources, "object", {"id": str(index+2), "type": "model", "pid": "1", "pindex": str(index),
                                           "name": f"Color {index+1}: {part['name']}"})
        mesh = add(object, "mesh")
        vertices = add(mesh, "vertices")
        for x, y, z in part["vertices"]:
            add(vertices, "vertex", {"x": f"{x:.17g}", "y": f"{y:.17g}", "z": f"{z:.17g}"})
        triangles = add(mesh, "triangles")
        for a, b, c in part["faces"]:
            add(triangles, "triangle", {"v1": str(a), "v2": str(b), "v3": str(c)})
    assembly_id = str(len(parts)+2)
    assembly = add(resources, "object", {"id": assembly_id, "type": "model", "name": "Terrain Studio - assign color parts to filaments"})
    components = add(assembly, "components")
    for index in range(len(parts)):
        add(components, "component", {"objectid": str(index+2)})
    build = add(model, "build")
    add(build, "item", {"objectid": assembly_id})
    buffer = BytesIO()
    with ZipFile(buffer, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", '''<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>''')
        archive.writestr("_rels/.rels", '''<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>''')
        archive.writestr("3D/3dmodel.model", ET.tostring(model, encoding="utf-8", xml_declaration=True))
    buffer.seek(0)
    return buffer, "model/3mf", "terrain-print.3mf"
