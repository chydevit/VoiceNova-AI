"""The editor: change sentences, voice only what changed, undo / redo.

Every change is one undo step (typing in one field is grouped). Voicing happens outside the
project lock, and a finished clip is only stored if the sentence still says the same thing.
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Annotated, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

import briefs
import config
import history
import jobs
import pipeline
import sentences
import store
import timeline
import watermarks
from api_projects import reply, restore_version
from errors import AppError, LineError
from services import clips, cover, fit, media, separate, translate, tts, voicecheck

router = APIRouter(prefix="/api/projects/{pid}")

LABELS = {
    "khmer_text": "Edit Khmer text", "subtitle_text": "Edit subtitle", "subtitle_synced": "Sync subtitle",
    "voice": "Change voice", "speed": "Change speed", "volume": "Change volume", "muted": "Mute", "start": "Change timing", "end": "Change timing",
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

Percent = Annotated[int, Field(ge=0, le=timeline.VOLUME_MAX, strict=True)]  # a volume: 0–200, 100 = as it is (whole numbers only)


class SentencePatch(BaseModel):
    khmer_text: str | None = Field(None, max_length=2000)
    subtitle_text: str | None = Field(None, max_length=2000)
    subtitle_synced: bool | None = None  # true: the subtitle follows the Khmer text again
    voice: str | None = None
    speed: float | None = Field(None, ge=config.MIN_SPEED, le=config.MAX_SPEED)
    volume: Percent | None = None
    muted: bool | None = None  # silent, keeping its volume for when it's unmuted
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
    volume: Percent | None = None
    ids: list[str] | None = None  # None = every sentence


@router.patch("/sentences")
def apply_to_all(pid: str, body: ApplyAllBody):
    fields = body.model_dump(exclude_unset=True, exclude={"ids"})
    label = "Apply to all" if body.ids is None else LABELS.get(next(iter(fields), ""), "Change sentences")
    project, count = _edit(pid, lambda p: sentences.apply_all(p, fields, body.ids, _voices()), label)
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
        dict(s) for s in sentences.items(project)
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
        for s in sentences.items(p):
            if s["id"] in wanted:
                s["status"] = "regenerating"

    store.mutate(pid, mark)
    errors: list[AppError] = []
    results: dict[str, dict] = {}

    def finish(p: dict) -> None:
        errors.extend(clips.apply(p, results))
        for s in sentences.items(p):
            if s["id"] in wanted and s["status"] == "regenerating":
                sentences.refresh(s)

    try:
        results = clips.ensure_many(store.project_dir(pid), targets, provider, force)
    finally:
        project = store.mutate(pid, finish)
    if errors and len(errors) == len(targets) and not isinstance(errors[0], LineError):
        raise errors[0]  # e.g. no internet: show it, not just a red mark on the line
    return reply(project, voiced=len(targets) - len(errors), failed=len(errors), **extra)


class BatchBody(BaseModel):
    kind: Literal["voice", "restyle", "fit"]  # voice again · translate again in a style, then voice · fit to their time
    ids: list[str] | None = None  # None: every sentence
    style: Literal["natural", "shorter", "formal", "casual"] | None = None  # for restyle
    force: bool = True  # voice: even if the same clip is cached


@router.post("/sentences/batch")
def batch(pid: str, body: BatchBody):
    """Many sentences at once, in the background (editing goes on): voice them, translate them again,
    or fit them to their time. Its progress is in project["batch"]."""
    project = store.load(pid)
    _check(project)
    if (project.get("batch") or {}).get("state") == "running":
        raise AppError("Sentences are already being worked on.", hint="Wait for that to finish, then try again.", status=409)
    items = sentences.items(project)
    known = {s["id"] for s in items}
    ids = [i for i in (body.ids if body.ids is not None else [s["id"] for s in items]) if i in known]
    if not any(s["khmer_text"] or body.kind == "restyle" for s in items if s["id"] in set(ids)):
        raise AppError("There are no sentences there.", hint="Choose a part of the timeline with sentences in it.")
    if body.kind == "restyle":
        if not body.style:
            raise AppError("Choose how to translate them.")
        if not translate.provider():
            raise AppError("No translation service is set up.", hint=translate.status()["reason"])
    _provider()  # say now if the voice isn't ready, not halfway through
    labels = {"voice": "Voicing", "restyle": "Translating again", "fit": "Fitting"}
    jobs.start_task(pid, "batch", lambda p, report: pipeline.batch_task(p, report, body.kind, ids, body.style, body.force),
                    kind=body.kind, label=labels[body.kind], count=len(ids), style=body.style)
    return reply(store.load(pid))


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
    for s in sentences.items(project):
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
        provider, index = _provider(), {s["id"]: i for i, s in enumerate(sentences.items(project))}

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
        for cur in sentences.items(p):
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
    return _regenerate(pid, sorted(wrong), True, checked=sum(1 for s in sentences.items(project) if sentences.has_clip(s)),
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


class SuggestBody(BaseModel):
    instruction: str = Field("", max_length=300)  # the editor's own wish for the line ("more polite", "use បង"…)


@router.post("/sentences/{sid}/suggest")
def suggest(pid: str, sid: str, body: SuggestBody | None = None):
    """Improve translation: three Khmer lines, written with four lines either side, the video's brief
    and the editor's own wish; plus the line as it was most likely said if it was misheard."""
    project = store.load(pid)
    i, s = sentences.find(project, sid)
    if not translate.provider():
        raise AppError("No translation service is set up.", hint=translate.status()["reason"])
    items = sentences.items(project)
    room = s["end"] - s["start"]

    def near(xs: list[dict]) -> list[dict]:
        return [{"original": x["original_text"], "khmer": x["khmer_text"]} for x in xs if x["original_text"] or x["khmer_text"]]

    result = translate.improve(
        s["original_text"] or s["khmer_text"], s["khmer_text"], room, before=near(items[max(0, i - 4):i]), after=near(items[i + 1:i + 5]),
        brief=briefs.get(pid, project), instruction=body.instruction if body else "", source_lang=pipeline.source_language(project),
    )
    if not result["options"]:
        raise AppError("The translator didn't suggest anything.", hint="Try again.")
    return {**result, "budget": sentences.budget(room)}


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
    voice: str | None = None  # None: the project's voice


