"""Print Studio add-ons: parametric holes, pockets, plaques, and text cut into or added onto a terrain print.

Placement uses normalized model coordinates (u left→right, v top→bottom, as map features do); sizes are
millimeters of the exported model, whose x/y origin is its center and whose floor is z = 0.
"""
from functools import lru_cache
import json
import math
from pathlib import Path
import re
from threading import Lock

import manifold3d as mf
import numpy as np
from shapely import contains_xy, get_coordinates, line_interpolate_point, make_valid
from shapely.affinity import rotate, scale, translate
from shapely.geometry import MultiPolygon, Point, Polygon, box
from shapely.geometry.polygon import orient
from shapely.ops import unary_union

from .features import parts as geometry_parts
from .mesh import build_mesh
from .print_features import clean_collinear_faces, extrude, footprint as feature_footprint, from_mesh, grid_window, surface_heights

DATA = Path(__file__).parent / "data"
FONT_PATH = DATA / "fonts" / "DejaVuSans-Bold.ttf"
FONT_NAME = "DejaVu Sans Bold"
# Text styles for the silhouette page's text blocks (the 3D design page's add-ons stay bold); all DejaVu Sans.
FONT_FILES = {"bold": "DejaVuSans-Bold.ttf", "regular": "DejaVuSans.ttf", "italic": "DejaVuSans-Oblique.ttf", "bold-italic": "DejaVuSans-BoldOblique.ttf"}
FONT_STYLES = tuple(FONT_FILES)
BALL_PATH = DATA / "templates" / "marker-ball.stl"
BALL_INFO = json.loads((DATA / "templates" / "marker-ball.json").read_text(encoding="utf-8"))
BALL_COLOR = "#c0392b"
BALL_GAP = 4.0  # mm between the model and marker balls laid out beside it
PLATFORM_PATH = DATA / "templates" / "marker-platform.stl"
PLATFORM_INFO = json.loads((DATA / "templates" / "marker-platform.json").read_text(encoding="utf-8"))
MARKER_STYLES = {"ball": "Ball", "platform": "Platform"}
PLATFORM_TOPS = {"none": "Nothing", "terrain": "Terrain around the marker", "building": "Building at the marker"}
TOP_BASE = 1.2  # mm of solid under a terrain top
TOP_MARGIN = 1.5  # mm between a building top and the deck edge
TOP_MIN_HEIGHT = 4.0  # mm: the lowest building printed on a platform
BUILDING_REACH_M = 15  # a building this close to the nail counts as "at" the marker
TERRAIN_COLOR = "#827254"  # the single terrain material outside the Print palette
MAX_ADDONS = 40
MIN_FLOOR, SAFE_FLOOR = .8, 1.6  # mm of material left under a cut: error below, warning below
MIN_WALL = 1.6
FILL_BOND = .6  # mm that added material reaches below the surface it sits on
SHAPE, FILL, CUT = 0, 1, 2  # phases: leveling cuts, then added material, then cuts through everything
HEX = re.compile(r"#[0-9a-fA-F]{6}")


def number(default, low, high, label, unit="mm", step=None, integer=False):
    spec = {"type": "integer" if integer else "number", "default": default, "min": low, "max": high, "label": label}
    if unit:
        spec["unit"] = unit
    if step:
        spec["step"] = step
    return spec


def choice(default, choices, label):
    choices = dict(choices)
    return {"type": "choice", "default": default, "choices": list(choices), "choice_labels": choices, "label": label}


def text(default, label, max_length=60, max_lines=2, required=False):
    return {"type": "text", "default": default, "max_length": max_length, "max_lines": max_lines, "required": required, "label": label}


SHAPES = {"rect": "Rectangle", "rounded": "Rounded rectangle", "oval": "Oval"}
STYLES = {"emboss": "Raised (emboss)", "deboss": "Engraved (deboss)"}
NAIL_DEPTH = float(BALL_INFO["exposed_nail_length"])
NAIL_HOLE = float(BALL_INFO["recommended_hole_diameter"])

TYPES = {
    "hole": {"label": "Hole", "kind": "cut",
             "help": "A round hole straight down from the surface at its center. The chamfer softens the rim.",
             "params": {"diameter": number(5, .5, 30, "Diameter", step=.1), "depth": number(8, .5, 200, "Depth", step=.5),
                        "chamfer": number(.4, 0, 3, "Chamfer", step=.1)}},
    "nail_marker": {"label": "Nail marker", "kind": "cut",
                    "help": "A snug hole for the brass nail of the bundled marker ball. The default depth is the nail's exposed length, so the ball sits on the surface.",
                    "params": {"hole_diameter": number(NAIL_HOLE, 1, 4, "Hole diameter", step=.05), "depth": number(NAIL_DEPTH, 1, 60, "Depth", step=.1)}},
    "pencil_holder": {"label": "Pencil holder", "kind": "cut",
                      "help": "A row of round holes along the add-on's width, measured from the surface above each hole. Tilt leans them toward the add-on's back.",
                      "params": {"diameter": number(10, 4, 30, "Diameter", step=.5), "depth": number(40, 5, 200, "Depth"),
                                 "count": number(1, 1, 12, "Holes", unit=None, integer=True), "spacing": number(14, 4, 100, "Spacing", step=.5),
                                 "tilt_deg": number(0, 0, 30, "Tilt", unit="°")}},
    "photo_slot": {"label": "Photo slot", "kind": "cut",
                   "help": "A narrow slot that holds a photo or card, leaning back by the lean angle.",
                   "params": {"width": number(60, 5, 250, "Width"), "gap": number(1.2, .4, 6, "Gap", step=.1),
                              "depth": number(12, 2, 80, "Depth"), "lean_deg": number(10, 0, 30, "Lean", unit="°")}},
    "pocket": {"label": "Pocket", "kind": "cut",
               "help": "A flat-floored tray. Its depth is measured from the lowest surface point inside it, so the whole floor is recessed.",
               "params": {"shape": choice("rounded", SHAPES.items(), "Shape"), "width": number(40, 2, 250, "Width"),
                          "length": number(25, 2, 250, "Length"), "depth": number(6, .5, 100, "Depth", step=.5),
                          "corner_radius": number(4, 0, 50, "Corner radius", step=.5)}},
    "coaster": {"label": "Coaster recess", "kind": "cut",
                "help": "A round flat-floored recess, measured from the lowest surface point inside it.",
                "params": {"diameter": number(95, 20, 200, "Diameter"), "depth": number(3, .5, 20, "Depth", step=.5)}},
    "groove": {"label": "Stand groove", "kind": "cut",
               "help": "A straight groove that holds a tile, sign, or phone; its walls lean back by the angle.",
               "params": {"length": number(80, 5, 250, "Length"), "width": number(12, 1, 50, "Width", step=.5),
                          "depth": number(8, 1, 80, "Depth", step=.5), "angle_deg": number(15, 0, 40, "Lean", unit="°")}},
    "magnet": {"label": "Magnet pocket", "kind": "underside",
               "help": "A round pocket in the underside for a press-fit or glued magnet.",
               "params": {"diameter": number(6.2, 1, 40, "Diameter", step=.1), "depth": number(3.2, .5, 20, "Depth", step=.1)}},
    "hanging": {"label": "Wall hanger", "kind": "underside",
                "help": "A keyhole slot (or a plain hole) in the underside for hanging the print on a screw or nail. The slot runs toward the add-on's back.",
                "params": {"style": choice("keyhole", {"keyhole": "Keyhole slot", "hole": "Plain hole"}.items(), "Style"),
                           "head_diameter": number(8, 3, 20, "Head diameter", step=.5), "shank_diameter": number(4, 1, 15, "Shank diameter", step=.5),
                           "slot_length": number(10, 0, 40, "Slot length"), "depth": number(5, 1, 30, "Depth", step=.5)}},
    "plaque": {"label": "Plaque", "kind": "mixed",
               "help": "A level pad for a name or date. Flatten cuts down to the lowest point, Level cuts and fills to the mean height, Raise builds a pad above the highest point.",
               "params": {"shape": choice("rounded", SHAPES.items(), "Shape"), "width": number(60, 5, 250, "Width"),
                          "length": number(25, 5, 250, "Length"), "corner_radius": number(4, 0, 50, "Corner radius", step=.5),
                          "mode": choice("flatten", {"flatten": "Flatten", "level": "Level", "raise": "Raise"}.items(), "Mode"),
                          "raise": number(2, 0, 30, "Raise", step=.5), "text": text("", "Text"),
                          "text_size": number(6, 2, 40, "Text size", step=.5), "text_style": choice("deboss", STYLES.items(), "Text style"),
                          "text_depth": number(.8, .2, 5, "Text depth", step=.1)}},
    "text": {"label": "Text", "kind": "mixed",
             "help": "Raised or engraved lettering. Follow sets each letter's height from the terrain under it; Flat sets one height for all letters.",
             "params": {"text": text("Text", "Text", max_lines=3, required=True), "text_size": number(6, 2, 40, "Text size", step=.5),
                        "text_style": choice("emboss", STYLES.items(), "Style"), "text_depth": number(1, .2, 10, "Depth", step=.1),
                        "base": choice("follow", {"follow": "Follow terrain", "flat": "Flat"}.items(), "Base")}},
}


