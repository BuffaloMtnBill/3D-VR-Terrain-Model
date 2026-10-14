"""Download bounded elevation rasters and sample them in geographic coordinates."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
import hashlib
from io import BytesIO
import math
from pathlib import Path
import time
import uuid
from typing import Callable

import numpy as np
from PIL import Image, UnidentifiedImageError
import requests
from scipy.ndimage import map_coordinates

EARTH_RADIUS = 6_371_008.8
MERCATOR_LIMIT = 85.05112878
TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
SOURCE = "Mapzen / Tilezen Terrain Tiles (AWS Open Data)"
SOURCE_URL = "https://registry.opendata.aws/terrain-tiles/"
LICENSE_URL = "https://github.com/tilezen/joerd/blob/master/docs/attribution.md"
USER_AGENT = "3D-Map-Extractor/1.0 (local terrain visualization; Mapzen Terrain Tiles)"
THREE_DEP_USER_AGENT = "3D-Map-Extractor/1.0 (local terrain visualization; USGS 3DEP)"
THREE_DEP_URL = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage"
WEB_MERCATOR_RADIUS = 6_378_137.0  # EPSG:3857 sphere; distinct from the mean radius used for model dimensions
DEFAULT_SOURCE = "mapzen"
SOURCES = {
    "mapzen": {"label": "Mapzen · global", "short": "Mapzen Terrain Tiles", "source": SOURCE,
               "source_url": SOURCE_URL, "license_url": LICENSE_URL,
               "elevation_units": "meters above sea level (source dataset vertical datum)"},
    "usgs3dep": {"label": "USGS 3DEP · United States", "short": "USGS 3DEP",
                 "source": "USGS 3D Elevation Program (3DEP), The National Map",
                 "source_url": "https://www.usgs.gov/3d-elevation-program",
                 "license_url": "https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits",
                 "elevation_units": "meters (NAVD88 in the conterminous United States; local vertical datums elsewhere)"},
}


def source_id(value) -> str:
    if not isinstance(value, str) or value not in SOURCES:
        raise ValueError("Choose Mapzen or USGS 3DEP as the elevation source.")
    return value


@dataclass(frozen=True)
class Bounds:
    south: float
    west: float
    north: float
    east: float
    rotation_deg: float = 0.0  # clockwise in the map's Mercator plane
    shape: str = "rectangle"

    @classmethod
    def from_dict(cls, value: dict) -> "Bounds":
        if not isinstance(value, dict):
            raise ValueError("Supply south, west, north, and east coordinates.")
        try:
            bounds = cls(**{key: float(value[key]) for key in ("south", "west", "north", "east")},
                         rotation_deg=float(value.get("rotation_deg", 0)), shape=value.get("shape", "rectangle"))
        except (KeyError, TypeError, ValueError):
            raise ValueError("Supply four numeric bounding coordinates.") from None
        bounds.validate()
        return bounds

    def validate(self):
        if not all(math.isfinite(getattr(self, key)) for key in ("south", "west", "north", "east", "rotation_deg")):
            raise ValueError("Coordinates must be finite numbers.")
        if self.shape not in ("rectangle", "circle", "oval"):
            raise ValueError("Choose rectangle, circle, or oval as the selection shape.")
        if not -180 <= self.rotation_deg <= 180:
            raise ValueError("Rotation must be between −180° and 180°.")
        if not -MERCATOR_LIMIT <= self.south < self.north <= MERCATOR_LIMIT:
            raise ValueError("Select an area between 85° south and 85° north.")
        if not -180 <= self.west < self.east <= 180:
            raise ValueError("Select an area within −180° to 180° longitude without crossing the date line.")
        if self.shape == "circle":
            x0, y0 = pixel_coordinates(self.west, self.north, 0)
            x1, y1 = pixel_coordinates(self.east, self.south, 0)
            if not math.isclose(float(x1-x0), float(y1-y0), rel_tol=.01):
                raise ValueError("A circle needs equal width and height on the map. Use oval for unequal axes.")
        width, height = self.dimensions
        if min(width, height) < 50:
            raise ValueError("Select an area at least 50 meters wide and tall.")
        if max(width, height) > 250_000:
            raise ValueError("Select a smaller area: each side must be under 250 km.")
        longitude, latitude = self.corners
        if np.any(np.abs(latitude) > MERCATOR_LIMIT) or np.any(np.abs(longitude) > 180):
            raise ValueError("The rotated selection must stay within ±85° latitude and cannot cross the date line.")

    def to_dict(self):
        value = {key: getattr(self, key) for key in ("south", "west", "north", "east")}
        if self.rotation_deg:
            value["rotation_deg"] = self.rotation_deg
        if self.shape != "rectangle":
            value["shape"] = self.shape
        return value

    @property
    def corners(self):
        """Longitudes/latitudes in selection order: top-left, top-right, bottom-right, bottom-left."""
        return selection_coordinates(self, np.array([0, 1, 1, 0]), np.array([0, 0, 1, 1]))

    @property
    def geographic_extent(self):
        longitude, latitude = self.corners
        return Bounds(float(latitude.min()), float(longitude.min()), float(latitude.max()), float(longitude.max()))

    @property
    def dimensions(self) -> tuple[float, float]:
        latitude = math.radians((self.south + self.north) / 2)
        width = EARTH_RADIUS * math.cos(latitude) * math.radians(self.east - self.west)
        height = EARTH_RADIUS * math.radians(self.north - self.south)
        return (width, width) if self.shape == "circle" else (width, height)

    @property
    def boundary(self):
        if self.shape == "rectangle":
            return self.corners
        angles = np.linspace(0, 2*np.pi, 128, endpoint=False)
        return selection_coordinates(self, .5+.5*np.cos(angles), .5+.5*np.sin(angles))


@dataclass
class Terrain:
    bounds: Bounds
    elevations: np.ndarray  # rows run from frame top to bottom; columns left to right
    zoom: int
    tile_count: int
    fetched_at: str
    source: str = DEFAULT_SOURCE
    pixel_spacing_m: float | None = None  # ground spacing of the downloaded raster, when not tile-based

    @property
    def width(self):
        return self.bounds.dimensions[0]

    @property
    def height(self):
        return self.bounds.dimensions[1]

    def metadata(self) -> dict:
        rows, columns = self.elevations.shape
        spacing = max(self.width / (columns - 1), self.height / (rows - 1))
        source_spacing = self.pixel_spacing_m
        tiled = source_spacing is None
        if source_spacing is None:
            source_spacing = 156543.033928 * math.cos(math.radians((self.bounds.north + self.bounds.south) / 2)) / 2**self.zoom
        source = SOURCES[self.source]
        return {
            "bounds": self.bounds.to_dict(), "rows": rows, "columns": columns,
            "rotation_deg": self.bounds.rotation_deg,
            "geographic_bounds": self.bounds.geographic_extent.to_dict(),
            "footprint": [{"latitude": float(lat), "longitude": float(lng)} for lng, lat in zip(*self.bounds.boundary)],
            "width_m": self.width, "height_m": self.height,
            "min_m": float(self.elevations.min()), "max_m": float(self.elevations.max()),
            "mean_m": float(self.elevations.mean()), "grid_spacing_m": spacing,
            "tile_pixel_spacing_m": source_spacing, "zoom": None if tiled is False else self.zoom,
            "tile_count": None if tiled is False else self.tile_count, "fetched_at": self.fetched_at,
            "source_id": self.source, "source": source["source"], "source_short": source["short"],
            "source_url": source["source_url"], "license_url": source["license_url"],
            "projection": "Local dimensions at center latitude; X toward selection right, Y toward selection top, Z up; north-up at 0° rotation",
            "grid_orientation": "Rows: selection top to bottom; columns: selection left to right. At 0° rotation, top is north and left is west.",
            "elevation_units": source["elevation_units"],
            "notes": "Grid spacing is sampling density, not survey accuracy. Source resolution varies by region. No buildings or vegetation are added.",
        }


def pixel_coordinates(longitude, latitude, zoom: int):
    size = 256 * 2**zoom
    lat = np.radians(np.clip(latitude, -MERCATOR_LIMIT, MERCATOR_LIMIT))
    x = (np.asarray(longitude) + 180) / 360 * size
    y = (1 - np.arcsinh(np.tan(lat)) / np.pi) / 2 * size
    return x, y


def geographic_coordinates(x, y, zoom: int):
    size = 256 * 2**zoom
    return np.asarray(x) / size * 360 - 180, np.degrees(np.arctan(np.sinh(np.pi * (1 - 2*np.asarray(y)/size))))


def selection_coordinates(bounds: Bounds, u, v):
    """Geographic coordinates for fractions along the selected rectangle's edges."""
    u, v = np.asarray(u), np.asarray(v)
    if not bounds.rotation_deg:
        return bounds.west + u*(bounds.east-bounds.west), bounds.north + v*(bounds.south-bounds.north)
    west, north = pixel_coordinates(bounds.west, bounds.north, 0)
    east, south = pixel_coordinates(bounds.east, bounds.south, 0)
    dx, dy = (u-.5)*(east-west), (v-.5)*(south-north)
    angle = math.radians(bounds.rotation_deg)
    cosine, sine = math.cos(angle), math.sin(angle)
    x = (west+east)/2 + dx*cosine - dy*sine
    y = (north+south)/2 + dx*sine + dy*cosine
    return geographic_coordinates(x, y, 0)