@router.post("/sentences")
def add(pid: str, body: AddBody):
    if body.voice is not None and body.voice not in _voices():
        raise AppError(f"“{body.voice}” isn't a voice of the current voice engine.", hint=f"Use one of: {', '.join(_voices())}.")

    def apply(p: dict) -> dict:
        timeline.require(p, "voice")
        s = sentences.add(p, body.start, body.end, body.khmer_text, body.original_text)
        if body.voice:
            s["voice"] = body.voice
            sentences.refresh(s)
        return s

    project, s = _edit(pid, apply, "Add sentence")
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


class ExportSettings(BaseModel):
    """The exported picture (keep in sync with timeline.default_export): its size (the shorter side),
    its shape, how a picture of another shape fits it, and how much it is compressed."""
    resolution: Literal["original", "720p", "1080p"] = "original"
    aspect: Literal["original", "16:9", "9:16", "1:1"] = "original"
    fit: Literal["fit", "fill"] = "fit"
    quality: Literal["high", "medium", "small"] = "high"


class SettingsBody(BaseModel):
    export: ExportSettings | None = None
    background: Literal["replace", "separate", "duck"] | None = None
    background_volume: Percent | None = None  # the background track's volume (as PATCH /timeline/tracks/background)
    subtitle_style: SubtitleStyle | None = None
    cover: CoverSettings | None = None
    title: TitleSettings | None = None