def catalog():
    """Add-on types and parameters for the client, which builds its forms from this description."""
    return {"types": TYPES, "order": list(TYPES), "marker_ball": BALL_INFO, "marker_platform": PLATFORM_INFO,
            "marker_styles": MARKER_STYLES, "platform_tops": PLATFORM_TOPS, "font": FONT_NAME, "max_addons": MAX_ADDONS}


def finite(value):
    return not isinstance(value, bool) and isinstance(value, (int, float)) and math.isfinite(value)


def hex_color(value, message):
    if not isinstance(value, str) or not HEX.fullmatch(value):
        raise ValueError(message)
    return value.lower()


def param_value(spec, value, label, name):
    title = f"{label}: {spec['label'].lower()}"
    if spec["type"] in ("number", "integer"):
        if not finite(value) or (spec["type"] == "integer" and value != int(value)):
            raise ValueError(f"{title} must be a {'whole ' if spec['type'] == 'integer' else ''}number.")
        if not spec["min"] <= value <= spec["max"]:
            raise ValueError(f"{title} must be between {spec['min']:g} and {spec['max']:g}{' '+spec['unit'] if spec.get('unit') and spec['unit'] != '°' else spec.get('unit', '')}.")
        return int(value) if spec["type"] == "integer" else float(value)
    if spec["type"] == "choice":
        if value not in spec["choices"]:
            raise ValueError(f"{title} must be one of: {', '.join(spec['choices'])}.")
        return value
    if not isinstance(value, str) or len(value) > spec["max_length"]:
        raise ValueError(f"{title} must be text of at most {spec['max_length']} characters.")
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    if any(ord(character) < 32 and character != "\n" for character in value):
        raise ValueError(f"{title} cannot contain control characters.")
    if value.count("\n") >= spec["max_lines"]:
        raise ValueError(f"{title} can have at most {spec['max_lines']} lines.")
    if spec["required"] and not value.strip():
        raise ValueError(f"{label}: enter the text to print.")
    return value


def addon_options(value, index):
    if not isinstance(value, dict):
        raise ValueError("Each add-on must be an object.")
    kind = value.get("type")
    if kind not in TYPES:
        raise ValueError(f"Add-on {index+1} has an unknown type. Choose one of: {', '.join(TYPES)}.")
    label = TYPES[kind]["label"]
    identifier = value.get("id", f"addon-{index+1}")
    if not isinstance(identifier, str) or not 1 <= len(identifier) <= 64:
        raise ValueError(f"{label}: add-on ids must be text of 1 to 64 characters.")
    u, v, angle = value.get("u"), value.get("v"), value.get("rotation_deg", 0)
    if not finite(u) or not finite(v) or not 0 <= u <= 1 or not 0 <= v <= 1:
        raise ValueError(f"{label}: place the add-on on the model (u and v must be between 0 and 1).")
    if not finite(angle):
        raise ValueError(f"{label}: rotation must be a number of degrees.")
    params = value.get("params") or {}
    if not isinstance(params, dict):
        raise ValueError(f"{label}: parameters must be an object.")
    # Unknown parameter names are ignored so that older servers accept newer projects' extras.
    result = {name: param_value(spec, params.get(name, spec["default"]), label, name) for name, spec in TYPES[kind]["params"].items()}
    color = value.get("color")
    if color is not None:
        color = hex_color(color, f"{label}: choose a six-digit hex color or none.")
    visible = value.get("visible", True)
    if not isinstance(visible, bool):
        raise ValueError(f"{label}: visible must be true or false.")
    return {"id": identifier, "type": kind, "u": float(u), "v": float(v), "rotation_deg": float(angle) % 360,
            "params": result, "color": color, "visible": visible}


def project_options(value):
    """Validate a Print Studio project; None means print the model as is."""
    if value is None:
        return None
    if not isinstance(value, dict):
        raise ValueError("The print project must be an object.")
    if value.get("version", 1) != 1:
        raise ValueError("This print project was saved by a newer version of Terrain Studio.")
    name = value.get("name", "Untitled project")
    if not isinstance(name, str) or len(name) > 80:
        raise ValueError("Project names must be text of at most 80 characters.")
    addons = value.get("addons", [])
    if not isinstance(addons, list):
        raise ValueError("Project add-ons must be a list.")
    if len(addons) > MAX_ADDONS:
        raise ValueError(f"A project can hold at most {MAX_ADDONS} add-ons.")
    addons = [addon_options(addon, index) for index, addon in enumerate(addons)]
    if len({addon["id"] for addon in addons}) != len(addons):
        raise ValueError("Each add-on in a project needs a different id.")
    return {"version": 1, "name": name, "addons": addons, "marker_balls": marker_options(value.get("marker_balls"))}


