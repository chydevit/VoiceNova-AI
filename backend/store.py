"""Projects live in data/projects/<id>/ with their state in project.json.

  project.json   the project and its edit list: tracks of clips (see timeline.py, README → "Data model")
  history/       undo / redo steps
  clips/         voice clips, one per (voice engine, voice, speed, Khmer text)
  media/         files added in the editor (videos, pictures, music); the upload is source.*
  proxy/         small copies of the videos for a smooth preview
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
import timeline
import watermarks
from errors import AppError
from services import cover, media

_lock = threading.RLock()  # every read-modify-write of a project.json happens under this lock
SCHEMA_VERSION = 5
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
        "voice": voice, "speed": speed, "background": background,  # the background's volume is its track's
        "subtitle_style": default_subtitle_style(),
        "cover": dict(cover.DEFAULT),
        "title": default_title(),
        "export": timeline.default_export(),
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


def default_background_volume(background: str) -> int:
    """The background track's volume (percent) for a background mode."""
    return timeline.default_level(background)


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
        "media": {},  # every file the edit list plays: "source" (the upload) and files added later
        "timeline": timeline.empty(),  # the background's volume is set for its mode when the video arrives (timeline.init)
        "next_id": 1,  # voice clips: s1, s2 …
        "next_clip": 1,  # other clips: v1, b2, t3, a4 …
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
        project["settings"].setdefault("title", default_title())
        project["settings"].setdefault("export", timeline.default_export())
        timeline.ensure_tracks(project)
        for t in project["timeline"]["tracks"]:  # fields added in version 4
            for k, v in timeline.new_track(t["id"]).items():
                if k != "clips":
                    t.setdefault(k, v)
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
        timeline.relink(project)
        watermarks.fit_whole(project)
        timeline.sort(project)
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
        if (project.get("batch") or {}).get("state") == "running":
            project["batch"] = {**project["batch"], "state": "error", "error": {
                "message": "The server restarted while sentences were being voiced.", "hint": "Run it again; what was finished is kept."}}
            changed = True
        if (project.get("separation") or {}).get("state") == "running":
            project["separation"] = {"state": "error", "progress": 0.0, "message": "", "error": {
                "message": "The server restarted while the original voice was being removed.", "hint": "Press “Try again”."}}
            changed = True
        for s in sentences.items(project):
            if s["status"] == "regenerating":
                sentences.refresh(s)
                changed = True
        if changed:
            save(project)


def _migrate(project: dict) -> None:
    """Bring an older project.json up to SCHEMA_VERSION, one version at a time. A copy of the file as
    it was is kept next to it (project.v<old>.json)."""
    folder = project_dir(project["id"])
    old = project.get("version", 1)
    backup = folder / f"project.v{old}.json"
    if not backup.exists():
        shutil.copy2(folder / "project.json", backup)
    if old < 2:
        _migrate_v1(project)
    if project["version"] < 3:
        _migrate_v2(project, folder)
    if project["version"] < 4:
        _migrate_v3(project, folder)
    if project["version"] < 5:
        timeline.ensure_tracks(project)  # the watermark track; undo steps name tracks by id, so they stay
        project["version"] = 5


def _migrate_v3(project: dict, folder: Path) -> None:
    """Version 3 kept volumes as fractions (1.0 = normal) and the background's level in the settings;
    version 4 keeps integer percents on every track and clip (timeline.upgrade_v4). The undo steps
    held the old volumes, so the history starts again; the old one is kept as history.v3/."""
    timeline.upgrade_v4(project)
    old = folder / "history"
    if old.exists():
        shutil.rmtree(folder / "history.v3", ignore_errors=True)
        old.replace(folder / "history.v3")
    history.reset(folder, project)
    project["version"] = 4


def _migrate_v2(project: dict, folder: Path) -> None:
    """Version 2 kept the sentences in source time, and cuts, background parts and "original audio"
    gaps as lists of times. Since version 3 it is an edit list: tracks of clips (timeline.migrate_state,
    which writes version 4's volumes straight away). Its undo history can't go back past the upgrade;
    the old one is kept as history.v2.json."""
    video = project.get("video")
    if video and not video.get("fps"):
        try:
            video["fps"] = media.probe(folder / video["file"]).get("fps") or 30
        except AppError:
            video["fps"] = 30
    state = {
        "sentences": project.pop("sentences", []), "settings": project.get("settings") or default_settings(),
        "original_gaps": project.pop("original_gaps", []), "next_id": project.get("next_id", 1),
    }
    project.update(timeline.migrate_state(state, video))
    project["media"] = {"source": timeline.source_media(video, project["name"])} if video else {}
    old_history = folder / "history.json"
    if old_history.exists():
        old_history.replace(folder / "history.v2.json")
    history.reset(folder, project)
    project["version"] = 4


def _migrate_v1(project: dict) -> None:
    """Version 1 (before the editor) kept `segments` with source/khmer text and one `output`."""
    opts = project.pop("options", None) or {}
    voice, speed, background = opts.get("voice", "female"), opts.get("speed", 1.0), opts.get("background", "duck")
    project["sentences"] = [
        {**sentences.make(
            seg["id"], seg["start"], seg["end"], original_text=seg.get("source", ""), khmer_text=seg.get("khmer", ""),
            voice=voice, speed=speed, shortened=seg.get("shortened", False),
        ), "volume": 1.0}  # version 2 kept volumes as fractions (_migrate_v2 makes them percents)
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
    project["version"] = 2
