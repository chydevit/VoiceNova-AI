"""The edit list: tracks of clips on one timeline (pure data: no files, no network).

project["timeline"]["tracks"] holds five tracks, always in this order:

  video       video and image clips; they never overlap, empty space is black
  voice       the Khmer sentences, one voice clip each (their rules are in sentences.py)
  text        text you add on top of the picture (subtitles belong to their voice clip)
  watermark   logos and text over everything, often for the whole video (watermarks.py)
  background  the video clips' own sound; every piece is linked to a video clip (`link`)
  audio       music and sound effects you add

Every clip has an id, a type, start and end (timeline seconds; its length is end - start) and
`skipped`. Clips of a media file also have `media` (a key of project["media"]) and source_in /
source_out (seconds in that file, (out - in) = length x speed). Nothing ever changes a media file:
the export renders this list (render.py).

A skipped video clip's time is left out of the export, with everything that plays during it;
a skipped voice, text or audio clip is silent or hidden.

Volumes are integer percent, 0–200 (100 = as it is): each sound track has one (`volume`), and so
does each sound clip; they multiply. `muted` makes a track or clip silent and keeps its volume, so
unmuting brings it back. A clip may have a volume line, `keys`: [{"at", "v"}] — its volume over
time (percent), `at` being seconds in its own sound (the file for media clips, the voice clip for a
sentence), so the line stays on the sound whatever the clip goes through; before the first point
and after the last the line stays level. The background and music tracks can be lowered while the
Khmer voice speaks: `duck` = {"on", "level" (percent, while it speaks), "fade" (seconds)}.
"""
import copy

TRACKS = ("video", "voice", "text", "watermark", "background", "audio")
SOUND_TRACKS = ("voice", "background", "audio")  # the tracks with a volume
SOUND_TYPES = ("video",)  # clips on the video track that carry their own sound (linked background pieces)
EPS = 0.001
MIN_CLIP = 0.05  # shortest clip, in seconds
MEDIA_FIELDS = ("media", "source_in", "source_out")
VOLUME_MAX = 200  # percent; keep in sync with frontend lib/timeline.js


def r3(t: float) -> float:
    return round(t + 0.0, 3)


def volume(v) -> int:
    """A volume as stored: an integer percent, 0–VOLUME_MAX."""
    return int(round(min(VOLUME_MAX, max(0, float(v)))))


def default_duck() -> dict:
    """Lower a track while the Khmer voice speaks: to `level` percent, over `fade` seconds."""
    return {"on": False, "level": 10, "fade": 0.3}


def default_level(mode: str) -> int:
    """The background's volume for a background mode: the original quietly (duck: DUCK_VOLUME in .env),
    the music without the voice at full volume (separate), or nothing (replace)."""
    import config  # here: this module needs nothing else of the app

    return {"duck": volume(config.DUCK_VOLUME * 100), "separate": 100}.get(mode, 0)


# ---------- tracks and clips ----------

def new_track(tid: str) -> dict:
    t = {"id": tid, "kind": tid, "locked": False, "muted": False, "hidden": False, "clips": []}
    if tid in SOUND_TRACKS:
        t["volume"] = 100
    if tid in ("background", "audio"):
        t["duck"] = default_duck()
    return t


def empty() -> dict:
    return {"tracks": [new_track(t) for t in TRACKS]}


def ensure_tracks(state: dict) -> dict:
    """Add the tracks a project made before them doesn't have (the watermark track came in schema 5),
    each in its place. Works on a project's editable state or a snapshot."""
    have = {t["id"]: t for t in state["timeline"]["tracks"]}
    state["timeline"]["tracks"] = [have.get(tid) or new_track(tid) for tid in TRACKS] + [t for t in state["timeline"]["tracks"] if t["id"] not in TRACKS]
    return state


def track(project: dict, tid: str) -> dict:
    for t in project["timeline"]["tracks"]:
        if t["id"] == tid:
            return t
    raise KeyError(tid)


def clips(project: dict, tid: str) -> list[dict]:
    return track(project, tid)["clips"]


def all_clips(project: dict):
    for t in project["timeline"]["tracks"]:
        for c in t["clips"]:
            yield t, c


def find(project: dict, cid: str) -> tuple[dict, dict] | tuple[None, None]:
    for t, c in all_clips(project):
        if c["id"] == cid:
            return t, c
    return None, None


def order(c: dict) -> tuple:
    """How clips are kept in a track (undo uses the same order)."""
    return c["start"], c["end"], c["id"]


def sort(project: dict) -> None:
    for t in project["timeline"]["tracks"]:
        t["clips"].sort(key=order)


def new_id(project: dict, prefix: str) -> str:
    """v1, b2, t3, a4 … (voice clips keep the sentence ids s1, s2 …, see sentences.new_id)."""
    n = project.get("next_clip", 1)
    taken = {c["id"] for _, c in all_clips(project)}
    while f"{prefix}{n}" in taken:
        n += 1
    project["next_clip"] = n + 1
    return f"{prefix}{n}"


def video_clip(cid: str, media: str, start: float, source_in: float, source_out: float, speed: float = 1.0) -> dict:
    return {
        "id": cid, "type": "video", "media": media, "start": r3(start), "end": r3(start + (source_out - source_in) / speed),
        "source_in": r3(source_in), "source_out": r3(source_out), "speed": speed, "skipped": False,
    }


def background_clip(cid: str, video: dict, source_in: float, source_out: float, level: int = 100,
                    fade_in: float = 0.0, fade_out: float = 0.0, keep_voice: bool = False) -> dict:
    """A piece of a video clip's own sound. Its times follow the video clip (see relink)."""
    b = {
        "id": cid, "type": "audio", "media": video["media"], "link": video["id"], "start": 0.0, "end": 0.0,
        "source_in": r3(source_in), "source_out": r3(source_out), "volume": volume(level), "muted": False,
        "fade_in": round(fade_in, 2), "fade_out": round(fade_out, 2), "keep_voice": keep_voice, "skipped": False,
    }
    place(b, video)
    return b


