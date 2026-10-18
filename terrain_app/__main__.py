import argparse
import ipaddress
import os
from pathlib import Path
import socket
from threading import Thread
import time
import webbrowser

from .server import create_app


def main():
    parser = argparse.ArgumentParser(description="Run 3D-VR-Terrain. By default it serves HTTPS to this network, so a VR headset can connect.")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--host", default=None, help="Address to listen on (default: every interface; --local requires a loopback IP or localhost)")
    parser.add_argument("--no-browser", action="store_true", help="Do not open the app in this computer's browser")
    parser.add_argument("--open", action="store_true", help=argparse.SUPPRESS)  # the default now; kept so older commands still work
    parser.add_argument("--local", action="store_true", help="Serve plain HTTP to this computer only (no headset, no pairing)")
    parser.add_argument("--lan", action="store_true", help=argparse.SUPPRESS)  # the default now; kept so older commands still work
    parser.add_argument("--forget-devices", action="store_true", help="Unpair every device, so each must enter the PIN again")
    args = parser.parse_args()
    lan = not args.local
    args.host = args.host or ("0.0.0.0" if lan else "127.0.0.1")
    if args.local:
        # Local mode has no pairing or TLS, so never let a host override expose it to the network.
        # Pin localhost to a numeric address rather than trusting hostname resolution at bind time.
        if args.host.lower() == "localhost":
            args.host = "127.0.0.1"
        try:
            loopback = ipaddress.ip_address(args.host).is_loopback
        except ValueError:
            loopback = False
        if not loopback:
            parser.error("--local requires a loopback IP address or localhost. Omit --local to serve the headset over HTTPS with PIN pairing.")
    app = create_app()
    url_host = f"[{args.host}]" if ":" in args.host else args.host
    ssl_context, urls = None, [f"http://{url_host}:{args.port}"]
    if lan:
        from .lan import certificate, local_addresses
        from .pairing import Pairing
        addresses, hostname = local_addresses(), socket.gethostname()
        hosts = ["localhost", "127.0.0.1", hostname, *addresses]
        app.config["TRUSTED_HOSTS"] = [*app.config["TRUSTED_HOSTS"], hostname, *addresses]
        ssl_context = tuple(str(path) for path in certificate(Path(app.config["CACHE_DIR"]).parent / "tls", hosts))
        pairing = app.config["PAIRING"] = Pairing(Path(app.config["CACHE_DIR"]).parent / "tls", os.environ.get("TERRAIN_PAIRING_PIN"))
        if args.forget_devices:
            pairing.forget_all()
        urls = [f"https://{address}:{args.port}" for address in addresses] or [f"https://{hostname}:{args.port}"]
    lan_note = ("Open the address above in the headset's browser and accept the certificate warning once.\n"
                f"New devices pair once with this PIN: {app.config['PAIRING'].pin}\n"
                f"On this computer, open https://localhost:{args.port} (no PIN needed)\n") if lan else ""
    # Plain ASCII: Windows consoles using a legacy code page cannot print arrows.
    print(f"\n3D-VR-Terrain is running at {' or '.join(urls)}\n{lan_note}"
          f"Downloaded map data is cached in {Path(app.config['CACHE_DIR']).parent}\n"
          "Press Ctrl+C to stop.\n", flush=True)
    if not args.no_browser:
        # This computer never needs pairing, so it opens on localhost, once the server answers.
        Thread(target=open_when_ready, args=(f"https://localhost:{args.port}" if lan else urls[0], args.port), daemon=True).start()
    app.run(host=args.host, port=args.port, threaded=True, debug=False, ssl_context=ssl_context)


def open_when_ready(url, port, timeout=30):
    end = time.monotonic()+timeout
    while time.monotonic() < end:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1):
                break
        except OSError:
            time.sleep(.2)
    webbrowser.open(url)


if __name__ == "__main__":
    main()
