"""One sentence = one Khmer voice clip on the timeline. The rules for editing them live here
(pure data: no files, no network).

A sentence plays its clip from `start`; `end` is the end of its time slot. A clip longer than
its slot is cut there (status "too_long"). Sentences never overlap.
"""
import hashlib
import unicodedata

import config
from errors import AppError

MIN_LENGTH = 0.3  # shortest time slot, in seconds
TOO_LONG_TOLERANCE = 0.05  # a clip may overshoot its slot by this much before it counts as too long
KHMER_CHARS_PER_SECOND = 11  # keep in sync with services/translate.py
TEXT_FIELDS = ("khmer_text", "subtitle_text")
VOICE_FIELDS = ("khmer_text", "voice", "speed")  # changing these needs a new clip


def make(sid: str, start: float, end: float, original_text: str = "", khmer_text: str = "", voice: str = "female",
         speed: float = 1.0, volume: float = 1.0, **extra) -> dict:
    s = {
        "id": sid,
        "start": round(start, 3),
        "end": round(end, 3),
        "original_text": original_text,
        "khmer_text": clean(khmer_text),
        "subtitle_text": None,  # None = the subtitle shows khmer_text
        "voice": voice,
        "speed": round(speed, 2),
        "volume": round(volume, 2),
        "audio_file_path": None,
        "audio_key": None,
        "audio_duration": None,
        "status": "edited",  # ok | too_long | edited (needs a new clip) | regenerating | failed | empty
        "shortened": False,
        "error": None,
    }
    s.update(extra)
    refresh(s)
    return s


def clean(text: str) -> str:
    return " ".join(str(text or "").split())


def subtitle(s: dict) -> str:
    return s["khmer_text"] if s["subtitle_text"] is None else s["subtitle_text"]


def clip_key(s: dict) -> str:
    """Names the clip for this sentence's text, voice and speed. Same key → same clip file."""
    raw = f"{config.TTS_PROVIDER}|{s['voice']}|{s['speed']:.2f}|{s['khmer_text']}"
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:20]


def has_clip(s: dict) -> bool:
    """True when the stored clip matches the current text/voice/speed."""
    return bool(s["audio_file_path"]) and s["audio_key"] == clip_key(s)


def refresh(s: dict) -> dict:
    if not s["khmer_text"]:
        s["status"] = "empty"
    elif s.get("error"):
        s["status"] = "failed"
    elif not has_clip(s):
        s["status"] = "edited"
    elif s["audio_duration"] > s["end"] - s["start"] + TOO_LONG_TOLERANCE:
        s["status"] = "too_long"
    else:
        s["status"] = "ok"
    return s


def refresh_all(project: dict) -> None:
    for s in project["sentences"]:
        if s["status"] != "regenerating":
            refresh(s)


def sort(project: dict) -> None:
    project["sentences"].sort(key=lambda s: s["start"])


def find(project: dict, sid: str) -> tuple[int, dict]:
    for i, s in enumerate(project["sentences"]):
        if s["id"] == sid:
            return i, s
    raise AppError("That sentence doesn't exist any more.", hint="Reload the page.", status=404)


def room_end(project: dict, i: int) -> float:
    """Where the free time after sentence i ends: the next sentence's start, or the end of the video."""
    sents = project["sentences"]
    return sents[i + 1]["start"] if i + 1 < len(sents) else project["video"]["duration"]


def budget(seconds: float) -> int:
    return max(4, round(seconds * KHMER_CHARS_PER_SECOND))


# ---------- edits ----------