def place(b: dict, video: dict) -> None:
    """Put a linked background piece where its part of the source plays on the timeline."""
    b["start"] = r3(video["start"] + (b["source_in"] - video["source_in"]) / video["speed"])
    b["end"] = r3(video["start"] + (b["source_out"] - video["source_in"]) / video["speed"])


def relink(project: dict) -> None:
    """Keep every background piece on its video clip: inside its part of the source, at the time that
    part now plays. Pieces whose video clip is gone, or that ended up outside it, are dropped."""
    videos = {c["id"]: c for c in clips(project, "video")}
    kept = []
    for b in clips(project, "background"):
        v = videos.get(b.get("link"))
        if not v or v["type"] not in SOUND_TYPES:
            continue
        b["source_in"] = r3(max(b["source_in"], v["source_in"]))
        b["source_out"] = r3(min(b["source_out"], v["source_out"]))
        if b["source_out"] - b["source_in"] < 0.01 * v["speed"]:
            continue
        place(b, v)
        kept.append(b)
    track(project, "background")["clips"] = sorted(kept, key=order)


PREFIX = {"video": "v", "text": "t", "watermark": "w", "background": "b", "audio": "a"}


def speed(project: dict, c: dict) -> float:
    """How fast a media clip plays its source (a background piece plays at its video clip's speed)."""
    if c.get("link"):
        _, v = find(project, c["link"])
        return v["speed"] if v else 1.0
    return c.get("speed", 1.0)


def split_at(project: dict, c: dict, t: float, minimum: float = MIN_CLIP) -> dict | None:
    """Split a video, image, background, audio or text clip at timeline time t. The new right part is
    returned (None when either part would be shorter than `minimum`). A video clip's background
    pieces go with the part they play under; one that crosses t is split too."""
    if not c["start"] + minimum - EPS <= t <= c["end"] - minimum + EPS:
        return None
    t = r3(t)
    tr, _ = find(project, c["id"])
    right = copy.deepcopy(c)
    right["id"] = new_id(project, PREFIX[tr["id"]])
    cut = None
    if "source_in" in c:
        cut = r3(c["source_in"] + (t - c["start"]) * speed(project, c))
        c["source_out"] = right["source_in"] = cut
    c["end"] = right["start"] = t
    if c.get("whole"):  # two parts of a watermark are each just a part
        c["whole"] = right["whole"] = False
    if "fade_in" in c:  # a fade belongs to the outer edge it was on
        c["fade_out"] = right["fade_in"] = 0.0
    prune_keys(c, tr["id"])
    prune_keys(right, tr["id"])
    tr["clips"].append(right)
    if c["type"] in SOUND_TYPES:
        for b in list(clips(project, "background")):
            if b.get("link") != c["id"]:
                continue
            if b["source_in"] >= cut - EPS:
                b["link"] = right["id"]
            elif b["source_out"] > cut + EPS:
                piece = split_at(project, b, b["start"] + (cut - b["source_in"]) / c["speed"], minimum)
                if piece:
                    piece["link"] = right["id"]
        relink(project)
    sort(project)
    return right


def split_range(project: dict, tid: str, start: float, finish: float) -> list[dict]:
    """Split every clip of a track that crosses start or finish there (even a sliver); returns the
    clips now inside [start, finish]."""
    for t in (start, finish):
        for c in [c for c in clips(project, tid) if c["start"] + EPS < t < c["end"] - EPS]:
            split_at(project, c, t, minimum=2 * EPS)
    return [c for c in clips(project, tid) if c["start"] >= start - EPS and c["end"] <= finish + EPS]


def set_background(project: dict, start: float, finish: float, **fields) -> int:
    """Change the background pieces between start and finish (splitting them there): volume,
    keep_voice… Returns how many pieces changed."""
    inner = split_range(project, "background", start, finish)
    for b in inner:
        b.update(fields)
    return len(inner)


def init(project: dict, video: dict, name: str) -> None:
    """A new project: the upload as one video clip, with its sound as one background piece."""
    project["media"] = {"source": source_media(video, name)}
    project["timeline"] = empty()
    track(project, "background")["volume"] = default_level((project.get("settings") or {}).get("background", "duck"))
    project["next_clip"] = 1
    v = video_clip(new_id(project, "v"), "source", 0.0, 0.0, video["duration"])
    clips(project, "video").append(v)
    clips(project, "background").append(background_clip(new_id(project, "b"), v, 0.0, video["duration"]))


def source_media(video: dict, name: str) -> dict:
    return {
        "kind": "video", "file": video["file"], "name": name, "duration": video["duration"],
        "width": video["width"], "height": video["height"], "fps": video.get("fps") or 30, "audio": True, "proxy": None,
    }


# ---------- time ----------

def end(project: dict, exclude: tuple[str, ...] = ()) -> float:
    """Where the timeline ends: the end of its last clip (the export is this long, minus skipped parts).
    A watermark never makes the video longer."""
    return max((c["end"] for t, c in all_clips(project) if t["id"] not in exclude and t["id"] != "watermark"), default=0.0)


def clip_at(project: dict, tid: str, t: float) -> dict | None:
    for c in clips(project, tid):
        if c["start"] - EPS <= t < c["end"] - EPS:
            return c
    return None


def merge_ranges(ranges: list[dict]) -> list[dict]:
    """Sort {"start", "end"} ranges and join the ones that overlap or touch."""
    merged: list[dict] = []
    for r in sorted(ranges, key=lambda r: r["start"]):
        if merged and r["start"] <= merged[-1]["end"] + 0.01:
            merged[-1]["end"] = max(merged[-1]["end"], r["end"])
        else:
            merged.append({"start": r["start"], "end": r["end"]})
    return merged


