"""“Fix automatically” for a clip that is longer than its time slot. In order:

  1. let it use the pause after the sentence (up to the next sentence),
  2. speed it up, at most MAX_FIT_SPEED (1.3×),
  3. ask the translator for a shorter Khmer line (up to 2 tries), voice it, then speed up what's left.

Works on a copy and returns (changed fields, notes) — the caller applies them, so a sentence
edited meanwhile is never overwritten. Used for every line by the first "Generate Voice" too.
"""
import math
from pathlib import Path

import config
import sentences
from errors import AppError
from services import clips


def fit(folder: Path, original: dict, room_end: float, provider, shorten=None) -> tuple[dict, list[str]]:
    s = dict(original)
    notes: list[str] = []
    s.update(clips.ensure(folder, s, provider))
    if _fits(s):
        return _changes(original, s), notes

    # 1. use the pause after it
    end = round(min(room_end, s["start"] + s["audio_duration"] + 0.05), 3)
    if end > s["end"] + 0.01:
        s["end"] = end
        notes.append("used the pause after it")
        if _fits(s):
            return _changes(original, s), notes

    # 2. a little faster is enough?
    if _speed_needed(s) <= config.MAX_FIT_SPEED or not shorten:
        _speed_up(folder, s, provider, notes)
        return _changes(original, s), notes

    # 3. shorter wording
    for _ in range(2):
        slot = s["end"] - s["start"]
        at_normal = s["audio_duration"] * s["speed"]  # how long the line takes at 1.0×
        target = max(4, int(len(s["khmer_text"]) * slot * config.MAX_FIT_SPEED * 0.9 / at_normal))
        try:
            shorter = shorten(s["original_text"], s["khmer_text"], slot, target)
        except AppError:
            break  # translator unavailable: speeding up is all we can do
        shorter = sentences.clean(shorter or "")
        if not shorter or len(shorter) >= len(s["khmer_text"]):
            break
        s["khmer_text"], s["shortened"] = shorter, True
        s.update(clips.ensure(folder, s, provider))
        if "shortened the translation" not in notes:
            notes.append("shortened the translation")
        if _speed_needed(s) <= config.MAX_FIT_SPEED:
            break
    if not _fits(s):
        _speed_up(folder, s, provider, notes)
    return _changes(original, s), notes


def _fits(s: dict) -> bool:
    return s["audio_duration"] <= s["end"] - s["start"] + sentences.TOO_LONG_TOLERANCE


def _speed_needed(s: dict) -> float:
    return s["audio_duration"] * s["speed"] / (s["end"] - s["start"])


def _speed_up(folder: Path, s: dict, provider, notes: list[str]) -> None:
    speed = min(config.MAX_FIT_SPEED, math.ceil(_speed_needed(s) * 100) / 100)
    if speed <= s["speed"]:
        return
    s["speed"] = speed
    s.update(clips.ensure(folder, s, provider))
    notes.append(f"sped up to {speed:.2f}×")
    if not _fits(s):
        notes.append("still a little long — its end will be cut")


def _changes(original: dict, s: dict) -> dict:
    s["error"] = None
    sentences.refresh(s)
    return {k: v for k, v in s.items() if original.get(k) != v}
