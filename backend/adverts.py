"""Ad wizard drafts: what the user fills in to make an advertorial video from scratch, before it is
built into a project (steps 1–5 of the wizard). One JSON file per draft in DATA_DIR/adverts/.

The pictures, clips and logo are Ad Library assets (library.py): uploading them in the wizard puts
them in the library, so the next ad can use them again. A new draft starts from the default brand kit.
"""
import copy
import json
import secrets
import threading
import time
from pathlib import Path

import adtemplates
import config
import library
from errors import AppError
from services import adscript

_lock = threading.RLock()

STEPS = ("product", "media", "style", "format", "script", "build")
FORMATS = {  # aspect -> (label, where it's used)
    "9:16": ("Vertical", "TikTok, Reels, Shorts"),
    "1:1": ("Square", "Facebook and Instagram feed"),
    "16:9": ("Wide", "YouTube"),
}
RESOLUTIONS = ("720p", "1080p")
MOODS = ("upbeat", "calm", "luxury", "fun")
VOICES = ("female", "male")
MAX_MEDIA = 20
TEXT_LIMITS = {"product": 120, "description": 1500, "price": 60, "promo": 200, "cta": 60}


def root() -> Path:
    return config.DATA_DIR / "adverts"


def _path(did: str) -> Path:
    if not did.isalnum():
        raise AppError("That ad draft doesn't exist.", status=404)
    return root() / f"{did}.json"


def _empty_brief() -> dict:
    return {"product": "", "description": "", "price": "", "promo": "", "cta": "", "contact": {k: "" for k in library.CONTACT_FIELDS}}


def create() -> dict:
    """A new draft, filled in from the default brand kit."""
    brand = library.current_brand()
    brief = _empty_brief()
    if brand:
        brief["contact"].update(brand["contact"])
        brief["cta"] = brand["cta"]
    now = time.time()
    draft = {
        "id": secrets.token_hex(5), "version": 1, "created_at": now, "updated_at": now, "step": "product",
        "brand": brand["id"] if brand else None, "brief": brief, "media": [], "logo": brand["logo"] if brand else None,
        "style": "product", "template": adtemplates.for_style("product")["id"], "format": "9:16", "length": 30, "resolution": "1080p", "voice": "female", "music": {"mood": "upbeat"},
        "scripts": [], "chosen": None, "project": None,
        "watermark": _default_watermark(),  # a watermark preset (watermarks.py), or None
    }
    _save(draft)
    return draft


def _default_watermark() -> str | None:
    import watermarks

    data = watermarks.load_presets()
    return data.get("default") if data.get("auto") else None


def load(did: str) -> dict:
    try:
        return json.loads(_path(did).read_text("utf-8"))
    except FileNotFoundError:
        raise AppError("That ad draft doesn't exist any more.", hint="Start a new ad.", status=404) from None
    except (OSError, ValueError) as err:
        raise AppError("This ad draft can't be read.", status=500, detail=str(err)) from err


