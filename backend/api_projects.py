"""Projects: upload, list, open, generate, export, versions, and the files the editor shows."""
import json
import re
import threading
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, File, Form, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

import config
import history
import jobs
import pipeline
import sentences
import store
import timeline
import watermarks
import views
from errors import AppError
from services import media, separate, tts

router = APIRouter(prefix="/api/projects")
_media_locks: dict[str, threading.Lock] = {}
_media_guard = threading.Lock()


def reply(project: dict, **extra) -> dict:
    return {"project": views.public(project), **extra}


@router.get("")
def list_projects():
    return {"projects": [views.summary(p) for p in store.list_projects()]}


@router.post("")
async def upload(file: UploadFile = File(...), source_lang: str = Form("auto"), watermark_preset: str = Form("")):
    media.require_ffmpeg()
    name = Path(file.filename or "video").name
    ext = Path(name).suffix.lower()
    if ext not in config.ALLOWED_EXTENSIONS:
        raise AppError(f"“{ext or name}” files aren't supported.", hint="Upload an MP4, MOV, MKV or WebM video.")
    preset = watermarks.preset_for_new_project(watermark_preset.strip() or None)  # (checked before anything is kept)
    project = store.create(name)
    pid = project["id"]
    target = store.project_dir(pid) / f"source{ext}"
    limit = config.MAX_UPLOAD_MB * 1024 * 1024
    written = 0
    try:
        with target.open("wb") as f:
            while chunk := await file.read(1024 * 1024):
                written += len(chunk)
                if written > limit:
                    raise AppError(f"This video is larger than {config.MAX_UPLOAD_MB} MB.", hint="Trim or compress it, then upload again.", status=413)
                f.write(chunk)
        if not written:
            raise AppError("The uploaded file is empty.", hint="Choose the video again.")
        info = media.probe(target)
    except Exception:
        store.delete(pid)
        raise
    def setup(p: dict) -> None:
        p.update(video={"file": target.name, **info}, source_lang=(source_lang or "auto").strip() or "auto")
        timeline.init(p, p["video"], name)  # the edit list starts as the whole upload
        if preset:  # the watermark preset chosen for it, or the default one for new projects
            try:
                watermarks.apply_preset(p, store.project_dir(pid), preset)
            except AppError:
                pass  # (a logo deleted from the Brand Kit since: the video still comes in)

    project = store.mutate(pid, setup)
    jobs.start(pid, "prepare", pipeline.prepare, busy_status="processing", done_status="review")
    pipeline.ensure_proxies(pid, project)
    return reply(store.load(pid))


@router.get("/{pid}")
def get_project(pid: str):
    project = store.load(pid)
    pipeline.ensure_proxies(pid, project)  # projects made before preview copies existed get theirs now
    return reply(project)


@router.delete("/{pid}")
def delete_project(pid: str):
    project = store.load(pid)
    if project["status"] in store.BUSY:
        raise AppError("This video is still being processed.", hint="Wait for it to finish, then delete it.", status=409)
    store.delete(pid)
    return {"ok": True}


# ---------- the first "Generate Voice" (from the review page) ----------

class SubtitleLayout(BaseModel):
    """The strip of the picture the subtitle images cover (every image has this size)."""
    y: int = Field(ge=0)
    width: int = Field(gt=0)
    height: int = Field(gt=0)


class TitleImage(BaseModel):
    """The title drawn by the browser: a PNG strip of the picture, placed at y."""
    data: str = Field(pattern=r"^data:image/png;base64,", max_length=20_000_000)
    y: int = Field(ge=0)
    width: int = Field(gt=0)
    height: int = Field(gt=0)


class TextImage(BaseModel):
    """One text clip drawn by the browser: a PNG of just the text, with its place on the canvas."""
    data: str = Field(pattern=r"^data:image/png;base64,", max_length=20_000_000)
    x: float
    y: float
    width: int = Field(gt=0)
    height: int = Field(gt=0)


class Point(BaseModel):
    x: float
    y: float


class WatermarkImage(TextImage):
    """One watermark drawn by the browser at the exported size (its look, opacity and rotation in it),
    where it goes, and for a corner switch where it goes at each corner (top-left, top-right,
    bottom-right, bottom-left)."""
    corners: list[Point] | None = Field(None, min_length=4, max_length=4)


class TextEdit(BaseModel):
    id: str
    khmer_text: str = Field(max_length=2000)


class GenerateBody(BaseModel):
    voice: str = "female"
    speed: float = Field(1.0, ge=config.MIN_SPEED, le=config.MAX_SPEED)
    background: Literal["replace", "separate", "duck"] = "duck"
    burn_subtitles: bool = False
    sentences: list[TextEdit] | None = None  # unsaved edits, applied first
    subtitle_images: dict[str, str] | None = None  # sentence id -> PNG data URL, drawn by the browser
    subtitle_layout: SubtitleLayout | None = None


