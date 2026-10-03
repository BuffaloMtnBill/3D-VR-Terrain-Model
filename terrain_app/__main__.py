import argparse
from pathlib import Path
import webbrowser

from .server import create_app


def main():
    parser = argparse.ArgumentParser(description="Run Terrain Studio locally.")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--open", action="store_true", help="Open the app in your browser")
    args = parser.parse_args()
    app = create_app()
    url = f"http://{args.host}:{args.port}"
    # Plain ASCII: Windows consoles using a legacy code page cannot print arrows.
    print(f"\nTerrain Studio is running at {url}\nDownloaded map data is cached in {Path(app.config['CACHE_DIR']).parent}\n"
          "Press Ctrl+C to stop.\n", flush=True)
    if args.open:
        webbrowser.open(url)
    app.run(host=args.host, port=args.port, threaded=True, debug=False)


if __name__ == "__main__":
    main()
