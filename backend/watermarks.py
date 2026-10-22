"""Watermarks: a logo, a line of text or a faint repeated logo on top of the whole picture.

They are the clips of the watermark track (see timeline.py). Everything about where and how big
is in percent of the picture, so a watermark sits in the same place at any size or shape:

  kind        image | text | tiled
  media       the logo: a key of project["media"] (image and tiled)
  whole       true: it lasts the whole video, whatever is cut or added (fit_whole)
  anchor      one of ANCHORS: where it sits; "free" uses x, y (its middle, % of the picture)
  margin      % of the picture's shorter side, from the edges (anchored positions)
  width       % of the picture's width (image); `height` % of the picture's height, or None to keep
              the logo's own shape
  size        a text watermark's letters, % of the picture's shorter side
  opacity     0–100 · rotation: degrees, -180–180
  effects     shadow, glow, outline, color (original | white | black), radius (% rounded corners), soft
  animation   {type: none | fade | pulse | corners, fade (s), period (s, pulse), every (s, corners)}
  tile        {spacing (% of the picture's width between logos), angle (degrees)}
  hide_during ads, intro, outro: left out while those play
  safe_area   keep it out of the parts of a 9:16 picture that TikTok / Reels / Shorts cover

The browser draws a watermark (frontend lib/watermark.js) for the preview and, at the exported
size, for the export; FFmpeg lays it over the picture with its timing and animation (merge.py).
Presets and the default watermark for new projects are kept in DATA_DIR/library/watermarks.json.
"""
import copy
import json
import re
import secrets
import subprocess
import threading
import time
from pathlib import Path

import numpy as np

import config
import timeline
from errors import AppError

KINDS = ("image", "text", "tiled")
ANCHORS = ("top-left", "top-center", "top-right", "middle-left", "center", "middle-right",
           "bottom-left", "bottom-center", "bottom-right", "free")
ANIMATIONS = ("none", "fade", "pulse", "corners")
HIDE = ("ads", "intro", "outro")
COLORS = ("original", "white", "black")
FONTS = ("Kantumruy Pro", "Noto Sans Khmer", "Battambang", "Moul")  # loaded by frontend index.html
MAX_LOGO_MB = 10
LOGO_EXTENSIONS = (".png", ".jpg", ".jpeg", ".webp")  # an SVG is turned into a PNG by the browser first
HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


def defaults(kind: str = "image") -> dict:
    """A new watermark's settings (keep in sync with frontend lib/watermark.js)."""
    return {
        "kind": kind, "media": None, "whole": True,
        "anchor": "bottom-right" if kind != "tiled" else "center", "x": 50.0, "y": 50.0, "margin": 4,
        "width": 12 if kind == "image" else 8, "height": None,
        "text": "", "font": "Kantumruy Pro", "size": 4.0, "color": "#ffffff", "bold": True,
        "opacity": 75 if kind != "tiled" else 15, "rotation": 0,
        "effects": {"shadow": False, "glow": False, "outline": False, "color": "original", "radius": 0, "soft": False},
        "animation": {"type": "none", "fade": 0.5, "period": 3.0, "every": 10.0},
        "tile": {"spacing": 30, "angle": -30},
        "hide_during": [], "safe_area": True, "remove_bg": False,
        "preset": None,  # the preset it came from (applying that preset again replaces it)
    }


FIELDS = tuple(k for k in defaults() if k != "kind")


def _num(v, lo, hi, name, whole=False):
    try:
        v = float(v)
    except (TypeError, ValueError):
        raise AppError(f"The watermark's {name} must be a number.") from None
    if not np.isfinite(v):
        raise AppError(f"The watermark's {name} must be a number.")
    v = min(hi, max(lo, v))
    return int(round(v)) if whole else round(v, 3)


