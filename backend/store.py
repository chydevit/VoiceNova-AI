"""Projects live in data/projects/<id>/ with their state in project.json.

  project.json   the project and its sentences (see README → "Data model")
  history.json   undo / redo snapshots
  clips/         voice clips, one per (voice engine, voice, speed, Khmer text)
  versions/vN/   the files of each export, plus snapshot.json to restore its edits
"""
import json
import secrets
import shutil
import threading
import time
from pathlib import Path

import config
import history
import sentences
from errors import AppError
from services import cover

_lock = threading.RLock()  # every read-modify-write of a project.json happens under this lock
SCHEMA_VERSION = 2
BUSY = ("uploaded", "processing", "generating", "exporting")


def new_id() -> str:
    return secrets.token_urlsafe(8).replace("-", "a").replace("_", "b")


def project_dir(pid: str) -> Path:
    if not pid.isalnum():
        raise AppError("Project not found.", status=404)
    return config.PROJECTS_DIR / pid


def work_dir(pid: str) -> Path:
    """Scratch space for one job; deleted when the job ends."""
    d = project_dir(pid) / "work"
    d.mkdir(parents=True, exist_ok=True)
    return d


def clear_work(pid: str) -> None:
    shutil.rmtree(project_dir(pid) / "work", ignore_errors=True)


def default_settings(voice: str = "female", speed: float = 1.0, background: str = "duck") -> dict:
    return {
        "voice": voice, "speed": speed, "background": background, "background_volume": default_background_volume(background),
        "subtitle_style": default_subtitle_style(),
        "cover": dict(cover.DEFAULT),
        "title": default_title(),
        "background_cuts": [],  # parts of the background that are silent: [{"start", "end"}]
        "video_cuts": [],  # parts removed from the video (and everything on them): [{"start", "end"}]
    }


def default_title() -> dict:
    """Text shown at the top for the whole video. size and margin are % of the picture; drawn by the browser."""
    return {"text": "", "size": 7.0, "color": "#fde047", "margin": 5, "outline": True, "box": False}


def default_subtitle_style() -> dict:
    """How burned-in subtitles look. size and margin are % of the picture; drawn by the browser."""
    return {
        "size": 5.5, "color": "#ffffff", "outline": True, "box": False, "position": "bottom", "margin": 7, "bilingual": False,
        "x": 50, "align": "center", "width": 90, "font": "Kantumruy Pro", "bold": True,
        "outline_color": "#000000", "outline_width": 20, "box_color": "#000000", "box_opacity": 0.6, "shadow": False,
    }


def default_background_volume(background: str) -> float:
    return {"duck": config.DUCK_VOLUME, "separate": 1.0}.get(background, 0.0)


def create(name: str) -> dict:
    pid = new_id()
    project_dir(pid).mkdir(parents=True)
    now = time.time()
    project = {
        "version": SCHEMA_VERSION,
        "id": pid,
        "name": name,
        "created_at": now,
        "updated_at": now,
        "rev": 0,
        "status": "uploaded",  # uploaded | processing | review | generating | done | exporting | error
        "phase": None,  # prepare | generate | export (the job that is running or last ran)
        "step": None,  # extract | transcribe | translate | voice | merge | done
        "progress": 0.0,
        "message": "",
        "error": None,
        "warnings": [],
        "video": None,
        "source_lang": "auto",
        "detected_lang": None,
        "settings": default_settings(),
        "original_gaps": [],  # deleted sentences where the original audio plays at full volume
        "next_id": 1,
        "sentences": [],
        "versions": [],
        "export_prefs": {"formats": ["mp4", "srt"], "audio_format": "mp3"},
        "history": dict(history.EMPTY_COUNTS),
    }
    save(project)
    return project


def load(pid: str) -> dict:
    path = project_dir(pid) / "project.json"
    with _lock:
        if not path.exists():
            raise AppError("Project not found.", hint="It may have been deleted — upload the video again.", status=404)
        project = json.loads(path.read_text("utf-8"))
        if project.get("version") != SCHEMA_VERSION:
            _migrate(project)
            save(project)
        project["settings"].setdefault("subtitle_style", default_subtitle_style())  # added after version 2
        project["settings"].setdefault("cover", dict(cover.DEFAULT))
        project["settings"].setdefault("background_cuts", [])
        project["settings"].setdefault("title", default_title())
        project["settings"].setdefault("video_cuts", [])
        return project


def save(project: dict) -> dict:
    path = project_dir(project["id"]) / "project.json"
    tmp = path.with_suffix(".tmp")
    with _lock:
        project["rev"] = project.get("rev", 0) + 1  # lets the browser ignore replies older than what it shows
        project["updated_at"] = time.time()
        tmp.write_text(json.dumps(project, ensure_ascii=False, indent=1), "utf-8")
        tmp.replace(path)
    return project


