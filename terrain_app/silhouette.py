"""Silhouette pieces: elevation-profile slices (or an uploaded route's profile) cut as flat ridgeline pieces.

A design is one or more layers, each a piece drawn in millimeters with x from 0 at its left end and y up from its flat
bottom, plus what holds them: a tab for an LED lamp base's slot, a comb base for several layers on one lamp, or two
spacer combs for a shadow box. Exports lay every part flat on the bed (layers front face up, z = thickness), so
engraved and raised text, ticks, and medal pegs print without supports.

The assembled arrangement (the preview's 3D view) uses x along the pieces, y up, and z toward the viewer.
"""
from dataclasses import asdict, dataclass, replace
from io import BytesIO
import json
import math
from pathlib import Path
import re
from xml.sax.saxutils import escape, quoteattr
from zipfile import ZIP_DEFLATED, ZipFile

import manifold3d as mf
import numpy as np
from shapely import make_valid
from shapely.affinity import scale, translate
from shapely.geometry import LineString, Point, Polygon, box
from shapely.geometry.polygon import orient
from shapely.ops import nearest_points, unary_union

from .addons import FONT_STYLES, HEX, finite, line_shape, text_shape
from .elevation import SOURCES
from .features import parts as geometry_parts, to_selection
from .mesh import ModelOptions, binary_stl, model_elevations, relief_method
from .printing import model_xml, package_3mf
from .profiles import band, profile_options, ridgeline, ridges, skyline_profile, viewpoint
from .routes import ROUTE_ID, along

BED_MM = 256  # the common printer bed the size hint is measured against
WALL = 1.2  # mm of material kept around wall holes and engraved or stencil text
STAND_SLOT_DEPTH, STAND_FLOOR, STAND_GAP, CLEARANCE = 4.0, 2.0, 6.0, .2
KEYHOLE_HEAD, KEYHOLE_SLOT, KEYHOLE_TRAVEL = 7.6, 3.8, 6.0  # mm: a screw head passes the head, its shank rests in the slot
# Combs (the lamp's comb base and the shadow box's spacer combs): a solid floor under slots the layers stand in.
COMB_FLOOR, COMB_SLOT, COMB_WALL, COMB_STRIP, COMB_CLEARANCE, SLOT_WALL = 3.0, 5.0, 2.5, 12.0, .3, 1.2
# Printability of lamp and shadow-box parts: the comb base prints slots down, so its slot mouths are chamfered against
# elephant's foot; a rear panel must show at least SHOW_MM above the panels in front of it somewhere.
SLOT_CHAMFER, SHOW_MM = .4, 1.5
BOX_SIDE, BOX_BACK = 1.0, .5  # pieces are the box's inner width less BOX_SIDE; combs its inner depth less BOX_BACK
PART_GAP = 6.0  # between parts laid out on the bed
TICK_WIDTH, TICK_LENGTH, TICK_LABEL, MARK_DEPTH = .6, 3.0, 3.0, .6
MILE_M = 1609.344
FORMATS = {"stl": ("model/stl", "silhouette.stl"), "3mf": ("model/3mf", "silhouette.3mf"),
           "svg": ("image/svg+xml", "silhouette.svg"), "json": ("application/json", "silhouette-settings.json")}
PARTS_ZIP = ("application/zip", "silhouette-parts.zip")  # STL of a design with more than one part
TEXT_STYLES = ("engrave", "emboss", "stencil")
MOUNTS = ("none", "stand", "holes", "keyholes")
FITS = ("none", "lamp", "box")
PRESET_DATA = json.loads((Path(__file__).parent / "data" / "silhouette-presets.json").read_text(encoding="utf-8"))
PRESETS = tuple(PRESET_DATA["presets"])
MAX_LAYERS = 7
MAX_TEXT_LINES = 6  # a text block from the text editor
# Colored by distance: nearest first, dark to pale, the farthest the default text color so a caption can share it.
DISTANCE_COLORS = ("#234e40", "#678272", "#acb6a4", "#f0ead6")
COLOR_LIMIT = "Use at most four colors: share the text color with one of the distance colors."


