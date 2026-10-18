"""Startup must keep unauthenticated local mode on loopback and protect LAN access."""
import sys
from unittest.mock import Mock

import pytest

from terrain_app import __main__ as cli
from terrain_app.pairing import Pairing
from terrain_app.server import create_app


@pytest.fixture
def app(tmp_path, monkeypatch):
    app = create_app({"TESTING": True, "CACHE_DIR": tmp_path / "tiles"})
    monkeypatch.setattr(cli, "create_app", lambda: app)
    monkeypatch.setattr(app, "run", Mock())  # exercise startup without opening a listener
    yield app
    app.extensions["terrain"]["executor"].shutdown(wait=True)


@pytest.mark.parametrize("host", ["0.0.0.0", "::", "192.168.0.50", "8.8.8.8", "studio-pc", "localhost.example"])
def test_local_rejects_network_hosts_before_creating_app(host, monkeypatch, capsys):
    factory = Mock()
    monkeypatch.setattr(cli, "create_app", factory)
    monkeypatch.setattr(sys, "argv", ["terrain-studio", "--local", "--host", host, "--no-browser"])
    with pytest.raises(SystemExit) as error:
        cli.main()
    assert error.value.code == 2
    assert "Omit --local" in capsys.readouterr().err
    factory.assert_not_called()


@pytest.mark.parametrize("host,expected", [(None, "127.0.0.1"), ("127.0.0.1", "127.0.0.1"),
                                         ("127.0.0.2", "127.0.0.2"), ("localhost", "127.0.0.1"),
                                         ("LOCALHOST", "127.0.0.1"), ("::1", "::1")])
def test_local_accepts_only_loopback_bindings(app, host, expected, monkeypatch, capsys):
    arguments = ["terrain-studio", "--local", "--no-browser"]
    if host is not None:
        arguments += ["--host", host]
    monkeypatch.setattr(sys, "argv", arguments)
    cli.main()
    app.run.assert_called_once_with(host=expected, port=8000, threaded=True, debug=False, ssl_context=None)
    assert app.config["PAIRING"] is None
    url_host = "[::1]" if expected == "::1" else expected
    assert f"http://{url_host}:8000" in capsys.readouterr().out


@pytest.mark.parametrize("host", [None, "0.0.0.0", "192.168.0.177"])
def test_lan_startup_still_requires_https_and_pairing(app, host, monkeypatch):
    monkeypatch.setattr("terrain_app.lan.local_addresses", lambda: ["192.168.0.177"])
    monkeypatch.setenv("TERRAIN_PAIRING_PIN", "123456")
    arguments = ["terrain-studio", "--no-browser"]
    if host is not None:
        arguments += ["--host", host]
    monkeypatch.setattr(sys, "argv", arguments)
    cli.main()
    assert app.run.call_args.kwargs["host"] == (host or "0.0.0.0")
    assert len(app.run.call_args.kwargs["ssl_context"]) == 2
    assert isinstance(app.config["PAIRING"], Pairing)
    client = app.test_client()
    remote = {"REMOTE_ADDR": "192.168.0.50"}
    assert client.get("/api/config", base_url="https://192.168.0.177:8000", environ_base=remote).status_code == 401
    response = client.post("/api/pair", json={"pin": "123456"}, base_url="https://192.168.0.177:8000", environ_base=remote)
    assert response.status_code == 200
    assert "Secure" in response.headers["Set-Cookie"]
    config = client.get("/api/config", base_url="https://192.168.0.177:8000", environ_base=remote)
    assert config.status_code == 200 and config.json["pairing_pin"] is None
