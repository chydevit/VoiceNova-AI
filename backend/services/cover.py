"""Cover the original video's burned-in subtitles (blur or a dark box), so the Khmer ones
don't sit on top of them.

The area is stored in percent of the picture: {enabled, mode: blur | box, x, y, w, h}.

detect() finds the subtitle band by itself: burned-in subtitles show up while people talk
and disappear in the pauses, always at the same height. So it compares, row by row, how much
sharp outlined-text detail there is in frames taken mid-sentence versus frames taken in the
pauses between sentences. Static things (logos, watermarks) are in both and cancel out.
"""
import subprocess

import numpy as np

import config
from errors import AppError

DEFAULT = {"enabled": False, "mode": "blur", "x": 0.0, "y": 76.0, "w": 100.0, "h": 12.0}
SAMPLE_WIDTH = 320
FRAMES = 24  # per group (speech / pauses)


def ffmpeg_chain(cover: dict | None, width: int, height: int, src: str = "[0:v]", out: str = "[cv]") -> str | None:
    """The filter that covers the area, or None when covering is off."""
    if not cover or not cover.get("enabled"):
        return None
    x, y, w, h = _pixels(cover, width, height)
    if cover.get("mode") == "box":
        return f"{src}drawbox=x={x}:y={y}:w={w}:h={h}:color=black@1.0:t=fill{out}"
    radius = max(1, min(30, min(w, h) // 2 - 1))
    chroma = max(1, min(radius, min(w, h) // 4 - 1))  # the colour planes are half the size
    return (
        f"{src}split[cover_base][cover_part];"
        f"[cover_part]crop={w}:{h}:{x}:{y},boxblur=luma_radius={radius}:luma_power=3:chroma_radius={chroma}:chroma_power=3[cover_blur];"
        f"[cover_base][cover_blur]overlay={x}:{y}{out}"
    )


def _pixels(cover: dict, width: int, height: int) -> tuple[int, int, int, int]:
    def even(v: float) -> int:  # yuv420 likes even sizes and positions
        return int(round(v / 2)) * 2

    x = even(width * max(0.0, min(100.0, cover["x"])) / 100)
    y = even(height * max(0.0, min(100.0, cover["y"])) / 100)
    w = max(2, min(width - x, even(width * cover["w"] / 100)))
    h = max(2, min(height - y, even(height * cover["h"] / 100)))
    return x, y, w, h


def detect(video, info: dict, sentences: list[dict]) -> dict:
    """{"found": bool, "cover": {...}, "confidence": 0–1}."""
    duration = info["duration"]
    talking = [s for s in sentences if s["end"] - s["start"] >= 0.8]
    pauses = _pauses(sentences, duration)
    if len(talking) < 4:
        return {"found": False, "cover": None, "confidence": 0.0, "reason": "Not enough sentences to compare."}
    speech_times = [s["start"] + (s["end"] - s["start"]) * 0.5 for s in _spread(talking, FRAMES)]
    if len(pauses) >= 4:
        quiet_times = [(a + b) / 2 for a, b in _spread(pauses, FRAMES)]
    else:  # hardly any pauses: compare with the picture in general (sampled evenly) instead
        quiet_times = [duration * (i + 0.5) / FRAMES for i in range(FRAMES)]

    speech = np.mean([_row_detail(video, t) for t in speech_times], axis=0)
    quiet = np.mean([_row_detail(video, t) for t in quiet_times], axis=0)
    diff = np.convolve(speech - quiet, np.ones(5) / 5, mode="same")  # smooth over a few rows
    rows = len(diff)
    peak = int(np.argmax(diff))
    strength = float(diff[peak])
    if strength < 0.025:  # less than 2.5 % of a row's width turned into text edges: nothing there
        return {"found": False, "cover": None, "confidence": round(max(0.0, strength) / 0.025, 2), "reason": "No burned-in subtitles were found."}

    # Grow the band around the peak while the rows still carry most of the difference.
    edge = strength * 0.35
    top = peak
    while top > 0 and diff[top - 1] > edge:
        top -= 1
    bottom = peak
    while bottom < rows - 1 and diff[bottom + 1] > edge:
        bottom += 1
    pad = rows * 0.015
    y = max(0.0, (top - pad) / rows * 100)
    h = min(100.0 - y, (bottom - top + 1 + 2 * pad) / rows * 100)
    # Horizontally: where the speech frames carry extra detail inside the band.
    x, w = _columns(video, speech_times, top, bottom, quiet_times)
    centred = abs(x + w / 2 - 50) < 15  # subtitles are centred; changing UI text in a corner is not a subtitle
    if strength < 0.04 or not centred:
        return {"found": False, "cover": None, "confidence": round(min(1.0, strength / 0.08) * 0.5, 2), "reason": "No burned-in subtitles were found."}
    cover = {"enabled": True, "mode": "blur", "x": round(float(x), 1), "y": round(float(y), 1), "w": round(float(w), 1), "h": round(float(max(h, 4.0)), 1)}
    return {"found": True, "cover": cover, "confidence": round(min(1.0, strength / 0.08), 2)}


def _pauses(sentences: list[dict], duration: float) -> list[tuple[float, float]]:
    out, t = [], 0.0
    for s in sorted(sentences, key=lambda s: s["start"]):
        if s["start"] - t >= 0.6:
            out.append((t + 0.15, s["start"] - 0.15))
        t = max(t, s["end"])
    if duration - t >= 0.6:
        out.append((t + 0.15, duration - 0.15))
    return out


def _spread(items: list, n: int) -> list:
    if len(items) <= n:
        return items
    step = len(items) / n
    return [items[int(i * step)] for i in range(n)]


def _frame(video, t: float) -> np.ndarray:
    proc = subprocess.run(
        [config.FFMPEG, "-v", "error", "-ss", f"{max(0.0, t):.2f}", "-i", str(video), "-frames:v", "1",
         "-vf", f"scale={SAMPLE_WIDTH}:-2,format=gray", "-f", "rawvideo", "-"],
        capture_output=True,
    )
    data = np.frombuffer(proc.stdout, dtype=np.uint8)
    if proc.returncode != 0 or not data.size or data.size % SAMPLE_WIDTH:
        raise AppError("Couldn't read frames from the video.", detail=proc.stderr.decode(errors="replace")[-500:])
    return data.reshape(-1, SAMPLE_WIDTH).astype(np.int16)


def _row_detail(video, t: float) -> np.ndarray:
    """Per row: the share of strong left-right brightness jumps — outlined text has many."""
    jumps = np.abs(np.diff(_frame(video, t), axis=1)) > 70
    return jumps.mean(axis=1)


def _columns(video, speech_times: list[float], top: int, bottom: int, quiet_times: list[float]) -> tuple[float, float]:
    def band(times: list[float]) -> np.ndarray:
        return np.mean([np.abs(np.diff(_frame(video, t)[top:bottom + 1], axis=1)) > 70 for t in times[:10]], axis=(0, 1))

    diff = band(speech_times) - band(quiet_times)
    hot = np.flatnonzero(np.convolve(diff, np.ones(9) / 9, mode="same") > max(0.02, diff.max() * 0.15))
    if not hot.size:
        return 0.0, 100.0
    cols = len(diff)
    left = hot[0] / cols * 100
    right = (hot[-1] + 1) / cols * 100
    # Subtitles are centred and their length varies: cover symmetrically, wide enough for long lines.
    half = min(50.0, max(50 - left, right - 50) + 8)
    return 50 - half, 2 * half
