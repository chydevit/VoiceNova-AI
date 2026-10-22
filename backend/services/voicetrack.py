"""Lay every sentence's clip on one voice track: placed at its start, at its own volume (or along its
volume line, with its fades: render.voice_gains, the same as the preview), cut with a short fade
where its time slot ends."""
import math
from pathlib import Path

import numpy as np

import render
import sentences
from services import media

SR = media.VOICE_RATE


def build(folder: Path, items: list[dict], duration: float, out: Path, volume: int = 100) -> tuple[Path, dict]:
    """`volume`: the voice track's (percent)."""
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
        cut = len(samples) > limit
        if cut:
            if len(samples) - limit > sentences.TOO_LONG_TOLERANCE * SR:
                report["cut"] += 1
            samples = samples[:limit]
        gain = render.voice_gains(s, np.arange(len(samples)) / SR, len(samples) / SR, cut) * (volume / 100)
        at = int(round(s["start"] * SR))
        end = min(len(track), at + len(samples))
        if end > at:
            track[at:end] += samples[: end - at] * gain[: end - at].astype(np.float32)
            report["voiced"] += 1
    return media.write_wav(out, np.clip(track, -32768, 32767).astype(np.int16)), report


def cut(track: Path, kept: list[tuple[float, float]], length: float, out: Path) -> Path:
    """The voice track in output time: the skipped parts of the timeline left out, `length` long."""
    samples = media.read_wav(track)
    joined = np.concatenate([samples[int(round(a * SR)):int(round(b * SR))] for a, b in kept] or [samples[:0]])
    n = int(round(length * SR))
    if len(joined) < n:
        joined = np.concatenate([joined, np.zeros(n - len(joined), dtype=joined.dtype)])
    return media.write_wav(out, joined[:n])
