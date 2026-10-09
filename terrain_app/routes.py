"""Uploaded GPS routes (GPX), stored once and overlaid on any framed area."""
import hashlib
import math
from pathlib import Path
import re
from xml.etree import ElementTree as ET

import numpy as np
from shapely.geometry import LineString, box

from .features import encoded_line, parts, to_selection
from .services import cache_json, cached_json

MAX_GPX_BYTES = 15_000_000
MAX_POINTS = 500_000
MAX_SEGMENTS = 500
STORED_TOLERANCE_M = 1.0  # well under a printed line's width at any model size; also the stored profile's vertical tolerance
ELEVATION_WINDOW_M = 100.0  # GPS altitude is smoothed by a moving average over this much distance
SCHEMA_VERSION = 2  # 2: stored points carry their smoothed elevation as an optional third value
DISPLAY_POINTS = 4_000  # for the map overlay
EARTH_RADIUS_M = 6371008.8
ROUTE_ID = re.compile(r"[0-9a-f]{24}")
HEX_COLOR = re.compile(r"#[0-9a-fA-F]{6}")
WIDTH_RANGE = (.4, 6.0)  # printed line width, millimeters


def local_name(element):
    return element.tag.rsplit("}", 1)[-1]


def gpx_segments(content):
    """Track segments and routes as [[lon, lat, elevation or None], ...] lists, the first name found, and the first point's time."""
    try:
        root = ET.fromstring(content)
    except ET.ParseError:
        raise ValueError("This file is not valid GPX. Export the activity as GPX and try again.") from None
    if local_name(root) != "gpx":
        raise ValueError("This file is not a GPX file. Export the activity as GPX and try again.")
    segments, name, count, started = [], None, 0, None
    for element in root.iter():
        tag = local_name(element)
        if tag == "name" and name is None and element.text and element.text.strip():
            name = element.text.strip()[:120]
        if tag not in ("trkseg", "rte"):
            continue
        segment = []
        for point in element:
            if local_name(point) not in ("trkpt", "rtept"):
                continue
            try:
                lon, lat = float(point.attrib["lon"]), float(point.attrib["lat"])
            except (KeyError, ValueError):
                continue
            if not (math.isfinite(lon) and math.isfinite(lat) and abs(lon) <= 180 and abs(lat) <= 85.05112878):
                continue
            elevation = next((child.text for child in point if local_name(child) == "ele"), None)
            if started is None:
                started = next((child.text.strip()[:40] for child in point if local_name(child) == "time" and child.text and child.text.strip()), None)
            try:
                elevation = float(elevation) if elevation is not None else None
            except ValueError:
                elevation = None
            segment.append([lon, lat, elevation if elevation is not None and math.isfinite(elevation) else None])
            count += 1
            if count > MAX_POINTS:
                raise ValueError("This route has more than 500,000 points. Split it into shorter activities.")
        if len(segment) >= 2:
            segments.append(segment)
            if len(segments) > MAX_SEGMENTS:
                raise ValueError("This GPX file has too many separate tracks. Export a single activity.")
    if not segments:
        raise ValueError("This GPX file has no track or route points.")
    return segments, name, started


def local_meters(coordinates, latitude):
    """Equirectangular meters around one latitude: accurate to well under a meter across a route's extent."""
    coordinates = np.asarray(coordinates, dtype=np.float64)
    scale = math.radians(1)*EARTH_RADIUS_M
    return np.column_stack((coordinates[:, 0]*scale*math.cos(math.radians(latitude)), coordinates[:, 1]*scale))


def kept_indices(coordinates, tolerance):
    """Douglas–Peucker on any 2D polyline; returns the indices of the kept points (always the two ends)."""
    if len(coordinates) < 3 or tolerance <= 0:
        return set(range(len(coordinates)))
    kept = np.asarray(LineString(coordinates).simplify(tolerance, preserve_topology=False).coords)
    lookup = {tuple(np.round(point, 6)): index for index, point in enumerate(coordinates)}
    return {lookup.get(tuple(np.round(point, 6)), 0) for point in kept} | {0, len(coordinates)-1}


