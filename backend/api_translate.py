"""Translating the lines a video's first translation left without Khmer, from the review page (before
the first voicing). In the editor the same is "Translate again" on those lines (api_editor batch)."""
from fastapi import APIRouter

import jobs
import pipeline
import sentences
import store
from api_projects import reply
from errors import AppError
from services import translate

router = APIRouter(prefix="/api/projects/{pid}")


@router.post("/translate-missing")
def translate_missing(pid: str):
    project = store.load(pid)
    if project["status"] != "review":
        raise AppError("This is for the review page, before the voice is made.", hint="In the editor, use “Translate them” above the sentences.")
    if not any(s["original_text"] and not s["khmer_text"] for s in sentences.items(project)):
        return reply(project)
    if not translate.provider():
        raise AppError("No translation service is set up.", hint=translate.status()["reason"])
    # prepare() keeps the transcript and every translated line, and translates only the empty ones
    jobs.start(pid, "prepare", pipeline.prepare, busy_status="processing", done_status="review")
    return reply(store.load(pid))
