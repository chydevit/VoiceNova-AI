"""Thin wrappers around ffmpeg / ffprobe, plus WAV read/write for timeline building."""
import json
import subprocess
import wave
from pathlib import Path

import numpy as np

import config
from errors import AppError

VOICE_RATE = 24000  # every TTS clip is normalised to 24 kHz mono 16-bit before timing


def require_ffmpeg() -> None:
    if not config.FFMPEG or not config.FFPROBE:
        raise AppError("FFmpeg is not installed.", hint="Install FFmpeg (see the README), then restart the server.", status=500)


def run(args: list, what: str) -> str:
    require_ffmpeg()
    proc = subprocess.run(args, capture_output=True, text=True, errors="replace")
    if proc.returncode != 0:
        raise AppError(f"{what} failed.", hint="The file may be damaged or in an unusual format.", detail=proc.stderr[-1500:])
    return proc.stdout


def ffmpeg(*args, what: str) -> None:
    run([config.FFMPEG, "-hide_banner", "-loglevel", "error", "-y", *map(str, args)], what)


def probe(path: Path) -> dict:
    """Return duration, size and stream info, or raise if this isn't a usable video."""
    require_ffmpeg()
    proc = subprocess.run(
        [config.FFPROBE, "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
        capture_output=True, text=True, errors="replace",
    )
    if proc.returncode != 0:
        raise AppError("This file can't be read as a video.", hint="Upload an MP4, MOV, MKV or WebM video.", detail=proc.stderr[-800:])
    data = json.loads(proc.stdout or "{}")
    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video" and not s.get("disposition", {}).get("attached_pic")), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if not video:
        raise AppError("This file has no video track.", hint="Upload a video file (MP4, MOV, MKV or WebM).")
    if not audio:
        raise AppError("This video has no sound.", hint="There is no speech to translate — upload a video with an audio track.")
    duration = float(data.get("format", {}).get("duration") or video.get("duration") or 0)
    if duration <= 0:
        raise AppError("Couldn't read how long this video is.", hint="Re-export the video as MP4 and try again.")
    width, height = int(video.get("width") or 0), int(video.get("height") or 0)
    rotation = _rotation(video)
    if rotation in (90, 270):  # phones store portrait video sideways; ffmpeg rotates it on decode
        width, height = height, width
    return {
        "duration": round(duration, 3),
        "width": width,
        "height": height,
        "vcodec": video.get("codec_name"),
        "acodec": audio.get("codec_name"),
    }


def _rotation(stream: dict) -> int:
    rot = stream.get("tags", {}).get("rotate")
    for side in stream.get("side_data_list", []) or []:
        if "rotation" in side:
            rot = side["rotation"]
    try:
        return abs(int(float(rot))) % 360
    except (TypeError, ValueError):
        return 0


def extract_audio(src: Path, out: Path, rate: int = 16000, channels: int = 1) -> Path:
    ffmpeg("-i", src, "-vn", "-ac", channels, "-ar", rate, "-c:a", "pcm_s16le", out, what="Extracting the audio")
    return out


def to_voice_wav(src: Path, out: Path, tempo: float = 1.0) -> Path:
    """Convert any audio to 24 kHz mono WAV, optionally changing speed without changing pitch."""
    args = ["-i", src, "-ac", 1, "-ar", VOICE_RATE, "-c:a", "pcm_s16le"]
    if abs(tempo - 1.0) > 0.005:
        args += ["-af", f"atempo={tempo:.4f}"]  # atempo accepts 0.5–100 in one stage
    ffmpeg(*args, out, what="Processing a voice clip")
    return out


def read_wav(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as w:
        if w.getnchannels() != 1 or w.getsampwidth() != 2 or w.getframerate() != VOICE_RATE:
            raise AppError("A voice clip had an unexpected format.", detail=str(path))
        return np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)


def write_wav(path: Path, samples: np.ndarray, rate: int = VOICE_RATE) -> Path:
    if samples.dtype != np.int16:
        samples = (np.clip(samples, -1.0, 1.0) * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(samples.tobytes())
    return path


def wav_duration(path: Path) -> float:
    with wave.open(str(path), "rb") as w:
        return w.getnframes() / float(w.getframerate())


def trim_silence(samples: np.ndarray, threshold: int = 300) -> np.ndarray:
    """Cut leading/trailing near-silence that TTS engines add, so clips start on the word."""
    loud = np.flatnonzero(np.abs(samples.astype(np.int32)) > threshold)
    if not loud.size:
        return samples
    pad = int(0.04 * VOICE_RATE)
    return samples[max(0, loud[0] - pad): min(len(samples), loud[-1] + pad)]


# ---------- pictures and sound for the editor ----------

def thumbnail(video: Path, duration: float, out: Path) -> Path:
    ffmpeg("-ss", f"{min(1.0, duration / 3):.2f}", "-i", video, "-frames:v", 1, "-vf", "scale=320:-2", "-q:v", 4, out, what="Making a thumbnail")
    return out


FILMSTRIP_HEIGHT = 54


def filmstrip(video: Path, duration: float, out: Path) -> dict:
    """One JPEG with a row of small frames across the whole video, for the timeline."""
    tiles = max(4, min(120, round(duration / 4)))
    every = duration / tiles
    # Decoding only keyframes keeps this fast even for long videos; fps= then fills each tile.
    ffmpeg(
        "-skip_frame", "nokey", "-i", video,
        "-vf", f"fps=1/{every:.4f},scale=-2:{FILMSTRIP_HEIGHT},tile={tiles}x1",
        "-frames:v", 1, "-q:v", 5, out, what="Making the timeline pictures",
    )
    proc = subprocess.run(
        [config.FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width", "-of", "csv=p=0", str(out)],
        capture_output=True, text=True,
    )
    width = int((proc.stdout.strip() or "0").split(",")[0] or 0)
    return {"tiles": tiles, "every": round(every, 4), "tile_width": width // tiles if tiles else 0, "tile_height": FILMSTRIP_HEIGHT}


def waveform(src: Path, per_second: int = 20) -> dict:
    """Loudness peaks (0–1), `per_second` per second, to draw the background track."""
    require_ffmpeg()
    rate = 4000
    proc = subprocess.run(
        [config.FFMPEG, "-v", "error", "-i", str(src), "-vn", "-ac", "1", "-ar", str(rate), "-f", "s16le", "-"],
        capture_output=True,
    )
    if proc.returncode != 0:
        raise AppError("Couldn't read the video's sound.", detail=proc.stderr.decode(errors="replace")[-800:])
    samples = np.frombuffer(proc.stdout, dtype=np.int16)
    size = rate // per_second
    n = len(samples) // size
    if not n:
        return {"per_second": per_second, "peaks": []}
    peaks = np.abs(samples[: n * size].reshape(n, size).astype(np.int32)).max(axis=1).astype(np.float32)
    top = max(float(np.percentile(peaks, 99.5)), 1.0)
    return {"per_second": per_second, "peaks": np.round(np.minimum(peaks / top, 1.0), 2).tolist()}


def export_audio(voice: Path, out: Path) -> Path:
    if out.suffix == ".mp3":
        ffmpeg("-i", voice, "-c:a", "libmp3lame", "-b:a", "192k", out, what="Saving the Khmer audio")
    else:
        ffmpeg("-i", voice, "-ar", 48000, "-c:a", "pcm_s16le", out, what="Saving the Khmer audio")
    return out