def grid_shape(bounds: Bounds, resolution: int) -> tuple[int, int]:
    if isinstance(resolution, bool) or not isinstance(resolution, int) or not 32 <= resolution <= 384:
        raise ValueError("Resolution must be an integer from 32 to 384.")
    width, height = bounds.dimensions
    if width >= height:
        return max(16, round((resolution - 1) * height / width) + 1), resolution
    return resolution, max(16, round((resolution - 1) * width / height) + 1)


def tile_extent(bounds: Bounds, zoom: int) -> tuple[int, int, int, int]:
    # Include the pixel-center interpolation halo, including at exact tile boundaries.
    bounds = bounds.geographic_extent
    west, north = pixel_coordinates(bounds.west, bounds.north, zoom)
    east, south = pixel_coordinates(bounds.east, bounds.south, zoom)
    last = 2**zoom - 1
    return (max(0, int(math.floor((west - .5) / 256))),
            max(0, int(math.floor((north - .5) / 256))),
            min(last, int(math.floor((east + .5) / 256))),
            min(last, int(math.floor((south + .5) / 256))))


def choose_zoom(bounds: Bounds, rows: int, columns: int) -> int:
    spacing = max(bounds.dimensions[0] / (columns - 1), bounds.dimensions[1] / (rows - 1))
    equatorial_pixel = 156543.033928 * math.cos(math.radians((bounds.south + bounds.north) / 2))
    zoom = min(15, max(0, math.ceil(math.log2(equatorial_pixel / spacing))))
    while zoom > 0:
        x0, y0, x1, y1 = tile_extent(bounds, zoom)
        if (x1 - x0 + 1) * (y1 - y0 + 1) <= 64:
            break
        zoom -= 1
    return zoom


