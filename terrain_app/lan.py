"""Serving Terrain Studio to other devices on the local network, such as a VR headset.

Browsers allow WebXR only on secure pages, so LAN mode serves HTTPS with a self-signed certificate made for this
computer's addresses. The headset asks once to trust it."""
from datetime import datetime, timedelta, timezone
import ipaddress
from pathlib import Path
import socket


def local_addresses():
    """This computer's LAN IPv4 addresses, the one with the default route first."""
    found = []
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as probe:
            probe.connect(("192.0.2.1", 9))  # no packet is sent; this only picks the outgoing interface
            found.append(probe.getsockname()[0])
    except OSError:
        pass
    try:
        found += socket.gethostbyname_ex(socket.gethostname())[2]
    except OSError:
        pass
    return [address for address in dict.fromkeys(found) if not address.startswith("127.")]


def certificate(folder, hosts):
    """Paths to a certificate and key covering these host names and addresses, made again when the hosts change."""
    try:
        from cryptography import x509
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        from cryptography.x509.oid import NameOID
    except ImportError:
        raise SystemExit("LAN mode needs the 'cryptography' package: python -m pip install cryptography") from None
    folder = Path(folder)
    cert_path, key_path, hosts_path = folder / "terrain-studio.crt", folder / "terrain-studio.key", folder / "hosts.txt"
    wanted = "\n".join(sorted(set(hosts)))
    if cert_path.exists() and key_path.exists() and hosts_path.exists() and hosts_path.read_text() == wanted:
        cert = x509.load_pem_x509_certificate(cert_path.read_bytes())
        if cert.not_valid_after_utc > datetime.now(timezone.utc) + timedelta(days=7):
            return cert_path, key_path
    names = []
    for host in sorted(set(hosts)):
        try:
            names.append(x509.IPAddress(ipaddress.ip_address(host)))
        except ValueError:
            names.append(x509.DNSName(host))
    key = ec.generate_private_key(ec.SECP256R1())
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Terrain Studio (local network)")])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(days=1))
            .not_valid_after(now + timedelta(days=825)).add_extension(x509.SubjectAlternativeName(names), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .sign(key, hashes.SHA256()))
    folder.mkdir(parents=True, exist_ok=True)
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    key_path.chmod(0o600)
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    hosts_path.write_text(wanted)
    return cert_path, key_path
