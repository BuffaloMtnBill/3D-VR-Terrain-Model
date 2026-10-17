"""The VR page cannot write files to this computer, and the LAN mode's certificate."""
import pytest
from cryptography import x509

from terrain_app.lan import certificate
from terrain_app.server import create_app


@pytest.fixture
def app(tmp_path):
    app = create_app({"TESTING": True, "CACHE_DIR": tmp_path / "tiles"})
    yield app
    app.extensions["terrain"]["executor"].shutdown(wait=True)


def test_there_is_no_way_to_save_a_model_on_the_server(app):
    client = app.test_client()
    raw = {"Content-Type": "application/octet-stream"}
    assert client.post("/api/saved?filename=terrain.stl", data=b"solid terrain", headers=raw).status_code == 415
    assert client.post("/api/saved?filename=terrain.stl", json={"model": "solid terrain"}).status_code == 404
    assert "save_dir" not in client.get("/api/config").json
    # Raw uploads are refused everywhere; endpoints take JSON only.
    assert client.post("/api/terrain", data=b"x", headers=raw).status_code == 415


def test_certificate_covers_the_lan_addresses_and_is_reused(tmp_path):
    hosts = ["localhost", "127.0.0.1", "studio-pc", "192.168.0.177"]
    cert_path, key_path = certificate(tmp_path, hosts)
    cert = x509.load_pem_x509_certificate(cert_path.read_bytes())
    names = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
    assert set(map(str, names.get_values_for_type(x509.IPAddress))) == {"127.0.0.1", "192.168.0.177"}
    assert set(names.get_values_for_type(x509.DNSName)) == {"localhost", "studio-pc"}
    assert key_path.stat().st_mode & 0o077 == 0
    first = cert_path.read_bytes()
    certificate(tmp_path, list(reversed(hosts)))
    assert cert_path.read_bytes() == first  # the headset keeps trusting it
    certificate(tmp_path, [*hosts, "192.168.0.50"])
    assert cert_path.read_bytes() != first  # a new address needs a new certificate
