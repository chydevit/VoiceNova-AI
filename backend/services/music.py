"""Built-in background music for ads, made here from code: chords, bass, drums and melody notes are
synthesised with numpy (plucked strings with Karplus–Strong, an FM electric piano, additive pads, drums
from swept sines and noise). It belongs to nobody else, so any ad may use it: no licence, no claims.

Four moods with two pieces each. A piece is made on first use (a few seconds) and kept in
DATA_DIR/music/<id>.m4a; the same id always gives the same music (the random parts are seeded).
"""
import threading
import wave
from dataclasses import dataclass
from pathlib import Path

import numpy as np

import config
from errors import AppError
from services import media

RATE = 44100
SECONDS = 68  # longer than the longest ad (60 s), so a piece never has to loop
_lock = threading.Lock()


@dataclass(frozen=True)
class Piece:
    name: str
    bpm: int
    chords: tuple[tuple[int, ...], ...]  # MIDI notes, one chord a bar
    lead: str  # pluck | epiano | marimba | none
    drums: str  # four (four on the floor) | soft (kick on 1 and 3) | shaker | none
    pad: float = 0.5
    seed: int = 1


def _c(*notes: int) -> tuple[int, ...]:
    return notes


PIECES = {
    "upbeat_1": Piece("Sunny day", 116, (_c(48, 55, 60, 64, 67), _c(43, 55, 59, 62, 67), _c(45, 57, 60, 64, 69), _c(41, 53, 57, 60, 65)), "pluck", "four", 0.35, 11),
    "upbeat_2": Piece("Go go", 124, (_c(50, 57, 62, 66, 69), _c(47, 54, 59, 62, 66), _c(43, 55, 59, 62, 67), _c(45, 57, 61, 64, 69)), "marimba", "four", 0.3, 12),
    "calm_1": Piece("Morning tea", 76, (_c(41, 57, 60, 64, 65), _c(45, 55, 60, 64, 67), _c(38, 57, 60, 62, 65), _c(46, 57, 62, 65, 69)), "epiano", "shaker", 0.6, 21),
    "calm_2": Piece("Soft light", 70, (_c(43, 54, 59, 62, 66), _c(40, 55, 59, 62, 67), _c(36, 55, 59, 64, 67), _c(38, 57, 59, 62, 66)), "pluck", "none", 0.7, 22),
    "luxury_1": Piece("Velvet", 88, (_c(45, 55, 59, 60, 64), _c(41, 57, 60, 64, 67), _c(38, 57, 60, 64, 65), _c(40, 56, 59, 62, 65)), "epiano", "soft", 0.55, 31),
    "luxury_2": Piece("Gold", 84, (_c(48, 58, 62, 63, 67), _c(44, 55, 60, 63, 67), _c(41, 56, 60, 63, 67), _c(43, 53, 59, 62, 65)), "epiano", "soft", 0.5, 32),
    "fun_1": Piece("Bounce", 128, (_c(43, 55, 59, 62, 67), _c(48, 55, 60, 64, 67), _c(50, 57, 62, 66, 69), _c(43, 55, 59, 62, 67)), "pluck", "four", 0.25, 41),
    "fun_2": Piece("Party", 132, (_c(40, 56, 59, 64, 68), _c(45, 57, 61, 64, 69), _c(47, 54, 59, 63, 66), _c(45, 57, 61, 64, 69)), "marimba", "four", 0.25, 42),
}
MOODS = ("upbeat", "calm", "luxury", "fun")


def catalog() -> list[dict]:
    return [{"id": pid, "mood": pid.rsplit("_", 1)[0], "name": p.name, "bpm": p.bpm, "seconds": SECONDS} for pid, p in PIECES.items()]


def for_mood(mood: str, variant: int = 0) -> str:
    """The id of a mood's piece (variant 0 or 1)."""
    if mood not in MOODS:
        raise AppError(f"“{mood}” isn't a music mood.", hint=f"Use one of: {', '.join(MOODS)}.")
    return f"{mood}_{variant % 2 + 1}"


def track(pid: str) -> Path:
    """The file of a built-in piece, made the first time it's asked for."""
    if pid not in PIECES:
        raise AppError("That built-in music doesn't exist.", status=404)
    out = config.DATA_DIR / "music" / f"{pid}.m4a"
    with _lock:
        if not out.exists():
            out.parent.mkdir(parents=True, exist_ok=True)
            wav = out.with_suffix(".wav")
            _write_wav(wav, render(PIECES[pid]))
            try:
                tmp = out.with_name(f"{pid}.tmp.m4a")
                media.ffmpeg("-i", wav, "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", tmp, what="Making the music")
                tmp.replace(out)
            finally:
                wav.unlink(missing_ok=True)
    return out


# ---------- making a piece ----------

