"""Run 3D-VR-Terrain with: python app.py

Any Python will do: when the project's .venv exists, this switches to it, so the packages it needs (such as
flask-sock) are found even if `python` is another installation, like Anaconda's.
"""
import os
from pathlib import Path
import subprocess
import sys

HERE = Path(__file__).resolve().parent
VENV = HERE / ".venv"
VENV_PYTHON = VENV / ("Scripts/python.exe" if os.name == "nt" else "bin/python")


def use_project_environment():
    if not VENV_PYTHON.exists() or Path(sys.prefix).resolve() == VENV.resolve():
        return
    command = [str(VENV_PYTHON), str(Path(__file__).resolve()), *sys.argv[1:]]
    if os.name == "nt":
        sys.exit(subprocess.call(command))
    os.execv(command[0], command)


if __name__ == "__main__":
    use_project_environment()
    try:
        from terrain_app.__main__ import main
    except ModuleNotFoundError as error:
        sys.exit(f"Python package '{error.name}' is missing. Set up the project's environment once, in this folder:\n"
                 "  python3 -m venv .venv\n  .venv/bin/python -m pip install -r requirements.txt\n"
                 "then run python app.py again.")
    main()
