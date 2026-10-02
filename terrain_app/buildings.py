"""OSM Simple 3D Buildings: mapped heights, building parts, and roof shapes as closed solids."""
import math

import manifold3d as mf
import numpy as np
from shapely import make_valid
from shapely.affinity import affine_transform
from shapely.geometry import Polygon
from shapely.geometry.polygon import orient

# Mapped roof:shape values and the supported form that approximates each.
ROOF_SHAPES = {"flat": "flat", "gabled": "gabled", "gambrel": "gabled", "saltbox": "gabled", "round": "gabled",
               "half-hipped": "hipped", "hipped": "hipped", "mansard": "hipped", "side_hipped": "hipped",
               "pyramidal": "pyramidal", "dome": "pyramidal", "onion": "pyramidal", "cone": "pyramidal",
               "skillion": "skillion", "lean_to": "skillion"}
COMPASS = {name: index*22.5 for index, name in enumerate(
    "N NNE NE ENE E ESE SE SSE S SSW SW WSW W WNW NW NNW".split())}


def meters(value, multiplier=1, maximum=500):
    try:
        number = float(str(value).lower().removesuffix("m").strip())*multiplier
    except (ValueError, TypeError):
        return None
    return number if math.isfinite(number) and 0 < number <= maximum else None


def building_dimensions(tags):
    """Total, base, and roof heights in meters from mapped tags; six meters when nothing is mapped."""
    roof_levels = meters(tags.get("roof:levels"), 3) or 0
    height, source = meters(tags.get("height")), "height"
    if height is None:
        levels = meters(tags.get("building:levels"), 3)
        height, source = (levels+roof_levels, "building:levels") if levels else (6, "assumed")
        height = min(height, 500)
    base = meters(tags.get("min_height")) or meters(tags.get("building:min_level"), 3) or 0
    if base >= height:
        base = 0
    shape = ROOF_SHAPES.get(str(tags.get("roof:shape", "flat")).strip().lower(), "flat")
    roof = 0
    if shape != "flat":
        roof = min(meters(tags.get("roof:height")) or roof_levels or 3, height-base)
    result = {"height_m": height, "height_source": source, "min_height_m": base, "roof_shape": shape, "roof_height_m": roof}
    if tags.get("roof:orientation") == "across":
        result["roof_across"] = True
    direction = str(tags.get("roof:direction", "")).strip()
    bearing = COMPASS.get(direction.upper())
    if bearing is None:
        try:
            bearing = float(direction) % 360
        except ValueError:
            bearing = None
    if bearing is not None and math.isfinite(bearing):
        result["roof_direction_deg"] = bearing
    return result


def is_detailed(feature):
    """Whether a flat block from the footprint and total height would misrepresent the mapped building."""
    return bool(feature.get("part") or feature.get("min_height_m") or feature.get("roof_height_m"))


def contours(polygon):
    polygon = orient(polygon)
    return [np.asarray(ring.coords[:-1], dtype=np.float64) for ring in (polygon.exterior, *polygon.interiors)]


def prism(polygon, height):
    return mf.CrossSection(contours(polygon)).extrude(height)


def polygon_solid(polygon, dimensions, rotation_deg=0):
    """One footprint polygon in local meters (x right, y toward the selection's bottom edge), base at z = 0."""
    total = dimensions["height_m"]-dimensions["min_height_m"]
    roof, shape = min(dimensions["roof_height_m"], total), dimensions["roof_shape"]
    if shape == "flat" or roof <= 0:
        return prism(polygon, total)
    walls = total-roof
    corners = np.asarray(polygon.minimum_rotated_rectangle.exterior.coords[:4])
    edges = [corners[1]-corners[0], corners[2]-corners[1]]
    lengths = [float(np.hypot(*edge)) for edge in edges]
    if min(lengths) <= 0:
        return prism(polygon, total)
    long_axis = int(lengths[1] > lengths[0])
    center = corners.mean(axis=0)
    if shape == "skillion":
        if "roof_direction_deg" in dimensions:  # compass bearing of the downward slope, in the rotated selection
            bearing = math.radians(dimensions["roof_direction_deg"]-rotation_deg)
            down = np.array([math.sin(bearing), -math.cos(bearing)])
        else:
            down = edges[1-long_axis]/lengths[1-long_axis]
        along = np.asarray(polygon.exterior.coords) @ down
        slope = roof/max(float(np.ptp(along)), 1e-9)
        # Keep everything beneath a plane that reaches full height on the uphill edge.
        normal = np.array([-slope*down[0], -slope*down[1], -1])
        length = float(np.linalg.norm(normal))
        return prism(polygon, total).trim_by_plane(tuple(normal/length), -(walls+roof+slope*float(along.min()))/length)
    ridge = long_axis if not dimensions.get("roof_across") else 1-long_axis
    angle = math.atan2(edges[ridge][1], edges[ridge][0])
    cosine, sine = math.cos(angle), math.sin(angle)
    # Rotate the ridge onto the x axis through the origin; extrusion scaling then pulls the eaves onto it.
    local = affine_transform(polygon, [cosine, sine, -sine, cosine,
                                       -(cosine*center[0]+sine*center[1]), sine*center[0]-cosine*center[1]])
    length, width = lengths[ridge], lengths[1-ridge]
    scale = (0, 0) if shape == "pyramidal" else (max(0, length-width)/length, 0) if shape == "hipped" else (1, 0)
    top = mf.CrossSection(contours(local)).extrude(roof, scale_top=scale)
    top = top.rotate((0, 0, math.degrees(angle))).translate((center[0], center[1], walls))
    return top+prism(polygon, walls) if walls > 1e-6 else top


def building_mesh(geometry, dimensions, width_m, height_m, rotation_deg=0):
    """Closed mesh for a footprint in selection fractions: flat [u, v, meters above ground] and triangle indices."""
    solids = []
    for polygon in (geometry.geoms if hasattr(geometry, "geoms") else [geometry]):
        if not isinstance(polygon, Polygon) or polygon.is_empty:
            continue
        polygon = make_valid(affine_transform(polygon, [width_m, 0, 0, height_m, 0, 0]))
        for piece in (polygon.geoms if hasattr(polygon, "geoms") else [polygon]):
            if not isinstance(piece, Polygon) or piece.area < .01:
                continue
            solid = polygon_solid(piece, dimensions, rotation_deg)
            if solid.status() != mf.Error.NoError or solid.is_empty():
                solid = prism(piece, dimensions["height_m"]-dimensions["min_height_m"])
            solids.append(solid)
    if not solids:
        return None
    solid = mf.Manifold.batch_boolean(solids, mf.OpType.Add) if len(solids) > 1 else solids[0]
    solid = solid.translate((0, 0, dimensions["min_height_m"]))
    frame = mf.Manifold.cube((width_m, height_m, 2000)).translate((0, 0, -1000))
    solid = solid ^ frame
    if solid.status() != mf.Error.NoError or solid.is_empty():
        return None
    mesh = solid.to_mesh()
    positions = np.asarray(mesh.vert_properties, dtype=np.float64)[:, :3]/(width_m, height_m, 1)
    positions[:, :2] = np.clip(positions[:, :2], 0, 1)
    return {"positions": positions.round(8).ravel().tolist(), "indices": np.asarray(mesh.tri_verts).ravel().tolist()}
