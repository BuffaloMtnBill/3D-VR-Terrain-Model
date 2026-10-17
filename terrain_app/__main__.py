import argparse
import os
from pathlib import Path
import socket
import webbrowser

from .server import create_app


def main():
    parser = argparse.ArgumentParser(description="Run Terrain Studio locally.")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--open", action="store_true", help="Open the app in your browser")
    parser.add_argument("--lan", action="store_true",
                        help="Serve HTTPS to other devices on this network, such as a VR headset (self-signed certificate)")
    parser.add_argument("--forget-devices", action="store_true", help="With --lan: unpair every device, so each must enter the PIN again")
    args = parser.parse_args()
    app = create_app()
    ssl_context, urls = None, [f"http://{args.host}:{args.port}"]
    if args.lan:
        from .lan import certificate, local_addresses
        from .pairing import Pairing
        addresses, hostname = local_addresses(), socket.gethostname()
        hosts = ["localhost", "127.0.0.1", hostname, *addresses]
        app.config["TRUSTED_HOSTS"] = [*app.config["TRUSTED_HOSTS"], hostname, *addresses]
        ssl_context = tuple(str(path) for path in certificate(Path(app.config["CACHE_DIR"]).parent / "tls", hosts))
        args.host = "0.0.0.0" if args.host == "127.0.0.1" else args.host
        pairing = app.config["PAIRING"] = Pairing(Path(app.config["CACHE_DIR"]).parent / "tls", os.environ.get("TERRAIN_PAIRING_PIN"))
        if args.forget_devices:
            pairing.forget_all()
        urls = [f"https://{address}:{args.port}" for address in addresses] or [f"https://{hostname}:{args.port}"]
    lan_note = ("Open the address above in the headset's browser and accept the certificate warning once.\n"
                f"New devices pair once with this PIN: {app.config['PAIRING'].pin}\n") if args.lan else ""
    # Plain ASCII: Windows consoles using a legacy code page cannot print arrows.
    print(f"\n3D-VR-Terrain is running at {' or '.join(urls)}\n{lan_note}"
          f"Downloaded map data is cached in {Path(app.config['CACHE_DIR']).parent}\n"
          "Press Ctrl+C to stop.\n", flush=True)
    if args.open:
        webbrowser.open(urls[0].replace("0.0.0.0", "127.0.0.1"))
    app.run(host=args.host, port=args.port, threaded=True, debug=False, ssl_context=ssl_context)


if __name__ == "__main__":
    main()
