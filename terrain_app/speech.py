"""Voice search: speech to text on this computer with Whisper (faster-whisper), for the VR keyboard's microphone key.

The headset records and sends plain 16 kHz samples (no audio file to decode); they stay in memory and nothing is
saved. The model (TERRAIN_WHISPER_MODEL, default small.en, about 480 MB) is downloaded once, on first use; it hears
place names far better than base.en (about 140 MB) and still answers in well under a second on a desktop CPU.
"""
import base64
import binascii
import os
import re
from threading import Lock

import numpy as np

RATE = 16000
MAX_SECONDS = 20
PROMPTS = {
    "search": "A place name, street address, city, or US ZIP code.",
    # Short clips heard while VR listens for its voice commands: told what to expect, Whisper hears them reliably.
    "command": "Open menu. Close menu. Generate terrain. Exit program.",
}


class Transcriber:
    def __init__(self, model_name=None):
        self.model_name = model_name or os.environ.get("TERRAIN_WHISPER_MODEL", "small.en")
        self._model = None
        self._lock = Lock()

    @staticmethod
    def available():
        try:
            import faster_whisper  # noqa: F401
        except ImportError:
            return False
        return True

    def _load(self):
        with self._lock:
            if self._model is None:
                from faster_whisper import WhisperModel
                self._model = WhisperModel(self.model_name, device="cpu", compute_type="int8")
            return self._model

    def transcribe(self, samples, purpose="search", vocabulary=()):
        model = self._load()
        prompt = PROMPTS[purpose] + "".join(f" {word}." for word in vocabulary)
        segments, _ = model.transcribe(samples, language="en", beam_size=5, vad_filter=True, initial_prompt=prompt)
        return tidy(" ".join(segment.text.strip() for segment in segments))


def tidy(text):
    """Ready for the search box: no closing full stop, and a ZIP code read digit by digit ("2-8-6-0-4") joined up."""
    text = text.strip().rstrip(".").strip()
    if re.fullmatch(r"[\d\s,.-]+", text) and len(digits := re.sub(r"\D", "", text)) in (5, 9):
        return digits if len(digits) == 5 else f"{digits[:5]}-{digits[5:]}"
    return text


def purpose_of(payload):
    purpose = payload.get("purpose", "search") if isinstance(payload, dict) else "search"
    if purpose not in PROMPTS:
        raise ValueError("purpose is search or command.")
    return purpose


def vocabulary_of(payload):
    """The names a command may be (the menu's options on show), to tell Whisper what to expect: plain short text only."""
    words = payload.get("vocabulary", []) if isinstance(payload, dict) else []
    if not isinstance(words, list):
        raise ValueError("vocabulary is a list of names.")
    cleaned = [re.sub(r"[^\w\s:+'-]", "", word).strip()[:40] for word in words[:40] if isinstance(word, str)]
    return [word for word in cleaned if word]


def decode_samples(payload):
    """16-bit little-endian mono samples at 16 kHz, base64-encoded, as float32 in [-1, 1]."""
    if not isinstance(payload, dict):
        raise ValueError("Send the recording as JSON.")
    if payload.get("rate") != RATE:
        raise ValueError(f"Send the recording at {RATE} samples per second.")
    try:
        raw = base64.b64decode(payload.get("samples", ""), validate=True)
    except (binascii.Error, TypeError, ValueError):
        raise ValueError("The recording is not valid base64.") from None
    if len(raw) % 2 or not raw:
        raise ValueError("The recording is empty or damaged.")
    if len(raw) > RATE * MAX_SECONDS * 2:
        raise ValueError(f"Keep a voice search under {MAX_SECONDS} seconds.")
    return np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768
