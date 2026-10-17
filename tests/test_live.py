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
    assert events == [{"type": "workspace", "page": "headset", "name": "Roan Mountain", "terrain_id": "abc"}]
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
