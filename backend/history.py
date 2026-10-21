"""Undo / redo, and export versions.

Undo works on snapshots of what the user edits (sentences, settings, gaps). Voice clips are
files named by their content, so restoring an old snapshot brings its clips back instantly.
Snapshots live in history.json next to project.json; project["history"] only keeps the counts
so the browser can enable the buttons without reading the whole history.
"""
import copy
import json
import time
from pathlib import Path

import config

EDITABLE = ("sentences", "settings", "original_gaps", "next_id")
LIMIT = 40  # undo steps kept
GROUP_SECONDS = 4  # edits to the same field within this time are one undo step (typing)
EMPTY_COUNTS = {"undo": 0, "redo": 0, "undo_label": None, "redo_label": None}


def snapshot(project: dict) -> dict:
    return copy.deepcopy({k: project[k] for k in EDITABLE})


def restore(project: dict, state: dict) -> None:
    project.update(copy.deepcopy(state))


def record(folder: Path, project: dict, before: dict, label: str, group: str | None) -> None:
    """Remember `before` as the state to go back to, and forget the redo steps."""
    h = _read(folder)
    last = h["undo"][-1] if h["undo"] else None
    if group and last and last.get("group") == group and time.time() - last["at"] < GROUP_SECONDS:
        last["at"] = time.time()  # keep the older snapshot: the whole burst of typing undoes at once
    else:
        h["undo"].append({"state": before, "label": label, "group": group, "at": time.time()})
        del h["undo"][:-LIMIT]
    h["redo"] = []
    _write(folder, h, project)


def step(folder: Path, project: dict, direction: str) -> str | None:
    """Undo or redo one step on `project` (not saved here). Returns the step's label, or None."""
    h = _read(folder)
    source, target = (h["undo"], h["redo"]) if direction == "undo" else (h["redo"], h["undo"])
    if not source:
        return None
    entry = source.pop()
    target.append({"state": snapshot(project), "label": entry["label"], "group": None, "at": time.time()})
    restore(project, entry["state"])
    _write(folder, h, project)
    return entry["label"]


def _read(folder: Path) -> dict:
    try:
        return json.loads((folder / "history.json").read_text("utf-8"))
    except (OSError, ValueError):
        return {"undo": [], "redo": []}


def _write(folder: Path, h: dict, project: dict) -> None:
    path = folder / "history.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(h, ensure_ascii=False), "utf-8")
    tmp.replace(path)
    project["history"] = {
        "undo": len(h["undo"]), "redo": len(h["redo"]),
        "undo_label": h["undo"][-1]["label"] if h["undo"] else None,
        "redo_label": h["redo"][-1]["label"] if h["redo"] else None,
    }


# ---------- versions ----------

def version_dir(folder: Path, n: int) -> Path:
    return folder / "versions" / f"v{n}"


def next_version(project: dict) -> int:
    return max((v["n"] for v in project["versions"]), default=0) + 1


def add_version(project: dict, folder: Path, n: int, files: dict, options: dict) -> dict:
    """Record export `n` (its files are already in versions/vN/) with a snapshot of the edits."""
    vdir = version_dir(folder, n)
    vdir.mkdir(parents=True, exist_ok=True)
    (vdir / "snapshot.json").write_text(json.dumps(snapshot(project), ensure_ascii=False), "utf-8")
    version = {"n": n, "at": time.time(), "label": f"Export {n}", "files": files, "options": options, "restorable": True}
    project["versions"].append(version)
    _prune(project, folder)
    return version


def load_version(folder: Path, n: int) -> dict | None:
    try:
        return json.loads((version_dir(folder, n) / "snapshot.json").read_text("utf-8"))
    except (OSError, ValueError):
        return None


def _prune(project: dict, folder: Path) -> None:
    """Keep the files of the newest KEEP_VERSIONS exports; older ones keep only their snapshot."""
    for version in project["versions"][:-max(1, config.KEEP_VERSIONS)]:
        if not version["files"]:
            continue
        for rel in version["files"].values():
            (folder / rel).unlink(missing_ok=True)
        version["files"] = {}
        version["pruned"] = True