def marker_options(value):
    """What goes on each nail: a ball, or a platform with nothing, terrain, or a building on top.

    Older projects send only include and color; they get balls as before."""
    value = value or {}
    if not isinstance(value, dict) or not isinstance(value.get("include", False), bool):
        raise ValueError("Marker ball settings must say whether to include them (true or false).")
    color = hex_color(value.get("color") or BALL_COLOR, "Choose a six-digit hex color for the marker balls.")
    style, top = value.get("style", "ball"), value.get("top", "none")
    if style not in MARKER_STYLES:
        raise ValueError("Nail marker style must be ball or platform.")
    if top not in PLATFORM_TOPS:
        raise ValueError("A marker platform's top must be none, terrain, or building.")
    top_color = value.get("top_color")
    top_color = color if top_color is None else hex_color(top_color, "Choose a six-digit hex color for the platform tops.")
    area, exaggeration = value.get("top_area_mm", 30), value.get("top_exaggeration")
    if not finite(area) or not 10 <= area <= 80:
        raise ValueError("The area lifted onto marker platforms must be between 10 and 80 mm.")
    if exaggeration is not None and (not finite(exaggeration) or not .5 <= exaggeration <= 20):
        raise ValueError("The platform top's exaggeration must be between 0.5 and 20.")
    return {"include": value.get("include", False), "color": color, "style": style, "top": top, "top_color": top_color,
            "top_area_mm": float(area), "top_exaggeration": None if exaggeration is None else float(exaggeration)}


def active_addons(project):
    return [addon for addon in (project or {}).get("addons", []) if addon["visible"]]


def nail_markers(project):
    return [addon for addon in active_addons(project) if addon["type"] == "nail_marker"]


def ball_count(project):
    """One marker ball (or platform) per visible nail marker, when the project includes them."""
    if not project or not project["marker_balls"]["include"]:
        return 0
    return len(nail_markers(project))


marker_count = ball_count


def marker_style(project):
    return (project or {}).get("marker_balls", {}).get("style", "ball")


def marker_info(project):
    """The bundled template a project's nail markers carry: the ball's metadata or the platform's."""
    return PLATFORM_INFO if marker_style(project) == "platform" else BALL_INFO


def platform_top(project):
    """The top printed on each platform ("none" for balls)."""
    balls = (project or {}).get("marker_balls", {})
    return balls.get("top", "none") if balls.get("style") == "platform" else "none"


def changes_model(project):
    return bool(active_addons(project)) or ball_count(project) > 0


def project_metadata(project):
    return {key: project[key] for key in ("name", "addons", "marker_balls")}


# --- Text -------------------------------------------------------------------------------------------------

FONT_LOCK = Lock()  # fontTools loads tables lazily; export jobs and requests run on several threads.


@lru_cache(maxsize=4)
def font(style="bold"):
    from fontTools.ttLib import TTFont
    loaded = TTFont(DATA / "fonts" / FONT_FILES[style])
    glyphs = loaded.getGlyphSet()
    from fontTools.pens.boundsPen import BoundsPen
    pen = BoundsPen(glyphs)
    glyphs["H"].draw(pen)
    return loaded, glyphs, loaded.getBestCmap(), pen.bounds[3]


def flatten_contours(glyphs, name):
    from fontTools.pens.basePen import BasePen

    class Outline(BasePen):
        def __init__(self):
            super().__init__(glyphs)
            self.contours, self.current = [], []

        def _moveTo(self, point):
            self.current = [point]

        def _lineTo(self, point):
            self.current.append(point)

        def _qCurveToOne(self, control, point):
            start = np.asarray(self._getCurrentPoint())
            t = np.linspace(0, 1, 7)[1:, None]
            self.current.extend(map(tuple, (1-t)**2*start+2*(1-t)*t*np.asarray(control)+t**2*np.asarray(point)))

        def _curveToOne(self, first, second, point):
            start = np.asarray(self._getCurrentPoint())
            t = np.linspace(0, 1, 9)[1:, None]
            self.current.extend(map(tuple, (1-t)**3*start+3*(1-t)**2*t*np.asarray(first)+3*(1-t)*t**2*np.asarray(second)+t**3*np.asarray(point)))

        def _closePath(self):
            if len(self.current) >= 3:
                self.contours.append(self.current)
            self.current = []

        _endPath = _closePath

    pen = Outline()
    glyphs[name].draw(pen)
    return pen.contours


@lru_cache(maxsize=1024)
def glyph_shape(name, style="bold"):
    """A glyph's filled area in font units, from its contours under the even-odd rule."""
    with FONT_LOCK:
        _, glyphs, _, _ = font(style)
        contours = flatten_contours(glyphs, name)
    shape = Polygon()
    for contour in contours:
        shape = shape.symmetric_difference(make_valid(Polygon(contour)))
    return shape


@lru_cache(maxsize=256)
def text_shape(value, size):
    """Lettering with a cap height of `size` mm, lines centered, the whole block centered on 0, 0.

    Returns the shape and the characters the bundled font cannot draw."""
    with FONT_LOCK:
        loaded, _, cmap, cap = font()
        metrics = loaded["hmtx"].metrics
        space = metrics[cmap[32]][0]
    factor = size/cap
    shapes, missing = [], []
    for line_number, line in enumerate(value.split("\n")):
        cursor, line_shapes = 0, []
        for character in line:
            name = cmap.get(ord(character))
            if name is None:
                if not character.isspace():
                    missing.append(character)
                cursor += space
                continue
            glyph = glyph_shape(name)
            if not glyph.is_empty:
                line_shapes.append(translate(glyph, cursor))
            cursor += metrics[name][0]
        line_shape = unary_union(line_shapes)
        if not line_shape.is_empty:
            shapes.append(translate(line_shape, -cursor/2, -line_number*cap*1.6))
    shape = unary_union(shapes)
    if shape.is_empty:
        return shape, tuple(dict.fromkeys(missing))
    shape = scale(shape, factor, factor, origin=(0, 0))
    x0, y0, x1, y1 = shape.bounds
    return make_valid(translate(shape, -(x0+x1)/2, -(y0+y1)/2)), tuple(dict.fromkeys(missing))


@lru_cache(maxsize=256)
def line_shape(value, size, style="bold", tracking=0.0):
    """One line of lettering with a cap height of `size` mm, its baseline at y = 0 and its pen starting at x = 0; tracking
    adds that percentage of the cap height between letters (negative tightens). Returns the shape, the advance width (mm),
    and the characters the font cannot draw."""
    with FONT_LOCK:
        loaded, _, cmap, cap = font(style)
        metrics = loaded["hmtx"].metrics
        space = metrics[cmap[32]][0]
    gap, cursor, shapes, missing = tracking/100*cap, 0.0, [], []
    for index, character in enumerate(value):
        if index:
            cursor += gap
        name = cmap.get(ord(character))
        if name is None:
            if not character.isspace():
                missing.append(character)
            cursor += space
            continue
        glyph = glyph_shape(name, style)
        if not glyph.is_empty:
            shapes.append(translate(glyph, cursor))
        cursor += metrics[name][0]
    factor = size/cap
    shape = unary_union(shapes)
    shape = make_valid(scale(shape, factor, factor, origin=(0, 0))) if not shape.is_empty else shape
    return shape, cursor*factor, tuple(dict.fromkeys(missing))