@router.patch("/settings")
def settings(pid: str, body: SettingsBody):
    if body.background == "separate" and not separate.available():
        raise AppError("“Remove the original voice” needs Demucs, which isn't installed.", hint="Run: pip install -r requirements-extra.txt")

    def apply(p: dict) -> None:
        current = p["settings"]
        background = timeline.track(p, "background")
        if body.background and body.background != current["background"]:
            current["background"] = body.background
            if body.background_volume is None:  # each mode starts at its own level: the original quietly, the music fully
                background["volume"] = store.default_background_volume(body.background)
        if body.background_volume is not None:
            background["volume"] = body.background_volume
        if body.subtitle_style is not None:
            current["subtitle_style"] = body.subtitle_style.model_dump()
        if body.title is not None:
            current["title"] = body.title.model_dump()
        if body.cover is not None:
            current["cover"] = {k: round(v, 2) if isinstance(v, float) else v for k, v in body.cover.model_dump().items()}
        if body.export is not None:
            current["export"] = body.export.model_dump()

    label = ("Subtitle style" if body.subtitle_style is not None else "Title" if body.title is not None
             else "Cover original subtitles" if body.cover is not None else "Export settings" if body.export is not None else "Background settings")
    project, _ = _edit(pid, apply, label, group="settings")
    if project["settings"]["background"] == "separate":
        project = _start_separation(pid, project)
    return reply(project)


class DuckSettings(BaseModel):
    """Lower a track while the Khmer voice speaks (keep in sync with timeline.default_duck)."""
    on: bool = False
    level: Percent = 10  # its volume while the voice speaks
    fade: float = Field(0.3, ge=0.1, le=2)  # seconds to go down before the voice, and back up after it


class TrackPatch(BaseModel):
    locked: bool | None = None  # no edit changes a locked track
    muted: bool | None = None  # a sound track is silent (preview and export); its volume is kept
    hidden: bool | None = None  # the video or text track isn't drawn
    volume: Percent | None = None  # a sound track's volume
    duck: DuckSettings | None = None  # the background and music tracks: lower them while the voice speaks


TRACK_LABELS = {"locked": ("Lock track", "Unlock track"), "muted": ("Mute track", "Unmute track"), "hidden": ("Hide track", "Show track"),
                "volume": ("Change track volume",) * 2, "duck": ("Lower under the voice",) * 2}


@router.patch("/timeline/tracks/{tid}")
def patch_track(pid: str, tid: str, body: TrackPatch):
    fields = body.model_dump(exclude_unset=True)
    if tid not in timeline.TRACKS:
        raise AppError("That track doesn't exist.", status=404)
    if not fields:
        return reply(store.load(pid))
    if "volume" in fields and tid not in timeline.SOUND_TRACKS:
        raise AppError("Only the sound tracks have a volume.")
    if "duck" in fields and tid not in ("background", "audio"):
        raise AppError("Only the background and the music track can be lowered under the voice.")
    if "duck" in fields:
        fields["duck"] = {**fields["duck"], "fade": round(fields["duck"]["fade"], 2)}
    key, value = next(iter(fields.items()))
    # dragging a track's volume (or its ducking) is one undo step
    group = f"track:{tid}:{key}" if key in ("volume", "duck") else None
    project, _ = _edit(pid, lambda p: timeline.track(p, tid).update(fields), TRACK_LABELS[key][0 if value else 1], group)
    return reply(project)


# ---------- timeline edits: split, trim, delete, remove a part, skip, close a gap, clip settings ----------

Seconds = Annotated[float, Field(ge=0, le=24 * 3600)]


class SplitOp(BaseModel):
    op: Literal["split"]
    at: Seconds
    clips: list[str] | None = None  # None: the video clip at `at` (and its sound)
    indexes: dict[str, int] = {}  # where to split each sentence's Khmer text (from the browser's word breaks)


class TrimOp(BaseModel):
    op: Literal["trim"]
    clip: str
    side: Literal["start", "end"]
    to: Seconds


class DeleteOp(BaseModel):
    op: Literal["delete"]
    clips: list[str] = Field(min_length=1)
    ripple: bool = False  # close the gap: what follows moves up, on every unlocked track
    fill: Literal["silence", "original"] = "silence"  # a deleted sentence: silence, or the original audio


class RangeOp(BaseModel):
    op: Literal["remove_range", "skip_range", "unskip_range"]
    start: Seconds
    end: Seconds


class SkipOp(BaseModel):
    op: Literal["skip"]
    clips: list[str] = Field(min_length=1)
    skipped: bool = True


class GapOp(BaseModel):
    op: Literal["close_gap"]
    at: Seconds


