"""The Ad Library and Brand Kits: files and settings every project can reuse. They live in
DATA_DIR/library/:

  library.json        the assets, the saved colours and the brand kits
  assets/<id>.<ext>   the files, as uploaded
  thumbs/<id>.*       a small picture of each picture or video (music has none)

Asset kinds: logo, product (picture or clip), ad_clip (a finished ad: video or still), image, music.
A project that uses an asset gets its own copy of the file, so deleting an asset never breaks a project.

A brand kit is a logo, colours, fonts, contact details and the words new ads use; one of them is the
default, and every new ad starts from it.
"""
import copy
import json
import re
import secrets
import shutil
import subprocess
import threading
import time
from pathlib import Path

import config
from errors import AppError
from services import media

_lock = threading.RLock()  # every read-modify-write of library.json happens under this lock

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
AUDIO_EXTENSIONS = {".mp3", ".m4a", ".aac", ".wav", ".ogg", ".flac"}
KINDS = {  # asset kind -> the media it can be
    "logo": ("image",),
    "product": ("image", "video"),
    "ad_clip": ("video", "image"),
    "image": ("image",),
    "music": ("audio",),
}
MAX_MB = {"image": 30, "audio": 100, "video": config.MAX_UPLOAD_MB}
THUMB_SIZE = 320
MAX_COLORS = 40
# keep in sync with frontend lib/subtitleImages.js FONTS (all are loaded by index.html)
FONTS = ("Kantumruy Pro", "Noto Sans Khmer", "Battambang", "Hanuman", "Koulen", "Moul")
COLOR_ROLES = ("primary", "secondary", "accent", "text", "background")
CONTACT_FIELDS = ("phone", "facebook", "telegram", "address", "website")
HEX = re.compile(r"^#[0-9a-fA-F]{6}$")


def root() -> Path:
    return config.DATA_DIR / "library"


def _empty() -> dict:
    return {"version": 1, "assets": [], "colors": [], "brands": []}


def load() -> dict:
    with _lock:
        try:
            data = json.loads((root() / "library.json").read_text("utf-8"))
        except FileNotFoundError:
            return _empty()
        except (OSError, ValueError) as err:
            raise AppError("The Ad Library file can't be read.", hint=f"Check {root() / 'library.json'}.", status=500, detail=str(err)) from err
        for key, value in _empty().items():
            data.setdefault(key, value)
        return data


def _save(data: dict) -> None:
    path = root() / "library.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=1), "utf-8")
    tmp.replace(path)


def mutate(fn):
    """Load, change with fn(data), save; returns (data, fn's result)."""
    with _lock:
        data = load()
        result = fn(data)
        _save(data)
        return data, result


def _new_id(prefix: str, taken) -> str:
    while True:
        new = f"{prefix}_{secrets.token_hex(4)}"
        if new not in taken:
            return new


# ---------- assets ----------

def media_kind(filename: str) -> str:
    ext = Path(filename).suffix.lower()
    if ext in IMAGE_EXTENSIONS:
        return "image"
    if ext in config.ALLOWED_EXTENSIONS:
        return "video"
    if ext in AUDIO_EXTENSIONS:
        return "audio"
    raise AppError(f"“{ext or filename}” files can't go in the Ad Library.",
                   hint="Use a picture (PNG, JPG, WebP), a video (MP4, MOV, MKV, WebM) or music (MP3, M4A, WAV, OGG, FLAC).")


MEDIA_NAMES = {"image": "a picture", "video": "a video", "audio": "a sound file"}
KIND_NAMES = {"logo": "A logo", "product": "A product", "ad_clip": "An ad clip", "image": "An image", "music": "Music"}


def check_kind(kind: str, what: str) -> None:
    if kind not in KINDS:
        raise AppError(f"“{kind}” isn't a kind of asset.", hint=f"Use one of: {', '.join(KINDS)}.")
    if what not in KINDS[kind]:
        allowed = " or ".join(MEDIA_NAMES[m] for m in KINDS[kind])
        raise AppError(f"{KIND_NAMES[kind]} must be {allowed}, not {MEDIA_NAMES[what]}.", hint="Choose another kind, or another file.")


