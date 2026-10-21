"""Google Cloud Text-to-Speech. Khmer (km-KH) support depends on Google's current
voice list, so the voices are looked up at runtime and a clear error is shown if
there are none."""
import base64
import threading
from pathlib import Path

import httpx

import config
from errors import AppError

from .base import TTSProvider

API = "https://texttospeech.googleapis.com/v1"


class GoogleTTS(TTSProvider):
    name = "google"
    label = "Google Cloud Text-to-Speech"

    def __init__(self):
        self._voices = None
        self._lock = threading.Lock()

    def status(self):
        if not config.GOOGLE_TTS_API_KEY:
            return False, "Set GOOGLE_TTS_API_KEY in backend/.env"
        return True, ""

    def _headers(self):
        return {"X-Goog-Api-Key": config.GOOGLE_TTS_API_KEY}

    def _voice_for(self, gender: str) -> str:
        with self._lock:
            if self._voices is None:
                try:
                    res = httpx.get(f"{API}/voices", params={"languageCode": "km-KH"}, headers=self._headers(), timeout=30)
                except httpx.HTTPError as err:
                    raise AppError("Couldn't reach Google Cloud TTS.", hint="Check your internet connection.", detail=str(err)) from err
                if res.status_code in (400, 401, 403):
                    raise AppError("Google rejected the TTS API key.", hint="Check GOOGLE_TTS_API_KEY and that the Text-to-Speech API is enabled.", detail=res.text)
                res.raise_for_status()
                self._voices = [v for v in res.json().get("voices", []) if "km-KH" in v.get("languageCodes", [])]
        if not self._voices:
            raise AppError(
                "Google Cloud Text-to-Speech has no Khmer (km-KH) voice.",
                hint="Set TTS_PROVIDER=edge, azure or mms in backend/.env and restart.",
            )
        want = "MALE" if gender == "male" else "FEMALE"
        match = next((v for v in self._voices if v.get("ssmlGender") == want), self._voices[0])
        return match["name"]

    def synthesize(self, text: str, gender: str, speed: float, out: Path) -> Path:
        ok, reason = self.status()
        if not ok:
            raise AppError("Google TTS isn't set up.", hint=reason)
        body = {
            "input": {"text": text},
            "voice": {"languageCode": "km-KH", "name": self._voice_for(gender)},
            "audioConfig": {"audioEncoding": "LINEAR16", "sampleRateHertz": 24000, "speakingRate": speed},
        }
        try:
            res = httpx.post(f"{API}/text:synthesize", headers=self._headers(), json=body, timeout=60)
        except httpx.HTTPError as err:
            raise AppError("Couldn't reach Google Cloud TTS.", hint="Check your internet connection.", detail=str(err)) from err
        if res.status_code != 200:
            raise AppError(f"Google TTS failed (HTTP {res.status_code}).", detail=res.text)
        wav = out.with_suffix(".google.wav")
        wav.write_bytes(base64.b64decode(res.json()["audioContent"]))
        return wav
