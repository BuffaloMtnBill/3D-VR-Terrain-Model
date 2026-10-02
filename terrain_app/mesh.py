"""Smooth heights and build consistently wound, closed terrain meshes."""
from dataclasses import asdict, dataclass
from io import BytesIO, StringIO
import json
import math
import struct

import numpy as np
from PIL import Image
from PIL.PngImagePlugin import PngInfo
from scipy.ndimage import gaussian_filter

from .elevation import Terrain, SOURCES


@dataclass(frozen=True)
class ModelOptions:
    exaggeration: float = 2.0
    smoothing: float = 0.0  # Gaussian sigma, in grid cells
    base_percent: float = 3.0  # percentage of longest horizontal side
    size_mm: float = 180.0  # longest horizontal side in exported model
    solid: bool = True
    relief: str = "standard"  # how heights are shaped before the multiplier: see RELIEF_METHODS
    relief_strength: float = 50.0  # percent; ignored by the standard method

    @classmethod
    def from_dict(cls, value):
        if not isinstance(value, dict):
            raise ValueError("Model options must be an object.")
        defaults = cls()
        numbers = {}
        limits = {"exaggeration": (.1, 20), "smoothing": (0, 5), "base_percent": (.1, 15), "size_mm": (10, 2000),
                  "relief_strength": (0, 100)}
        for name, (low, high) in limits.items():
            try:
                number = float(value.get(name, getattr(defaults, name)))
            except (TypeError, ValueError):
                raise ValueError(f"{name} must be a number.") from None
            if not math.isfinite(number) or not low <= number <= high:
                raise ValueError(f"{name} must be between {low} and {high}.")
            numbers[name] = number
        solid = value.get("solid", True)
        if not isinstance(solid, bool):
            raise ValueError("solid must be true or false.")
        return cls(**numbers, solid=solid, relief=relief_method(value.get("relief", "standard")))


def smooth_elevations(terrain: Terrain, sigma: float):
    if not math.isfinite(sigma) or not 0 <= sigma <= 5:
        raise ValueError("Smoothing must be between 0 and 5 grid cells.")
    heights = terrain.elevations.astype(np.float64)
    return gaussian_filter(heights, sigma=sigma, mode="nearest") if sigma > 0 else heights


RELIEF_METHODS = ("standard", "local", "lowland")


def relief_method(value):
    if value not in RELIEF_METHODS:
        raise ValueError("Choose standard, local, or lowland as the elevation profile.")
    return value


def shape_elevations(heights, relief="standard", strength=50.0):
    """Reshape heights, in meters, before the uniform multiplier is applied.

    local: scale-separated exaggeration. Relief finer than a smoothed trend surface
    (a local relief model) is amplified up to three times; broad landforms keep their height.
    lowland: a power curve gives low ground a larger share of the same total range,
    preserving the order of heights and the lowest and highest points.
    """
    relief_method(relief)
    if not math.isfinite(strength) or not 0 <= strength <= 100:
        raise ValueError("relief_strength must be between 0 and 100.")
    heights = np.asarray(heights, dtype=np.float64)
    if relief == "standard" or strength == 0:
        return heights
    if relief == "local":
        trend = gaussian_filter(heights, sigma=max(2.0, .03*max(heights.shape)), mode="nearest")
        return trend+(1+2*strength/100)*(heights-trend)
    low, span = heights.min(), np.ptp(heights)
    if span <= 0:
        return heights
    return low+span*((heights-low)/span)**(1/(1+2*strength/100))


def model_elevations(terrain: Terrain, options: ModelOptions):
    return shape_elevations(smooth_elevations(terrain, options.smoothing), options.relief, options.relief_strength)


def build_mesh(terrain: Terrain, options: ModelOptions):
    elevations = model_elevations(terrain, options)
    rows, columns = elevations.shape
    longest = max(terrain.width, terrain.height)
    base = longest * options.base_percent / 100 if options.solid else 0
    xx, yy = np.meshgrid(np.linspace(-terrain.width/2, terrain.width/2, columns),
                         np.linspace(terrain.height/2, -terrain.height/2, rows))
    zz = (elevations - elevations.min()) * options.exaggeration + base
    vertices = np.column_stack((xx.ravel(), yy.ravel(), zz.ravel()))
    top_left = (np.arange(rows - 1)[:, None] * columns + np.arange(columns - 1)).ravel()
    # Top-to-bottom rows require this winding for upward-facing top normals.
    triangles = np.column_stack((top_left, top_left + columns, top_left + 1))
    other = np.column_stack((top_left + 1, top_left + columns, top_left + columns + 1))
    faces = np.concatenate((triangles, other))
    if options.solid:
        # Counterclockwise rim viewed from above: left→bottom→right→top.
        rim = np.concatenate((np.arange(0, rows * columns, columns),
                              np.arange((rows-1)*columns+1, rows*columns),
                              np.arange((rows-2)*columns+columns-1, columns-2, -columns),
                              np.arange(columns-2, 0, -1)))
        lower = np.arange(len(vertices), len(vertices) + len(rim))
        floor = vertices[rim].copy()
        floor[:, 2] = 0
        center = len(vertices) + len(rim)
        vertices = np.concatenate((vertices, floor, [[0, 0, 0]]))
        following_rim, following_lower = np.roll(rim, -1), np.roll(lower, -1)
        sides_a = np.column_stack((rim, lower, following_rim))
        sides_b = np.column_stack((following_rim, lower, following_lower))
        bottom = np.column_stack((np.full(len(rim), center), following_lower, lower))
        faces = np.concatenate((faces, sides_a, sides_b, bottom))
    return vertices * (options.size_mm / longest), faces.astype(np.uint32)


