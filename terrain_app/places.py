"""Famous landscapes: the named areas in the map UI's list, read from data/DefaultProfiles.txt.

The file holds one entry after another. Each is a line with the name shown in the list,
followed by the JSON that Current box parameters > Copy produces in the app:

    Roan Mountain, TN
    {"bounds": {...}, "zoom": 12.71, "settings": {"palette": "alpine", "controls": {...}}}

"bounds" is required. "zoom" is the map zoom to show the area at (never closer than the
area fits). "settings" are the right-hand rendering settings applied when the entry is
selected; entries without them leave the current settings unchanged. The first entry is
the one shown when the app starts.
"""
import json
from pathlib import Path
import re

from .elevation import Bounds

LANDSCAPES_FILE = Path(__file__).parent / "data" / "DefaultProfiles.txt"


def parse_landscapes(text: str) -> dict:
    """Entries keyed by a URL-safe form of their name, in file order."""
    decoder, position, places = json.JSONDecoder(), 0, {}
    while True:
        start = text.find("{", position)
        label = " ".join(text[position:start if start >= 0 else None].split())
        if start < 0:
            if label:
                raise ValueError(f"Famous landscape '{label}' has no parameters after its name.")
            break
        if not label:
            raise ValueError("Every famous landscape needs a name on the line above its parameters.")
        try:
            entry, position = decoder.raw_decode(text, start)
            # Validated here so a bad entry is reported by name at startup, not as a broken map.
            bounds = Bounds.from_dict(entry["bounds"]).to_dict()
        except (ValueError, KeyError, TypeError) as error:
            raise ValueError(f"Famous landscape '{label}' is not valid: {error}") from None
        key = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")
        if not key or key in places or key == "custom":
            raise ValueError(f"Famous landscape '{label}' needs a different name; each must be unique.")
        places[key] = {"name": label.split(",")[0].strip(), "label": label, "bounds": bounds}
        zoom, settings = entry.get("zoom"), entry.get("settings")
        if isinstance(zoom, (int, float)) and not isinstance(zoom, bool) and 0 <= zoom <= 22:
            places[key]["zoom"] = zoom
        if isinstance(settings, dict) and isinstance(settings.get("controls"), dict):
            places[key]["settings"] = {"palette": settings.get("palette"), "controls": settings["controls"]}
    if not places:
        raise ValueError("The famous landscapes file lists no landscapes.")
    return places


PRESETS = parse_landscapes(LANDSCAPES_FILE.read_text(encoding="utf-8"))
DEFAULT_PLACE = next(iter(PRESETS))
