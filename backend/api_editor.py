"""The editor: change sentences, voice only what changed, undo / redo.

Every change is one undo step (typing in one field is grouped). Voicing happens outside the
project lock, and a finished clip is only stored if the sentence still says the same thing.
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

import config
import history
import jobs
import pipeline
import sentences
import store
from api_projects import reply, restore_version
from errors import AppError, LineError
from services import clips, cover, fit, media, separate, translate, tts, voicecheck

router = APIRouter(prefix="/api/projects/{pid}")
MIN_CUT = 0.05  # seconds; shorter background cuts are dropped

LABELS = {
    "khmer_text": "Edit Khmer text", "subtitle_text": "Edit subtitle", "subtitle_synced": "Sync subtitle",
    "voice": "Change voice", "speed": "Change speed", "volume": "Change volume", "start": "Change timing", "end": "Change timing",
}


def _check(project: dict) -> None:
    if project["status"] in store.BUSY:
        raise AppError("Please wait — this video is still being processed.", hint="Editing is paused until it finishes.", status=409)


def _edit(pid: str, fn, label: str, group: str | None = None):
    def guarded(p: dict):
        _check(p)
        return fn(p)

    return store.edit(pid, guarded, label, group)


def _voices() -> tuple[str, ...]:
    return tts.get().genders


def _provider():
    provider = tts.get()
    ok, reason = provider.status()
    if not ok:
        raise AppError(f"The {provider.label} voice isn't ready.", hint=reason)
    return provider


# ---------- one sentence ----------

class SentencePatch(BaseModel):
    khmer_text: str | None = Field(None, max_length=2000)
    subtitle_text: str | None = Field(None, max_length=2000)
    subtitle_synced: bool | None = None  # true: the subtitle follows the Khmer text again
    voice: str | None = None
    speed: float | None = Field(None, ge=config.MIN_SPEED, le=config.MAX_SPEED)
    volume: float | None = Field(None, ge=0, le=2)
    start: float | None = Field(None, ge=0)
    end: float | None = Field(None, ge=0)


@router.patch("/sentences/{sid}")
def patch_sentence(pid: str, sid: str, body: SentencePatch):
    fields = body.model_dump(exclude_unset=True)
    if not fields:
        return reply(store.load(pid))
    timing = "start" in fields or "end" in fields
    group = None if timing else f"{sid}:{','.join(sorted(fields))}"  # typing / slider drags = one undo step
    project, _ = _edit(pid, lambda p: sentences.patch(p, sid, fields, _voices()), LABELS[next(iter(fields))], group)
    return reply(project)


class ApplyAllBody(BaseModel):
    voice: str | None = None
    speed: float | None = Field(None, ge=config.MIN_SPEED, le=config.MAX_SPEED)
    volume: float | None = Field(None, ge=0, le=2)
    ids: list[str] | None = None  # None = every sentence


@router.patch("/sentences")
def apply_to_all(pid: str, body: ApplyAllBody):
    fields = body.model_dump(exclude_unset=True, exclude={"ids"})
    project, count = _edit(pid, lambda p: sentences.apply_all(p, fields, body.ids, _voices()), "Apply to all")
    return reply(project, changed=count)


class RegenerateBody(BaseModel):
    force: bool = False  # voice it again even if the same clip is cached
    ids: list[str] | None = None  # for /sentences/regenerate: None = every sentence that needs a voice


@router.post("/sentences/{sid}/regenerate")
def regenerate_one(pid: str, sid: str, body: RegenerateBody | None = None):
    return _regenerate(pid, [sid], body.force if body else False)


@router.post("/sentences/regenerate")
def regenerate_many(pid: str, body: RegenerateBody):
    return _regenerate(pid, body.ids, body.force)


def _regenerate(pid: str, ids: list[str] | None, force: bool | set[str], **extra) -> dict:
    project = store.load(pid)
    _check(project)
    targets = [
        dict(s) for s in project["sentences"]
        if s["khmer_text"] and (s["id"] in ids if ids is not None else not sentences.has_clip(s) or s["error"])
    ]
    if not targets:
        if ids and len(ids) == 1:
            sentences.find(project, ids[0])
            raise AppError("This sentence has no Khmer text to voice.", hint="Type the Khmer text first.")
        return reply(project, voiced=0, **extra)
    provider = _provider()
    wanted = {s["id"] for s in targets}

    def mark(p: dict) -> None:
        for s in p["sentences"]:
            if s["id"] in wanted:
                s["status"] = "regenerating"

    store.mutate(pid, mark)
    errors: list[AppError] = []
    results: dict[str, dict] = {}

    def finish(p: dict) -> None:
        errors.extend(clips.apply(p, results))
        for s in p["sentences"]:
            if s["id"] in wanted and s["status"] == "regenerating":
                sentences.refresh(s)

    try:
        results = clips.ensure_many(store.project_dir(pid), targets, provider, force)
    finally:
        project = store.mutate(pid, finish)
    if errors and len(errors) == len(targets) and not isinstance(errors[0], LineError):
        raise errors[0]  # e.g. no internet: show it, not just a red mark on the line
    return reply(project, voiced=len(targets) - len(errors), failed=len(errors), **extra)


@router.post("/sentences/check-voices")
def check_voices(pid: str):
    """“Check voices”: find the clips that came out wrong (also ones made before clips were checked)
    and voice them again; lines with words in other letters, which the voice skips, are written in
    Khmer first when a translator is set up. One undo step for the rewritten lines."""
    project = store.load(pid)
    _check(project)
    folder = store.project_dir(pid)
    wrong: set[str] = set()
    foreign: list[dict] = []
    for s in project["sentences"]:
        if not sentences.has_clip(s):
            continue
        if voicecheck.unreadable(s["khmer_text"]):
            foreign.append(s)
        elif s.get("voice_warning") or voicecheck.problem(media.read_wav(folder / s["audio_file_path"]), s["khmer_text"], s["speed"]):
            wrong.add(s["id"])
    rewritten: dict[str, dict] = {}  # id -> the changed fields: Khmer letters only, voiced and fitted to its time
    if foreign and translate.provider():
        lines = [{"id": s["id"], "text": s["original_text"], "room": s["end"] - s["start"], "khmer": s["khmer_text"]} for s in foreign]
        texts = translate.retranslate(lines, pipeline.source_language(project))
        provider, index = _provider(), {s["id"]: i for i, s in enumerate(project["sentences"])}

        def voice(s: dict) -> dict:
            draft = {**s, "khmer_text": sentences.clean(texts[s["id"]]), "shortened": False}
            changes, _ = fit.fit(folder, draft, sentences.room_end(project, index[s["id"]]), provider, translate.shorten)
            return {"khmer_text": draft["khmer_text"], "shortened": False, **changes}

        with ThreadPoolExecutor(max_workers=max(1, config.TTS_WORKERS)) as pool:
            futures = {pool.submit(voice, s): s for s in foreign if texts.get(s["id"])}
            for future in as_completed(futures):
                try:
                    rewritten[futures[future]["id"]] = future.result()
                except AppError:
                    pass  # keeps its text and gets the warning below

    before = {s["id"]: s for s in foreign}

    def apply(p: dict) -> None:
        for cur in p["sentences"]:
            old = before.get(cur["id"])
            if not old or any(cur[k] != old[k] for k in ("khmer_text", "voice", "speed", "start", "end")):
                continue  # not a line with other letters, or edited meanwhile
            if cur["id"] in rewritten:
                cur.update(rewritten[cur["id"]])
            else:
                cur["voice_warning"] = clips.text_warning(cur["khmer_text"])  # clips made before the check have none
            sentences.refresh(cur)

    if foreign:
        _edit(pid, apply, "Write words in other letters in Khmer" if rewritten else "Check voices")
    return _regenerate(pid, sorted(wrong), True, checked=sum(1 for s in project["sentences"] if sentences.has_clip(s)),
                       wrong=len(wrong) + len(foreign), rewritten=len(rewritten))


@router.post("/sentences/{sid}/fix")
def fix_sentence(pid: str, sid: str):
    project = store.load(pid)
    _check(project)
    i, s = sentences.find(project, sid)
    if not s["khmer_text"]:
        raise AppError("This sentence has no Khmer text yet.")
    ready = translate.provider()
    changes, notes = fit.fit(store.project_dir(pid), s, sentences.room_end(project, i), _provider(),
                             translate.shorten if ready else None, translate.respeller(pipeline.source_language(project)) if ready else None, force=bool(s.get("voice_warning")))

    def apply(p: dict) -> None:
        _, cur = sentences.find(p, sid)
        if any(cur[k] != s[k] for k in ("khmer_text", "voice", "speed", "start", "end")):
            raise AppError("This sentence changed while it was being fixed.", hint="Press “Fix automatically” again.", status=409)
        cur.update(changes)
        sentences.refresh(cur)

    project, _ = _edit(pid, apply, "Fix automatically")
    note = ("Fixed: " + ", ".join(notes) + ".") if notes else "It already fits."
    return reply(project, note=note)


@router.post("/sentences/{sid}/suggest")
def suggest(pid: str, sid: str):
    project = store.load(pid)
    i, s = sentences.find(project, sid)
    if not translate.provider():
        raise AppError("No translation service is set up.", hint=translate.status()["reason"])
    items = project["sentences"]
    room = s["end"] - s["start"]
    options = translate.suggest(
        s["original_text"] or s["khmer_text"], s["khmer_text"], room,
        before=[x["khmer_text"] for x in items[max(0, i - 2):i] if x["khmer_text"]],
        after=[x["khmer_text"] for x in items[i + 1:i + 3] if x["khmer_text"]],
    )
    if not options:
        raise AppError("The translator didn't suggest anything.", hint="Try again.")
    return {"options": options, "budget": sentences.budget(room)}


# ---------- structure ----------

class SplitBody(BaseModel):
    index: int | None = Field(None, ge=0)  # character position in the Khmer text
    at: float | None = Field(None, ge=0)  # where the second half starts, in seconds


@router.post("/sentences/{sid}/split")
def split(pid: str, sid: str, body: SplitBody | None = None):
    body = body or SplitBody()
    project, (_, second) = _edit(pid, lambda p: sentences.split(p, sid, body.index, body.at), "Split sentence")
    return reply(project, id=second["id"])


@router.post("/sentences/{sid}/merge")
def merge(pid: str, sid: str):
    project, _ = _edit(pid, lambda p: sentences.merge(p, sid), "Merge sentences")
    return reply(project)


class AddBody(BaseModel):
    start: float = Field(ge=0)
    end: float | None = Field(None, ge=0)
    khmer_text: str = Field("", max_length=2000)
    original_text: str = Field("", max_length=2000)


@router.post("/sentences")
def add(pid: str, body: AddBody):
    project, s = _edit(pid, lambda p: sentences.add(p, body.start, body.end, body.khmer_text, body.original_text), "Add sentence")
    return reply(project, id=s["id"])


@router.delete("/sentences/{sid}")
def delete(pid: str, sid: str, fill: Literal["silence", "original"] = "silence"):
    project, _ = _edit(pid, lambda p: sentences.remove(p, sid, fill), "Delete sentence")
    return reply(project)


# ---------- whole project ----------

class SubtitleStyle(BaseModel):
    size: float = Field(5.5, ge=3, le=10)  # text height, % of the picture's shorter side
    color: str = Field("#ffffff", pattern=r"^#[0-9a-fA-F]{6}$")
    outline: bool = True
    box: bool = False  # dark box behind the text
    position: Literal["bottom", "top"] = "bottom"
    margin: float = Field(7, ge=0, le=95)  # distance from that edge, % of the picture height
    bilingual: bool = False  # also show the original text, smaller, under the Khmer
    x: float = Field(50, ge=0, le=100)  # where the text sits across the picture, % of its width
    align: Literal["left", "center", "right"] = "center"  # which side of the text sits at x
    width: float = Field(90, ge=20, le=100)  # longest line before wrapping, % of the picture width
    font: Literal["Kantumruy Pro", "Noto Sans Khmer", "Battambang", "Hanuman", "Koulen", "Moul"] = "Kantumruy Pro"
    bold: bool = True
    outline_color: str = Field("#000000", pattern=r"^#[0-9a-fA-F]{6}$")
    outline_width: float = Field(20, ge=0, le=60)  # % of the text height
    box_color: str = Field("#000000", pattern=r"^#[0-9a-fA-F]{6}$")
    box_opacity: float = Field(0.6, ge=0, le=1)
    shadow: bool = False


class CoverSettings(BaseModel):
    """Cover the original video's burned-in subtitles. Position and size in % of the picture."""
    enabled: bool = False
    mode: Literal["blur", "box"] = "blur"
    x: float = Field(0, ge=0, le=100)
    y: float = Field(76, ge=0, le=100)
    w: float = Field(100, gt=0, le=100)
    h: float = Field(12, gt=0, le=100)


