"""The editor's panel layout for a project (panelview.py). The project itself sends it as `view`."""
from typing import Literal

from fastapi import APIRouter
from pydantic import BaseModel, ConfigDict, Field

import panelview

router = APIRouter(prefix="/api/projects/{pid}")


class TrackView(BaseModel):
    model_config = ConfigDict(extra="forbid")
    collapsed: bool = False
    height: int | None = Field(None, ge=12, le=400)


class TimelineView(BaseModel):
    model_config = ConfigDict(extra="forbid")
    mode: Literal["open", "collapsed", "closed", "max"] = "open"
    height: int | None = Field(None, ge=40, le=4000)
    follow: bool = True
    hide_empty: bool = False
    sheet: Literal["closed", "open", "expanded"] = "open"
    tracks: dict[str, TrackView] = Field(default_factory=dict, max_length=64)


@router.put("/view")
def put_view(pid: str, body: TimelineView):
    """Save how the timeline panel looks. No undo step, no new revision."""
    panelview.save(pid, body.model_dump())
    return {"ok": True}
