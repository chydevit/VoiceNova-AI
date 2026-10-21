"""Voice clips, cached in the project's clips/ folder.

The voice engine speaks each (voice, text) once at normal speed — the "base" clip, b_<hash>.wav.
Every other speed is made from it with ffmpeg's atempo (pitch unchanged) and saved as
<clip key>.wav, the key being a hash of (engine, voice, speed, text). So:
  - identical lines are never voiced twice,
  - changing a sentence's speed is instant and works offline,
  - undo can bring back an old clip, because old files are kept.

Every new base clip is checked (services/voicecheck.py). One that came out wrong is voiced again,
up to VOICE_RETRIES times; if every try is wrong, the least wrong one is kept and the sentence
gets a `voice_warning`, saved next to the clip as b_<hash>.check so a cached clip keeps it.
"""
import logging
import hashlib
import shutil
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import config
import sentences
from errors import AppError, LineError
from services import media, voicecheck

log = logging.getLogger("clips")

SR = media.VOICE_RATE
_file_locks: dict[str, threading.Lock] = {}
_guard = threading.Lock()


def ensure(folder: Path, s: dict, provider, force: bool = False) -> dict:
    """Make sure the clip for this sentence's current text, voice and speed exists.
    Returns the sentence's audio fields. `force` voices the text again even if it is cached."""
    text = s["khmer_text"]
    if not text:
        raise LineError("This sentence has no Khmer text to voice.")
    clips = folder / "clips"
    clips.mkdir(exist_ok=True)
    base = clips / f"b_{_hash(provider.name, s['voice'], text)}.wav"
    check = base.with_suffix(".check")  # why this clip may be wrong, when every try was
    with _lock(base):
        if force or not base.exists():
            warning = _synthesize(provider, text, s["voice"], base)
            if warning:
                check.write_text(warning, "utf-8")
            else:
                check.unlink(missing_ok=True)
        warning = check.read_text("utf-8") if check.exists() else None
    warning = text_warning(text) or warning
    key = sentences.clip_key(s)
    if abs(s["speed"] - 1.0) < 0.005:
        out = base
    else:
        out = clips / f"{key}.wav"
        with _lock(out):
            if force or not out.exists():
                tmp = clips / f".{uuid.uuid4().hex}.wav"
                try:
                    media.to_voice_wav(base, tmp, tempo=s["speed"])
                    tmp.replace(out)
                finally:
                    tmp.unlink(missing_ok=True)
    return {"audio_file_path": f"clips/{out.name}", "audio_key": key, "audio_duration": round(media.wav_duration(out), 3), "voice_warning": warning}


def ensure_many(folder: Path, items: list[dict], provider, force: bool | set[str] = False, on_done=None) -> dict[str, dict]:
    """Voice several sentences in parallel. Returns {id: audio fields} or {id: {"error": AppError}}.
    `force`: True for all, or the ids to voice again even if cached."""
    results: dict[str, dict] = {}
    if not items:
        return results
    with ThreadPoolExecutor(max_workers=max(1, config.TTS_WORKERS)) as pool:
        futures = {pool.submit(ensure, folder, s, provider, force if isinstance(force, bool) else s["id"] in force): s for s in items}
        for done, future in enumerate(as_completed(futures), 1):
            s = futures[future]
            try:
                results[s["id"]] = future.result()
            except AppError as err:
                results[s["id"]] = {"error": err}
            if on_done:
                on_done(done, len(items))
    return results


def apply(project: dict, results: dict[str, dict]) -> list[AppError]:
    """Store finished clips on the sentences they were made for. A sentence edited in the
    meantime keeps its "needs voice" status instead of getting an out-of-date clip."""
    errors = []
    for s in project["sentences"]:
        r = results.get(s["id"])
        if r is None:
            continue
        if "error" in r:
            s["error"] = r["error"].message
            errors.append(r["error"])
        elif r["audio_key"] == sentences.clip_key(s):
            s.update(r)
            s["error"] = None
        sentences.refresh(s)
    return errors


def text_warning(text: str) -> str | None:
    if words := voicecheck.unreadable(text):
        return f"The Khmer voice skips “{words}”: these words aren't in Khmer letters. Write them in Khmer, or use ✨ Improve translation."
    return None


def _synthesize(provider, text: str, voice: str, out: Path) -> str | None:
    """Voice `text` into `out` and check it; a clip that came out wrong is voiced again.
    Returns None when the clip is right, else what is still wrong with the least wrong try."""
    # Words in other scripts are skipped by the voice whatever we do, so the length can't be judged.
    judge = not voicecheck.unreadable(text)
    tries = 1 + max(0, config.VOICE_RETRIES)
    best = None  # (how far off, samples, what's wrong)
    failure: LineError | None = None
    tmp = out.parent / f".tmp_{uuid.uuid4().hex}"
    tmp.mkdir()
    try:
        for attempt in range(tries):
            try:
                raw = provider.synthesize(text, voice, 1.0, tmp / f"raw{attempt}", attempt=attempt)
            except LineError as err:  # e.g. no audio received: another try may get it
                failure = err
                continue
            samples = media.trim_silence(media.read_wav(media.to_voice_wav(raw, tmp / f"voice{attempt}.wav")))
            wrong = voicecheck.problem(samples, text) if judge else (None if voicecheck.silent_free(samples) else voicecheck.SILENT)
            if wrong is None:
                best = (0.0, samples, None)
                break
            log.warning("voice try %d of %d is wrong (%s): %s", attempt + 1, tries, wrong, text[:60])
            if wrong != voicecheck.SILENT:
                off = voicecheck.badness(samples, text)
                if best is None or off < best[0]:
                    best = (off, samples, wrong)
        if best is None:
            if failure:
                raise failure
            raise LineError(f"{voicecheck.SILENT[:-1]} for this line, {tries} times.", detail=text[:80])
        media.write_wav(tmp / "clip.wav", best[1]).replace(out)
        if best[2]:
            return f"{best[2]} It came out like this {tries} times — press Regenerate to try again, or reword the line."
        return None
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _hash(*parts: str) -> str:
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:20]


def _lock(path: Path) -> threading.Lock:
    """One lock per clip file, so two requests never write the same clip at once."""
    with _guard:
        return _file_locks.setdefault(str(path), threading.Lock())
