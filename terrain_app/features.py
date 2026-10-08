"""Read OSM linework and water polygons, then clip them to the selected rectangle."""
import hashlib
import json
import math
from pathlib import Path
import re
import time

import numpy as np
import requests
from shapely import contains_xy, make_valid
from shapely.geometry import LineString, Polygon, box
from shapely.ops import polygonize, unary_union
from shapely.strtree import STRtree

from .buildings import building_dimensions, building_mesh, is_detailed
from .elevation import Bounds, pixel_coordinates
from .services import USER_AGENT, cache_json, cached_json, response_json

LAYER_NAMES = ("roads", "railways", "borders", "water", "cities", "parks", "buildings", "at", "trails")
OVERPASS_URL = "https://overpass-api.de/api/interpreter"
MAX_RESPONSE_BYTES = 40_000_000
MAX_POINTS = 200_000
MAX_ELEMENTS = 40_000
QUERY_SETTINGS = "[out:json][timeout:60][maxsize:134217728]"  # seconds and bytes allowed on the Overpass server
REQUEST_TIMEOUT = (8, 75)  # connect, read: longer than the server-side query timeout
ROADS = {"motorway", "trunk", "primary", "secondary", "tertiary", "unclassified", "residential",
         "motorway_link", "trunk_link", "primary_link", "secondary_link", "tertiary_link",
         "living_street", "service", "pedestrian", "track", "road"}
TRAILS = {"path", "footway", "bridleway"}
RAILS = {"rail", "light_rail", "subway", "tram", "narrow_gauge", "funicular", "monorail", "preserved"}
CLIP = box(0, 0, 1, 1)


