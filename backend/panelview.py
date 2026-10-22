"""How the editor's panels are laid out for a project: the timeline's height, whether it is open,
collapsed, closed or maximised, whether it follows the playhead, hidden empty tracks, each track's
height and collapse, and the phone's bottom sheet.

It is kept in view.json in the project's folder, not in project.json: it's how you look at the
project, not part of it, so changing it is no edit (no undo step, no new revision, and the project
doesn't count as "edited just now"). Keep the fields in sync with frontend timeline/layout.js.
"""
import json
import threading

import store
from errors import AppError

_lock = threading.Lock()


def load(pid: str) -> dict | None:
    try:
        return json.loads((store.project_dir(pid) / "view.json").read_text("utf-8"))
    except (OSError, ValueError):
        return None  # none saved yet (or unreadable): the editor uses its defaults


def save(pid: str, view: dict) -> None:
    folder = store.project_dir(pid)
    if not (folder / "project.json").exists():
        raise AppError("Project not found.", status=404)
    path = folder / "view.json"
    with _lock:
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(view, ensure_ascii=False), "utf-8")
        tmp.replace(path)
