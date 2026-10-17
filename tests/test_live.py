"""The headset link: binary surfaces, live events, and LAN pairing."""
import gzip
import json
import struct
import time

import numpy as np
import pytest
from simple_websocket import ConnectionClosed

from terrain_app.elevation import Bounds, Terrain
from terrain_app.live import Hub
from terrain_app.pairing import COOKIE, LOCKOUT, MAX_FAILURES, Pairing
from terrain_app.server import create_app

HEADSET = {"REMOTE_ADDR": "192.168.0.50"}


@pytest.fixture
def app(tmp_path):
    app = create_app({"TESTING": True, "CACHE_DIR": tmp_path / "tiles"})
    yield app
    app.extensions["terrain"]["executor"].shutdown(wait=True)


@pytest.fixture
def paired_app(app, tmp_path):
    app.config["PAIRING"] = Pairing(tmp_path / "tls", "246810")
    return app


def decode(body):
    length = struct.unpack_from("<I", body)[0]
    header = json.loads(body[4:4+length])
    count, offset, arrays = header["rows"]*header["columns"], 4+length, {}
    for name in header["arrays"]:
        arrays[name] = np.frombuffer(body, "<f4", count, offset)
        offset += count*4
    assert offset == len(body)
    return header, arrays


@pytest.mark.parametrize("relief", ["standard", "local"])
def test_binary_surface_matches_the_json_one(app, relief):
    client = app.test_client()
    expected = client.get(f"/api/terrain/example?relief={relief}").get_json()
    response = client.get(f"/api/terrain/example?relief={relief}&format=binary")
    assert response.mimetype == "application/octet-stream"
    header, arrays = decode(response.get_data())
    assert header["rows"] == expected["rows"] and header["relief"] == relief
    np.testing.assert_allclose(arrays["elevations"], expected["elevations"], atol=1e-3)
    if "true_elevations" in expected:
        np.testing.assert_allclose(arrays["true_elevations"], expected["true_elevations"], atol=1e-3)
    else:
        assert header["arrays"] == ["elevations"]
    # Well under half the JSON size, and smaller again when gzipped.
    assert len(response.get_data())*2 < len(json.dumps(expected))
    zipped = client.get(f"/api/terrain/example?relief={relief}&format=binary", headers={"Accept-Encoding": "gzip, br"})
    assert zipped.headers["Content-Encoding"] == "gzip"
    assert gzip.decompress(zipped.get_data()) == response.get_data()


def test_job_progress_and_new_terrain_are_pushed_live(app, monkeypatch):
    heights = np.arange(20, dtype=np.float32).reshape(4, 5)
    terrain = Terrain(Bounds(37.695, -119.665, 37.785, -119.525), heights, 11, 4, "2026-09-30T00:00:00Z")

    def fetch(bounds, resolution, progress):
        progress(.5, "Downloading test tiles")
        return terrain
    monkeypatch.setattr(app.extensions["terrain"]["client"], "fetch", fetch)
    events = []
    monkeypatch.setattr(app.extensions["terrain"]["live"], "publish", events.append)
    client = app.test_client()
    identifier = client.post("/api/terrain", json={"bounds": terrain.metadata()["bounds"], "resolution": 96, "name": " Half Dome "}).get_json()["id"]
    for _ in range(200):
        if any(event["type"] == "terrain" for event in events):
            break
        time.sleep(.01)
    assert [event.get("state") for event in events if event["type"] == "job"] == ["loading", "ready"]
    assert {"type": "terrain", "id": identifier, "name": "Half Dome"} in events


class FakeSocket:
    def __init__(self, closes_after):
        self.sent, self.closes_after = [], closes_after

    def send(self, data):
        self.sent.append(json.loads(data))
        if len(self.sent) > self.closes_after:
            raise ConnectionClosed()

    def receive(self, timeout=None):
        return None


def test_hub_says_hello_then_forwards_events():
    hub = Hub()
    socket = FakeSocket(closes_after=2)
    hub.publish({"type": "lost"})  # nobody listening yet
    from threading import Thread
    thread = Thread(target=lambda: pytest.raises(ConnectionClosed, hub.serve, socket))
    thread.start()
    for _ in range(200):
        if hub.listeners:
            break
        time.sleep(.005)
    hub.publish({"type": "job", "id": "a"})
    hub.publish({"type": "job", "id": "b"})
    thread.join(2)
    assert socket.sent == [{"type": "hello", "boot": hub.boot}, {"type": "job", "id": "a"}, {"type": "job", "id": "b"}]
    assert hub.listeners == 0


