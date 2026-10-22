"""Background jobs. One worker thread runs them in order, so the heavy local
models (Whisper, MMS, Demucs) never compete for memory and the API stays responsive."""
import logging
import traceback
from concurrent.futures import ThreadPoolExecutor

import store
from errors import AppError

log = logging.getLogger("jobs")
_executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="job")
_media = ThreadPoolExecutor(max_workers=1, thread_name_prefix="media")  # preview copies: never wait for a job


def start_media(fn, *args) -> None:
    """Make a derived file (a preview copy) in the background, beside the jobs."""
    def run():
        try:
            fn(*args)
        except Exception:  # noqa: BLE001 - the preview falls back to the original file
            log.exception("media task %s%s failed", getattr(fn, "__name__", fn), args)

    _media.submit(run)


class Progress:
    """Passed to pipeline steps so they can report what they are doing."""

    def __init__(self, pid: str):
        self.pid = pid
        self.warnings: list[str] = []

    def step(self, name: str, message: str) -> None:
        store.update(self.pid, step=name, progress=0.0, message=message)

    def update(self, fraction: float | None = None, message: str | None = None) -> None:
        fields = {}
        if fraction is not None:
            fields["progress"] = round(max(0.0, min(1.0, fraction)), 3)
        if message is not None:
            fields["message"] = message
        if fields:
            store.update(self.pid, **fields)

    def warn(self, text: str) -> None:
        self.warnings.append(text)


def start(pid: str, phase: str, fn, busy_status: str, done_status: str) -> None:
    """Queue `fn(pid, progress)`; the project shows `busy_status` until it finishes."""
    store.update(pid, status=busy_status, phase=phase, error=None, warnings=[], progress=0.0, message="Waiting to start…")

    def run():
        progress = Progress(pid)
        try:
            fn(pid, progress)
            store.update(pid, status=done_status, progress=1.0, message="", warnings=progress.warnings)
        except AppError as err:
            log.warning("job %s/%s failed: %s %s", pid, phase, err.message, (err.detail or "")[:300])
            store.update(pid, status="error", error=err.to_dict(), warnings=progress.warnings)
        except Exception as err:  # noqa: BLE001 - any crash must reach the user, not just the log
            log.error("job %s/%s crashed:\n%s", pid, phase, traceback.format_exc())
            store.update(pid, status="error", warnings=progress.warnings, error={
                "message": "Something went wrong while processing this video.",
                "hint": "Press “Try again”. If it keeps failing, check the server log.",
                "detail": f"{type(err).__name__}: {err}"[-1500:],
            })
        finally:
            store.clear_work(pid)

    _executor.submit(run)


def start_task(pid: str, key: str, fn, **about) -> None:
    """Queue a side task that does not lock editing (e.g. removing the original voice).
    Its state lives in project[key]: {state: running | done | error, progress, message, error, **about}."""
    store.update(pid, **{key: {"state": "running", "progress": 0.0, "message": "Waiting to start…", "error": None, **about}})

    def report(fraction: float | None = None, message: str | None = None) -> None:
        def apply(p: dict) -> None:
            if fraction is not None:
                p[key]["progress"] = round(max(0.0, min(1.0, fraction)), 3)
            if message is not None:
                p[key]["message"] = message
        store.mutate(pid, apply)

    def finish(**fields) -> None:
        store.mutate(pid, lambda p: p[key].update(fields))

    def run():
        try:
            fn(pid, report)
            finish(state="done", progress=1.0, message="")
        except AppError as err:
            log.warning("task %s/%s failed: %s %s", pid, key, err.message, (err.detail or "")[:300])
            finish(state="error", error=err.to_dict())
        except Exception as err:  # noqa: BLE001
            log.error("task %s/%s crashed:\n%s", pid, key, traceback.format_exc())
            finish(state="error", error={"message": "Something went wrong.", "hint": "Try again; if it keeps failing, check the server log.", "detail": f"{type(err).__name__}: {err}"[-1500:]})

    _executor.submit(run)
