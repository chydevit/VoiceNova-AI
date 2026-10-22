"""Undo / redo, and export versions.

Undo works on what the user edits: the timeline (every track and clip), the settings and the id
counters. Each step stores only what it changed, both ways (the clips by id, the other fields
whole), in its own file under history/; history/index.json lists the steps. So there is no fixed
number of steps: only when a project's history passes HISTORY_BYTES are the oldest steps dropped.
Voice clips are files named by their content, so going back to an old step brings its clips back
instantly. project["history"] keeps the counts so the browser can enable the buttons.
"""
import copy
import json
import secrets
import shutil
import time
from pathlib import Path

import config
import timeline

EDITABLE = ("timeline", "settings", "next_id", "next_clip")
HISTORY_BYTES = 100 * 1024 * 1024  # the oldest steps are dropped past this
GROUP_SECONDS = 4  # edits to the same field within this time are one undo step (typing)
EMPTY_COUNTS = {"undo": 0, "redo": 0, "undo_label": None, "redo_label": None}


def snapshot(project: dict) -> dict:
    return copy.deepcopy({k: project[k] for k in EDITABLE if k in project})


def restore(project: dict, state: dict) -> None:
    project.update(copy.deepcopy(state))


# ---------- what changed ----------

def diff(before: dict, after: dict) -> dict:
    """{"keys": {name: [before, after]}, "tracks": {id: {"props": [before, after], "clips": {id: [before, after]}}}}
    — only what differs. A clip that was added has None before; one that was removed, None after."""
    out = {"keys": {}, "tracks": {}}
    for k in EDITABLE:
        if k != "timeline" and before.get(k) != after.get(k):
            out["keys"][k] = [before.get(k), after.get(k)]
    old = {t["id"]: t for t in (before.get("timeline") or {}).get("tracks", [])}
    new = {t["id"]: t for t in (after.get("timeline") or {}).get("tracks", [])}
    for tid in old.keys() | new.keys():
        a, b = old.get(tid, {"clips": []}), new.get(tid, {"clips": []})
        change = {}
        props_a = {k: v for k, v in a.items() if k != "clips"}
        props_b = {k: v for k, v in b.items() if k != "clips"}
        if props_a != props_b:
            change["props"] = [props_a, props_b]
        clips_a = {c["id"]: c for c in a["clips"]}
        clips_b = {c["id"]: c for c in b["clips"]}
        changed = {cid: [clips_a.get(cid), clips_b.get(cid)] for cid in clips_a.keys() | clips_b.keys() if clips_a.get(cid) != clips_b.get(cid)}
        if changed:
            change["clips"] = changed
        if change:
            out["tracks"][tid] = change
    return out


def empty_diff(d: dict) -> bool:
    return not d["keys"] and not d["tracks"]


def compose(first: dict, second: dict) -> dict:
    """One step that does `first` then `second` (for grouping a burst of typing)."""
    out = copy.deepcopy(first)
    for k, (b, a) in second["keys"].items():
        out["keys"][k] = [out["keys"][k][0] if k in out["keys"] else b, a]
    for tid, change in second["tracks"].items():
        target = out["tracks"].setdefault(tid, {})
        if "props" in change:
            target["props"] = [target["props"][0] if "props" in target else change["props"][0], change["props"][1]]
        for cid, (b, a) in change.get("clips", {}).items():
            clips = target.setdefault("clips", {})
            clips[cid] = [clips[cid][0] if cid in clips else b, a]
    # drop what ended where it started (typed, then deleted again)
    out["keys"] = {k: v for k, v in out["keys"].items() if v[0] != v[1]}
    for tid in list(out["tracks"]):
        change = out["tracks"][tid]
        if "props" in change and change["props"][0] == change["props"][1]:
            del change["props"]
        if "clips" in change:
            change["clips"] = {cid: v for cid, v in change["clips"].items() if v[0] != v[1]}
            if not change["clips"]:
                del change["clips"]
        if not change:
            del out["tracks"][tid]
    return out


def _apply(project: dict, d: dict, side: int) -> None:
    """Put the project in the `side` (0 = before, 1 = after) state of step d."""
    for k, pair in d["keys"].items():
        if pair[side] is None:
            project.pop(k, None)
        else:
            project[k] = copy.deepcopy(pair[side])
    tracks = {t["id"]: t for t in project["timeline"]["tracks"]}
    for tid, change in d["tracks"].items():
        t = tracks.get(tid)
        if t is None:
            continue
        if "props" in change:
            t.update(copy.deepcopy(change["props"][side]))
        if "clips" in change:
            by_id = {c["id"]: c for c in t["clips"]}
            for cid, pair in change["clips"].items():
                if pair[side] is None:
                    by_id.pop(cid, None)
                else:
                    by_id[cid] = copy.deepcopy(pair[side])
            t["clips"] = sorted(by_id.values(), key=timeline.order)


