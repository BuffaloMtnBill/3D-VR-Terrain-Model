"""Silhouette pieces: one elevation-profile slice cut as a flat ridgeline piece with a caption and an optional mount.

The piece is drawn in millimeters with x from 0 at its left end and y up from its flat bottom; exports lay it flat
on the bed with its front face up (z = thickness), so engraved and raised text print without supports.
"""
from dataclasses import asdict, dataclass
from io import BytesIO
import json
import math
from xml.sax.saxutils import escape, quoteattr

import manifold3d as mf
import numpy as np
from shapely import make_valid
from shapely.affinity import translate
from shapely.geometry import LineString, Point, Polygon, box
from shapely.geometry.polygon import orient
from shapely.ops import unary_union

from .addons import HEX, finite, text_shape
from .elevation import SOURCES
from .features import parts as geometry_parts
from .mesh import ModelOptions, binary_stl, model_elevations, relief_method
from .printing import model_xml, package_3mf

BED_MM = 256  # the common printer bed the size hint is measured against
WALL = 1.2  # mm of material kept around wall holes and engraved or stencil text
STAND_SLOT_DEPTH, STAND_FLOOR, STAND_GAP, CLEARANCE = 4.0, 2.0, 6.0, .2
KEYHOLE_HEAD, KEYHOLE_SLOT, KEYHOLE_TRAVEL = 7.6, 3.8, 6.0  # mm: a screw head passes the head, its shank rests in the slot
FORMATS = {"stl": ("model/stl", "silhouette.stl"), "3mf": ("model/3mf", "silhouette.3mf"),
           "svg": ("image/svg+xml", "silhouette.svg"), "json": ("application/json", "silhouette-settings.json")}
TEXT_STYLES = ("engrave", "emboss", "stencil")
MOUNTS = ("none", "stand", "holes", "keyholes")


@dataclass(frozen=True)
class SilhouetteOptions:
    direction: str = "ew"  # ew: along grid rows (left → right); ns: along columns (top → bottom)
    position: float = 50.0  # percent across the frame, as the geography selection page's profile slider
    trim: tuple = (0.0, 100.0)  # percent of the slice printed
    width_mm: float = 180.0  # length of the piece; the trimmed slice fills it
    vertical_scale: float = 2.0  # × true proportions at that width
    base_mm: float = 8.0  # solid strip under the lowest point
    smoothing: float = 0.0  # percent
    source: str = "true"  # true elevations, or "shaped" by the model's elevation profile
    relief: str = "standard"
    relief_strength: float = 50.0
    mirror: bool = False
    thickness_mm: float = 4.0
    text: str = ""
    text_size: float = 5.0  # cap height, mm
    text_style: str = "engrave"
    text_align: str = "center"
    text_depth: float = .8
    mount: str = "none"
    hole_diameter: float = 4.0
    body_color: str = "#234e40"
    text_color: str = "#f0ead6"

    @classmethod
    def from_dict(cls, value):
        if not isinstance(value, dict):
            raise ValueError("Supply the silhouette settings as an object.")
        defaults, numbers = cls(), {}
        limits = {"position": (0, 100, "The slice position must be between 0 and 100 percent."),
                  "width_mm": (40, 400, "The piece width must be between 40 and 400 mm."),
                  "vertical_scale": (.5, 10, "The vertical scale must be between 0.5 and 10 times."),
                  "base_mm": (2, 40, "The base height must be between 2 and 40 mm."),
                  "smoothing": (0, 100, "Smoothing must be between 0 and 100 percent."),
                  "relief_strength": (0, 100, "The elevation profile strength must be between 0 and 100 percent."),
                  "thickness_mm": (1.2, 30, "The thickness must be between 1.2 and 30 mm."),
                  "text_size": (2, 30, "The text size must be between 2 and 30 mm."),
                  "text_depth": (.2, 5, "The text depth must be between 0.2 and 5 mm."),
                  "hole_diameter": (2, 10, "The wall hole diameter must be between 2 and 10 mm.")}
        for name, (low, high, message) in limits.items():
            number = value.get(name, getattr(defaults, name))
            if not finite(number) or not low <= number <= high:
                raise ValueError(message)
            numbers[name] = float(number)
        choices = {"direction": (("ew", "ns"), "Choose ew (left to right) or ns (top to bottom) as the slice direction."),
                   "source": (("true", "shaped"), "Choose true or shaped as the profile source."),
                   "text_style": (TEXT_STYLES, "Choose engrave, emboss, or stencil as the text style."),
                   "text_align": (("left", "center", "right"), "Choose left, center, or right as the text position."),
                   "mount": (MOUNTS, "Choose none, stand, holes, or keyholes as the mount.")}
        picked = {}
        for name, (allowed, message) in choices.items():
            picked[name] = value.get(name, getattr(defaults, name))
            if picked[name] not in allowed:
                raise ValueError(message)
        trim = value.get("trim", [0, 100])
        if (not isinstance(trim, (list, tuple)) or len(trim) != 2 or not all(finite(item) for item in trim)
                or not 0 <= trim[0] < trim[1] <= 100):
            raise ValueError("Trim must be a start and an end percentage between 0 and 100, the start before the end.")
        if trim[1]-trim[0] < 5:
            raise ValueError("Trim must keep at least 5 percent of the slice.")
        mirror = value.get("mirror", False)
        if not isinstance(mirror, bool):
            raise ValueError("Mirror must be true or false.")
        text = value.get("text", "")
        if not isinstance(text, str) or len(text) > 60 or "\n" in text:
            raise ValueError("The text must be one line of at most 60 characters.")
        colors = {}
        for name in ("body_color", "text_color"):
            color = value.get(name, getattr(defaults, name))
            if not isinstance(color, str) or not HEX.fullmatch(color):
                raise ValueError(f"Choose a six-digit hex color for the {name.split('_')[0]}.")
            colors[name] = color.lower()
        options = cls(**numbers, **picked, **colors, trim=(float(trim[0]), float(trim[1])), mirror=mirror, text=text.strip(),
                      relief=relief_method(value.get("relief", "standard")))
        if options.text and options.text_style == "engrave" and options.text_depth > options.thickness_mm-.4:
            raise ValueError("Engraved text must leave at least 0.4 mm behind it. Make the text shallower or the piece thicker.")
        return options


