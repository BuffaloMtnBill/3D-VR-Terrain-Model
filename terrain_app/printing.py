"""Native 3MF assemblies of closed terrain parts sharing up to four colors."""
from io import BytesIO
import json
from xml.sax.saxutils import escape, quoteattr
from zipfile import ZipFile, ZIP_DEFLATED

import numpy as np

from .landcover import COVER_NAMES, COVER_LABELS
from .mesh import build_mesh, export_metadata
from .print_features import feature_color_parts
from .addons import (PLATFORM_INFO, Model, active_addons, apply_addons, ball_count, ball_positions, changes_model, marker_mesh, marker_style,
                     marker_tops, plan_project, platform_top, print_color_set, project_metadata, top_mesh)

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


def mesh_xml(vertices, faces):
    """Vertex and triangle elements, formatted in bulk: per-element ElementTree nodes dominate large exports."""
    vertices = np.asarray(vertices, dtype=np.float64).ravel().tolist()
    faces = np.asarray(faces, dtype=np.int64).ravel().tolist()
    return ("<vertices>" + '<vertex x="%.17g" y="%.17g" z="%.17g"/>'*(len(vertices)//3) % tuple(vertices) + "</vertices><triangles>"
            + '<triangle v1="%d" v2="%d" v3="%d"/>'*(len(faces)//3) % tuple(faces) + "</triangles>")


def model_xml(parts, metadata, attribution, balls=None, title="Terrain Studio four-color landscape"):
    """The 3D model part of a 3MF package: one colored object per part, grouped in one assembly.

    balls: optional {"vertices", "faces", "color", "positions"}, one more object placed as separate
    build items (marker balls beside the model) with its own material. Marker platforms add "name",
    "flip" (the deck height: bare platforms are turned deck down onto the bed) and "tops", one entry per
    position: None, or {"vertices", "faces", "color"} for a top that becomes, with the platform, a
    two-part assembly standing upright so the parts stay aligned."""
    def attributes(**values):
        return "".join(f" {name}={quoteattr(str(value))}" for name, value in values.items())
    output = ['<?xml version="1.0" encoding="UTF-8"?>',
              f'<model xmlns="{CORE}" unit="millimeter" xml:lang="en-US">',
              '<metadata name="Application">Terrain Studio</metadata>',
              f'<metadata name="Title">{escape(title)}</metadata>',
              f'<metadata name="Description">{escape(json.dumps(metadata))}</metadata>',
              f'<metadata name="Copyright">{escape(attribution)}</metadata>',
              '<resources><basematerials id="1">']
    output.extend(f"<base{attributes(name=part['name'], displaycolor=part['color'].upper()+'FF')}/>" for part in parts)
    # A ball (or platform top) sharing a part's color reuses its material, so slicers list no extra filament.
    materials = [part["color"].lower() for part in parts]
    def material(color, name):
        if color.lower() not in materials:
            materials.append(color.lower())
            output.append(f"<base{attributes(name=name, displaycolor=color.upper()+'FF')}/>")
        return materials.index(color.lower())
    marker_name = (balls or {}).get("name", "Marker ball")
    ball_index = material(balls["color"], marker_name) if balls else None
    tops = (balls or {}).get("tops") or []
    top_indices = [material(top["color"], "Platform top") if top else None for top in tops]
    output.append("</basematerials>")
    for index, part in enumerate(parts):
        output.append(f"<object{attributes(id=index+2, type='model', pid=1, pindex=index, name=f'Color {index+1}: {part['name']}')}>"
                      f"<mesh>{mesh_xml(part['vertices'], part['faces'])}</mesh></object>")
    assembly_id = len(parts)+2
    output.append(f'<object id="{assembly_id}" type="model" name="Terrain Studio - assign color parts to filaments"><components>')
    output.extend(f'<component objectid="{index+2}"/>' for index in range(len(parts)))
    output.append("</components></object>")
    if balls:
        output.append(f'<object{attributes(id=assembly_id+1, type="model", pid=1, pindex=ball_index, name=marker_name)}>'
                      f"<mesh>{mesh_xml(balls['vertices'], balls['faces'])}</mesh></object>")
    items, next_id = {}, assembly_id+2
    for index, (top, pindex) in enumerate(zip(tops, top_indices)):
        if not top:
            continue
        output.append(f'<object id="{next_id}" type="model" pid="1" pindex="{pindex}" name="Platform top {index+1}">'
                      f"<mesh>{mesh_xml(top['vertices'], top['faces'])}</mesh></object>"
                      f'<object id="{next_id+1}" type="model" name="Nail marker {index+1}: platform and top"><components>'
                      f'<component objectid="{assembly_id+1}"/><component objectid="{next_id}"/></components></object>')
        items[index], next_id = next_id+1, next_id+2
    output.append(f'</resources><build><item objectid="{assembly_id}"/>')
    flip = (balls or {}).get("flip")
    for index, (x, y) in enumerate((balls or {}).get("positions", [])):
        if index in items:
            output.append(f'<item objectid="{items[index]}" transform="1 0 0 0 1 0 0 0 1 {x:.6f} {y:.6f} 0"/>')
        elif flip is not None:  # turned over about x: the deck top lands on the bed
            output.append(f'<item objectid="{assembly_id+1}" transform="1 0 0 0 -1 0 0 0 -1 {x:.6f} {y:.6f} {flip:.6f}"/>')
        else:
            output.append(f'<item objectid="{assembly_id+1}" transform="1 0 0 0 1 0 0 0 1 {x:.6f} {y:.6f} 0"/>')
    output.append("</build></model>")
    return "".join(output).encode("utf-8")


def package_3mf(model):
    buffer = BytesIO()
    with ZipFile(buffer, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", '''<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>''')
        archive.writestr("_rels/.rels", '''<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>''')
        archive.writestr("3D/3dmodel.model", model)
    buffer.seek(0)
    return buffer


def export_3mf(terrain, options, palette, classes, attribution, feature_layers=None, feature_data=None, project=None, progress=None,
               buildings=None):
    """Closed color parts, with any Print Studio project's add-ons applied and marker balls (or platforms) beside the model.

    buildings: the loaded OSM building layer, for buildings printed on marker platforms (defaults to feature_data's)."""
    feature_layers = feature_layers or {}
    report = progress or (lambda fraction, message: None)
    colors = set(palette.values()) | {style["color"] for style in feature_layers.values() if style["enabled"]}
    if len(colors) > 4:
        raise ValueError("Use at most four colors across the Print palette and enabled map features. Share feature colors with the palette.")
    if changes_model(project) and len(print_color_set(palette, feature_layers, project)) > 4:
        raise ValueError("Use at most four colors across the Print palette, enabled map features, add-on material, and nail markers (balls, platforms, and their tops).")
    report(.05, "Building color parts…")
    parts = color_parts(terrain, options, palette, classes)
    feature_counts = {}
    if any(style["enabled"] for style in feature_layers.values()):
        if feature_data is None:
            raise ValueError("Wait for selected map features to load before exporting 3MF.")
        report(.15, "Adding map features…")
        parts, feature_counts = feature_color_parts(terrain, options, palette, parts, feature_layers, feature_data)
    if active_addons(project):
        report(.6, "Cutting add-ons…")
        model = Model(terrain, options)
        parts = apply_addons(parts, plan_project(project, model, palette["dirt"]), model)
    balls = None
    if ball_count(project):
        vertices, faces = marker_mesh(project)
        width, height = np.ptp(build_mesh(terrain, options)[0][:, :2], axis=0)
        balls = {"vertices": vertices, "faces": faces, "color": project["marker_balls"]["color"],
                 "positions": ball_positions(ball_count(project), width, height, vertices)}
        if marker_style(project) == "platform":
            balls |= {"name": "Marker platform", "flip": float(PLATFORM_INFO["deck_top_z"])}
            if platform_top(project) != "none":
                if buildings is None and feature_data is not None:
                    buildings = feature_data["layers"].get("buildings")
                if platform_top(project) == "building" and buildings is None:
                    raise ValueError("Turn on the Buildings map layer and wait for it to load to print buildings on marker platforms.")
                report(.8, "Shaping platform tops…")
                color = project["marker_balls"]["top_color"]
                balls["tops"] = [dict(zip(("vertices", "faces"), top_mesh(top["solid"])), color=color) if top["solid"] else None
                                 for top in marker_tops(terrain, options, project, buildings)]
    report(.85, "Writing 3MF…")
    metadata = export_metadata(terrain, options) | {"print_palette": palette, "feature_layers": feature_layers or {},
                "surface_source": "OpenStreetMap", "feature_counts": feature_counts, "feature_inlay_depth_mm": .6, "color_parts": [{"color": part["color"], "name": part["name"]} for part in parts]}
    if changes_model(project):
        metadata |= {"project": project_metadata(project), "marker_balls": len((balls or {}).get("positions", []))}
        if balls and marker_style(project) == "platform":
            metadata["marker_platforms"] = {"count": len(balls["positions"]), "top": platform_top(project),
                                            "tops_printed": sum(top is not None for top in balls.get("tops") or [])}
    content = package_3mf(model_xml(parts, metadata, attribution, balls))
    return content, "model/3mf", "terrain-print.3mf"
