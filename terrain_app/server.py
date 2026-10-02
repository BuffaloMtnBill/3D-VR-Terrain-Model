"""Local HTTP interface and bounded background elevation downloads."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import RLock
import logging
import os
import time
import uuid

from flask import Flask, jsonify, render_template, request, send_file
import numpy as np

from .elevation import Bounds, DEFAULT_SOURCE, SOURCES, THREE_DEP_URL, ElevationClient, Terrain, ThreeDepClient, grid_shape, source_id
from .mesh import ModelOptions, export_file, relief_method, shape_elevations, smooth_elevations
from .places import DEFAULT_PLACE, PRESETS
from .features import FeatureClient, OVERPASS_URL, layer_options
from .services import GEOCODER_URL, PlaceClient, ZipClient, ZipLookupError
from .landcover import LandCoverClient, print_colors, face_classes
from .printing import export_3mf

ROOT = Path(__file__).parent
LOGGER = logging.getLogger(__name__)
STREET_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
STREET_ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
TERRAIN_ATTRIBUTION = STREET_ATTRIBUTION + ' · SRTM · <a href="https://opentopomap.org/about" target="_blank" rel="noopener">OpenTopoMap</a> (<a href="https://creativecommons.org/licenses/by-sa/3.0/" target="_blank" rel="noopener">CC-BY-SA</a>)'


def load_example():
    path = ROOT / "data" / f"{DEFAULT_PLACE}.npz"
    if not path.exists():
        return None
    with np.load(path, allow_pickle=False) as data:
        return Terrain(Bounds(*data["bounds"].tolist()), data["elevations"].copy(),
                       int(data["zoom"]), int(data["tile_count"]), str(data["fetched_at"]))


class WorkerPools:
    def __init__(self, terrain, features):
        self.terrain, self.features = terrain, features

    def shutdown(self, wait=True):
        self.terrain.shutdown(wait=wait)
        self.features.shutdown(wait=wait)


def create_app(test_config=None):
    app = Flask(__name__)
    app.config.update(MAX_CONTENT_LENGTH=16_384,
                      TRUSTED_HOSTS=os.environ.get("TERRAIN_TRUSTED_HOSTS", "localhost,127.0.0.1,[::1]").split(","),
                      MAP_TILE_URL=os.environ.get("TERRAIN_MAP_TILE_URL", "https://tile.opentopomap.org/{z}/{x}/{y}.png"),
                      MAP_ATTRIBUTION=os.environ.get("TERRAIN_MAP_ATTRIBUTION", TERRAIN_ATTRIBUTION),
                      MAP_MAX_NATIVE_ZOOM=int(os.environ.get("TERRAIN_MAP_MAX_NATIVE_ZOOM", "17")),
                      CACHE_DIR=os.environ.get("TERRAIN_CACHE_DIR", str(Path.cwd() / ".cache" / "elevation")))
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
    # Slow map-feature services must not hold up elevation downloads.
    executor = WorkerPools(ThreadPoolExecutor(max_workers=2, thread_name_prefix="terrain-job"),
                           ThreadPoolExecutor(max_workers=3, thread_name_prefix="feature-job"))
    lock = RLock()
    jobs = {}
    feature_jobs = {}
    building_jobs = {}
    cover_jobs = {}
    example = load_example()
    app.extensions["terrain"] = {"client": client, "clients": clients, "jobs": jobs, "lock": lock, "executor": executor,
                                 "features": feature_client, "feature_jobs": feature_jobs, "building_jobs": building_jobs, "zip": zip_client, "places": place_client,
                                 "landcover": cover_client, "cover_jobs": cover_jobs}

    @app.before_request
    def same_origin():
        # JSON requests from the local UI; reject mutations from foreign pages.
        if request.method == "POST":
            if not request.is_json:
                return jsonify(error="Send an application/json request."), 415
            origin = request.headers.get("Origin")
            if origin and origin.rstrip("/") != request.host_url.rstrip("/"):
                return jsonify(error="This request must originate from Terrain Studio."), 403

    @app.after_request
    def response_headers(response):
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        if request.path.startswith("/api/"):
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
        try:
            terrain = clients[source].fetch(bounds, resolution, progress)
            with lock:
                jobs[identifier].update(state="ready", progress=1, message="Terrain ready", terrain=terrain, accessed=time.monotonic())
        except Exception as error:
            LOGGER.exception("Elevation download failed")
            message = str(error) if isinstance(error, ValueError) else "Terrain processing failed. Try a smaller selection or check the terminal for details."
            with lock:
                jobs[identifier].update(state="error", message=message, accessed=time.monotonic())

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
        if layer not in ("", "buildings"):
            raise ValueError("Request all map features, or layer=buildings.")
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
        return render_template("index.html", presets=PRESETS, default_place=DEFAULT_PLACE)

    @app.get("/api/config")
    def config():
        return jsonify(map_tile_url=app.config["MAP_TILE_URL"], map_attribution=app.config["MAP_ATTRIBUTION"],
                       map_max_native_zoom=app.config["MAP_MAX_NATIVE_ZOOM"],
                       street_tile_url=STREET_URL, street_attribution=STREET_ATTRIBUTION,
                       presets=PRESETS, default_place=DEFAULT_PLACE,
                       elevation_sources={key: value["label"] for key, value in SOURCES.items()},
                       example_available=example is not None)

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
            jobs[identifier] = dict(state="queued", progress=0, message="Preparing elevation download…", accessed=time.monotonic())
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
        if heights is not true_heights:
            # The model is reshaped; colors, contours, and the profile still use real elevations.
            result["true_elevations"] = np.round(true_heights, 4).ravel().tolist()
        return jsonify(result)

    @app.post("/api/export/<identifier>")
    def export(identifier):
        terrain = find_terrain(identifier)
        if terrain is None:
            return jsonify(error="Terrain is unavailable. Generate the area again."), 404
        payload = request.get_json()
        if not isinstance(payload, dict):
            raise ValueError("Supply export options.")
        options = ModelOptions.from_dict(payload)
        features = layer_options(payload.get("feature_layers"))
        colors = print_colors(payload.get("print_palette"))
        format = payload.get("format", "stl")
        attribution = (ROOT / "data" / "ATTRIBUTION.txt").read_text(encoding="utf-8")
        if format == "3mf":
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
                    if features.get("buildings", {}).get("enabled"):
                        building_record = building_jobs.get(identifier)
                        if not building_record or building_record["state"] != "ready":
                            raise ValueError("Wait for buildings to load before exporting 3MF.")
                        feature_data = {**feature_data, "layers": {**feature_data["layers"], "buildings": building_record["data"]["layers"]["buildings"]}}
            content, mimetype, filename = export_3mf(terrain, options, colors, classes, attribution, features, feature_data)
        else:
            content, mimetype, filename = export_file(terrain, options, format, attribution, features, colors)
        return send_file(content, mimetype=mimetype, as_attachment=True, download_name=filename)

    @app.get("/api/attribution")
    def attribution():
        return send_file(ROOT / "data" / "ATTRIBUTION.txt", mimetype="text/plain",
                         as_attachment=request.args.get("download") == "1",
                         download_name="terrain-credits.txt")

    return app