def clean(fields: dict, current: dict | None = None) -> dict:
    """Checked and clamped settings, from what was sent (keys left out stay as in `current`)."""
    out = copy.deepcopy(current) if current else defaults(fields.get("kind", "image"))
    for k, v in fields.items():
        if k == "kind":
            if v not in KINDS:
                raise AppError("A watermark is a logo, text or a tiled logo.")
            out[k] = v
        elif k in ("media", "preset"):
            out[k] = v if v is None else str(v)[:40]
        elif k in ("whole", "bold", "safe_area", "remove_bg"):
            out[k] = bool(v)
        elif k == "anchor":
            if v not in ANCHORS:
                raise AppError(f"“{v}” isn't a watermark position.")
            out[k] = v
        elif k in ("x", "y"):
            out[k] = _num(v, 0, 100, "position")
        elif k == "margin":
            out[k] = _num(v, 0, 40, "margin", whole=True)
        elif k == "width":
            out[k] = _num(v, 1, 100, "size", whole=True)
        elif k == "height":
            out[k] = None if v is None else _num(v, 1, 100, "height", whole=True)
        elif k == "size":
            out[k] = _num(v, 1, 30, "text size")
        elif k == "text":
            out[k] = str(v)[:200]
        elif k == "font":
            if v not in FONTS:
                raise AppError(f"“{v}” isn't one of the watermark fonts.", hint=", ".join(FONTS))
            out[k] = v
        elif k == "color":
            if not HEX.match(str(v)):
                raise AppError("A colour is written like #ffffff.")
            out[k] = str(v).lower()
        elif k == "opacity":
            out[k] = _num(v, 0, 100, "opacity", whole=True)
        elif k == "rotation":
            out[k] = _num(v, -180, 180, "rotation", whole=True)
        elif k == "effects":
            e = out["effects"]
            for ek, ev in (v or {}).items():
                if ek in ("shadow", "glow", "outline", "soft"):
                    e[ek] = bool(ev)
                elif ek == "color":
                    if ev not in COLORS:
                        raise AppError("The logo's colour is original, white or black.")
                    e[ek] = ev
                elif ek == "radius":
                    e[ek] = _num(ev, 0, 50, "corner rounding", whole=True)
                else:
                    raise AppError(f"A watermark has no effect “{ek}”.")
        elif k == "animation":
            a = out["animation"]
            for ak, av in (v or {}).items():
                if ak == "type":
                    if av not in ANIMATIONS:
                        raise AppError("The animation is none, fade, pulse or corner switch.")
                    a[ak] = av
                elif ak == "fade":
                    a[ak] = _num(av, 0.1, 5, "fade")
                elif ak == "period":  # in tenths, so the export's looped pulse lasts exactly one
                    a[ak] = round(_num(av, 1, 20, "pulse"), 1)
                elif ak == "every":
                    a[ak] = _num(av, 2, 600, "corner switch time")
                else:
                    raise AppError(f"A watermark animation has no “{ak}”.")
        elif k == "tile":
            t = out["tile"]
            for tk, tv in (v or {}).items():
                if tk == "spacing":
                    t[tk] = _num(tv, 5, 200, "tile spacing", whole=True)
                elif tk == "angle":
                    t[tk] = _num(tv, -90, 90, "tile angle", whole=True)
                else:
                    raise AppError(f"A tiled watermark has no “{tk}”.")
        elif k == "hide_during":
            bad = [h for h in (v or []) if h not in HIDE]
            if bad:
                raise AppError(f"A watermark can be hidden during {', '.join(HIDE)}, not “{bad[0]}”.")
            out[k] = [h for h in HIDE if h in (v or [])]
        else:
            raise AppError(f"A watermark has no setting “{k}”.")
    return out


# ---------- animation (the same maths as frontend lib/watermark.js animationAt) ----------

PULSE_DEPTH = 0.35  # a pulsing watermark goes down to (1 - this) of its opacity
PULSE_RATE = 10  # its opacity changes this many times a second
CORNERS = ("top-left", "top-right", "bottom-right", "bottom-left")  # the order a corner switch goes round


def nearest_corner(anchor: str) -> str:
    if anchor in CORNERS:
        return anchor
    row, col = ("bottom", "right") if anchor in ("center", "free") else anchor.split("-")
    return f"{'top' if row == 'top' else 'bottom'}-{'left' if col == 'left' else 'right'}"


def pulse_alpha(step: float, period: float) -> float:
    return 1 - PULSE_DEPTH * (1 - np.cos(2 * np.pi * step / period)) / 2


def animation_at(w: dict, since: float, until: float = float("inf")) -> tuple[float, str]:
    """(its opacity's share 0–1, where it sits) `since` seconds after it appeared, `until` before it goes."""
    a = w.get("animation") or {}
    alpha, anchor = 1.0, w["anchor"]
    if a.get("type") == "fade":  # at most half its time each way, so the two never meet
        d = min(a["fade"], (since + until) / 2)
        alpha = min(1.0, max(0.0, since / d), max(0.0, until / d))
    if a.get("type") == "pulse":
        alpha = float(pulse_alpha(np.floor(since * PULSE_RATE + 1e-9) / PULSE_RATE, a["period"]))
    if a.get("type") == "corners" and w.get("kind") != "tiled":
        first = CORNERS.index(nearest_corner(w["anchor"]))
        anchor = CORNERS[(first + int(np.floor(since / a["every"] + 1e-9))) % 4]
    return alpha, anchor