@dataclass(frozen=True)
class SilhouetteOptions:
    direction: str = "ew"  # ew: along grid rows (left → right); ns: along columns (top → bottom)
    position: float = 50.0  # percent across the frame, as the geography selection page's profile slider
    trim: tuple = (0.0, 100.0)  # percent of the slice (or route) printed
    width_mm: float = 180.0  # length of the piece; the trimmed slice fills it
    vertical_scale: float = 2.0  # × true proportions at that width
    base_mm: float = 8.0  # solid strip under the lowest point
    smoothing: float = 0.0  # percent
    source: str = "true"  # true elevations, "shaped" by the model's elevation profile, the uploaded "route", a "ridgeline", or a "viewpoint" skyline
    relief: str = "standard"
    relief_strength: float = 50.0
    mirror: bool = False
    thickness_mm: float = 4.0  # every layer's, unless it has its own or its thickness follows its distance
    thickness_by_distance: bool = False  # a viewpoint's layers: closer layers thicker, thickness_near_mm to thickness_far_mm
    thickness_near_mm: float = 3.0
    thickness_far_mm: float = 1.5
    text: str = ""  # up to three lines
    text_size: float = 5.0  # cap height, mm
    text_style: str = "engrave"
    text_align: str = "center"
    text_lines: tuple = ()  # a text block: ((text, cap height mm, style, letter spacing %), ...) top to bottom; empty: text and text_size
    line_spacing: float = 1.6  # baseline to baseline, times the lower line's cap height
    text_x: float = None  # the caption block's center (mm from the piece's left and up from its bottom); None: aligned on the base
    text_y: float = None
    text_depth: float = .8
    mount: str = "none"
    hole_diameter: float = 4.0
    body_color: str = "#234e40"
    text_color: str = "#f0ead6"
    preset: str = "custom"  # recorded in the settings file; the client applies a preset's fields
    layers: tuple = ()  # ((position %, base mm, color, thickness mm or None), ...) front to back; empty: one layer at position and base_mm
    fit: str = "none"  # lamp: a tab (or comb base) for an LED lamp base's slot; box: spacer combs for a shadow box
    slot_width: float = 4.0
    slot_length: float = 160.0
    slot_depth: float = 8.0
    slot_clearance: float = .2
    layer_spacing: float = 6.0  # between layer slots in a lamp's comb base
    comb_clearance: float = COMB_CLEARANCE  # added to each layer's thickness for its slot in the comb base or spacer combs
    min_feature_mm: float = 1.0  # lamp and box panels: spikes and slivers narrower than this are trimmed (0: off)
    box_width: float = 200.0  # inner size of the shadow box
    box_height: float = 150.0
    box_depth: float = 40.0
    photo_slot: bool = False
    photo_gap: float = 1.0
    led_channel: bool = False
    led_width: float = 5.0
    led_depth: float = 2.0
    include_buildings: bool = False
    building_corridor_m: float = 30.0
    route_id: str = ""
    summit_pin: bool = False
    pin_diameter: float = 1.8
    pin_depth: float = 10.0
    peg_count: int = 0
    peg_diameter: float = 6.0
    peg_length: float = 20.0
    ticks: bool = False
    tick_every: float = 1.0  # miles or kilometers, as units
    units: str = "ft"  # the app's switch: ft ticks every mile, m every kilometer
    start_finish: bool = False
    # Profiles drawn on the geography page (profiles.py); points are (latitude, longitude).
    ridge_start: tuple = ()
    ridge_end: tuple = ()
    view_point: tuple = ()
    view_bearing: float = 0.0
    view_fov: float = 120.0
    view_eye_m: float = 2.0
    view_min_radius_m: float = 0.0  # terrain nearer than this is left out of the view
    view_max_radius_m: float = 0.0  # terrain farther than this is cut off (0: out to the horizon)
    view_ridges: bool = False  # several layers are the detected ridgelines, nearest first, instead of distance bands
    color_by_distance: bool = False  # layers take distance_colors in contiguous groups, nearest first; fit parts and feet the farthest used
    distance_colors: tuple = DISTANCE_COLORS  # 1–4 colors, nearest first
    color_zones: bool = False  # a viewpoint's layers become color zones of one flat piece instead of separate layers
    clouds: bool = False  # a decorative, separate panel behind the terrain layers
    cloud_color: str = "#f0ead6"
    ridge_edits: tuple = ()  # (original layer index, deleted, normalized curve ((x/width, (y-base)/width), ...))

    @classmethod
    def from_dict(cls, value):
        if not isinstance(value, dict):
            raise ValueError("Supply the silhouette settings as an object.")
        defaults, numbers = cls(), {}
        limits = {"position": (0, 100, "The slice position must be between 0 and 100 percent."),
                  "width_mm": (40, 400, "The piece width must be between 40 and 400 mm."),
                  "vertical_scale": (.5, 100, "The vertical scale must be between 0.5 and 100 times."),
                  "base_mm": (2, 40, "The base height must be between 2 and 40 mm."),
                  "smoothing": (0, 100, "Smoothing must be between 0 and 100 percent."),
                  "relief_strength": (0, 100, "The elevation profile strength must be between 0 and 100 percent."),
                  "thickness_mm": (1.2, 30, "The thickness must be between 1.2 and 30 mm."),
                  "thickness_near_mm": (1.2, 30, "The nearest layer's thickness must be between 1.2 and 30 mm."),
                  "thickness_far_mm": (1.2, 30, "The farthest layer's thickness must be between 1.2 and 30 mm."),
                  "text_size": (2, 30, "The text size must be between 2 and 30 mm."),
                  "text_depth": (.2, 5, "The text depth must be between 0.2 and 5 mm."),
                  "hole_diameter": (2, 10, "The wall hole diameter must be between 2 and 10 mm."),
                  "slot_width": (1, 20, "The lamp slot width must be between 1 and 20 mm."),
                  "slot_length": (20, 400, "The lamp slot length must be between 20 and 400 mm."),
                  "slot_depth": (2, 30, "The lamp slot depth must be between 2 and 30 mm."),
                  "slot_clearance": (0, 1, "The lamp slot clearance must be between 0 and 1 mm."),
                  "layer_spacing": (2, 30, "The layer spacing must be between 2 and 30 mm."),
                  "comb_clearance": (0, 1, "The comb slot clearance must be between 0 and 1 mm."),
                  "min_feature_mm": (0, 3, "The minimum feature width must be between 0 (off) and 3 mm."),
                  "box_width": (41, 500, "The box's inner width must be between 41 and 500 mm."),
                  "box_height": (20, 400, "The box's inner height must be between 20 and 400 mm."),
                  "box_depth": (8, 200, "The box's inner depth must be between 8 and 200 mm."),
                  "photo_gap": (.3, 5, "The photo slot must be between 0.3 and 5 mm wide."),
                  "led_width": (2, 20, "The LED channel must be between 2 and 20 mm wide."),
                  "led_depth": (.5, 5, "The LED channel must be between 0.5 and 5 mm deep."),
                  "building_corridor_m": (5, 200, "The building corridor must be between 5 and 200 m wide."),
                  "pin_diameter": (1, 4, "The summit pin hole must be between 1 and 4 mm across."),
                  "pin_depth": (3, 30, "The summit pin hole must be between 3 and 30 mm deep."),
                  "peg_diameter": (3, 12, "The medal pegs must be between 3 and 12 mm across."),
                  "peg_length": (5, 40, "The medal pegs must be between 5 and 40 mm long."),
                  "tick_every": (.1, 100, "Distance ticks must be between 0.1 and 100 miles or kilometers apart.")}
        for name, (low, high, message) in limits.items():
            number = value.get(name, getattr(defaults, name))
            if not finite(number) or not low <= number <= high:
                raise ValueError(message)
            numbers[name] = float(number)
        choices = {"direction": (("ew", "ns"), "Choose ew (left to right) or ns (top to bottom) as the slice direction."),
                   "source": (("true", "shaped", "route", "ridgeline", "viewpoint"), "Choose true, shaped, route, ridgeline, or viewpoint as the profile source."),
                   "text_style": (TEXT_STYLES, "Choose engrave, emboss, or stencil as the text style."),
                   "text_align": (("left", "center", "right"), "Choose left, center, or right as the text position."),
                   "mount": (MOUNTS, "Choose none, stand, holes, or keyholes as the mount."),
                   "fit": (FITS, "Choose none, lamp, or box as the fit."),
                   "units": (("ft", "m"), "Choose ft (miles) or m (kilometers) as the units."),
                   "preset": (PRESETS, "Choose one of the listed design presets.")}
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
        flags = {}
        for name, label in (("mirror", "Mirror"), ("photo_slot", "The photo slot"), ("led_channel", "The LED channel"),
                            ("include_buildings", "Include buildings"), ("summit_pin", "The summit pin hole"),
                            ("ticks", "Distance ticks"), ("start_finish", "START and FINISH labels"), ("thickness_by_distance", "Thicker when closer"),
                            ("color_by_distance", "Color by distance"), ("color_zones", "Color zones"), ("clouds", "Cloud background")):
            flags[name] = value.get(name, getattr(defaults, name))
            if not isinstance(flags[name], bool):
                raise ValueError(f"{label} must be true or false.")
        spacing = value.get("line_spacing", defaults.line_spacing)
        if not finite(spacing) or not 1 <= spacing <= 3:
            raise ValueError("The line spacing must be between 1 and 3 times the letter height.")
        block = text_block_lines(value.get("text_lines"))  # the text editor's lines, read first: they replace text and text_size
        if block:
            lines = [line[0] for line in block]
            numbers["text_size"] = float(min(max(max(line[1] for line in block), 2), 30))
        else:
            text = value.get("text", "")
            if not isinstance(text, str):
                raise ValueError("The caption must be text.")
            lines = [line.strip() for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
            while lines and not lines[-1]:
                lines.pop()
            while lines and not lines[0]:
                lines.pop(0)
            if len(lines) > 3 or any(len(line) > 60 for line in lines):
                raise ValueError("The caption must be at most 3 lines of at most 60 characters each.")
        spot, place = (value.get("text_x"), value.get("text_y")), {}
        if any(item is not None for item in spot):
            if not all(finite(item) and -500 <= item <= 1000 for item in spot):
                raise ValueError("A moved caption needs text_x and text_y, its center in millimeters on the piece.")
            place = {"text_x": float(spot[0]), "text_y": float(spot[1])}
        colors = {}
        for name in ("body_color", "text_color", "cloud_color"):
            color = value.get(name, getattr(defaults, name))
            if not isinstance(color, str) or not HEX.fullmatch(color):
                raise ValueError(f"Choose a six-digit hex color for the {name.split('_')[0]}.")
            colors[name] = color.lower()
        palette = value.get("distance_colors", list(DISTANCE_COLORS))
        if (not isinstance(palette, (list, tuple)) or not 1 <= len(palette) <= 4
                or not all(isinstance(color, str) and HEX.fullmatch(color) for color in palette)):
            raise ValueError("Choose one to four six-digit hex colors for the distance colors, nearest first.")
        pegs = value.get("peg_count", 0)
        if not finite(pegs) or pegs != int(pegs) or not 0 <= pegs <= 8:
            raise ValueError("The number of medal pegs must be a whole number from 0 to 8.")
        layers = value.get("layers", [])
        if not isinstance(layers, (list, tuple)) or len(layers) > MAX_LAYERS:
            raise ValueError("Supply 1 to 7 layers, each with a slice position, a base height, and a color.")
        parsed = []
        for index, layer in enumerate(layers, 1):
            if not isinstance(layer, dict):
                raise ValueError("Supply 1 to 7 layers, each with a slice position, a base height, and a color.")
            position, base, color = layer.get("position"), layer.get("base_mm", numbers["base_mm"]), layer.get("color", colors["body_color"])
            thickness = layer.get("thickness_mm")
            if not finite(position) or not 0 <= position <= 100:
                raise ValueError(f"Layer {index}'s slice position must be between 0 and 100 percent.")
            if not finite(base) or not 2 <= base <= 120:
                raise ValueError(f"Layer {index}'s base height must be between 2 and 120 mm.")
            if not isinstance(color, str) or not HEX.fullmatch(color):
                raise ValueError(f"Choose a six-digit hex color for layer {index}.")
            if thickness is not None and (not finite(thickness) or not 1.2 <= thickness <= 30):
                raise ValueError(f"Layer {index}'s thickness must be between 1.2 and 30 mm.")
            parsed.append((float(position), float(base), color.lower(), None if thickness is None else float(thickness)))
        route_id = value.get("route_id", "")
        if picked["source"] == "route" and (not isinstance(route_id, str) or not ROUTE_ID.fullmatch(route_id)):
            raise ValueError("Upload a GPX route on the geography selection page to use its elevation profile.")
        drawn = {}
        if picked["source"] == "ridgeline":
            ridge = profile_options({"mode": "ridgeline", "start": value.get("ridge_start"), "end": value.get("ridge_end")})
            drawn = {"ridge_start": ridge["start"], "ridge_end": ridge["end"]}
        elif picked["source"] == "viewpoint":
            view = profile_options({"mode": "viewpoint", "point": value.get("view_point"), "bearing": value.get("view_bearing", 0.0),
                                    "fov": value.get("view_fov", 120.0), "eye_m": value.get("view_eye_m", 2.0),
                                    "min_radius_m": value.get("view_min_radius_m", 0.0), "max_radius_m": value.get("view_max_radius_m", 0.0),
                                    "ridges": value.get("view_ridges", False)})
            drawn = {"view_point": view["point"], "view_bearing": view["bearing"], "view_fov": view["fov"], "view_eye_m": view["eye_m"],
                     "view_min_radius_m": view["min_radius_m"], "view_max_radius_m": view["max_radius_m"], "view_ridges": view["ridges"]}
            # Detected ridges set their own distances; distance bands go by the layers' positions.
            if not view["ridges"] and [layer[0] for layer in parsed] != sorted(layer[0] for layer in parsed):
                raise ValueError("A viewpoint's layers are distance bands: give each layer a farther distance than the one in front.")
        edits = parse_ridge_edits(value.get("ridge_edits", []), len(parsed) or 1)
        options = cls(**numbers, **picked, **colors, **flags, **drawn, **place, ridge_edits=edits, text_lines=block, line_spacing=float(spacing), trim=(float(trim[0]), float(trim[1])), text="\n".join(lines),
                      relief=relief_method(value.get("relief", "standard")), layers=tuple(parsed), peg_count=int(pegs),
                      distance_colors=tuple(color.lower() for color in palette),
                      route_id=route_id if picked["source"] == "route" else "")
        if options.fit == "box":
            options = replace(options, width_mm=options.box_width-BOX_SIDE)  # pieces fill the box's width
        count = len(layer_specs(options))
        if options.color_zones and (options.source != "viewpoint" or count < 2):
            raise ValueError("Color zones need a viewpoint with at least two ridges or bands.")
        if options.color_zones and options.fit == "box":
            raise ValueError("Color zones make one piece; turn off the shadow-box fit or the zones.")
        if count > 1 and options.fit == "none" and not options.color_zones:
            raise ValueError("Several layers need a lamp-base or shadow-box fit to stand in. Choose one, or use a single layer.")
        if count > 1 and options.source in ("route", "ridgeline"):
            raise ValueError(f"A {options.source} profile makes a single layer. Use one layer.")
        if options.fit != "none" and options.mount != "none":
            raise ValueError("A lamp base or shadow box holds the piece, so set the mount to none.")
        if options.clouds and (count < 2 or options.fit not in ("lamp", "box") or options.color_zones):
            raise ValueError("Clouds need separate terrain layers in a lamp base or shadow box.")
        if options.fit == "lamp":
            if tab_thickness(options) < .8 or options.slot_length-2*options.slot_clearance < 10:
                raise ValueError("The lamp slot is too small for a tab. Check its width, length, and clearance.")
        if not by_distance(options) or all(layer[3] is not None for layer in options.layers):
            active = active_ridge_options(options)
            check_thickness(active, layer_thicknesses(active))  # otherwise layout checks once distances are known
        return options


def parse_ridge_edits(value, count):
    """Curves remain graphs across the whole width, so edits cannot fold a panel over itself."""
    if not isinstance(value, (list, tuple)) or len(value) > count:
        raise ValueError("Supply ridgeline edits as a list, with at most one edit per ridge.")
    edits, seen = [], set()
    for edit in value:
        if not isinstance(edit, dict):
            raise ValueError("Each ridgeline edit needs a layer index, deleted flag, and optional curve.")
        index, deleted, curve = edit.get("layer"), edit.get("deleted", False), edit.get("curve", [])
        if not finite(index) or int(index) != index or not 0 <= index < count or index in seen:
            raise ValueError("Each ridgeline edit must name a different existing layer index.")
        if not isinstance(deleted, bool):
            raise ValueError("A ridgeline's deleted flag must be true or false.")
        if not isinstance(curve, (list, tuple)) or (curve and not 2 <= len(curve) <= 1025):
            raise ValueError("An edited ridge curve needs 2 to 1025 points across its width.")
        points = []
        for point in curve:
            if (not isinstance(point, (list, tuple)) or len(point) != 2 or not all(finite(v) for v in point)
                    or not 0 <= point[0] <= 1 or not 0 <= point[1] <= 5
                    or (points and point[0] <= points[-1][0])):
                raise ValueError("Ridge curve points must increase left to right from 0 to 1, with heights from 0 to 5 widths above the base.")
            points.append(tuple(map(float, point)))
        if points and (points[0][0] != 0 or points[-1][0] != 1):
            raise ValueError("An edited ridge curve must cover the full width, from 0 to 1.")
        seen.add(index)
        edits.append((int(index), deleted, tuple(points)))
    if sum(deleted for _, deleted, _ in edits) >= count:
        raise ValueError("Keep at least one ridgeline in the silhouette.")
    return tuple(edits)


def active_ridge_options(options):
    deleted = {index for index, removed, _ in options.ridge_edits if removed}
    specs = tuple(spec for index, spec in enumerate(layer_specs(options)) if index not in deleted)
    # A single remaining panel uses the single-panel fit; a cloud background needs layered terrain.
    return replace(options, layers=specs, clouds=options.clouds and len(specs) > 1)


def layer_specs(options):
    """(position %, base mm, color, own thickness mm or None) for each layer, front to back."""
    return options.layers or ((options.position, options.base_mm, options.body_color, None),)


def by_distance(options):
    return options.thickness_by_distance and options.source == "viewpoint" and len(layer_specs(options)) > 1


def by_color(options):
    return options.color_by_distance or options.color_zones


def distance_palette(options, count):
    """Each of `count` layers' color, nearest first, colored by distance: contiguous groups of layers, as even as possible,
    take the distance colors in order (fewer layers than colors use the nearest ones)."""
    used = min(count, len(options.distance_colors))
    return [options.distance_colors[index*used//count] for index in range(count)]


def layer_thicknesses(options, distances=None):
    """Each layer's thickness (mm), front to back: its own when given; for a viewpoint's layers thicker when closer, by log
    distance from thickness_near_mm at the nearest layer to thickness_far_mm at the farthest (to 0.1 mm); else thickness_mm."""
    specs = layer_specs(options)
    shared = [options.thickness_mm]*len(specs)
    if by_distance(options) and distances:
        logs = np.log(np.maximum(distances, 1.0))
        low, high = float(logs.min()), float(logs.max())
        shared = [round(float(options.thickness_near_mm+(options.thickness_far_mm-options.thickness_near_mm)*((value-low)/(high-low) if high > low else 0)), 1)
                  for value in logs]
    return [spec[3] if spec[3] is not None else value for spec, value in zip(specs, shared)]


def check_thickness(options, thicknesses):
    """What the layers' thicknesses must leave room for: engraved text in the front layer, and the comb's or box's slots."""
    if options.text and options.text_style == "engrave" and options.text_depth > thicknesses[0]-.4:
        raise ValueError("Engraved text must leave at least 0.4 mm behind it. Make the text shallower or the piece thicker.")
    if options.fit == "lamp" and len(thicknesses) > 1 and not options.color_zones:
        lamp_comb(options, thicknesses)  # raises when slots would run together
    if options.fit == "box":
        box_slots(options, thicknesses)  # raises when the box is too shallow


def tab_thickness(options):
    return options.slot_width-options.slot_clearance


def tab_span(options, width):
    """The lamp tab's x range under a piece (or comb base) of this width: centered, never longer than the piece."""
    length = min(options.slot_length-2*options.slot_clearance, width)
    return (width-length)/2, (width+length)/2


def box_slots(options, thicknesses):
    """Slots along each spacer comb, front to back: (kind, center from the comb's front end, width, depth), evenly spaced;
    each layer's slot is its thickness plus clearance."""
    length, count = options.box_depth-BOX_BACK, len(thicknesses)
    items = [("layer", thickness+options.comb_clearance, COMB_SLOT) for thickness in thicknesses]
    if options.led_channel:
        items.append(("led", options.led_width, options.led_depth))
    if options.photo_slot:
        items.append(("photo", options.photo_gap, COMB_SLOT))
    room = length-2*COMB_WALL-sum(width for _, width, _ in items)
    gap = room/(len(items)-1) if len(items) > 1 else 0
    if room < 0 or (len(items) > 1 and gap < SLOT_WALL):
        extras = " and its photo and LED slots" if options.photo_slot and options.led_channel else " and its photo slot" if options.photo_slot else " and its LED channel" if options.led_channel else ""
        raise ValueError(f"The box's inner depth of {options.box_depth:g} mm is too shallow for {count} layer{'s' if count > 1 else ''}{extras}. "
                         "Make the box deeper, the layers thinner, or use fewer layers.")
    slots, cursor = [], COMB_WALL if len(items) > 1 else (length-items[0][1])/2
    for kind, width, depth in items:
        slots.append((kind, cursor+width/2, width, depth))
        cursor += width+gap
    return slots


def lamp_comb(options, thicknesses):
    """The comb base's depth, its layer slots' centers from its front edge (layer_spacing apart), and their widths (each
    layer's thickness plus clearance); the slots are centered over the tab."""
    slots, count = [thickness+options.comb_clearance for thickness in thicknesses], len(thicknesses)
    for index, (a, b) in enumerate(zip(slots, slots[1:])):
        if options.layer_spacing-(a+b)/2 < SLOT_WALL-1e-9:
            raise ValueError(f"The layer spacing must leave at least 1.2 mm between the comb's slots; layers {index+1} and {index+2} "
                             f"({thicknesses[index]:g} and {thicknesses[index+1]:g} mm thick) need {(a+b)/2+SLOT_WALL:.1f} mm. "
                             "Space the layers further apart or make them thinner.")
    span = (count-1)*options.layer_spacing+(slots[0]+slots[-1])/2
    depth = max(span+2*COMB_WALL, tab_thickness(options)+2*COMB_WALL)
    first = (depth-span)/2+slots[0]/2
    return depth, [first+index*options.layer_spacing for index in range(count)], slots


# --- Profiles ---------------------------------------------------------------------------------------------

@dataclass
class Sources:
    """Data a design can draw on beyond the terrain: the uploaded route, and the loaded OSM building layer (None: not loaded)."""
    route: dict = None
    buildings: list = None


def grid_sample(grid, uv):
    """Bilinear heights at frame coordinates (u right, v down, 0–1 across the grid)."""
    rows, columns = grid.shape
    x, y = np.clip(uv[:, 0], 0, 1)*(columns-1), np.clip(uv[:, 1], 0, 1)*(rows-1)
    x0, y0 = np.minimum(np.floor(x).astype(int), columns-2), np.minimum(np.floor(y).astype(int), rows-2)
    fx, fy = x-x0, y-y0
    top = grid[y0, x0]*(1-fx)+grid[y0, x0+1]*fx
    bottom = grid[y0+1, x0]*(1-fx)+grid[y0+1, x0+1]*fx
    return top*(1-fy)+bottom*fy


def slice_heights(terrain, options, position=None):
    """Heights (m) along the slice and their distances (m), sampled exactly as the geography page's profile chart."""
    heights = (terrain.elevations.astype(np.float64) if options.source != "shaped"
               else model_elevations(terrain, ModelOptions(relief=options.relief, relief_strength=options.relief_strength)))
    rows, columns = heights.shape
    horizontal = options.direction == "ew"
    last = rows-1 if horizontal else columns-1
    cross = (options.position if position is None else position)/100*last
    a = math.floor(cross)
    b, mix = min(a+1, last), cross-a
    values = heights[a]*(1-mix)+heights[b]*mix if horizontal else heights[:, a]*(1-mix)+heights[:, b]*mix
    length = terrain.width if horizontal else terrain.height
    return np.linspace(0, length, len(values)), values, length


def route_profile(terrain, route):
    """Distance along the route (m) and its elevation, segments joined in order.

    Elevations are the GPX's own, smoothed when the route was stored; without them the terrain is sampled, which needs
    the whole route inside the frame. Kept points are densified to the grid spacing so the samples follow the ground."""
    grid = terrain.elevations.astype(np.float64)
    rows, columns = grid.shape
    step = max(min(terrain.width/(columns-1), terrain.height/(rows-1)), 1.0)
    distances, heights, offset = [], [], 0.0
    for segment in route["segments"]:
        points = np.asarray([point[:2] for point in segment], dtype=np.float64)
        d = along(points)
        elevations = np.asarray([np.nan if len(point) < 3 or point[2] is None else point[2] for point in segment], dtype=np.float64)
        if np.isnan(elevations).any():
            dense = np.unique(np.concatenate((d, np.arange(0, d[-1], step))))
            uv = to_selection(terrain.bounds, np.column_stack((np.interp(dense, d, points[:, 0]), np.interp(dense, d, points[:, 1]))))
            if not ((uv > -1e-6) & (uv < 1+1e-6)).all():
                if route.get("schema_version", 1) < 2:
                    raise ValueError("This route was stored before elevations were kept. Upload the GPX file again, or frame the whole route.")
                raise ValueError("This GPX file has no elevations; re-export it with elevation or frame the whole route.")
            d, elevations = dense, grid_sample(grid, uv)
        distances.append(d+offset)
        heights.append(elevations)
        offset += float(d[-1])
    distances, heights = np.concatenate(distances), np.concatenate(heights)
    distances, keep = np.unique(distances, return_index=True)
    if offset < 10 or len(distances) < 2:
        raise ValueError("The route is too short for a profile.")
    return distances, heights[keep], offset


def with_buildings(terrain, options, position, distances, values, buildings):
    """The slice raised to the tops of the mapped buildings within the corridor: each footprint's span along the slice
    stands at its lowest ground plus the building's height, with straight walls. Returns distances, heights, count."""
    width, height, half = terrain.width, terrain.height, options.building_corridor_m/2
    horizontal = options.direction == "ew"
    cross = position/100*(height if horizontal else width)
    strip = box(0, cross-half, width, cross+half) if horizontal else box(cross-half, 0, cross+half, height)
    low, high = cross-half, cross+half
    spans = []
    for feature in buildings or []:
        top = feature.get("height_m")
        if not finite(top) or top <= 0:
            continue
        for polygon in feature.get("polygons", []):
            outer = np.asarray(polygon.get("outer") or [], dtype=np.float64)
            if len(outer) < 4:
                continue
            outer = outer*(width, height)
            across = outer[:, 1] if horizontal else outer[:, 0]
            if across.max() < low or across.min() > high:
                continue
            shape = make_valid(Polygon(outer, [np.asarray(ring, dtype=np.float64)*(width, height) for ring in polygon.get("holes", []) if len(ring) >= 4]))
            piece = shape.intersection(strip)
            if piece.is_empty:
                continue
            x0, y0, x1, y1 = piece.bounds
            spans.append((x0, x1, top) if horizontal else (y0, y1, top))
    if not spans:
        return distances, values, 0
    length = distances[-1]
    edges = np.clip([edge for a0, a1, _ in spans for edge in (a0-.01, a0, a1, a1+.01)], 0, length)
    samples = np.unique(np.concatenate((distances, edges)))
    ground = np.interp(samples, distances, values)
    tops = ground.copy()
    for a0, a1, top in spans:
        inside = (samples >= a0) & (samples <= a1)
        if inside.any():
            tops[inside] = np.maximum(tops[inside], ground[inside].min()+top)
    return samples, tops, len(spans)


def profile_heights(terrain, options, position=None, sources=None, skyline=None):
    """The trimmed, smoothed profile: x (mm, before mirroring), heights (m), span (m), start (m), and mm per meter.
    A viewpoint layer's skyline angles come from view_layers (computed once for the design), else its first layer's.

    Trim endpoints are interpolated, so the piece starts and ends exactly where asked. Smoothing is a moving average
    over up to 8% of the samples on each side."""
    sources = sources or Sources()
    if options.source == "route":
        if sources.route is None:
            raise ValueError("The uploaded route is no longer available. Upload the GPX file again.")
        distances, values, length = route_profile(terrain, sources.route)
    elif options.source == "ridgeline":
        ridge = ridgeline(terrain, options.ridge_start, options.ridge_end)
        distances, values, length = ridge["distances"], ridge["heights"], ridge["length"]
    elif options.source == "viewpoint":
        distances, values, length = (view_heights(terrain, options) if skyline is None else skyline_profile(skyline, options.view_fov))
    else:
        position = options.position if position is None else position
        distances, values, length = slice_heights(terrain, options, position)
        if options.include_buildings and sources.buildings:
            distances, values, _ = with_buildings(terrain, options, position, distances, values, sources.buildings)
    start, end = options.trim[0]/100*length, options.trim[1]/100*length
    samples = np.concatenate(([start], distances[(distances > start) & (distances < end)], [end]))
    heights = np.interp(samples, distances, values)
    radius = round(options.smoothing/100*len(heights)*.08)
    if radius:
        padded = np.pad(heights, radius, mode="edge")
        heights = np.convolve(padded, np.ones(2*radius+1)/(2*radius+1), mode="valid")
    scale = options.width_mm/(end-start)
    return (samples-start)*scale, heights, end-start, start, scale


def view_layers(terrain, options):
    """A viewpoint's layers, front to back: each one's skyline angles (degrees per direction), its distance (m), and the
    detected ridges used (None for bands). Terrain nearer than view_min_radius_m is left out, and terrain farther than
    view_max_radius_m (when set) is cut off.

    One layer is the whole skyline. Several are the detected ridgelines (view_ridges: layer i is the i-th nearest; their
    positions are ignored) or distance bands: terrain between the layer in front's distance and its own (percent of the
    farthest terrain seen), whose distance is the band's geometric middle. Directions where a layer holds no terrain sit
    just below the lowest skyline, so the shared datum stays near the view."""
    view = viewpoint(terrain, options.view_point, options.view_bearing, options.view_fov, options.view_eye_m,
                     min_radius_m=options.view_min_radius_m, max_radius_m=options.view_max_radius_m)
    specs = layer_specs(options)
    seen = view["angles"][view["angles"] > -90]
    floor = (float(seen.min()) if len(seen) else 0.0)-1
    if len(specs) == 1:
        return {"angles": [np.maximum(view["angles"], floor)], "distances": [float(np.median(view["skyline_m"]))], "ridges": None,
                "ranges": [(options.view_min_radius_m, float(view["farthest"]))], "farthest_m": float(view["farthest"])}
    if options.view_ridges:
        found = ridges(view, len(specs))
        if len(found) < len(specs):
            k = len(found)
            raise ValueError(f"Only {k} separate ridge{'s are' if k > 1 else ' is'} visible from this viewpoint; "
                             f"use {k} layer{'s' if k > 1 else ''} or lower the minimum distance.")
        return {"angles": [np.maximum(ridge["angles"], floor) for ridge in found], "distances": [ridge["distance_m"] for ridge in found], "ridges": found,
                "ranges": [(ridge["near_m"], ridge["far_m"]) for ridge in found], "farthest_m": float(view["farthest"])}
    nearest, angles, distances, ranges = max(float(view["steps"][0]), options.view_min_radius_m), [], [], []
    for far, *_ in specs:
        near = max((spec[0] for spec in specs if spec[0] < far), default=0.0)
        angles.append(np.maximum(band(view, near/100, far/100), floor))
        distances.append(math.sqrt(max(near/100*view["farthest"], nearest)*max(far/100*view["farthest"], nearest)))
        far_m = float(far/100*view["farthest"])
        ranges.append((min(far_m, max(near/100*view["farthest"], options.view_min_radius_m)), far_m))
    return {"angles": angles, "distances": distances, "ridges": None, "ranges": ranges, "farthest_m": float(view["farthest"])}


def view_heights(terrain, options, index=0):
    """One viewpoint layer's skyline as a profile: lengths along a cylinder around the viewer (profiles.skyline_profile)."""
    return skyline_profile(view_layers(terrain, options)["angles"][index], options.view_fov)


def ridge_points(x, heights, datum, base, scale, options):
    """The ridgeline in mm, left to right, with the datum elevation on the base; simplification grows with smoothing
    (a tiny tolerance at 0% drops collinear points on flat ground)."""
    y = (heights-datum)*scale*options.vertical_scale+base
    if options.mirror:
        x, y = options.width_mm-x[::-1], y[::-1]
    line = LineString(np.column_stack((x, y))).simplify(.005+options.smoothing/100*.6, preserve_topology=False)
    return np.asarray(line.coords)


def profile_points(terrain, options, position=None, sources=None):
    """One layer's ridgeline in mm with its own lowest point on the base, and the length of ground it spans (m)."""
    x, heights, span, _, scale = profile_heights(terrain, options, position, sources)
    return ridge_points(x, heights, heights.min(), options.base_mm, scale, options), span


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


def caption(options, width, margin, center):
    """The caption's lines stacked about `center` (lines 1.6 × the cap height apart), aligned left, center, or right."""
    lines = options.text.split("\n")
    if options.text_align == "center" or len(lines) == 1:
        shape, missing = text_shape(options.text, options.text_size)
        if shape.is_empty:
            return shape, missing, 0.0
        x0, _, x1, _ = shape.bounds
        x = {"left": margin+(x1-x0)/2, "center": width/2, "right": width-margin-(x1-x0)/2}[options.text_align]
        return translate(shape, x, center), missing, x1-x0
    pitch, shapes, missing, widest = options.text_size*1.6, [], [], 0.0
    for index, line in enumerate(lines):
        shape, lost = text_shape(line, options.text_size)
        missing.extend(lost)
        if shape.is_empty:
            continue
        x0, _, x1, _ = shape.bounds
        widest = max(widest, x1-x0)
        x = margin+(x1-x0)/2 if options.text_align == "left" else width-margin-(x1-x0)/2
        shapes.append(translate(shape, x, center+((len(lines)-1)/2-index)*pitch))
    return unary_union(shapes) if shapes else Polygon(), tuple(dict.fromkeys(missing)), widest


def text_block_lines(value):
    """The text editor's lines, validated: up to MAX_TEXT_LINES of {text, size (cap height, mm), style, tracking (letter
    spacing, % of the cap height)}; blank lines at the top and bottom are dropped. Returns a tuple (empty: no block)."""
    if value is None or value == [] or value == ():
        return ()
    if not isinstance(value, (list, tuple)) or len(value) > MAX_TEXT_LINES:
        raise ValueError(f"A text block holds 1 to {MAX_TEXT_LINES} lines.")
    lines = []
    for index, line in enumerate(value, 1):
        if not isinstance(line, dict) or not isinstance(line.get("text", ""), str):
            raise ValueError(f"Text line {index} needs its text, size, style, and letter spacing.")
        words = " ".join(line.get("text", "").split())
        size, style, tracking = line.get("size", 5), line.get("style", "bold"), line.get("tracking", 0)
        if len(words) > 60:
            raise ValueError(f"Text line {index} is longer than 60 characters. Shorten it.")
        if not finite(size) or not 1 <= size <= 40:
            raise ValueError(f"Text line {index}'s size must be between 1 and 40 mm (the height of its capital letters).")
        if style not in FONT_STYLES:
            raise ValueError(f"Text line {index}'s style must be regular, bold, italic, or bold-italic.")
        if not finite(tracking) or not -20 <= tracking <= 100:
            raise ValueError(f"Text line {index}'s letter spacing must be between -20 and 100 percent of its letter height.")
        lines.append((words, float(size), style, float(tracking)))
    while lines and not lines[-1][0]:
        lines.pop()
    while lines and not lines[0][0]:
        lines.pop(0)
    return tuple(lines)


def text_block(options, width, margin, center):
    """The text editor's block: each line in its own size, style, and letter spacing, its baseline line_spacing × its cap
    height below the line above (a blank line still takes its space); lines aligned left, center, or right within the
    block, and the block placed on the base like a caption (stencil lines bridged at their own size). Returns the shape,
    the characters the fonts cannot draw, and the widest line (mm)."""
    shapes, missing, baseline = [], [], 0.0
    for index, (words, size, style, tracking) in enumerate(options.text_lines):
        if index:
            baseline -= options.line_spacing*size
        if not words:
            continue
        shape, _, lost = line_shape(words, size, style, tracking)
        missing.extend(lost)
        if shape.is_empty:
            continue
        shapes.append(translate(stencil_bridges(shape, size) if options.text_style == "stencil" else shape, 0, baseline))
    if not shapes:
        return Polygon(), tuple(dict.fromkeys(missing)), 0.0
    widest = max(shape.bounds[2]-shape.bounds[0] for shape in shapes)
    aligned = []
    for shape in shapes:
        x0, _, x1, _ = shape.bounds
        aligned.append(translate(shape, {"left": -x0, "center": (widest-x0-x1)/2, "right": widest-x1}[options.text_align]))
    block = unary_union(aligned)
    x0, y0, x1, y1 = block.bounds
    x = {"left": margin, "center": width/2-widest/2, "right": width-margin-widest}[options.text_align]
    return make_valid(translate(block, x-x0, center-(y0+y1)/2)), tuple(dict.fromkeys(missing)), widest


def text_block_json(value):
    """The text editor's live preview: the block's outlines in mm, centered on 0, 0 (y up), its size, and what the fonts
    cannot draw, from the same layout the piece uses. value: {text_lines, text_align, line_spacing, text_style}."""
    value = value if isinstance(value, dict) else {}
    options = SilhouetteOptions.from_dict({key: value[key] for key in ("text_lines", "text_align", "line_spacing", "text_style") if key in value})
    shape, missing, _ = text_block(options, 0, 0, 0) if options.text_lines else (Polygon(), (), 0)
    if not shape.is_empty:
        x0, y0, x1, y1 = shape.bounds
        shape = translate(shape, -(x0+x1)/2, -(y0+y1)/2)
    x0, y0, x1, y1 = shape.bounds if not shape.is_empty else (0, 0, 0, 0)
    return {"text": rings(shape), "width_mm": round(x1-x0, 2), "height_mm": round(y1-y0, 2), "missing": list(missing)}


def onto(shape, keep):
    """The caption moved the least so it lies on material (inside keep): (shape, moved). Centers where its bounding box fits
    are keep eroded by the box (y scaled so the box is a square, then a mitred inset); the nearest one is tried, then
    nudged toward the middle of that region until the letters fit. A caption that fits nowhere stays where it is."""
    if keep.is_empty or keep.buffer(.05).contains(shape):
        return shape, False
    x0, y0, x1, y1 = shape.bounds
    half_w, half_h, cx, cy = (x1-x0)/2, max((y1-y0)/2, .1), (x0+x1)/2, (y0+y1)/2
    ratio = half_w/half_h
    region = make_valid(scale(scale(keep, 1, ratio, origin=(0, 0)).buffer(-half_w, join_style="mitre"), 1, 1/ratio, origin=(0, 0)))
    if region.is_empty:
        return shape, False
    target, inner = nearest_points(region, Point(cx, cy))[0], region.representative_point()
    for _ in range(16):
        moved = translate(shape, target.x-cx, target.y-cy)
        if keep.buffer(.05).contains(moved):
            return moved, True
        target = Point(target.x+(inner.x-target.x)*.2, target.y+(inner.y-target.y)*.2)
    return shape, False


def block_height(options):
    if options.text_lines:  # first cap height, then each baseline step down
        return options.text_lines[0][1]+sum(options.line_spacing*line[1] for line in options.text_lines[1:])
    lines = len(options.text.split("\n")) if options.text else 0
    return lines*options.text_size+max(lines-1, 0)*.6*options.text_size


def label(text, size, x, y):
    shape, _ = text_shape(text, size)
    return translate(shape, x, y) if not shape.is_empty else shape


def tick_marks(options, start, span, scale, y):
    """Engraved ticks every tick_every miles or kilometers from the route's start, labeled where they have room."""
    unit = MILE_M if options.units == "ft" else 1000.0
    step = options.tick_every*unit
    ticks, labels, positions = [], [], []
    for count in range(1, int((start+span)/step+1e-9)+1):
        distance = count*step
        if distance <= start:
            continue
        x = (distance-start)*scale
        if options.mirror:
            x = options.width_mm-x
        if not WALL+TICK_WIDTH < x < options.width_mm-WALL-TICK_WIDTH:
            continue
        positions.append((x, count))
        ticks.append(box(x-TICK_WIDTH/2, y, x+TICK_WIDTH/2, y+TICK_LENGTH))
    if not positions:
        return Polygon(), 0
    pitch = step*scale
    names = [f"{count*options.tick_every:g}" for _, count in positions]
    room = max(len(name) for name in names)*TICK_LABEL*.75+2
    every = next(value for value in (1, 2, 5, 10, 20, 50, 100, 10**9) if pitch*value >= room)
    unit = " mi" if options.units == "ft" else " km"
    for (x, count), name in zip(positions, names):
        if count % every and (x, count) != positions[-1]:
            continue
        if not labels:
            name += unit  # the first label carries the unit
        shape = label(name, TICK_LABEL, x, y-.8-TICK_LABEL/2)
        x0, _, x1, _ = shape.bounds
        if x0 > WALL and x1 < options.width_mm-WALL and not any(shape.intersects(other) for other in labels):
            labels.append(shape)
    return unary_union(ticks+labels), len(ticks)


def cloud_panel(width, height):
    """Connected cartoon-cloud silhouette with a flat base, printable as one panel."""
    radius = min(width*.09, height*.24)
    baseline = height-1.6*radius
    puffs = [Point(width*x, baseline).buffer(radius*scale, quad_segs=24)
             for x, scale in zip((0, .13, .29, .48, .68, .86, 1), (.9, 1.3, 1.05, 1.6, 1.1, 1.4, .9))]
    return orient(unary_union([box(0, 0, width, baseline), *puffs]).intersection(box(0, 0, width, height)))


def printable(outline, feature):
    """A panel outline without spikes and slivers narrower than `feature` mm, which are too thin to print or snap off: a
    morphological opening with mitred joins (so square corners stay square and the base stays at y = 0), keeping only what
    still stands on the base. Returns the outline and the area trimmed (mm²)."""
    if feature <= 0:
        return outline, 0.0
    opened = make_valid(outline.buffer(-feature/2, join_style="mitre").buffer(feature/2, join_style="mitre"))
    kept = [part for part in geometry_parts(opened, "Polygon") if part.bounds[1] < 1e-6]
    if not kept:
        return outline, 0.0
    trimmed = orient(make_valid(unary_union(kept)).buffer(0)) if len(kept) > 1 else orient(kept[0])
    return trimmed, max(0.0, outline.area-trimmed.area)


def layout(terrain, options, sources=None):
    """Everything drawn or cut in 2D: each layer's body (with wall holes and stencil cuts), the front layer's text and
    markings, mount marks, the fit's parts, and warnings."""
    sources = sources or Sources()
    warnings, notes = [], []
    specs = layer_specs(options)
    views = view_layers(terrain, options) if options.source == "viewpoint" else None  # once: ridges are found for the whole design
    curves = [profile_heights(terrain, options, spec[0], sources, None if views is None else views["angles"][index]) for index, spec in enumerate(specs)]
    # Keep the original detection and shared datum. Deleting a ridge must not regroup the others or move their curves.
    datum = min(float(heights.min()) for _, heights, _, _, _ in curves)
    edits = {index: (deleted, curve) for index, deleted, curve in options.ridge_edits}
    indices = [index for index in range(len(specs)) if not edits.get(index, (False, ()))[0]]
    specs = [specs[index] for index in indices]
    curves = [curves[index] for index in indices]
    if views:
        views = dict(views, angles=[views["angles"][i] for i in indices], distances=[views["distances"][i] for i in indices],
                     ranges=[views["ranges"][i] for i in indices],
                     ridges=None if views["ridges"] is None else [views["ridges"][i] for i in indices])
    if options.clouds and len(indices) == 1:
        notes.append("The cloud background is left out while only one terrain ridgeline remains.")
    options = active_ridge_options(options)
    thicknesses = layer_thicknesses(options, views["distances"] if views else None)
    check_thickness(options, thicknesses)
    # Layers share one datum, so heights compare truly between them; a single layer sits its lowest point on the base.
    width = options.width_mm
    limit = options.box_height-COMB_FLOOR-.5 if options.fit == "box" else None
    multi = len(specs) > 1 and not options.color_zones
    layers, trimmed = [], 0.0
    for index, ((position, base, color, _), (x, heights, span, start, scale)) in enumerate(zip(specs, curves)):
        base = options.base_mm if options.color_zones else base  # one piece: every ridge on the same base strip
        points = ridge_points(x, heights, datum, base, scale, options)
        custom = edits.get(indices[index], (False, ()))[1]
        if custom:
            points = np.asarray(custom, dtype=np.float64)*width
            points[:, 1] += base
        outline = orient(make_valid(Polygon([(0, 0), *points.tolist(), (width, 0)])).buffer(0))
        if options.fit in ("lamp", "box"):
            outline, removed = printable(outline, options.min_feature_mm)
            trimmed += removed
        height = float(outline.bounds[3]) if options.fit in ("lamp", "box") else float(points[:, 1].max())
        name = "Silhouette" if not multi else f"Layer {index+1}" + (" (front)" if index == 0 else " (back)" if index == len(specs)-1 else "")
        if limit is not None and height > limit:
            outline = orient(make_valid(outline.intersection(box(0, 0, width, limit))))
            warnings.append(f"{name if multi else 'The piece'} is {height:.0f} mm tall, more than the box's inner height allows "
                            f"({limit:.0f} mm above the combs), so its top is cut flat. Lower the vertical scale or the base heights.")
            height = limit
        layers.append({"name": name, "ridge_index": indices[index], "position": position, "base": base, "color": color, "outline": outline, "body": outline, "thickness": thicknesses[index],
                       "distance_m": None if views is None else float(views["distances"][index]),
                       "distance_range_m": None if views is None else views["ranges"][index], "kind": "terrain",
                       "points": points, "height": height, "lowest": float(points[:, 1].min()), "span_m": span, "start_m": start, "scale": scale})
    palette = distance_palette(options, len(layers)) if by_color(options) else None
    for layer, color in zip(layers, palette or []):
        layer["color"] = color
    ridge_curves = [{"layer": layer["ridge_index"], "name": layer["name"], "base_mm": layer["base"], "color": layer["color"],
                     "curve": np.column_stack((layer["points"][:, 0], np.minimum(layer["points"][:, 1], limit) if limit is not None else layer["points"][:, 1])).round(5).tolist()}
                    for layer in layers]
    if options.clouds:
        rear = layers[-1]
        step = rear["base"]-layers[-2]["base"]
        cloud_base = min(120, rear["base"]+max(0, step))
        terrain_height = max(layer["height"] for layer in layers)
        cloud_height = max(terrain_height+width*.16, cloud_base+width*.12)
        if limit is not None:
            cloud_height = min(cloud_height, limit)
            if cloud_height-terrain_height < width*.08:
                warnings.append("The box leaves little sky above the terrain for clouds. Lower the vertical scale or use a taller box.")
        cloud = cloud_panel(width, cloud_height)
        rear["name"] = rear["name"].replace(" (back)", "")
        layers.append({**rear, "name": f"Layer {len(layers)+1} · Clouds (back)", "kind": "cloud", "position": None,
                       "base": cloud_base, "color": options.cloud_color, "outline": cloud, "body": cloud,
                       "thickness": rear["thickness"], "distance_m": None, "distance_range_m": None,
                       "points": np.asarray(cloud.exterior.coords), "height": cloud_height, "lowest": cloud_base})
        check_thickness(options, [layer["thickness"] for layer in layers])
        notes.append("Clouds are a decorative rear panel, not mapped terrain; the base includes an extra slot for it.")
    if trimmed > .5:
        notes.append(f"Spikes and slivers narrower than {options.min_feature_mm:g} mm were trimmed from the panels so they print "
                     "and don't snap; lower Minimum feature to keep them.")
    # A rear panel hidden behind the ones in front adds a part but no ridge: it should show somewhere by SHOW_MM.
    if multi and options.fit in ("lamp", "box"):
        for index in range(1, len(layers)):
            shown = layers[index]["outline"].difference(unary_union([layer["outline"] for layer in layers[:index]]))
            if shown.is_empty or shown.buffer(-SHOW_MM/2).is_empty:
                warnings.append(f"{layers[index]['name']} barely shows above the layers in front (nowhere {SHOW_MM:g} mm). "
                                "Raise the base step or the vertical scale, or use fewer layers.")
    zones = None
    if options.color_zones:
        piece, zones = zone_layout(layers)
        layers = [piece]
    front = layers[0]
    outline, base, height = front["outline"], front["base"], front["height"]
    mounts = []
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
    # The base holds, bottom to top: medal pegs, the caption (with START and FINISH at its ends), and distance ticks. Layers in a
    # lamp's comb base hide their bottom in its slots, and a box's spacer combs hide their ends.
    margin = max(text_margin(options), COMB_STRIP+2 if options.fit == "box" else 0)
    pegs = options.peg_count > 0
    hidden = COMB_SLOT+.5 if options.fit == "lamp" and multi else 0.0
    bottom = options.peg_diameter+2*WALL if pegs else hidden
    top = base-(WALL+TICK_LENGTH+.8+TICK_LABEL+.8) if options.ticks else base
    banded = pegs or options.ticks or "\n" in options.text or options.start_finish or hidden
    near = zones[0]["polygon"] if zones else outline  # text and markings stay on the nearest zone, the base strip's
    room = near.buffer(-WALL) if options.text_style != "emboss" else near
    engrave_room = near.buffer(-WALL)
    text, markings, ticks, text_box = Polygon(), [], 0, None
    if options.text:
        center = (bottom+top)/2 if banded else base/2
        shape, missing, line_width = text_block(options, width, margin, center) if options.text_lines else caption(options, width, margin, center)
        if missing:
            warnings.append(f"The font cannot draw {''.join(missing)}; those characters are left as spaces.")
        if not shape.is_empty:
            x0, y0, x1, y1 = shape.bounds
            default, moved, positioned = ((x0+x1)/2, (y0+y1)/2), False, options.text_x is not None
            if positioned:
                # A moved caption stays on material: off the comb slots and the box's comb ends, inside the nearest zone, and
                # WALL in from the edges unless raised; dragged off the piece, it comes back to the nearest place it fits.
                keep = room
                if hidden:
                    keep = keep.difference(box(-1, -1, width+1, hidden))
                if options.fit == "box":
                    keep = keep.difference(unary_union([box(-1, -1, COMB_STRIP+2, COMB_SLOT+.5), box(width-COMB_STRIP-2, -1, width+1, COMB_SLOT+.5)]))
                shape, moved = onto(translate(shape, options.text_x-default[0], options.text_y-default[1]), make_valid(keep))
                if moved:
                    notes.append("The caption was moved back onto the piece: it must sit on material, clear of the edges and comb slots.")
            x0, y0, x1, y1 = shape.bounds
            text_box = {"x": round((x0+x1)/2, 3), "y": round((y0+y1)/2, 3), "x0": round(x0, 3), "y0": round(y0, 3), "x1": round(x1, 3), "y1": round(y1, 3),
                        "placed": positioned, "moved": moved, "default": [round(default[0], 3), round(default[1], 3)]}
            placed = stencil_bridges(shape, options.text_size) if options.text_style == "stencil" and not options.text_lines else shape
            text = make_valid(placed.intersection(room))
            need = bottom+block_height(options)+1.6+(base-top)
            if banded and need > base+.01 and not positioned:
                warnings.append(f"The caption{', ticks,' if options.ticks else ''}{' and pegs' if pegs else ''} need a base of at least {math.ceil(need)} mm. Raise the base height.")
            elif text.area < placed.area*.98:
                warnings.append("The text runs past the edge of the piece and is trimmed. Make it smaller or the base taller."
                                if not positioned else "The caption does not fit on the piece anywhere, so it is trimmed. Make it smaller or shorter.")
            if line_width > width-2*margin and not positioned:
                warnings.append("The text is wider than the space between the mounts. Shorten it or make it smaller.")
            for number, (words, size, _, _) in enumerate(options.text_lines, 1):
                if words and options.text_style == "stencil" and size < 4:
                    warnings.append(f"Line {number} is under 4 mm tall: stencil letters that small lose their bridges and islands. Make it at least 4 mm.")
                elif words and size < 2:
                    warnings.append(f"Line {number} is under 2 mm tall and may not print clearly. Make it larger.")
            if options.text_size < 3 and not options.text_lines:
                warnings.append("Text under 3 mm tall may not print clearly. Make it larger.")
    if options.start_finish:
        size = max(3.0, min(options.text_size*.7, 5.0))
        center = (bottom+top)/2
        ends = [label(word, size, 0, center) for word in ("START", "FINISH")]
        left, right = (ends[1], ends[0]) if options.mirror else ends
        left = translate(left, margin-left.bounds[0])
        right = translate(right, width-margin-right.bounds[2])
        if not text.is_empty and (text.intersects(left.buffer(1.5)) or text.intersects(right.buffer(1.5))):
            warnings.append("The caption runs into the START and FINISH labels. Shorten it or make it smaller.")
        markings.extend((left, right))
    if options.ticks:
        first = front["start_m"] if options.source == "route" else 0.0
        shape, ticks = tick_marks(options, first, front["span_m"], front["scale"], base-WALL-TICK_LENGTH)
        markings.append(shape)
        if not ticks:
            warnings.append("No distance ticks fall on the piece. Make the ticks closer together.")
    marks = make_valid(unary_union(markings).intersection(engrave_room)) if markings else Polygon()
    if not text.is_empty and options.text_style != "stencil":
        marks = marks.difference(text.buffer(.3))  # never two engravings in one place
    peg_marks = []
    if pegs:
        inset = margin+options.peg_diameter/2
        span = width-2*inset
        y = WALL+options.peg_diameter/2
        circles = [Point(inset+(index+.5)*span/options.peg_count, y).buffer(options.peg_diameter/2, quad_segs=16) for index in range(options.peg_count)]
        if span <= 0 or not all(outline.buffer(-.4).contains(circle) for circle in circles):
            warnings.append(f"The medal pegs do not fit on the base, so they are left out. Raise the base to at least {math.ceil(options.peg_diameter+2*WALL)} mm or use fewer pegs.")
        else:
            near = unary_union([circle.buffer(.6) for circle in circles])
            if near.intersects(text) or near.intersects(marks) or any(near.intersects(hole) for hole in holes):
                warnings.append("A medal peg overlaps the caption, the markings, or a wall hole. Raise the base, shorten the caption, or use fewer pegs.")
            peg_marks = [{"kind": "peg", "x": round(circle.centroid.x, 3), "y": round(y, 3), "d": options.peg_diameter, "length": options.peg_length}
                         for circle in circles]
    pin = None
    if options.summit_pin:
        index = int(np.argmax(front["points"][:, 1]))
        x, r = float(front["points"][index, 0]), options.pin_diameter/2
        x = min(max(x, r+WALL), width-r-WALL)
        need = box(x-r-.6, height-options.pin_depth, x+r+.6, height-1.5)
        if (min(zone["thickness"] for zone in zones) if zones else front["thickness"]) < options.pin_diameter+1.2:
            warnings.append(f"The piece must be at least {options.pin_diameter+1.2:.1f} mm thick for the summit pin hole, so it is left out. Make it thicker.")
        elif height-options.pin_depth < base or not outline.buffer(.01).contains(need):
            warnings.append("The summit is too narrow or too low for the pin hole, so it is left out. Smooth the profile or raise the vertical scale.")
        else:
            pin = {"kind": "pin", "x": round(x, 3), "y0": round(height-options.pin_depth, 3), "y1": round(height, 3), "d": options.pin_diameter}
    body = outline.difference(text) if options.text_style == "stencil" and not text.is_empty else outline
    if len(geometry_parts(body, "Polygon")) > 1:
        warnings.append("The stencil text splits the piece into separate parts. Move or shrink the text.")
    front.update(outline=outline, body=body)
    if zones:
        cuts = front["piece"].difference(body) if body is not front["piece"] else Polygon()  # wall holes and stencil letters
        for zone in zones:
            zone["body"] = make_valid(zone["polygon"].difference(cuts)) if not cuts.is_empty else zone["polygon"]
    for layer in layers:
        if layer["lowest"] < 3:
            warnings.append(f"The thinnest point of {layer['name'].lower() if multi else 'the piece'} is {layer['lowest']:.1f} mm tall and may snap. Raise the base.")
    fit = fit_layout(options, layers, warnings, notes)
    if zones:
        fit["parts"][0]["size"][2] = max(zone["thickness"] for zone in zones)
    # The filaments a 3MF uses: the layers' (or zones') colors, the text's in its own color, and the fit parts' and feet's.
    fit_color = palette[-1] if palette else options.body_color
    colors = [zone["color"] for zone in zones] if zones else [layer["color"] for layer in layers]
    if (not text.is_empty and options.text_style != "stencil") or not marks.is_empty:
        colors.append(options.text_color)
    if fit["comb_base"] or fit["combs"] or options.mount == "stand":
        colors.append(fit_color)
    colors = list(dict.fromkeys(colors))
    if by_color(options) and len(colors) > 4:
        warnings.append(COLOR_LIMIT)
    for part in fit["parts"]:
        if max(part["size"][:2]) > BED_MM:
            warnings.append(f"{part['name']} is {part['size'][0]:.0f} × {part['size'][1]:.0f} mm, larger than a {BED_MM} mm printer bed. "
                            "Make it narrower or lower the vertical scale.")
    if options.mount == "stand" and front["thickness"] < 2.4:
        warnings.append("A piece thinner than 2.4 mm may wobble in its stand. Make it thicker.")
    if options.include_buildings and options.source != "route" and sources.buildings is None:
        warnings.append("Turn on the Buildings map layer and wait for it to load to include buildings.")
    if min(len(layer["points"]) for layer in layers) < 8:
        warnings.append("The profile has very few samples, so it looks coarse. Generate a denser grid or choose a longer slice.")
    return {"layers": layers, "body": body, "outline": outline, "text": text, "markings": marks, "points": front["points"],
            "mounts": mounts+peg_marks+([pin] if pin else []), "pegs": peg_marks, "pin": pin, "ticks": ticks, "fit": fit,
            "warnings": warnings, "notes": notes, "width": width, "height": max(layer["height"] for layer in layers),
            "lowest": front["lowest"], "span_m": front["span_m"], "ridges": views["ridges"] if views else None,
            "view_farthest_m": None if views is None else views["farthest_m"], "text_box": text_box,
            "zones": zones, "colors": colors, "fit_color": fit_color, "ridge_curves": ridge_curves}


def zone_layout(layers):
    """One flat piece from a viewpoint's layers (on one datum and base strip), nearest first: zone 1 is the nearest ridge's
    outline with the base strip, zone k what of ridge k shows above the nearer zones. Slivers thinner than 0.2 mm are
    dropped, and the next zone fills down into them, so the zones tile the piece. Returns the piece (as one layer) and the
    zones that show, each {number, name, color, thickness, distance_m, polygon}."""
    zones, covered, total = [], Polygon(), len(layers)
    for number, layer in enumerate(layers, 1):
        shape = make_valid(layer["outline"].difference(covered)) if zones else layer["outline"]
        kept = [part for part in geometry_parts(shape, "Polygon") if part.area > .5 and 2*part.area/part.length > .2]
        if not kept:
            continue
        polygon = orient(unary_union(kept)) if len(kept) == 1 else unary_union(kept)
        zones.append({"number": number, "name": f"Zone {number}" + (" (nearest)" if number == 1 else " (farthest)" if number == total else ""),
                      "color": layer["color"], "thickness": layer["thickness"], "distance_m": layer["distance_m"], "polygon": polygon})
        covered = unary_union([covered, polygon])
    outline = orient(make_valid(unary_union([zone["polygon"] for zone in zones])).buffer(0))
    # The skyline over every ridge: the highest of them at each x.
    xs = np.unique(np.concatenate([layer["points"][:, 0] for layer in layers]))
    top = np.max([np.interp(xs, layer["points"][:, 0], layer["points"][:, 1]) for layer in layers], axis=0)
    front = layers[0]
    piece = front | {"name": "Silhouette", "outline": outline, "body": outline, "piece": outline, "points": np.column_stack((xs, top)),
                     "height": float(top.max()), "lowest": float(top.min()), "color": zones[0]["color"], "thickness": zones[0]["thickness"]}
    return piece, zones


def zone_groups(shapes):
    """The color zones merged by color (one 3MF part each): [(name, color, zones)], nearest first."""
    groups = {}
    for zone in shapes["zones"]:
        groups.setdefault(zone["color"], []).append(zone)
    return [(members[0]["name"] if len(members) == 1 else "Zones " + ", ".join(str(zone["number"]) for zone in members), color, members)
            for color, members in groups.items()]


def fit_layout(options, layers, warnings, notes):
    """The lamp tab, comb base, or spacer combs, where each layer stands in the assembly (y: its bottom, z: its back face;
    the lamp slot or the box's front-to-back center is z = 0), and the parts list."""
    width, count = options.width_mm, len(layers)
    thicknesses = [layer["thickness"] for layer in layers]
    parts = [{"name": layer["name"], "size": [round(width, 1), round(layer["height"], 1), layer["thickness"]], "count": 1} for layer in layers]
    result = {"kind": options.fit, "parts": parts, "placements": [{"y": 0.0, "z": 0.0} for _ in layers], "tab": None, "comb_base": None, "combs": None, "box": None}
    if options.fit == "lamp":
        t = tab_thickness(options)
        x0, x1 = tab_span(options, width)
        result["tab"] = {"x0": round(x0, 3), "x1": round(x1, 3), "y0": -options.slot_depth, "y1": 0.0, "thickness": round(t, 3), "z": 0.0}
        if x1-x0 < options.slot_length-2*options.slot_clearance-1e-6:
            warnings.append(f"The piece is narrower than the lamp's slot, so its tab is only {x1-x0:.0f} mm long and may wobble. "
                            f"Widen it to at least {math.ceil(options.slot_length-2*options.slot_clearance)} mm.")
        if count == 1:
            # The tab is flush with the piece's back face, so both print flat on the bed.
            result["placements"] = [{"y": 0.0, "z": round(-t/2, 3)}]
            parts[0]["name"] += " with lamp tab"
            if thicknesses[0] < t-1e-6:
                notes.append(f"The piece is thinner than the {t:g} mm tab, so the tab stands {t-thicknesses[0]:.1f} mm proud of its front face; it still prints flat.")
        else:
            depth, centers, slots = lamp_comb(options, thicknesses)
            result["comb_base"] = {"width": round(width, 3), "depth": round(depth, 3), "height": COMB_FLOOR+COMB_SLOT, "floor": COMB_FLOOR,
                                   "slots": [round(center, 3) for center in centers], "slot_widths": [round(slot, 3) for slot in slots],
                                   "slot_width": round(max(slots), 3)}
            result["placements"] = [{"y": COMB_FLOOR, "z": round(depth/2-center-thickness/2, 3)} for center, thickness in zip(centers, thicknesses)]
            parts.append({"name": "Comb base with lamp tab", "size": [round(width, 1), round(depth, 1), COMB_FLOOR+COMB_SLOT+options.slot_depth], "count": 1})
    elif options.fit == "box":
        slots = box_slots(options, thicknesses)
        length = options.box_depth-BOX_BACK
        result["combs"] = {"length": round(length, 3), "width": COMB_STRIP, "height": COMB_FLOOR+COMB_SLOT, "floor": COMB_FLOOR,
                           "slots": [{"kind": kind, "center": round(center, 3), "width": round(slot, 3), "depth": depth} for kind, center, slot, depth in slots]}
        result["box"] = {"width": options.box_width, "height": options.box_height, "depth": options.box_depth}
        centers = [center for kind, center, _, _ in slots if kind == "layer"]
        result["placements"] = [{"y": COMB_FLOOR, "z": round(options.box_depth/2-center-thickness/2, 3)} for center, thickness in zip(centers, thicknesses)]
        parts.append({"name": "Spacer comb", "size": [COMB_STRIP, round(length, 1), COMB_FLOOR+COMB_SLOT], "count": 2})
    return result


def rings(geometry):
    return [{"outer": np.round(polygon.exterior.coords, 3).tolist(), "holes": [np.round(ring.coords, 3).tolist() for ring in polygon.interiors]}
            for polygon in geometry_parts(geometry, "Polygon")]


def largest(geometry):
    found = rings(geometry)
    return max(found, key=lambda ring: Polygon(ring["outer"]).area) if found else {"outer": [], "holes": []}


def thickest(shapes):
    return max(item["thickness"] for item in shapes["zones"] or shapes["layers"])


def outline_json(terrain, options, sources=None):
    """The client preview: outlines, text, markings, and mount marks in mm (y up, x from 0 at the left), the fit and the
    assembly, plus size and hints. No solids are built here: it answers every slider move."""
    shapes = layout(terrain, options, sources)
    fit = shapes["fit"]
    layers = [{"name": layer["name"], "outline": largest(layer["outline"]), "color": layer["color"], "position": layer["position"], "kind": layer["kind"],
               "base_mm": layer["base"], "height_mm": round(layer["height"], 3), "thickness_mm": layer["thickness"], **placement,
               **({} if layer["distance_m"] is None else {"distance_m": round(layer["distance_m"], 1),
                                                          "distance_range_m": [round(value, 1) for value in layer["distance_range_m"]]})}
              for layer, placement in zip(shapes["layers"], fit["placements"])]
    return {"outline": largest(shapes["outline"]), "text": rings(shapes["text"]), "markings": rings(shapes["markings"]), "text_box": shapes["text_box"],
            "text_style": options.text_style, "mount": shapes["mounts"], "layers": layers,
            "ridge_curves": shapes["ridge_curves"],
            "fit": {key: value for key, value in fit.items() if key not in ("parts", "placements")}, "parts": fit["parts"],
            "width_mm": round(shapes["width"], 3), "height_mm": round(shapes["height"], 3), "thickness_mm": thickest(shapes),
            "zones": [{"number": zone["number"], "name": zone["name"], "color": zone["color"], "thickness_mm": zone["thickness"], "polygons": rings(zone["body"]),
                       **({} if zone["distance_m"] is None else {"distance_m": round(zone["distance_m"], 1)})} for zone in shapes["zones"] or []],
            "colors": shapes["colors"],
            "ridges": [{"distance_m": round(ridge["distance_m"], 1), "coverage": round(ridge["coverage"], 3)} for ridge in shapes["ridges"] or []],
            "view_farthest_m": None if shapes["view_farthest_m"] is None else round(shapes["view_farthest_m"], 1),
            "min_profile_mm": round(shapes["lowest"], 3), "slice_length_m": round(shapes["span_m"], 2), "ticks": shapes["ticks"],
            "profile": options.source if options.source in ("route", "ridgeline", "viewpoint") else "slice", "points": len(shapes["points"]),
            "warnings": shapes["warnings"], "notes": shapes["notes"]}


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


def cube(x0, y0, z0, x1, y1, z1):
    return mf.Manifold.cube((x1-x0, y1-y0, z1-z0)).translate((x0, y0, z0))


def union(solids):
    solids = [solid for solid in solids if not solid.is_empty()]
    return closed(mf.Manifold.batch_boolean(solids, mf.OpType.Add)) if len(solids) > 1 else solids[0]


def foot(options, x, y, depth, thickness):
    """One stand foot, flat on the bed: a block with a slot open along its length, the piece's thickness plus clearance wide."""
    length, height, slot = foot_length(options), STAND_FLOOR+STAND_SLOT_DEPTH, thickness+CLEARANCE
    block = mf.Manifold.cube((length, depth, height)).translate((x, y, 0))
    cutter = mf.Manifold.cube((length+2, slot, STAND_SLOT_DEPTH+1)).translate((x-1, y+depth/2-slot/2, STAND_FLOOR))
    return closed(block-cutter)


def comb_base(options, fit):
    """The lamp's comb base, printed upside down: its layer slots open on the bed, the tab standing on top. Each slot's mouth
    is chamfered (SLOT_CHAMFER, less where the walls between slots are thin), since the first layer squashes outward and
    would narrow it; the chamfer also guides a panel in."""
    comb, t = fit["comb_base"], tab_thickness(options)
    width, depth, height = comb["width"], comb["depth"], comb["height"]
    block = cube(0, 0, 0, width, depth, height)
    # Slot centers are measured from the front edge, which is y = depth here (front ends up toward +z when turned over).
    spans = [(depth-center-slot/2, depth-center+slot/2) for center, slot in zip(comb["slots"], comb["slot_widths"])]
    walls = [spans[-1][0]]+[a[0]-b[1] for a, b in zip(spans, spans[1:])]+[depth-spans[0][1]]
    chamfer = float(np.clip((min(walls)-.6)/2, 0, SLOT_CHAMFER))
    cutters = [cube(-1, y0, -1, width+1, y1, COMB_SLOT) for y0, y1 in spans]
    if chamfer > .05:
        cutters += [mf.Manifold.batch_hull([cube(-1, y0-chamfer, -1, width+1, y1+chamfer, 0), cube(-1, y0, chamfer-.01, width+1, y1, chamfer)])
                    for y0, y1 in spans]
    x0, x1 = tab_span(options, width)
    tab = cube(x0, depth/2-t/2, height-.01, x1, depth/2+t/2, height+options.slot_depth)
    return closed(union([closed(block-union(cutters)), tab]))


def spacer_comb(options, fit):
    """One spacer comb, flat on the bed: slots across its top for the layers, the LED strip, and the photo; front end at y = 0."""
    comb = fit["combs"]
    block = cube(0, 0, 0, comb["width"], comb["length"], comb["height"])
    cutters = [cube(-1, slot["center"]-slot["width"]/2, comb["height"]-slot["depth"], comb["width"]+1, slot["center"]+slot["width"]/2, comb["height"]+1)
               for slot in comb["slots"]]
    return closed(block-union(cutters))


def layer_parts(options, shapes, index):
    """One layer's named parts in print position (front face up), each at its own thickness: the body with its tab, pegs,
    and pin hole, and for the front layer its text and markings when they are a separate color. Layers of a design with
    several are named with their thickness ("Layer 2 · 2.4 mm"), so the files say which is which."""
    layer, fit = shapes["layers"][index], shapes["fit"]
    thickness = layer["thickness"]
    name = f"{layer['name']} · {thickness:.1f} mm" if len(shapes["layers"]) > 1 else layer["name"]
    zoned = []  # color zones: one part per color, each zone at its own thickness from the flat back, so steps stand out in front
    if shapes["zones"]:
        zoned = [(group, color, union([extrude(zone["body"], zone["thickness"]) for zone in members])) for group, color, members in zone_groups(shapes)]
        (name, _, body), zoned = zoned[0], zoned[1:]
    else:
        body = extrude(layer["body"], thickness)
    if fit["tab"] and len(shapes["layers"]) == 1:
        tab = fit["tab"]
        body = union([body, cube(tab["x0"], tab["y0"], 0, tab["x1"], .01, tab["thickness"])])
    if index:
        return [(name, layer["color"], body)]
    if shapes["pegs"]:
        body = union([body]+[mf.Manifold.cylinder(options.peg_length+.5, peg["d"]/2, peg["d"]/2, 40).translate((peg["x"], peg["y"], thickness-.5))
                             for peg in shapes["pegs"]])
    if shapes["pin"]:
        pin = shapes["pin"]
        drill = mf.Manifold.cylinder(pin["y1"]-pin["y0"]+1, pin["d"]/2, pin["d"]/2, 24).rotate((-90, 0, 0))
        drill = drill.translate((pin["x"], pin["y0"], (min(zone["thickness"] for zone in shapes["zones"]) if zoned else thickness)/2))
        body = closed(body-drill)
        zoned = [(group, color, closed(solid-drill)) for group, color, solid in zoned]
    text, depth, parts = shapes["text"], options.text_depth, []
    if not text.is_empty and options.text_style == "engrave":
        body = closed(body-extrude(text, depth+1, thickness-depth))
        parts.append(("Text", options.text_color, extrude(text, depth, thickness-depth)))
    elif not text.is_empty and options.text_style == "emboss":
        parts.append(("Text", options.text_color, extrude(text, depth, thickness)))
    marks = shapes["markings"]
    if not marks.is_empty:
        mark = min(options.text_depth if options.text_style == "engrave" else MARK_DEPTH, thickness-.4)
        body = closed(body-extrude(marks, mark+1, thickness-mark))
        parts.append(("Markings", options.text_color, extrude(marks, mark, thickness-mark)))
    parts[:0] = [(name, layer["color"], body)]+zoned
    if options.mount == "stand":
        reach = float(np.clip(shapes["height"]*.5, 30, 90))
        feet = [foot(options, index*(foot_length(options)+STAND_GAP), -STAND_GAP-reach, reach, thickness) for index in range(2)]
        parts.append(("Stand feet", shapes["fit_color"], closed(mf.Manifold.batch_boolean(feet, mf.OpType.Add))))
    return parts


def part_groups(terrain, options, shapes=None, sources=None):
    """Each printed part with what prints in it (text and markings inlays): lists of (name, color, solid) in print position."""
    shapes = shapes or layout(terrain, options, sources)
    groups = [layer_parts(options, shapes, index) for index in range(len(shapes["layers"]))]
    fit = shapes["fit"]
    if fit["comb_base"]:
        groups.append([("Comb base", shapes["fit_color"], comb_base(options, fit))])
    if fit["combs"]:
        comb = spacer_comb(options, fit)
        groups.extend([[("Spacer comb (left)", shapes["fit_color"], comb)], [("Spacer comb (right)", shapes["fit_color"], comb)]])
    return groups


def laid_out(groups):
    """Groups placed side by side on the bed in rows (a single group stays where it is), as one list of parts."""
    if len(groups) == 1:
        return groups[0]
    boxes = [np.array([solid.bounding_box() for _, _, solid in group]) for group in groups]
    row = max(BED_MM, max(float(bounds[:, 3].max()-bounds[:, 0].min()) for bounds in boxes))
    x = y = height = 0.0
    placed = []
    for group, bounds in zip(groups, boxes):
        x0, y0, x1, y1 = float(bounds[:, 0].min()), float(bounds[:, 1].min()), float(bounds[:, 3].max()), float(bounds[:, 4].max())
        if x and x+x1-x0 > row:
            x, y, height = 0.0, y+height+PART_GAP, 0.0
        placed.extend((name, color, solid.translate((x-x0, y-y0, 0))) for name, color, solid in group)
        x, height = x+x1-x0+PART_GAP, max(height, y1-y0)
    return placed


def solids(terrain, options, shapes=None, sources=None):
    """Named parts in print position (front face up): layers, text and markings, stand feet, and comb parts, laid out flat."""
    return laid_out(part_groups(terrain, options, shapes, sources))


def mesh(solid):
    result = solid.to_mesh64()
    return np.asarray(result.vert_properties)[:, :3].astype(np.float64), np.asarray(result.tri_verts).astype(np.int64)


# --- Files ------------------------------------------------------------------------------------------------

def metadata(terrain, options, shapes):
    settings = asdict(options) | {"trim": list(options.trim), "layers": [{"position": p, "base_mm": b, "color": c, **({} if t is None else {"thickness_mm": t})}
                                                                          for p, b, c, t in options.layers],
                                       "text_lines": [{"text": w, "size": s, "style": f, "tracking": k} for w, s, f, k in options.text_lines],
                                       "ridge_edits": [{"layer": i, "deleted": d, "curve": c} for i, d, c in options.ridge_edits]}
    return {"kind": "silhouette", "preset": options.preset, "settings": settings,
            "size_mm": {"width": round(shapes["width"], 3), "height": round(shapes["height"], 3), "thickness": thickest(shapes)},
            "zones": [{"name": zone["name"], "color": zone["color"], "thickness_mm": zone["thickness"],
                       **({} if zone["distance_m"] is None else {"distance_m": round(zone["distance_m"], 1)})} for zone in shapes["zones"] or []],
            "colors": shapes["colors"],
            "layers": [{"name": layer["name"], "thickness_mm": layer["thickness"], **({} if layer["distance_m"] is None else {"distance_m": round(layer["distance_m"], 1)})}
                       for layer in shapes["layers"]],
            "parts": shapes["fit"]["parts"], "slice_length_m": round(float(shapes["span_m"]), 2), "bounds": terrain.bounds.to_dict(),
            "source": SOURCES[terrain.source]["short"], "units": "mm",
            "axes": "x along the piece, y up the piece, z out of its front face (printed front face up)"}


def svg_path(geometry, height):
    commands = []
    for polygon in geometry_parts(geometry, "Polygon"):
        for ring in (polygon.exterior, *polygon.interiors):
            coords = np.asarray(ring.coords)[:-1]
            commands.append("M" + " L".join(f"{x:.3f} {height-y:.3f}" for x, y in coords) + " Z")
    return " ".join(commands)


def comb_profiles(options, fit):
    """Side views of the comb parts in mm, for laser cutting them from sheet: [(id, name, shape, count)]."""
    profiles = []
    if fit["comb_base"]:
        comb, t = fit["comb_base"], tab_thickness(options)
        shape = box(0, 0, comb["depth"], comb["height"]).difference(unary_union(
            [box(center-slot/2, comb["floor"], center+slot/2, comb["height"]+1) for center, slot in zip(comb["slots"], comb["slot_widths"])]))
        shape = unary_union([shape, box(comb["depth"]/2-t/2, -options.slot_depth, comb["depth"]/2+t/2, 0)])
        profiles.append(("comb-base", "Comb base (side view)", shape, 1))
    if fit["combs"]:
        comb = fit["combs"]
        shape = box(0, 0, comb["length"], comb["height"]).difference(unary_union(
            [box(slot["center"]-slot["width"]/2, comb["height"]-slot["depth"], slot["center"]+slot["width"]/2, comb["height"]+1) for slot in comb["slots"]]))
        profiles.append(("spacer-comb", "Spacer comb (side view; cut two)", shape, 2))
    return profiles


def svg_file(options, shapes, attribution):
    """A 2D drawing in millimeters for laser cutting or vinyl: outlines with wall holes, then the text as its own paths.
    A design with several parts puts each layer (and comb side view) in its own group, stacked with gaps."""
    cut = 'fill="none" stroke="#ff0000" stroke-width="0.1"'
    text_style = cut if options.text_style == "stencil" else f'fill="{options.text_color}" stroke="none"'
    fit = shapes["fit"]
    profiles = comb_profiles(options, fit)
    head = lambda width, height: ['<?xml version="1.0" encoding="UTF-8"?>',
                                  f'<svg xmlns="http://www.w3.org/2000/svg" width="{width:.3f}mm" height="{height:.3f}mm" viewBox="0 0 {width:.3f} {height:.3f}">',
                                  f"<title>Terrain Studio silhouette</title><desc>{escape(attribution.splitlines()[0] if attribution else '')}</desc>"]
    def outline_of(index):
        layer = shapes["layers"][index]
        geometry = layer["outline"]
        if fit["tab"] and len(shapes["layers"]) == 1:
            tab = fit["tab"]
            geometry = unary_union([geometry, box(tab["x0"], tab["y0"], tab["x1"], .01)])
        return geometry
    def front_paths(height):
        output = []
        if not shapes["text"].is_empty:
            output.append(f'<g id="text" data-style={quoteattr(options.text_style)}><path fill-rule="evenodd" {text_style} d="{svg_path(shapes["text"], height)}"/></g>')
        if not shapes["markings"].is_empty:
            output.append(f'<g id="markings" data-style="engrave"><path fill-rule="evenodd" fill="{options.text_color}" stroke="none" d="{svg_path(shapes["markings"], height)}"/></g>')
        return output
    if len(shapes["layers"]) == 1 and not profiles:
        geometry = outline_of(0)
        x0, y0, x1, y1 = geometry.bounds
        width, height = shapes["width"], shapes["height"]
        output = head(width, height-min(y0, 0))  # y is flipped about the top, so a lamp tab below the piece extends the drawing down
        fill = "none" if shapes["zones"] else shapes["layers"][0]["color"]
        output.append(f'<path id="outline" fill-rule="evenodd" fill="{fill}" stroke="#ff0000" stroke-width="0.1" d="{svg_path(geometry, height)}"/>')
        if shapes["zones"]:  # color zones, one group per color, drawn where they sit in the piece
            for index, (name, color, members) in enumerate(zone_groups(shapes), 1):
                output.append(f'<g id="zone-{index}" data-name={quoteattr(name)}><path fill-rule="evenodd" fill="{color}" stroke="none" '
                              f'd="{svg_path(unary_union([zone["body"] for zone in members]), height)}"/></g>')
        output.extend(front_paths(height))
        output.append("</svg>")
        return "\n".join(output).encode("utf-8")
    items = [(f"layer-{index+1}", f"{layer['name']} · {layer['thickness']:.1f} mm" if len(shapes["layers"]) > 1 else layer["name"], outline_of(index), layer["color"], index == 0)
             for index, layer in enumerate(shapes["layers"])]
    items += [(name, title, shape, shapes["fit_color"], False) for name, title, shape, _ in profiles]
    width = max(shape.bounds[2]-min(shape.bounds[0], 0) for _, _, shape, _, _ in items)
    body, y = [], 0.0
    for name, title, shape, color, front in items:
        x0, y0, x1, y1 = shape.bounds
        top = max(y1, 0)
        body.append(f'<g id="{name}" data-name={quoteattr(title)} transform="translate({-min(x0, 0):.3f} {y:.3f})">'
                    f'<path fill-rule="evenodd" fill="{color}" stroke="#ff0000" stroke-width="0.1" d="{svg_path(shape, top)}"/>')
        if front:
            body.extend(front_paths(top))
        body.append("</g>")
        y += top-min(y0, 0)+PART_GAP
    output = head(width, y-PART_GAP)+body+["</svg>"]
    return "\n".join(output).encode("utf-8")


def slug(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def silhouette_export(terrain, options, format, attribution, sources=None):
    """Return (bytes, mimetype, filename) for one silhouette file."""
    if format not in FORMATS:
        raise ValueError("Choose stl, 3mf, svg, or json as the silhouette export format.")
    shapes = layout(terrain, options, sources)
    info = metadata(terrain, options, shapes)
    mimetype, filename = FORMATS[format]
    if format == "svg":
        content = svg_file(options, shapes, attribution)
    elif format == "json":
        content = json.dumps(info | {"warnings": shapes["warnings"], "attribution": attribution}, indent=2).encode()
    else:
        groups = part_groups(terrain, options, shapes)
        if format == "stl":
            # STL has no colors: raised text joins its part, engraved text and markings stay cavities, stand feet lie beside it.
            def merged(group):
                kept = [solid for name, _, solid in group if not (name == "Markings" or (name == "Text" and options.text_style == "engrave"))]
                return union(kept)
            if len(groups) == 1:
                content = binary_stl(*mesh(merged(groups[0])), SOURCES[terrain.source]["short"])
            else:
                buffer = BytesIO()
                with ZipFile(buffer, "w", compression=ZIP_DEFLATED) as archive:
                    for number, group in enumerate(groups, 1):
                        archive.writestr(f"{number:02d}-{slug(group[0][0])}.stl", binary_stl(*mesh(merged(group)), SOURCES[terrain.source]["short"]))
                    archive.writestr("credits.txt", attribution)
                content, (mimetype, filename) = buffer.getvalue(), PARTS_ZIP
        else:
            if by_color(options) and len(shapes["colors"]) > 4:
                raise ValueError(COLOR_LIMIT)
            colored = [{"name": name, "color": color, **dict(zip(("vertices", "faces"), mesh(solid)))} for name, color, solid in laid_out(groups)]
            content = package_3mf(model_xml(colored, info, attribution, title="Terrain Studio silhouette")).getvalue()
    return content, mimetype, filename
