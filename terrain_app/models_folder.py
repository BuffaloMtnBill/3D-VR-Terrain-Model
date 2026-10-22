"""Saving finished models into the shared Models folder (~/Projects/Models).

The Control Panel's workflow passes models between programs through that folder:
creation programs save there, and the Visualizer and the VR programs open from
it. Set PROJECTS_MODELS to use another folder.
"""
import os
import re
from pathlib import Path


def models_root():
    return Path(os.environ.get('PROJECTS_MODELS') or Path.home()/'Projects'/'Models').expanduser()


def clean_name(name, fallback):
    """A file name stem from what the user typed: letters, digits, spaces, dots, dashes and underscores."""
    stem = re.sub(r'[^\w .-]+', '', str(name or '')).strip(' .')[:80]
    return stem or fallback


def save_bytes(data, category, name, suffix, fallback='model', root=None):
    """Write `data` to <root>/<category>/<name><suffix>, never over an existing file.

    A name already in use gets -2, -3, ... Returns the new file's path.
    """
    folder = Path(root or models_root())/category
    folder.mkdir(parents=True, exist_ok=True)
    stem = clean_name(name, fallback)
    for n in range(1, 10000):
        path = folder/(f'{stem}{suffix}' if n == 1 else f'{stem}-{n}{suffix}')
        try:
            with open(path, 'xb') as f:
                f.write(data)
            return path
        except FileExistsError:
            continue
    raise FileExistsError(f'Too many models called {stem} in {folder}')


def save_copy(source, category, name, root=None):
    source = Path(source)
    return save_bytes(source.read_bytes(), category, name, source.suffix, source.stem, root)


def save_set(files, category, name, fallback='model', root=None):
    """Copy several files into a new folder <root>/<category>/<name>/ (or <name>-2, ...).

    `files` maps each file name to write to its source path; missing sources are skipped.
    Returns the new folder's path.
    """
    parent = Path(root or models_root())/category
    parent.mkdir(parents=True, exist_ok=True)
    stem = clean_name(name, fallback)
    for n in range(1, 10000):
        folder = parent/(stem if n == 1 else f'{stem}-{n}')
        try:
            folder.mkdir()
            break
        except FileExistsError:
            continue
    else:
        raise FileExistsError(f'Too many models called {stem} in {parent}')
    for target, source in files.items():
        if source and Path(source).is_file():
            (folder/clean_name(target, 'part')).write_bytes(Path(source).read_bytes())
    return folder
