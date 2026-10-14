"""Handing a silhouette to CylinderLamp, which wraps it around a lithophane shade.

The silhouette page's ridge curves (one per layer, nearest first, in mm with y up, including any ridge edits) go into a
small JSON file in a folder both apps know, and CylinderLamp opens it from its address (`/?silhouette=<id>`). There each
layer becomes a band of wall thickness: the sky thinnest and brightest, the nearest ridge thickest and darkest.

The folder is `$TERRAIN_LAMP_HANDOFF`, or `~/.local/share/terrain-studio/lamp-silhouettes` (`%LOCALAPPDATA%\\terrain-studio\\
lamp-silhouettes` on Windows). CylinderLamp is reached at `$CYLINDERLAMP_URL` (default http://127.0.0.1:5057) and, when it
isn't running, started from `$CYLINDERLAMP_DIR` (default: a CylinderLamp folder beside this project)."""

import json
import os
import socket
import subprocess
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import urlsplit

from .silhouette import layout

FORMAT = "terrain-studio-lamp-silhouette"
VERSION = 1
KEEP = 50                   # handoff files kept; older ones are removed


def handoff_dir():
    if os.environ.get("TERRAIN_LAMP_HANDOFF"):
        return Path(os.environ["TERRAIN_LAMP_HANDOFF"])
    if os.name == "nt":
        return Path(os.environ.get("LOCALAPPDATA", Path.home())) / "terrain-studio" / "lamp-silhouettes"
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "terrain-studio" / "lamp-silhouettes"


def lamp_url():
    return os.environ.get("CYLINDERLAMP_URL", "http://127.0.0.1:5057").rstrip("/")


def lamp_dir():
    return Path(os.environ.get("CYLINDERLAMP_DIR", Path(__file__).resolve().parents[2] / "CylinderLamp"))


def lamp_silhouette(terrain, options, sources=None, name="", attribution=""):
    """The silhouette's ridge curves as CylinderLamp reads them: layers nearest first, each a curve of [x, y] mm points
    (x from 0 to width_mm, y up from the bottom of the piece) with its base, color, and distance."""
    shapes = layout(terrain, options, sources)
    layers = []
    for layer, curve in zip(shapes["layers"], shapes["ridge_curves"]):
        layers.append({"name": layer["name"], "curve": curve["curve"], "base_mm": round(float(curve["base_mm"]), 3),
                       "color": layer["color"],
                       "distance_m": None if layer["distance_m"] is None else round(layer["distance_m"], 1)})
    if not layers:
        raise ValueError("This silhouette has no ridgeline to wrap around a lamp.")
    return {"format": FORMAT, "version": VERSION, "name": name or "Mountain silhouette",
            "profile": options.source if options.source in ("route", "ridgeline", "viewpoint") else "slice",
            "width_mm": round(float(shapes["width"]), 3), "height_mm": round(float(shapes["height"]), 3),
            "layers": layers, "attribution": attribution.splitlines()[0] if attribution else "",
            "created": time.strftime("%Y-%m-%dT%H:%M:%S")}


def save_handoff(data, folder=None):
    """Write the silhouette for CylinderLamp; returns its id. The oldest files beyond KEEP are removed."""
    folder = Path(folder or handoff_dir())
    folder.mkdir(parents=True, exist_ok=True)
    identifier = uuid.uuid4().hex
    path = folder / f"{identifier}.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data), encoding="utf-8")
    tmp.replace(path)
    old = sorted(folder.glob("*.json"), key=lambda p: p.stat().st_mtime)[:-KEEP]
    for stale in old:
        stale.unlink(missing_ok=True)
    return identifier


def lamp_running(url=None, timeout=.5):
    parts = urlsplit(url or lamp_url())
    try:
        with socket.create_connection((parts.hostname or "127.0.0.1", parts.port or 80), timeout=timeout):
            return True
    except OSError:
        return False


def start_lamp(folder=None, wait=15.0):
    """Start CylinderLamp (without opening a browser) if it isn't running; True once it answers. Uses the project's own
    environment when it has one."""
    if lamp_running():
        return True
    folder = Path(folder or lamp_dir())
    if not (folder / "app.py").is_file():
        return False
    python = folder / (".venv/Scripts/python.exe" if os.name == "nt" else ".venv/bin/python")
    port = urlsplit(lamp_url()).port or 5057
    subprocess.Popen([str(python if python.is_file() else sys.executable), "app.py", "--no-browser", "--port", str(port)],
                     cwd=folder, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                     start_new_session=os.name != "nt")
    deadline = time.monotonic()+wait
    while time.monotonic() < deadline:
        if lamp_running():
            return True
        time.sleep(.25)
    return False
