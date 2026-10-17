"""Local HTTP interface and bounded background elevation downloads."""
from concurrent.futures import ThreadPoolExecutor
from functools import partial
import gzip
from io import BytesIO
from pathlib import Path
from threading import RLock
import json
import logging
import os
import re
import struct
import subprocess
import sys
from threading import Timer
import time
import uuid

from flask import Flask, Response, jsonify, redirect, render_template, request, send_file
from flask_sock import Sock
import numpy as np

from .elevation import Bounds, DEFAULT_SOURCE, SOURCES, THREE_DEP_URL, ElevationClient, Terrain, ThreeDepClient, grid_shape, source_id
from .mesh import ModelOptions, export_file, relief_method, shape_elevations, smooth_elevations
from .places import DEFAULT_PLACE, PRESETS
from .features import FeatureClient, OVERPASS_URL, layer_options
from .services import GEOCODER_URL, PlaceClient, ZipClient, ZipLookupError, default_cache_dir
from .landcover import LandCoverClient, print_colors, face_classes
from .printing import export_3mf
from .addons import BALL_COLOR, catalog as studio_catalog, check_project, platform_top, project_options, text_outline
from .studio import marker_ball_file, marker_platform_file, studio_export, studio_format
from .hydrography import HydrographyClient, HYDROGRAPHY_URL, water_source
from . import lamp_handoff
from .live import Hub
from .relief import ReliefTiles
from .speech import MAX_SECONDS as MAX_SPEECH_SECONDS, Transcriber, decode_samples, purpose_of, vocabulary_of
from .pairing import COOKIE as PAIR_COOKIE, is_local
from .silhouette import PRESET_DATA as SILHOUETTE_PRESETS, SilhouetteOptions, Sources, outline_json, silhouette_export, text_block_json
from .profiles import profile_json, profile_options
from .routes import MAX_GPX_BYTES, RouteStore, public_route, route_lines, route_options, with_route

ROOT = Path(__file__).parent
LOGGER = logging.getLogger(__name__)
STREET_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
STREET_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
TERRAIN_ATTRIBUTION = STREET_ATTRIBUTION + ' · SRTM · <a href="https://opentopomap.org/about" target="_blank" rel="noopener">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/" target="_blank" rel="noopener">CC-BY-SA</a>)'


def load_example(path=None):
    """The bundled terrain for the landscape shown at startup, if one has been captured for it."""
    path = Path(path or ROOT / "data" / f"{DEFAULT_PLACE}.npz")
    if not path.exists():
        return None
    with np.load(path, allow_pickle=False) as data:
        return Terrain(Bounds(*data["bounds"].tolist()), data["elevations"].copy(),
                       int(data["zoom"]), int(data["tile_count"]), str(data["fetched_at"]))


class WorkerPools:
    def __init__(self, terrain, features, studio=None):
        self.terrain, self.features = terrain, features
        # Print Studio exports are CPU-bound; their own pool keeps them from starving map downloads.
        self.studio = studio or ThreadPoolExecutor(max_workers=2, thread_name_prefix="studio-job")

    def shutdown(self, wait=True):
        self.terrain.shutdown(wait=wait)
        self.features.shutdown(wait=wait)
        self.studio.shutdown(wait=wait)


def restart_process():
    """Start this server again with the same command line (python app.py, python -m terrain_app, or the installed
    command), so code changes take effect. POSIX replaces the process; Windows starts a new one and exits."""
    command = [sys.executable, *getattr(sys, "orig_argv", [sys.executable, *sys.argv])[1:]]
    if "--no-browser" not in command:
        command.append("--no-browser")  # the page that asked for the restart is already open; it reloads itself
    logging.getLogger(__name__).info("Restarting Terrain Studio: %s", " ".join(command))
    if os.name == "nt":
        subprocess.Popen(command)
        os._exit(0)
    # The listening socket survives exec as an open descriptor, which would keep the port busy for the new server.
    os.closerange(3, min(os.sysconf("SC_OPEN_MAX"), 65536))
    os.execv(sys.executable, command)


