"""Khmer Voice AI — API server.

Run (from the backend folder):  python main.py   →  http://127.0.0.1:8000
"""
import json
import logging
import os
import signal
import threading
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

import api_editor
import api_projects
import api_settings
import config
import store
from errors import AppError
from services import separate, transcribe, translate, tts

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("khmer-voice-ai")


def _cleanup_loop():
    while True:
        time.sleep(3600)
        try:
            store.cleanup_expired()
        except Exception:  # noqa: BLE001 - never let cleanup kill the thread
            log.exception("cleanup failed")


def _parent_alive(parent: int) -> bool:
    if os.name != "nt":
        return os.getppid() == parent  # on macOS/Linux an orphan gets a new parent
    import ctypes  # Windows never changes the parent id: ask whether that process still runs

    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(0x00100000, False, parent)  # SYNCHRONIZE
    if not handle:
        return False
    try:
        return kernel32.WaitForSingleObject(handle, 0) == 0x102  # WAIT_TIMEOUT: still running
    finally:
        kernel32.CloseHandle(handle)


def _exit_with_parent(parent: int):
    """Started by the desktop app: if the app goes away without stopping us (crash, force quit), stop too."""
    while True:
        time.sleep(2)
        if not _parent_alive(parent):
            log.info("the app that started this server has closed; stopping")
            if os.name == "nt":
                os._exit(0)
            os.kill(os.getpid(), signal.SIGTERM)  # a clean shutdown, like Ctrl+C
            return


@asynccontextmanager
async def lifespan(_app: FastAPI):
    config.PROJECTS_DIR.mkdir(parents=True, exist_ok=True)
    store.mark_interrupted()
    removed = store.cleanup_expired()
    if removed:
        log.info("removed %d expired project(s)", removed)
    threading.Thread(target=_cleanup_loop, daemon=True).start()
    if config.env("EXIT_WITH_PARENT") == "1":
        parent = int(config.env("PARENT_PID") or os.getppid())  # the Windows app passes its own id
        threading.Thread(target=_exit_with_parent, args=(parent,), daemon=True).start()
    yield


app = FastAPI(title="Khmer Voice AI", lifespan=lifespan)


# ---------- errors: always {"error": {"message", "hint"?, "detail"?}} ----------

@app.exception_handler(AppError)
async def app_error(_req, err: AppError):
    return JSONResponse({"error": err.to_dict()}, status_code=err.status)


@app.exception_handler(RequestValidationError)
async def validation_error(_req, err: RequestValidationError):
    return JSONResponse({"error": {"message": "Some settings were invalid.", "detail": json.dumps(jsonable_errors(err), ensure_ascii=False)}}, status_code=422)


@app.exception_handler(StarletteHTTPException)
async def http_error(_req, err: StarletteHTTPException):
    return JSONResponse({"error": {"message": str(err.detail)}}, status_code=err.status_code)


def jsonable_errors(err: RequestValidationError) -> list:
    return [{"field": ".".join(map(str, e.get("loc", []))), "problem": e.get("msg")} for e in err.errors()]


@app.middleware("http")
async def reject_huge_uploads(request: Request, call_next):
    # Refuse an oversized upload before receiving it, instead of after 500 MB has arrived.
    if request.method == "POST" and request.url.path == "/api/projects":
        size = int(request.headers.get("content-length") or 0)
        if size > config.MAX_UPLOAD_MB * 1024 * 1024 + 1024 * 1024:
            return JSONResponse({"error": {"message": f"This video is larger than {config.MAX_UPLOAD_MB} MB.", "hint": "Trim or compress it, then upload again."}}, status_code=413)
    return await call_next(request)


# ---------- API ----------

@app.get("/api/health")
def health():
    return {
        "ffmpeg": bool(config.FFMPEG and config.FFPROBE),
        "transcribe": transcribe.status(),
        "translate": translate.status(),
        "tts": tts.status(),
        "demucs": separate.available(),
        "max_upload_mb": config.MAX_UPLOAD_MB,
        "formats": sorted(config.ALLOWED_EXTENSIONS),
        "speed_range": [config.MIN_SPEED, config.MAX_SPEED],
    }


app.include_router(api_projects.router)
app.include_router(api_editor.router)
app.include_router(api_settings.router)


class FrontendFiles(StaticFiles):
    """The page itself is always checked for a newer build (the Mac app's WebKit would otherwise keep
    showing an old one); the files in assets/ have the build's hash in their name, so they never change."""

    async def get_response(self, path: str, scope):
        response = await super().get_response(path, scope)
        response.headers["Cache-Control"] = "public, max-age=31536000, immutable" if path.startswith("assets/") else "no-cache"
        return response


# The built React app (npm run build) is served from here; during development Vite serves it instead.
if config.FRONTEND_DIST.exists():
    app.mount("/", FrontendFiles(directory=config.FRONTEND_DIST, html=True), name="frontend")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("main:app", host=config.env("HOST", "127.0.0.1"), port=int(config.env("PORT", "8000")))
