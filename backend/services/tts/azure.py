"""Microsoft Azure AI Speech — the official, paid service with km-KH neural voices."""
from pathlib import Path
from xml.sax.saxutils import escape

import httpx

import config
from errors import AppError

from .base import TTSProvider

VOICES = {"male": "km-KH-PisethNeural", "female": "km-KH-SreymomNeural"}


class AzureTTS(TTSProvider):
    name = "azure"
    label = "Azure AI Speech"

    def status(self):
        if not (config.AZURE_SPEECH_KEY and config.AZURE_SPEECH_REGION):
            return False, "Set AZURE_SPEECH_KEY and AZURE_SPEECH_REGION in backend/.env"
        return True, ""

    def synthesize(self, text: str, gender: str, speed: float, out: Path, attempt: int = 0) -> Path:
        ok, reason = self.status()
        if not ok:
            raise AppError("Azure voices aren't set up.", hint=reason)
        rate = f"{round((speed - 1) * 100):+d}%"
        ssml = (
            "<speak version='1.0' xml:lang='km-KH'>"
            f"<voice name='{VOICES.get(gender, VOICES['female'])}'><prosody rate='{rate}'>{escape(text)}</prosody></voice></speak>"
        )
        url = f"https://{config.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1"
        headers = {
            "Ocp-Apim-Subscription-Key": config.AZURE_SPEECH_KEY,
            "Content-Type": "application/ssml+xml",
            "X-Microsoft-OutputFormat": "riff-24khz-16bit-mono-pcm",
            "User-Agent": "khmer-voice-ai",
        }
        try:
            res = httpx.post(url, headers=headers, content=ssml.encode("utf-8"), timeout=60)
        except httpx.HTTPError as err:
            raise AppError("Couldn't reach Azure Speech.", hint="Check your internet connection and AZURE_SPEECH_REGION.", detail=str(err)) from err
        if res.status_code in (401, 403):
            raise AppError("Azure rejected the speech key.", hint="Check AZURE_SPEECH_KEY and AZURE_SPEECH_REGION in backend/.env.")
        if res.status_code == 429:
            raise AppError("Azure Speech is rate-limiting requests.", hint="Wait a minute and try again.")
        if res.status_code != 200 or not res.content:
            raise AppError(f"Azure Speech failed (HTTP {res.status_code}).", detail=res.text)
        wav = out.with_suffix(".azure.wav")
        wav.write_bytes(res.content)
        return wav