def layer_options(value):
    if value is None:
        return {}
    if not isinstance(value, dict) or not set(value) <= set(LAYER_NAMES):
        raise ValueError("Choose valid model feature layers.")
    result = {}
    for name, options in value.items():
        if not isinstance(options, dict) or not isinstance(options.get("enabled"), bool):
            raise ValueError("Feature layer enabled values must be true or false.")
        color = options.get("color")
        if not isinstance(color, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
            raise ValueError("Choose a six-digit hex color for each feature layer.")
        result[name] = {"enabled": options["enabled"], "color": color.lower()}
        if "source" in options:
            if name != "water" or options["source"] not in ("osm", "usgs"):
                raise ValueError("Choose OpenStreetMap or USGS 3DHP as the water source.")
            result[name]["source"] = options["source"]
        if "detail" in options:
            detail = options["detail"]
            if name not in {"roads", "water"} or isinstance(detail, bool) or not isinstance(detail, (int, float)) or not math.isfinite(detail) or not 0 <= detail <= 100:
                raise ValueError("Road and water detail must be between 0 and 100.")
            result[name]["detail"] = detail
        if "detailed" in options:
            if name != "buildings" or not isinstance(options["detailed"], bool):
                raise ValueError("3D buildings can only be switched on or off for the Buildings layer.")
            result[name]["detailed"] = options["detailed"]
    return result


def is_appalachian_trail(tags):
    """Match the main AT route or named trail ways, rather than other hiking trails."""
    name = str(tags.get("name", ""))
    named = bool(re.fullmatch(r"Appalachian(?: National Scenic)? Trail(?:\s*\(.*\))?", name, re.I))
    route = tags.get("route") in {"hiking", "foot"}
    return (route and str(tags.get("ref", "")).upper() == "AT") or ((route or tags.get("highway") in {"path", "footway", "track"}) and named)


def classify(tags):
    if not isinstance(tags, dict):
        return []
    categories = []
    if is_appalachian_trail(tags):
        categories.append("at")
    elif tags.get("highway") in TRAILS and tags.get("footway") not in {"sidewalk", "crossing"}:
        categories.append("trails")
    if tags.get("highway") in ROADS:
        categories.append("roads")
    if tags.get("railway") in RAILS:
        categories.append("railways")
    if tags.get("boundary") == "administrative":
        try:
            level = int(tags.get("admin_level", 0))
        except (ValueError, TypeError):
            level = 0
        if 2 <= level <= 6:
            categories.append("borders")
        elif 7 <= level <= 10:
            categories.append("cities")
    if (tags.get("natural") == "water" or tags.get("landuse") == "reservoir"
            or tags.get("waterway") in {"river", "stream", "canal", "drain", "ditch", "riverbank"}):
        categories.append("water")
    if tags.get("leisure") in {"park", "nature_reserve"} or tags.get("boundary") in {"national_park", "protected_area"}:
        categories.append("parks")
    if any(tags.get(key) and tags[key] != "no" for key in ("building", "building:part")):
        categories.append("buildings")
    return categories


def building_height(tags):
    """Use mapped meters or levels; otherwise a six-meter illustrative building."""
    for key, multiplier in (("height", 1), ("building:levels", 3)):
        try:
            value = float(str(tags.get(key, "")).removesuffix(" m").strip())*multiplier
            if math.isfinite(value) and 0 < value <= 500:
                return value, key
        except (ValueError, TypeError):
            pass
    return 6, "assumed"


def to_selection(bounds, coordinates):
    longitude, latitude = np.asarray(coordinates, dtype=np.float64).T
    if not bounds.rotation_deg:
        return np.column_stack(((longitude-bounds.west)/(bounds.east-bounds.west),
                                (bounds.north-latitude)/(bounds.north-bounds.south)))
    x, y = pixel_coordinates(longitude, latitude, 0)
    west, north = pixel_coordinates(bounds.west, bounds.north, 0)
    east, south = pixel_coordinates(bounds.east, bounds.south, 0)
    dx, dy = x-(west+east)/2, y-(north+south)/2
    angle = math.radians(bounds.rotation_deg)
    return np.column_stack((.5+(dx*math.cos(angle)+dy*math.sin(angle))/(east-west),
                            .5+(-dx*math.sin(angle)+dy*math.cos(angle))/(south-north)))


def paths(geometry):
    """Never join across missing points in Overpass's bounded geometry output."""
    result, current = [], []
    for point in geometry or []:
        if isinstance(point, dict):
            try:
                coordinate = [float(point["lon"]), float(point["lat"])]
            except (KeyError, ValueError, TypeError):
                coordinate = None
            if coordinate and not (all(math.isfinite(v) for v in coordinate) and abs(coordinate[0]) <= 180 and abs(coordinate[1]) <= 85.05112878):
                coordinate = None
        else:
            coordinate = None
        if coordinate is None:
            if len(current) >= 2:
                result.append(current)
            current = []
        elif not current or coordinate != current[-1]:
            current.append(coordinate)
    if len(current) >= 2:
        result.append(current)
    return result


def parts(geometry, kind):
    if geometry.is_empty:
        return []
    if geometry.geom_type == kind:
        return [geometry]
    return [item for child in getattr(geometry, "geoms", []) for item in parts(child, kind)]


def encoded_line(line):
    return np.clip(np.asarray(line.coords), 0, 1).round(8).tolist()


def element_geometry(element, bounds):
    """Assemble complete OSM area geometry, retaining inner rings when clipping."""
    if element.get("type") == "way":
        rings = paths(element.get("geometry"))
        polygons = [make_valid(Polygon(to_selection(bounds, ring))) for ring in rings if len(ring) >= 4 and ring[0] == ring[-1]]
        geometry = unary_union(polygons) if polygons else Polygon()
    else:
        outer, inner = [], []
        for member in element.get("members", []):
            if member.get("type") != "way":
                continue
            target = inner if member.get("role") == "inner" else outer
            target.extend(LineString(to_selection(bounds, path)) for path in paths(member.get("geometry")))
        # Members can be split or reversed; polygonize assembles their connected rings.
        outer_polygons = list(polygonize(unary_union(outer))) if outer else []
        inner_polygons = list(polygonize(unary_union(inner))) if inner else []
        geometry = unary_union(outer_polygons) if outer_polygons else Polygon()
        if inner_polygons:
            geometry = geometry.difference(unary_union(inner_polygons))
    return make_valid(geometry)


def encode_polygons(geometry):
    geometry = geometry.intersection(CLIP)
    return [{"outer": encoded_line(polygon.exterior), "holes": [encoded_line(ring) for ring in polygon.interiors]}
            for polygon in parts(geometry, "Polygon") if polygon.area > 1e-12]


def element_polygons(element, bounds):
    return encode_polygons(element_geometry(element, bounds))


def coastline_paths(element, bounds):
    """Selection-space coastline ways, kept whole so they can divide the selection into land and sea."""
    if element.get("type") != "way" or (element.get("tags") or {}).get("natural") != "coastline":
        return []
    return [to_selection(bounds, path) for path in paths(element.get("geometry"))]


def sea_geometry(coastlines):
    """The part of the selection that is sea, from OSM coastlines.

    Open sea is not mapped as water areas: coastline ways run with land on their left and
    water on their right. The coastlines cut the selection into pieces; each piece is sea
    when more coastline length has it on the water side than on the land side. With no
    coastline crossing the selection, nothing can be decided and it is left as land.
    """
    lines = [LineString(path) for path in coastlines if len(path) >= 2]
    if not lines:
        return Polygon()
    inside = unary_union(lines).intersection(CLIP)
    segments = [np.asarray(line.coords) for line in parts(inside, "LineString")]
    if not segments:
        return Polygon()
    starts = np.concatenate([segment[:-1] for segment in segments])
    steps = np.concatenate([np.diff(segment, axis=0) for segment in segments])
    lengths = np.hypot(steps[:, 0], steps[:, 1])
    starts, steps, lengths = starts[lengths > 0], steps[lengths > 0], lengths[lengths > 0]
    # Rows run north to south here, so the water (right-hand) side of a step (du, dv) is (-dv, du).
    offsets = np.column_stack((-steps[:, 1], steps[:, 0]))/lengths[:, None]*1e-6
    water_side, land_side = starts+steps/2+offsets, starts+steps/2-offsets
    sea = []
    for piece in polygonize(unary_union([CLIP.boundary, inside])):
        water = lengths[contains_xy(piece, water_side[:, 0], water_side[:, 1])].sum()
        land = lengths[contains_xy(piece, land_side[:, 0], land_side[:, 1])].sum()
        if water > land:
            sea.append(piece)
    return make_valid(unary_union(sea)) if sea else Polygon()


def water_polygons(element, bounds):
    tags = element.get("tags", {})
    if tags.get("natural") == "water" or tags.get("landuse") == "reservoir" or tags.get("waterway") == "riverbank":
        return element_polygons(element, bounds)
    return []


def prepare_features(data, bounds):
    elements = data.get("elements")
    if not isinstance(elements, list) or data.get("remark"):
        raise ValueError("Map feature lookup did not finish. Try again or select a smaller area.")
    if len(elements) > MAX_ELEMENTS:
        raise ValueError("There are too many map features. Select a smaller area.")
    layers, seen, points = {name: [] for name in LAYER_NAMES}, set(), 0
    buildings, coastlines = [], []
    # Ways of an Appalachian Trail relation belong to the AT layer, even when unnamed.
    at_ways = {member.get("ref") for element in elements if isinstance(element, dict) and element.get("type") == "relation"
               and is_appalachian_trail(element.get("tags") or {}) for member in element.get("members", []) if isinstance(member, dict)}
    for element in reversed(elements):
        if not isinstance(element, dict):
            continue
        identifier = f'{element.get("type")}/{element.get("id")}'
        if identifier in seen:
            continue
        seen.add(identifier)
        coast = coastline_paths(element, bounds)
        if coast:
            points += sum(len(path) for path in coast)
            if points > MAX_POINTS:
                raise ValueError("The map features are too detailed for this area. Select a smaller area.")
            coastlines.extend(coast)
        categories = classify(element.get("tags", {}))
        if element.get("type") == "way" and element.get("id") in at_ways:
            categories = [category for category in categories if category != "trails"]
        if not categories:
            continue
        raw_paths = paths(element.get("geometry")) if element.get("type") == "way" else [
            path for member in element.get("members", []) if member.get("type") == "way"
            for path in paths(member.get("geometry"))]
        # Bound processing as well as the size of the final browser payload.
        points += sum(len(path) for path in raw_paths)
        if points > MAX_POINTS:
            raise ValueError("The map features are too detailed for this area. Select a smaller area.")
        lines = []
        for path in raw_paths:
            geometry = LineString(to_selection(bounds, path)).intersection(CLIP)
            lines.extend(encoded_line(line.simplify(1e-5)) for line in parts(geometry, "LineString") if line.length > 1e-10)
        tags = element["tags"]
        water_area = "water" in categories and (tags.get("natural") == "water" or tags.get("landuse") == "reservoir" or tags.get("waterway") == "riverbank")
        area_geometry = element_geometry(element, bounds) if water_area else None
        if "buildings" in categories:
            area_geometry = element_geometry(element, bounds)
        polygons = encode_polygons(area_geometry) if area_geometry is not None else []
        if not lines and not polygons:
            continue
        feature = {"id": identifier, "name": str(element.get("tags", {}).get("name", ""))[:200],
                   "lines": lines, "polygons": polygons}
        if "buildings" in categories:
            feature.update(building_dimensions(tags))
            if not tags.get("building") or tags["building"] == "no":
                feature["part"] = True
            buildings.append((feature, area_geometry))
        if "roads" in categories:
            feature["kind"] = tags["highway"]
        elif "water" in categories:
            feature["kind"] = tags.get("waterway", tags.get("water", "water"))
            if water_area:
                width, height = bounds.dimensions
                # Measure the full mapped water body, not its clipped visible sliver.
                feature["area_m2"] = round(area_geometry.area*width*height, 2)
        for category in categories:
            layers[category].append(feature)
    detail_buildings(buildings, bounds)
    sea = encode_polygons(sea_geometry(coastlines))
    if sea:
        width, height = bounds.dimensions
        area = sum(Polygon(polygon["outer"], polygon["holes"]).area for polygon in sea)
        layers["water"].append({"id": "coastline/sea", "name": "", "lines": [], "polygons": sea, "kind": "sea",
                                "area_m2": round(area*width*height, 2)})
    return {"layers": layers, "counts": {name: len(features) for name, features in layers.items()},
            "bounds": bounds.to_dict(), "source": "© OpenStreetMap contributors", "source_url": "https://www.openstreetmap.org/copyright",
            "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "schema_version": 6}


def detail_buildings(buildings, bounds):
    """Link building parts to their outlines and add closed meshes where a flat block would be wrong.

    Outlines containing parts are replaced by those parts in 3D mode; parts are ignored otherwise.
    """
    outlines = [(feature, geometry) for feature, geometry in buildings if not feature.get("part") and not geometry.is_empty]
    tree = STRtree([geometry for _, geometry in outlines]) if outlines else None
    width, height = bounds.dimensions
    for feature, geometry in buildings:
        if geometry.is_empty:
            continue
        if feature.get("part") and tree is not None:
            point = geometry.representative_point()
            for index in tree.query(point, predicate="within"):
                outlines[index][0]["has_parts"] = True
                feature["parent"] = outlines[index][0]["id"]
                break
    for feature, geometry in buildings:
        if geometry.is_empty or feature.get("has_parts") or not is_detailed(feature):
            continue
        mesh = building_mesh(geometry, feature, width, height, bounds.rotation_deg)
        if mesh:
            feature["mesh"] = mesh


def building_query(bounds):
    """Footprints and 3D parts; by far the largest layer in cities, so it is requested separately."""
    extent = bounds.geographic_extent
    bbox = ",".join(f"{v:.8f}" for v in (extent.south, extent.west, extent.north, extent.east))
    return f'''{QUERY_SETTINGS};
(
 wr["building"]["building"!="no"]({bbox});
 wr["building:part"]["building:part"!="no"]({bbox});
); out geom qt;'''


def overpass_query(bounds):
    extent = bounds.geographic_extent
    bbox = ",".join(f"{v:.8f}" for v in (extent.south, extent.west, extent.north, extent.east))
    roads, rails = "|".join(sorted(ROADS)), "|".join(sorted(RAILS))
    return f'''{QUERY_SETTINGS};
(
 way["highway"~"^({roads})$"]({bbox});
 relation["route"~"^(hiking|foot)$"]["ref"~"^AT$",i]({bbox});
 relation["route"~"^(hiking|foot)$"]["name"~"^Appalachian( National Scenic)? Trail($| *[(])",i]({bbox});
 way["highway"~"^(path|footway|track)$"]["name"~"^Appalachian( National Scenic)? Trail($| *[(])",i]({bbox});
 way["highway"~"^(path|footway|bridleway)$"]["footway"!~"^(sidewalk|crossing)$"]({bbox});
 way["railway"~"^({rails})$"]({bbox});
 way["waterway"~"^(river|stream|canal|drain|ditch)$"]({bbox});
 nwr["boundary"="administrative"]["admin_level"~"^(2|3|4|5|6|7|8|9|10)$"]({bbox});
 nwr["leisure"~"^(park|nature_reserve)$"]({bbox});
 nwr["boundary"~"^(national_park|protected_area)$"]({bbox});
); out geom({bbox}) qt;
(
 nwr["natural"="water"]({bbox});
 nwr["landuse"="reservoir"]({bbox});
 nwr["waterway"="riverbank"]({bbox});
 way["natural"="coastline"]({bbox});
); out geom qt;'''


class FeatureClient:
    def __init__(self, cache_dir: Path, url=OVERPASS_URL):
        self.cache_dir, self.url = Path(cache_dir), url

    def fetch(self, bounds: Bounds):
        """Every layer except buildings."""
        return self._fetch(bounds, overpass_query, "")

    def fetch_buildings(self, bounds: Bounds):
        return self._fetch(bounds, building_query, "-buildings")

    def _fetch(self, bounds: Bounds, query, suffix):
        bounds.validate()
        if max(bounds.dimensions) > 50_000:
            raise ValueError("Map features are available for areas up to 50 km per side. Select a smaller area and generate its terrain.")
        key = hashlib.sha256(json.dumps(bounds.to_dict(), sort_keys=True).encode()).hexdigest()
        path = self.cache_dir / f"{key}{suffix}.json"
        result = cached_json(path, 7*86400, MAX_RESPONSE_BYTES)
        if isinstance(result, dict) and result.get("schema_version") == 6 and result.get("bounds") == bounds.to_dict() and set(result.get("layers", {})) == set(LAYER_NAMES):
            return result
        try:
            with requests.post(self.url, data={"data": query(bounds)}, headers={"User-Agent": USER_AGENT},
                               timeout=REQUEST_TIMEOUT, stream=True) as response:
                data = response_json(response, MAX_RESPONSE_BYTES)
        except requests.RequestException:
            raise ValueError("Map features could not load. The service may be busy; retry in a moment or check your connection.") from None
        result = prepare_features(data, bounds)
        if not suffix:
            # A park or water area can also be tagged as a building; buildings come only from their own request.
            result["layers"]["buildings"], result["counts"]["buildings"] = [], 0
        cache_json(path, result)
        return result