@router.post("/{pid}/generate")
def generate(pid: str, body: GenerateBody):
    provider = tts.get()
    voice = body.voice if body.voice in provider.genders else provider.genders[0]
    if body.background == "separate" and not separate.available():
        raise AppError("“Remove the original voice” needs Demucs, which isn't installed.", hint="Run: pip install -r requirements-extra.txt — or pick another background option.")
    if body.burn_subtitles and not body.subtitle_images:
        raise AppError("The subtitle images are missing.", hint="Reload the page and try again.")

    def start(p: dict) -> None:
        if p["status"] in store.BUSY:
            raise AppError("Please wait — this video is still being processed.", status=409)
        items = sentences.items(p)
        if not items:
            raise AppError("There are no sentences yet.", hint="Press “Try again” to transcribe the video.", status=409)
        for edit in body.sentences or []:
            if any(s["id"] == edit.id for s in items):
                sentences.patch(p, edit.id, {"khmer_text": edit.khmer_text}, provider.genders)
        if not any(s["khmer_text"] for s in items):
            raise AppError("All the Khmer lines are empty.", hint="Type the Khmer translation, then generate.")
        p["settings"] = store.default_settings(voice, round(body.speed, 2), body.background)
        timeline.track(p, "background")["volume"] = store.default_background_volume(body.background)
        for s in items:
            sentences.patch(p, s["id"], {"voice": voice, "speed": body.speed}, provider.genders)

    store.edit(pid, start, "Generate voice")
    formats = ["mp4_subs" if body.burn_subtitles else "mp4", "srt"]
    store.update(pid, export_prefs={"formats": formats, "audio_format": "mp3"})
    pipeline.write_request(pid, formats, "mp3", body.subtitle_images, body.subtitle_layout)
    jobs.start(pid, "generate", pipeline.generate, busy_status="generating", done_status="done")
    return reply(store.load(pid))


# ---------- export from the editor ----------

class ExportBody(BaseModel):
    formats: list[Literal["mp4", "mp4_subs", "srt", "audio"]] = Field(min_length=1)
    audio_format: Literal["mp3", "wav"] = "mp3"
    subtitle_images: dict[str, str] | None = None
    subtitle_layout: SubtitleLayout | None = None
    title_image: TitleImage | None = None  # the title at the top, burned into both videos
    text_images: dict[str, TextImage] | None = None  # text clip id -> its picture, for both videos
    watermark_images: dict[str, WatermarkImage] | None = None  # watermark id -> its picture, for both videos
    watermark: bool = True  # false: export without the watermarks


@router.post("/{pid}/export")
def export(pid: str, body: ExportBody):
    project = store.load(pid)
    if project["status"] in store.BUSY:
        raise AppError("Please wait — this video is still being processed.", status=409)
    if not any(s["khmer_text"] for s in sentences.items(project)):
        raise AppError("All the Khmer lines are empty.", hint="Type the Khmer text of at least one sentence.")
    if "mp4_subs" in body.formats and not body.subtitle_images:
        raise AppError("The subtitle images are missing.", hint="Reload the page and try again.")
    if project["settings"]["background"] == "separate" and not separate.available() and {"mp4", "mp4_subs"} & set(body.formats):
        raise AppError("“Remove the original voice” needs Demucs, which isn't installed.", hint="Pick another background in Project settings.")
    store.update(pid, export_prefs={"formats": body.formats, "audio_format": body.audio_format, "watermark": body.watermark})
    pipeline.write_request(pid, body.formats, body.audio_format, body.subtitle_images, body.subtitle_layout, body.title_image, body.text_images,
                           body.watermark_images if body.watermark else None, body.watermark)
    jobs.start(pid, "export", pipeline.export, busy_status="exporting", done_status="done")
    return reply(store.load(pid))


@router.post("/{pid}/retry")
def retry(pid: str):
    project = store.load(pid)
    if project["status"] != "error":
        return reply(project)
    if project["phase"] == "prepare" or not sentences.items(project):
        jobs.start(pid, "prepare", pipeline.prepare, busy_status="processing", done_status="review")
    elif project["phase"] == "export":  # back to the editor; the user exports again
        store.update(pid, status="done", error=None)
    else:  # the first voice generation failed: back to the review page
        store.update(pid, status="review", error=None)
    return reply(store.load(pid))


# ---------- files ----------

MEDIA_TYPES = {".mp4": "video/mp4", ".srt": "application/x-subrip", ".mp3": "audio/mpeg", ".wav": "audio/wav"}


