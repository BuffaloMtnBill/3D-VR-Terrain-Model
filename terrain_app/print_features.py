"""Printable OSM inlays and buildings, partitioned with manifold mesh booleans."""
import math

import manifold3d as mf
import numpy as np
from shapely import contains_xy, get_coordinates, line_interpolate_point, make_valid
from shapely.affinity import affine_transform
from shapely.geometry import LineString, Polygon, box
from shapely.geometry.polygon import orient
from shapely.ops import substring, unary_union

from .features import LAYER_NAMES, parts
from .mesh import build_mesh
from .footprint import footprint_polygon, footprint_prism

LABELS = dict(zip(LAYER_NAMES, ("Roads", "Train tracks", "Borders", "Water", "City boundaries", "Park boundaries", "Buildings", "AT", "Other trails")))
LABELS["route"] = "Route"  # an uploaded GPX track (routes.py), printed like a trail at its chosen width
# Later layers take precedence where features intersect.
ORDER = ("water", "roads", "railways", "borders", "cities", "parks", "trails", "at", "route", "buildings")
ROAD_DETAIL = {"motorway": 0, "motorway_link": 0, "trunk": 0, "trunk_link": 0, "primary": 0, "primary_link": 0,
               "secondary": 25, "secondary_link": 25, "tertiary": 50, "tertiary_link": 50, "unclassified": 75, "residential": 75}
INLAY_DEPTH = .6  # mm: three layers at a typical 0.2 mm layer height
MIN_LINE_WIDTH = .6
MAX_PRINT_SEGMENTS = 200_000


def selected_features(data, styles, terrain):
    """Apply exactly the same road/water filtering as the interactive preview."""
    result = {}
    for name, style in styles.items():
        if not style["enabled"]:
            continue
        features = data["layers"].get(name, [])
        detail = style.get("detail", 100)
        if name == "roads":
            features = [feature for feature in features if detail >= ROAD_DETAIL.get(feature.get("kind"), 100)]
        elif name == "water" and detail < 100:
            def visible(feature):
                kind = feature.get("kind")
                if kind in {"river", "riverbank", "sea"}:
                    return True
                if kind in {"canal", "stream", "ditch", "drain"}:
                    return detail >= {"canal": 25, "stream": 80, "ditch": 100, "drain": 100}[kind]
                area = feature.get("area_m2")
                if area is None:
                    area = sum(Polygon(p["outer"], p["holes"]).area for p in feature.get("polygons", []))*terrain.width*terrain.height
                return area >= 20_000*(1-detail/100)**2
            features = [feature for feature in features if visible(feature)]
        elif name == "buildings":
            # 3D mode replaces outlines with their mapped parts; block mode ignores parts.
            features = [feature for feature in features if (not feature.get("has_parts") if style.get("detailed") else not feature.get("part"))]
        result[name] = features
    return result


def checked(solid):
    if solid.status() != mf.Error.NoError:
        raise ValueError("Printable map features could not form closed solids. Try a smaller area.")
    return solid


def from_mesh(vertices, faces):
    return checked(mf.Manifold(mf.Mesh64(np.array(vertices, dtype=np.float64, order="C", copy=True),
                                       np.array(faces, dtype=np.uint64, order="C", copy=True))))


def union(solids):
    return checked(mf.Manifold.batch_boolean(solids, mf.OpType.Add))


def extrude(geometry, height):
    contours = []
    for polygon in parts(make_valid(geometry), "Polygon"):
        polygon = orient(polygon)
        contours.append(np.asarray(polygon.exterior.coords[:-1], dtype=np.float64))
        contours.extend(np.asarray(ring.coords[:-1], dtype=np.float64) for ring in polygon.interiors)
    if not contours:
        return mf.Manifold()
    return checked(mf.CrossSection(contours).extrude(height))


def mesh_solid(feature, ground, scale, width, height):
    """A mapped 3D building in model millimeters; its base reaches the model floor like block buildings."""
    positions = np.asarray(feature["mesh"]["positions"], dtype=np.float64).reshape(-1, 3)
    faces = np.asarray(feature["mesh"]["indices"], dtype=np.uint64).reshape(-1, 3)[:, ::-1]  # y is mirrored below
    scale = max(scale, .8/max(feature.get("height_m", 6), 1e-6))
    z = np.where(positions[:, 2] <= 1e-6, 0, ground+positions[:, 2]*scale)
    solid = from_mesh(np.column_stack(((positions[:, 0]-.5)*width, (.5-positions[:, 1])*height, z)), faces)
    if solid.is_empty():
        raise ValueError("Empty building")
    return solid


def footprint(feature, transform):
    return unary_union([affine_transform(Polygon(p["outer"], p["holes"]), transform)
                        for p in feature.get("polygons", [])])


