import argparse
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
    print(f"\nTerrain Studio → {url}\nPress Ctrl+C to stop.\n", flush=True)
    if args.open:
        webbrowser.open(url)
    app.run(host=args.host, port=args.port, threaded=True, debug=False)


if __name__ == "__main__":
    main()
