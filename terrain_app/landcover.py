"""Discrete OSM surface classes for a shared, four-filament terrain palette."""
import hashlib
import json
from pathlib import Path
import re
import time

import numpy as np
import requests
from shapely import contains_xy
from shapely.geometry import Polygon

from .features import MAX_ELEMENTS, MAX_POINTS, MAX_RESPONSE_BYTES, OVERPASS_URL, QUERY_SETTINGS, REQUEST_TIMEOUT, coastline_paths, encode_polygons, sea_geometry, element_polygons, paths
from .services import USER_AGENT, cache_json, cached_json, response_json

COVER_NAMES = ("dark_foliage", "light_foliage", "dirt", "snow", "water", "buildings")
COVER_LABELS = ("Dark foliage", "Light foliage", "Dirt", "Snow", "Water", "Buildings")


def print_colors(value):
    if value is None:
        return None
    if not isinstance(value, dict) or set(value) != set(COVER_NAMES):
        raise ValueError("Choose a print color for all six surface types.")
    if any(not isinstance(color, str) or not re.fullmatch(r"#[0-9a-fA-F]{6}", color) for color in value.values()):
        raise ValueError("Print colors must be six-digit hex colors.")
    return {name: value[name].lower() for name in COVER_NAMES}


def cover_class(tags):
    if not isinstance(tags, dict):
        return None
    if tags.get("building") and tags["building"] != "no":
        return "buildings"
    if tags.get("natural") == "water" or tags.get("landuse") == "reservoir" or tags.get("waterway") == "riverbank":
        return "water"
    if tags.get("natural") == "glacier" or tags.get("landcover") == "snow":
        return "snow"
    if tags.get("natural") == "wood" or tags.get("landuse") == "forest" or tags.get("landcover") == "trees":
        return "dark_foliage"
    if (tags.get("natural") in {"grassland", "scrub", "heath", "wetland"}
            or tags.get("landuse") in {"grass", "meadow", "orchard", "vineyard", "farmland"}
            or tags.get("landcover") == "grass" or tags.get("leisure") in {"park", "garden", "golf_course"}):
        return "light_foliage"
    if (tags.get("natural") in {"bare_rock", "scree", "shingle", "sand", "beach", "mud"}
            or tags.get("landuse") in {"quarry", "brownfield", "construction"}):
        return "dirt"
    return None


def prepare_cover(data, bounds):
    elements = data.get("elements")
    if not isinstance(elements, list) or data.get("remark"):
        raise ValueError("The surface map did not finish. Retry or select a smaller area.")
    if len(elements) > MAX_ELEMENTS:
        raise ValueError("There are too many mapped surfaces. Select a smaller area.")
    regions, seen, points = {name: [] for name in COVER_NAMES}, set(), 0
    coastlines = []
    for element in elements:
        if not isinstance(element, dict):
            continue
        coast = coastline_paths(element, bounds)
        if coast and ("way", element.get("id")) not in seen:
            seen.add(("way", element.get("id")))
            points += sum(len(path) for path in coast)
            coastlines.extend(coast)
            continue
        category = cover_class(element.get("tags"))
        identifier = (element.get("type"), element.get("id"))
        if category is None or identifier in seen:
            continue
        seen.add(identifier)
        geometries = [element.get("geometry")] if element.get("type") == "way" else [
            member.get("geometry") for member in element.get("members", []) if member.get("type") == "way"]
        points += sum(len(path) for geometry in geometries for path in paths(geometry))
        if points > MAX_POINTS:
            raise ValueError("The surface map is too detailed. Select a smaller area.")
        regions[category].extend(element_polygons(element, bounds))
    regions["water"].extend(encode_polygons(sea_geometry(coastlines)))  # open sea is bounded by coastlines
    return {"regions": regions, "counts": {name: len(regions[name]) for name in COVER_NAMES}, "bounds": bounds.to_dict(),
            "source": "© OpenStreetMap contributors", "source_url": "https://www.openstreetmap.org/copyright",
            "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "schema_version": 2}


def face_classes(cover, rows, columns):
    """Classify triangle centroids in browser order: first/second for each cell."""
    result = np.full((rows-1, columns-1, 2), COVER_NAMES.index("dirt"), dtype=np.uint8)
    # Smaller clearings override forests; water and buildings override land.
    for name in ("dirt", "dark_foliage", "light_foliage", "snow", "water", "buildings"):
        for region in cover["regions"].get(name, []):
            polygon = Polygon(region["outer"], region["holes"])
            west, north, east, south = polygon.bounds
            x0, x1 = max(0, int(west*(columns-1))), min(columns-1, int(east*(columns-1))+1)
            y0, y1 = max(0, int(north*(rows-1))), min(rows-1, int(south*(rows-1))+1)
            if x1 <= x0 or y1 <= y0:
                continue
            for half, fraction in enumerate((1/3, 2/3)):
                u, v = np.meshgrid((np.arange(x0, x1)+fraction)/(columns-1), (np.arange(y0, y1)+fraction)/(rows-1))
                target = result[y0:y1, x0:x1, half]
                target[contains_xy(polygon, u, v)] = COVER_NAMES.index(name)
    return result.ravel()


def cover_query(bounds):
    extent = bounds.geographic_extent
    bbox = ",".join(f"{v:.8f}" for v in (extent.south, extent.west, extent.north, extent.east))
    return f'''{QUERY_SETTINGS};
(
 wr["natural"~"^(wood|grassland|scrub|heath|wetland|bare_rock|scree|shingle|sand|beach|mud|glacier|water)$"]({bbox});
 wr["landuse"~"^(forest|grass|meadow|orchard|vineyard|farmland|reservoir|quarry|brownfield|construction)$"]({bbox});
 wr["landcover"~"^(trees|grass|snow)$"]({bbox});
 wr["leisure"~"^(park|garden|golf_course)$"]({bbox});
 wr["waterway"="riverbank"]({bbox});
 way["natural"="coastline"]({bbox});
 wr["building"]["building"!="no"]({bbox});
); out geom qt;'''


class LandCoverClient:
    def __init__(self, cache_dir: Path, url=OVERPASS_URL):
        self.cache_dir, self.url = Path(cache_dir), url

    def fetch(self, bounds):
        bounds.validate()
        if max(bounds.dimensions) > 50_000:
            raise ValueError("Mapped print colors support areas up to 50 km per side. Generate a smaller area.")
        key = hashlib.sha256(json.dumps(bounds.to_dict(), sort_keys=True).encode()).hexdigest()
        path = self.cache_dir / f"{key}.json"
        result = cached_json(path, 7*86400, MAX_RESPONSE_BYTES)
        if isinstance(result, dict) and result.get("schema_version") == 2 and result.get("bounds") == bounds.to_dict() and set(result.get("regions", {})) == set(COVER_NAMES):
            return result
        try:
            with requests.post(self.url, data={"data": cover_query(bounds)}, headers={"User-Agent": USER_AGENT},
                               timeout=REQUEST_TIMEOUT, stream=True) as response:
                data = response_json(response, MAX_RESPONSE_BYTES)
        except requests.RequestException:
            raise ValueError("The surface map could not load. The service may be busy; retry or check your connection.") from None
        result = prepare_cover(data, bounds)
        cache_json(path, result)
        return result