def probe(path: Path, what: str) -> dict:
    """Size, length and transparency of a picture, video or sound file."""
    media.require_ffmpeg()
    proc = subprocess.run(
        [config.FFPROBE, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        capture_output=True, text=True, errors="replace",
    )
    if proc.returncode != 0:
        raise AppError(f"This file can't be read as {MEDIA_NAMES[what]}.", hint="It may be damaged; export it again and retry.", detail=proc.stderr[-800:])
    data = json.loads(proc.stdout or "{}")
    streams = data.get("streams", [])
    picture = next((s for s in streams if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic")), None)
    sound = next((s for s in streams if s.get("codec_type") == "audio"), None)
    duration = float(data.get("format", {}).get("duration") or (picture or sound or {}).get("duration") or 0)
    if what == "audio":
        if not sound or duration <= 0:
            raise AppError("This file has no sound.", hint="Choose a music file (MP3, M4A, WAV…).")
        return {"duration": round(duration, 3), "width": None, "height": None, "fps": None, "audio": True, "alpha": False}
    if not picture:
        raise AppError("This file has no picture.", hint="Choose a picture or a video.")
    width, height = int(picture.get("width") or 0), int(picture.get("height") or 0)
    if width <= 0 or height <= 0:
        raise AppError(f"This file can't be read as {MEDIA_NAMES[what]}.", hint="It may be damaged; export it again and retry.")
    if what == "video":
        if duration <= 0:
            raise AppError("Couldn't read how long this video is.", hint="Re-export the video as MP4 and try again.")
        if media._rotation(picture) in (90, 270):  # phones store portrait video sideways
            width, height = height, width
        return {"duration": round(duration, 3), "width": width, "height": height, "fps": media._fps(picture), "audio": bool(sound), "alpha": False}
    fmt = picture.get("pix_fmt") or ""
    return {"duration": None, "width": width, "height": height, "fps": None, "audio": False,
            "alpha": "a" in fmt.replace("pal8", "") or (fmt == "pal8" and picture.get("codec_name") == "png")}


def _thumbnail(src: Path, what: str, duration: float | None, stem: str) -> str | None:
    thumbs = root() / "thumbs"
    thumbs.mkdir(parents=True, exist_ok=True)
    fit = f"scale=w='min({THUMB_SIZE},iw)':h='min({THUMB_SIZE},ih)':force_original_aspect_ratio=decrease"
    if what == "image":  # PNG keeps a logo's transparency
        out = thumbs / f"{stem}.png"
        media.ffmpeg("-i", src, "-frames:v", 1, "-vf", fit, out, what="Making a thumbnail")
    elif what == "video":
        out = thumbs / f"{stem}.jpg"
        media.ffmpeg("-ss", f"{min(1.0, (duration or 0) / 3):.2f}", "-i", src, "-frames:v", 1, "-vf", fit, "-q:v", 4, out, what="Making a thumbnail")
    else:
        return None
    return f"thumbs/{out.name}"


def add_asset(upload: Path, filename: str, kind: str, name: str = "") -> dict:
    """Put an uploaded file (written to `upload`, which is moved) into the library."""
    what = media_kind(filename)
    check_kind(kind, what)
    size = upload.stat().st_size
    if not size:
        raise AppError("The uploaded file is empty.", hint="Choose the file again.")
    if size > MAX_MB[what] * 1024 * 1024:
        raise AppError(f"This file is larger than {MAX_MB[what]} MB.", hint="Make it smaller, then upload it again.", status=413)
    info = probe(upload, what)
    with _lock:
        aid = _new_id("as", {a["id"] for a in load()["assets"]})
    ext = Path(filename).suffix.lower()
    target = root() / "assets" / f"{aid}{ext}"
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(upload), target)
    try:
        thumb = _thumbnail(target, what, info["duration"], aid)
    except AppError:
        thumb = None  # the asset still works without its small picture
    asset = {
        "id": aid, "kind": kind, "name": _text(name, 80) or _text(Path(filename).stem, 80) or kind, "media": what,
        "file": f"assets/{target.name}", "thumb": thumb, "original_name": Path(filename).name, "bytes": size,
        **info, "brand": None, "tags": [], "created_at": time.time(),
    }
    mutate(lambda data: data["assets"].append(asset))
    return asset


def find_asset(data: dict, aid: str) -> dict:
    for a in data["assets"]:
        if a["id"] == aid:
            return a
    raise AppError("That asset isn't in the Ad Library any more.", hint="Reload the page.", status=404)


def asset_path(aid: str, thumb: bool = False) -> Path:
    a = find_asset(load(), aid)
    rel = a.get("thumb") if thumb else a["file"]
    path = root() / rel if rel else None
    if not path or not path.exists():
        raise AppError("That file isn't in the Ad Library any more.", status=404)
    return path


def update_asset(aid: str, fields: dict) -> dict:
    def apply(data: dict) -> dict:
        a = find_asset(data, aid)
        if "kind" in fields and fields["kind"] is not None:
            check_kind(fields["kind"], a["media"])
            a["kind"] = fields["kind"]
        if fields.get("name") is not None:
            a["name"] = _text(fields["name"], 80) or a["name"]
        if "brand" in fields:
            if fields["brand"] is not None:
                find_brand(data, fields["brand"])
            a["brand"] = fields["brand"]
        if fields.get("tags") is not None:
            a["tags"] = sorted({_text(t, 30) for t in fields["tags"] if _text(t, 30)})[:20]
        return a

    return mutate(apply)[1]


def delete_asset(aid: str) -> list[str]:
    """Remove an asset and its files. Returns the names of the brand kits that used it as their logo
    (they keep working, without a logo)."""
    def apply(data: dict) -> tuple[dict, list[str]]:
        a = find_asset(data, aid)
        data["assets"].remove(a)
        cleared = []
        for b in data["brands"]:
            if b.get("logo") == aid:
                b["logo"] = None
                cleared.append(b["name"])
        return a, cleared

    _, (asset, cleared) = mutate(apply)
    for rel in (asset["file"], asset.get("thumb")):
        if rel:
            (root() / rel).unlink(missing_ok=True)
    return cleared


# ---------- saved colours ----------

def set_colors(colors: list[dict]) -> list[dict]:
    if len(colors) > MAX_COLORS:
        raise AppError(f"The library keeps at most {MAX_COLORS} colours.", hint="Remove a few first.")
    clean = [{"name": _text(c.get("name"), 40), "hex": _hex(c.get("hex"))} for c in colors]
    mutate(lambda data: data.update(colors=clean))
    return clean


# ---------- brand kits ----------

def default_brand() -> dict:
    """What a new brand kit starts with."""
    return {
        "name": "My brand",
        "logo": None,
        "colors": {"primary": "#D62828", "secondary": "#F77F00", "accent": "#FCBF49", "text": "#FFFFFF", "background": "#111827"},
        "fonts": {"title": "Moul", "body": "Kantumruy Pro"},
        "contact": {k: "" for k in CONTACT_FIELDS},
        "cta": "កុម្ម៉ង់ឥឡូវនេះ",  # "Order now"
        "sponsored_label": "ផ្សាយពាណិជ្ជកម្ម",  # "Sponsored"
    }


def find_brand(data: dict, bid: str) -> dict:
    for b in data["brands"]:
        if b["id"] == bid:
            return b
    raise AppError("That brand kit doesn't exist any more.", hint="Reload the page.", status=404)


def current_brand() -> dict | None:
    """The default brand kit, which new ads use (None when there is none)."""
    brands = load()["brands"]
    return copy.deepcopy(next((b for b in brands if b.get("default")), brands[0] if brands else None))


def _brand_fields(data: dict, brand: dict, fields: dict) -> None:
    """Check and copy the given fields onto brand (fields left out stay as they are)."""
    if fields.get("name") is not None:
        brand["name"] = _text(fields["name"], 60) or brand["name"]
    if "logo" in fields:
        if fields["logo"] is not None:
            a = find_asset(data, fields["logo"])
            if a["media"] != "image":
                raise AppError("A brand logo must be a picture.", hint="Upload the logo as PNG (best with a transparent background) or JPG.")
        brand["logo"] = fields["logo"]
    for role, value in (fields.get("colors") or {}).items():
        if role not in COLOR_ROLES:
            raise AppError(f"“{role}” isn't a brand colour.", hint=f"Use: {', '.join(COLOR_ROLES)}.")
        brand["colors"][role] = _hex(value)
    for role, value in (fields.get("fonts") or {}).items():
        if role not in ("title", "body"):
            raise AppError(f"“{role}” isn't a brand font.", hint="Use: title, body.")
        if value not in FONTS:
            raise AppError(f"“{value}” isn't one of the Khmer fonts.", hint=f"Use one of: {', '.join(FONTS)}.")
        brand["fonts"][role] = value
    for key, value in (fields.get("contact") or {}).items():
        if key not in CONTACT_FIELDS:
            raise AppError(f"“{key}” isn't a contact field.", hint=f"Use: {', '.join(CONTACT_FIELDS)}.")
        brand["contact"][key] = _text(value, 200)
    for key, size in (("cta", 60), ("sponsored_label", 40)):
        if fields.get(key) is not None:
            brand[key] = _text(fields[key], size)


def create_brand(fields: dict) -> dict:
    def apply(data: dict) -> dict:
        brand = {"id": _new_id("br", {b["id"] for b in data["brands"]}), **default_brand(), "default": not data["brands"],
                 "created_at": time.time(), "updated_at": time.time()}
        _brand_fields(data, brand, fields)
        data["brands"].append(brand)
        return brand

    return mutate(apply)[1]


def update_brand(bid: str, fields: dict) -> dict:
    def apply(data: dict) -> dict:
        brand = find_brand(data, bid)
        _brand_fields(data, brand, fields)
        brand["updated_at"] = time.time()
        return brand

    return mutate(apply)[1]


def set_default_brand(bid: str) -> None:
    def apply(data: dict) -> None:
        find_brand(data, bid)
        for b in data["brands"]:
            b["default"] = b["id"] == bid

    mutate(apply)


def delete_brand(bid: str) -> None:
    def apply(data: dict) -> None:
        brand = find_brand(data, bid)
        data["brands"].remove(brand)
        for a in data["assets"]:
            if a.get("brand") == bid:
                a["brand"] = None
        if brand.get("default") and data["brands"]:
            data["brands"][0]["default"] = True

    mutate(apply)


# ---------- helpers ----------

def _text(value, limit: int) -> str:
    return " ".join(str(value or "").split())[:limit]


def _hex(value) -> str:
    value = str(value or "").strip()
    if not HEX.match(value):
        raise AppError(f"“{value}” isn't a colour.", hint="Write colours as #RRGGBB, for example #D62828.")
    return value.upper()
