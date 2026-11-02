import json
import time

import numpy as np
import pytest

from terrain_app import lamp_handoff
from terrain_app.elevation import Bounds, Terrain
from terrain_app.server import create_app

LAYERED = {"fit": "lamp", "width_mm": 170, "base_mm": 14, "layer_spacing": 6,
           "layers": [{"position": 25, "base_mm": 14}, {"position": 50, "base_mm": 20}, {"position": 75, "base_mm": 26}]}


@pytest.fixture
def client(tmp_path, monkeypatch):
    rows, columns = np.mgrid[0:24, 0:33]
    heights = (np.sin(columns/5)*40+np.cos(rows/4)*30+400).astype(np.float32)
    terrain = Terrain(Bounds(36.08, -82.165, 36.145, -82.055), heights, 11, 2, "2026-10-01T00:00:00Z")
    monkeypatch.setenv("TERRAIN_LAMP_HANDOFF", str(tmp_path / "handoff"))
    monkeypatch.setenv("CYLINDERLAMP_DIR", str(tmp_path / "no-lamp-here"))
    monkeypatch.setenv("CYLINDERLAMP_URL", "http://127.0.0.1:9")     # nothing listens: not running, can't start
    app = create_app({"TESTING": True, "CACHE_DIR": tmp_path / "tiles"})
    extension = app.extensions["terrain"]
    extension["jobs"]["t"] = {"state": "ready", "terrain": terrain, "accessed": time.monotonic()}
    yield app.test_client()
    extension["executor"].shutdown(wait=True)


def test_layers_go_to_cylinderlamp_nearest_first(client, tmp_path):
    response = client.post("/api/silhouette/t/cylinder-lamp", json={**LAYERED, "name": "Roan Mountain"})
    assert response.status_code == 200
    result = response.get_json()
    assert result["layers"] == 3 and result["running"] is False
    assert result["url"] == f"http://127.0.0.1:9/?silhouette={result['id']}"
    data = json.loads((tmp_path / "handoff" / f"{result['id']}.json").read_text())
    assert data["format"] == lamp_handoff.FORMAT and data["name"] == "Roan Mountain"
    assert [layer["base_mm"] for layer in data["layers"]] == [14, 20, 26]       # nearest first, rear ones raised
    for layer in data["layers"]:
        curve = np.array(layer["curve"])
        assert curve.shape[1] == 2 and curve[:, 0].min() >= -1e-6 and curve[:, 0].max() <= data["width_mm"]+1e-6
        assert curve[:, 1].min() >= layer["base_mm"]-1e-6                      # the ridge stands on its base
    download = client.post("/api/silhouette/t/cylinder-lamp?download=1", json=LAYERED)
    assert download.status_code == 200 and json.loads(download.data)["format"] == lamp_handoff.FORMAT
    assert client.post("/api/silhouette/missing/cylinder-lamp", json=LAYERED).status_code == 404


def test_old_handoffs_are_pruned(tmp_path, monkeypatch):
    monkeypatch.setattr(lamp_handoff, "KEEP", 3)
    for _ in range(5):
        lamp_handoff.save_handoff({"format": lamp_handoff.FORMAT}, tmp_path)
    assert len(list(tmp_path.glob("*.json"))) == 3


def test_only_this_computer_hands_off_to_cylinderlamp(client, tmp_path, monkeypatch):
    """SECURITY_REVIEW.md TS-04: another computer gets the download, but can't write handoffs or start CylinderLamp."""
    started = []
    monkeypatch.setattr(lamp_handoff, "start_lamp", lambda *a, **k: started.append(True) or False)
    lan = {"REMOTE_ADDR": "192.168.0.50"}
    assert client.post("/api/silhouette/t/cylinder-lamp", json=LAYERED, environ_base=lan).status_code == 403
    assert not (tmp_path / "handoff").exists() or not any((tmp_path / "handoff").iterdir())
    assert started == []
    download = client.post("/api/silhouette/t/cylinder-lamp?download=1", json=LAYERED, environ_base=lan)
    assert download.status_code == 200 and json.loads(download.data)["format"] == lamp_handoff.FORMAT


def test_cylinderlamp_is_started_once_at_a_time(tmp_path, monkeypatch):
    """Two handoffs at once start one CylinderLamp: the second waits, then finds it running."""
    import threading
    folder = tmp_path / "lamp"
    folder.mkdir()
    (folder / "app.py").write_text("")
    launched, up = [], threading.Event()
    monkeypatch.setattr(lamp_handoff, "lamp_running", up.is_set)
    def popen(*args, **kwargs):
        launched.append(args)
        threading.Timer(.3, up.set).start()
    monkeypatch.setattr(lamp_handoff.subprocess, "Popen", popen)
    results = []
    threads = [threading.Thread(target=lambda: results.append(lamp_handoff.start_lamp(folder, wait=5))) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert results == [True, True] and len(launched) == 1