def skipped_ranges(project: dict) -> list[dict]:
    """The parts of the timeline left out of the export: where a skipped video clip is."""
    return merge_ranges([{"start": c["start"], "end": c["end"]} for c in clips(project, "video") if c.get("skipped")])


def kept_ranges(skipped: list[dict], length: float) -> list[tuple[float, float]]:
    """The (start, end) parts of [0, length] that are not skipped, in order."""
    out, t = [], 0.0
    for c in merge_ranges(skipped):
        if c["start"] > t:
            out.append((t, min(c["start"], length)))
        t = max(t, c["end"])
    if t < length:
        out.append((t, length))
    return [(a, b) for a, b in out if b - a > EPS]


def output_time(t: float, skipped: list[dict]) -> float:
    """Where timeline time t lands in the export (inside a skipped part: where that part was)."""
    removed = 0.0
    for c in merge_ranges(skipped):
        if t <= c["start"]:
            break
        removed += min(t, c["end"]) - c["start"]
    return t - removed


def inside(start: float, finish: float, ranges: list[dict]) -> bool:
    """True when [start, finish] lies wholly inside one of the ranges."""
    return any(r["start"] - 0.01 <= start and finish <= r["end"] + 0.01 for r in ranges)


def source_time(project: dict, t: float) -> tuple[str, float] | None:
    """(media id, seconds in that file) of the video clip playing at timeline time t."""
    v = clip_at(project, "video", t)
    if not v or v["type"] != "video":
        return None
    return v["media"], v["source_in"] + (t - v["start"]) * v["speed"]


# ---------- schema 2 → 3 ----------

def default_export() -> dict:
    """How the export is rendered. resolution: original | 720p | 1080p (the shorter side);
    aspect: original | 16:9 | 9:16 | 1:1; fit: fit (black bars) | fill (crop); quality: high | medium | small."""
    return {"resolution": "original", "aspect": "original", "fit": "fit", "quality": "high"}


def migrate_state(state: dict, video: dict | None) -> dict:
    """Schema 2 kept the sentences in source time, plus settings["video_cuts"] (parts removed from the
    video), settings["background_cuts"] (background volume parts {start, end, gain, fade}) and
    original_gaps (deleted sentences where the original audio plays at full volume). They become:
    video clips (removed parts skipped), background pieces (volume, fades, keep_voice) and voice clips.
    Works on a project's editable state or on an export version's snapshot."""
    settings = copy.deepcopy(state.get("settings") or {})
    cuts = merge_ranges(settings.pop("video_cuts", None) or [])
    parts = sorted(settings.pop("background_cuts", None) or [], key=lambda p: p["start"])
    gaps = merge_ranges(state.get("original_gaps") or [])
    settings.setdefault("export", default_export())
    out = {"timeline": empty(), "settings": settings, "next_id": state.get("next_id", 1), "next_clip": 1}
    level = settings.pop("background_volume", None)  # schema 2 and 3 kept the background's level here (1.0 = 100 %)
    track(out, "background")["volume"] = volume(level * 100) if level is not None else default_level(settings.get("background", "duck"))
    voice = [
        {**copy.deepcopy(s), "type": "voice", "skipped": s.get("skipped", False), "subtitle_timing": s.get("subtitle_timing"),
         "volume": volume(s.get("volume", 1.0) * 100), "muted": False}
        for s in sorted(state.get("sentences") or [], key=lambda s: s["start"])
    ]
    track(out, "voice")["clips"] = voice
    if not video:
        return out
    length = video["duration"]

    def cut_points(ranges):
        return {r3(x) for r in ranges for x in (r["start"], r["end"]) if EPS < x < length - EPS}

    edges = sorted({0.0, r3(length)} | cut_points(cuts))
    videos = []
    for a, b in zip(edges, edges[1:]):
        if b - a < EPS:
            continue
        v = video_clip(new_id(out, "v"), "source", a, a, b)
        v["skipped"] = inside(a, b, cuts)
        videos.append(v)
    track(out, "video")["clips"] = videos

    pieces = []
    edges = sorted({0.0, r3(length)} | cut_points(cuts) | cut_points(parts) | cut_points(gaps))
    for a, b in zip(edges, edges[1:]):
        if b - a < EPS:
            continue
        mid = (a + b) / 2
        v = next(x for x in videos if x["start"] - EPS <= mid < x["end"] + EPS)
        part = next((p for p in parts if p["start"] - EPS <= mid <= p["end"] + EPS), None)
        piece = background_clip(new_id(out, "b"), v, a, b, level=part["gain"] * 100 if part else 100,
                                keep_voice=any(g["start"] - EPS <= mid <= g["end"] + EPS for g in gaps))
        if part:  # the old volume ramped inside the part, over `fade`, at both of its edges
            fade = max(part.get("fade", 0.05), 0.01)
            piece["fade_in"] = round(fade, 2) if abs(a - part["start"]) < 0.002 else 0.0
            piece["fade_out"] = round(fade, 2) if abs(b - part["end"]) < 0.002 else 0.0
        pieces.append(piece)
    track(out, "background")["clips"] = pieces
    return out


def upgrade_v4(state: dict) -> dict:
    """Schema 3 (the first edit list) kept volumes as fractions (1.0 = normal) and the background's level
    in settings["background_volume"]. Schema 4 keeps every volume as an integer percent, on its track
    and its clips, with ducking on the sound tracks. Works on a project's editable state or a snapshot."""
    settings = state.setdefault("settings", {})
    level = settings.pop("background_volume", None)
    for t in state["timeline"]["tracks"]:
        base = new_track(t["id"])
        for k in ("volume", "duck"):
            if k in base:
                t.setdefault(k, copy.deepcopy(base[k]))
        if t["id"] == "background":
            t["volume"] = volume(level * 100) if level is not None else default_level(settings.get("background", "duck"))
        if t["id"] in SOUND_TRACKS:
            for c in t["clips"]:
                c["volume"] = volume(c.get("volume", 1.0) * 100)
                c.setdefault("muted", False)
    return state