@router.get("/{pid}/versions/{n}/{kind}")
def version_file(pid: str, n: int, kind: str, download: int = 0):
    project = store.load(pid)
    version = next((v for v in project["versions"] if v["n"] == n), None)
    rel = (version or {}).get("files", {}).get(kind)
    path = store.project_dir(pid) / rel if rel else None
    if not path or not path.exists():
        raise AppError("That file isn't available any more.", hint="Export the video again.", status=404)
    return FileResponse(
        path, media_type=MEDIA_TYPES.get(path.suffix, "application/octet-stream"),
        filename=pipeline.download_name(project, kind, rel), content_disposition_type="attachment" if download else "inline",
    )


@router.get("/{pid}/source")
def source_video(pid: str):
    project = store.load(pid)
    return FileResponse(store.project_dir(pid) / project["video"]["file"], content_disposition_type="inline")


# ---------- files added in the editor (videos, pictures, music, sound effects) ----------

@router.post("/{pid}/media")
async def add_media(pid: str, file: UploadFile = File(...)):
    """Add a file to the project's media (not an undo step: the file stays until it's removed)."""
    name = Path(file.filename or "file").name
    kind = media.media_kind(name)
    if not kind:
        raise AppError(f"“{Path(name).suffix or name}” files can't be added.",
                       hint="Add a video (MP4, MOV, MKV, WebM), a picture (PNG, JPG, WebP) or sound (MP3, WAV, M4A, OGG, FLAC).")
    project = store.load(pid)
    if project["status"] in store.BUSY:
        raise AppError("Please wait — this video is still being processed.", status=409)
    folder = store.project_dir(pid)
    (folder / "media").mkdir(exist_ok=True)

    def register(p: dict) -> str:
        mid = timeline.new_id(p, "m")
        p.setdefault("media", {})[mid] = {"kind": kind, "name": name, "file": ""}
        return mid

    holder: list[str] = []
    store.mutate(pid, lambda p: holder.append(register(p)))
    mid = holder[0]
    target = folder / "media" / f"{mid}{Path(name).suffix.lower()}"
    limit, written = config.MAX_UPLOAD_MB * 1024 * 1024, 0
    try:
        with target.open("wb") as f:
            while chunk := await file.read(1024 * 1024):
                written += len(chunk)
                if written > limit:
                    raise AppError(f"This file is larger than {config.MAX_UPLOAD_MB} MB.", hint="Use a smaller file.", status=413)
                f.write(chunk)
        if not written:
            raise AppError("The file is empty.", hint="Choose it again.")
        info = media.probe_media(target, kind)
        extra = {}
        if kind == "video":
            extra["poster"] = str(media.poster(target, info["duration"], folder / "media" / f"{mid}.poster.jpg").relative_to(folder))
        if kind in ("video", "audio") and info.get("audio"):
            wave = folder / "media" / f"{mid}.wave.json"
            wave.write_text(json.dumps(media.waveform(target)), "utf-8")
            extra["wave"] = str(wave.relative_to(folder))
    except Exception:
        target.unlink(missing_ok=True)
        store.mutate(pid, lambda p: p["media"].pop(mid, None))
        raise
    project = store.mutate(pid, lambda p: p["media"][mid].update(file=str(target.relative_to(folder)), proxy=None, **info, **extra))
    pipeline.ensure_proxies(pid, project)
    return reply(project, id=mid)


@router.delete("/{pid}/media/{mid}")
def remove_media(pid: str, mid: str):
    """Take a file out of the media list. Its file is kept, so undo and earlier versions still work."""
    def apply(p: dict) -> None:
        m = (p.get("media") or {}).get(mid)
        if not m or mid == "source":
            raise AppError("That file can't be removed.", status=404)
        if any(c.get("media") == mid for _, c in timeline.all_clips(p)):
            raise AppError("This file is on the timeline.", hint="Delete its clips first, then remove it.", status=409)
        m["removed"] = True

    return reply(store.mutate(pid, apply))


@router.get("/{pid}/media/{mid}/poster.jpg")
def media_poster(pid: str, mid: str):
    return _media_extra(pid, mid, "poster", "image/jpeg")


@router.get("/{pid}/media/{mid}/waveform.json")
def media_waveform(pid: str, mid: str):
    return _media_extra(pid, mid, "wave", "application/json")


def _media_extra(pid: str, mid: str, key: str, media_type: str):
    rel = (store.load(pid).get("media", {}).get(mid) or {}).get(key)
    path = store.project_dir(pid) / rel if rel else None
    if not path or not path.exists():
        raise AppError("Not available.", status=404)
    return FileResponse(path, media_type=media_type, headers={"Cache-Control": "public, max-age=31536000, immutable"})


@router.get("/{pid}/media/{mid}/proxy.mp4")
def proxy_file(pid: str, mid: str):
    m = store.load(pid).get("media", {}).get(mid)
    path = store.project_dir(pid) / m["proxy"] if m and m.get("proxy") else None
    if not path or not path.exists():
        raise AppError("The preview copy isn't ready yet.", status=404)
    # Its URL carries the file's time, so a new copy gets a new URL.
    return FileResponse(path, media_type="video/mp4", headers={"Cache-Control": "public, max-age=31536000, immutable"})