def _save(draft: dict) -> None:
    path = _path(draft["id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    draft["updated_at"] = time.time()
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(draft, ensure_ascii=False, indent=1), "utf-8")
    tmp.replace(path)


def mutate(did: str, fn) -> dict:
    with _lock:
        draft = load(did)
        fn(draft)
        _save(draft)
        return draft


def list_drafts() -> list[dict]:
    out = []
    for path in root().glob("*.json") if root().exists() else []:
        try:
            out.append(json.loads(path.read_text("utf-8")))
        except (OSError, ValueError):
            continue
    return sorted(out, key=lambda d: -d["updated_at"])


def delete(did: str) -> None:
    load(did)
    _path(did).unlink(missing_ok=True)


# ---------- changing a draft ----------

def patch(did: str, fields: dict) -> dict:
    """Change any of: step, brand, brief (merged), media, logo, style, format, length, resolution,
    voice, music, chosen, scripts (the user's edits to the scripts), watermark (a preset id or None)."""
    lib = library.load()

    def apply(d: dict) -> None:
        if "brand" in fields:
            if fields["brand"] is not None:
                library.find_brand(lib, fields["brand"])
            d["brand"] = fields["brand"]
        if fields.get("brief") is not None:
            _brief(d["brief"], fields["brief"])
        if fields.get("media") is not None:
            existing = {a["id"]: a for a in lib["assets"]}
            wanted = list(dict.fromkeys(fields["media"]))
            if any(aid not in existing and aid not in d["media"] for aid in wanted):
                raise AppError("That picture isn't in the Ad Library any more.", hint="Reload the page.", status=404)
            ids = [aid for aid in wanted if aid in existing]  # ones deleted from the library since are dropped
            if len(ids) > MAX_MEDIA:
                raise AppError(f"An ad can use at most {MAX_MEDIA} pictures and clips.", hint="Pick the best ones.")
            if any(existing[aid]["media"] not in ("image", "video") for aid in ids):
                raise AppError("Only pictures and video clips can be shown in an ad.", hint="Music is chosen in the Format step.")
            d["media"] = ids
        if "logo" in fields:
            if fields["logo"] is not None and library.find_asset(lib, fields["logo"])["media"] != "image":
                raise AppError("The logo must be a picture.")
            d["logo"] = fields["logo"]
        _choice(d, fields, "step", STEPS)
        old_style = d["style"]
        _choice(d, fields, "style", tuple(adscript.STYLES))
        if fields.get("template") is not None:
            d["template"] = adtemplates.get(fields["template"])["id"]
        elif d["style"] != old_style and d.get("template") == adtemplates.for_style(old_style)["id"]:
            d["template"] = adtemplates.for_style(d["style"])["id"]  # still the old style's own look: follow the style
        _choice(d, fields, "format", tuple(FORMATS))
        _choice(d, fields, "resolution", RESOLUTIONS)
        _choice(d, fields, "voice", VOICES)
        if fields.get("length") is not None:
            adscript.budget(fields["length"])  # checks it
            d["length"] = fields["length"]
        if fields.get("music") is not None:
            mood = fields["music"].get("mood", d["music"]["mood"])
            if mood not in MOODS:
                raise AppError(f"“{mood}” isn't a music mood.", hint=f"Use one of: {', '.join(MOODS)}.")
            track = fields["music"].get("asset", d["music"].get("asset"))
            if track is not None and library.find_asset(lib, track)["media"] != "audio":
                raise AppError("The music must be a sound file.")
            d["music"] = {"mood": mood, "asset": track}
        if fields.get("scripts") is not None:
            d["scripts"] = [edited_script(s, d["length"], d["media"]) for s in fields["scripts"]]
            if d["chosen"] is not None and d["chosen"] >= len(d["scripts"]):
                d["chosen"] = None
        if "chosen" in fields:
            if fields["chosen"] is not None and not 0 <= fields["chosen"] < len(d["scripts"]):
                raise AppError("That script doesn't exist.", hint="Write the scripts first.")
            d["chosen"] = fields["chosen"]
        if "watermark" in fields:  # the watermark preset the ad gets (None: no watermark)
            if fields["watermark"] is not None:
                import watermarks

                watermarks.find_preset(watermarks.load_presets(), fields["watermark"])
            d["watermark"] = fields["watermark"]

    return mutate(did, apply)


def _choice(d: dict, fields: dict, key: str, allowed: tuple) -> None:
    if fields.get(key) is None:
        return
    if fields[key] not in allowed:
        raise AppError(f"“{fields[key]}” isn't a choice for {key}.", hint=f"Use one of: {', '.join(allowed)}.")
    d[key] = fields[key]


def _brief(brief: dict, fields: dict) -> None:
    for key, limit in TEXT_LIMITS.items():
        if fields.get(key) is not None:
            brief[key] = str(fields[key]).strip()[:limit]
    for key, value in (fields.get("contact") or {}).items():
        if key not in library.CONTACT_FIELDS:
            raise AppError(f"“{key}” isn't a contact field.", hint=f"Use: {', '.join(library.CONTACT_FIELDS)}.")
        brief["contact"][key] = " ".join(str(value or "").split())[:200]


def edited_script(s: dict, length: int, media: list[str]) -> dict:
    """A script as the user edited it: tidied and re-timed the same way as the AI's (adscript.clean),
    but numbers are left as typed (the voice step spells them out). A scene's media is the id of one
    of the draft's pictures or clips, or None (the brand colours and logo)."""
    scenes, taken = [], set()
    for i, sc in enumerate(s.get("scenes") or []):
        voice = " ".join(str(sc.get("voice") or "").split())[:400]
        caption = " ".join(str(sc.get("caption") or "").split())[:80]
        if not voice and not caption:
            continue
        sid = str(sc.get("id") or "")  # kept, so the page doesn't redraw a shot while it's being typed in
        if not (sid.isalnum() and len(sid) <= 24) or sid in taken:
            sid = next(f"sc{n}" for n in range(i + 1, 10_000) if f"sc{n}" not in taken)
        taken.add(sid)
        scenes.append({
            "id": sid, "role": sc.get("role") if sc.get("role") in adscript.ROLES else "benefit",
            "voice": voice, "caption": caption, "media": sc.get("media") if sc.get("media") in media else None,
            "seconds": adscript.scene_seconds(voice),
        })
    tone = s.get("tone") if s.get("tone") in adscript.TONE_HOW else "friendly"
    out = {
        "tone": tone, "label": next(t[1] for t in adscript.TONES if t[0] == tone), "title": " ".join(str(s.get("title") or "").split())[:120],
        "scenes": scenes, "post": str(s.get("post") or "").strip()[:2000],
        "chars": sum(len(sc["voice"]) for sc in scenes), "seconds": round(sum(sc["seconds"] for sc in scenes), 1),
        "warnings": [],
    }
    budget = adscript.budget(length)
    if out["chars"] > budget["chars"] * 1.1:
        out["warnings"].append(f"{out['chars']} characters is too much to say in {length} seconds; about {budget['chars']} fit.")
    return out


# ---------- writing the scripts ----------

def write_scripts(did: str) -> dict:
    draft = load(did)
    lib = library.load()
    ids, media = [], []
    for aid in draft["media"]:
        try:
            a = library.find_asset(lib, aid)
        except AppError:
            continue  # deleted from the library since; left out
        ids.append(aid)
        media.append({"name": a["name"], "media": a["media"]})
    scripts = adscript.write(draft["brief"], draft["style"], draft["length"], media)
    for script in scripts:  # the AI picks pictures by number; the draft keeps their ids
        for sc in script["scenes"]:
            sc["media"] = ids[sc["media"]] if sc["media"] >= 0 else None

    def apply(d: dict) -> None:
        d["scripts"] = copy.deepcopy(scripts)
        d["scripts_length"] = draft["length"]  # the page warns when the ad's length changes after this
        d["chosen"] = None
        d["step"] = "script"

    return mutate(did, apply)


def script_text(draft: dict, index: int | None = None) -> str:
    """The chosen script (or script `index`) as plain text: the voiceover, the captions, and the
    text to post with the video."""
    i = draft["chosen"] if index is None else index
    if i is None or not 0 <= i < len(draft["scripts"]):
        raise AppError("Pick a script first.")
    s = draft["scripts"][i]
    lines = [s["title"] or draft["brief"]["product"], f"{s['label']} · {draft['length']} seconds · {draft['format']}", ""]
    lines += ["VOICEOVER / អត្ថបទអាន"]
    lines += [f"{n}. {sc['voice']}" for n, sc in enumerate(s["scenes"], 1) if sc["voice"]]
    lines += ["", "CAPTIONS / អក្សរលើវីដេអូ"]
    lines += [f"{n}. {sc['caption']}" for n, sc in enumerate(s["scenes"], 1) if sc["caption"]]
    lines += ["", "POST / អត្ថបទប្រកាស", s["post"]]
    return "\n".join(lines).strip() + "\n"