# --- Profile ----------------------------------------------------------------------------------------------

def slice_heights(terrain, options):
    """Heights (m) along the slice and their distances (m), sampled exactly as the geography page's profile chart."""
    heights = (terrain.elevations.astype(np.float64) if options.source == "true"
               else model_elevations(terrain, ModelOptions(relief=options.relief, relief_strength=options.relief_strength)))
    rows, columns = heights.shape
    horizontal = options.direction == "ew"
    last = rows-1 if horizontal else columns-1
    cross = options.position/100*last
    a = math.floor(cross)
    b, mix = min(a+1, last), cross-a
    values = heights[a]*(1-mix)+heights[b]*mix if horizontal else heights[:, a]*(1-mix)+heights[:, b]*mix
    length = terrain.width if horizontal else terrain.height
    return np.linspace(0, length, len(values)), values, length


def profile_points(terrain, options):
    """The ridgeline in mm, left to right: the trimmed slice fills width_mm; its lowest point sits on the base.

    Trim endpoints are interpolated, so the piece starts and ends exactly where asked. Smoothing is a moving
    average over up to 8% of the samples on each side, then a Douglas–Peucker simplification whose tolerance
    grows with it (a tiny one at 0% drops collinear points on flat ground)."""
    distances, values, length = slice_heights(terrain, options)
    start, end = options.trim[0]/100*length, options.trim[1]/100*length
    along = np.concatenate(([start], distances[(distances > start) & (distances < end)], [end]))
    heights = np.interp(along, distances, values)
    radius = round(options.smoothing/100*len(heights)*.08)
    if radius:
        padded = np.pad(heights, radius, mode="edge")
        heights = np.convolve(padded, np.ones(2*radius+1)/(2*radius+1), mode="valid")
    scale = options.width_mm/(end-start)
    x = (along-start)*scale
    y = (heights-heights.min())*scale*options.vertical_scale+options.base_mm
    if options.mirror:
        x, y = options.width_mm-x[::-1], y[::-1]
    line = LineString(np.column_stack((x, y))).simplify(.005+options.smoothing/100*.6, preserve_topology=False)
    return np.asarray(line.coords), end-start


# --- 2D layout --------------------------------------------------------------------------------------------