# ---------- on the timeline ----------

def new_clip(project: dict, fields: dict, start: float | None = None, end: float | None = None) -> dict:
    """A watermark clip on the watermark track: for the whole video, or [start, end]."""
    timeline.require(project, "watermark")
    s = clean(fields)
    if s["kind"] in ("image", "tiled"):
        m = (project.get("media") or {}).get(s["media"])
        if not m or m.get("kind") != "image" or m.get("removed"):
            raise AppError("Choose a logo first.", hint="Upload one, or pick one from the Brand Kit.")
    elif not s["text"].strip():
        s["text"] = project.get("name", "").rsplit(".", 1)[0][:40] or "Khmer Voice AI"
    length = timeline.end(project)
    whole = start is None and end is None
    start = 0.0 if start is None else max(0.0, start)
    end = (length or 5.0) if end is None else end
    if end - start < timeline.MIN_CLIP:
        raise AppError("The part is too short for a watermark.", hint="Set the In and Out points further apart.")
    c = {"id": timeline.new_id(project, "w"), "type": "watermark", "start": timeline.r3(start), "end": timeline.r3(end),
         "skipped": False, **s, "whole": whole and s.get("whole", True)}
    timeline.clips(project, "watermark").append(c)
    timeline.sort(project)
    return c


def set_props(project: dict, cid: str, fields: dict) -> dict:
    """Change a watermark's settings (whatever was sent; the rest stays)."""
    tr, c = timeline.find(project, cid)
    if not c or tr["id"] != "watermark":
        raise AppError("That watermark doesn't exist any more.", hint="Reload the page.", status=404)
    timeline.require(project, "watermark")
    fields = dict(fields)
    start, end = fields.pop("start", None), fields.pop("end", None)
    if start is not None or end is not None:  # only a part of the video from now on
        start = max(0.0, float(c["start"] if start is None else start))
        end = float(c["end"] if end is None else end)
        if end - start < timeline.MIN_CLIP:
            raise AppError("The part is too short for a watermark.", hint="Set the In and Out points further apart.")
        c["start"], c["end"], c["whole"] = timeline.r3(start), timeline.r3(end), False
    current = {k: c[k] for k in ("kind", *FIELDS) if k in c}
    s = clean(fields, {**defaults(c.get("kind", "image")), **current})
    if s["kind"] in ("image", "tiled") and "media" in fields:
        m = (project.get("media") or {}).get(s["media"])
        if not m or m.get("kind") != "image":
            raise AppError("That logo isn't in this project.", hint="Upload it again, or pick it from the Brand Kit.")
    c.update(s)
    return c


def add_logo(project: dict, folder: Path, src: Path, name: str, library_id: str | None = None) -> str:
    """Copy a logo picture into the project's media (it then never depends on the Brand Kit).
    Returns its media id."""
    import shutil

    pixels = read_rgba(src)
    h, w = pixels.shape[:2]
    mid = timeline.new_id(project, "m")
    (folder / "media").mkdir(exist_ok=True)
    target = folder / "media" / f"{mid}{src.suffix.lower()}"
    shutil.copy2(src, target)
    project.setdefault("media", {})[mid] = {
        "kind": "image", "name": name, "file": str(target.relative_to(folder)), "width": w, "height": h,
        "role": "watermark", "library": library_id,
        "transparent": bool((pixels[..., 3] < 250).mean() > 0.01),
    }
    return mid


def fit_whole(project: dict) -> None:
    """Watermarks that last the whole video follow its length (after any edit)."""
    length = timeline.end(project)
    for c in timeline.clips(project, "watermark"):
        if c.get("whole") and length > 0:
            c["start"], c["end"] = 0.0, timeline.r3(length)


def hidden_ranges(project: dict, hide: list[str]) -> list[dict]:
    """The parts of the timeline a watermark hides during: ads (clips of files marked as ads), the
    intro (added clips before the upload's first clip) and the outro (added clips after its last)."""
    video = [c for c in timeline.clips(project, "video")]
    media = project.get("media") or {}
    out = []
    if "ads" in hide:
        out += [{"start": c["start"], "end": c["end"]} for c in video
                if c.get("type") == "ad_video" or (media.get(c.get("media")) or {}).get("role") == "ad"]
    own = [c for c in video if c.get("media") == "source"]
    if own:
        first, last = min(c["start"] for c in own), max(c["end"] for c in own)
        if "intro" in hide and any(c["end"] <= first + timeline.EPS for c in video if c.get("media") != "source"):
            out.append({"start": 0.0, "end": first})
        if "outro" in hide and any(c["start"] >= last - timeline.EPS for c in video if c.get("media") != "source"):
            out.append({"start": last, "end": timeline.end(project)})
    return timeline.merge_ranges(out)


