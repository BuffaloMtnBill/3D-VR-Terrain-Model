"""Saving finished models into the shared Models folder (~/Projects/Models).

The Control Panel's workflow passes models between programs through that folder:
creation programs save there, and the Visualizer and the VR programs open from
it. Set PROJECTS_MODELS to use another folder.

Template models the programs build from (marker balls, lamp lids and bases)
live in its Templates folder; set PROJECTS_TEMPLATES to use another one. That
folder is for templates only: programs never save output there.

record_derivation() notes which templates (ids in Templates/templates.json) a
saved model was made from, in the folder's collection index (.collection.json,
shared with Collection Manager), so a template's derivatives can be listed
together.
"""
from contextlib import contextmanager
import json
import os
import re
from pathlib import Path

try:
    import fcntl
except ImportError:     # Windows: saves there are not locked against Collection Manager
    fcntl = None

COLLECTION = '.collection.json'


def models_root():
    return Path(os.environ.get('PROJECTS_MODELS') or Path.home()/'Projects'/'Models').expanduser()


def templates_root():
    return Path(os.environ.get('PROJECTS_TEMPLATES') or models_root()/'Templates').expanduser()


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


@contextmanager
def collection_index(root=None):
    """The collection index as a dict, written back on leaving; locked so programs and Collection Manager don't clash."""
    root = Path(root or models_root())
    path = root/COLLECTION
    with open(root/'.collection.lock', 'a') as lock:
        if fcntl:
            fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            try:
                index = json.loads(path.read_text(encoding='utf-8'))
            except (OSError, ValueError):
                index = {}
            for key, empty in (('version', 1), ('categories', []), ('assets', {})):
                index.setdefault(key, empty)
            yield index
            tmp = root/(COLLECTION + '.tmp')
            tmp.write_text(json.dumps(index, indent=1, sort_keys=True), encoding='utf-8')
            os.replace(tmp, path)
        finally:
            if fcntl:
                fcntl.flock(lock, fcntl.LOCK_UN)


def record_derivation(files, program, root=None):
    """Note which templates each saved file was made from: `files` maps a saved path to a list of template ids.

    Files outside the Models folder, missing files and empty lists are skipped. Returns False instead of
    raising, so a model that saved is never reported as failed because its note could not be written."""
    root = Path(root or models_root()).resolve()
    notes = {}
    for path, templates in files.items():
        path = Path(path).resolve()
        if templates and path.is_file() and root in path.parents:
            notes[path.relative_to(root).as_posix()] = templates
    if not notes:
        return True
    try:
        with collection_index(root) as index:
            for rel, templates in notes.items():
                record = index['assets'].setdefault(rel, {})
                record['derived_from'] = sorted(set(record.get('derived_from', [])) | set(templates))
                record['made_by'] = program
        return True
    except (OSError, ValueError):
        return False
