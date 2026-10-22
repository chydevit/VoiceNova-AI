"""The ad wizard: drafts of advertorial videos made from scratch, and the AI that writes their Khmer
scripts (adverts.py, services/adscript.py)."""
from urllib.parse import quote

from fastapi import APIRouter
from fastapi.responses import Response
from pydantic import BaseModel, ConfigDict, Field

import adtemplates
import adverts
import library
from services import adscript, translate

router = APIRouter(prefix="/api/adverts")


def options() -> dict:
    """The choices the wizard offers."""
    return {
        "styles": [{"key": k, "label": label, "about": about} for k, (label, about) in adscript.STYLES.items()],
        "formats": [{"key": k, "label": label, "where": where} for k, (label, where) in adverts.FORMATS.items()],
        "lengths": [{"seconds": s, **adscript.budget(s)} for s in adscript.LENGTHS],
        "tones": [{"key": k, "label": label, "km": km} for k, label, km, _ in adscript.TONES],
        "roles": list(adscript.ROLES),
        "moods": list(adverts.MOODS),
        "voices": list(adverts.VOICES),
        "resolutions": list(adverts.RESOLUTIONS),
        "writer": translate.status(),
        "templates": adtemplates.all_templates(),
    }


def reply(draft: dict) -> dict:
    return {"draft": draft}


@router.get("")
def list_drafts():
    return {"drafts": adverts.list_drafts(), "options": options()}


@router.post("")
def create_draft():
    return reply(adverts.create())


@router.get("/{did}")
def get_draft(did: str):
    return {"draft": adverts.load(did), "options": options()}


class Contact(BaseModel):
    model_config = ConfigDict(extra="forbid")
    phone: str | None = Field(None, max_length=200)
    facebook: str | None = Field(None, max_length=200)
    telegram: str | None = Field(None, max_length=200)
    address: str | None = Field(None, max_length=200)
    website: str | None = Field(None, max_length=200)


class Brief(BaseModel):
    product: str | None = Field(None, max_length=500)
    description: str | None = Field(None, max_length=5000)
    price: str | None = Field(None, max_length=500)
    promo: str | None = Field(None, max_length=1000)
    cta: str | None = Field(None, max_length=500)
    contact: Contact | None = None


class Music(BaseModel):
    mood: str | None = None
    asset: str | None = None


class DraftPatch(BaseModel):
    step: str | None = None
    brand: str | None = None
    brief: Brief | None = None
    media: list[str] | None = None
    logo: str | None = None
    style: str | None = None
    template: str | None = None
    format: str | None = None
    length: int | None = None
    resolution: str | None = None
    voice: str | None = None
    music: Music | None = None
    scripts: list[dict] | None = None
    chosen: int | None = None
    watermark: str | None = Field(None, max_length=40)  # a watermark preset; null: none


@router.patch("/{did}")
def patch_draft(did: str, body: DraftPatch):
    fields = body.model_dump(exclude_unset=True)
    if "brief" in fields and fields["brief"] is not None:
        fields["brief"] = {k: v for k, v in fields["brief"].items() if v is not None}
        if fields["brief"].get("contact"):
            fields["brief"]["contact"] = {k: v for k, v in fields["brief"]["contact"].items() if v is not None}
    if fields.get("music") is not None:
        fields["music"] = {k: v for k, v in fields["music"].items() if k in body.music.model_fields_set}
    return reply(adverts.patch(did, fields))


@router.post("/{did}/brand")
def apply_brand(did: str):
    """Fill the contact details, call to action and logo in again from the draft's brand kit."""
    draft = adverts.load(did)
    brand = library.find_brand(library.load(), draft["brand"]) if draft["brand"] else library.current_brand()
    if not brand:
        return reply(draft)
    return reply(adverts.patch(did, {"brand": brand["id"], "logo": brand["logo"], "brief": {"cta": brand["cta"], "contact": brand["contact"]}}))


@router.delete("/{did}")
def delete_draft(did: str):
    adverts.delete(did)
    return {"ok": True}


@router.post("/{did}/scripts")
def write_scripts(did: str):
    """The AI writes three scripts (friendly, energetic, professional). Takes up to a minute."""
    return reply(adverts.write_scripts(did))


@router.get("/{did}/script.txt")
def script_text(did: str, index: int | None = None):
    """The chosen script as text, for posting: voiceover, captions and the post."""
    draft = adverts.load(did)
    text = adverts.script_text(draft, index)
    name = (draft["brief"]["product"] or "ad").strip()[:60] + " - script.txt"
    return Response(text, media_type="text/plain; charset=utf-8",
                    headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}"})