class TitleSettings(BaseModel):
    """Text at the top of the video for its whole length (keep in sync with store.default_title)."""
    text: str = Field("", max_length=300)
    size: float = Field(7, ge=3, le=14)  # text height, % of the picture's shorter side
    color: str = Field("#fde047", pattern=r"^#[0-9a-fA-F]{6}$")
    margin: float = Field(5, ge=0, le=60)  # distance from the top, % of the picture height
    outline: bool = True
    box: bool = False


class SettingsBody(BaseModel):
    background: Literal["replace", "separate", "duck"] | None = None
    background_volume: float | None = Field(None, ge=0, le=1)
    subtitle_style: SubtitleStyle | None = None
    cover: CoverSettings | None = None
    title: TitleSettings | None = None


@router.patch("/settings")
def settings(pid: str, body: SettingsBody):
    if body.background == "separate" and not separate.available():
        raise AppError("“Remove the original voice” needs Demucs, which isn't installed.", hint="Run: pip install -r requirements-extra.txt")

    def apply(p: dict) -> None:
        current = p["settings"]
        if body.background and body.background != current["background"]:
            current["background"] = body.background
            if body.background_volume is None:
                current["background_volume"] = store.default_background_volume(body.background)
        if body.background_volume is not None:
            current["background_volume"] = round(body.background_volume, 2)
        if body.subtitle_style is not None:
            current["subtitle_style"] = body.subtitle_style.model_dump()
        if body.title is not None:
            current["title"] = body.title.model_dump()
        if body.cover is not None:
            current["cover"] = {k: round(v, 2) if isinstance(v, float) else v for k, v in body.cover.model_dump().items()}

    label = ("Subtitle style" if body.subtitle_style is not None else "Title" if body.title is not None
             else "Cover original subtitles" if body.cover is not None else "Background settings")
    project, _ = _edit(pid, apply, label, group="settings")
    if project["settings"]["background"] == "separate":
        project = _start_separation(pid, project)
    return reply(project)


