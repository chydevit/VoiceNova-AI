"""Khmer subtitles: an .srt file, and an overlay stream for burning them in.

Burned-in text is drawn by the browser (it shapes Khmer script correctly and has the
font), in the chosen style: one transparent PNG per line, all covering the same strip of
the picture (`strip` = {y, width, height}). Here we turn those PNGs into a single ffmpeg
concat stream that shows each image during its line; merge.py lays it over the video at y."""
import base64
from pathlib import Path

import sentences
from errors import AppError
from services import media


def spans(items: list[dict], duration: float) -> list[tuple[dict, str, float, float]]:
    """(sentence, subtitle text, start, end) for every sentence with a subtitle, never overlapping the next."""
    lines = [s for s in sorted(items, key=lambda s: s["start"]) if sentences.subtitle(s)]
    out = []
    for i, s in enumerate(lines):
        limit = lines[i + 1]["start"] if i + 1 < len(lines) else duration
        end = min(max(s["end"], s["start"] + 0.5), limit, duration)
        if end > s["start"]:
            out.append((s, sentences.subtitle(s), s["start"], end))
    return out


def _stamp(t: float) -> str:
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"


def write_srt(items: list[dict], duration: float, path: Path, bilingual: bool = False) -> Path:
    """bilingual: the original line goes under the Khmer one."""
    blocks = [
        f"{n}\n{_stamp(a)} --> {_stamp(b)}\n{text}\n" + (f"{s['original_text']}\n" if bilingual and s["original_text"] else "")
        for n, (s, text, a, b) in enumerate(spans(items, duration), 1)
    ]
    path.write_text("\n".join(blocks), "utf-8")
    return path


def build_overlay(items: list[dict], duration: float, images: dict[str, str], strip: dict, work: Path) -> tuple[Path, int]:
    """Write the PNGs and an ffconcat list; returns (the list's path — an ffmpeg input, the strip's y)."""
    width, height = strip["width"], strip["height"]
    folder = work / "subs"
    folder.mkdir(exist_ok=True)
    blank = folder / "blank.png"
    media.ffmpeg("-f", "lavfi", "-i", f"color=c=black@0.0:s={width}x{height},format=rgba", "-frames:v", 1, blank, what="Preparing subtitles")
    entries, t = [], 0.0
    for s, _text, start, end in spans(items, duration):
        data = images.get(s["id"])
        if not data:
            continue
        png = folder / f"{s['id']}.png"
        try:
            png.write_bytes(base64.b64decode(data.split(",", 1)[-1]))
        except ValueError as err:
            raise AppError("A subtitle image was damaged.", hint="Reload the page and try again.") from err
        if start > t:
            entries.append((blank, start - t))
        entries.append((png, end - start))
        t = end
    entries.append((blank, max(0.04, duration - t)))
    lines = ["ffconcat version 1.0"]
    for file, seconds in entries:
        lines += [f"file '{file.name}'", f"duration {seconds:.3f}"]
    lines.append(f"file '{blank.name}'")  # the concat demuxer ignores the last duration unless the file repeats
    listing = folder / "subs.ffconcat"
    listing.write_text("\n".join(lines) + "\n", "utf-8")
    return listing, strip["y"]