def foot_length(options):
    return min(20.0, .3*options.width_mm)


def stand_feet(options):
    """Two feet under the piece, at a fifth of its width from each end: (x0, x1) in mm along it."""
    length = foot_length(options)
    return [(center-length/2, center+length/2) for center in (.2*options.width_mm, .8*options.width_mm)]


def mount_shapes(options, height):
    """Wall holes (2D, cut through the piece) for the holes and keyholes mounts."""
    inset = max(8.0, .1*options.width_mm)
    if options.mount == "holes":
        radius = options.hole_diameter/2
        return [Point(x, max(options.base_mm/2, radius+WALL)).buffer(radius, quad_segs=12) for x in (inset, options.width_mm-inset)]
    if options.mount == "keyholes":
        y = KEYHOLE_HEAD/2+WALL+.4
        return [unary_union([Point(x, y).buffer(KEYHOLE_HEAD/2, quad_segs=12), Point(x, y+KEYHOLE_TRAVEL).buffer(KEYHOLE_SLOT/2, quad_segs=8),
                             box(x-KEYHOLE_SLOT/2, y, x+KEYHOLE_SLOT/2, y+KEYHOLE_TRAVEL)]) for x in (inset, options.width_mm-inset)]
    return []


def text_margin(options):
    """How far text keeps from the ends: clear of wall holes and stand feet."""
    if options.mount in ("holes", "keyholes"):
        size = options.hole_diameter if options.mount == "holes" else KEYHOLE_HEAD
        return max(8.0, .1*options.width_mm)+size/2+2
    if options.mount == "stand":
        return stand_feet(options)[0][1]+2
    return 3.0


def stencil_bridges(shape, size):
    """Thin vertical bars through each counter (the inside of O, A, e…), so stencil letters keep their islands attached."""
    width = max(.6, size*.12)
    bars = []
    for polygon in geometry_parts(shape, "Polygon"):
        _, y0, _, y1 = polygon.bounds
        for ring in polygon.interiors:
            x = Polygon(ring).centroid.x
            bars.append(box(x-width/2, y0-1, x+width/2, y1+1))
    return shape.difference(unary_union(bars)) if bars else shape


def layout(terrain, options):
    """Everything drawn or cut in 2D: the body (with wall holes and stencil cuts), the text, mount marks, and warnings."""
    points, span_m = profile_points(terrain, options)
    width, height = options.width_mm, float(points[:, 1].max())
    outline = orient(make_valid(Polygon([(0, 0), *points.tolist(), (width, 0)])).buffer(0))
    warnings, mounts = [], []
    holes = mount_shapes(options, height)
    if holes:
        if all(outline.buffer(-WALL).contains(hole) for hole in holes):
            outline = outline.difference(unary_union(holes))
            mounts = [{"kind": "hole" if options.mount == "holes" else "keyhole", "x": round(hole.centroid.x, 3), "y": round(hole.bounds[1], 3)}
                      for hole in holes]
        else:
            need = max(hole.bounds[3] for hole in holes)+WALL
            warnings.append(f"The wall holes do not fit inside the piece, so they are left out. Raise the base to at least {math.ceil(need)} mm.")
    elif options.mount == "stand":
        mounts = [{"kind": "foot", "x0": round(x0, 3), "x1": round(x1, 3), "y0": -STAND_FLOOR, "y1": STAND_SLOT_DEPTH} for x0, x1 in stand_feet(options)]
    text = Polygon()
    if options.text:
        shape, missing = text_shape(options.text, options.text_size)
        if missing:
            warnings.append(f"The font cannot draw {''.join(missing)}; those characters are left as spaces.")
        if not shape.is_empty:
            x0, y0, x1, y1 = shape.bounds
            margin = text_margin(options)
            x = {"left": margin+(x1-x0)/2, "center": width/2, "right": width-margin-(x1-x0)/2}[options.text_align]
            placed = translate(shape, x, options.base_mm/2)
            if options.text_style == "stencil":
                placed = stencil_bridges(placed, options.text_size)
            room = outline.buffer(-WALL) if options.text_style != "emboss" else outline
            text = make_valid(placed.intersection(room))
            if text.area < placed.area*.98:
                warnings.append("The text runs past the edge of the piece and is trimmed. Make it smaller or the base taller.")
            if x1-x0 > width-2*margin:
                warnings.append("The text is wider than the space between the mounts. Shorten it or make it smaller.")
            if options.text_size < 3:
                warnings.append("Text under 3 mm tall may not print clearly. Make it larger.")
    body = outline.difference(text) if options.text_style == "stencil" and not text.is_empty else outline
    if len(geometry_parts(body, "Polygon")) > 1:
        warnings.append("The stencil text splits the piece into separate parts. Move or shrink the text.")
    lowest = float(points[:, 1].min())
    if lowest < 3:
        warnings.append(f"The thinnest point of the piece is {lowest:.1f} mm tall and may snap. Raise the base.")
    if max(width, height) > BED_MM:
        warnings.append(f"The piece is {width:.0f} × {height:.0f} mm, larger than a {BED_MM} mm printer bed. Make it narrower or lower the vertical scale.")
    if options.mount == "stand" and options.thickness_mm < 2.4:
        warnings.append("A piece thinner than 2.4 mm may wobble in its stand. Make it thicker.")
    return {"body": body, "outline": outline, "text": text, "points": points, "mounts": mounts, "warnings": warnings,
            "width": width, "height": height, "lowest": lowest, "span_m": span_m}