def test_live_channel_rejects_foreign_pages(app):
    response = app.test_client().get("/api/live", headers={"Origin": "https://example.com"})
    assert response.status_code == 403


def test_without_lan_mode_nothing_needs_pairing(app):
    client = app.test_client()
    assert client.get("/api/config", environ_base=HEADSET).status_code == 200
    assert client.get("/api/config").get_json()["pairing_pin"] is None


def test_other_devices_must_pair_first(paired_app):
    client = paired_app.test_client()
    assert client.get("/", environ_base=HEADSET).headers["Location"].endswith("/pair")
    assert client.get("/api/config", environ_base=HEADSET).status_code == 401
    assert client.get("/static/app.js", environ_base=HEADSET).status_code == 401
    assert client.get("/api/live", environ_base=HEADSET).status_code == 401
    assert "Pair this device" in client.get("/pair", environ_base=HEADSET).get_data(as_text=True)
    # This computer itself never pairs, and it is the only place the PIN is shown.
    assert client.get("/api/config").get_json()["pairing_pin"] == "246810"


def test_the_right_pin_pairs_a_device_for_good(paired_app, tmp_path):
    client = paired_app.test_client()
    assert client.post("/api/pair", json={"pin": "000000"}, environ_base=HEADSET).status_code == 403
    response = client.post("/api/pair", json={"pin": "246810"}, environ_base=HEADSET)
    assert response.status_code == 200
    cookie = response.headers["Set-Cookie"]
    assert "HttpOnly" in cookie and "SameSite=Strict" in cookie
    config = client.get("/api/config", environ_base=HEADSET)
    assert config.status_code == 200 and config.get_json()["pairing_pin"] is None
    # Pairing survives a server restart; only hashes of the tokens are stored.
    token = client.get_cookie(COOKIE).value
    assert Pairing(tmp_path / "tls").is_paired(token)
    assert token not in (tmp_path / "tls" / "paired.json").read_text()
    other = paired_app.test_client()
    other.set_cookie(COOKIE, "guessed-token")
    assert other.get("/api/config", environ_base=HEADSET).status_code == 401


def test_wrong_pins_pause_pairing(tmp_path, monkeypatch):
    pairing = Pairing(tmp_path, "123456")
    clock = [1000.0]
    monkeypatch.setattr("terrain_app.pairing.time.monotonic", lambda: clock[0])
    for _ in range(MAX_FAILURES):
        assert pairing.pair("999999") is None
    with pytest.raises(PermissionError):
        pairing.pair("123456")  # even the right PIN waits out the pause
    clock[0] += LOCKOUT+1
    assert pairing.pair("123456")


def test_forget_all_unpairs_every_device(tmp_path):
    pairing = Pairing(tmp_path, "123456")
    token = pairing.pair("123456")
    pairing.forget_all()
    assert not Pairing(tmp_path).is_paired(token)


ROAN = {"south": 36.08, "west": -82.165, "north": 36.145, "east": -82.055, "rotation_deg": 25, "shape": "oval"}


def test_the_headset_hands_off_its_workspace(app, monkeypatch):
    events = []
    monkeypatch.setattr(app.extensions["terrain"]["live"], "publish", events.append)
    client = app.test_client()
    assert client.get("/api/workspace").get_json() == {}
    payload = {"page": "headset", "name": "Roan Mountain", "place": "custom", "selection": ROAN, "terrain_id": "abc",
               "palette": "earth", "controls": {"exaggeration": 3.5, "contours": True, "bad": {"nested": 1}}, "export_size": 220}
    assert client.post("/api/workspace", json=payload).status_code == 200
    # The event carries the whole workspace, so following pages apply it without another request.
    assert len(events) == 1 and events[0]["type"] == "workspace"
    assert events[0]["selection"] == ROAN and events[0]["controls"]["exaggeration"] == 3.5 and "saved" not in events[0]
    shared = client.get("/api/workspace").get_json()
    assert shared["selection"] == ROAN and shared["export_size"] == 220 and shared["age_s"] == 0
    assert shared["controls"] == {"exaggeration": 3.5, "contours": True}  # only plain values pass


