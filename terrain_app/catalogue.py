"""What Collection Manager is told about a saved terrain model (models_folder.describe): where it is, how big and
how it was shaped, as tags, a description and details. The same file is in each program with Print Studio
(Terrain Model, Terrain Studio, VR Terrain Model, VR Silhouette); Mountain Silhouette has its own."""
from .addons import TYPES, active_addons

FORMATS = {"stl": "STL mesh", "3mf": "3MF with colour parts", "obj": "OBJ mesh", "glb": "GLB scene"}
LAYERS = {"roads": "roads", "railways": "railways", "borders": "borders", "water": "water", "cities": "city labels",
          "parks": "parks", "buildings": "buildings", "at": "Appalachian Trail", "trails": "trails"}


def place_parts(place):
    """'Mount Rainier, Pierce County, Washington, United States' -> its name and the wider areas, nearest first."""
    parts = [" ".join(part.split()) for part in str(place or "").split(",")]
    return [part for part in parts if part][:6]


def latitude(value):
    return f"{abs(value):.4f}° {'N' if value >= 0 else 'S'}"


def longitude(value):
    return f"{abs(value):.4f}° {'E' if value >= 0 else 'W'}"


def about_terrain(terrain, options=None, format="", features=None, project=None, route=False):
    """Everything known when the model is made; describe_terrain adds the place name the page searched for."""
    meta = terrain.metadata()
    geo = meta["geographic_bounds"]
    lat, lng = (geo["north"]+geo["south"])/2, (geo["east"]+geo["west"])/2
    width_km, height_km = meta["width_m"]/1000, meta["height_m"]/1000
    low, high = meta["min_m"], meta["max_m"]
    layers = [LAYERS.get(name, name) for name, layer in (features or {}).items() if layer.get("enabled")]
    addons = [TYPES[addon["type"]]["label"] for addon in active_addons(project) if addon["type"] in TYPES]
    markers = (project or {}).get("marker_balls", {})
    details = {
        "Centre": f"{latitude(lat)}, {longitude(lng)}",
        "Bounds": f"{latitude(geo['south'])} to {latitude(geo['north'])}, {longitude(geo['west'])} to {longitude(geo['east'])}",
        "Area": f"{width_km:.2f} × {height_km:.2f} km",
        "Elevation": f"{low:,.0f} to {high:,.0f} m (relief {high-low:,.0f} m)",
        "Rotation": f"{meta['rotation_deg']:g}°" if meta["rotation_deg"] else "",
        "Outline": terrain.bounds.shape if terrain.bounds.shape != "rectangle" else "",
        "Elevation data": meta["source_short"],
        "Grid": f"{meta['columns']} × {meta['rows']} points, {meta['grid_spacing_m']:.0f} m apart",
        "Format": FORMATS.get(format, format.upper()),
        "Map layers": ", ".join(layers),
        "Route": "GPX route" if route else "",
        "Add-ons": ", ".join(addons),
        "Markers": f"{markers.get('style', 'ball')} markers" if markers.get("include") else "",
    }
    tags = ["terrain", "landscape", "relief map", format] + layers + [a.lower() for a in addons]
    tags += ["route"] if route else []
    tags += ["mountains"] if high-low > 1000 else ["hills"] if high-low > 200 else ["flat"]
    lines = [f"Covers {width_km:.1f} × {height_km:.1f} km centred on {latitude(lat)}, {longitude(lng)}, "
             f"from {low:,.0f} m up to {high:,.0f} m ({meta['source_short']})."]
    if options is not None:
        scale = meta["width_m"]*1000/max(options.size_mm, 1) if meta["width_m"] >= meta["height_m"] \
            else meta["height_m"]*1000/max(options.size_mm, 1)
        details.update({
            "Model size": f"{options.size_mm:g} mm on the longest side",
            "Scale": f"1:{scale:,.0f}",
            "Vertical exaggeration": f"{options.exaggeration:g}×",
            "Relief": options.relief + (f" ({options.relief_strength:g}%)" if options.relief != "standard" else ""),
            "Smoothing": f"{options.smoothing:g}" if options.smoothing else "",
            "Base": f"solid, {options.base_percent:g}% of the longest side" if options.solid else "surface only",
        })
        lines.append(f"Printed {options.size_mm:g} mm across (1:{scale:,.0f}) with {options.exaggeration:g}× vertical "
                     f"exaggeration, {options.relief} relief, {'a solid base' if options.solid else 'no base'}.")
    if layers:
        lines.append(f"Map layers: {', '.join(layers)}.")
    if addons:
        lines.append(f"Add-ons: {', '.join(addons)}.")
    return {"tags": tags, "lines": lines, "details": details}


def describe_terrain(about, place="", kind="Terrain model"):
    """models_folder.describe arguments from about_terrain() and the place the page searched for."""
    about = about or {"tags": ["terrain"], "lines": [], "details": {}}
    parts = place_parts(place)
    lines = list(about["lines"])
    lines.insert(0, f"{kind} of {', '.join(parts)}." if parts else f"{kind}.")
    details = {"Place": parts[0], "Region": ", ".join(parts[1:])} if parts else {}
    return {"tags": about["tags"] + parts, "notes": "\n".join(lines), "details": {**details, **about["details"]}}
