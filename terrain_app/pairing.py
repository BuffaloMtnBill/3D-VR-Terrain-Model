"""LAN pairing: another device (such as a VR headset) enters a PIN shown on this computer once, then keeps a cookie.

Requests from this computer itself (loopback) never need pairing. Only hashes of the paired devices' tokens are kept,
so the file reveals nothing that would let another device in.
"""
import hashlib
import hmac
import json
import os
from pathlib import Path
import secrets
from threading import Lock
import time

COOKIE = "terrain_paired"
MAX_FAILURES = 5          # wrong PINs allowed per window before pairing pauses
FAILURE_WINDOW = 300      # seconds
LOCKOUT = 60              # seconds pairing pauses after too many wrong PINs
MAX_DEVICES = 20


def _digest(token):
    return hashlib.sha256(token.encode()).hexdigest()


class Pairing:
    def __init__(self, folder, pin=None):
        self.path = Path(folder) / "paired.json"
        self.pin = pin or f"{secrets.randbelow(10**6):06d}"
        self._lock = Lock()
        self._failures = []
        self._locked_until = 0.0
        try:
            self._tokens = [value for value in json.loads(self.path.read_text())["tokens"] if isinstance(value, str)][-MAX_DEVICES:]
        except (OSError, ValueError, KeyError, TypeError):
            self._tokens = []

    def is_paired(self, token):
        if not token:
            return False
        digest = _digest(token)
        with self._lock:
            return any(hmac.compare_digest(digest, known) for known in self._tokens)

    def pair(self, pin):
        """A new device token for the right PIN; None for a wrong one. Raises PermissionError while paused."""
        now = time.monotonic()
        with self._lock:
            if now < self._locked_until:
                raise PermissionError(f"Too many wrong PINs. Try again in {int(self._locked_until-now)+1} seconds.")
            if not hmac.compare_digest(str(pin).strip().encode(), self.pin.encode()):
                self._failures = [moment for moment in self._failures if now-moment < FAILURE_WINDOW] + [now]
                if len(self._failures) >= MAX_FAILURES:
                    self._failures, self._locked_until = [], now+LOCKOUT
                return None
            self._failures = []
            token = secrets.token_urlsafe(32)
            self._tokens = [*self._tokens, _digest(token)][-MAX_DEVICES:]
            self._save()
            return token

    def forget_all(self):
        with self._lock:
            self._tokens = []
            self._save()

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.path.with_suffix(".tmp")
        temporary.write_text(json.dumps({"tokens": self._tokens}))
        os.chmod(temporary, 0o600)
        temporary.replace(self.path)


def is_local(address):
    return address in ("127.0.0.1", "::1") or (address or "").startswith("::ffff:127.")
