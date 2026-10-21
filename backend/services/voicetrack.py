"""Lay every sentence's clip on one voice track: placed at its start, at its own volume,
cut (with a short fade) where its time slot ends."""
import math
from pathlib import Path

import numpy as np

import sentences
from services import media

SR = media.VOICE_RATE


def build(folder: Path, items: list[dict], duration: float, out: Path) -> tuple[Path, dict]:
    track = np.zeros(int(math.ceil(duration * SR)), dtype=np.float32)
    report = {"voiced": 0, "cut": 0, "missing": 0}
    for s in sorted(items, key=lambda s: s["start"]):
        if not s["khmer_text"]:
            continue
        if not sentences.has_clip(s):
            report["missing"] += 1
            continue
        samples = media.read_wav(folder / s["audio_file_path"]).astype(np.float32)
        limit = int((s["end"] - s["start"]) * SR)
        if len(samples) > limit:
            if len(samples) - limit > sentences.TOO_LONG_TOLERANCE * SR:
                report["cut"] += 1
            samples = _fade_out(samples[:limit])
        at = int(round(s["start"] * SR))
        end = min(len(track), at + len(samples))
        if end > at:
            track[at:end] += samples[: end - at] * s["volume"]
            report["voiced"] += 1
    return media.write_wav(out, np.clip(track, -32768, 32767).astype(np.int16)), report


def cut(track: Path, kept: list[tuple[float, float]], out: Path) -> Path:
    """The voice track with the parts removed from the video left out (for "Khmer audio only")."""
    samples = media.read_wav(track)
    return media.write_wav(out, np.concatenate([samples[int(a * SR):int(b * SR)] for a, b in kept]))


def _fade_out(samples: np.ndarray, seconds: float = 0.08) -> np.ndarray:
    n = min(len(samples), int(seconds * SR))
    if n:
        samples[-n:] *= np.linspace(1.0, 0.0, n, dtype=np.float32)
    return samples