def patch(project: dict, sid: str, fields: dict, voices: tuple[str, ...]) -> dict:
    """Apply edited fields to one sentence."""
    _, s = find(project, sid)
    if "voice" in fields and fields["voice"] not in voices:
        raise AppError(f"“{fields['voice']}” isn't a voice of the current voice engine.", hint=f"Use one of: {', '.join(voices)}.")
    if "start" in fields or "end" in fields:
        start = fields.get("start", s["start"])
        end = fields.get("end", s["end"])
        if "start" in fields and "end" not in fields:  # moving the start keeps the length
            end = start + (s["end"] - s["start"])
        s["start"], s["end"] = check_timing(project, s, start, end)
    if "khmer_text" in fields:
        text = clean(fields["khmer_text"])
        if text != s["khmer_text"]:
            s["khmer_text"], s["shortened"] = text, False
    if "subtitle_synced" in fields and fields["subtitle_synced"]:
        s["subtitle_text"] = None
    elif "subtitle_text" in fields:
        s["subtitle_text"] = None if fields["subtitle_text"] is None else clean(fields["subtitle_text"])
    if "voice" in fields:
        s["voice"] = fields["voice"]
    if "speed" in fields:
        s["speed"] = round(min(config.MAX_SPEED, max(config.MIN_SPEED, fields["speed"])), 2)
    if "volume" in fields:
        s["volume"] = round(min(2.0, max(0.0, fields["volume"])), 2)
    if any(k in fields for k in VOICE_FIELDS):
        s["error"] = None
    return refresh(s)


def apply_all(project: dict, fields: dict, ids: list[str] | None, voices: tuple[str, ...]) -> int:
    """Set voice / speed / volume on many sentences at once. Returns how many changed."""
    wanted = {k: v for k, v in fields.items() if k in ("voice", "speed", "volume") and v is not None}
    targets = [s for s in project["sentences"] if ids is None or s["id"] in ids]
    for s in targets:
        patch(project, s["id"], wanted, voices)
    if ids is None:  # "apply to all" also becomes the default for new sentences
        project["settings"].update({k: v for k, v in wanted.items() if k in ("voice", "speed")})
    return len(targets)


def check_timing(project: dict, s: dict | None, start: float, end: float) -> tuple[float, float]:
    duration = project["video"]["duration"]
    start, end = round(max(0.0, start), 3), round(min(duration, end), 3)
    if end - start < MIN_LENGTH - 0.001:
        raise AppError(f"A sentence must be at least {MIN_LENGTH} seconds long.", hint="Make the time slot longer.")
    for other in project["sentences"]:
        if other is not s and start < other["end"] - 0.001 and end > other["start"] + 0.001:
            raise AppError(
                f"That would overlap the sentence at {_clock(other['start'])}.",
                hint="Move or shorten the neighbouring sentence first.", status=409,
            )
    return start, end