def is_v3(state: dict) -> bool:
    """A schema 3 edit list (its sound tracks have no volume yet)."""
    tracks = (state.get("timeline") or {}).get("tracks") or []
    return any(t["id"] == "background" and "volume" not in t for t in tracks)


# ---------- editing (the API wraps each change in one undo step) ----------
# Locked tracks are never changed. The background is the video clips' own sound, so its pieces
# always follow their video clip (relink), whatever happens to the video.

def editable(project: dict, tid: str) -> bool:
    return not track(project, tid)["locked"]


def require(project: dict, tid: str) -> None:
    if not editable(project, tid):
        raise _error(f"The {NAMES[tid]} track is locked.", "Unlock it (🔒 next to its name) to change it.")


NAMES = {"video": "video", "voice": "Khmer voice", "text": "text", "watermark": "watermark", "background": "background", "audio": "music & sound"}


def _error(message: str, hint: str = "", status: int = 400):
    from errors import AppError  # here, so this module stays importable without the app

    return AppError(message, hint=hint, status=status)


def media_length(project: dict, mid: str) -> float | None:
    """How long a media file is (None for a picture: it can be shown for any time)."""
    m = (project.get("media") or {}).get(mid)
    return m.get("duration") if m and m.get("kind") != "image" else None


def _neighbours(clips_: list[dict], c: dict) -> tuple[float, float]:
    """The free time around a clip on a track whose clips never overlap: (previous end, next start)."""
    before = [o["end"] for o in clips_ if o is not c and o["end"] <= c["start"] + EPS]
    after = [o["start"] for o in clips_ if o is not c and o["start"] >= c["end"] - EPS]
    return max(before, default=0.0), min(after, default=float("inf"))


def trim(project: dict, cid: str, side: str, t: float) -> dict:
    """Move one edge of a clip to timeline time t (as far as it can go). Video clips stop at their
    neighbours and at the ends of their file; extending a video clip brings its sound back too."""
    tr, c = find(project, cid)
    if not c:
        raise _error("That clip doesn't exist any more.", "Reload the page.", 404)
    require(project, tr["id"])
    if tr["id"] == "voice":
        raise _error("Change a sentence's time with its start and end.")
    if tr["id"] == "background":
        return _trim_piece(project, c, side, t)
    if tr["id"] == "watermark":
        c["whole"] = False  # trimmed: just a part from now on
    sp = speed(project, c)
    has_source = "source_in" in c
    length = media_length(project, c["media"]) if has_source else None
    lo, hi = _neighbours(tr["clips"], c) if tr["id"] == "video" else (0.0, float("inf"))
    old_in, old_out = c.get("source_in"), c.get("source_out")
    if side == "start":
        low = lo
        if has_source:
            low = max(low, c["start"] - c["source_in"] / sp)
        t = r3(min(max(t, low, 0.0), c["end"] - MIN_CLIP))
        if has_source:
            c["source_in"] = r3(c["source_in"] + (t - c["start"]) * sp)
        c["start"] = t
    else:
        high = hi
        if has_source and length is not None:
            high = min(high, c["start"] + (length - c["source_in"]) / sp)
        t = r3(max(min(t, high), c["start"] + MIN_CLIP))
        if has_source:
            c["source_out"] = r3(c["source_in"] + (t - c["start"]) * sp)
        c["end"] = t
    if c["type"] in SOUND_TYPES:
        _cover_sound(project, c, old_in, old_out)
    relink(project)
    sort(project)
    return c


def _cover_sound(project: dict, v: dict, old_in: float, old_out: float) -> None:
    """After a video clip grew, give the newly shown part of its file its sound: the piece at that
    edge grows with it, or (if that edge was silent on purpose) a new piece fills it."""
    pieces = sorted((b for b in clips(project, "background") if b.get("link") == v["id"]), key=lambda b: b["source_in"])
    if not (project.get("media") or {}).get(v["media"], {}).get("audio", True):
        return
    if v["source_in"] < old_in - EPS:
        first = pieces[0] if pieces else None
        if first and abs(first["source_in"] - old_in) < EPS:
            first["source_in"] = v["source_in"]
        else:
            clips(project, "background").append(background_clip(new_id(project, "b"), v, v["source_in"], old_in))
    if v["source_out"] > old_out + EPS:
        last = pieces[-1] if pieces else None
        if last and abs(last["source_out"] - old_out) < EPS:
            last["source_out"] = v["source_out"]
        else:
            clips(project, "background").append(background_clip(new_id(project, "b"), v, old_out, v["source_out"]))


def _trim_piece(project: dict, b: dict, side: str, t: float) -> dict:
    """A background piece's edge moves inside its video clip, up to the pieces beside it."""
    _, v = find(project, b["link"])
    siblings = [o for o in clips(project, "background") if o.get("link") == b["link"]]
    lo, hi = _neighbours(siblings, b)
    lo, hi = max(lo, v["start"]), min(hi, v["end"])
    if side == "start":
        t = min(max(t, lo), b["end"] - MIN_CLIP)
        b["source_in"] = r3(v["source_in"] + (t - v["start"]) * v["speed"])
    else:
        t = max(min(t, hi), b["start"] + MIN_CLIP)
        b["source_out"] = r3(v["source_in"] + (t - v["start"]) * v["speed"])
    relink(project)
    return b