def update(pid: str, **fields) -> dict:
    with _lock:
        project = load(pid)
        project.update(fields)
        return save(project)


def mutate(pid: str, fn) -> dict:
    """Change a project atomically, without an undo step (voice clips, job results)."""
    with _lock:
        project = load(pid)
        fn(project)
        return save(project)


def edit(pid: str, fn, label: str, group: str | None = None):
    """Change a project atomically as one undo step. `fn(project)` may raise AppError to refuse
    the change. Returns (project, whatever fn returned)."""
    with _lock:
        project = load(pid)
        before = history.snapshot(project)
        result = fn(project)
        sentences.sort(project)
        if history.snapshot(project) != before:
            history.record(project_dir(pid), project, before, label, group)
            save(project)
        return project, result


def list_projects() -> list[dict]:
    if not config.PROJECTS_DIR.exists():
        return []
    out = []
    for d in config.PROJECTS_DIR.iterdir():
        if d.is_dir() and (d / "project.json").exists():
            try:
                out.append(load(d.name))
            except Exception:  # noqa: BLE001 - one broken folder must not hide the others
                continue
    return sorted(out, key=lambda p: p.get("updated_at", 0), reverse=True)


def delete(pid: str) -> None:
    with _lock:
        shutil.rmtree(project_dir(pid), ignore_errors=True)


def cleanup_expired() -> int:
    """Delete projects not touched for PROJECT_TTL_HOURS (0 = never; never one that is mid-job)."""
    if not config.PROJECTS_DIR.exists() or config.PROJECT_TTL_HOURS <= 0:
        return 0
    cutoff = time.time() - config.PROJECT_TTL_HOURS * 3600
    removed = 0
    for d in config.PROJECTS_DIR.iterdir():
        if not d.is_dir():
            continue
        try:
            project = load(d.name)
            busy = project["status"] in BUSY
            expired = project.get("updated_at", project["created_at"]) < cutoff
        except Exception:  # unreadable folder: remove it once it is old
            busy, expired = False, d.stat().st_mtime < cutoff
        if expired and not busy:
            shutil.rmtree(d, ignore_errors=True)
            removed += 1
    return removed


def mark_interrupted() -> None:
    """A restart kills running jobs; tell the user instead of showing them as running forever."""
    if not config.PROJECTS_DIR.exists():
        return
    for d in config.PROJECTS_DIR.iterdir():
        try:
            project = load(d.name)
        except Exception:
            continue
        changed = False
        if project["status"] in ("processing", "generating", "exporting"):
            project["status"] = "error"
            project["error"] = {"message": "The server restarted while this video was being processed.", "hint": "Press “Try again”."}
            changed = True
        if (project.get("separation") or {}).get("state") == "running":
            project["separation"] = {"state": "error", "progress": 0.0, "message": "", "error": {
                "message": "The server restarted while the original voice was being removed.", "hint": "Press “Try again”."}}
            changed = True
        for s in project["sentences"]:
            if s["status"] == "regenerating":
                sentences.refresh(s)
                changed = True
        if changed:
            save(project)


def _migrate(project: dict) -> None:
    """Version 1 (before the editor) kept `segments` with source/khmer text and one `output`."""
    opts = project.pop("options", None) or {}
    voice, speed, background = opts.get("voice", "female"), opts.get("speed", 1.0), opts.get("background", "duck")
    project["sentences"] = [
        sentences.make(
            seg["id"], seg["start"], seg["end"], original_text=seg.get("source", ""), khmer_text=seg.get("khmer", ""),
            voice=voice, speed=speed, shortened=seg.get("shortened", False),
        )
        for seg in project.pop("segments", [])
    ]
    numbers = [int(s["id"][1:]) for s in project["sentences"] if s["id"][1:].isdigit()]
    project["next_id"] = max(numbers, default=0) + 1
    project["settings"] = default_settings(voice, speed, background)
    project["original_gaps"] = []
    project["versions"] = []
    output = project.pop("output", None)
    if output:
        kind = "mp4_subs" if opts.get("burn_subtitles") else "mp4"
        project["versions"].append({
            "n": 1, "at": output["at"], "label": "Export 1",
            "files": {kind: output["video"], "srt": output["srt"]}, "restorable": False,
        })
    project["export_prefs"] = {"formats": ["mp4_subs" if opts.get("burn_subtitles") else "mp4", "srt"], "audio_format": "mp3"}
    project["history"] = dict(history.EMPTY_COUNTS)
    project.setdefault("updated_at", project["created_at"])
    project["version"] = SCHEMA_VERSION