def binary_stl(vertices, faces, source="Mapzen Terrain Tiles"):
    triangles = vertices[faces]
    normals = np.cross(triangles[:, 1] - triangles[:, 0], triangles[:, 2] - triangles[:, 0])
    magnitudes = np.linalg.norm(normals, axis=1)
    normals /= np.maximum(magnitudes[:, None], np.finfo(float).eps)
    records = np.zeros(len(faces), dtype=[("normal", "<f4", (3,)), ("vertices", "<f4", (3, 3)), ("attribute", "<u2")])
    records["normal"] = normals
    records["vertices"] = triangles
    header = f"Terrain Studio; units mm; Z up; elevation: {source}; credits in app".encode("ascii").ljust(80, b" ")
    return header + struct.pack("<I", len(faces)) + records.tobytes()


def obj_file(vertices, faces, metadata=None, attribution=""):
    output = StringIO()
    output.write("# Terrain Studio | millimeters | X selection right, Y selection top, Z up\n")
    if metadata is not None:
        output.write("# Metadata: " + json.dumps(metadata, ensure_ascii=False) + "\n")
    for line in attribution.splitlines():
        output.write("# " + line + "\n")
    output.write("o Terrain\n")
    np.savetxt(output, vertices, fmt="v %.6f %.6f %.6f")
    np.savetxt(output, faces + 1, fmt="f %d %d %d")
    return output.getvalue().encode()


def export_metadata(terrain: Terrain, options: ModelOptions):
    return terrain.metadata() | {
        "model_options": asdict(options), "mesh_units": "mm",
        "mesh_elevation_origin_m": float(model_elevations(terrain, options).min()),
        "relief_note": "Model heights are reshaped before scaling; CSV, NumPy and PNG exports keep true elevations."
                       if options.relief != "standard" and options.relief_strength else "Model heights are true elevations, uniformly scaled.",
        "heightmap": {"bits": 16, "rows": "selection top to bottom", "columns": "selection left to right",
                      "north_up": terrain.bounds.rotation_deg == 0,
                      "decode_m": "min_m + pixel / 65535 * (max_m - min_m)"},
    }


def export_file(terrain: Terrain, options: ModelOptions, format: str, attribution: str, feature_layers=None, print_palette=None):
    """Return one native file, its MIME type, and its suggested filename."""
    formats = {
        "stl": ("model/stl", "terrain.stl"),
        "obj": ("text/plain", "terrain.obj"),
        "png": ("image/png", "heightmap.png"),
        "csv": ("text/csv", "elevations.csv"),
        "npy": ("application/octet-stream", "elevations.npy"),
        "metadata": ("application/json", "terrain-metadata.json"),
    }
    if format not in formats:
        raise ValueError("Choose stl, obj, png, csv, npy, or metadata as the export format.")
    metadata = export_metadata(terrain, options)
    if feature_layers:
        metadata["feature_layers"] = feature_layers
    if print_palette:
        metadata["print_palette"] = print_palette
    if format in ("stl", "obj"):
        vertices, faces = build_mesh(terrain, options)
        metadata |= {"vertices": len(vertices), "triangles": len(faces)}
        content = binary_stl(vertices, faces, SOURCES[terrain.source]["short"]) if format == "stl" else obj_file(vertices, faces, metadata, attribution)
        buffer = BytesIO(content)
    elif format == "npy":
        buffer = BytesIO()
        np.save(buffer, terrain.elevations, allow_pickle=False)
    elif format == "csv":
        csv = StringIO()
        np.savetxt(csv, terrain.elevations, delimiter=",", fmt="%.4f")
        buffer = BytesIO(csv.getvalue().encode())
    elif format == "png":
        low, high = float(terrain.elevations.min()), float(terrain.elevations.max())
        normalized = np.clip((terrain.elevations - low) / max(high-low, 1e-9) * 65535, 0, 65535)
        info = PngInfo()
        info.add_text("terrain_metadata", json.dumps(metadata))
        info.add_text("elevation_min_m", str(low))
        info.add_text("elevation_max_m", str(high))
        info.add_text("orientation", metadata["grid_orientation"])
        info.add_itxt("attribution", attribution)
        buffer = BytesIO()
        Image.fromarray(np.rint(normalized).astype(np.uint16)).save(buffer, format="PNG", pnginfo=info)
    else:
        buffer = BytesIO(json.dumps(metadata | {"attribution": attribution}, indent=2).encode())
    buffer.seek(0)
    mimetype, filename = formats[format]
    return buffer, mimetype, filename