def delete(project: dict, ids: list[str], ripple: bool = False, min_voice: float = 0.3) -> int:
    """Delete clips. ripple: a deleted video clip's time is removed from every unlocked track and what
    follows moves up (the gap closes). Otherwise its time stays, as a gap. Returns how many went."""
    targets = [(tr, c) for tr, c in (find(project, i) for i in ids) if c]
    for tr, _ in targets:
        require(project, tr["id"])
    count = 0
    if ripple:
        videos = sorted((c for tr, c in targets if tr["id"] == "video"), key=lambda c: c["start"], reverse=True)
        for v in videos:  # from the end, so earlier times stay where they are
            remove_range(project, v["start"], v["end"], min_voice)
            count += 1
        targets = [(tr, c) for tr, c in targets if tr["id"] != "video"]
    for tr, c in targets:
        if c in tr["clips"]:
            tr["clips"].remove(c)
            count += 1
    relink(project)
    sort(project)
    return count


def remove_range(project: dict, a: float, b: float, min_voice: float = 0.3) -> None:
    """Take [a, b] out of the timeline on every unlocked track; everything after it moves up by b - a.
    Media and text clips are cut at a and b. A sentence is never cut in the middle of its speech:
    one inside the range goes, one across an edge keeps the part outside it (if long enough)."""
    a, b = r3(a), r3(b)
    gap = b - a
    if gap < EPS:
        return
    for tr in project["timeline"]["tracks"]:
        if tr["locked"] or tr["id"] == "background":
            continue
        if tr["id"] == "voice":
            tr["clips"] = _ripple_voice(tr["clips"], a, b, min_voice)
            continue
        whole = _lift_whole(tr)
        inner = split_range(project, tr["id"], a, b)
        tr["clips"] = [c for c in tr["clips"] if c not in inner and c["end"] - c["start"] >= 0.02]  # no slivers
        for c in tr["clips"]:
            if c["start"] >= b - EPS:
                c["start"], c["end"] = r3(c["start"] - gap), r3(c["end"] - gap)
        tr["clips"] += whole
    relink(project)
    sort(project)


def _lift_whole(tr: dict) -> list[dict]:
    """Take the watermarks that last the whole video off their track while time is taken out or put
    in: they aren't cut, they just follow the video's new length (watermarks.fit_whole)."""
    whole = [c for c in tr["clips"] if c.get("whole")]
    tr["clips"] = [c for c in tr["clips"] if not c.get("whole")]
    return whole


def _ripple_voice(items: list[dict], a: float, b: float, min_length: float) -> list[dict]:
    gap = b - a
    out = []
    for s in items:
        start, end = s["start"], s["end"]
        if start >= b - EPS:
            start, end = start - gap, end - gap
        elif start >= a - EPS:  # starts inside the range
            if end <= b + EPS:
                continue
            start, end = a, end - gap
        elif end > a + EPS:  # starts before it and runs into it
            end = a if end <= b else end - gap
        if end - start < min_length - EPS:
            continue
        s["start"], s["end"] = r3(start), r3(end)
        out.append(s)
    return out


def close_gap(project: dict, t: float, min_voice: float = 0.3) -> tuple[float, float]:
    """Close the empty space on the video track around time t: everything after it moves up."""
    require(project, "video")
    if clip_at(project, "video", t):
        raise _error("There's no gap here.", "Click an empty (black) part of the video track.")
    video = clips(project, "video")
    start = max((c["end"] for c in video if c["end"] <= t + EPS), default=0.0)
    finish = min((c["start"] for c in video if c["start"] >= t - EPS), default=None)
    if finish is None:
        raise _error("This empty space is at the end, so there's nothing to move up.")
    for tid in ("voice", "text"):
        if editable(project, tid) and any(start - EPS <= c["start"] and c["end"] <= finish + EPS for c in clips(project, tid)):
            raise _error(f"There's {NAMES[tid]} in this gap.", f"Delete it first, or lock the {NAMES[tid]} track to keep it where it is.", 409)
    remove_range(project, start, finish, min_voice)
    return start, finish


def set_skipped(project: dict, ids: list[str], value: bool) -> int:
    """Skip (leave out of the export, but keep) or bring back clips."""
    n = 0
    for cid in ids:
        tr, c = find(project, cid)
        if not c:
            continue
        require(project, tr["id"])
        c["skipped"] = value
        n += 1
    return n


def skip_range(project: dict, a: float, b: float, value: bool = True) -> int:
    """Skip (or bring back) the picture between a and b, and so everything playing during it."""
    require(project, "video")
    inner = [c for c in split_range(project, "video", a, b) if c["end"] - c["start"] >= EPS]
    for c in inner:
        c["skipped"] = value
    relink(project)
    return len(inner)


SOUND_PROPS = ("volume", "muted", "keys", "fade_in", "fade_out")
PROPS = {
    "video": ("skipped",),
    "voice": SOUND_PROPS,
    "background": (*SOUND_PROPS, "keep_voice", "skipped"),
    "audio": (*SOUND_PROPS, "skipped"),
    "text": ("text", "style", "x", "y", "width", "align", "animation", "skipped"),
    "watermark": ("skipped",),  # its own settings: watermarks.set_props
}


def set_props(project: dict, cid: str, fields: dict) -> dict:
    """Change a clip's settings (volume, mute, fades, volume line, keep the original voice, skipped …)."""
    tr, c = find(project, cid)
    if not c:
        raise _error("That clip doesn't exist any more.", "Reload the page.", 404)
    require(project, tr["id"])
    allowed = PROPS.get(tr["id"], ())
    for k, v in fields.items():
        if k not in allowed:
            raise _error(f"A {NAMES[tr['id']]} clip has no “{k}”.")
        if k == "volume":
            v = volume(v)
        elif k == "keys":
            v = clean_keys(v)
        c[k] = round(v, 3) if isinstance(v, float) else v
    length = c["end"] - c["start"]
    for k in ("fade_in", "fade_out"):
        if k in c:
            c[k] = round(max(0.0, min(c[k], length)), 2)
    if "keys" in c and not c["keys"]:
        del c["keys"]  # no line: the clip's volume is its `volume`
    return c


