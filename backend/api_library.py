"""Ad Library and Brand Kits: upload and manage logos, product pictures, ad clips and music, the
saved colours, and the brand kits new ads start from (library.py)."""
import secrets
from pathlib import Path

from fastapi import APIRouter, File, Form, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

import library
from errors import AppError
from services import music

router = APIRouter(prefix="/api/library")
IMMUTABLE = {"Cache-Control": "public, max-age=31536000, immutable"}  # an asset's file never changes


def public_asset(a: dict) -> dict:
    base = f"/api/library/assets/{a['id']}"
    return {**a, "url": f"{base}/file", "thumb_url": f"{base}/thumb" if a.get("thumb") else None}


def view() -> dict:
    data = library.load()
    return {
        "assets": [public_asset(a) for a in sorted(data["assets"], key=lambda a: -a["created_at"])],
        "colors": data["colors"],
        "brands": data["brands"],
        "kinds": {k: list(v) for k, v in library.KINDS.items()},
        "fonts": list(library.FONTS),
        "new_brand": library.default_brand(),
        "max_mb": library.MAX_MB,
        "music": music.catalog(),
    }


@router.get("")
def get_library():
    return view()


# ---------- assets ----------

@router.post("/assets")
async def upload_asset(file: UploadFile = File(...), kind: str = Form(...), name: str = Form("")):
    filename = Path(file.filename or "file").name
    what = library.media_kind(filename)
    library.check_kind(kind, what)  # refuse before receiving the whole file
    incoming = library.root() / "incoming"
    incoming.mkdir(parents=True, exist_ok=True)
    tmp = incoming / f"{secrets.token_hex(8)}{Path(filename).suffix.lower()}"
    limit = library.MAX_MB[what] * 1024 * 1024
    written = 0
    try:
        with tmp.open("wb") as f:
            while chunk := await file.read(1024 * 1024):
                written += len(chunk)
                if written > limit:
                    raise AppError(f"This file is larger than {library.MAX_MB[what]} MB.", hint="Make it smaller, then upload it again.", status=413)
                f.write(chunk)
        asset = library.add_asset(tmp, filename, kind, name)
    finally:
        tmp.unlink(missing_ok=True)
    return {"asset": public_asset(asset), "library": view()}


class AssetPatch(BaseModel):
    name: str | None = Field(None, max_length=200)
    kind: str | None = None
    brand: str | None = None
    tags: list[str] | None = None


@router.patch("/assets/{aid}")
def patch_asset(aid: str, body: AssetPatch):
    asset = library.update_asset(aid, body.model_dump(exclude_unset=True))
    return {"asset": public_asset(asset), "library": view()}


@router.delete("/assets/{aid}")
def delete_asset(aid: str):
    cleared = library.delete_asset(aid)
    return {"cleared_brands": cleared, "library": view()}


@router.get("/assets/{aid}/file")
def asset_file(aid: str):
    return FileResponse(library.asset_path(aid), headers=IMMUTABLE, content_disposition_type="inline")


@router.get("/assets/{aid}/thumb")
def asset_thumb(aid: str):
    return FileResponse(library.asset_path(aid, thumb=True), headers=IMMUTABLE)


# ---------- built-in music ----------

@router.get("/music/{pid}.m4a")
def builtin_music(pid: str):
    """A built-in music piece (made from code, free to use); made the first time it's played."""
    return FileResponse(music.track(pid), media_type="audio/mp4", headers=IMMUTABLE)


# ---------- saved colours ----------

class Color(BaseModel):
    name: str = Field("", max_length=200)
    hex: str


class ColorsBody(BaseModel):
    colors: list[Color]


@router.put("/colors")
def put_colors(body: ColorsBody):
    library.set_colors([c.model_dump() for c in body.colors])
    return view()


# ---------- brand kits ----------

class BrandBody(BaseModel):
    name: str | None = Field(None, max_length=200)
    logo: str | None = None
    colors: dict[str, str] | None = None
    fonts: dict[str, str] | None = None
    contact: dict[str, str] | None = None
    cta: str | None = Field(None, max_length=200)
    sponsored_label: str | None = Field(None, max_length=200)


@router.post("/brands")
def create_brand(body: BrandBody):
    brand = library.create_brand(body.model_dump(exclude_unset=True))
    return {"brand": brand, "library": view()}


@router.patch("/brands/{bid}")
def patch_brand(bid: str, body: BrandBody):
    brand = library.update_brand(bid, body.model_dump(exclude_unset=True))
    return {"brand": brand, "library": view()}


@router.post("/brands/{bid}/default")
def make_default(bid: str):
    library.set_default_brand(bid)
    return view()


@router.delete("/brands/{bid}")
def delete_brand(bid: str):
    library.delete_brand(bid)
    return view()


@router.get("/brands/default")
def default_brand():
    """The brand kit new ads start from, or null."""
    return {"brand": library.current_brand()}