Hex = Annotated[str, Field(pattern=r"^#[0-9a-fA-F]{6}$")]
Font = Literal["Kantumruy Pro", "Noto Sans Khmer", "Battambang", "Hanuman", "Koulen", "Moul"]
Animation = Literal["none", "fade", "pop", "slide"]


class TextStyle(BaseModel):
    """How a text clip looks (keep in sync with timeline.default_text_style)."""
    font: Font = "Kantumruy Pro"
    size: float = Field(8, ge=2, le=25)  # % of the picture's shorter side
    color: Hex = "#ffffff"
    bold: bool = True
    outline: bool = True
    outline_color: Hex = "#000000"
    outline_width: float = Field(18, ge=0, le=60)  # % of the text size
    box: bool = False
    box_color: Hex = "#000000"
    box_opacity: float = Field(0.6, ge=0, le=1)
    shadow: bool = True


class TextAnimation(BaseModel):
    model_config = {"populate_by_name": True}
    come: Animation = Field("none", alias="in")
    go: Animation = Field("none", alias="out")


class VolumeKey(BaseModel):
    """A point of a clip's volume line: `v` percent at `at` seconds in the clip's own sound."""
    at: float = Field(ge=0, le=24 * 3600)
    v: Percent


class ClipFields(BaseModel):
    volume: Percent | None = None
    muted: bool | None = None  # silent, keeping its volume
    keys: list[VolumeKey] | None = Field(None, max_length=1000)  # its volume line ([] removes it)
    fade_in: float | None = Field(None, ge=0, le=30)
    fade_out: float | None = Field(None, ge=0, le=30)
    keep_voice: bool | None = None
    skipped: bool | None = None
    text: str | None = Field(None, max_length=2000)  # text clips
    style: TextStyle | None = None
    x: float | None = Field(None, ge=0, le=100)  # where the text's middle is, % of the picture
    y: float | None = Field(None, ge=0, le=100)
    width: float | None = Field(None, ge=20, le=100)  # longest line before wrapping, % of the picture width
    align: Literal["left", "center", "right"] | None = None
    animation: TextAnimation | None = None

    def values(self) -> dict:
        out = self.model_dump(exclude_none=True, exclude={"style", "animation", "keys"})
        if self.keys is not None:
            out["keys"] = [k.model_dump() for k in self.keys]
        if self.style is not None:
            out["style"] = self.style.model_dump()
        if self.animation is not None:
            out["animation"] = {"in": self.animation.come, "out": self.animation.go}
        if "text" in out:
            out["text"] = "\n".join(" ".join(line.split()) for line in out["text"].strip().splitlines())
        return out


class SetOp(BaseModel):
    op: Literal["set"]
    clip: str
    fields: ClipFields


class AddWatermarkOp(BaseModel):
    op: Literal["add_watermark"]  # a watermark for the whole video, or for [start, end]
    fields: dict = Field(default_factory=dict)  # its settings (watermarks.clean checks them)
    start: Seconds | None = None
    end: Seconds | None = None


class SetWatermarkOp(BaseModel):
    op: Literal["set_watermark"]
    clip: str
    fields: dict  # only what changes (watermarks.clean checks them)


class AddTextOp(BaseModel):
    op: Literal["add_text"]
    at: Seconds
    text: str = Field("", max_length=2000)
    seconds: float = Field(3, gt=0, le=3600)


class MoveOp(BaseModel):
    op: Literal["move"]  # text and sound clips, earlier (by < 0) or later
    clips: list[str] = Field(min_length=1)
    by: float = Field(ge=-86400, le=86400)


class SubtitleTimingOp(BaseModel):
    op: Literal["subtitle_timing"]  # when a sentence's subtitle shows; both None: during the sentence
    clip: str
    start: Seconds | None = None
    end: Seconds | None = None


class InsertOp(BaseModel):
    op: Literal["insert"]  # a media file at `at`: video / picture push what follows later; sound goes on the music track
    media: str
    at: Seconds
    seconds: float | None = Field(None, gt=0, le=3600)  # how long a picture shows


class DuplicateOp(BaseModel):
    op: Literal["duplicate"]
    clips: list[str] = Field(min_length=1)


class PasteItem(BaseModel):
    track: Literal["video", "voice", "text", "background", "audio"]
    clip: dict