def clean_keys(keys) -> list[dict]:
    """A volume line as stored: points {at (seconds in the clip's sound), v (percent)}, in time order, one per moment."""
    out: dict[float, int] = {}
    for k in keys or []:
        out[round(max(0.0, float(k["at"])), 3)] = volume(k["v"])
    return [{"at": at, "v": v} for at, v in sorted(out.items())]


def sound_span(c: dict, tid: str) -> tuple[float, float]:
    """Where a clip's sound runs, in its own time (what `keys` are in)."""
    if tid == "voice":
        return 0.0, c["end"] - c["start"]
    return c.get("source_in", 0.0), c.get("source_out", 0.0)


def prune_keys(c: dict, tid: str) -> None:
    """Keep the points of a clip's volume line that matter to it: those inside its sound, and the
    nearest one on each side (the line runs towards it)."""
    keys = c.get("keys")
    if not keys:
        return
    lo, hi = sound_span(c, tid)
    before = [k for k in keys if k["at"] < lo - EPS]
    after = [k for k in keys if k["at"] > hi + EPS]
    inner = [k for k in keys if lo - EPS <= k["at"] <= hi + EPS]
    c["keys"] = before[-1:] + inner + after[:1]


def volume_range(project: dict, tid: str, start: float, finish: float, level: int) -> int:
    """One volume for the part [start, finish] of a sound track: the background's and the music's clips
    are split at its edges; the sentences in it (a sentence is never cut) all get it. A volume line on
    a clip in the part is replaced by the new volume. Returns how many clips changed."""
    require(project, tid)
    level = volume(level)
    if tid == "voice":
        inner = [s for s in clips(project, "voice") if s["start"] < finish - EPS and s["end"] > start + EPS]
    else:
        inner = split_range(project, tid, start, finish)
    for c in inner:
        c["volume"] = level
        c["muted"] = False
        c.pop("keys", None)
    return len(inner)


# ---------- text ----------

ANIMATIONS = ("none", "fade", "pop", "slide")


def default_text_style() -> dict:
    """How new text looks: like the subtitles, larger, with a soft shadow. size is % of the picture's
    shorter side, outline_width % of the text size (keep in sync with frontend lib/subtitleImages.js)."""
    return {
        "font": "Kantumruy Pro", "size": 8.0, "color": "#ffffff", "bold": True,
        "outline": True, "outline_color": "#000000", "outline_width": 18,
        "box": False, "box_color": "#000000", "box_opacity": 0.6, "shadow": True,
    }


def text_clip(cid: str, start: float, end: float, text: str, style: dict | None = None,
              x: float = 50.0, y: float = 20.0) -> dict:
    """Text on top of the picture: its middle is at (x, y), in % of the picture."""
    return {
        "id": cid, "type": "text", "start": r3(start), "end": r3(end), "skipped": False, "text": text,
        "style": {**default_text_style(), **(style or {})}, "x": x, "y": y, "width": 90, "align": "center",
        "animation": {"in": "pop", "out": "fade"},
    }


def add_text(project: dict, at: float, text: str, seconds: float = 3.0, style: dict | None = None) -> dict:
    """New text at the playhead, shown for `seconds`."""
    require(project, "text")
    at = r3(max(0.0, at))
    c = text_clip(new_id(project, "t"), at, at + max(MIN_CLIP, seconds), text or "អក្សរ", style)
    clips(project, "text").append(c)
    sort(project)
    return c


def move(project: dict, ids: list[str], by: float) -> int:
    """Move text and sound clips earlier or later on their track (never before the start)."""
    moved = 0
    targets = [(tr, c) for tr, c in (find(project, i) for i in ids) if c]
    if not targets:
        return 0
    by = max(by, -min(c["start"] for _, c in targets))
    for tr, c in targets:
        require(project, tr["id"])
        if tr["id"] not in ("text", "audio", "watermark"):
            raise _error("Only text, watermark and sound clips can be moved this way.")
        c["start"], c["end"] = r3(c["start"] + by), r3(c["end"] + by)
        if tr["id"] == "watermark":
            c["whole"] = False
        moved += 1
    sort(project)
    return moved


def set_subtitle_timing(project: dict, sid: str, start: float | None, end: float | None) -> dict:
    """When a sentence's subtitle shows, if not during the sentence itself (None, None: during it again).
    Stored relative to the sentence, so it moves with it."""
    require(project, "text")
    _, s = find(project, sid)
    if not s or s.get("type") != "voice":
        raise _error("That sentence doesn't exist any more.", "Reload the page.", 404)
    if start is None and end is None:
        s["subtitle_timing"] = None
        return s
    start = max(0.0, start if start is not None else s["start"])
    end = end if end is not None else max(s["end"], s["start"] + 0.5)
    if end - start < 0.2:
        raise _error("A subtitle must show for at least 0.2 seconds.")
    s["subtitle_timing"] = {"from": r3(start - s["start"]), "to": r3(end - s["start"])}
    return s


# ---------- adding clips: insert, duplicate, paste, rearrange, speed ----------

def open_gap(project: dict, t: float, length: float, min_voice: float = 0.3) -> None:
    """Make `length` seconds of room at t on every unlocked track: clips there are cut at t and what
    follows moves later (a ripple insert). A sentence is never cut: one that has hardly started moves
    with what follows; one already under way ends at t."""
    t, length = r3(t), r3(length)
    for tr in project["timeline"]["tracks"]:
        if tr["locked"] or tr["id"] == "background":
            continue
        if tr["id"] == "voice":
            for s in tr["clips"]:
                if s["start"] >= t - EPS or (s["end"] > t + EPS and t - s["start"] < min_voice):
                    s["start"], s["end"] = r3(s["start"] + length), r3(s["end"] + length)
                elif s["end"] > t + EPS:
                    s["end"] = t
            continue
        whole = _lift_whole(tr)
        for c in [c for c in tr["clips"] if c["start"] + EPS < t < c["end"] - EPS]:
            split_at(project, c, t, minimum=2 * EPS)
        for c in tr["clips"]:
            if c["start"] >= t - EPS:
                c["start"], c["end"] = r3(c["start"] + length), r3(c["end"] + length)
        tr["clips"] += whole
    relink(project)
    sort(project)