def decode_terrarium(image: Image.Image) -> np.ndarray:
    pixels = np.asarray(image.convert("RGB"), dtype=np.float32)
    return pixels[..., 0] * 256 + pixels[..., 1] + pixels[..., 2] / 256 - 32768


class ElevationClient:
    def __init__(self, cache_dir: Path, tile_url: str = TILE_URL):
        self.cache_dir = Path(cache_dir)
        self.tile_url = tile_url

    def _read_tile(self, path: Path) -> np.ndarray:
        with Image.open(path, formats=["PNG"]) as image:
            if image.size != (256, 256):
                raise ValueError("Unexpected elevation tile dimensions.")
            if image.mode == "RGBA" and np.asarray(image.getchannel("A")).min() == 0:
                raise ValueError("Elevation tile contains missing data; select a different area.")
            return decode_terrarium(image)

    def tile(self, zoom: int, x: int, y: int) -> np.ndarray:
        path = self.cache_dir / str(zoom) / str(x) / f"{y}.png"
        if path.exists() and time.time() - path.stat().st_mtime < 30 * 86400:
            try:
                return self._read_tile(path)
            except (OSError, ValueError, UnidentifiedImageError):
                pass  # A damaged cache entry is replaced with a verified download.
        url = self.tile_url.format(z=zoom, x=x, y=y)
        try:
            response = requests.get(url, headers={"User-Agent": USER_AGENT}, timeout=(8, 25))
            response.raise_for_status()
            if len(response.content) > 2_000_000:
                raise ValueError("Elevation server returned an oversized tile.")
            with Image.open(BytesIO(response.content), formats=["PNG"]) as image:  # never other decoders
                if image.size != (256, 256):
                    raise ValueError("Elevation server returned an invalid tile.")
                if image.mode == "RGBA" and np.asarray(image.getchannel("A")).min() == 0:
                    raise ValueError("Elevation tile contains missing data; select a different area.")
                decoded = decode_terrarium(image)
        except (requests.RequestException, OSError, UnidentifiedImageError) as error:
            raise ValueError("Could not download elevation data. Check your internet connection and try again.") from error
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(f".{uuid.uuid4().hex}.tmp")
        try:
            temporary.write_bytes(response.content)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
        return decoded

    def fetch(self, bounds: Bounds, resolution: int = 160,
              progress: Callable[[float, str], None] = lambda *_: None) -> Terrain:
        bounds.validate()
        rows, columns = grid_shape(bounds, resolution)
        zoom = choose_zoom(bounds, rows, columns)
        x0, y0, x1, y1 = tile_extent(bounds, zoom)
        tiles = [(x, y) for y in range(y0, y1 + 1) for x in range(x0, x1 + 1)]
        mosaic = np.empty(((y1 - y0 + 1) * 256, (x1 - x0 + 1) * 256), dtype=np.float32)
        progress(.02, f"Downloading {len(tiles)} elevation tiles…")
        with ThreadPoolExecutor(max_workers=4) as pool:
            futures = {pool.submit(self.tile, zoom, x, y): (x, y) for x, y in tiles}
            for completed, future in enumerate(as_completed(futures), 1):
                x, y = futures[future]
                mosaic[(y-y0)*256:(y-y0+1)*256, (x-x0)*256:(x-x0+1)*256] = future.result()
                progress(.05 + .8 * completed / len(tiles), f"Elevation tiles {completed} / {len(tiles)}")
        progress(.9, "Sampling terrain in meters…")
        u, v = np.meshgrid(np.linspace(0, 1, columns), np.linspace(0, 1, rows))
        longitude, latitude = selection_coordinates(bounds, u, v)
        px, py = pixel_coordinates(longitude, latitude, zoom)
        elevations = map_coordinates(mosaic, [py - y0 * 256 - .5, px - x0 * 256 - .5],
                                     order=1, mode="nearest", prefilter=False)
        if not np.all(np.isfinite(elevations)):
            raise ValueError("The selected area contains missing elevation data.")
        return Terrain(bounds, elevations, zoom, len(tiles), time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))