class Cut(BaseModel):
    start: float = Field(ge=0)
    end: float = Field(ge=0)
    gain: float = Field(0, ge=0, le=2)  # background only: 0 = silent, 0.5 = half, 1.5 = louder
    fade: float = Field(0.05, ge=0, le=5)  # background only: seconds to ramp in and out


class CutsBody(BaseModel):
    cuts: list[Cut] = Field(max_length=500)


@router.put("/background/cuts")
def background_cuts(pid: str, body: CutsBody):
    """Parts of the background (original audio or music) played at another volume — 0 is silent."""
    current = store.load(pid)
    duration = current["video"]["duration"]
    parts = sentences.layer_ranges([
        {"start": round(c.start, 3), "end": round(min(c.end, duration), 3), "gain": round(c.gain, 2), "fade": round(c.fade, 2)}
        for c in body.cuts if min(c.end, duration) - c.start >= MIN_CUT
    ])
    before = current["settings"].get("background_cuts", [])
    label = "Change background volume" if len(parts) >= len(before) else "Restore background"
    project, _ = _edit(pid, lambda p: p["settings"].update(background_cuts=parts), label)
    return reply(project)


@router.put("/video/cuts")
def video_cuts(pid: str, body: CutsBody):
    """The parts removed from the video: the export leaves them out and moves what follows up."""
    def check(cuts: list[dict], duration: float) -> None:
        if sum(b - a for a, b in sentences.kept_ranges(cuts, duration)) < 0.5:
            raise AppError("That would remove the whole video.", hint="Remove a smaller part.")

    return _set_cuts(pid, "video_cuts", body, ("Remove part of the video", "Put back part of the video", "Move video cut"), check)