def _voice_id(project: dict) -> str:
    """A new sentence id (as sentences.new_id)."""
    n = project.get("next_id", 1)
    taken = {s["id"] for s in clips(project, "voice")}
    while f"s{n}" in taken:
        n += 1
    project["next_id"] = n + 1
    return f"s{n}"


def _copy(project: dict, c: dict, tid: str, shift: float) -> dict:
    out = copy.deepcopy(c)
    out["id"] = _voice_id(project) if tid == "voice" else new_id(project, PREFIX[tid])
    out["start"], out["end"] = r3(c["start"] + shift), r3(c["end"] + shift)
    return out


def attached(project: dict, v: dict) -> list[tuple[str, dict]]:
    """The sentences and text that go with a video clip: those on unlocked tracks starting on it."""
    return [(tid, c) for tid in ("voice", "text") if editable(project, tid)
            for c in clips(project, tid) if v["start"] - EPS <= c["start"] < v["end"] - EPS]


def insert_media(project: dict, mid: str, at: float, seconds: float | None = None, min_voice: float = 0.3) -> dict:
    """Put a media file on the timeline at `at`. A video or picture goes on the video track and pushes
    what follows later (on every unlocked track); music and sound effects go on the audio track."""
    m = (project.get("media") or {}).get(mid)
    if not m or m.get("removed"):
        raise _error("That file isn't in this project any more.", "Add it again.", 404)
    at = r3(max(0.0, at))
    if m["kind"] == "audio":
        require(project, "audio")
        c = {"id": new_id(project, "a"), "type": "audio", "media": mid, "start": at, "end": r3(at + m["duration"]),
             "source_in": 0.0, "source_out": r3(m["duration"]), "volume": 100, "muted": False, "fade_in": 0.0, "fade_out": 0.0, "skipped": False}
        clips(project, "audio").append(c)
        sort(project)
        return c
    require(project, "video")
    length = r3(m["duration"] if m["kind"] == "video" else (seconds or 3.0))
    open_gap(project, at, length, min_voice)
    if m["kind"] == "video":
        c = video_clip(new_id(project, "v"), mid, at, 0.0, length)
    else:
        c = {"id": new_id(project, "v"), "type": "image", "media": mid, "start": at, "end": r3(at + length), "skipped": False}
    clips(project, "video").append(c)
    if m["kind"] == "video" and m.get("audio"):
        clips(project, "background").append(background_clip(new_id(project, "b"), c, 0.0, length))
    relink(project)
    sort(project)
    return c


def _video_group(project: dict, v: dict) -> list[tuple[str, dict]]:
    """A video clip with its sound pieces and the sentences and text that go with it."""
    pieces = [("background", b) for b in clips(project, "background") if b.get("link") == v["id"]]
    return [("video", v), *pieces, *attached(project, v)]


def _place(project: dict, group: list[tuple[str, dict]], shift: float, keep_ids: bool = False) -> list[dict]:
    """Put copies of a video group on the timeline, `shift` seconds later (pieces stay linked)."""
    made, ids = [], {}
    for tid, c in group:
        new = copy.deepcopy(c) if keep_ids else _copy(project, c, tid, 0.0)
        new["start"], new["end"] = r3(c["start"] + shift), r3(c["end"] + shift)
        ids[c["id"]] = new["id"]
        made.append((tid, new))
    for tid, new in made:
        if tid == "background":
            new["link"] = ids.get(new["link"], new["link"])
        clips(project, tid).append(new)
    relink(project)
    sort(project)
    return [c for _, c in made]


def duplicate(project: dict, ids: list[str], min_voice: float = 0.3) -> list[str]:
    """A copy of each clip right after it. A video clip's copy brings its sound, sentences and text,
    and pushes what follows later; a sentence's copy needs free time after it."""
    made = []
    targets = [(tr, c) for tr, c in (find(project, i) for i in ids) if c]
    for tr, c in sorted(targets, key=lambda x: x[1]["start"], reverse=True):
        require(project, tr["id"])
        length = c["end"] - c["start"]
        if tr["id"] == "video":
            group = _video_group(project, c)
            open_gap(project, c["end"], length, min_voice)
            made += [x["id"] for x in _place(project, group, length)]
        elif tr["id"] == "voice":
            if any(o is not c and c["end"] - EPS < o["end"] and o["start"] < c["end"] + length - EPS for o in tr["clips"]):
                raise _error("There's no room after this sentence for its copy.", "Make room first, or paste it somewhere else.", 409)
            copy_ = _copy(project, c, "voice", length)
            tr["clips"].append(copy_)
            made.append(copy_["id"])
        elif tr["id"] in ("text", "audio", "watermark"):
            copy_ = _copy(project, c, tr["id"], length)
            if tr["id"] == "watermark":
                c["whole"] = copy_["whole"] = False
            tr["clips"].append(copy_)
            made.append(copy_["id"])
    sort(project)
    return made


