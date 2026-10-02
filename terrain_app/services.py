"""Small, bounded JSON requests and local caches for map data services."""
import json
import math
from pathlib import Path
import re
import time
import uuid

import requests

USER_AGENT = "Terrain-Studio/1.0 (local 3D-Map-Extractor)"


def response_json(response, max_bytes):
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
    if not isinstance(value, dict):
        raise ValueError("The map service returned an invalid response. Try again later.")
    return value


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
