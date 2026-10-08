"""Bounded USGS 3DHP flowlines and waterbodies in terrain selection coordinates."""
import hashlib
import json
import time
from pathlib import Path

import requests
from shapely import make_valid
from shapely.geometry import LineString, Polygon

from .features import (CLIP, MAX_ELEMENTS, MAX_POINTS, MAX_RESPONSE_BYTES,
                       encode_polygons, encoded_line, parts, to_selection)
from .services import USER_AGENT, cache_json, cached_json, response_json

HYDROGRAPHY_URL = "https://3dhp.nationalmap.gov/arcgis/rest/services/usgs_3dhp_all/FeatureServer"
SOURCE_URL = "https://www.usgs.gov/3d-hydrography-program"
PAGE_SIZE = 1000


def water_source(value):
    if value not in ("osm", "usgs"):
        raise ValueError("Choose OpenStreetMap or USGS 3DHP as the water source.")
    return value


def prepare_water(data, bounds):
    """Convert Esri geometry; ring nesting preserves islands and multipart lakes."""
    features, points = [], 0
    width, height = bounds.dimensions
    for layer, records in data.items():
        for record in records:
            attributes = record.get("attributes") or {}
            geometry = record.get("geometry") or {}
            label = str(attributes.get("featuretypelabel") or "").lower()
            # Network links through lakes and underground pipes are not surface creeks.
            if layer == 50 and label not in {"channel line", "river", "drainageway", "canal/ditch", "canal", "ditch"}:
                continue
            raw = geometry.get("paths" if layer == 50 else "rings", [])
            points += sum(len(path) for path in raw)
            if points > MAX_POINTS:
                raise ValueError("USGS waterways are too detailed. Select a smaller area.")
            projected = [to_selection(bounds, [point[:2] for point in path]) for path in raw if len(path) >= (2 if layer == 50 else 4)]
            feature = {"id": f"usgs/{layer}/{attributes['OBJECTID']}",
                       "name": str(attributes.get("gnisidlabel") or "")[:200], "lines": [], "polygons": []}
            if layer == 50:
                # Stream order separates headwater creeks from larger waterways.
                order = attributes.get("streamorder") or 0
                if label in {"canal/ditch", "canal", "ditch"}:
                    feature["kind"] = "canal"
                elif label == "drainageway":
                    feature["kind"] = "drain"
                else:
                    feature["kind"] = "river" if order >= 4 else "stream"
                for path in projected:
                    clipped = LineString(path).intersection(CLIP)
                    feature["lines"].extend(encoded_line(line.simplify(1e-5)) for line in parts(clipped, "LineString") if line.length > 1e-10)
            else:
                rings = [make_valid(Polygon(ring)) for ring in projected]
                # Esri rings can have either winding after projection. Containment
                # depth, rather than winding, distinguishes land islands from water.
                rings.sort(key=lambda ring: ring.area, reverse=True)
                water = Polygon()
                for index, ring in enumerate(rings):
                    depth = sum(parent.covers(ring) for parent in rings[:index])
                    water = water.union(ring) if depth % 2 == 0 else water.difference(ring)
                feature["polygons"] = encode_polygons(make_valid(water))
                feature["kind"] = "riverbank" if "river" in label else "canal" if "canal" in label else "lake"
                feature["area_m2"] = round(water.area * width * height, 2)
            if feature["lines"] or feature["polygons"]:
                features.append(feature)
    return {"water": features, "water_source": "usgs", "source": "USGS 3D Hydrography Program (3DHP)",
            "source_url": SOURCE_URL, "bounds": bounds.to_dict(), "schema_version": 1,
            "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}


class HydrographyClient:
    def __init__(self, cache_dir, url=HYDROGRAPHY_URL):
        self.cache_dir, self.url = Path(cache_dir), url.rstrip("/")

    def fetch(self, bounds):
        bounds.validate()
        if max(bounds.dimensions) > 50_000:
            raise ValueError("USGS waterways are available for areas up to 50 km per side. Select a smaller area.")
        key = hashlib.sha256(json.dumps([self.url, bounds.to_dict()], sort_keys=True).encode()).hexdigest()
        path = self.cache_dir / f"{key}.json"
        result = cached_json(path, 7*86400, MAX_RESPONSE_BYTES)
        if isinstance(result, dict) and result.get("schema_version") == 1 and result.get("bounds") == bounds.to_dict():
            return result
        extent = bounds.geographic_extent
        envelope = ",".join(str(value) for value in (extent.west, extent.south, extent.east, extent.north))
        data, total_bytes, total_points, total_records = {}, 0, 0, 0
        try:
            for layer in (50, 60):
                records, offset = [], 0
                while True:
                    parameters = dict(f="json", where="1=1", geometry=envelope, geometryType="esriGeometryEnvelope",
                                      inSR=4326, outSR=4326, spatialRel="esriSpatialRelIntersects",
                                      outFields="OBJECTID,featuretypelabel,gnisidlabel" + (",streamorder" if layer == 50 else ""),
                                      returnGeometry="true", returnZ="false", returnM="false",
                                      orderByFields="OBJECTID", resultOffset=offset, resultRecordCount=PAGE_SIZE)
                    with requests.get(f"{self.url}/{layer}/query", params=parameters, headers={"User-Agent": USER_AGENT},
                                      timeout=(8, 75), stream=True) as response:
                        page = response_json(response, MAX_RESPONSE_BYTES-total_bytes)
                    total_bytes += len(json.dumps(page).encode())
                    if page.get("error") or not isinstance(page.get("features"), list):
                        raise ValueError("USGS waterways could not load. Retry or select a smaller area.")
                    batch = page["features"]
                    total_records += len(batch)
                    total_points += sum(len(path) for record in batch for path in (record.get("geometry") or {}).get("paths" if layer == 50 else "rings", []))
                    if total_records > MAX_ELEMENTS or total_points > MAX_POINTS or total_bytes > MAX_RESPONSE_BYTES:
                        raise ValueError("USGS waterways are too detailed. Select a smaller area.")
                    records.extend(batch)
                    if not page.get("exceededTransferLimit"):
                        break
                    if not batch:
                        raise ValueError("USGS waterways returned an incomplete response. Retry in a moment.")
                    offset += len(batch)
                data[layer] = records
        except requests.RequestException:
            raise ValueError("USGS waterways could not load. Check your connection or choose OpenStreetMap.") from None
        result = prepare_water(data, bounds)
        cache_json(path, result)
        return result
