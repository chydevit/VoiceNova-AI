"""Watermarks: logos for them (uploaded, or from the Brand Kit), background removal, presets and the
default watermark for new projects. Adding and changing a project's watermarks are timeline edits
(api_editor: add_watermark, set_watermark), so they undo like any other edit."""
import secrets
from pathlib import Path

from fastapi import APIRouter, File, Form, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

import library
import store
import timeline
import watermarks
from api_projects import reply
from errors import AppError

router = APIRouter(prefix="/api")


async def _receive(file: UploadFile, folder: Path) -> tuple[Path, str]:
    """The uploaded logo, written to a temporary file in `folder` (at most MAX_LOGO_MB)."""
    filename = Path(file.filename or "logo.png").name
    ext = Path(filename).suffix.lower()
    if ext not in watermarks.LOGO_EXTENSIONS:
        raise AppError(f"“{ext or filename}” files can't be used as a logo.", hint="Use a PNG (best with a transparent background), JPG, WebP or SVG.")
    folder.mkdir(parents=True, exist_ok=True)
    tmp = folder / f"incoming-{secrets.token_hex(6)}{ext}"
    limit, written = watermarks.MAX_LOGO_MB * 1024 * 1024, 0
    try:
        with tmp.open("wb") as f:
            while chunk := await file.read(1024 * 1024):
                written += len(chunk)
                if written > limit:
                    raise AppError(f"A logo can be at most {watermarks.MAX_LOGO_MB} MB.", hint="Save it smaller (a logo needs about 1000 pixels at most).", status=413)
                f.write(chunk)
        if not written:
            raise AppError("The file is empty.", hint="Choose it again.")
    except Exception:
        tmp.unlink(missing_ok=True)
        raise
    return tmp, filename


@router.post("/projects/{pid}/watermark-logo")
async def upload_logo(pid: str, file: UploadFile = File(...), save_to_kit: str = Form("yes"), name: str = Form("")):
    """Add a logo to the project (and, unless told not to, to the Brand Kit for every project)."""
    folder = store.project_dir(pid)
    store.load(pid)
    tmp, filename = await _receive(file, folder / "media")
    try:
        watermarks.read_rgba(tmp)  # a picture we can read, before anything is kept
        asset = None
        if save_to_kit.lower() not in ("no", "false", "0", ""):  # (a missing bool form field reads as false)
            kit_copy = tmp.with_name(tmp.stem + "-kit" + tmp.suffix)
            kit_copy.write_bytes(tmp.read_bytes())
            asset = library.add_asset(kit_copy, filename, "logo", name or Path(filename).stem)
        holder: list[str] = []
        project = store.mutate(pid, lambda p: holder.append(watermarks.add_logo(p, folder, tmp, name or filename, asset["id"] if asset else None)))
    finally:
        tmp.unlink(missing_ok=True)
    return reply(project, id=holder[0], asset=asset and asset["id"])


class FromKit(BaseModel):
    asset: str = Field(max_length=40)


@router.post("/projects/{pid}/watermark-logo/from-kit")
def logo_from_kit(pid: str, body: FromKit):
    """Use a Brand Kit logo in this project (the project gets its own copy, once)."""
    folder = store.project_dir(pid)
    data = library.load()
    a = library.find_asset(data, body.asset)
    if a["media"] != "image":
        raise AppError("That isn't a picture.", hint="Pick a logo.")
    src = library.asset_path(body.asset)
    project = store.load(pid)
    have = next((mid for mid, m in (project.get("media") or {}).items() if m.get("library") == body.asset and not m.get("removed")), None)
    if have:
        return reply(project, id=have)
    holder: list[str] = []
    project = store.mutate(pid, lambda p: holder.append(watermarks.add_logo(p, folder, src, a["name"], body.asset)))
    return reply(project, id=holder[0])


class RemoveBackground(BaseModel):
    tolerance: int = Field(40, ge=5, le=150)


@router.post("/projects/{pid}/media/{mid}/remove-background")
def remove_background(pid: str, mid: str, body: RemoveBackground):
    """A copy of the logo without its plain (white or one-colour) background, kept next to it; the
    watermark uses it while its `remove_bg` is on."""
    folder = store.project_dir(pid)
    m = (store.load(pid).get("media") or {}).get(mid)
    if not m or m.get("kind") != "image":
        raise AppError("That logo isn't in this project.", status=404)
    out = folder / "media" / f"{mid}.nobg.png"
    found = watermarks.remove_background(folder / m["file"], out, body.tolerance)
    project = store.mutate(pid, lambda p: p["media"][mid].update(nobg=str(out.relative_to(folder)), nobg_tolerance=body.tolerance))
    return reply(project, **found)


