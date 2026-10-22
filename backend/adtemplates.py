"""Ad templates: the look of an ad (fonts, colours, how shots move and change, caption styles, where
the logo goes, the end screen, the music), apart from what it says. Built-in templates are the JSON
files in backend/ad_templates/; templates people save are in DATA_DIR/library/templates/.

Positions are named spots (top_left … bottom_right, upper, center, lower) that place() turns into
fractions of the frame inside the format's safe area: TikTok, Reels and Shorts cover the bottom and
the right edge of a 9:16 video with buttons and text. So one template fits all three formats.
"""
import copy
import json
import re
import secrets
import time
from pathlib import Path

import config
import library
from errors import AppError
from services import adscript, music

BUILTIN_DIR = Path(__file__).resolve().parent / "ad_templates"
FORMATS = ("9:16", "1:1", "16:9")
# the part of the frame free of the apps' buttons and captions (fractions of each side)
SAFE = {
    "9:16": {"top": 0.10, "bottom": 0.22, "left": 0.06, "right": 0.16},
    "1:1": {"top": 0.07, "bottom": 0.08, "left": 0.07, "right": 0.07},
    "16:9": {"top": 0.08, "bottom": 0.10, "left": 0.06, "right": 0.06},
}
POSITIONS = {  # name -> (row, column)
    "top_left": ("top", "left"), "top": ("top", "center"), "top_right": ("top", "right"),
    "upper_left": ("upper", "left"), "upper": ("upper", "center"), "upper_right": ("upper", "right"),
    "center": ("center", "center"),
    "lower_left": ("lower", "left"), "lower": ("lower", "center"), "lower_right": ("lower", "right"),
    "bottom_left": ("bottom", "left"), "bottom": ("bottom", "center"), "bottom_right": ("bottom", "right"),
}
CORNERS = ("top_left", "top_right", "bottom_left", "bottom_right")
CAPTION_PRESETS = {  # how a caption is drawn (by the browser, like the subtitles)
    "headline": "big title letters with a shadow",
    "bold_box": "bold letters on a box in the main colour",
    "highlight": "letters on a bright marker stroke in the highlight colour",
    "outline": "white letters with a thick dark outline",
    "price_tag": "a tilted tag in the main colour, for prices",
    "burst": "a star burst in the highlight colour, for discounts",
    "ribbon": "a ribbon across the frame",
    "button": "a rounded button, for the call to action",
    "pill": "a small rounded label",
}
ANIMATIONS = ("none", "fade", "pop", "slide_up", "slide_down", "slide_left", "slide_right", "typewriter")
MOTIONS = ("none", "zoom_in", "zoom_out", "pan_left", "pan_right", "pan_up", "pan_down")
TRANSITIONS = ("cut", "fade", "slide_left", "slide_up", "zoom", "wipe", "flash")
FITS = ("fill", "fit", "blur")
END_LAYOUTS = ("centered", "split", "card", "bottom_bar")
END_BACKGROUNDS = ("brand", "gradient", "last_shot_blur", "image")
END_PARTS = ("logo", "headline", "price", "promo", "cta", "contact")


def place(position: str, aspect: str) -> dict:
    """Where a named position is in a format: {x, y} (0–1, the anchor point) and align (left,
    center, right), inside the safe area."""
    if position not in POSITIONS:
        raise AppError(f"“{position}” isn't a position.", hint=f"Use one of: {', '.join(POSITIONS)}.")
    s = SAFE[_one(aspect, FORMATS, "format")]
    left, right, top, bottom = s["left"], 1 - s["right"], s["top"], 1 - s["bottom"]
    row, col = POSITIONS[position]
    y = {"top": top, "upper": top + (bottom - top) * 0.25, "center": (top + bottom) / 2,
         "lower": top + (bottom - top) * 0.75, "bottom": bottom}[row]
    x = {"left": left, "center": (left + right) / 2, "right": right}[col]
    return {"x": round(x, 4), "y": round(y, 4), "align": col}


# ---------- loading ----------

def _user_dir() -> Path:
    return library.root() / "templates"


def all_templates() -> list[dict]:
    """Built-in templates first (in style order), then saved ones, newest first."""
    order = {s: i for i, s in enumerate(adscript.STYLES)}
    builtin = sorted((_read(p, True) for p in BUILTIN_DIR.glob("*.json")), key=lambda t: (order.get(t["style"], 99), t["id"]))
    saved = []
    if _user_dir().exists():
        for p in _user_dir().glob("*.json"):
            try:
                saved.append(_read(p, False))
            except AppError:
                continue  # a damaged file is left out rather than breaking the list
    return builtin + sorted(saved, key=lambda t: -t.get("created_at", 0))


def get(tid: str) -> dict:
    for t in all_templates():
        if t["id"] == tid:
            return t
    raise AppError("That template doesn't exist any more.", hint="Pick another one.", status=404)


