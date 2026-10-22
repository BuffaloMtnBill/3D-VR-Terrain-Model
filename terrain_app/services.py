"""Small, bounded JSON requests and local caches for map data services."""
import hashlib
import json
import math
from pathlib import Path
import os
import re
import sys
from threading import BoundedSemaphore, Event, Lock
import time
import uuid

import requests

USER_AGENT = "Terrain-Studio/1.0 (local 3D-Map-Extractor)"


def default_cache_dir() -> Path:
    """The per-user cache folder for this operating system, independent of where the app is launched."""
    if sys.platform == "win32":
        return Path(os.environ.get("LOCALAPPDATA") or Path.home() / "AppData" / "Local") / "TerrainStudio" / "Cache"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Caches" / "TerrainStudio"
    return Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache") / "terrain-studio"


def response_json(response, max_bytes, kind=dict):
    response.raise_for_status()
    chunks, length = [], 0
    for chunk in response.iter_content(65_536):
        length += len(chunk)
        if length > max_bytes:
            raise ValueError("The map service returned too much data. Select a smaller area.")
        chunks.append(chunk)
    try:
        value = json.loads(b"".join(chunks))
    except (ValueError, UnicodeDecodeError):
        raise ValueError("The map service returned an invalid response. Try again later.") from None
    if not isinstance(value, kind):
        raise ValueError("The map service returned an invalid response. Try again later.")
    return value


# Overpass (OpenStreetMap's public query service) runs only two queries at a time for each computer and refuses more
# (HTTP 429). Every Overpass query here (map features, buildings, print colors) waits for one of those two slots.
OVERPASS_SLOTS = 2
OVERPASS_MIRRORS = ("https://maps.mail.ru/osm/tools/overpass/api/interpreter", "https://overpass.private.coffee/api/interpreter")
OVERPASS_BUSY = (429, 502, 503, 504)
OVERPASS_RETRY_S = 3.0
_overpass_slots = BoundedSemaphore(OVERPASS_SLOTS)


def overpass_json(url, query, timeout, max_bytes, mirrors=()):
    """One Overpass query, in turn: a refusal for being busy (429) waits a moment and tries again, and when the
    server stays busy or can't be reached, each mirror is tried. Raises requests.RequestException if none answer."""
    targets, last = [url, url, *[mirror for mirror in mirrors if mirror != url]], None
    for attempt, target in enumerate(targets):
        if attempt == 1:
            if not (isinstance(last, requests.HTTPError) and "429" in str(last)):
                continue   # only a "too many requests" refusal is worth asking the same server again
            time.sleep(OVERPASS_RETRY_S)
        with _overpass_slots:
            try:
                with requests.post(target, data={"data": query}, headers={"User-Agent": USER_AGENT}, timeout=timeout, stream=True) as response:
                    if response.status_code in OVERPASS_BUSY:
                        raise requests.HTTPError(str(response.status_code))
                    return response_json(response, max_bytes)
            except requests.RequestException as error:
                last = error
    raise last or requests.RequestException("No Overpass server answered.")


class SingleFlight:
    """One download per key at a time: a second caller for the same key waits for the first and shares its answer
    (so the head start a download gets when Generate is pressed is never repeated by the page's own request)."""
    def __init__(self):
        self._lock, self._calls = Lock(), {}

    def do(self, key, work):
        with self._lock:
            call = self._calls.get(key)
            leader = call is None
            if leader:
                call = self._calls[key] = {"done": Event()}
        if not leader:
            call["done"].wait()
            if "error" in call:
                raise call["error"]
            return call["result"]
        try:
            call["result"] = work()
            return call["result"]
        except BaseException as error:
            call["error"] = error
            raise
        finally:
            with self._lock:
                del self._calls[key]
            call["done"].set()


def cached_json(path: Path, age: int, max_bytes: int):
    try:
        if time.time()-path.stat().st_mtime > age or path.stat().st_size > max_bytes:
            return None
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def cache_json(path: Path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f".{uuid.uuid4().hex}.tmp")
    try:
        temporary.write_text(json.dumps(value, separators=(",", ":")), encoding="utf-8")
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