class PasteOp(BaseModel):
    op: Literal["paste"]
    items: list[PasteItem] = Field(min_length=1, max_length=2000)
    at: Seconds


class MoveVideoOp(BaseModel):
    op: Literal["move_video"]  # with its sound, sentences and text
    clip: str
    to: Seconds
    insert: bool = False  # True: put it in between at `to` (what's there moves later); False: into empty space


class SpeedOp(BaseModel):
    op: Literal["speed"]
    clip: str
    speed: float = Field(ge=0.25, le=4)


class BackgroundOp(BaseModel):
    op: Literal["background"]  # the background's volume between start and end (as "volume" on the background track)
    start: Seconds
    end: Seconds
    volume: Percent


class VolumeOp(BaseModel):
    op: Literal["volume"]  # one volume for a part of a sound track (its clips are split there; sentences are not)
    track: Literal["voice", "background", "audio"]
    start: Seconds
    end: Seconds
    volume: Percent


TimelineOp = Annotated[SplitOp | TrimOp | DeleteOp | RangeOp | SkipOp | GapOp | SetOp | AddWatermarkOp | SetWatermarkOp | BackgroundOp | VolumeOp | AddTextOp | MoveOp
                       | SubtitleTimingOp | InsertOp | DuplicateOp | PasteOp | MoveVideoOp | SpeedOp, Field(discriminator="op")]

# the fields of a sentence that a paste may bring (its clip is reused: same text, voice and speed)
VOICE_PASTE = ("start", "end", "original_text", "khmer_text", "subtitle_text", "subtitle_timing", "voice", "speed", "volume",
               "muted", "keys", "fade_in", "fade_out", "audio_file_path", "audio_key", "audio_duration", "shortened", "voice_warning", "skipped")


class TimelineEdit(BaseModel):
    edit: TimelineOp


@router.post("/timeline/edit")
def timeline_edit(pid: str, body: TimelineEdit):
    op = body.edit
    extra: dict = {}

    def apply(p: dict) -> None:
        if op.op == "split":
            extra["ids"] = _split(p, op)
        elif op.op == "trim":
            timeline.trim(p, op.clip, op.side, op.to)
        elif op.op == "delete":
            voice = [cid for cid in op.clips if (timeline.find(p, cid)[0] or {}).get("id") == "voice"]
            for sid in voice:
                timeline.require(p, "voice")
                sentences.remove(p, sid, op.fill)
            rest = [cid for cid in op.clips if cid not in voice]
            extra["deleted"] = len(voice) + (timeline.delete(p, rest, op.ripple, sentences.MIN_LENGTH) if rest else 0)
        elif op.op == "remove_range":
            _range(op)
            timeline.remove_range(p, op.start, op.end, sentences.MIN_LENGTH)
        elif op.op in ("skip_range", "unskip_range"):
            _range(op)
            extra["changed"] = timeline.skip_range(p, op.start, op.end, op.op == "skip_range")
        elif op.op == "skip":
            extra["changed"] = timeline.set_skipped(p, op.clips, op.skipped)
        elif op.op == "close_gap":
            extra["closed"] = timeline.close_gap(p, op.at, sentences.MIN_LENGTH)
        elif op.op in ("background", "volume"):
            _range(op)
            extra["changed"] = timeline.volume_range(p, getattr(op, "track", "background"), op.start, op.end, op.volume)
        elif op.op == "add_text":
            extra["id"] = timeline.add_text(p, op.at, op.text.strip(), op.seconds)["id"]
        elif op.op == "move":
            extra["moved"] = timeline.move(p, op.clips, op.by)
        elif op.op == "subtitle_timing":
            timeline.set_subtitle_timing(p, op.clip, op.start, op.end)
        elif op.op == "insert":
            extra["id"] = timeline.insert_media(p, op.media, op.at, op.seconds, sentences.MIN_LENGTH)["id"]
        elif op.op == "duplicate":
            extra["ids"] = timeline.duplicate(p, op.clips, sentences.MIN_LENGTH)
        elif op.op == "paste":
            extra.update(timeline.paste(p, [i.model_dump() for i in op.items], op.at, VOICE_PASTE, sentences.MIN_LENGTH))
        elif op.op == "move_video":
            timeline.move_video(p, op.clip, op.to, op.insert, sentences.MIN_LENGTH)
        elif op.op == "speed":
            timeline.set_speed(p, op.clip, op.speed, sentences.MIN_LENGTH)
        elif op.op == "add_watermark":
            extra["id"] = watermarks.new_clip(p, op.fields, op.start, op.end)["id"]
        elif op.op == "set_watermark":
            watermarks.set_props(p, op.clip, op.fields)
        else:
            timeline.set_props(p, op.clip, op.fields.values())
        sentences.refresh_all(p)

    label = LABEL_OF[op.op]
    if op.op == "delete" and op.ripple:
        label = "Ripple delete"
    elif op.op == "skip" and not op.skipped:
        label = "Bring back"
    elif op.op == "set" and len(op.fields.values()) == 1:
        (key, value), = op.fields.values().items()
        label = {"volume": "Change volume", "muted": "Mute clip" if value else "Unmute clip", "keys": "Change volume line",
                 "fade_in": "Change fade", "fade_out": "Change fade"}.get(key, label)
    # A burst of slider moves on one clip is one undo step.
    group = f"set:{op.clip}:{','.join(sorted(op.fields.values()))}" if op.op == "set" else None
    if op.op == "set_watermark":  # a slider drag on one watermark: one undo step
        group = f"watermark:{op.clip}:{','.join(sorted(op.fields))}"
    project, _ = _edit(pid, apply, label, group)
    return reply(project, **extra)


