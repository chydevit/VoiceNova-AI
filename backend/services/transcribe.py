"""Speech-to-text with sentence timestamps.

local  – faster-whisper on this computer (free; the model downloads once)
openai – OpenAI's Whisper API (needs OPENAI_API_KEY)
"""
import threading
import wave
from pathlib import Path

import httpx
import numpy as np

import config
from errors import AppError
from services import media

_model = None
_model_lock = threading.Lock()


def status() -> dict:
    if config.TRANSCRIBE_PROVIDER == "openai":
        ok = bool(config.OPENAI_API_KEY)
        return {"provider": "openai", "ok": ok, "reason": "" if ok else "Set OPENAI_API_KEY in backend/.env"}
    try:
        import faster_whisper  # noqa: F401
        return {"provider": "local", "model": config.WHISPER_MODEL, "ok": True, "reason": ""}
    except ImportError:
        return {"provider": "local", "ok": False, "reason": "faster-whisper is not installed (pip install -r requirements.txt)"}


def transcribe(audio: Path, language: str | None, duration: float, on_progress) -> tuple[list[dict], str | None]:
    """Return ([{start, end, text}], detected_language)."""
    if config.TRANSCRIBE_PROVIDER == "openai":
        segments, lang = _openai(audio, language)
    else:
        segments, lang = _local(audio, language, duration, on_progress)
    segments = [s for s in segments if s["text"] and s["end"] - s["start"] > 0.05]
    if not segments:
        raise AppError("No speech was found in this video.", hint="Make sure the video has people talking. Music-only videos can't be dubbed.")
    return segments, lang


def _load_model():
    global _model
    with _model_lock:
        if _model is None:
            try:
                from faster_whisper import WhisperModel
            except ImportError as err:
                raise AppError("faster-whisper is not installed.", hint="Run: pip install -r requirements.txt", status=500) from err
            try:
                _model = WhisperModel(config.WHISPER_MODEL, device=config.WHISPER_DEVICE, compute_type=config.WHISPER_COMPUTE_TYPE)
            except Exception as err:  # noqa: BLE001 - usually a failed first download
                raise AppError(
                    f"Couldn't load the Whisper “{config.WHISPER_MODEL}” model.",
                    hint="The first run downloads it from the internet — check your connection, or set WHISPER_MODEL=small in .env.",
                    detail=str(err),
                ) from err
        return _model


def _local(audio: Path, language: str | None, duration: float, on_progress):
    model = _load_model()
    # Hand Whisper the samples ffmpeg already decoded, so it never needs its own (PyAV) decoder.
    with wave.open(str(audio), "rb") as w:
        samples = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    segments, info = model.transcribe(
        samples,
        language=language,
        vad_filter=True,  # skip music/silence so Whisper doesn't invent lines
        beam_size=5,
        condition_on_previous_text=False,  # stops one mistake repeating through the whole video
    )
    out = []
    for seg in segments:  # a generator: transcription happens while we iterate
        out.append({"start": round(seg.start, 2), "end": round(seg.end, 2), "text": seg.text.strip()})
        on_progress(seg.end / duration if duration else None)
    return out, info.language


def _openai(audio: Path, language: str | None):
    if not config.OPENAI_API_KEY:
        raise AppError("OpenAI speech-to-text is selected but OPENAI_API_KEY is empty.", hint="Add the key to backend/.env, or set TRANSCRIBE_PROVIDER=local.")
    small = audio.with_suffix(".mp3")  # the API takes at most 25 MB
    media.ffmpeg("-i", audio, "-ac", 1, "-ar", 16000, "-b:a", "48k", small, what="Compressing the audio")
    if small.stat().st_size > 25 * 1024 * 1024:
        raise AppError("This video is too long for OpenAI's speech-to-text (about 1 hour max).", hint="Set TRANSCRIBE_PROVIDER=local in .env to transcribe on this computer.")
    data = {"model": config.OPENAI_TRANSCRIBE_MODEL, "response_format": "verbose_json", "timestamp_granularities[]": "segment"}
    if language:
        data["language"] = language
    try:
        with small.open("rb") as f:
            res = httpx.post(
                "https://api.openai.com/v1/audio/transcriptions",
                headers={"Authorization": f"Bearer {config.OPENAI_API_KEY}"},
                data=data, files={"file": ("audio.mp3", f, "audio/mpeg")}, timeout=600,
            )
    except httpx.HTTPError as err:
        raise AppError("Couldn't reach OpenAI.", hint="Check your internet connection and try again.", detail=str(err)) from err
    if res.status_code in (401, 403):
        raise AppError("OpenAI rejected the API key.", hint="Check OPENAI_API_KEY in backend/.env.")
    if res.status_code != 200:
        raise AppError(f"OpenAI speech-to-text failed (HTTP {res.status_code}).", hint="Try again in a minute.", detail=res.text)
    body = res.json()
    segments = [{"start": round(s["start"], 2), "end": round(s["end"], 2), "text": s["text"].strip()} for s in body.get("segments", [])]
    return segments, body.get("language")
