"""Checks a voice clip for the mistakes voice engines make, so a wrong one is made again.

A clip is wrong when, for the length of its text, it is
  - silent,
  - much too short (the engine stopped early or skipped words),
  - much too long (it rambled or repeated itself),
  - broken by a long silence in the middle (it hung), or
  - distorted (clipped samples).
The limits come from 2,400 good clips: a Khmer voice takes 0.065–0.39 s per letter and pauses
at most ~1 s inside a line, so only clearly broken clips are caught.

Text the voice can't read is caught before voicing: letters of other languages (Thai, Chinese…)
are skipped by a Khmer voice, so voicing again won't help — the words need to be in Khmer.
"""
import math
import unicodedata

import numpy as np

from services import media

MIN_SECONDS_PER_LETTER = 0.04  # good clips: ≥ 0.065
MAX_SECONDS = (1.5, 0.4)  # longest believable clip: 1.5 s + 0.4 s per letter (good clips: ≤ 0.39 s per letter)
TYPICAL_SECONDS_PER_LETTER = 0.12
LONGEST_PAUSE = 1.8  # seconds of silence inside a line (good clips: ≤ 1 s)
QUIET_DB = -45  # quieter than this counts as silence
CLIPPED_SHARE = 0.005  # share of samples at full scale


def letters(text: str) -> int:
    """Letters that are spoken: everything but spaces and combining marks (Khmer vowel signs, coeng…)."""
    return sum(1 for c in text if not c.isspace() and not unicodedata.category(c).startswith("M"))


def unreadable(text: str) -> str:
    """The words in `text` written in another script than Khmer or Latin (a Khmer voice skips them), or ""."""
    def foreign(c: str) -> bool:
        return c.isalpha() and not ("ក" <= c <= "៿" or "᧠" <= c <= "᧿") and not unicodedata.name(c, "").startswith("LATIN")

    words = []
    word = ""
    for c in text + " ":
        if foreign(c) or (word and unicodedata.category(c).startswith("M")):
            word += c
        elif word:
            words.append(word)
            word = ""
    return " ".join(dict.fromkeys(words))


SILENT = "The voice came back silent."


def silent_free(samples: np.ndarray) -> bool:
    """True when the clip has some sound in it (trim_silence leaves a fully silent clip as it is)."""
    return samples.size > 0 and int(np.max(np.abs(samples.astype(np.int32)))) > 300


def problem(samples: np.ndarray, text: str, speed: float = 1.0, rate: int = media.VOICE_RATE) -> str | None:
    """What is wrong with this clip of `text` (already trimmed of leading/trailing silence), or None."""
    seconds = len(samples) / rate * speed  # how long it would take at normal speed
    n = max(1, letters(text))
    if seconds < 0.05 or not silent_free(samples):
        return SILENT
    if n >= 6 and seconds < MIN_SECONDS_PER_LETTER * n:
        return f"The voice is much too short for the text ({seconds:.1f} s) — words are probably missing."
    if seconds > MAX_SECONDS[0] + MAX_SECONDS[1] * n:
        return f"The voice is much too long for the text ({seconds:.1f} s) — it may repeat or ramble."
    x = samples.astype(np.float32) / 32768
    if np.mean(np.abs(x) > 0.998) > CLIPPED_SHARE:
        return "The voice is distorted."
    pause = longest_pause(x, rate) * speed
    if pause > LONGEST_PAUSE:
        return f"The voice stops for {pause:.1f} s in the middle."
    return None


def longest_pause(x: np.ndarray, rate: int) -> float:
    frame = int(0.02 * rate)
    count = len(x) // frame
    if not count:
        return 0.0
    energy = np.sqrt(np.mean(x[: count * frame].reshape(count, frame) ** 2, axis=1))
    quiet = energy < 10 ** (QUIET_DB / 20)
    longest = run = 0
    for q in quiet:
        run = run + 1 if q else 0
        longest = max(longest, run)
    return longest * 0.02


def badness(samples: np.ndarray, text: str, rate: int = media.VOICE_RATE) -> float:
    """How far a clip's length is from typical, to keep the least wrong of several tries."""
    seconds = max(0.01, len(samples) / rate)
    return abs(math.log(seconds / (TYPICAL_SECONDS_PER_LETTER * max(1, letters(text)))))