# ---------- logos: reading, background removal ----------

def read_rgba(path: Path) -> np.ndarray:
    """A picture as an (h, w, 4) uint8 array."""
    probe = subprocess.run([config.FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height",
                            "-of", "csv=p=0", str(path)], capture_output=True, text=True)
    try:
        w, h = (int(x) for x in probe.stdout.strip().split(",")[:2])
    except ValueError:
        raise AppError("This picture can't be read.", hint="Use a PNG, JPG or WebP file.") from None
    raw = subprocess.run([config.FFMPEG, "-v", "error", "-i", str(path), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgba", "-"],
                         capture_output=True).stdout
    if len(raw) < w * h * 4:
        raise AppError("This picture can't be read.", hint="Use a PNG, JPG or WebP file.")
    return np.frombuffer(raw[: w * h * 4], np.uint8).reshape(h, w, 4).copy()


def write_png(pixels: np.ndarray, path: Path) -> Path:
    h, w = pixels.shape[:2]
    proc = subprocess.run([config.FFMPEG, "-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", f"{w}x{h}", "-i", "-",
                           "-frames:v", "1", str(path)], input=np.ascontiguousarray(pixels, np.uint8).tobytes(), capture_output=True)
    if proc.returncode:
        raise AppError("The logo couldn't be saved.", detail=proc.stderr.decode(errors="replace")[-400:])
    return path


def _runs(reach: np.ndarray, allowed: np.ndarray) -> np.ndarray:
    """Spread `reach` along each row through the runs of `allowed` pixels it touches."""
    h, w = allowed.shape
    a = np.concatenate([allowed, np.zeros((h, 1), bool)], axis=1).ravel()  # a gap after each row
    r = np.concatenate([reach, np.zeros((h, 1), bool)], axis=1).ravel() & a
    starts = a & ~np.concatenate([[False], a[:-1]])
    ids = np.cumsum(starts) * a
    hit = np.zeros(ids.max() + 1, bool)
    hit[ids[r]] = True
    hit[0] = False
    return hit[ids].reshape(h, w + 1)[:, :w]


def background_mask(pixels: np.ndarray, tolerance: int = 40) -> tuple[np.ndarray, np.ndarray]:
    """The background of a logo on a plain (white or solid) background: the pixels of the border's
    colour joined to the border (so white inside the logo stays). Returns (alpha 0–1 to keep, colour)."""
    rgb = pixels[..., :3].astype(np.int16)
    border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]])
    color = np.median(border, axis=0)
    dist = np.abs(rgb - color).max(axis=2)
    near = dist <= tolerance
    seed = np.zeros_like(near)
    seed[0, :], seed[-1, :], seed[:, 0], seed[:, -1] = near[0, :], near[-1, :], near[:, 0], near[:, -1]
    reach = seed
    for _ in range(64):  # rows, then columns, until nothing more is reached (a few rounds for most logos)
        nxt = _runs(_runs(reach, near).T, near.T).T
        if (nxt == reach).all():
            break
        reach = nxt
    soft = np.clip((dist - tolerance * 0.5) / max(1.0, tolerance * 0.5), 0, 1)  # smooth edges, not jagged ones
    keep = np.where(reach, soft, 1.0)
    return keep, color


def remove_background(src: Path, out: Path, tolerance: int = 40) -> dict:
    """A copy of the logo with its plain background made transparent."""
    pixels = read_rgba(src)
    if (pixels[..., 3] < 250).mean() > 0.05:
        raise AppError("This logo already has a transparent background.")
    keep, color = background_mask(pixels, tolerance)
    removed = float((keep < 0.5).mean())
    if removed < 0.02:
        raise AppError("No plain background was found around the logo.", hint="This works for a logo on a white or one-colour background.")
    pixels[..., 3] = np.round(pixels[..., 3] * keep).astype(np.uint8)
    write_png(pixels, out)
    return {"removed": round(removed, 3), "color": "#%02x%02x%02x" % tuple(int(c) for c in color)}


# ---------- presets and the default for new projects ----------

_lock = threading.RLock()
PRESET_FIELDS = tuple(k for k in FIELDS if k not in ("media", "whole", "preset"))


def _file() -> Path:
    return config.DATA_DIR / "library" / "watermarks.json"


def load_presets() -> dict:
    """{presets: [{id, name, watermarks: [settings + logo (a Brand Kit asset id)]}], default, auto}"""
    path = _file()
    with _lock:
        if not path.exists():
            return {"presets": [], "default": None, "auto": False}
        return json.loads(path.read_text("utf-8"))