def mercator_meters(longitude, latitude):
    x, y = pixel_coordinates(longitude, latitude, 0)
    span = 2 * math.pi * WEB_MERCATOR_RADIUS
    return (x / 256 - .5) * span, (.5 - y / 256) * span


class ThreeDepClient:
    """One bounded Web Mercator export from the USGS 3DEP dynamic elevation service."""
    max_pixels = 1200
    coverage_error = ("USGS 3DEP has no complete elevation data for this selection. It covers the United States "
                      "and its territories, without open ocean; choose Mapzen for this area.")

    def __init__(self, cache_dir: Path, url: str = THREE_DEP_URL):
        self.cache_dir = Path(cache_dir)
        self.url = url

    def _decode(self, content: bytes, width: int, height: int) -> np.ndarray:
        try:
            with Image.open(BytesIO(content), formats=["TIFF"]) as image:
                if image.size != (width, height) or image.mode != "F":
                    raise ValueError("USGS 3DEP returned an unexpected image.")
                return np.asarray(image, dtype=np.float32).copy()
        except (OSError, UnidentifiedImageError):
            # The service answers areas without any data with an empty, truncated TIFF.
            raise ValueError(self.coverage_error) from None

    def raster(self, xmin: float, ymin: float, xmax: float, ymax: float, width: int, height: int) -> np.ndarray:
        box = ",".join(f"{value:.2f}" for value in (xmin, ymin, xmax, ymax))
        path = self.cache_dir / f"{hashlib.sha256(f'{box}:{width}x{height}'.encode()).hexdigest()[:32]}.tif"
        if path.exists() and time.time() - path.stat().st_mtime < 30 * 86400:
            try:
                return self._decode(path.read_bytes(), width, height)
            except (OSError, ValueError):
                pass  # A damaged cache entry is replaced with a verified download.
        parameters = {"bbox": box, "bboxSR": 3857, "imageSR": 3857, "size": f"{width},{height}", "format": "tiff",
                      "pixelType": "F32", "noData": -9999, "interpolation": "RSP_BilinearInterpolation", "f": "image"}
        try:
            response = requests.get(self.url, params=parameters, headers={"User-Agent": THREE_DEP_USER_AGENT}, timeout=(8, 90))
            response.raise_for_status()
        except requests.RequestException as error:
            raise ValueError("Could not download USGS 3DEP elevation data. Check your internet connection and try again.") from error
        if len(response.content) > 24_000_000:
            raise ValueError("USGS 3DEP returned an oversized image.")
        if "image/tiff" not in response.headers.get("Content-Type", "image/tiff"):
            raise ValueError("USGS 3DEP is temporarily unavailable. Try again shortly, or choose Mapzen.")
        decoded = self._decode(response.content, width, height)
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_suffix(f".{uuid.uuid4().hex}.tmp")
        try:
            temporary.write_bytes(response.content)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
        return decoded

    def fetch(self, bounds: Bounds, resolution: int = 160,
              progress: Callable[[float, str], None] = lambda *_: None) -> Terrain:
        bounds.validate()
        rows, columns = grid_shape(bounds, resolution)
        u, v = np.meshgrid(np.linspace(0, 1, columns), np.linspace(0, 1, rows))
        x, y = mercator_meters(*selection_coordinates(bounds, u, v))
        # Mercator meters are stretched by 1/cos(latitude) relative to the ground.
        ground = math.cos(math.radians((bounds.south + bounds.north) / 2))
        spacing = max(bounds.dimensions[0] / (columns - 1), bounds.dimensions[1] / (rows - 1))
        pixel = max(spacing / 2, 1.0) / ground  # twice the grid density, not finer than the 1 m source
        span = max(x.max() - x.min(), y.max() - y.min())
        pixel = max(pixel, span / (self.max_pixels - 4))
        width, height = (int(math.ceil((axis.max() - axis.min()) / pixel)) + 4 for axis in (x, y))
        xmin = (x.min() + x.max()) / 2 - width * pixel / 2
        ymax = (y.min() + y.max()) / 2 + height * pixel / 2
        progress(.05, "Requesting USGS 3DEP elevation…")
        image = self.raster(xmin, ymax - height * pixel, xmin + width * pixel, ymax, width, height)
        progress(.9, "Sampling terrain in meters…")
        valid = np.isfinite(image) & (image > -1000) & (image < 9000)
        coordinates = [(ymax - y) / pixel - .5, (x - xmin) / pixel - .5]
        # Any missing pixel touching a sample invalidates it; edges of coverage also hold garbage values.
        coverage = map_coordinates(valid.astype(np.float32), coordinates, order=1, mode="nearest", prefilter=False)
        if coverage.min() < .999:
            raise ValueError(self.coverage_error)
        elevations = map_coordinates(np.where(valid, image, 0), coordinates, order=1, mode="nearest", prefilter=False)
        return Terrain(bounds, elevations, 0, 1, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                       "usgs3dep", pixel * ground)