def line_footprint(features, name, transform, model_size, width_mm=None):
    width = max(MIN_LINE_WIDTH, width_mm or model_size*(.014 if name == "roads" else .012 if name == "water" else .010)/6.4)
    shapes, segments = [], 0
    for feature in features:
        for path in feature.get("lines", []):
            if len(path) < 2:
                continue
            line = affine_transform(LineString(path), transform)
            if line.length < 1e-7:
                continue
            if name in {"borders", "cities", "parks"}:
                pieces = [substring(line, start, min(start+2, line.length)) for start in np.arange(0, line.length, 3)]
            elif name == "railways":
                # Two 0.4-mm rails and ties; retain visible separation with a 0.4-mm nozzle.
                pieces = [line.offset_curve(-.5), line.offset_curve(.5)]
                for distance in np.arange(0, line.length, 1.8):
                    point = line.interpolate(distance)
                    a = line.interpolate(max(0, distance-.01))
                    b = line.interpolate(min(line.length, distance+.01))
                    dx, dy = b.x-a.x, b.y-a.y
                    length = math.hypot(dx, dy)
                    if length:
                        nx, ny = -dy/length*.7, dx/length*.7
                        pieces.append(LineString([(point.x-nx, point.y-ny), (point.x+nx, point.y+ny)]))
                width = .4
            else:
                pieces = [line]
            segments += len(pieces)
            if segments > MAX_PRINT_SEGMENTS:
                raise ValueError("There are too many printable feature segments. Reduce detail or select a smaller area.")
            shapes.extend(piece.buffer(width/2, quad_segs=2) for piece in pieces if piece.length > 1e-7)
    return unary_union(shapes)


def clean_collinear_faces(vertices, faces):
    """Retriangulate collapsed contact faces without moving any boundary vertices.

    Boolean operations can leave a zero-area triangle along a shared straight
    edge. Split the neighboring face at its middle vertex to keep every edge
    paired, rather than deleting a face and leaving a hole.
    """
    faces = np.array(faces, dtype=np.uint64, copy=True)
    for _ in range(256):
        triangles = vertices[faces]
        zero = np.flatnonzero(np.linalg.norm(np.cross(triangles[:, 1]-triangles[:, 0], triangles[:, 2]-triangles[:, 0]), axis=1) == 0)
        if not len(zero):
            return faces
        index = int(zero[0])
        face = faces[index]
        lengths = [np.linalg.norm(vertices[face[a]]-vertices[face[b]]) for a, b in ((0, 1), (1, 2), (2, 0))]
        i, j = ((0, 1), (1, 2), (2, 0))[int(np.argmax(lengths))]
        a, c, middle = int(face[i]), int(face[j]), int(face[3-i-j])
        if np.array_equal(vertices[middle], vertices[a]) or np.array_equal(vertices[middle], vertices[c]):
            target = a if np.array_equal(vertices[middle], vertices[a]) else c
            faces[faces == middle] = target
            faces = faces[(faces[:, 0] != faces[:, 1]) & (faces[:, 1] != faces[:, 2]) & (faces[:, 2] != faces[:, 0])]
            continue
        neighbors = np.flatnonzero((faces == a).any(axis=1) & (faces == c).any(axis=1))
        neighbors = neighbors[neighbors != index]
        if len(neighbors) != 1:
            raise ValueError("Printable feature contacts could not be closed. Try a smaller area.")
        neighbor_index = int(neighbors[0])
        neighbor = faces[neighbor_index].tolist()
        for offset in range(3):
            u, v, d = neighbor[offset], neighbor[(offset+1)%3], neighbor[(offset+2)%3]
            if {u, v} == {a, c}:
                faces[index] = [u, middle, d]
                faces[neighbor_index] = [middle, v, d]
                break
    raise ValueError("Too many tiny feature contacts to print. Reduce detail or choose a smaller area.")


def grid_window(bounds, width, height, rows, columns):
    """Row and column slices of the model grid covering an (x0, y0, x1, y1) box in model millimeters."""
    x0, y0, x1, y1 = bounds
    first_column = max(0, math.floor((x0/width+.5)*(columns-1)))
    last_column = min(columns-1, math.ceil((x1/width+.5)*(columns-1)))
    first_row = max(0, math.floor((.5-y1/height)*(rows-1)))
    last_row = min(rows-1, math.ceil((.5-y0/height)*(rows-1)))
    return slice(first_row, max(first_row, last_row+1)), slice(first_column, max(first_column, last_column+1))


def surface_heights(top, width, height, points):
    """Heights of the triangulated model surface (a rows×columns×3 grid in mm) at x/y points."""
    rows, columns = top.shape[:2]
    points = np.asarray(points, dtype=np.float64).reshape(-1, 2)
    x = np.clip((points[:, 0]/width+.5)*(columns-1), 0, columns-1)
    y = np.clip((.5-points[:, 1]/height)*(rows-1), 0, rows-1)
    col, row = np.minimum(x.astype(int), columns-2), np.minimum(y.astype(int), rows-2)
    rx, ry = x-col, y-row
    a, b, c, d = top[row, col, 2], top[row, col+1, 2], top[row+1, col, 2], top[row+1, col+1, 2]
    return np.where(rx+ry <= 1, a*(1-rx-ry)+b*rx+c*ry, d*(rx+ry-1)+b*(1-ry)+c*(1-rx))