def rings(geometry):
    return [{"outer": np.round(polygon.exterior.coords, 3).tolist(), "holes": [np.round(ring.coords, 3).tolist() for ring in polygon.interiors]}
            for polygon in geometry_parts(geometry, "Polygon")]


def outline_json(terrain, options):
    """The client preview: outline, text, and mount marks in mm (y up, x from 0 at the left), plus size and hints."""
    shapes = layout(terrain, options)
    outline = rings(shapes["outline"])
    return {"outline": max(outline, key=lambda ring: Polygon(ring["outer"]).area) if outline else {"outer": [], "holes": []},
            "text": rings(shapes["text"]), "text_style": options.text_style, "mount": shapes["mounts"],
            "width_mm": round(shapes["width"], 3), "height_mm": round(shapes["height"], 3), "thickness_mm": options.thickness_mm,
            "min_profile_mm": round(shapes["lowest"], 3), "slice_length_m": round(shapes["span_m"], 2),
            "points": len(shapes["points"]), "warnings": shapes["warnings"]}


# --- Solids -----------------------------------------------------------------------------------------------

def closed(solid):
    if solid.status() != mf.Error.NoError:
        raise ValueError("The silhouette could not form a closed solid. Change the text or smoothing and try again.")
    return solid


def extrude(geometry, height, bottom=0.0):
    contours = []
    for polygon in geometry_parts(make_valid(geometry), "Polygon"):
        polygon = orient(polygon)
        contours.append(np.asarray(polygon.exterior.coords[:-1], dtype=np.float64))
        contours.extend(np.asarray(ring.coords[:-1], dtype=np.float64) for ring in polygon.interiors)
    if not contours:
        return mf.Manifold()
    return closed(mf.CrossSection(contours).extrude(height).translate((0, 0, bottom)))


def foot(options, x, y, depth):
    """One stand foot, flat on the bed: a block with a slot open along its length, the piece's thickness plus clearance wide."""
    length, height, slot = foot_length(options), STAND_FLOOR+STAND_SLOT_DEPTH, options.thickness_mm+CLEARANCE
    block = mf.Manifold.cube((length, depth, height)).translate((x, y, 0))
    cutter = mf.Manifold.cube((length+2, slot, STAND_SLOT_DEPTH+1)).translate((x-1, y+depth/2-slot/2, STAND_FLOOR))
    return closed(block-cutter)


def solids(terrain, options, shapes=None):
    """Named parts in print position (front face up): the body, the text when it is a separate color, and stand feet."""
    shapes = shapes or layout(terrain, options)
    thickness, text, depth = options.thickness_mm, shapes["text"], options.text_depth
    body = extrude(shapes["body"], thickness)
    parts = []
    if not text.is_empty and options.text_style == "engrave":
        body = closed(body-extrude(text, depth+1, thickness-depth))
        parts.append(("Text", options.text_color, extrude(text, depth, thickness-depth)))
    elif not text.is_empty and options.text_style == "emboss":
        parts.append(("Text", options.text_color, extrude(text, depth, thickness)))
    parts.insert(0, ("Silhouette", options.body_color, body))
    if options.mount == "stand":
        reach = float(np.clip(shapes["height"]*.5, 30, 90))
        feet = [foot(options, index*(foot_length(options)+STAND_GAP), -STAND_GAP-reach, reach) for index in range(2)]
        parts.append(("Stand feet", options.body_color, closed(mf.Manifold.batch_boolean(feet, mf.OpType.Add))))
    return parts