def simplified(segment, latitude, tolerance):
    """Douglas–Peucker in meters; returns the kept lon/lat points."""
    points = np.asarray([point[:2] for point in segment], dtype=np.float64)
    return points[sorted(kept_indices(local_meters(points, latitude), tolerance))]


def along(points):
    """Cumulative great-circle distance (m) at each [lon, lat] point."""
    radians = np.radians(np.asarray(points, dtype=np.float64)[:, :2])
    dlon, dlat = np.diff(radians[:, 0]), np.diff(radians[:, 1])
    a = np.sin(dlat/2)**2+np.cos(radians[:-1, 1])*np.cos(radians[1:, 1])*np.sin(dlon/2)**2
    return np.concatenate(([0.0], np.cumsum(2*EARTH_RADIUS_M*np.arcsin(np.sqrt(np.clip(a, 0, 1))))))


def smoothed_elevations(segment, distances):
    """GPS altitude averaged over ELEVATION_WINDOW_M of distance; gaps are filled along the distance; None without any."""
    raw = np.asarray([np.nan if point[2] is None else point[2] for point in segment], dtype=np.float64)
    present = np.isfinite(raw)
    if not present.any():
        return None
    filled = np.interp(distances, distances[present], raw[present])
    total = np.concatenate(([0.0], np.cumsum(filled)))
    low = np.searchsorted(distances, distances-ELEVATION_WINDOW_M/2)
    high = np.searchsorted(distances, distances+ELEVATION_WINDOW_M/2, side="right")
    return (total[high]-total[low])/(high-low)


def stored_segment(segment, latitude):
    """Points kept to within a meter of the ground track and, when the GPX has altitude, of its smoothed profile too."""
    points = np.asarray([point[:2] for point in segment], dtype=np.float64)
    indices = kept_indices(local_meters(points, latitude), STORED_TOLERANCE_M)
    distances = along(points)
    elevations = smoothed_elevations(segment, distances)
    if elevations is not None:
        # A straight road over a hill simplifies to its two ends; the profile's own simplification keeps the hill.
        indices |= kept_indices(np.column_stack((distances, elevations)), STORED_TOLERANCE_M)
    indices = sorted(indices)
    return [[round(float(points[index, 0]), 7), round(float(points[index, 1]), 7),
             None if elevations is None else round(float(elevations[index]), 1)] for index in indices]


def route_stats(segments):
    distance = gain = 0.0
    for segment in segments:
        points = np.radians(np.asarray([point[:2] for point in segment], dtype=np.float64))
        dlon, dlat = np.diff(points[:, 0]), np.diff(points[:, 1])
        a = np.sin(dlat/2)**2+np.cos(points[:-1, 1])*np.cos(points[1:, 1])*np.sin(dlon/2)**2
        distance += float((2*EARTH_RADIUS_M*np.arcsin(np.sqrt(np.clip(a, 0, 1)))).sum())
        # Climbing counts only past 3 m of change, so GPS altitude noise doesn't inflate the total.
        reference = None
        for _, _, elevation in segment:
            if elevation is None:
                continue
            if reference is None or elevation < reference:
                reference = elevation
            elif elevation-reference >= 3:
                gain += elevation-reference
                reference = elevation
    return distance, gain