def _refresh(project: dict, d: dict, side: int) -> None:
    """Before leaving a state, write what it is now into the step (clips voiced since, for example),
    so coming back to it brings that back too."""
    for k in d["keys"]:
        d["keys"][k][side] = copy.deepcopy(project.get(k))
    tracks = {t["id"]: t for t in project["timeline"]["tracks"]}
    for tid, change in d["tracks"].items():
        t = tracks.get(tid)
        if t is None:
            continue
        if "props" in change:
            change["props"][side] = copy.deepcopy({k: v for k, v in t.items() if k != "clips"})
        if "clips" in change:
            by_id = {c["id"]: c for c in t["clips"]}
            for cid in change["clips"]:
                change["clips"][cid][side] = copy.deepcopy(by_id.get(cid))


# ---------- the steps on disk ----------

def record(folder: Path, project: dict, before: dict, label: str, group: str | None) -> None:
    """Remember the change from `before` to the project as it is now, and forget the redo steps."""
    d = diff(before, snapshot(project))
    if empty_diff(d):
        return
    index = _index(folder)
    last = index["undo"][-1] if index["undo"] else None
    if group and last and last.get("group") == group and time.time() - last["at"] < GROUP_SECONDS:
        d = compose(_load(folder, last["id"]) or d, d)  # the whole burst of typing undoes at once
        last["at"] = time.time()
        if empty_diff(d):
            _forget(folder, [index["undo"].pop()])
        else:
            last["bytes"] = _save(folder, last["id"], d)
    else:
        entry = {"id": secrets.token_hex(6), "label": label, "group": group, "at": time.time()}
        entry["bytes"] = _save(folder, entry["id"], d)
        index["undo"].append(entry)
    _forget(folder, index["redo"])
    index["redo"] = []
    while len(index["undo"]) > 1 and sum(s.get("bytes", 0) for s in index["undo"]) > HISTORY_BYTES:
        _forget(folder, [index["undo"].pop(0)])
    _write_index(folder, index, project)


def step(folder: Path, project: dict, direction: str) -> str | None:
    """Undo or redo one step on `project` (not saved here). Returns the step's label, or None."""
    index = _index(folder)
    source, target = (index["undo"], index["redo"]) if direction == "undo" else (index["redo"], index["undo"])
    if not source:
        return None
    entry = source.pop()
    d = _load(folder, entry["id"])
    if d is None:  # its file is gone: skip it rather than get stuck
        _write_index(folder, index, project)
        return entry["label"]
    leave, arrive = (1, 0) if direction == "undo" else (0, 1)
    _refresh(project, d, leave)
    _apply(project, d, arrive)
    entry["bytes"] = _save(folder, entry["id"], d)
    entry["group"] = None
    target.append(entry)
    _write_index(folder, index, project)
    return entry["label"]


def reset(folder: Path, project: dict) -> None:
    """Start an empty history."""
    shutil.rmtree(folder / "history", ignore_errors=True)
    project["history"] = dict(EMPTY_COUNTS)


def _dir(folder: Path) -> Path:
    d = folder / "history"
    d.mkdir(exist_ok=True)
    return d


def _index(folder: Path) -> dict:
    try:
        index = json.loads((folder / "history" / "index.json").read_text("utf-8"))
        return {"undo": index.get("undo", []), "redo": index.get("redo", [])}
    except (OSError, ValueError):
        return {"undo": [], "redo": []}


def _load(folder: Path, sid: str) -> dict | None:
    try:
        return json.loads((folder / "history" / f"{sid}.json").read_text("utf-8"))
    except (OSError, ValueError):
        return None


def _save(folder: Path, sid: str, d: dict) -> int:
    path = _dir(folder) / f"{sid}.json"
    data = json.dumps(d, ensure_ascii=False, separators=(",", ":"))
    tmp = path.with_suffix(".tmp")
    tmp.write_text(data, "utf-8")
    tmp.replace(path)
    return len(data.encode("utf-8"))


def _forget(folder: Path, steps: list[dict]) -> None:
    for s in steps:
        (folder / "history" / f"{s['id']}.json").unlink(missing_ok=True)


def _write_index(folder: Path, index: dict, project: dict) -> None:
    path = _dir(folder) / "index.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(index, ensure_ascii=False), "utf-8")
    tmp.replace(path)
    project["history"] = {
        "undo": len(index["undo"]), "redo": len(index["redo"]),
        "undo_label": index["undo"][-1]["label"] if index["undo"] else None,
        "redo_label": index["redo"][-1]["label"] if index["redo"] else None,
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
