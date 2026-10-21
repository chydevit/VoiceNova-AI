"""Microsoft Edge "Read aloud" voices through the edge-tts package. Free, no key,
needs internet. Same km-KH neural voices as Azure, but an unofficial endpoint
with no uptime guarantee — use Azure for anything commercial."""
import asyncio
from pathlib import Path

from errors import AppError, LineError

from .base import TTSProvider

VOICES = {"male": "km-KH-PisethNeural", "female": "km-KH-SreymomNeural"}


class EdgeTTS(TTSProvider):
    name = "edge"
    label = "Microsoft Edge voices (free)"

    def status(self):
        try:
            import edge_tts  # noqa: F401
            return True, ""
        except ImportError:
            return False, "edge-tts is not installed (pip install -r requirements.txt)"

    def synthesize(self, text: str, gender: str, speed: float, out: Path, attempt: int = 0) -> Path:
        import edge_tts

        mp3 = out.with_suffix(".mp3")
        rate = f"{round((speed - 1) * 100):+d}%"
        try:
            asyncio.run(edge_tts.Communicate(text, VOICES.get(gender, VOICES["female"]), rate=rate).save(str(mp3)))
        except edge_tts.exceptions.NoAudioReceived as err:
            raise LineError("The voice service returned no audio for this line.", detail=f"{err} — {text[:80]}") from err
        except Exception as err:  # noqa: BLE001 - network errors come in many shapes
            raise AppError("Couldn't reach the Microsoft Edge voice service.", hint="Check your internet connection, or switch TTS_PROVIDER in .env.", detail=f"{type(err).__name__}: {err}") from err
        return mp3