def text_outline(value, size):
    """Text polygons in millimeters, centered at 0, 0, for client previews."""
    if not isinstance(value, str) or len(value) > 200:
        raise ValueError("Text must be at most 200 characters.")
    if not finite(size) or not 1 <= size <= 100:
        raise ValueError("Text size must be between 1 and 100 mm.")
    shape, missing = text_shape(value, float(size))
    polygons = [{"outer": np.round(polygon.exterior.coords, 3).tolist(),
                 "holes": [np.round(ring.coords, 3).tolist() for ring in polygon.interiors]}
                for polygon in geometry_parts(shape, "Polygon")]
    x0, y0, x1, y1 = shape.bounds if not shape.is_empty else (0, 0, 0, 0)
    return {"polygons": polygons, "width": x1-x0, "height": y1-y0, "missing": list(missing)}


# --- Marker ball ------------------------------------------------------------------------------------------

def marker_ball():
    """The bundled push-pin ball as a shared-vertex mesh: flat collar at z = 0, centered on x/y, in mm."""
    return template_mesh(BALL_PATH)


def marker_platform():
    """The bundled marker platform as a shared-vertex mesh: hub bottom at z = 0, deck on top, centered on x/y, in mm."""
    return template_mesh(PLATFORM_PATH)


def marker_mesh(project):
    return marker_platform() if marker_style(project) == "platform" else marker_ball()


@lru_cache(maxsize=4)
def template_mesh(path):
    data = path.read_bytes()
    count = int(np.frombuffer(data, "<u4", 1, 80)[0])
    records = np.frombuffer(data, [("normal", "<f4", (3,)), ("vertices", "<f4", (3, 3)), ("attribute", "<u2")], count, 84)
    vertices, faces = np.unique(np.round(records["vertices"].reshape(-1, 3).astype(np.float64), 5), axis=0, return_inverse=True)
    # A manifold round trip drops the export's degenerate slivers, leaving every edge shared by two triangles.
    mesh = closed(from_mesh(vertices, faces.reshape(-1, 3))).to_mesh64()
    return np.asarray(mesh.vert_properties)[:, :3], np.asarray(mesh.tri_verts).astype(np.int64)


