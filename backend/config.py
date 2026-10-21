"""All settings, read from backend/.env (copy .env.example to .env and edit it)."""
import json
import os
import shutil
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent
# The settings file: backend/.env, or another file chosen with ENV_FILE (the Mac app keeps it in
# ~/Library/Application Support/Khmer Voice AI). The Settings page writes API keys here.
ENV_FILE = Path(os.getenv("ENV_FILE", "").strip() or BACKEND_DIR / ".env").expanduser()
load_dotenv(ENV_FILE)


def _load_keys_file() -> None:
    """KEYS_FILE may point to a JSON file of API keys ({"GEMINI_API_KEY": "…"}), e.g. one another app
    on this computer already keeps. Keys set in .env or the environment win; the file is only read."""
    path = os.getenv("KEYS_FILE", "").strip()
    if not path:
        return
    try:
        keys = json.loads(Path(path).expanduser().read_text("utf-8"))
    except (OSError, ValueError):
        return
    for name, value in keys.items() if isinstance(keys, dict) else ():
        if name.endswith("_API_KEY") and isinstance(value, str) and value.strip() and not os.getenv(name, "").strip():
            os.environ[name] = value.strip()


_load_keys_file()


def env(name: str, default: str = "") -> str:
    value = os.getenv(name, "").strip()
    return value or default


# ---------- storage & limits ----------
DATA_DIR = Path(env("DATA_DIR", str(BACKEND_DIR / "data"))).resolve()
PROJECTS_DIR = DATA_DIR / "projects"
FRONTEND_DIST = BACKEND_DIR.parent / "frontend" / "dist"
MAX_UPLOAD_MB = int(env("MAX_UPLOAD_MB", "500"))
ALLOWED_EXTENSIONS = {".mp4", ".mov", ".mkv", ".webm"}
PROJECT_TTL_HOURS = float(env("PROJECT_TTL_HOURS", "0"))  # delete projects not edited for this long; 0 = keep until deleted
KEEP_VERSIONS = int(env("KEEP_VERSIONS", "5"))  # exports whose files are kept; older versions keep only their edits

FFMPEG = env("FFMPEG_PATH", shutil.which("ffmpeg") or "")
FFPROBE = env("FFPROBE_PATH", shutil.which("ffprobe") or "")

# ---------- speech-to-text ----------
TRANSCRIBE_PROVIDER = env("TRANSCRIBE_PROVIDER", "local")  # local | openai
WHISPER_MODEL = env("WHISPER_MODEL", "small")  # tiny | base | small | medium | large-v3 | large-v3-turbo
WHISPER_DEVICE = env("WHISPER_DEVICE", "auto")  # auto | cpu | cuda
WHISPER_COMPUTE_TYPE = env("WHISPER_COMPUTE_TYPE", "int8")

# ---------- translation (LLM) ----------
TRANSLATE_PROVIDER = env("TRANSLATE_PROVIDER", "auto")  # auto | anthropic | gemini | openai
ANTHROPIC_API_KEY = env("ANTHROPIC_API_KEY")
ANTHROPIC_MODEL = env("ANTHROPIC_MODEL", "claude-opus-5-5")
GEMINI_API_KEY = env("GEMINI_API_KEY")
GEMINI_MODEL = env("GEMINI_MODEL", "gemini-flash-latest")
GEMINI_FALLBACK_MODEL = env("GEMINI_FALLBACK_MODEL", "gemini-flash-lite-latest")  # used while GEMINI_MODEL is overloaded or too slow
OPENAI_API_KEY = env("OPENAI_API_KEY")
OPENAI_MODEL = env("OPENAI_MODEL", "gpt-5-mini")
OPENAI_TRANSCRIBE_MODEL = env("OPENAI_TRANSCRIBE_MODEL", "whisper-1")
TRANSLATE_WORKERS = int(env("TRANSLATE_WORKERS", "4"))  # batches of lines translated at the same time

# ---------- text-to-speech ----------
TTS_PROVIDER = env("TTS_PROVIDER", "edge")  # edge | azure | google | mms
AZURE_SPEECH_KEY = env("AZURE_SPEECH_KEY")
AZURE_SPEECH_REGION = env("AZURE_SPEECH_REGION")
GOOGLE_TTS_API_KEY = env("GOOGLE_TTS_API_KEY")
MMS_MODEL = env("MMS_MODEL", "facebook/mms-tts-khm")

# ---------- timing & mixing ----------
MIN_SPEED, MAX_SPEED = 0.8, 1.3  # the per-sentence speed range
MAX_FIT_SPEED = 1.3  # "Fix automatically" never speeds a clip up beyond this
TTS_WORKERS = int(env("TTS_WORKERS", "4"))  # voice clips generated at the same time
VOICE_RETRIES = int(env("VOICE_RETRIES", "2"))  # times a clip that came out wrong is voiced again (services/voicecheck.py)
DUCK_VOLUME = float(env("DUCK_VOLUME", "0.15"))  # original audio level in "keep original quietly" mode
DEMUCS_DEVICE = env("DEMUCS_DEVICE", "auto")  # auto | mps | cuda | cpu — where voice removal runs