def _save_presets(data: dict) -> None:
    path = _file()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), "utf-8")
    tmp.replace(path)


def mutate_presets(fn):
    with _lock:
        data = load_presets()
        result = fn(data)
        _save_presets(data)
        return data, result


def find_preset(data: dict, pid: str) -> dict:
    for p in data["presets"]:
        if p["id"] == pid:
            return p
    raise AppError("That watermark preset doesn't exist any more.", hint="Reload the page.", status=404)


def preset_item(fields: dict, logo: str | None) -> dict:
    """One watermark of a preset: its settings (no times), and its logo as a Brand Kit asset."""
    s = clean({k: v for k, v in fields.items() if k in ("kind", *PRESET_FIELDS)})
    item = {k: s[k] for k in ("kind", *PRESET_FIELDS)}
    item["logo"] = logo
    if item["kind"] in ("image", "tiled") and not logo:
        raise AppError("A logo in a preset must be saved in the Brand Kit first.")
    return item


def new_preset_id(data: dict) -> str:
    taken = {p["id"] for p in data["presets"]}
    while True:
        pid = "wp" + secrets.token_hex(3)
        if pid not in taken:
            return pid


def stamp() -> float:
    return time.time()


def preset_from_project(project: dict, folder: Path, name: str) -> tuple[dict, list[str]]:
    """A preset of the project's watermarks (as they are now). Logos not in the Brand Kit yet are put
    there, so every project can use the preset. Returns (preset, media ids that got a Brand Kit copy)."""
    import library

    items, saved = [], []
    for c in timeline.clips(project, "watermark"):
        if c.get("skipped"):
            continue
        logo = None
        if c["kind"] in ("image", "tiled"):
            m = project["media"][c["media"]]
            logo = m.get("library")
            try:
                if logo:
                    library.find_asset(library.load(), logo)
            except AppError:
                logo = None  # deleted from the Brand Kit since: put it back
            if not logo:
                src = folder / m["file"]
                tmp = src.with_name(f"kit-{secrets.token_hex(4)}{src.suffix}")
                tmp.write_bytes(src.read_bytes())
                logo = library.add_asset(tmp, m.get("name") or src.name, "logo", Path(m.get("name") or src.stem).stem)["id"]
                m["library"] = logo
                saved.append(c["media"])
        item = preset_item(c, logo)
        if c.get("remove_bg"):
            item["bg_tolerance"] = project["media"][c["media"]].get("nobg_tolerance", 40)
        items.append(item)
    if not items:
        raise AppError("There's no watermark to save.", hint="Add a logo or a text watermark first.")
    return {"name": (name or "My watermark").strip()[:60], "watermarks": items, "created_at": stamp()}, saved


def apply_preset(project: dict, folder: Path, preset: dict) -> list[str]:
    """Put a preset's watermarks on the project, for the whole video (replacing the ones the same
    preset put there before). Its logos are copied into the project. Returns the new clip ids."""
    import library

    track = timeline.track(project, "watermark")
    timeline.require(project, "watermark")
    track["clips"] = [c for c in track["clips"] if c.get("preset") != preset["id"]]
    ids = []
    for item in preset["watermarks"]:
        fields = {k: v for k, v in item.items() if k not in ("logo", "bg_tolerance")}
        fields["preset"] = preset["id"]
        if item["kind"] in ("image", "tiled"):
            mid = next((k for k, m in (project.get("media") or {}).items() if m.get("library") == item["logo"] and not m.get("removed")), None)
            if not mid:
                a = library.find_asset(library.load(), item["logo"])
                mid = add_logo(project, folder, library.asset_path(item["logo"]), a["name"], item["logo"])
            m = project["media"][mid]
            if item.get("remove_bg") and not m.get("nobg"):
                out = folder / "media" / f"{mid}.nobg.png"
                try:
                    remove_background(folder / m["file"], out, item.get("bg_tolerance", 40))
                    m.update(nobg=str(out.relative_to(folder)), nobg_tolerance=item.get("bg_tolerance", 40))
                except AppError:
                    fields["remove_bg"] = False  # (the logo is transparent already)
            fields["media"] = mid
        ids.append(new_clip(project, fields)["id"])
    return ids


def preset_for_new_project(choice: str | None) -> dict | None:
    """The preset a new project starts with: the one chosen ("none": none), or else the default
    one when "add it to new projects" is on."""
    data = load_presets()
    if choice == "none":
        return None
    if choice:
        return find_preset(data, choice)
    if data.get("auto") and data.get("default"):
        return next((p for p in data["presets"] if p["id"] == data["default"]), None)
    return None
