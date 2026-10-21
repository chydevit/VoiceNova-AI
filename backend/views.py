"""What the browser receives: the project with URLs for its files."""
from collections import Counter

import config
import sentences

BACKGROUND_TRACK = "background_no_vocals.m4a"  # keep in sync with pipeline.BACKGROUND_TRACK


def public(project: dict) -> dict:
    out = dict(project)
    base = f"/api/projects/{project['id']}"
    sentences.refresh_all(out)
    out["source_url"] = f"{base}/source" if project.get("video") else None
    out["thumb_url"] = f"{base}/thumb.jpg" if project.get("video") else None
    background = config.PROJECTS_DIR / project["id"] / BACKGROUND_TRACK
    out["background_url"] = f"{base}/background.m4a?t={int(background.stat().st_mtime)}" if background.exists() else None
    out["sentences"] = [
        {**s, "audio_url": f"{base}/{s['audio_file_path']}" if sentences.has_clip(s) else None}
        for s in project["sentences"]
    ]
    out["versions"] = [version(base, v) for v in project.get("versions", [])]
    out["counts"] = dict(Counter(s["status"] for s in out["sentences"]))
    return out


def version(base: str, v: dict) -> dict:
    files = {
        kind: {
            "url": f"{base}/versions/{v['n']}/{kind}?t={int(v['at'])}",
            "download_url": f"{base}/versions/{v['n']}/{kind}?download=1&t={int(v['at'])}",
            "ext": path.rsplit(".", 1)[-1],
        }
        for kind, path in v["files"].items()
    }
    return {**v, "files": files}


def summary(project: dict) -> dict:
    """One row of "My Projects"."""
    base = f"/api/projects/{project['id']}"
    statuses = Counter(s["status"] for s in project["sentences"])
    return {
        "id": project["id"],
        "name": project["name"],
        "status": project["status"],
        "phase": project.get("phase"),
        "created_at": project["created_at"],
        "updated_at": project.get("updated_at", project["created_at"]),
        "duration": (project.get("video") or {}).get("duration"),
        "sentences": len(project["sentences"]),
        "needs_work": statuses.get("edited", 0) + statuses.get("too_long", 0) + statuses.get("failed", 0),
        "versions": len(project.get("versions", [])),
        "thumb_url": f"{base}/thumb.jpg" if project.get("video") else None,
    }