@router.get("/projects/{pid}/media/{mid}/nobg.png")
def background_removed(pid: str, mid: str):
    folder = store.project_dir(pid)
    m = (store.load(pid).get("media") or {}).get(mid) or {}
    path = folder / m["nobg"] if m.get("nobg") else None
    if not path or not path.exists():
        raise AppError("The logo hasn't had its background removed.", status=404)
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "no-cache"})


# ---------- presets ----------

def presets_view() -> dict:
    data = watermarks.load_presets()
    lib = {a["id"]: a for a in library.load()["assets"]}
    for p in data["presets"]:
        for item in p["watermarks"]:
            a = lib.get(item.get("logo"))
            item["logo_url"] = f"/api/library/assets/{a['id']}/file" if a else None
    return data


@router.get("/watermarks")
def get_presets():
    return presets_view()


class NewPreset(BaseModel):
    name: str = Field("", max_length=60)
    project: str = Field(max_length=40)  # its watermarks become the preset


@router.post("/watermarks/presets")
def create_preset(body: NewPreset):
    folder = store.project_dir(body.project)
    holder = {}

    def make(p: dict) -> None:
        holder["preset"], _ = watermarks.preset_from_project(p, folder, body.name)

    store.mutate(body.project, make)  # the logos it put in the Brand Kit are remembered on the project

    def add(data: dict) -> dict:
        preset = {"id": watermarks.new_preset_id(data), **holder["preset"]}
        data["presets"].append(preset)
        if not data.get("default"):
            data["default"] = preset["id"]
        return preset

    _, preset = watermarks.mutate_presets(add)
    return {**presets_view(), "id": preset["id"], "project": reply(store.load(body.project))["project"]}


class PresetPatch(BaseModel):
    name: str | None = Field(None, max_length=60)


@router.patch("/watermarks/presets/{wid}")
def rename_preset(wid: str, body: PresetPatch):
    def apply(data: dict) -> None:
        p = watermarks.find_preset(data, wid)
        if body.name is not None and body.name.strip():
            p["name"] = body.name.strip()[:60]

    watermarks.mutate_presets(apply)
    return presets_view()


@router.delete("/watermarks/presets/{wid}")
def delete_preset(wid: str):
    def apply(data: dict) -> None:
        watermarks.find_preset(data, wid)
        data["presets"] = [p for p in data["presets"] if p["id"] != wid]
        if data.get("default") == wid:
            data["default"] = data["presets"][0]["id"] if data["presets"] else None

    watermarks.mutate_presets(apply)
    return presets_view()


class DefaultChoice(BaseModel):
    preset: str | None = None
    auto: bool | None = None  # add it to every new project


@router.post("/watermarks/default")
def set_default(body: DefaultChoice):
    def apply(data: dict) -> None:
        if "preset" in body.model_fields_set:
            if body.preset is not None:
                watermarks.find_preset(data, body.preset)
            data["default"] = body.preset
        if body.auto is not None:
            data["auto"] = body.auto

    watermarks.mutate_presets(apply)
    return presets_view()


class ApplyPreset(BaseModel):
    preset: str = Field(max_length=40)


@router.post("/projects/{pid}/watermarks/preset")
def apply_preset(pid: str, body: ApplyPreset):
    preset = watermarks.find_preset(watermarks.load_presets(), body.preset)
    folder = store.project_dir(pid)
    project, ids = store.edit(pid, lambda p: watermarks.apply_preset(p, folder, preset), f"Watermark preset “{preset['name']}”")
    return reply(project, ids=ids)


@router.post("/watermarks/presets/{wid}/apply-all")
def apply_to_all(wid: str):
    """The preset on every project (one undo step in each; replacing what it put there before).
    Projects that are busy, locked or have no video yet are left as they are."""
    preset = watermarks.find_preset(watermarks.load_presets(), wid)
    done, skipped = [], []
    for p in store.list_projects():
        if p["status"] in store.BUSY or not p.get("video") or timeline.track(p, "watermark")["locked"]:
            skipped.append(p["id"])
            continue
        folder = store.project_dir(p["id"])
        try:
            store.edit(p["id"], lambda q, folder=folder: watermarks.apply_preset(q, folder, preset), f"Watermark preset “{preset['name']}”")
            done.append(p["id"])
        except AppError:
            skipped.append(p["id"])
    return {"done": len(done), "skipped": len(skipped)}