def for_style(style: str) -> dict:
    """The built-in template made for an ad style."""
    return next(t for t in all_templates() if t["builtin"] and t["style"] == style)


def _read(path: Path, builtin: bool) -> dict:
    try:
        data = json.loads(path.read_text("utf-8"))
    except (OSError, ValueError) as err:
        raise AppError(f"The template {path.name} can't be read.", status=500, detail=str(err)) from err
    t = check(data)
    t["builtin"] = builtin
    return t


# ---------- checking ----------

def _one(value, allowed: tuple, what: str):
    if value not in allowed:
        raise AppError(f"“{value}” isn't a {what}.", hint=f"Use one of: {', '.join(map(str, allowed))}.")
    return value


def _number(value, lo: float, hi: float, what: str) -> float:
    if not isinstance(value, (int, float)) or not lo <= value <= hi:
        raise AppError(f"The {what} must be a number from {lo} to {hi}.")
    return float(value)


def check(t: dict) -> dict:
    """Check a template and return it tidied; raises AppError naming what's wrong."""
    t = copy.deepcopy(t)
    if not re.fullmatch(r"[a-z0-9_]{2,40}", str(t.get("id", ""))):
        raise AppError("A template needs an id of 2–40 letters, digits or _.")
    if not str(t.get("name") or "").strip():
        raise AppError("A template needs a name.")
    _one(t.get("style"), tuple(adscript.STYLES), "ad style")
    fonts = t.get("fonts")
    if fonts is not None:
        for role in ("title", "body"):
            _one(fonts.get(role), library.FONTS, "Khmer font")
    palette = t.get("palette", "brand")
    if palette != "brand":
        for role in library.COLOR_ROLES:
            library._hex(palette.get(role))
    shots = t["shots"]
    _one(shots["fit"], FITS, "picture fit")
    if not shots["motion"]:
        raise AppError("A template needs at least one shot motion.")
    for m in shots["motion"]:
        _one(m, MOTIONS, "motion")
    _number(shots.get("motion_amount", 0.1), 0, 0.4, "motion amount")
    _one(shots["transition"]["type"], TRANSITIONS, "transition")
    _number(shots["transition"]["duration"], 0, 1.5, "transition length")
    caps = t["captions"]
    if "default" not in caps:
        raise AppError("A template's captions need a default style.")
    for role, c in caps.items():
        if role != "default":
            _one(role, adscript.ROLES, "kind of shot")
        _one(c["preset"], tuple(CAPTION_PRESETS), "caption style")
        _one(c["position"], tuple(POSITIONS), "position")
        _one(c.get("anim", "none"), ANIMATIONS, "animation")
        _number(c.get("size", 1.0), 0.5, 2.0, "caption size")
    logo = t["logo"]
    _one(logo["corner"], CORNERS, "corner")
    _number(logo["size"], 0.05, 0.35, "logo size")
    _number(logo["opacity"], 0.1, 1.0, "logo opacity")
    sp = t.get("sponsored", {"show": False, "corner": "top_left"})
    _one(sp["corner"], CORNERS, "corner")
    end = t["end_screen"]
    _one(end["layout"], END_LAYOUTS, "end screen layout")
    _one(end["background"], END_BACKGROUNDS, "end screen background")
    _one(end.get("anim", "pop"), ANIMATIONS, "animation")
    _number(end["seconds"], 1.5, 8, "end screen length")
    for part in end["show"]:
        _one(part, END_PARTS, "end screen part")
    m = t["music"]
    _one(m["mood"], music.MOODS, "music mood")
    _number(m["volume"], 0, 1, "music volume")
    _number(m["duck"], 0, 1, "music level under the voice")
    _number(t.get("voice", {}).get("speed", 1.0), config.MIN_SPEED, config.MAX_SPEED, "voice speed")
    t.setdefault("sponsored", sp)
    t.setdefault("palette", palette)
    t.setdefault("voice", {"speed": 1.0})
    return t


# ---------- saved templates ----------

def save(t: dict) -> dict:
    """Save a template someone made (stage 5: "Save as template" from an edited ad)."""
    t = {**copy.deepcopy(t), "id": f"my_{secrets.token_hex(4)}", "created_at": time.time()}
    t.pop("builtin", None)
    t = check(t)
    _user_dir().mkdir(parents=True, exist_ok=True)
    path = _user_dir() / f"{t['id']}.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(t, ensure_ascii=False, indent=1), "utf-8")
    tmp.replace(path)
    return {**t, "builtin": False}


def delete(tid: str) -> None:
    t = get(tid)
    if t["builtin"]:
        raise AppError("Built-in templates can't be deleted.")
    (_user_dir() / f"{tid}.json").unlink(missing_ok=True)
