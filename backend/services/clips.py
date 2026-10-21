"""Voice clips, cached in the project's clips/ folder.

The voice engine speaks each (voice, text) once at normal speed — the "base" clip, b_<hash>.wav.
Every other speed is made from it with ffmpeg's atempo (pitch unchanged) and saved as
<clip key>.wav, the key being a hash of (engine, voice, speed, text). So:
  - identical lines are never voiced twice,
  - changing a sentence's speed is instant and works offline,
  - undo can bring back an old clip, because old files are kept.
"""
import hashlib
import shutil
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import config
import sentences
from errors import AppError, LineError
from services import media

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
    with _lock(base):
        if force or not base.exists():
            _synthesize(provider, text, s["voice"], base)
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
    return {"audio_file_path": f"clips/{out.name}", "audio_key": key, "audio_duration": round(media.wav_duration(out), 3)}


def ensure_many(folder: Path, items: list[dict], provider, force: bool = False, on_done=None) -> dict[str, dict]:
    """Voice several sentences in parallel. Returns {id: audio fields} or {id: {"error": AppError}}."""
    results: dict[str, dict] = {}
    if not items:
        return results
    with ThreadPoolExecutor(max_workers=max(1, config.TTS_WORKERS)) as pool:
        futures = {pool.submit(ensure, folder, s, provider, force): s for s in items}
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


def _synthesize(provider, text: str, voice: str, out: Path) -> None:
    tmp = out.parent / f".tmp_{uuid.uuid4().hex}"
    tmp.mkdir()
    try:
        raw = provider.synthesize(text, voice, 1.0, tmp / "raw")
        samples = media.trim_silence(media.read_wav(media.to_voice_wav(raw, tmp / "voice.wav")))
        if len(samples) < SR * 0.05:
            raise LineError("The voice came back silent for this line.", detail=text[:80])
        media.write_wav(tmp / "clip.wav", samples).replace(out)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _hash(*parts: str) -> str:
    return hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()[:20]


def _lock(path: Path) -> threading.Lock:
    """One lock per clip file, so two requests never write the same clip at once."""
    with _guard:
        return _file_locks.setdefault(str(path), threading.Lock())