def _set_cuts(pid: str, key: str, body: CutsBody, labels: tuple[str, str, str], check=None) -> dict:
    current = store.load(pid)
    duration = current["video"]["duration"]
    cuts = sentences.merge_ranges([
        {"start": round(c.start, 3), "end": round(min(c.end, duration), 3)} for c in body.cuts if min(c.end, duration) - c.start >= MIN_CUT
    ])
    if check:
        check(cuts, duration)
    length = lambda xs: sum(c["end"] - c["start"] for c in xs)  # noqa: E731
    change = length(cuts) - length(current["settings"].get(key, []))
    label = labels[0] if change > 0.001 else labels[1] if change < -0.001 else labels[2]
    project, _ = _edit(pid, lambda p: p["settings"].update({key: cuts}), label)
    return reply(project)


@router.post("/cover/detect")
def detect_cover(pid: str):
    """Find the original video's burned-in subtitles (nothing is changed; the editor shows the result)."""
    project = store.load(pid)
    if not project["sentences"]:
        raise AppError("There are no sentences yet to compare with.", status=409)
    video = store.project_dir(pid) / project["video"]["file"]
    return cover.detect(video, project["video"], project["sentences"])


@router.post("/separate")
def separate_voice(pid: str):
    """Remove the original voice now (also used to try again after a failure)."""
    if not separate.available():
        raise AppError("“Remove the original voice” needs Demucs, which isn't installed.", hint="Run: pip install -r requirements-extra.txt")
    return reply(_start_separation(pid, store.load(pid)))


def _start_separation(pid: str, project: dict) -> dict:
    """Start making the voice-free background track, unless it exists or is being made."""
    done = (store.project_dir(pid) / pipeline.BACKGROUND_TRACK).exists()
    running = (project.get("separation") or {}).get("state") == "running"
    if done or running:
        return project
    jobs.start_task(pid, "separation", pipeline.separate_task)
    return store.load(pid)


@router.post("/undo")
def undo(pid: str):
    return _step(pid, "undo")


@router.post("/redo")
def redo(pid: str):
    return _step(pid, "redo")


def _step(pid: str, direction: str) -> dict:
    with store._lock:  # noqa: SLF001 - undo must read and write the project in one go
        project = store.load(pid)
        _check(project)
        label = history.step(store.project_dir(pid), project, direction)
        if label is None:
            return reply(project, label=None)
        sentences.refresh_all(project)
        store.save(project)
    return reply(project, label=label)


@router.post("/versions/{n}/restore")
def restore(pid: str, n: int):
    return reply(restore_version(pid, n))