@pytest.mark.parametrize("selection", [None, {"south": 1}, {**ROAN, "shape": "star"}])
def test_a_workspace_needs_a_valid_cut(app, selection):
    assert app.test_client().post("/api/workspace", json={"selection": selection}).status_code == 400


def test_surroundings_previews_are_not_announced(app, monkeypatch):
    heights = np.arange(20, dtype=np.float32).reshape(4, 5)
    terrain = Terrain(Bounds(37.695, -119.665, 37.785, -119.525), heights, 11, 4, "2026-09-30T00:00:00Z")
    monkeypatch.setattr(app.extensions["terrain"]["client"], "fetch", lambda bounds, resolution, progress: terrain)
    events = []
    monkeypatch.setattr(app.extensions["terrain"]["live"], "publish", events.append)
    client = app.test_client()
    client.post("/api/terrain", json={"bounds": terrain.metadata()["bounds"], "resolution": 96, "preview": True})
    for _ in range(200):
        if any(event.get("state") == "ready" for event in events):
            break
        time.sleep(.01)
    assert [event["type"] for event in events] == ["job"]


class FakeElevation:
    """Elevation tiles where height = 1000·row + column (pixel centers), and zoom 15 tile (1, 1) is open sea."""
    def __init__(self):
        self.calls = []

    def tile(self, zoom, x, y):
        self.calls.append((zoom, x, y))
        if (zoom, x, y) == (15, 1, 1):
            raise ValueError("Elevation tile contains missing data; select a different area.")
        rows, columns = np.mgrid[0:256, 0:256]
        return (1000 * rows + columns).astype(np.float32)


def test_relief_grid_samples_the_coarser_elevation_tile():
    from terrain_app.relief import ReliefTiles
    tiles = ReliefTiles(FakeElevation())
    grid, found = tiles.grid(10, 9, 17, size=17)   # zoom 7 elevation tile (1, 2); this map tile is its (1, 1) eighth
    assert found and grid.shape == (17, 17) and grid.dtype == np.float32
    # Corners at the map tile's edges: x from 32 to 64 elevation pixels, y the same (pixel centers are at i + 0.5).
    assert grid[0, 0] == pytest.approx(1000 * 31.5 + 31.5)
    assert grid[-1, -1] == pytest.approx(1000 * 63.5 + 63.5)
    assert grid[8, 0] == pytest.approx(1000 * 47.5 + 31.5)
    # Siblings in the same elevation tile share their edge.
    right, _ = tiles.grid(10, 10, 17, size=17)
    np.testing.assert_allclose(grid[:, -1], right[:, 0])
    assert tiles.client.calls == [(7, 1, 2)]   # one download served both


def test_relief_handles_sea_bounds_and_wrapping():
    from terrain_app.relief import ReliefTiles
    tiles = ReliefTiles(FakeElevation())
    grid, found = tiles.grid(18, 8, 8)   # inside zoom 15 tile (1, 1): open sea
    assert not found and not grid.any()
    with pytest.raises(ValueError):
        tiles.grid(3, 0, 8)
    with pytest.raises(ValueError):
        tiles.grid(3, 0, 0, size=20)
    np.testing.assert_array_equal(tiles.grid(3, 9, 2)[0], tiles.grid(3, 1, 2)[0])   # x wraps around the world


def test_relief_endpoint(app, monkeypatch):
    fake = FakeElevation()
    monkeypatch.setattr(app.extensions["terrain"]["client"], "tile", fake.tile)
    client = app.test_client()
    response = client.get("/api/relief/10/9/17?size=9", headers={"Accept-Encoding": "gzip"})
    assert response.status_code == 200 and response.headers["X-Relief-Size"] == "9"
    grid = np.frombuffer(gzip.decompress(response.get_data()), "<f4").reshape(9, 9)
    assert grid[0, 0] == pytest.approx(1000 * 31.5 + 31.5)
    assert "max-age" in response.headers["Cache-Control"]
    assert client.get("/api/relief/18/8/8").headers["X-Relief-Missing"] == "1"
    assert client.get("/api/relief/3/0/9").status_code == 400
    assert client.get("/api/config").headers["Cache-Control"] == "no-store"


