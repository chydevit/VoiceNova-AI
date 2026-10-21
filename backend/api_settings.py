"""Settings page: API keys and which services to use, saved to the settings file (config.ENV_FILE).

Keys are never sent back to the browser — only whether each one is set and its last 4 characters.
Changes apply at once: the services read config at the moment they are used.
"""
import os

from dotenv import set_key, unset_key
from fastapi import APIRouter
from pydantic import BaseModel

import config
from errors import AppError
from services import transcribe, translate, tts

router = APIRouter(prefix="/api/settings")

SECRETS = {
    "GEMINI_API_KEY": ("Google Gemini API key", "https://aistudio.google.com/apikey"),
    "ANTHROPIC_API_KEY": ("Anthropic (Claude) API key", "https://console.anthropic.com/settings/keys"),
    "OPENAI_API_KEY": ("OpenAI API key", "https://platform.openai.com/api-keys"),
    "AZURE_SPEECH_KEY": ("Azure Speech key", "https://portal.azure.com/"),
    "GOOGLE_TTS_API_KEY": ("Google Cloud Text-to-Speech key", "https://console.cloud.google.com/apis/credentials"),
}
CHOICES = {
    "TRANSLATE_PROVIDER": ("auto", "gemini", "anthropic", "openai"),
    "TTS_PROVIDER": tuple(tts.PROVIDERS),
}
PLAIN = ("AZURE_SPEECH_REGION",)
DEFAULTS = {"TRANSLATE_PROVIDER": "auto", "TTS_PROVIDER": "edge"}


def _view() -> dict:
    def secret(name: str) -> dict:
        value = getattr(config, name, "") or ""
        label, link = SECRETS[name]
        return {"name": name, "label": label, "link": link, "set": bool(value), "ending": value[-4:] if len(value) > 8 else ""}

    return {
        "secrets": [secret(name) for name in SECRETS],
        "values": {name: getattr(config, name, "") or "" for name in (*CHOICES, *PLAIN)},
        "choices": {name: list(options) for name, options in CHOICES.items()},
        "file": str(config.ENV_FILE),
        "status": {"translate": translate.status(), "tts": tts.status(), "transcribe": transcribe.status()},
    }


@router.get("")
def get_settings():
    return _view()


class SettingsUpdate(BaseModel):
    values: dict[str, str | None]  # name -> new value; "" or null removes it


@router.put("")
def save_settings(body: SettingsUpdate):
    allowed = {*SECRETS, *CHOICES, *PLAIN}
    for name, value in body.values.items():
        if name not in allowed:
            raise AppError(f"“{name}” can't be changed here.", status=400)
        value = (value or "").strip()
        if name in CHOICES and value and value not in CHOICES[name]:
            raise AppError(f"“{value}” isn't a choice for {name}.", hint=f"Use one of: {', '.join(CHOICES[name])}.")
        if any(c in value for c in "\n\r"):
            raise AppError("A setting can't contain line breaks.")

    path = config.ENV_FILE
    path.parent.mkdir(parents=True, exist_ok=True)
    path.touch(exist_ok=True)
    os.chmod(path, 0o600)  # keys: readable by this user only
    for name, value in body.values.items():
        value = (value or "").strip()
        if value:
            set_key(str(path), name, value, quote_mode="never")
            os.environ[name] = value
        else:
            unset_key(str(path), name, quote_mode="never")
            os.environ.pop(name, None)
            value = DEFAULTS.get(name, "")
        setattr(config, name, value)  # takes effect at once
    return _view()