class ZipLookupError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class ZipClient:
    def __init__(self, cache_dir: Path, url="https://api.zippopotam.us/us/{zip}"):
        self.cache_dir, self.url = Path(cache_dir), url

    def lookup(self, value):
        if not isinstance(value, str) or not re.fullmatch(r"[0-9]{5}(?:-[0-9]{4})?", value.strip()):
            raise ZipLookupError("Enter a US ZIP code, such as 37687 or 37687-1234.")
        zipcode = value.strip()[:5]
        path = self.cache_dir / f"{zipcode}.json"
        result = cached_json(path, 30*86400, 100_000)
        if isinstance(result, dict) and result.get("zip") == zipcode:
            return result
        try:
            with requests.get(self.url.format(zip=zipcode), headers={"User-Agent": USER_AGENT},
                              timeout=(8, 15), stream=True) as response:
                if response.status_code == 404:
                    raise ZipLookupError("That ZIP code was not found. Check the digits and try again.", 404)
                data = response_json(response, 100_000)
            place = data["places"][0]
            latitude, longitude = float(place["latitude"]), float(place["longitude"])
            if not (math.isfinite(latitude) and math.isfinite(longitude) and abs(latitude) <= 85 and abs(longitude) <= 180):
                raise ValueError("Invalid location")
            result = {"zip": zipcode, "latitude": latitude, "longitude": longitude,
                      "city": str(place["place name"]), "state": str(place.get("state abbreviation", place.get("state", ""))),
                      "source": "Zippopotam.us / GeoNames", "source_url": "https://www.zippopotam.us/"}
        except requests.RequestException:
            raise ZipLookupError("ZIP lookup is unavailable. Check your connection and try again.", 502) from None
        except ZipLookupError:
            raise
        except (ValueError, KeyError, IndexError, TypeError):
            raise ZipLookupError("ZIP lookup returned an incomplete location. Try again later.", 502) from None
        cache_json(path, result)
        return result


GEOCODER_URL = "https://nominatim.openstreetmap.org/search"


class PlaceLookupError(ZipLookupError):
    pass


class PlaceClient:
    """Address and place-name search through Nominatim: one result, cached, at most one request per second."""

    def __init__(self, cache_dir: Path, url=GEOCODER_URL):
        self.cache_dir, self.url = Path(cache_dir), url
        self.lock, self.last_request = Lock(), 0.0

    def lookup(self, value):
        query = " ".join(value.split()) if isinstance(value, str) else ""
        if not 2 <= len(query) <= 200:
            raise PlaceLookupError("Enter an address, city, or place name.")
        path = self.cache_dir / f"{hashlib.sha256(query.casefold().encode()).hexdigest()[:32]}.json"
        result = cached_json(path, 30*86400, 100_000)
        if isinstance(result, dict) and result.get("query", "").casefold() == query.casefold():
            return result
        try:
            with self.lock:  # Nominatim's usage policy allows one request per second.
                time.sleep(max(0, self.last_request + 1.1 - time.monotonic()))
                try:
                    with requests.get(self.url, params={"q": query, "format": "jsonv2", "limit": 1},
                                      headers={"User-Agent": USER_AGENT}, timeout=(8, 15), stream=True) as response:
                        data = response_json(response, 200_000, list)
                finally:
                    self.last_request = time.monotonic()
            if not data:
                raise PlaceLookupError("No place matched that search. Try adding a city, state, or country.", 404)
            place = data[0]
            latitude, longitude = float(place["lat"]), float(place["lon"])
            south, north, west, east = (float(edge) for edge in place["boundingbox"])
            if not (all(map(math.isfinite, (latitude, longitude, south, north, west, east)))
                    and abs(latitude) <= 85 and abs(longitude) <= 180):
                raise PlaceLookupError("That place is outside the map's range (85° south to 85° north).", 404)
            result = {"query": query, "name": str(place["display_name"]), "latitude": latitude, "longitude": longitude,
                      "bounds": {"south": south, "west": west, "north": north, "east": east},
                      "source": "© OpenStreetMap contributors · Nominatim", "source_url": "https://nominatim.org/"}
        except requests.RequestException:
            raise PlaceLookupError("Place search is unavailable. Check your connection and try again.", 502) from None
        except ZipLookupError:
            raise
        except (ValueError, KeyError, IndexError, TypeError):
            raise PlaceLookupError("Place search returned an incomplete location. Try again later.", 502) from None
        cache_json(path, result)
        return result
