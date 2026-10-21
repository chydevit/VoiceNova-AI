"""Pick the Khmer voice engine with TTS_PROVIDER in backend/.env."""
import config
from errors import AppError

from .azure import AzureTTS
from .base import TTSProvider
from .edge import EdgeTTS
from .google import GoogleTTS
from .mms import MmsTTS

PROVIDERS: dict[str, TTSProvider] = {p.name: p for p in (EdgeTTS(), AzureTTS(), GoogleTTS(), MmsTTS())}


def get() -> TTSProvider:
    provider = PROVIDERS.get(config.TTS_PROVIDER)
    if not provider:
        raise AppError(f"Unknown TTS_PROVIDER “{config.TTS_PROVIDER}”.", hint=f"Use one of: {', '.join(PROVIDERS)}.", status=500)
    return provider


def status() -> dict:
    provider = PROVIDERS.get(config.TTS_PROVIDER)
    if not provider:
        return {"provider": config.TTS_PROVIDER, "ok": False, "reason": f"Unknown provider; use one of: {', '.join(PROVIDERS)}", "genders": []}
    ok, reason = provider.status()
    return {"provider": provider.name, "label": provider.label, "ok": ok, "reason": reason, "genders": list(provider.genders)}