def create_app(test_config=None):
    app = Flask(__name__)
    app.config.update(MAX_CONTENT_LENGTH=65_536,  # room for a Print Studio project with 40 add-ons
                      TRUSTED_HOSTS=os.environ.get("TERRAIN_TRUSTED_HOSTS", "localhost,127.0.0.1,[::1]").split(","),
                      MAP_TILE_URL=os.environ.get("TERRAIN_MAP_TILE_URL", "https://tile.opentopomap.org/{z}/{x}/{y}.png"),
                      MAP_ATTRIBUTION=os.environ.get("TERRAIN_MAP_ATTRIBUTION", TERRAIN_ATTRIBUTION),
                      MAP_MAX_NATIVE_ZOOM=int(os.environ.get("TERRAIN_MAP_MAX_NATIVE_ZOOM", "17")),
                      CACHE_DIR=os.environ.get("TERRAIN_CACHE_DIR", str(default_cache_dir() / "elevation")),
                      LANDSCAPES=PRESETS, DEFAULT_LANDSCAPE=DEFAULT_PLACE, EXAMPLE_PATH=None,
                      PAIRING=None)  # a pairing.Pairing in LAN mode: other devices enter its PIN once
    if test_config:
        app.config.update(test_config)
    client = ElevationClient(Path(app.config["CACHE_DIR"]))
    cache_root = Path(app.config["CACHE_DIR"]).parent
    clients = {"mapzen": client, "usgs3dep": ThreeDepClient(cache_root / "3dep", os.environ.get("TERRAIN_3DEP_URL", THREE_DEP_URL))}
    feature_client = FeatureClient(Path(os.environ.get("TERRAIN_FEATURE_CACHE_DIR", cache_root / "features")),
                                   os.environ.get("TERRAIN_OVERPASS_URL", OVERPASS_URL))
    zip_client = ZipClient(cache_root / "zip")
    place_client = PlaceClient(cache_root / "places", os.environ.get("TERRAIN_GEOCODER_URL", GEOCODER_URL))
    cover_client = LandCoverClient(cache_root / "landcover", os.environ.get("TERRAIN_OVERPASS_URL", OVERPASS_URL))
    hydro_client = HydrographyClient(cache_root / "hydrography", os.environ.get("TERRAIN_3DHP_URL", HYDROGRAPHY_URL))
    route_store = RouteStore(cache_root / "routes")
    # Slow map-feature services must not hold up elevation downloads.
    executor = WorkerPools(ThreadPoolExecutor(max_workers=2, thread_name_prefix="terrain-job"),
                           ThreadPoolExecutor(max_workers=3, thread_name_prefix="feature-job"))
    lock = RLock()
    jobs = {}
    feature_jobs = {}
    building_jobs = {}
    water_jobs = {}
    cover_jobs = {}
    studio_jobs = {}
    presets, default_place = app.config["LANDSCAPES"], app.config["DEFAULT_LANDSCAPE"]
    example = load_example(app.config["EXAMPLE_PATH"])
    if example is not None and example.bounds != Bounds.from_dict(presets[default_place]["bounds"]):
        example = None  # captured for a different area than the first landscape now describes
    app.extensions["terrain"] = {"client": client, "clients": clients, "jobs": jobs, "lock": lock, "executor": executor,
                                 "features": feature_client, "feature_jobs": feature_jobs, "building_jobs": building_jobs, "zip": zip_client, "places": place_client,
                                 "landcover": cover_client, "cover_jobs": cover_jobs, "hydrography": hydro_client, "water_jobs": water_jobs, "studio_jobs": studio_jobs,
                                 "routes": route_store}
    relief = ReliefTiles(client)
    transcriber = app.config.get("TRANSCRIBER") or Transcriber()
    hub = Hub()
    app.extensions["terrain"]["live"] = hub
    sock = Sock(app)

    @app.before_request
    def paired_devices_only():
        # In LAN mode another device must pair once with the PIN shown on this computer; this computer never needs to.
        pairing = app.config["PAIRING"]
        if pairing is None or is_local(request.remote_addr) or request.path in ("/pair", "/api/pair"):
            return None
        if pairing.is_paired(request.cookies.get(PAIR_COOKIE)):
            return None
        if request.path == "/":
            return redirect("/pair")
        return jsonify(error="Pair this device first: open the page and enter the PIN shown on the computer."), 401

    @app.before_request
    def same_origin():
        # JSON requests from the local UI; reject mutations from foreign pages.
        if request.method == "POST":
            if not request.is_json:
                return jsonify(error="Send an application/json request."), 415
            if request.path == "/api/transcribe":
                request.max_content_length = MAX_SPEECH_SECONDS * 16000 * 3 + 4096   # base64 samples, still JSON
        # Browsers let any page open a WebSocket to any server, so the live channel checks its origin too.
        if request.method == "POST" or request.path == "/api/live":
            origin = request.headers.get("Origin")
            if origin and origin.rstrip("/") != request.host_url.rstrip("/"):
                return jsonify(error="This request must originate from Terrain Studio."), 403

    @app.after_request
    def response_headers(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        if request.path.startswith("/api/") and not request.path.startswith("/api/relief/"):
            response.headers["Cache-Control"] = "no-store"
        return response

    @app.errorhandler(ValueError)
    def bad_value(error):
        return jsonify(error=str(error)), 400

    @app.errorhandler(ZipLookupError)
    def bad_zip(error):
        return jsonify(error=str(error)), error.status

    def find_terrain(identifier):
        if identifier == "example" and example is not None:
            return example
        with lock:
            record = jobs.get(identifier)
            if record and record["state"] == "ready":
                record["accessed"] = time.monotonic()
                return record["terrain"]
        return None

    def prune_jobs():
        now = time.monotonic()
        expired = [key for key, value in jobs.items() if value["state"] in ("ready", "error") and now - value["accessed"] > 3600]
        for key in expired:
            del jobs[key]
        finished = sorted((key for key in jobs if jobs[key]["state"] in ("ready", "error")), key=lambda key: jobs[key]["accessed"])
        while len(jobs) >= 12 and finished:
            del jobs[finished.pop(0)]

    def run_job(identifier, bounds, resolution, source):
        def progress(fraction, message):
            with lock:
                jobs[identifier].update(progress=fraction, message=message, state="loading")
            hub.publish(dict(type="job", id=identifier, state="loading", progress=fraction, message=message))
        try:
            terrain = clients[source].fetch(bounds, resolution, progress)
            with lock:
                jobs[identifier].update(state="ready", progress=1, message="Terrain ready", terrain=terrain, accessed=time.monotonic())
                name, preview = jobs[identifier].get("name", ""), jobs[identifier].get("preview", False)
            hub.publish(dict(type="job", id=identifier, state="ready", progress=1, message="Terrain ready"))
            # Every open page hears about it, so terrain generated on the PC can be opened in the headset and back.
            if not preview:
                hub.publish(dict(type="terrain", id=identifier, name=name))
        except Exception as error:
            LOGGER.exception("Elevation download failed")
            message = str(error) if isinstance(error, ValueError) else "Terrain processing failed. Try a smaller selection or check the terminal for details."
            with lock:
                jobs[identifier].update(state="error", message=message, accessed=time.monotonic())
            hub.publish(dict(type="job", id=identifier, state="error", progress=0, message=message))

    def run_features(identifier, terrain, records, fetch):
        with lock:
            records[identifier].update(state="loading", message="Loading map features…")
        try:
            result = fetch(terrain.bounds)
            with lock:
                records[identifier].update(state="ready", message="Map features ready", data=result, accessed=time.monotonic())
        except Exception as error:
            LOGGER.exception("Map feature download failed")
            message = str(error) if isinstance(error, ValueError) else "Map features could not be processed. Retry or select a smaller area."
            with lock:
                records[identifier].update(state="error", message=message, accessed=time.monotonic())

    def feature_records():
        """Buildings are a separate, on-demand job: ?layer=buildings."""
        layer = request.args.get("layer", "")
        if layer == "water":
            if water_source(request.args.get("source", "usgs")) != "usgs":
                raise ValueError("OpenStreetMap water is included in the main map features request.")
            return water_jobs, hydro_client.fetch
        if layer not in ("", "buildings"):
            raise ValueError("Request all map features, layer=buildings, or layer=water&source=usgs.")
        return (building_jobs, feature_client.fetch_buildings) if layer else (feature_jobs, feature_client.fetch)

    def run_cover(identifier, terrain):
        with lock:
            cover_jobs[identifier].update(state="loading", message="Loading mapped surface colors…")
        try:
            data = cover_client.fetch(terrain.bounds)
            rows, columns = terrain.elevations.shape
            result = {key: value for key, value in data.items() if key != "regions"}
            result.update(rows=rows, columns=columns, face_classes=face_classes(data, rows, columns).tolist())
            with lock:
                cover_jobs[identifier].update(state="ready", message="Mapped surface colors ready", data=result, accessed=time.monotonic())
        except Exception as error:
            LOGGER.exception("Surface map download failed")
            message = str(error) if isinstance(error, ValueError) else "The surface map could not be processed. Retry or select a smaller area."
            with lock:
                cover_jobs[identifier].update(state="error", message=message, accessed=time.monotonic())

    @app.get("/")
    def index():
        return render_template("index.html", presets=presets, default_place=default_place, silhouette_presets=SILHOUETTE_PRESETS)

    @app.post("/api/restart")
    def restart_server():
        """The header's Restart server button: reply first, then restart once the response has gone out."""
        Timer(.5, app.config.get("RESTART", restart_process)).start()
        return jsonify(restarting=True), 202

    @app.get("/api/config")
    def config():
        return jsonify(map_tile_url=app.config["MAP_TILE_URL"], map_attribution=app.config["MAP_ATTRIBUTION"],
                       map_max_native_zoom=app.config["MAP_MAX_NATIVE_ZOOM"],
                       street_tile_url=STREET_URL, street_attribution=STREET_ATTRIBUTION,
                       presets=presets, default_place=default_place,
                       elevation_sources={key: value["label"] for key, value in SOURCES.items()},
                       example_available=example is not None, boot=hub.boot,
                       # Shown only on this computer, which is where the person pairing a headset reads it.
                       pairing_pin=app.config["PAIRING"].pin if app.config["PAIRING"] and is_local(request.remote_addr) else None)

    @app.get("/pair")
    def pair_page():
        return render_template("pair.html")

    @app.post("/api/pair")
    def pair_device():
        pairing = app.config["PAIRING"]
        if pairing is None:
            return jsonify(paired=True)
        try:
            token = pairing.pair((request.get_json(silent=True) or {}).get("pin", ""))
        except PermissionError as error:
            return jsonify(error=str(error)), 429
        if token is None:
            return jsonify(error="That PIN is not right. It is shown in the terminal and on the page on the computer."), 403
        response = jsonify(paired=True)
        response.set_cookie(PAIR_COOKIE, token, max_age=400*24*3600, secure=request.is_secure, httponly=True, samesite="Strict")
        return response

    workspace = {}

    @app.post("/api/workspace")
    def hand_off():
        """The headset's latest cut, scale, and settings, for the computer's page to continue from. Kept in memory only."""
        payload = request.get_json()
        if not isinstance(payload, dict):
            raise ValueError("Supply the workspace.")
        selection = Bounds.from_dict(payload.get("selection")).to_dict()
        def text(key, limit):
            value = payload.get(key)
            return value[:limit] if isinstance(value, str) else ""
        controls = payload.get("controls")
        if not isinstance(controls, dict) or len(controls) > 200:
            controls = {}
        controls = {str(key)[:60]: value for key, value in controls.items() if isinstance(value, (bool, int, float, str)) and len(str(value)) <= 60}
        terrain_id = text("terrain_id", 64)
        size = payload.get("export_size")
        with lock:
            workspace.clear()
            workspace.update(page=text("page", 40), name=text("name", 120), place=text("place", 60), selection=selection,
                             terrain_id=terrain_id or None, palette=text("palette", 20), controls=controls,
                             export_size=size if isinstance(size, (int, float)) and not isinstance(size, bool) else None, saved=time.monotonic())
            event = {key: value for key, value in workspace.items() if key != "saved"}
        # The whole workspace travels with the event, so a following page can apply it at once.
        hub.publish(dict(type="workspace", **event))
        return jsonify(ok=True)

    @app.get("/api/workspace")
    def workspace_now():
        with lock:
            if not workspace:
                return jsonify({})  # nothing handed off yet
            return jsonify({**{key: value for key, value in workspace.items() if key != "saved"}, "age_s": round(time.monotonic()-workspace["saved"])})

    @sock.route("/api/live")
    def live(ws):
        hub.serve(ws)

    @app.get("/api/location/zip/<zipcode>")
    def locate_zip(zipcode):
        return jsonify(zip_client.lookup(zipcode))

    @app.get("/api/location/search")
    def locate_place():
        return jsonify(place_client.lookup(request.args.get("q", "")))

    @app.post("/api/features/<identifier>")
    def create_features(identifier):
        records, fetch = feature_records()
        terrain = find_terrain(identifier)
        if terrain is None:
            return jsonify(error="Terrain is unavailable. Generate the area again."), 404
        with lock:
            existing = records.get(identifier)
            if existing and existing["state"] != "error":
                existing["accessed"] = time.monotonic()
                return jsonify(id=identifier, state=existing["state"]), 200 if existing["state"] == "ready" else 202
            finished = sorted((key for key in records if records[key]["state"] in ("ready", "error")),
                              key=lambda key: records[key]["accessed"])
            for key in finished:
                if len(records) >= 12 or time.monotonic()-records[key]["accessed"] > 3600:
                    del records[key]
            if sum(record["state"] in ("queued", "loading") for record in records.values()) >= 2:
                return jsonify(error="Two map feature downloads are already running. Wait for one to finish."), 429
            records[identifier] = dict(state="queued", message="Preparing map features…", accessed=time.monotonic())
        executor.features.submit(run_features, identifier, terrain, records, fetch)
        return jsonify(id=identifier, state="queued"), 202

    @app.get("/api/features/<identifier>")
    def get_features(identifier):
        records, _ = feature_records()
        if find_terrain(identifier) is None:
            return jsonify(error="Terrain is unavailable. Generate the area again."), 404
        with lock:
            record = records.get(identifier)
            if record is None:
                return jsonify(error="Map features have not been requested for this terrain."), 404
            record["accessed"] = time.monotonic()
            result = {"state": record["state"], "message": record["message"]}
            if record["state"] == "ready":
                result.update(record["data"])
        return jsonify(result)

    @app.post("/api/landcover/<identifier>")
    def create_cover(identifier):
        terrain = find_terrain(identifier)
        if terrain is None:
            return jsonify(error="Terrain is unavailable. Generate the area again."), 404
        with lock:
            existing = cover_jobs.get(identifier)
            if existing and existing["state"] != "error":
                existing["accessed"] = time.monotonic()
                return jsonify(id=identifier, state=existing["state"]), 200 if existing["state"] == "ready" else 202
            finished = sorted((key for key in cover_jobs if cover_jobs[key]["state"] in ("ready", "error")), key=lambda key: cover_jobs[key]["accessed"])
            for key in finished:
                if len(cover_jobs) >= 12 or time.monotonic()-cover_jobs[key]["accessed"] > 3600:
                    del cover_jobs[key]
            if sum(record["state"] in ("queued", "loading") for record in cover_jobs.values()) >= 2:
                return jsonify(error="Two surface maps are already loading. Wait for one to finish."), 429
            cover_jobs[identifier] = dict(state="queued", message="Preparing mapped colors…", accessed=time.monotonic())
        executor.features.submit(run_cover, identifier, terrain)
        return jsonify(id=identifier, state="queued"), 202

    @app.get("/api/landcover/<identifier>")
    def get_cover(identifier):
        if find_terrain(identifier) is None:
            return jsonify(error="Terrain is unavailable. Generate the area again."), 404
        with lock:
            record = cover_jobs.get(identifier)
            if record is None:
                return jsonify(error="Select the Print palette to request a surface map."), 404
            record["accessed"] = time.monotonic()
            result = {"state": record["state"], "message": record["message"]}
            if record["state"] == "ready":
                result.update(record["data"])
        return jsonify(result)

    @app.post("/api/terrain")
    def create_terrain():
        payload = request.get_json()
        if not isinstance(payload, dict):
            raise ValueError("Supply a bounding box and resolution.")
        bounds = Bounds.from_dict(payload.get("bounds"))
        resolution = payload.get("resolution", 160)
        grid_shape(bounds, resolution)
        source = source_id(payload.get("source", DEFAULT_SOURCE))
        with lock:
            prune_jobs()
            if sum(job["state"] in ("queued", "loading") for job in jobs.values()) >= 4:
                return jsonify(error="Four terrain downloads are already running. Wait for one to finish."), 429
            identifier = uuid.uuid4().hex
            name = payload.get("name")
            # A preview (the VR cut's surroundings) is not announced to other devices as new terrain.
            jobs[identifier] = dict(state="queued", progress=0, message="Preparing elevation download…", accessed=time.monotonic(),
                                    name=name.strip()[:120] if isinstance(name, str) else "", preview=payload.get("preview") is True)
        executor.terrain.submit(run_job, identifier, bounds, resolution, source)
        return jsonify(id=identifier), 202

    @app.get("/api/jobs/<identifier>")
    def job_status(identifier):
        with lock:
            record = jobs.get(identifier)
            if not record:
                return jsonify(error="Terrain job expired. Generate the area again."), 404
            record["accessed"] = time.monotonic()
            return jsonify({key: record[key] for key in ("state", "progress", "message")})

    @app.post("/api/transcribe")
    def transcribe():
        """Voice search and voice commands: the headset's recording (16 kHz samples) to text, on this computer; nothing
        is kept. purpose "command" expects the VR voice commands, "search" (the default) a place."""
        if not transcriber.available():
            return jsonify(error="Voice search needs faster-whisper on the computer: pip install faster-whisper"), 503
        payload = request.get_json(silent=True)
        samples, purpose = decode_samples(payload), purpose_of(payload)
        vocabulary = vocabulary_of(payload) if purpose == "command" else ()
        try:
            text = transcriber.transcribe(samples, purpose, vocabulary)
        except Exception:
            LOGGER.exception("Transcription failed")
            return jsonify(error="The voice search could not be understood. Try again, or type it."), 500
        return jsonify(text=text[:200])

    @app.get("/api/relief/<int:zoom>/<int:x>/<int:y>")
    def relief_tile(zoom, x, y):
        """The VR map's relief: a small float32 height grid (meters, little-endian, row by row from the north-west)
        for one map tile. X-Relief-Size gives the grid size; X-Relief-Missing marks areas without elevation data."""
        try:
            size = int(request.args.get("size", "17"))
        except ValueError:
            raise ValueError("size must be a whole number.") from None
        heights, found = relief.grid(zoom, x, y, size)
        body = np.ascontiguousarray(heights, dtype="<f4").tobytes()
        response = Response(gzip.compress(body, compresslevel=5) if "gzip" in request.headers.get("Accept-Encoding", "") else body,
                            mimetype="application/octet-stream")
        if "gzip" in request.headers.get("Accept-Encoding", ""):
            response.headers["Content-Encoding"] = "gzip"
        response.headers["X-Relief-Size"] = str(size)
        response.headers["Vary"] = "Accept-Encoding"
        if not found:
            response.headers["X-Relief-Missing"] = "1"
        # Elevation does not change: let the headset keep tiles it has seen (this beats the API's no-store default).
        response.headers["Cache-Control"] = "private, max-age=86400"
        return response

    @app.get("/api/terrain/<identifier>")
    def get_terrain(identifier):
        terrain = find_terrain(identifier)
        if terrain is None:
            return jsonify(error="Terrain is unavailable. Generate the area again."), 404
        try:
            sigma = float(request.args.get("smoothing", "0"))
        except ValueError:
            raise ValueError("Smoothing must be numeric.") from None
        relief = relief_method(request.args.get("relief", "standard"))
        try:
            strength = float(request.args.get("relief_strength", "50"))
        except ValueError:
            raise ValueError("relief_strength must be numeric.") from None
        true_heights = smooth_elevations(terrain, sigma)
        heights = shape_elevations(true_heights, relief, strength)
        result = dict(id=identifier, **terrain.metadata(), smoothing=sigma, relief=relief, relief_strength=strength,
                      surface_min_m=float(heights.min()), surface_max_m=float(heights.max()),
                      elevations=np.round(heights, 4).ravel().tolist())
        reshaped = heights is not true_heights
        if request.args.get("format") == "binary":
            return binary_terrain(result, heights, true_heights if reshaped else None)
        if reshaped:
            # The model is reshaped; colors, contours, and the profile still use real elevations.
            result["true_elevations"] = np.round(true_heights, 4).ravel().tolist()
        return jsonify(result)

    def binary_terrain(result, heights, true_heights):
        """The surface as little-endian float32 grids after a JSON header: under half the JSON size, gzipped when
        the browser accepts it. Layout: uint32 header length, header JSON (padded to 4 bytes), elevations, true elevations."""
        result = {**result, "elevations": None, "arrays": ["elevations"] + (["true_elevations"] if true_heights is not None else [])}
        header = json.dumps(result, separators=(",", ":")).encode()
        header += b" " * (-len(header) % 4)
        body = struct.pack("<I", len(header)) + header + np.asarray(heights, dtype="<f4").tobytes()
        if true_heights is not None:
            body += np.asarray(true_heights, dtype="<f4").tobytes()
        response = Response(body, mimetype="application/octet-stream")
        if "gzip" in request.headers.get("Accept-Encoding", ""):
            response.set_data(gzip.compress(body, compresslevel=5))
            response.headers["Content-Encoding"] = "gzip"
        response.headers["Vary"] = "Accept-Encoding"
        return response

    def print_inputs(identifier, features, colors):
        """Surface classes and loaded map features for 3MF color parts; a ValueError says what is still loading."""
        if colors is None:
            raise ValueError("Select the Print palette and choose its surface colors before exporting 3MF.")
        with lock:
            record = cover_jobs.get(identifier)
            if not record or record["state"] != "ready":
                raise ValueError("Wait for the mapped surface colors to load before exporting 3MF.")
            classes = np.asarray(record["data"]["face_classes"], dtype=np.uint8)
        feature_data = None
        if any(style["enabled"] for style in features.values()):
            with lock:
                feature_record = feature_jobs.get(identifier)
                if not feature_record or feature_record["state"] != "ready":
                    raise ValueError("Wait for selected map features to load before exporting 3MF.")
                feature_data = feature_record["data"]
                if features.get("water", {}).get("enabled") and features["water"].get("source", "osm") == "usgs":
                    water_record = water_jobs.get(identifier)
                    if not water_record or water_record["state"] != "ready":
                        raise ValueError("Wait for USGS waterways to load before exporting 3MF.")
                    # Preserve OSM's open-sea geometry, which 3DHP doesn't supply.
                    sea = [feature for feature in feature_data["layers"]["water"] if feature.get("kind") == "sea"]
                    feature_data = {**feature_data, "layers": {**feature_data["layers"], "water": sea + water_record["data"]["water"]}}
                if features.get("buildings", {}).get("enabled"):
                    building_record = building_jobs.get(identifier)
                    if not building_record or building_record["state"] != "ready":
                        raise ValueError("Wait for buildings to load before exporting 3MF.")
                    feature_data = {**feature_data, "layers": {**feature_data["layers"], "buildings": building_record["data"]["layers"]["buildings"]}}
        return classes, feature_data

    def available_print_inputs(identifier, features, colors):
        """For GLB files and previews: color parts once the surface map is ready, map features once they are loaded."""
        for layers in (features, {}):
            try:
                return print_inputs(identifier, layers, colors)
            except ValueError:
                pass
        return None, None

    def marker_buildings(identifier, project):
        """The loaded building layer when marker platforms carry buildings (whether or not the layer is shown)."""
        if platform_top(project) != "building":
            return None
        with lock:
            record = building_jobs.get(identifier)
            return record["data"]["layers"]["buildings"] if record and record["state"] == "ready" else None

    def route_layer(payload, terrain):
        """The uploaded route's style and its lines in this terrain's frame, or None when it is off."""
        style = route_options(payload.get("route"))
        if style is None:
            return None
        route = route_store.load(style["id"])
        if route is None:
            raise ValueError("The uploaded route is no longer available. Upload the GPX file again.")
        return style, route_lines(route, terrain.bounds)

    def add_route(payload, terrain, features, feature_data):
        layer = route_layer(payload, terrain)
        return with_route(features, feature_data, *layer) if layer else (features, feature_data)

    def export_payload():
        payload = request.get_json()
        if not isinstance(payload, dict):
            raise ValueError("Supply export options.")
        return (payload, ModelOptions.from_dict(payload), layer_options(payload.get("feature_layers")),
                print_colors(payload.get("print_palette")), project_options(payload.get("project")))

    @app.post("/api/export/<identifier>")
    def export(identifier):
        terrain = find_terrain(identifier)
        if terrain is None:
            return jsonify(error="Terrain is unavailable. Generate the area again."), 404
        payload, options, features, colors, project = export_payload()
        format = payload.get("format", "stl")
        attribution = (ROOT / "data" / "ATTRIBUTION.txt").read_text(encoding="utf-8")
        if format == "3mf":
            classes, feature_data = print_inputs(identifier, features, colors)
            features, feature_data = add_route(payload, terrain, features, feature_data)
            # The project is passed only when there is one, keeping the call unchanged for plain exports.
            content, mimetype, filename = export_3mf(terrain, options, colors, classes, attribution, features, feature_data,
                                                     **({"project": project, "buildings": marker_buildings(identifier, project)} if project else {}))
        else:
            content, mimetype, filename = export_file(terrain, options, format, attribution, features, colors, project)
        return send_file(content, mimetype=mimetype, as_attachment=True, download_name=filename)

    def prune_studio_jobs():
        now = time.monotonic()
        finished = sorted((key for key, job in studio_jobs.items() if job["state"] in ("ready", "error")), key=lambda key: studio_jobs[key]["finished"])
        for key in finished:
            if now-studio_jobs[key]["finished"] > 600 or len(studio_jobs) >= 6:
                del studio_jobs[key]

    def run_studio_job(identifier, work):
        def progress(fraction, message):
            with lock:
                studio_jobs[identifier].update(state="running", progress=round(float(fraction), 3), message=message)
        progress(0, "Starting the export…")
        try:
            content, mimetype, filename = work(progress=progress)
            with lock:
                studio_jobs[identifier].update(state="ready", progress=1, message="Ready to download.", content=content,
                                               mimetype=mimetype, filename=filename, finished=time.monotonic())
        except Exception as error:
            LOGGER.exception("Print Studio export failed")
            message = str(error) if isinstance(error, ValueError) else "The export failed. Try a smaller area or check the terminal for details."
            with lock:
                studio_jobs[identifier].update(state="error", message=message, finished=time.monotonic())

    @app.get("/api/studio/catalog")
    def studio_types():
        # Not jsonify: its sorted keys would scramble the parameter order the forms are built in.
        return app.response_class(json.dumps(studio_catalog()), mimetype="application/json")

    @app.post("/api/studio/<identifier>/check")
    def studio_check(identifier):
        terrain = find_terrain(identifier)
        if terrain is None:
            return jsonify(error="Terrain is unavailable. Generate the area again."), 404
        payload, options, features, colors, project = export_payload()
        bed = payload.get("bed_mm", 256)
        if isinstance(bed, bool) or not isinstance(bed, (int, float)) or not 50 <= bed <= 2000:
            raise ValueError("Printer bed size must be between 50 and 2000 mm.")
        features, _ = add_route(payload, terrain, features, None)  # its color counts toward the filament limit
        return jsonify(check_project(terrain, options, project, colors, features, payload.get("format", "3mf"), bed,
                                     buildings=marker_buildings(identifier, project)))

    @app.post("/api/studio/<identifier>/text-outline")
    def studio_text(identifier):
        payload = request.get_json()
        if not isinstance(payload, dict):
            raise ValueError("Supply the text and its size.")
        return jsonify(text_outline(payload.get("text", ""), payload.get("text_size", 6)))

    @app.post("/api/studio/<identifier>/export")
    def studio_export_job(identifier):
        terrain = find_terrain(identifier)
        if terrain is None:
            return jsonify(error="Terrain is unavailable. Generate the area again."), 404
        payload, options, features, colors, project = export_payload()
        preview = payload.get("preview", False)
        if not isinstance(preview, bool):
            raise ValueError("preview must be true or false.")
        format = "glb" if preview else studio_format(payload.get("format", "stl"))
        classes = feature_data = None
        if format == "3mf":
            classes, feature_data = print_inputs(identifier, features, colors)
        elif format == "glb":
            classes, feature_data = available_print_inputs(identifier, features, colors)
        if format in ("3mf", "glb"):
            features, feature_data = add_route(payload, terrain, features, feature_data)
        if project and project["addons"] and not options.solid and format in ("stl", "obj", "3mf", "glb"):
            raise ValueError("Enable Solid base to add holes, pockets, and other add-ons.")
        attribution = (ROOT / "data" / "ATTRIBUTION.txt").read_text(encoding="utf-8")
        with lock:
            prune_studio_jobs()
            if sum(job["state"] in ("queued", "running") for job in studio_jobs.values()) >= 4:
                return jsonify(error="Four exports are already running. Wait for one to finish."), 429
            job = uuid.uuid4().hex
            studio_jobs[job] = dict(state="queued", progress=0, message="Waiting to start…", finished=None)
        executor.studio.submit(run_studio_job, job, partial(studio_export, terrain, options, format, attribution, palette=colors, classes=classes,
                                                            feature_layers=features, feature_data=feature_data, project=project, preview_mesh=preview,
                                                            buildings=marker_buildings(identifier, project)))
        return jsonify(job=job), 202

    @app.get("/api/studio/jobs/<job>")
    def studio_job(job):
        with lock:
            record = studio_jobs.get(job)
            if record is None:
                return jsonify(error="This export has expired. Export again."), 404
            result = {key: record[key] for key in ("state", "progress", "message")}
            if record["state"] == "ready":
                result["filename"] = record["filename"]
        return jsonify(result)

    @app.get("/api/studio/jobs/<job>/file")
    def studio_job_file(job):
        with lock:
            record = studio_jobs.get(job)
            if record is None:
                return jsonify(error="This export has expired. Export again."), 404
            if record["state"] != "ready":
                return jsonify(error="This export is not ready yet."), 409
            content, mimetype, filename = record["content"], record["mimetype"], record["filename"]
        return send_file(BytesIO(content), mimetype=mimetype, as_attachment=True, download_name=filename)

    @app.get("/api/studio/marker-ball")
    def studio_marker_ball():
        color = request.args.get("color") or BALL_COLOR
        if not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
            raise ValueError("Choose a six-digit hex color for the marker ball.")
        content, mimetype, filename = marker_ball_file(request.args.get("format", "stl"), color.lower())
        return send_file(BytesIO(content), mimetype=mimetype, as_attachment=True, download_name=filename)

    @app.get("/api/studio/marker-platform")
    def studio_marker_platform():
        color = request.args.get("color") or BALL_COLOR
        if not re.fullmatch(r"#[0-9a-fA-F]{6}", color):
            raise ValueError("Choose a six-digit hex color for the marker platform.")
        content, mimetype, filename = marker_platform_file(request.args.get("format", "stl"), color.lower())
        return send_file(BytesIO(content), mimetype=mimetype, as_attachment=True, download_name=filename)

    # Silhouette design page: profile slices (or the uploaded route's profile) as flat pieces. Small and fast, so answered synchronously.
    def silhouette_sources(identifier, options):
        """The uploaded route for a route profile, and the loaded building layer for a skyline (None while not loaded)."""
        route = buildings = None
        if options.source == "route":
            route = route_store.load(options.route_id)
            if route is None:
                raise ValueError("The uploaded route is no longer available. Upload the GPX file again.")
        if options.include_buildings:
            with lock:
                record = building_jobs.get(identifier)
                buildings = record["data"]["layers"]["buildings"] if record and record["state"] == "ready" else None
        return Sources(route, buildings)

    @app.post("/api/silhouette/text")
    def silhouette_text():
        """The text editor's preview of a text block (no terrain needed)."""
        return jsonify(text_block_json(request.get_json(silent=True)))

    @app.post("/api/silhouette/<identifier>/outline")
    def silhouette_outline(identifier):
        terrain = find_terrain(identifier)
        if terrain is None:
            return jsonify(error="Terrain is unavailable. Generate the area again."), 404
        options = SilhouetteOptions.from_dict(request.get_json())
        return jsonify(outline_json(terrain, options, silhouette_sources(identifier, options)))

    @app.post("/api/silhouette/<identifier>/export")
    def silhouette_file(identifier):
        terrain = find_terrain(identifier)
        if terrain is None:
            return jsonify(error="Terrain is unavailable. Generate the area again."), 404
        payload = request.get_json()
        options = SilhouetteOptions.from_dict(payload)
        attribution = (ROOT / "data" / "ATTRIBUTION.txt").read_text(encoding="utf-8")
        content, mimetype, filename = silhouette_export(terrain, options, payload.get("format", "stl"), attribution,
                                                        silhouette_sources(identifier, options))
        return send_file(BytesIO(content), mimetype=mimetype, as_attachment=True, download_name=filename)

    @app.post("/api/silhouette/<identifier>/cylinder-lamp")
    def silhouette_cylinder_lamp(identifier):
        """Hand the silhouette's layers to CylinderLamp (started if needed) and answer the page to open there; with
        ?download=1, the handoff file itself."""
        terrain = find_terrain(identifier)
        if terrain is None:
            return jsonify(error="Terrain is unavailable. Generate the area again."), 404
        payload = request.get_json()
        options = SilhouetteOptions.from_dict({key: value for key, value in payload.items() if key != "name"})
        attribution = (ROOT / "data" / "ATTRIBUTION.txt").read_text(encoding="utf-8")
        data = lamp_handoff.lamp_silhouette(terrain, options, silhouette_sources(identifier, options),
                                            str(payload.get("name") or "")[:80], attribution)
        if request.args.get("download"):
            return send_file(BytesIO(json.dumps(data, indent=1).encode()), mimetype="application/json", as_attachment=True,
                             download_name="lamp-silhouette.json")
        handoff = lamp_handoff.save_handoff(data)
        running = lamp_handoff.start_lamp()
        return jsonify(id=handoff, url=f"{lamp_handoff.lamp_url()}/?silhouette={handoff}", running=running,
                       layers=len(data["layers"]))

    @app.post("/api/profile/<identifier>")
    def terrain_profile(identifier):
        """A ridgeline between two points or the skyline from a viewpoint, for the geography page's profile chart."""
        terrain = find_terrain(identifier)
        if terrain is None:
            return jsonify(error="Terrain is unavailable. Generate the area again."), 404
        return jsonify(profile_json(terrain, profile_options(request.get_json())))

    @app.post("/api/routes")
    def upload_route():
        # GPX text arrives as JSON (the same-origin guard accepts only JSON posts), so allow a larger body here.
        request.max_content_length = MAX_GPX_BYTES*2+4096
        payload = request.get_json()
        if not isinstance(payload, dict) or not isinstance(payload.get("gpx"), str):
            raise ValueError("Choose a GPX file to upload.")
        filename = payload.get("filename") if isinstance(payload.get("filename"), str) else ""
        return jsonify(public_route(route_store.save(payload["gpx"].encode("utf-8"), filename[:200])))

    @app.get("/api/routes/<route>")
    def get_route(route):
        found = route_store.load(route)
        if found is None:
            return jsonify(error="The uploaded route is no longer available. Upload the GPX file again."), 404
        return jsonify(public_route(found))

    @app.get("/api/routes/<route>/lines/<identifier>")
    def get_route_lines(route, identifier):
        terrain, found = find_terrain(identifier), route_store.load(route)
        if terrain is None:
            return jsonify(error="Terrain is unavailable. Generate the area again."), 404
        if found is None:
            return jsonify(error="The uploaded route is no longer available. Upload the GPX file again."), 404
        return jsonify(lines=route_lines(found, terrain.bounds))

    @app.get("/api/attribution")
    def attribution():
        return send_file(ROOT / "data" / "ATTRIBUTION.txt", mimetype="text/plain",
                         as_attachment=request.args.get("download") == "1",
                         download_name="terrain-credits.txt")

    return app