def move_video(project: dict, cid: str, to: float, insert: bool, min_voice: float = 0.3) -> dict:
    """Move a video clip, with its sound and the sentences and text on it, to start at `to`.
    insert: take it out (closing its gap) and put it in at `to` (pushing what's there later) —
    `to` is a time on the timeline as it is before the move. Otherwise it goes into empty space."""
    tr, v = find(project, cid)
    if not v or tr["id"] != "video":
        raise _error("That clip doesn't exist any more.", "Reload the page.", 404)
    require(project, "video")
    length = v["end"] - v["start"]
    to = r3(max(0.0, to))
    group = _video_group(project, v)
    if not insert:
        shift = to - v["start"]
        moving = {id(c) for _, c in group}
        if any(c is not v and c["start"] < to + length - EPS and c["end"] > to + EPS for c in tr["clips"]):
            raise _error("There's another clip there.", "Drop it on a clip's edge to put it in between, or into empty space.", 409)
        voice = [c for tid, c in group if tid == "voice"]
        for s in voice:
            if any(id(o) not in moving and o["start"] < s["end"] + shift - EPS and o["end"] > s["start"] + shift + EPS for o in clips(project, "voice")):
                raise _error("Its sentences would overlap the sentences there.", "Move it somewhere else, or lock the Khmer voice track.", 409)
        for tid, c in group:
            if tid != "background":
                c["start"], c["end"] = r3(c["start"] + shift), r3(c["end"] + shift)
        relink(project)
        sort(project)
        return v
    start, end = v["start"], v["end"]
    for tid, c in group:  # lift the group out…
        clips(project, tid).remove(c)
    remove_range(project, start, end, min_voice)  # …and close the gap it leaves
    if to >= end - EPS:
        to = r3(to - length)
    elif to > start:
        to = start
    open_gap(project, to, length, min_voice)
    _place(project, group, to - start, keep_ids=True)
    return v


def set_speed(project: dict, cid: str, value: float, min_voice: float = 0.3) -> dict:
    """Play a video clip faster or slower. It gets shorter or longer; its sentences and text keep their
    place in the picture. For everything else it is as if time were taken out (or put in) at the clip's
    end: what follows moves up (or later), and music running past that point is cut there (or split)."""
    tr, v = find(project, cid)
    if not v or v.get("type") != "video":
        raise _error("Only a video clip has a speed.")
    require(project, "video")
    value = round(min(4.0, max(0.25, value)), 3)
    old_end = v["end"]
    new_end = r3(v["start"] + (v["source_out"] - v["source_in"]) / value)
    ratio = v["speed"] / value
    group = _video_group(project, v)
    for tid, c in group:  # lift the clip and what's on it out while the rest of the timeline changes
        clips(project, tid).remove(c)
    if new_end < old_end:
        remove_range(project, new_end, old_end, min_voice)
    elif new_end > old_end:
        open_gap(project, old_end, new_end - old_end, min_voice)
    for tid, c in group:
        if tid in ("voice", "text"):
            c["start"] = r3(v["start"] + (c["start"] - v["start"]) * ratio)
            c["end"] = r3(v["start"] + (c["end"] - v["start"]) * ratio)
        clips(project, tid).append(c)
    v["speed"], v["end"] = value, new_end
    relink(project)
    sort(project)
    return v


PASTE_KEYS = {
    "video": ("type", "media", "start", "end", "source_in", "source_out", "speed", "skipped"),
    "background": ("media", "link", "start", "end", "source_in", "source_out", "volume", "muted", "keys", "fade_in", "fade_out", "keep_voice", "skipped"),
    "text": ("start", "end", "text", "style", "x", "y", "width", "align", "animation", "skipped"),
    "audio": ("media", "start", "end", "source_in", "source_out", "volume", "muted", "keys", "fade_in", "fade_out", "skipped"),
    "watermark": ("start", "end", "kind", "media", "anchor", "x", "y", "margin", "width", "height", "text", "font", "size", "color", "bold",
                  "opacity", "rotation", "effects", "animation", "tile", "hide_during", "safe_area", "remove_bg", "skipped"),
}


def paste(project: dict, items: list[dict], at: float, voice_keys: tuple[str, ...], min_voice: float = 0.3) -> dict:
    """Paste copied clips ({"track", "clip"}) at `at`, keeping their times relative to each other.
    Video clips push what follows later; sentences that would overlap others are left out."""
    items = [i for i in items if i.get("track") in (*PASTE_KEYS, "voice")]
    if not items:
        raise _error("There's nothing to paste.", "Copy a clip first (Ctrl+C).")
    media = project.get("media") or {}
    base = min(i["clip"]["start"] for i in items)
    videos = [i for i in items if i["track"] == "video"]
    for i in items:
        require(project, i["track"])
        if "media" in i["clip"] and i["clip"]["media"] not in media:
            raise _error("A copied clip's file isn't in this project.", "Copy and paste within the same project.")
    shift = r3(max(0.0, at) - base)
    if videos:
        span = max(i["clip"]["end"] for i in videos) - base
        open_gap(project, max(0.0, at), span, min_voice)
    group, left_out = [], 0
    for i in items:
        tid, src = i["track"], i["clip"]
        keys = voice_keys if tid == "voice" else PASTE_KEYS[tid]
        c = {k: copy.deepcopy(src[k]) for k in keys if k in src}
        c.setdefault("skipped", False)
        c["id"] = src.get("id", "x")
        if tid == "voice":
            c["type"] = "voice"
            start, end = c["start"] + shift, c["end"] + shift
            if any(o["start"] < end - EPS and o["end"] > start + EPS for o in clips(project, "voice")):
                left_out += 1
                continue
        if tid == "text":
            c["type"] = "text"
        if tid == "watermark":
            c["type"], c["whole"] = "watermark", False
        if tid in ("audio", "background"):
            c["type"] = "audio"
        group.append((tid, c))
    pieces_ok = {c["id"] for tid, c in group if tid == "video"}
    group = [(tid, c) for tid, c in group if tid != "background" or c.get("link") in pieces_ok]
    made = _place(project, group, shift)
    return {"ids": [c["id"] for c in made], "left_out": left_out}