def prepare_route(content, filename=""):
    segments, name, started = gpx_segments(content)
    points = np.asarray([point[:2] for segment in segments for point in segment])
    south, north = float(points[:, 1].min()), float(points[:, 1].max())
    west, east = float(points[:, 0].min()), float(points[:, 0].max())
    if east-west > 180:
        raise ValueError("Routes that cross the date line are not supported.")
    latitude = (south+north)/2
    distance, gain = route_stats(segments)
    stored = [stored_segment(segment, latitude) for segment in segments]
    profile = [point[2] for segment in stored for point in segment if point[2] is not None]
    # The map overlay needs only a few thousand points; keep its shape at the route's scale.
    extent = max(np.ptp(local_meters([[west, south], [east, north]], latitude), axis=0).max(), 1)
    display = [simplified(segment, latitude, extent/DISPLAY_POINTS*2) for segment in segments]
    fallback = Path(filename).stem.replace("_", " ").strip() if filename else ""
    return {
        "id": hashlib.sha256(content).hexdigest()[:24], "name": name or fallback[:120] or "Uploaded route",
        "segments": stored,
        "display": [np.round(segment[:, ::-1], 6).tolist() for segment in display],  # [lat, lon] for Leaflet
        "bounds": {"south": south, "west": west, "north": north, "east": east},
        "distance_m": round(distance, 1), "gain_m": round(gain, 1),
        "points": sum(len(segment) for segment in segments), "has_elevation": bool(profile),
        "elevation_range_m": round(max(profile)-min(profile), 1) if profile else None,
        "started_at": started, "date": started[:10] if started and re.fullmatch(r"\d{4}-\d\d-\d\d", started[:10]) else None,
        "schema_version": SCHEMA_VERSION,
    }


def public_route(route):
    return {key: value for key, value in route.items() if key not in ("segments", "schema_version")}


def route_lines(route, bounds):
    """The route in the frame's 0–1 coordinates, clipped to the frame; empty when it lies outside."""
    frame, lines = box(0, 0, 1, 1), []
    for segment in route["segments"]:
        line = LineString(to_selection(bounds, [point[:2] for point in segment]))
        if line.length < 1e-9:
            continue
        lines.extend(encoded_line(piece) for piece in parts(line.intersection(frame), "LineString") if piece.length > 1e-9)
    return lines


def route_options(value):
    """A validated {"id", "enabled", "color", "width_mm"} from an export or check request, or None."""
    if value is None:
        return None
    if not isinstance(value, dict) or not isinstance(value.get("enabled"), bool):
        raise ValueError("Route options must include enabled true or false.")
    if not value["enabled"]:
        return None
    if not isinstance(value.get("id"), str) or not ROUTE_ID.fullmatch(value["id"]):
        raise ValueError("Upload the GPX route again.")
    color = value.get("color")
    if not isinstance(color, str) or not HEX_COLOR.fullmatch(color):
        raise ValueError("Choose a six-digit hex color for the route.")
    width = value.get("width_mm", 1.6)
    if isinstance(width, bool) or not isinstance(width, (int, float)) or not math.isfinite(width) or not WIDTH_RANGE[0] <= width <= WIDTH_RANGE[1]:
        raise ValueError(f"Route line width must be between {WIDTH_RANGE[0]} and {WIDTH_RANGE[1]} millimeters.")
    return {"id": value["id"], "enabled": True, "color": color.lower(), "width_mm": float(width)}


class RouteStore:
    def __init__(self, cache_dir: Path):
        self.cache_dir = Path(cache_dir)

    def save(self, content, filename=""):
        if len(content) > MAX_GPX_BYTES:
            raise ValueError("GPX files must be under 15 MB.")
        route = prepare_route(content, filename)
        cache_json(self.cache_dir / f"{route['id']}.json", route)
        return route

    def load(self, identifier):
        if not ROUTE_ID.fullmatch(identifier or ""):
            return None
        route = cached_json(self.cache_dir / f"{identifier}.json", 10*365*86400, 200_000_000)
        # Version 1 files keep [lon, lat] points without elevations; uploading the GPX again stores them as version 2.
        return route if isinstance(route, dict) and route.get("schema_version") in (1, SCHEMA_VERSION) else None


def with_route(styles, feature_data, style, lines):
    """Add the route as one more line layer so 3MF and GLB color parts treat it like a trail."""
    styles = {**styles, "route": {"enabled": True, "color": style["color"], "width_mm": style["width_mm"]}}
    data = feature_data or {"layers": {}}
    return styles, {**data, "layers": {**data["layers"], "route": [{"id": "route", "lines": lines}]}}
