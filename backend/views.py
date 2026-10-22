"""What the browser receives: the project with URLs for its files."""
from collections import Counter

import config
import panelview
import sentences

BACKGROUND_TRACK = "background_no_vocals.m4a"  # keep in sync with pipeline.BACKGROUND_TRACK


def public(project: dict) -> dict:
    """The project for the browser. The voice track's clips are sent once, as `sentences` (with the
    URL of each voice clip); the voice track in `timeline` has no clips of its own."""
    out = dict(project)
    base = f"/api/projects/{project['id']}"
    folder = config.PROJECTS_DIR / project["id"]
    sentences.refresh_all(out)
    out["source_url"] = f"{base}/source" if project.get("video") else None
    out["thumb_url"] = f"{base}/thumb.jpg" if project.get("video") else None
    background = folder / BACKGROUND_TRACK
    out["background_url"] = f"{base}/background.m4a?t={int(background.stat().st_mtime)}" if background.exists() else None
    out["sentences"] = [
        {**s, "audio_url": f"{base}/{s['audio_file_path']}" if sentences.has_clip(s) else None}
        for s in sentences.items(project)
    ]
    out["timeline"] = {"tracks": [{**t, "clips": [] if t["id"] == "voice" else t["clips"]} for t in project["timeline"]["tracks"]]}
    out["media"] = {mid: media_view(base, folder, mid, m) for mid, m in project.get("media", {}).items()}
    out["versions"] = [version(base, v) for v in project.get("versions", [])]
    out["counts"] = dict(Counter(s["status"] for s in out["sentences"]))
    out["counts"]["check_voice"] = sum(1 for s in out["sentences"] if s.get("voice_warning") and s["audio_url"])
    out["view"] = panelview.load(project["id"])  # how the editor's panels are laid out (view.json)
    return out


def media_view(base: str, folder, mid: str, m: dict) -> dict:
    """A media file with the URLs the editor plays it from: the small proxy copy once it's ready."""
    proxy = folder / m["proxy"] if m.get("proxy") else None
    url = f"{base}/source" if mid == "source" else f"{base}/media/{mid}/file"
    return {
        **m, "url": url,
        "proxy_url": f"{base}/media/{mid}/proxy.mp4?t={int(proxy.stat().st_mtime)}" if proxy and proxy.exists() else None,
        "poster_url": f"{base}/media/{mid}/poster.jpg" if m.get("poster") else (f"{base}/thumb.jpg" if mid == "source" else None),
        "wave_url": f"{base}/media/{mid}/waveform.json" if m.get("wave") else None,
        "nobg_url": f"{base}/media/{mid}/nobg.png?t={m.get('nobg_tolerance', 0)}" if m.get("nobg") else None,  # a logo without its background
    }


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
    items = sentences.items(project)
    statuses = Counter(s["status"] for s in items)
    return {
        "id": project["id"],
        "name": project["name"],
        "status": project["status"],
        "phase": project.get("phase"),
        "created_at": project["created_at"],
        "updated_at": project.get("updated_at", project["created_at"]),
        "duration": (project.get("video") or {}).get("duration"),
        "sentences": len(items),
        "needs_work": statuses.get("edited", 0) + statuses.get("too_long", 0) + statuses.get("failed", 0)
                      + sum(1 for s in items if s.get("voice_warning") and s["status"] in ("ok", "too_long")),
        "versions": len(project.get("versions", [])),
        "thumb_url": f"{base}/thumb.jpg" if project.get("video") else None,
    }
