"""Remove the original voice but keep music and sound effects, with Demucs.
Optional: pip install -r requirements-extra.txt (it is large — it brings PyTorch).

Runs on the Apple GPU (mps) or an NVIDIA GPU when there is one — about 3–4× faster than the CPU."""
import functools
import importlib.util
import re
import shutil
import subprocess
import sys
from pathlib import Path

import config
from errors import AppError
from services import media


def available() -> bool:
    return importlib.util.find_spec("demucs") is not None


@functools.cache
def device() -> str:
    """cuda, mps or cpu (asked in a child process, so the server never loads PyTorch itself)."""
    if config.DEMUCS_DEVICE != "auto":
        return config.DEMUCS_DEVICE
    probe = "import torch; print('cuda' if torch.cuda.is_available() else 'mps' if torch.backends.mps.is_available() else 'cpu')"
    proc = subprocess.run([sys.executable, "-c", probe], capture_output=True, text=True)
    return proc.stdout.strip() if proc.returncode == 0 and proc.stdout.strip() else "cpu"


def remove_vocals(video: Path, work: Path, out: Path, on_progress=None) -> Path:
    """Write the music-and-effects track (no speech) to `out` (an .m4a)."""
    if not available():
        raise AppError(
            "Voice removal (Demucs) isn't installed.",
            hint="Run: pip install -r requirements-extra.txt — or choose another background option.",
        )
    work.mkdir(parents=True, exist_ok=True)
    mix = media.extract_audio(video, work / "original_44k.wav", rate=44100, channels=2)
    stem = work / "demucs" / "htdemucs" / mix.stem / "no_vocals.wav"
    dev = device()
    ok, log = _demucs(mix, work, dev, on_progress)
    if not ok and dev != "cpu":  # a GPU problem (e.g. out of memory): the CPU is slower but works
        shutil.rmtree(work / "demucs", ignore_errors=True)
        ok, log = _demucs(mix, work, "cpu", on_progress)
    if not ok or not stem.exists():
        raise AppError(
            "Removing the original voice failed.",
            hint="The first run downloads the Demucs model — check your internet connection, or choose another background option.",
            detail=log[-1500:],
        )
    tmp = out.with_name(f".{out.name}")
    media.ffmpeg("-i", stem, "-c:a", "aac", "-b:a", "192k", tmp, what="Saving the background track")
    tmp.replace(out)  # never leave a half-written track that looks finished
    return out


def _demucs(mix: Path, work: Path, dev: str, on_progress) -> tuple[bool, str]:
    """Run Demucs, reporting its progress bar (“ 45%|████ …”) as 0–1."""
    proc = subprocess.Popen(
        [sys.executable, "-m", "demucs", "--two-stems", "vocals", "-n", "htdemucs", "-d", dev, "-o", str(work / "demucs"), str(mix)],
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True, errors="replace",
    )
    log = ""
    while chunk := proc.stderr.read(256):
        log = (log + chunk)[-6000:]
        percents = re.findall(r"(\d+)%\|", chunk)
        if percents and on_progress:
            on_progress(int(percents[-1]) / 100)
    return proc.wait() == 0, log