@router.get("/{pid}/media/{mid}/file")
def media_file(pid: str, mid: str):
    m = store.load(pid).get("media", {}).get(mid)
    if not m:
        raise AppError("That file isn't in this project.", status=404)
    path = store.project_dir(pid) / m["file"]
    if not path.exists():
        raise AppError("That file is missing.", status=404)
    return FileResponse(path, content_disposition_type="inline")


@router.get("/{pid}/clips/{name}")
def clip(pid: str, name: str):
    if not re.fullmatch(r"[A-Za-z0-9_]+\.wav", name):
        raise AppError("Clip not found.", status=404)
    path = store.project_dir(pid) / "clips" / name
    if not path.exists():
        raise AppError("Clip not found.", status=404)
    # A clip's name is a hash of its content, so it never changes.
    return FileResponse(path, media_type="audio/wav", headers={"Cache-Control": "public, max-age=31536000, immutable"})


@router.get("/{pid}/thumb.jpg")
def thumbnail(pid: str):
    project = store.load(pid)
    path = _cached(pid, "thumb.jpg", lambda out: media.thumbnail(_video(pid, project), project["video"]["duration"], out))
    return FileResponse(path, media_type="image/jpeg")


@router.get("/{pid}/filmstrip")
def filmstrip(pid: str):
    project = store.load(pid)
    folder = store.project_dir(pid)

    def make(out: Path) -> None:
        meta = media.filmstrip(_video(pid, project), project["video"]["duration"], out)
        (folder / "filmstrip.json").write_text(json.dumps(meta), "utf-8")

    _cached(pid, "filmstrip.jpg", make)
    meta = json.loads((folder / "filmstrip.json").read_text("utf-8"))
    return {**meta, "url": f"/api/projects/{pid}/filmstrip.jpg"}


@router.get("/{pid}/filmstrip.jpg")
def filmstrip_image(pid: str):
    path = store.project_dir(pid) / "filmstrip.jpg"
    if not path.exists():
        raise AppError("Not ready.", status=404)
    return FileResponse(path, media_type="image/jpeg")


@router.get("/{pid}/waveform.json")
def waveform(pid: str, track: Literal["original", "background"] = "original"):
    project = store.load(pid)
    if track == "background":  # the track without the original voice, once it exists
        path = store.project_dir(pid) / "waveform_background.json"
        if not path.exists():
            raise AppError("The voice-free background isn't ready yet.", status=404)
        return FileResponse(path, media_type="application/json")

    def make(out: Path) -> None:
        out.write_text(json.dumps(media.waveform(_video(pid, project))), "utf-8")

    return FileResponse(_cached(pid, "waveform.json", make), media_type="application/json")


@router.get("/{pid}/background.m4a")
def background_track(pid: str):
    path = store.project_dir(pid) / pipeline.BACKGROUND_TRACK
    if not path.exists():
        raise AppError("The voice-free background isn't ready yet.", status=404)
    return FileResponse(path, media_type="audio/mp4")


def _video(pid: str, project: dict) -> Path:
    if not project.get("video"):
        raise AppError("This project has no video yet.", status=404)
    return store.project_dir(pid) / project["video"]["file"]


def _cached(pid: str, name: str, make) -> Path:
    """Build a derived file once (thumbnail, filmstrip, waveform), even if asked for twice at once."""
    path = store.project_dir(pid) / name
    with _media_guard:
        lock = _media_locks.setdefault(f"{pid}/{name}", threading.Lock())
    with lock:
        if not path.exists():
            tmp = path.with_name(f".{name}")
            make(tmp)
            tmp.replace(path)
    return path


def restore_version(pid: str, n: int) -> dict:
    """Bring back the edits of export n (used by the editor router)."""
    folder = store.project_dir(pid)
    state = history.load_version(folder, n)
    if state is None:
        raise AppError("This version can't be restored.", hint="Only exports made in the editor keep their edits.", status=404)
    if "timeline" not in state:  # exported before the edit list (schema 2)
        state = timeline.migrate_state(state, store.load(pid)["video"])
    elif timeline.is_v3(state):  # exported while volumes were fractions (schema 3)
        state = timeline.upgrade_v4(state)
    timeline.ensure_tracks(state)  # exported before the watermark track (schema 4)

    def apply(p: dict) -> None:
        if p["status"] in store.BUSY:
            raise AppError("Please wait — this video is still being processed.", status=409)
        history.restore(p, state)
        sentences.refresh_all(p)

    project, _ = store.edit(pid, apply, f"Restore export {n}")
    return project
