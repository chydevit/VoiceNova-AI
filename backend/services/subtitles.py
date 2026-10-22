"""Khmer subtitles: an .srt file, and an overlay stream for burning them in.

Both take the subtitles as spans in output time, (voice clip, text, start, end), from render.plan.

Burned-in text is drawn by the browser (it shapes Khmer script correctly and has the
font), in the chosen style: one transparent PNG per line, all covering the same strip of
the picture (`strip` = {y, width, height}). Here we turn those PNGs into a single ffmpeg
concat stream that shows each image during its line; merge.py lays it over the video at y."""
import base64
from pathlib import Path

from errors import AppError
from services import media


def _stamp(t: float) -> str:
    ms = int(round(t * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02}:{m:02}:{s:02},{ms:03}"


def write_srt(spans: list[tuple[dict, str, float, float]], path: Path, bilingual: bool = False) -> Path:
    """bilingual: the original line goes under the Khmer one."""
    blocks = [
        f"{n}\n{_stamp(a)} --> {_stamp(b)}\n{text}\n" + (f"{s['original_text']}\n" if bilingual and s["original_text"] else "")
        for n, (s, text, a, b) in enumerate((t for t in spans if t[3] - t[2] >= 0.1), 1)
    ]
    path.write_text("\n".join(blocks), "utf-8")
    return path


def build_overlay(spans: list[tuple[dict, str, float, float]], duration: float, images: dict[str, str], strip: dict, work: Path) -> tuple[Path, int]:
    """Write the PNGs and an ffconcat list; returns (the list's path — an ffmpeg input, the strip's y)."""
    width, height = strip["width"], strip["height"]
    folder = work / "subs"
    folder.mkdir(exist_ok=True)
    blank = folder / "blank.png"
    media.ffmpeg("-f", "lavfi", "-i", f"color=c=black@0.0:s={width}x{height},format=rgba", "-frames:v", 1, blank, what="Preparing subtitles")
    entries, t = [], 0.0
    for s, _text, start, end in spans:
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