def mesh(solid):
    result = solid.to_mesh64()
    return np.asarray(result.vert_properties)[:, :3].astype(np.float64), np.asarray(result.tri_verts).astype(np.int64)


# --- Files ------------------------------------------------------------------------------------------------

def metadata(terrain, options, shapes):
    return {"kind": "silhouette", "settings": asdict(options) | {"trim": list(options.trim)},
            "size_mm": {"width": round(shapes["width"], 3), "height": round(shapes["height"], 3), "thickness": options.thickness_mm},
            "slice_length_m": round(float(shapes["span_m"]), 2), "bounds": terrain.bounds.to_dict(), "source": SOURCES[terrain.source]["short"],
            "units": "mm", "axes": "x along the piece, y up the piece, z out of its front face (printed front face up)"}


def svg_path(geometry, height):
    commands = []
    for polygon in geometry_parts(geometry, "Polygon"):
        for ring in (polygon.exterior, *polygon.interiors):
            coords = np.asarray(ring.coords)[:-1]
            commands.append("M" + " L".join(f"{x:.3f} {height-y:.3f}" for x, y in coords) + " Z")
    return " ".join(commands)


def svg_file(options, shapes, attribution):
    """A 2D drawing in millimeters for laser cutting or vinyl: outline with wall holes, then the text as its own paths."""
    width, height = shapes["width"], shapes["height"]
    cut = 'fill="none" stroke="#ff0000" stroke-width="0.1"'
    text_style = cut if options.text_style == "stencil" else f'fill="{options.text_color}" stroke="none"'
    output = ['<?xml version="1.0" encoding="UTF-8"?>',
              f'<svg xmlns="http://www.w3.org/2000/svg" width="{width:.3f}mm" height="{height:.3f}mm" viewBox="0 0 {width:.3f} {height:.3f}">',
              f"<title>Terrain Studio silhouette</title><desc>{escape(attribution.splitlines()[0] if attribution else '')}</desc>",
              f'<path id="outline" fill-rule="evenodd" fill="{options.body_color}" stroke="#ff0000" stroke-width="0.1" d="{svg_path(shapes["outline"], height)}"/>']
    if not shapes["text"].is_empty:
        output.append(f'<g id="text" data-style={quoteattr(options.text_style)}><path fill-rule="evenodd" {text_style} d="{svg_path(shapes["text"], height)}"/></g>')
    output.append("</svg>")
    return "\n".join(output).encode("utf-8")


def silhouette_export(terrain, options, format, attribution):
    """Return (bytes, mimetype, filename) for one silhouette file."""
    if format not in FORMATS:
        raise ValueError("Choose stl, 3mf, svg, or json as the silhouette export format.")
    shapes = layout(terrain, options)
    info = metadata(terrain, options, shapes)
    if format == "svg":
        content = svg_file(options, shapes, attribution)
    elif format == "json":
        content = json.dumps(info | {"warnings": shapes["warnings"], "attribution": attribution}, indent=2).encode()
    else:
        parts = solids(terrain, options, shapes)
        if format == "stl":
            # STL has no colors: raised text joins the body, engraved text stays a cavity, and the feet lie beside it.
            solids_ = [solid for name, _, solid in parts if not (name == "Text" and options.text_style == "engrave")]
            vertices, faces = mesh(closed(mf.Manifold.batch_boolean(solids_, mf.OpType.Add)) if len(solids_) > 1 else solids_[0])
            content = binary_stl(vertices, faces, SOURCES[terrain.source]["short"])
        else:
            colored = [{"name": name, "color": color, **dict(zip(("vertices", "faces"), mesh(solid)))} for name, color, solid in parts]
            content = package_3mf(model_xml(colored, info, attribution, title="Terrain Studio silhouette")).getvalue()
    mimetype, filename = FORMATS[format]
    return content, mimetype, filename