def render(p: Piece, seconds: float = SECONDS) -> np.ndarray:
    """The piece as stereo float samples, shape (n, 2)."""
    rng = np.random.default_rng(p.seed)
    beat = 60 / p.bpm
    bar = 4 * beat
    bars = int(np.ceil(seconds / bar))
    n = int(bars * bar * RATE) + RATE  # a second more for the last notes to ring
    left, right = np.zeros(n), np.zeros(n)

    def add(sig: np.ndarray, at: float, gain: float, pan: float = 0.0) -> None:
        i = int(at * RATE)
        if i >= n:
            return
        sig = sig[: n - i] * gain
        left[i:i + len(sig)] += sig * np.sqrt((1 - pan) / 2)
        right[i:i + len(sig)] += sig * np.sqrt((1 + pan) / 2)

    for b in range(bars):
        chord = p.chords[b % len(p.chords)]
        t0 = b * bar
        intro = b == 0
        root, upper = chord[0], chord[1:]
        if p.pad:  # a held chord, wide
            for k, note in enumerate(upper):
                add(_pad(_hz(note), bar + 0.4), t0, p.pad * 0.12, -0.6 if k % 2 else 0.6)
        # bass: the root on the beats (eighths when it's busy)
        steps = 8 if p.bpm >= 110 else 4
        for s in range(steps):
            if p.drums == "none" and s % 2:
                continue
            note = root - 12 if root >= 40 else root
            if s == steps - 1 and rng.random() < 0.4:
                note += 7  # a fifth leading into the next bar
            add(_bass(_hz(note), bar / steps * 0.9), t0 + s * bar / steps, 0.32)
        if not intro:
            _lead(p, add, rng, chord, t0, beat)
            _drums(p, add, rng, t0, beat, b)

    mix = np.stack([left, right], axis=1)
    mix = _reverb(mix, wet=0.18 if p.bpm < 100 else 0.1)
    mix = np.tanh(mix * 1.2) / 1.2  # gentle saturation, no hard clipping
    rms = np.sqrt(np.mean(mix ** 2)) or 1.0
    mix *= 10 ** (-18 / 20) / rms  # about −18 dBFS: a bed, under a voice
    peak = np.max(np.abs(mix)) or 1.0
    if peak > 0.89:
        mix *= 0.89 / peak
    return mix[: int(seconds * RATE) + RATE // 2]


def _lead(p: Piece, add, rng, chord: tuple[int, ...], t0: float, beat: float) -> None:
    tones = sorted({n + 12 * k for n in chord[1:] for k in (0, 1)})
    if p.lead == "pluck":
        if p.bpm >= 110:  # a strummed pattern: down down-up up-down
            for s, accent in ((0, 1.0), (1.5, 0.6), (2, 0.8), (2.5, 0.5), (3, 0.8), (3.5, 0.6)):
                for k, note in enumerate(chord[1:]):
                    add(_pluck(_hz(note + 12), beat * 1.5, rng), t0 + s * beat + k * 0.012, 0.12 * accent, 0.3)
        else:  # a slow arpeggio
            for s in range(8):
                note = tones[(s * 2 + (s // 4)) % len(tones)]
                add(_pluck(_hz(note), beat * 2, rng), t0 + s * beat / 2, 0.18, -0.3 + 0.6 * (s % 2))
    elif p.lead == "marimba":
        pattern = rng.choice(len(tones), size=8)
        for s in range(8):
            if rng.random() < 0.2:
                continue
            add(_marimba(_hz(tones[pattern[s]] + 12), beat), t0 + s * beat / 2, 0.16, 0.25)
    elif p.lead == "epiano":
        hits = (0, 1.5, 2.5) if p.bpm >= 80 else (0, 2)
        for s in hits:
            for note in chord[1:]:
                add(_epiano(_hz(note), beat * 2.5), t0 + s * beat, 0.07, -0.15)
        if rng.random() < 0.7:  # a few melody notes on top
            for s in rng.choice(8, size=3, replace=False):
                add(_epiano(_hz(tones[-1 - int(rng.integers(0, 4))]), beat * 1.5), t0 + s * beat / 2, 0.06, 0.3)


def _drums(p: Piece, add, rng, t0: float, beat: float, b: int) -> None:
    if p.drums == "four":
        for s in range(4):
            add(_kick(), t0 + s * beat, 0.55)
            add(_hat(0.04), t0 + (s + 0.5) * beat, 0.16, 0.35)
        for s in (1, 3):
            add(_clap(rng), t0 + s * beat, 0.22, -0.1)
        if b % 8 == 7:  # a small fill before every eighth bar
            for s in (3.25, 3.5, 3.75):
                add(_clap(rng), t0 + s * beat, 0.12)
    elif p.drums == "soft":
        for s in (0, 2):
            add(_kick(), t0 + s * beat, 0.35)
        for s in (1, 3):
            add(_rim(), t0 + s * beat, 0.12, -0.2)
        for s in range(8):
            add(_hat(0.03), t0 + s * beat / 2, 0.06 + 0.03 * (s % 2), 0.4)
    elif p.drums == "shaker":
        for s in range(8):
            add(_hat(0.09), t0 + s * beat / 2, 0.05 + 0.03 * (s % 2 == 1), 0.3)


# ---------- instruments ----------

def _hz(note: int) -> float:
    return 440.0 * 2 ** ((note - 69) / 12)


def _t(seconds: float) -> np.ndarray:
    return np.arange(int(seconds * RATE)) / RATE


def _env(n: int, attack: float, release: float) -> np.ndarray:
    e = np.ones(n)
    a, r = min(n, int(attack * RATE)), min(n, int(release * RATE))
    if a:
        e[:a] = np.linspace(0, 1, a)
    if r:
        e[-r:] *= np.linspace(1, 0, r)
    return e


def _pad(f: float, seconds: float) -> np.ndarray:
    t = _t(seconds)
    sig = sum(np.sin(2 * np.pi * f * h * d * t) / h for h in range(1, 6) for d in (0.998, 1.002))
    return sig / 4 * _env(len(t), 0.35, 0.5)


def _bass(f: float, seconds: float) -> np.ndarray:
    t = _t(seconds)
    sig = np.sin(2 * np.pi * f * t) + 0.25 * np.sin(4 * np.pi * f * t)
    return sig * np.exp(-t * 3.0) * _env(len(t), 0.005, 0.03)


def _pluck(f: float, seconds: float, rng, decay: float = 0.995) -> np.ndarray:
    """Karplus–Strong: a noise burst through a delay line of one period, averaged each time round."""
    n, period = int(seconds * RATE), max(2, int(RATE / f))
    out = np.empty(n)
    burst = rng.uniform(-1, 1, period)
    out[:period] = (burst + np.roll(burst, 1)) / 2  # a softer, rounder attack
    i = period
    while i < n:
        j = min(i + period, n)
        prev = out[i - period:j - period]
        before = out[i - period - 1:j - period - 1] if i > period else np.concatenate(([0.0], out[:j - period - 1]))
        out[i:j] = decay * 0.5 * (prev + before)
        i = j
    return out * _env(n, 0.002, 0.05)


def _marimba(f: float, seconds: float) -> np.ndarray:
    t = _t(seconds)
    return (np.sin(2 * np.pi * f * t) + 0.35 * np.sin(2 * np.pi * f * 4 * t) * np.exp(-t * 18)) * np.exp(-t * 6) * _env(len(t), 0.002, 0.02)


def _epiano(f: float, seconds: float) -> np.ndarray:
    t = _t(seconds)
    index = 1.6 * np.exp(-t * 4)  # bright at the start, mellow as it rings
    sig = np.sin(2 * np.pi * f * t + index * np.sin(2 * np.pi * f * t)) + 0.15 * np.sin(2 * np.pi * f * 2 * t)
    return sig * np.exp(-t * 1.4) * _env(len(t), 0.004, 0.25)


def _kick() -> np.ndarray:
    t = _t(0.32)
    freq = 45 + 85 * np.exp(-t * 28)
    return np.sin(2 * np.pi * np.cumsum(freq) / RATE) * np.exp(-t * 11)


def _clap(rng) -> np.ndarray:
    t = _t(0.18)
    noise = np.diff(rng.uniform(-1, 1, len(t) + 1))
    return (0.6 * noise + 0.3 * np.sin(2 * np.pi * 190 * t)) * np.exp(-t * 24)


def _rim() -> np.ndarray:
    t = _t(0.06)
    return np.sin(2 * np.pi * 820 * t) * np.exp(-t * 70)


_HAT_NOISE = np.diff(np.random.default_rng(7).uniform(-1, 1, RATE // 4 + 1))


def _hat(decay: float) -> np.ndarray:
    t = _t(min(0.25, decay * 4))
    return _HAT_NOISE[: len(t)] * np.exp(-t / decay)


def _reverb(mix: np.ndarray, wet: float) -> np.ndarray:
    """A small room: convolution with 1.2 s of decaying noise (a different one per side, for width)."""
    rng = np.random.default_rng(3)
    t = _t(1.2)
    out = np.empty_like(mix)
    size = 1 << int(np.ceil(np.log2(len(mix) + len(t))))
    for ch in range(2):
        ir = rng.normal(0, 1, len(t)) * np.exp(-t * 4.5)
        ir /= np.sqrt(np.sum(ir ** 2))
        tail = np.fft.irfft(np.fft.rfft(mix[:, ch], size) * np.fft.rfft(ir, size), size)[: len(mix)]
        out[:, ch] = mix[:, ch] + wet * tail
    return out


def _write_wav(path: Path, samples: np.ndarray) -> None:
    pcm = (np.clip(samples, -1, 1) * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(pcm.tobytes())
