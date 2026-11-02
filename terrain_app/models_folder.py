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
together. describe() notes what a saved model is (category, tags, a description,
details such as its size or location and the program that made it), so Collection
Manager can show and filter models as soon as they are saved.
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


MODEL_SUFFIXES = ('.stl', '.3mf', '.obj', '.glb')


def count_models(category, root=None, suffixes=MODEL_SUFFIXES):
    """How many model files <root>/<category> holds, counting subfolders and skipping hidden files and folders."""
    folder = Path(root or models_root())/category
    total = 0
    for _, folders, files in os.walk(folder):
        folders[:] = [name for name in folders if not name.startswith('.')]
        total += sum(not name.startswith('.') and Path(name).suffix.lower() in suffixes for name in files)
    return total


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


# Colours for the categories describe() adds, matching Collection Manager's palette; others take the grey.
CATEGORY_COLORS = {'Terrain': '#7cc46a', 'Silhouettes': '#5a8de0', 'Animals': '#e0794a', 'Lamps': '#d9b44a',
                   'Lamp lids': '#d66bb0', 'Trees': '#4ab8c4', 'Clouds': '#9aa0a6', 'Houses': '#9a72e0',
                   'AI models': '#d66bb0', 'Boxes': '#b98b5e', 'Insets': '#e0708f'}
MAX_DETAILS = 40


def _tag(tag):
    return ' '.join(str(tag).split()).strip().lower()[:40]


def describe(files, program, category='', tags=(), notes='', details=None, root=None):
    """Note in the collection index what each saved file is, for Collection Manager to show and filter by.

    `files` is a saved path or a list of them; a folder stands for the model files in it (as save_set makes).
    The file goes in `category` (added to the index's categories if it is new), gains `tags`, gets `notes` (a
    description) and `details` ({label: value}, such as {'Size': '180 mm'}) and is marked as made by `program`.
    What someone already set by hand wins: a category or notes the file has are kept and tags are only added.
    Files outside the Models folder are skipped. Returns False instead of raising, like record_derivation."""
    root = Path(root or models_root()).resolve()
    paths = []
    for path in [files] if isinstance(files, (str, os.PathLike)) else files:
        path = Path(path).resolve()
        paths += sorted(p for p in path.rglob('*') if p.is_file() and p.suffix.lower() in MODEL_SUFFIXES) \
            if path.is_dir() else [path] if path.is_file() else []
    rels = [p.relative_to(root).as_posix() for p in paths if root in p.parents]
    if not rels:
        return True
    category = ' '.join(str(category or '').split())[:60]
    tags = {_tag(t) for t in tags} - {''}
    details = {' '.join(str(k).split())[:40]: ' '.join(str(v).split())[:200]
               for k, v in list((details or {}).items())[:MAX_DETAILS] if str(v).strip()}
    try:
        with collection_index(root) as index:
            if category and category not in {c.get('name') for c in index['categories']}:
                index['categories'].append({'name': category, 'color': CATEGORY_COLORS.get(category, '#9aa0a6')})
            for rel in rels:
                record = index['assets'].setdefault(rel, {})
                if category and not record.get('category'):
                    record['category'] = category
                if tags:
                    record['tags'] = sorted(set(record.get('tags', [])) | tags)
                if notes and not record.get('notes'):
                    record['notes'] = str(notes)[:4000]
                if details:
                    record['details'] = details
                record['made_by'] = str(program)[:80]
        return True
    except (OSError, ValueError):
        return False