LABEL_OF = {
    "split": "Split clip", "trim": "Trim clip", "delete": "Delete clip", "remove_range": "Remove part", "skip_range": "Skip part",
    "unskip_range": "Bring back part", "skip": "Skip", "close_gap": "Close gap", "set": "Change clip", "background": "Change background volume",
    "volume": "Change volume", "add_watermark": "Add watermark", "set_watermark": "Change watermark",
    "add_text": "Add text", "move": "Move clip", "subtitle_timing": "Change subtitle timing",
    "insert": "Add clip", "duplicate": "Duplicate", "paste": "Paste", "move_video": "Move clip", "speed": "Change speed",
}


def _range(op) -> None:
    if op.end - op.start < timeline.MIN_CLIP:
        raise AppError("Choose a longer part first.", hint="Set the In point (I) and the Out point (O) at least a moment apart.")


def _split(p: dict, op: SplitOp) -> list[str]:
    """Split the chosen clips at op.at (sentences at a word, their Khmer text in two); returns the new ids."""
    targets = op.clips
    if targets is None:
        v = timeline.clip_at(p, "video", op.at)
        if not v:
            raise AppError("There's no video clip at the playhead.", hint="Move the playhead onto a clip, or select the clip to split.")
        targets = [v["id"]]
    made = []
    for cid in targets:
        tr, c = timeline.find(p, cid)
        if not c or not c["start"] < op.at < c["end"]:
            continue
        timeline.require(p, tr["id"])
        if tr["id"] == "voice":
            index = op.indexes.get(cid)
            if index is None:
                index = round(len(c["khmer_text"]) * (op.at - c["start"]) / (c["end"] - c["start"]))
            _, new = sentences.split(p, cid, index, op.at)
        else:
            new = timeline.split_at(p, c, op.at)
        if new:
            made.append(new["id"])
    if not made:
        raise AppError("Nothing to split here.", hint="Put the playhead inside the clip, a little away from its edges.")
    return made


@router.post("/cover/detect")
def detect_cover(pid: str):
    """Find the original video's burned-in subtitles (nothing is changed; the editor shows the result)."""
    project = store.load(pid)
    # the times people speak in the upload itself (the timeline may have moved or cut parts of it)
    spoken = []
    for s in sentences.items(project):
        at = timeline.source_time(project, s["start"])
        if at and at[0] == "source":
            spoken.append({"start": at[1], "end": at[1] + s["end"] - s["start"]})
    if not spoken:
        raise AppError("There are no sentences yet to compare with.", status=409)
    video = store.project_dir(pid) / project["video"]["file"]
    return cover.detect(video, project["video"], spoken)


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