def split(project: dict, sid: str, index: int | None, at: float | None) -> tuple[dict, dict]:
    """Split one sentence into two at a character `index` of its Khmer text, the second starting at `at`."""
    i, s = find(project, sid)
    text = s["khmer_text"]
    if s["end"] - s["start"] < 2 * MIN_LENGTH:
        raise AppError("This sentence is too short to split.")
    if len(text) < 2:
        raise AppError("There isn't enough Khmer text to split.", hint="Type the text first, or use “Add sentence”.")
    index = safe_index(text, index if index is not None else len(text) // 2)
    first, second = text[:index].strip(), text[index:].strip()
    if not first or not second:
        raise AppError("Choose a split point inside the text.", hint="Click in the Khmer text where it should split, then press Split.")
    ratio = index / len(text)
    if at is None:
        at = s["start"] + (s["end"] - s["start"]) * ratio
    at = round(min(s["end"] - MIN_LENGTH, max(s["start"] + MIN_LENGTH, at)), 3)
    words = s["original_text"].split()
    cut = round(len(words) * ratio)
    sub_a = sub_b = None
    if s["subtitle_text"] is not None:  # an edited subtitle is split at the same proportion
        sub = s["subtitle_text"]
        k = safe_index(sub, round(len(sub) * ratio)) if len(sub) > 1 else len(sub)
        sub_a, sub_b = sub[:k].strip(), sub[k:].strip()
    new = make(
        new_id(project), at, s["end"], original_text=" ".join(words[cut:]), khmer_text=second,
        voice=s["voice"], speed=s["speed"], volume=s["volume"], subtitle_text=sub_b,
    )
    s.update(end=at, khmer_text=first, original_text=" ".join(words[:cut]), subtitle_text=sub_a, shortened=False, error=None)
    clear_audio(s)
    project["sentences"].insert(i + 1, new)
    return s, new


def merge(project: dict, sid: str) -> dict:
    """Join a sentence with the next one."""
    i, s = find(project, sid)
    if i + 1 >= len(project["sentences"]):
        raise AppError("This is the last sentence — there is nothing after it to merge with.")
    nxt = project["sentences"][i + 1]
    if s["subtitle_text"] is not None or nxt["subtitle_text"] is not None:
        s["subtitle_text"] = clean(f"{subtitle(s)} {subtitle(nxt)}")
    s.update(
        end=nxt["end"],
        khmer_text=clean(f"{s['khmer_text']} {nxt['khmer_text']}"),
        original_text=clean(f"{s['original_text']} {nxt['original_text']}"),
        shortened=False, error=None,
    )
    clear_audio(s)
    del project["sentences"][i + 1]
    return s


def add(project: dict, start: float, end: float | None, khmer_text: str, original_text: str) -> dict:
    """Add a sentence in free time on the timeline."""
    duration = project["video"]["duration"]
    start = round(max(0.0, min(start, duration - MIN_LENGTH)), 3)
    for other in project["sentences"]:
        if other["start"] - 0.001 < start < other["end"] - 0.001:
            raise AppError(
                f"There is already a sentence at {_clock(start)}.",
                hint="Pick a time in a gap between sentences, or split that sentence instead.", status=409,
            )
    free_until = min((o["start"] for o in project["sentences"] if o["start"] >= start), default=duration)
    if end is None:
        end = start + max(1.5, len(clean(khmer_text)) / KHMER_CHARS_PER_SECOND + 0.3)
    end = min(end, free_until)
    if end - start < MIN_LENGTH:
        raise AppError("There's no room for a new sentence here.", hint="Pick a time with at least a short pause before the next sentence.", status=409)
    settings = project["settings"]
    s = make(new_id(project), start, end, original_text=clean(original_text), khmer_text=khmer_text,
             voice=settings["voice"], speed=settings["speed"])
    check_timing(project, s, s["start"], s["end"])
    project["sentences"].append(s)
    sort(project)
    return s


def remove(project: dict, sid: str, fill: str) -> None:
    """Delete a sentence. fill="original" plays the original audio at full volume in its place."""
    i, s = find(project, sid)
    del project["sentences"][i]
    if fill == "original":
        gaps = sorted([*project["original_gaps"], {"start": s["start"], "end": s["end"]}], key=lambda g: g["start"])
        merged: list[dict] = []
        for g in gaps:
            if merged and g["start"] <= merged[-1]["end"] + 0.01:
                merged[-1]["end"] = max(merged[-1]["end"], g["end"])
            else:
                merged.append(dict(g))
        project["original_gaps"] = merged


def clear_audio(s: dict) -> None:
    s.update(audio_file_path=None, audio_key=None, audio_duration=None)
    refresh(s)


def new_id(project: dict) -> str:
    n = project.get("next_id", 1)
    taken = {s["id"] for s in project["sentences"]}
    while f"s{n}" in taken:
        n += 1
    project["next_id"] = n + 1
    return f"s{n}"


def safe_index(text: str, i: int) -> int:
    """Move a split point so it never lands inside a Khmer syllable (vowel signs, subscripts)."""
    i = max(1, min(len(text) - 1, i))

    def inside(k: int) -> bool:
        return unicodedata.category(text[k])[0] == "M" or text[k - 1] == "្"  # mark, or after COENG

    j = i
    while j < len(text) and inside(j):
        j += 1
    if j < len(text):
        return j
    while i > 1 and inside(i):
        i -= 1
    return i


def _clock(t: float) -> str:
    m, s = divmod(t, 60)
    return f"{int(m)}:{s:04.1f}"
