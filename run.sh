#!/usr/bin/env bash
# Terrain Studio launcher for macOS/Linux: sets up on first run, then starts the app.
set -euo pipefail
cd -- "$(dirname -- "$0")"

if [[ ! -x .venv/bin/python ]]; then
    echo "Setting up Terrain Studio for the first time. This takes a few minutes..."
    python3 -m venv .venv
fi
# Install again whenever requirements.txt differs from what was last installed.
if ! cmp -s requirements.txt .venv/requirements.installed; then
    echo "Installing required packages..."
    .venv/bin/python -m pip --version &>/dev/null || .venv/bin/python -m ensurepip --upgrade
    .venv/bin/python -m pip install --disable-pip-version-check -r requirements.txt
    cp requirements.txt .venv/requirements.installed
fi
exec .venv/bin/python app.py "$@"