def ball_positions(count, width, height, vertices=None):
    """Ball (or platform) centers in rows beside the model's +x edge, top to bottom, then further columns."""
    if vertices is None:
        vertices, _ = marker_ball()
    size_x, size_y = np.ptp(vertices[:, 0]), np.ptp(vertices[:, 1])
    per_column = max(1, int((height+BALL_GAP)//(size_y+BALL_GAP)))
    center = (vertices[:, :2].max(axis=0)+vertices[:, :2].min(axis=0))/2
    return [(width/2+BALL_GAP+size_x/2+(index//per_column)*(size_x+BALL_GAP)-center[0],
             height/2-size_y/2-(index % per_column)*(size_y+BALL_GAP)-center[1]) for index in range(count)]


# --- Geometry ---------------------------------------------------------------------------------------------

class Model:
    """The terrain solid's top surface in model millimeters, for placing and sizing add-ons."""

    def __init__(self, terrain, options, vertices=None):
        if vertices is None:
            vertices, _ = build_mesh(terrain, options)
        self.rows, self.columns = terrain.elevations.shape
        self.top = vertices[:self.rows*self.columns].reshape(self.rows, self.columns, 3)
        self.width, self.height = float(np.ptp(self.top[:, :, 0])), float(np.ptp(self.top[:, :, 1]))
        self.frame = box(-self.width/2, -self.height/2, self.width/2, self.height/2)
        self.max_z = float(self.top[:, :, 2].max())
        self.ceiling = self.max_z+60  # above anything an add-on adds (raise ≤ 30, text ≤ 10)
        self.spacing = min(self.width/(self.columns-1), self.height/(self.rows-1))
        self.options = options

    def at(self, points):
        return surface_heights(self.top, self.width, self.height, points)

    def samples(self, geometry):
        """Surface heights at grid vertices inside a footprint and densely along its edges."""
        geometry = geometry.intersection(self.frame)
        if geometry.is_empty:
            return np.zeros(0)
        window = self.top[grid_window(geometry.bounds, self.width, self.height, self.rows, self.columns)]
        inside = window[:, :, 2][contains_xy(geometry, window[:, :, 0], window[:, :, 1])]
        rings = [ring for polygon in geometry_parts(geometry, "Polygon") for ring in (polygon.exterior, *polygon.interiors)]
        edges = [get_coordinates(line_interpolate_point(ring, np.linspace(0, ring.length, max(4, math.ceil(2*ring.length/self.spacing)+1))))
                 for ring in rings]
        return np.concatenate((inside, self.at(np.concatenate(edges)) if edges else np.zeros(0)))

    def stats(self, geometry):
        """Lowest, mean, and highest surface over a footprint (mean of interior grid points when there are any)."""
        values = self.samples(geometry)
        if not len(values):
            center = self.at([geometry.centroid.coords[0]])[0] if not geometry.is_empty else 0
            return center, center, center
        return float(values.min()), float(values.mean()), float(values.max())


def segments(radius):
    return int(np.clip(math.ceil(radius*12), 24, 96))


def circle(radius, x=0, y=0):
    return Point(x, y).buffer(radius, quad_segs=segments(radius)//4)


def outline(shape, width, length, radius):
    if shape == "oval":
        return scale(Point(0, 0).buffer(1, quad_segs=24), width/2, length/2)
    radius = min(radius, width/2*.999, length/2*.999) if shape == "rounded" else 0
    if radius <= 0:
        return box(-width/2, -length/2, width/2, length/2)
    return box(-width/2+radius, -length/2+radius, width/2-radius, length/2-radius).buffer(radius, quad_segs=8)


def prism(geometry, bottom, top):
    if top <= bottom or geometry.is_empty:
        return mf.Manifold()
    return extrude(geometry, top-bottom).translate((0, 0, bottom))


def cylinder(radius, bottom, top, x=0, y=0):
    return mf.Manifold.cylinder(top-bottom, radius, radius, segments(radius)).translate((x, y, bottom))


def leaned(section, reach, lean, z_ref, floor, top):
    """A prism leaning toward local +y, entering the surface at local 0, 0, z_ref and reaching down to floor.

    section(length) builds the upright prism from z = 0; reach is its largest |y| (the bottom face tilts by it).
    Returns the solid and how far its bottom center lies toward local −y."""
    angle = math.radians(lean)
    center = floor+reach*math.sin(angle)
    along = max(z_ref-center, .01)/math.cos(angle)
    length = along+(top-z_ref)/math.cos(angle)+reach*math.tan(angle)+1
    offset = along*math.sin(angle)
    return section(length).rotate((-lean, 0, 0)).translate((0, -offset, center)), offset


def closed(solid):
    if solid.status() != mf.Error.NoError:
        raise ValueError("The add-ons could not form a closed solid. Move or resize the add-ons and try again.")
    return solid


def union(solids):
    solids = [solid for solid in solids if not solid.is_empty()]
    if not solids:
        return mf.Manifold()
    return closed(mf.Manifold.batch_boolean(solids, mf.OpType.Add) if len(solids) > 1 else solids[0])


class Placement:
    """Rotates and moves an add-on's local frame (x along its width, y toward its back) onto the model."""

    def __init__(self, addon, model):
        self.x, self.y = (addon["u"]-.5)*model.width, (.5-addon["v"])*model.height
        self.angle = addon["rotation_deg"]

    def geometry(self, shape):
        return translate(rotate(shape, self.angle, origin=(0, 0)), self.x, self.y)

    def solid(self, solid):
        return solid.rotate((0, 0, self.angle)).translate((self.x, self.y, 0))

    def point(self, x, y):
        angle = math.radians(self.angle)
        return self.x+x*math.cos(angle)-y*math.sin(angle), self.y+x*math.sin(angle)+y*math.cos(angle)


def plan_addon(addon, model, default_color):
    """Heights, footprint, and (lazily) the solids of one add-on.

    Every cut from the top reaches above the model; its floor is z_ref − depth. The result's build()
    returns (phase, solid, color) tuples in model millimeters."""
    kind, params = addon["type"], addon["params"]
    place = Placement(addon, model)
    color = addon["color"] or default_color
    center = model.at([(place.x, place.y)])[0]
    plan = {"id": addon["id"], "type": kind, "label": TYPES[kind]["label"], "z_ref": float(center), "floor_z": float(center),
            "top_cut": False, "underside": False, "fills": False, "tilt": 0.0, "color": color, "missing": (), "notes": []}
    top = model.ceiling
    builders = []

    def leaning(shape, section, reach, lean, depth, positions, chamfer=0):
        """Holes or slots along local x, each reaching `depth` below the surface above it."""
        footprints, entries = [], []
        for x in positions:
            z_ref = float(model.at([place.point(x, 0)])[0])
            _, offset = leaned(lambda length: mf.Manifold(), reach, lean, z_ref, z_ref-depth, top)
            footprints.append(translate(shape, x, -offset).union(translate(shape, x, 0)).convex_hull)
            if chamfer:
                footprints.append(translate(shape.buffer(chamfer), x, 0))
            entries.append((x, z_ref))
        def build():
            solids = []
            for x, z_ref in entries:
                solid, _ = leaned(section, reach, lean, z_ref, z_ref-depth, top)
                if chamfer:
                    radius = reach
                    solid = union([solid, mf.Manifold.cylinder(chamfer, radius, radius+chamfer, segments(radius+chamfer)).translate((0, 0, z_ref-chamfer)),
                                   cylinder(radius+chamfer, z_ref, top)])
                solids.append(place.solid(solid.translate((x, 0, 0))))
            return [(CUT, union(solids), None)]
        builders.append(build)
        plan.update(top_cut=True, tilt=lean, floor_z=min(z_ref for _, z_ref in entries)-depth, z_max=max(z_ref for _, z_ref in entries))
        return place.geometry(unary_union(footprints))

    def round_section(radius):
        return lambda length: mf.Manifold.cylinder(length, radius, radius, segments(radius))

    if kind in ("hole", "nail_marker"):
        radius = (params["diameter"] if kind == "hole" else params["hole_diameter"])/2
        chamfer = min(params.get("chamfer", 0), params["depth"]/2)
        footprint = leaning(circle(radius), round_section(radius), radius, 0, params["depth"], [0], chamfer)
    elif kind == "pencil_holder":
        radius, count = params["diameter"]/2, params["count"]
        positions = [(index-(count-1)/2)*params["spacing"] for index in range(count)]
        footprint = leaning(circle(radius), round_section(radius), radius, params["tilt_deg"], params["depth"], positions)
        if count > 1 and params["spacing"] < params["diameter"]+1.2:
            plan["notes"].append(("warning", "Pencil holder holes are closer than 1.2 mm to each other; increase the spacing."))
    elif kind in ("photo_slot", "groove"):
        width, gap, lean = ((params["width"], params["gap"], params["lean_deg"]) if kind == "photo_slot"
                            else (params["length"], params["width"], params["angle_deg"]))
        slot = box(-width/2, -gap/2, width/2, gap/2)
        footprint = leaning(slot, lambda length: extrude(slot, length), gap/2, lean, params["depth"], [0])
    elif kind in ("pocket", "coaster"):
        local = (outline(params["shape"], params["width"], params["length"], params["corner_radius"]) if kind == "pocket"
                 else circle(params["diameter"]/2))
        footprint = place.geometry(local)
        lowest, _, _ = model.stats(footprint)
        floor = lowest-params["depth"]
        plan.update(top_cut=True, z_ref=lowest, floor_z=floor)
        builders.append(lambda: [(CUT, prism(footprint, floor, top), None)])
    elif kind in ("magnet", "hanging"):
        depth = params["depth"]
        if kind == "magnet" or params["style"] == "hole":
            radius = (params["diameter"] if kind == "magnet" else params["head_diameter"])/2
            local = circle(radius)
            pieces = [(local, -1, depth)]
        else:
            head, shank, slot = params["head_diameter"]/2, min(params["shank_diameter"], params["head_diameter"])/2, params["slot_length"]
            channel = unary_union([circle(head), box(-head, 0, head, slot), circle(head, 0, slot)])
            neck = unary_union([box(-shank, 0, shank, slot), circle(shank, 0, slot)])
            lip = min(1.6, depth*.4)  # the screw head catches on this lip above the narrow slot
            local = channel
            pieces = [(circle(head), -1, depth), (neck, -1, lip+.01), (channel, lip, depth)]
        footprint = place.geometry(local)
        lowest, _, _ = model.stats(footprint)
        plan.update(underside=True, z_ref=lowest, floor_z=0.0, z_min=0.0, z_max=depth)
        builders.append(lambda: [(CUT, union([place.solid(prism(shape, bottom, ceiling)) for shape, bottom, ceiling in pieces]), None)])
    elif kind == "plaque":
        local = outline(params["shape"], params["width"], params["length"], params["corner_radius"])
        footprint = place.geometry(local)
        lowest, mean, highest = model.stats(footprint)
        mode = params["mode"]
        level = {"flatten": lowest, "level": mean, "raise": highest+params["raise"]}[mode]
        plan.update(z_ref=level, floor_z=level, top_cut=mode != "raise", fills=mode != "flatten",
                    z_min=max(0, lowest-FILL_BOND) if mode != "flatten" else level, z_max=level)
        if mode != "raise":
            builders.append(lambda: [(SHAPE, prism(footprint, level, top), None)])
        if mode != "flatten":
            builders.append(lambda: [(FILL, prism(footprint, max(0, lowest-FILL_BOND), level), color)])
        if params["text"].strip():
            letters, plan["missing"] = text_shape(params["text"], params["text_size"])
            if letters.is_empty:
                plan["notes"].append(("warning", "The plaque text has no printable characters."))
            else:
                if not local.buffer(1e-6).contains(letters):
                    plan["notes"].append(("warning", "The plaque text is larger than the plaque and will be cut off."))
                letters = place.geometry(letters.intersection(local))
                depth = params["text_depth"]
                if params["text_style"] == "emboss":
                    plan.update(fills=True, z_max=level+depth)
                    builders.append(lambda: [(FILL, prism(letters, max(0, level-FILL_BOND), level+depth), color)])
                else:
                    plan.update(top_cut=True, floor_z=level-depth, z_min=min(plan["z_min"], level-depth))
                    builders.append(lambda: [(CUT, prism(letters, level-depth, top), None)])
    elif kind == "text":
        letters, plan["missing"] = text_shape(params["text"], params["text_size"])
        footprint = place.geometry(letters) if not letters.is_empty else Polygon()
        depth, emboss = params["text_depth"], params["text_style"] == "emboss"
        if letters.is_empty:
            plan["notes"].append(("warning", "The text has no printable characters."))
        else:
            # Follow: each letter part gets its own height; flat: one height for the whole label.
            groups = geometry_parts(footprint, "Polygon") if params["base"] == "follow" else [footprint]
            levels = [(group, *model.stats(group)) for group in groups]
            if emboss:
                lowest = min(level[1] for level in levels)
                plan.update(fills=True, z_ref=max(level[3] for level in levels), floor_z=lowest, z_min=max(0, lowest-FILL_BOND),
                            z_max=max(level[3] for level in levels)+depth)
                builders.append(lambda: [(FILL, union([prism(group, max(0, lowest-FILL_BOND), highest+depth) for group, lowest, _, highest in levels]), color)])
            else:
                floor = min(level[1] for level in levels)-depth
                plan.update(top_cut=True, z_ref=floor+depth, floor_z=floor)
                builders.append(lambda: [(CUT, union([prism(group, lowest-depth, top) for group, lowest, _, _ in levels]), None)])
    plan["footprint"] = footprint
    plan.setdefault("z_min", plan["floor_z"])
    plan.setdefault("z_max", plan["z_ref"])
    plan["build"] = lambda: [operation for builder in builders for operation in builder()]
    return plan


def plan_project(project, model, default_color):
    return [plan_addon(addon, model, default_color) for addon in active_addons(project)]


def apply_addons(parts, plans, model, progress=None):
    """Apply add-on solids to closed color parts.

    Leveling cuts come first, then material is added — unioned into the part of its color (a new part
    for a new color) and removed from every other part, so parts never overlap — and finally every cut
    is subtracted from every part, through map-feature inlays and buildings alike."""
    solids = {part["color"]: part.get("solid") or from_mesh(part["vertices"], part["faces"]) for part in parts}
    labels = {part["color"]: part["name"].split(" / ") for part in parts}
    operations = []
    for index, plan in enumerate(plans):
        if progress:
            progress(index/max(len(plans), 1), f"Shaping {plan['label'].lower()}…")
        operations.extend((phase, solid, color, plan["label"]) for phase, solid, color in plan["build"]())
    frame = mf.Manifold.cube((model.width, model.height, model.ceiling+2)).translate((-model.width/2, -model.height/2, -1))
    shaping = union([solid for phase, solid, _, _ in operations if phase == SHAPE])
    if not shaping.is_empty():
        solids = {color: closed(solid-shaping) for color, solid in solids.items()}
    fills = {}
    for phase, solid, color, label in operations:
        if phase == FILL:
            fills.setdefault(color, []).append((solid, label))
    for color, items in fills.items():
        fill = closed(union([solid for solid, _ in items]) ^ frame)
        if fill.is_empty():
            continue
        for other in solids:
            if other != color:
                solids[other] = closed(solids[other]-fill)
        solids[color] = union([solids[color], fill]) if color in solids else fill
        labels.setdefault(color, []).extend(label for _, label in items)
    cutting = union([solid for phase, solid, _, _ in operations if phase == CUT])
    if not cutting.is_empty():
        solids = {color: closed(solid-cutting) for color, solid in solids.items()}
    result = []
    for color, solid in solids.items():
        if solid.is_empty():
            continue
        mesh = solid.to_mesh64()
        vertices = np.asarray(mesh.vert_properties)[:, :3]
        result.append({"color": color, "name": " / ".join(dict.fromkeys(labels[color])), "vertices": vertices,
                       "faces": clean_collinear_faces(vertices, np.asarray(mesh.tri_verts)), "solid": solid})
    return result


def addon_mesh(terrain, options, project, progress=None):
    """The single terrain solid (STL/OBJ) with a project's add-ons applied; colors are ignored."""
    if not options.solid:
        raise ValueError("Enable Solid base to add holes, pockets, and other add-ons.")
    vertices, faces = build_mesh(terrain, options)
    model = Model(terrain, options, vertices)
    part = {"color": TERRAIN_COLOR, "name": "Terrain", "solid": closed(from_mesh(vertices, faces))}
    plans = plan_project(project, model, TERRAIN_COLOR)
    for plan in plans:
        plan["color"] = TERRAIN_COLOR
    build = [plan["build"] for plan in plans]
    for plan, original in zip(plans, build):
        plan["build"] = lambda original=original: [(phase, solid, TERRAIN_COLOR) for phase, solid, _ in original()]
    result = apply_addons([part], plans, model, progress)
    if not result:
        raise ValueError("The add-ons remove the whole model. Make them smaller or shallower.")
    return result[0]["vertices"], result[0]["faces"]


def fill_colors(project, default_color):
    """Colors of material the project adds (plaque pads, raised text)."""
    colors = []
    for addon in active_addons(project):
        params = addon["params"]
        adds = ((addon["type"] == "plaque" and (params["mode"] != "flatten" or (params["text"].strip() and params["text_style"] == "emboss")))
                or (addon["type"] == "text" and params["text_style"] == "emboss"))
        if adds:
            colors.append(addon["color"] or default_color)
    return colors


def print_color_set(palette, feature_layers, project):
    """Every filament color a 3MF needs: surfaces, enabled features, add-on material, and marker balls."""
    colors = set(palette.values()) | {style["color"] for style in (feature_layers or {}).values() if style["enabled"]}
    colors |= set(fill_colors(project, palette["dirt"]))
    if ball_count(project):
        colors.add(project["marker_balls"]["color"])
        if platform_top(project) != "none":
            colors.add(project["marker_balls"]["top_color"])
    return colors


# --- Marker platform tops ---------------------------------------------------------------------------------

def deck_fit(margin=0.0):
    """The deck's usable top: ("round", radius) or ("square", half side), inside the chamfer and a margin."""
    info = PLATFORM_INFO
    half = info["deck_size"]/2-info.get("deck_chamfer", 0)-margin
    return ("square" if info["deck_shape"] == "square" else "round"), half


def heightfield_solid(x, y, z):
    """A closed solid under heights z (rows × columns, ≥ 0) at columns x and rows y (descending), floor at z = 0."""
    rows, columns = z.shape
    xx, yy = np.meshgrid(x, y)
    top = np.column_stack((xx.ravel(), yy.ravel(), z.ravel()))
    floor = top.copy()
    floor[:, 2] = 0
    count = rows*columns
    corner = (np.arange(rows-1)[:, None]*columns+np.arange(columns-1)).ravel()
    triangles = np.concatenate((np.column_stack((corner, corner+columns, corner+1)),
                                np.column_stack((corner+1, corner+columns, corner+columns+1))))
    edges = np.concatenate((triangles[:, [0, 1]], triangles[:, [1, 2]], triangles[:, [2, 0]]))
    _, inverse, counts = np.unique(np.sort(edges, axis=1), axis=0, return_inverse=True, return_counts=True)
    a, b = edges[counts[inverse.ravel()] == 1].T
    walls = np.concatenate((np.column_stack((a, a+count, b)), np.column_stack((b, a+count, b+count))))
    return closed(from_mesh(np.concatenate((top, floor)), np.concatenate((triangles, triangles[:, ::-1]+count, walls))))


def terrain_top(model, x, y, area, exaggeration):
    """A patch of the model's surface, `area` mm square around x, y, shrunk onto the deck with its own exaggeration.

    Returns a closed solid centered on x/y with its flat base at z = 0, or None when the patch is off the model."""
    x0, x1 = max(x-area/2, -model.width/2), min(x+area/2, model.width/2)
    y0, y1 = max(y-area/2, -model.height/2), min(y+area/2, model.height/2)
    if x1-x0 < 1 or y1-y0 < 1:
        return None
    shape, half = deck_fit(.4)
    side = 2*half if shape == "square" else 2*half/math.sqrt(2)  # the square inscribed in a round deck
    fit = side/max(x1-x0, y1-y0)
    columns = int(np.clip(math.ceil((x1-x0)/model.spacing)+1, 8, 100))
    rows = int(np.clip(math.ceil((y1-y0)/model.spacing)+1, 8, 100))
    xs, ys = np.linspace(x0, x1, columns), np.linspace(y1, y0, rows)
    xx, yy = np.meshgrid(xs, ys)
    heights = model.at(np.column_stack((xx.ravel(), yy.ravel()))).reshape(rows, columns)
    # Model heights carry the model's exaggeration; rescale them to the top's, at the top's horizontal scale.
    relief = (heights-heights.min())*(exaggeration/model.options.exaggeration)*fit
    return heightfield_solid((xs-(x0+x1)/2)*fit, (ys-(y0+y1)/2)*fit, relief+TOP_BASE)


def building_pieces(buildings):
    outlines = [feature for feature in buildings if not feature.get("part") and feature.get("polygons")]
    parts = {}
    for feature in buildings:
        if feature.get("part") and feature.get("parent"):
            parts.setdefault(feature["parent"], []).append(feature)
    return outlines, parts


def find_building(buildings, model, x, y, terrain):
    """The mapped building outline containing x, y (model mm), or the nearest within BUILDING_REACH_M."""
    transform = [model.width, 0, 0, -model.height, -model.width/2, model.height/2]
    reach = BUILDING_REACH_M*model.width/terrain.width
    point, best = Point(x, y), None
    outlines, _ = building_pieces(buildings)
    for feature in outlines:
        shape = feature_footprint(feature, transform)
        if shape.is_empty:
            continue
        distance = shape.distance(point)
        if distance <= reach and (best is None or distance < best[0]):
            best = (distance, feature, shape)
            if distance == 0:
                break
    return best


def building_top(buildings, feature, shape, model, terrain):
    """The building (its mapped 3D parts when there are any, else its extruded outline), scaled to fit the deck.

    Returns a closed solid centered on the outline with its base at z = 0."""
    _, parts = building_pieces(buildings)
    transform = [model.width, 0, 0, -model.height, -model.width/2, model.height/2]
    mm_per_m = model.width/terrain.width
    solids = []
    for piece in parts.get(feature["id"]) or [feature]:
        solid = None
        if piece.get("mesh"):
            positions = np.asarray(piece["mesh"]["positions"], dtype=np.float64).reshape(-1, 3)
            faces = np.asarray(piece["mesh"]["indices"], dtype=np.uint64).reshape(-1, 3)[:, ::-1]  # y is mirrored below
            try:
                solid = from_mesh(np.column_stack(((positions[:, 0]-.5)*model.width, (.5-positions[:, 1])*model.height,
                                                   positions[:, 2]*mm_per_m)), faces)
            except ValueError:
                solid = None
        if solid is None or solid.is_empty():
            outline = feature_footprint(piece, transform)
            bottom = piece.get("min_height_m", 0)*mm_per_m
            solid = prism(outline, bottom, max(piece.get("height_m", 6)*mm_per_m, bottom+.1))
        solids.append(solid)
    solid = union(solids)
    if solid.is_empty():
        return None
    hull = np.asarray(shape.convex_hull.exterior.coords) if shape.convex_hull.geom_type == "Polygon" else np.asarray(shape.bounds).reshape(2, 2)
    x0, y0, x1, y1 = shape.bounds
    center = np.array([(x0+x1)/2, (y0+y1)/2])
    kind, half = deck_fit(TOP_MARGIN)
    reach = np.abs(hull-center).max() if kind == "square" else np.hypot(*(hull-center).T).max()
    fit = half/max(reach, 1e-6)
    solid = solid.translate((-center[0], -center[1], 0)).scale((fit, fit, fit))
    height = solid.bounding_box()[5]
    if height < TOP_MIN_HEIGHT:
        solid = solid.scale((1, 1, TOP_MIN_HEIGHT/max(height, 1e-6)))
    return closed(solid)


def marker_tops(terrain, options, project, buildings=None, model=None):
    """What to print on each platform, in nail-marker order: {"id", "number", "solid" (None = bare), "note"}.

    Solids are in platform coordinates: centered on x/y, standing on the deck top (z = deck_top_z)."""
    top = platform_top(project)
    markers = nail_markers(project)
    if top == "none":
        return [{"id": addon["id"], "number": index+1, "solid": None, "note": None} for index, addon in enumerate(markers)]
    model = model or Model(terrain, options)
    balls = project["marker_balls"]
    result = []
    for index, addon in enumerate(markers):
        place = Placement(addon, model)
        solid, note = None, None
        if top == "terrain":
            solid = terrain_top(model, place.x, place.y, balls["top_area_mm"], balls["top_exaggeration"] or options.exaggeration)
        elif buildings is None:
            note = ("warning", f"Turn on the Buildings map layer and let it load to print a building on nail marker {index+1}.")
        else:
            found = find_building(buildings, model, place.x, place.y, terrain)
            if found:
                solid = building_top(buildings, found[1], found[2], model, terrain)
            if solid is None:
                note = ("warning", f"No mapped building at nail marker {index+1}; the platform prints bare.")
        if solid is not None:
            solid = solid.translate((0, 0, PLATFORM_INFO["deck_top_z"]))
        result.append({"id": addon["id"], "number": index+1, "solid": solid, "note": note})
    return result


def top_mesh(solid):
    mesh = solid.to_mesh64()
    vertices = np.asarray(mesh.vert_properties)[:, :3]
    return vertices, clean_collinear_faces(vertices, np.asarray(mesh.tri_verts))


# --- Checks -----------------------------------------------------------------------------------------------

def check_project(terrain, options, project, palette=None, feature_layers=None, format="3mf", bed_mm=256, buildings=None):
    """Fast printability checks (no booleans on the model; platform tops are built to see whether they exist).

    buildings: the loaded OSM building layer, for buildings printed on marker platforms."""
    checks = []
    def add(level, message, addon_id=None):
        checks.append({"addon_id": addon_id, "level": level, "message": message})
    project = project or {"addons": [], "marker_balls": marker_options(None)}
    addons = active_addons(project)
    default = palette["dirt"] if palette else TERRAIN_COLOR
    if addons and not options.solid:
        add("error", "Enable Solid base to add holes, pockets, and other add-ons.")
    model = Model(terrain, options)
    plans = plan_project(project, model, default)
    size, base = options.size_mm, options.size_mm*options.base_percent/100
    def thicker_base(shortfall):
        percent = math.ceil((options.base_percent+shortfall/size*100)*10)/10
        return f"raise the base to {percent:g}%" if percent <= 15 else "use a taller model"
    for plan in plans:
        label, identifier = plan["label"], plan["id"]
        for level, message in plan["notes"]:
            add(level, message, identifier)
        if plan["missing"]:
            add("warning", f"{label}: the bundled font cannot draw {' '.join(plan['missing'])}; those characters are left out.", identifier)
        if plan["type"] == "nail_marker":
            depth = next(addon for addon in addons if addon["id"] == identifier)["params"]["depth"]
            exposed = float(marker_info(project)["exposed_nail_length"])
            if depth < exposed-1e-6:
                add("warning", f"The nail will stand {exposed-depth:.1f} mm proud; trim the nail or use a thicker base.", identifier)
        if plan["top_cut"]:
            floor = plan["floor_z"]
            if floor < MIN_FLOOR:
                add("error", f"{label} would break through the bottom ({max(floor, 0):.1f} mm of floor left). Make it shallower or {thicker_base(SAFE_FLOOR-floor)}.", identifier)
            elif floor < SAFE_FLOOR:
                add("warning", f"{label} leaves a thin {floor:.1f} mm floor; {SAFE_FLOOR:g} mm or more prints reliably.", identifier)
        if plan["underside"]:
            left = plan["z_ref"]-plan["z_max"]
            if left < MIN_FLOOR:
                add("error", f"{label} would open through the top surface ({max(left, 0):.1f} mm of material left above it). Make it shallower or {thicker_base(SAFE_FLOOR-left)}.", identifier)
        if plan["tilt"] > 45:
            add("warning", f"{label} leans more than 45° and will need supports.", identifier)
        footprint = plan["footprint"]
        if footprint.is_empty:
            continue
        if not model.frame.buffer(1e-6).contains(footprint):
            add("warning", f"{label} extends past the model edge and will be clipped.", identifier)
        elif plan["top_cut"] or plan["underside"]:
            wall = model.frame.exterior.distance(footprint)
            if wall < MIN_WALL:
                add("warning", f"{label} leaves only {wall:.1f} mm of wall at the model edge.", identifier)
    for index, plan in enumerate(plans):
        for other in plans[:index]:
            if plan["footprint"].is_empty or other["footprint"].is_empty or plan["footprint"].intersection(other["footprint"]).area < .01:
                continue
            if (plan["underside"] and other["top_cut"]) or (plan["top_cut"] and other["underside"]):
                top_cut, under = (other, plan) if plan["underside"] else (plan, other)
                if top_cut["floor_z"]-under["z_max"] < MIN_FLOOR:
                    add("error", f"{under['label']} meets {top_cut['label'].lower()} inside the model; move one or make them shallower.", plan["id"])
                    continue
            level = "info" if {"plaque", "text"} & {plan["type"], other["type"]} else "warning"
            add(level, f"{plan['label']} overlaps {other['label'].lower()}.", plan["id"])
    balls = ball_count(project)
    if project["marker_balls"]["include"] and not balls:
        add("info", "Add a nail marker to print marker balls with the model.")
    if marker_style(project) == "platform":
        markers = nail_markers(project)
        reach = PLATFORM_INFO["deck_size"]*(math.sqrt(2) if PLATFORM_INFO["deck_shape"] == "square" else 1)
        for index, addon in enumerate(markers):
            first = Placement(addon, model)
            for other_index, other in enumerate(markers[index+1:], index+1):
                second = Placement(other, model)
                if math.hypot(first.x-second.x, first.y-second.y) < reach:
                    add("info", f"Platforms at markers {index+1} and {other_index+1} would touch; space them at least {reach:g} mm apart.", other["id"])
        if balls and platform_top(project) != "none":
            for top in marker_tops(terrain, options, project, buildings, model):
                if top["note"]:
                    add(*top["note"], top["id"])
            add("info", "Platforms with a printed-on top print upright and need supports under the deck; bare platforms print deck down without supports.")
    colors = 0
    if palette:
        colors = len(print_color_set(palette, feature_layers, project))
        if format == "3mf" and colors > 4:
            add("error", f"This print needs {colors} colors across surfaces, map features, add-ons, and nail markers; share colors to use at most four.")
    else:
        colors = len({TERRAIN_COLOR, *fill_colors(project, TERRAIN_COLOR)})
    if finite(bed_mm) and bed_mm > 0:
        width = model.width
        if balls and format == "3mf":
            vertices, _ = marker_mesh(project)
            positions = ball_positions(balls, model.width, model.height, vertices)
            width = max(width, model.width/2+max(x for x, _ in positions)+vertices[:, 0].max())
        if max(width, model.height) > bed_mm:
            add("warning", f"The print is {width:.0f} × {model.height:.0f} mm, larger than the {bed_mm:g} mm printer bed.")
    worst = {}
    order = {"info": 0, "warning": 1, "error": 2}
    for check in checks:
        if check["addon_id"] and order[check["level"]] >= order.get(worst.get(check["addon_id"]), -1):
            worst[check["addon_id"]] = check["level"]
    entries = []
    for plan in plans:
        entry = {key: round(float(plan[key]), 3) for key in ("z_ref", "floor_z", "z_min", "z_max")} | {"id": plan["id"]}
        if plan["id"] in worst:
            entry["level"] = worst[plan["id"]]
        entries.append(entry)
    return {"checks": checks, "colors": colors, "addons": entries,
            "model": {"width_mm": model.width, "height_mm": model.height, "max_z_mm": model.max_z, "base_mm": base}}