def feature_color_parts(terrain, options, palette, base_parts, styles, data):
    """Cut surface inlays out of terrain; cut building foundations out before adding roofs.

    All color solids are closed and their interiors never overlap. Features sharing
    a surface color are unioned into its part, so there is one part per filament.
    """
    selected = selected_features(data, styles, terrain)
    if not any(selected.values()):
        return base_parts, {name: 0 for name in selected}
    vertices, faces = build_mesh(terrain, options)
    terrain_solid = from_mesh(vertices, faces)
    shell = checked(terrain_solid-terrain_solid.translate((0, 0, -INLAY_DEPTH)))
    width, height = np.ptp(vertices[:, :2], axis=0)
    transform = [width, 0, 0, -height, -width/2, height/2]
    frame = footprint_polygon(terrain.bounds, width, height)
    maximum = vertices[:, 2].max()
    solids = {part["color"]: from_mesh(part["vertices"], part["faces"]) for part in base_parts}
    labels = {part["color"]: part["name"].split(" / ") for part in base_parts}
    counts = {}
    rows, columns = terrain.elevations.shape
    grid_vertices, _ = build_mesh(terrain, options, clip=False)
    top = grid_vertices[:rows*columns].reshape(rows, columns, 3)
    def surface_height(points):
        return surface_heights(top, width, height, points)
    def polygon_ground(polygon):
        # Sample grid vertices plus densely sampled footprint edges for a level base.
        ring = polygon.exterior
        spacing = min(width/(columns-1), height/(rows-1))/2
        points = get_coordinates(line_interpolate_point(ring, np.linspace(0, ring.length, max(2, math.ceil(ring.length/spacing)+1))))
        # Only grid vertices inside the footprint's bounding box can lie within it.
        window = top[grid_window(polygon.bounds, width, height, rows, columns)]
        within = contains_xy(polygon, window[:, :, 0], window[:, :, 1])
        return max(float(surface_height(points).max()), float(window[:, :, 2][within].max()) if within.any() else 0)
    for name in ORDER:
        features = selected.get(name, [])
        counts[name] = len(features) if name in selected else 0
        if not features:
            continue
        if name == "buildings":
            buildings = []
            outlines = {feature["id"]: feature for feature in data["layers"].get("buildings", [])}
            for feature in features:
                geometry = footprint(feature, transform).intersection(frame)
                scale = options.exaggeration*options.size_mm/max(terrain.width, terrain.height)
                if styles[name].get("detailed") and feature.get("mesh"):
                    parent = outlines.get(feature.get("parent"), feature)
                    base = footprint(parent, transform).intersection(frame)
                    grounds = [polygon_ground(polygon) for polygon in parts(base if not base.is_empty else geometry, "Polygon")]
                    try:
                        buildings.append(mesh_solid(feature, max(grounds, default=0), scale, width, height))
                        continue
                    except (ValueError, RuntimeError):
                        pass  # An unusable mapped shape is printed as its flat-roofed footprint.
                if geometry.is_empty:
                    continue
                for polygon in parts(geometry, "Polygon"):
                    roof = polygon_ground(polygon)+max(.8, feature.get("height_m", 6)*scale)
                    buildings.append(extrude(polygon, roof))
            if not buildings:
                continue
            feature_solid = union(buildings)
            if terrain.bounds.shape != "rectangle":
                feature_solid = checked(feature_solid ^ footprint_prism(terrain.bounds, width, height, -1, feature_solid.bounding_box()[5]+1))
        else:
            geometry = line_footprint(features, name, transform, options.size_mm, styles[name].get("width_mm"))
            if name == "water":
                geometry = unary_union([geometry, *(footprint(feature, transform) for feature in features)])
            geometry = geometry.intersection(frame)
            feature_solid = checked(extrude(geometry, maximum+1)^shell)
        if feature_solid.is_empty():
            continue
        color = styles[name]["color"]
        for other in list(solids):
            if other != color:
                solids[other] = checked(solids[other]-feature_solid)
        solids[color] = union([solids[color], feature_solid]) if color in solids else feature_solid
        labels.setdefault(color, [])
        labels[color].append(LABELS[name])
    result = []
    for color, solid in solids.items():
        checked(solid)
        if solid.is_empty():
            continue
        mesh = solid.to_mesh64()
        mesh_vertices = np.asarray(mesh.vert_properties)[:, :3]
        mesh_faces = clean_collinear_faces(mesh_vertices, np.asarray(mesh.tri_verts))
        result.append({"color": color, "name": " / ".join(dict.fromkeys(labels[color])),
                       "vertices": mesh_vertices, "faces": mesh_faces, "solid": solid})
    return result, counts