class FakeTranscriber:
    def __init__(self, text="Roan Mountain, Tennessee.", works=True):
        self.text, self.works, self.heard = text, works, None

    def available(self):
        return self.works

    def transcribe(self, samples, purpose="search", vocabulary=()):
        self.heard, self.purpose, self.vocabulary = samples, purpose, list(vocabulary)
        from terrain_app.speech import tidy
        return tidy(self.text)


def speech(seconds=1.0, rate=16000):
    import base64
    tone = (np.sin(np.arange(int(16000 * seconds)) / 16000 * 2 * np.pi * 440) * 12000).astype("<i2")
    return {"rate": rate, "samples": base64.b64encode(tone.tobytes()).decode()}


def test_voice_search_transcribes_on_this_computer(tmp_path):
    fake = FakeTranscriber()
    app = create_app({"TESTING": True, "CACHE_DIR": tmp_path / "tiles", "TRANSCRIBER": fake})
    try:
        response = app.test_client().post("/api/transcribe", json=speech())
        assert response.status_code == 200 and response.get_json() == {"text": "Roan Mountain, Tennessee"}
        assert fake.heard.dtype == np.float32 and len(fake.heard) == 16000 and abs(fake.heard).max() <= 1
    finally:
        app.extensions["terrain"]["executor"].shutdown(wait=True)


@pytest.mark.parametrize("payload,error", [
    (speech(rate=44100), "16000 samples per second"),
    ({"rate": 16000, "samples": "not base64!"}, "base64"),
    ({"rate": 16000, "samples": "AA=="}, "damaged"),   # one byte: half a sample
    (speech(seconds=21), "20 seconds"),
])
def test_voice_search_rejects_bad_recordings(tmp_path, payload, error):
    app = create_app({"TESTING": True, "CACHE_DIR": tmp_path / "tiles", "TRANSCRIBER": FakeTranscriber()})
    try:
        response = app.test_client().post("/api/transcribe", json=payload)
        assert response.status_code in (400, 413)
        if response.status_code == 400:
            assert error in response.get_json()["error"]
    finally:
        app.extensions["terrain"]["executor"].shutdown(wait=True)


def test_voice_search_without_the_engine(tmp_path):
    app = create_app({"TESTING": True, "CACHE_DIR": tmp_path / "tiles", "TRANSCRIBER": FakeTranscriber(works=False)})
    try:
        response = app.test_client().post("/api/transcribe", json=speech())
        assert response.status_code == 503 and "faster-whisper" in response.get_json()["error"]
    finally:
        app.extensions["terrain"]["executor"].shutdown(wait=True)


def test_spoken_zip_codes_are_joined():
    from terrain_app.speech import tidy
    assert tidy("2-8-6-0-4.") == "28604"
    assert tidy("2 8 6 0 4 1 2 3 4") == "28604-1234"
    assert tidy("Mount Rainier, Washington.") == "Mount Rainier, Washington"
    assert tidy("Route 66.") == "Route 66"


def test_voice_commands_are_transcribed_expecting_commands(tmp_path):
    fake = FakeTranscriber("Open menu.")
    app = create_app({"TESTING": True, "CACHE_DIR": tmp_path / "tiles", "TRANSCRIBER": fake})
    try:
        client = app.test_client()
        assert client.post("/api/transcribe", json={**speech(), "purpose": "command"}).get_json() == {"text": "Open menu"}
        assert fake.purpose == "command"
        client.post("/api/transcribe", json={**speech(), "purpose": "command", "vocabulary": ["Multiplier", "16:9", "<script>", 7, "x" * 99]})
        assert fake.vocabulary == ["Multiplier", "16:9", "script", "x" * 40], "The menu's names reach Whisper, cleaned"
        assert client.post("/api/transcribe", json={**speech(), "purpose": "command", "vocabulary": "Multiplier"}).status_code == 400
        client.post("/api/transcribe", json=speech())
        assert fake.purpose == "search"
        assert client.post("/api/transcribe", json={**speech(), "purpose": "dictation"}).status_code == 400
    finally:
        app.extensions["terrain"]["executor"].shutdown(wait=True)
