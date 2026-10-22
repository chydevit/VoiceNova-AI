"""From the edit list to what the export draws and plays (pure: no files, no FFmpeg).

Everything in a plan is in output time: the timeline with its skipped parts taken out.

  plan["length"]     how long the export is
  plan["kept"]       [(timeline start, timeline end)] — the parts of the timeline that are exported
  plan["canvas"]     (width, height) of the exported picture
  plan["video"]      segments one after another from 0 to length:
                       {"kind": "video" | "image" | "black", "start", "end", "media", "source_in", "source_out", "speed"}
  plan["sound"]      runs of background and added sound, each one stretch of one file played without a jump:
                       {"media", "track", "stream": "original" | "stem", "start", "end", "source_in", "source_out", "speed",
                        "pieces": [{"start", "end", "level", "keys", "source_in", "fade_in", "fade_out", "lead_in", "lead_out"}],
                        "duck": None | {"ratio", "fade", "spans"}}
                     (piece times are seconds into the run; gain_at is how loud it plays at each moment)
  plan["voice"]      the voice clips to lay on the voice track, in timeline time (voicetrack cuts the skipped parts)
  plan["voice_volume"]  the voice track's volume (percent; 0 when it's muted)
  plan["subtitles"]  [(voice clip, text, start, end)] in output time, for the .srt file
  plan["burned"]     the same, as burned into the video (none while the text track is hidden)
  plan["texts"]      the text clips' pieces, in output time: {"clip", "start", "end", "enters", "leaves"}
                     (enters / leaves: the piece begins / ends where the clip does, so it animates there)
  plan["watermarks"] the watermarks' pieces, in output time: {"clip", "start", "end", "enters", "leaves", "since", "until"}
                     (since / until: seconds since the watermark began / until it ends, at the piece's start)
"""
import numpy as np

import sentences
import timeline
import watermarks
from timeline import EPS

# keep these in sync with frontend lib/timeline.js
MIN_FADE = 0.01  # seconds; every change of level is ramped at least this long, so it never clicks
CUT_FADE = 0.05
DUCK_HOLD = 0.25  # seconds; the ducked level holds through a pause this much longer than its two fades
VOICE_CUT_FADE = 0.08  # seconds; a voice clip longer than its time slot fades out over this at the slot's end
ENVELOPE_RATE = 1000  # gain values a second in the export's volume envelope


def plan(project: dict, stem_ready: bool = True) -> dict:
    length = timeline.end(project)
    skipped = timeline.skipped_ranges(project)
    kept = timeline.kept_ranges(skipped, length)
    subtitles = subtitle_spans(project, skipped, length)
    return {
        "length": round(sum(b - a for a, b in kept), 3),
        "kept": kept,
        "canvas": canvas(project),
        "video": _video(project, kept),
        "sound": _sound(project, kept, skipped, stem_ready),
        "voice": _voice(project, skipped),
        "voice_volume": 0 if timeline.track(project, "voice")["muted"] else timeline.track(project, "voice").get("volume", 100),
        "subtitles": subtitles,
        "burned": [] if timeline.track(project, "text")["hidden"] else subtitles,
        "texts": _texts(project, kept),
        "watermarks": watermark_pieces(project, kept, skipped),
    }


def canvas(project: dict) -> tuple[int, int]:
    """The exported picture's size: the source's, or the chosen shape (aspect) and size (resolution)."""
    video = project["video"]
    w, h = video["width"], video["height"]
    export = project["settings"].get("export") or timeline.default_export()
    ratio = {"16:9": 16 / 9, "9:16": 9 / 16, "1:1": 1.0}.get(export.get("aspect"), w / h)
    short = {"720p": 720, "1080p": 1080}.get(export.get("resolution"), min(w, h))
    if ratio >= 1:
        h2, w2 = short, short * ratio
    else:
        w2, h2 = short, short / ratio
    if export.get("aspect", "original") == "original" and export.get("resolution", "original") == "original":
        w2, h2 = w, h
    return _even(w2), _even(h2)


def _even(v: float) -> int:
    return max(2, int(round(v / 2)) * 2)


def to_output(start: float, finish: float, kept: list[tuple[float, float]]) -> list[tuple[float, float, float]]:
    """The parts of [start, finish] that are exported: (timeline start, timeline end, output start)."""
    pieces, offset = [], 0.0
    for a, b in kept:
        lo, hi = max(start, a), min(finish, b)
        if hi - lo > EPS:
            pieces.append((lo, hi, offset + lo - a))
        offset += b - a
    return pieces


# ---------- picture ----------

def _video(project: dict, kept: list[tuple[float, float]]) -> list[dict]:
    track = timeline.track(project, "video")
    clips = [] if track["hidden"] else [c for c in track["clips"] if not c.get("skipped")]
    segments: list[dict] = []
    t = 0.0  # output time reached so far
    for a, b in kept:
        cursor = a
        for c in clips:
            if c["end"] <= cursor + EPS or c["start"] >= b - EPS:
                continue
            lo, hi = max(cursor, c["start"]), min(b, c["end"])
            if lo > cursor + EPS:
                t = _black(segments, t, lo - cursor)
            seg = {"kind": c["type"], "start": round(t, 3), "end": round(t + hi - lo, 3), "media": c["media"]}
            if c["type"] == "video":
                sp = c["speed"]
                seg.update(source_in=round(c["source_in"] + (lo - c["start"]) * sp, 3), source_out=round(c["source_in"] + (hi - c["start"]) * sp, 3), speed=sp)
            _add(segments, seg)
            t += hi - lo
            cursor = hi
        if b > cursor + EPS:
            t = _black(segments, t, b - cursor)
    return segments


def _black(segments: list[dict], t: float, seconds: float) -> float:
    _add(segments, {"kind": "black", "start": round(t, 3), "end": round(t + seconds, 3)})
    return t + seconds


def _add(segments: list[dict], seg: dict) -> None:
    """Append, joining a segment to the previous one when it simply carries on (same file, no jump)."""
    last = segments[-1] if segments else None
    if last and last["kind"] == seg["kind"] and abs(last["end"] - seg["start"]) < EPS:
        if seg["kind"] == "black" or (seg["kind"] == "image" and last["media"] == seg["media"]) or (
            seg["kind"] == "video" and last["media"] == seg["media"] and last["speed"] == seg["speed"]
            and abs(last["source_out"] - seg["source_in"]) < EPS
        ):
            last["end"] = seg["end"]
            if seg["kind"] == "video":
                last["source_out"] = seg["source_out"]
            return
    segments.append(seg)


# ---------- sound ----------
# How loud everything plays (the preview uses the same maths: frontend lib/timeline.js). A run's gain
# at a moment is
#   its piece's level (the track's and the clip's volume, the background mode)
#   x the clip's volume line, if it has one
#   x the ducking of its track, while the Khmer voice speaks.
# Where two pieces meet, one changes into the other along a straight line (their fades, or 10 ms).

def _sound(project: dict, kept: list[tuple[float, float]], skipped: list[dict], stem_ready: bool) -> list[dict]:
    mode = project["settings"]["background"]
    voice = speech(project, kept, skipped)
    runs = []
    for tid in ("background", "audio"):
        track = timeline.track(project, tid)
        if track["muted"]:
            continue
        level = track.get("volume", 100) / 100
        duck = _duck(track, voice)
        pieces = []
        for c in track["clips"]:
            if c.get("skipped") or c["end"] - c["start"] < EPS:
                continue
            sp = timeline.speed(project, c)
            for lo, hi, at in to_output(c["start"], c["end"], kept):
                pieces.append({
                    "clip": c, "media": c["media"], "speed": sp, "start": at, "end": at + hi - lo,
                    "source_in": c["source_in"] + (lo - c["start"]) * sp, "source_out": c["source_in"] + (hi - c["start"]) * sp,
                    # a fade belongs to the clip's own edge, not to an edge made by a skipped part
                    "fade_in": c.get("fade_in", 0.0) if abs(lo - c["start"]) < EPS else 0.0,
                    "fade_out": c.get("fade_out", 0.0) if abs(hi - c["end"]) < EPS else 0.0,
                })
        for run in _runs(pieces):
            for stream, gains in _streams(run, tid, mode, level, stem_ready):
                if any(g > 0 for g in gains):
                    runs.append(_run(run, tid, stream, gains, duck))
    return runs


def _runs(pieces: list[dict]) -> list[list[dict]]:
    """Group pieces that play one stretch of a file without a jump (same file, same speed, touching)."""
    out: list[list[dict]] = []
    for p in sorted(pieces, key=lambda p: p["start"]):
        last = out[-1][-1] if out else None
        if last and last["media"] == p["media"] and last["speed"] == p["speed"] and abs(last["end"] - p["start"]) < EPS \
                and abs(last["source_out"] - p["source_in"]) < EPS:
            out[-1].append(p)
        else:
            out.append([p])
    return out


def clip_factor(c: dict) -> float:
    """A clip's own share of its level: its volume (a volume line takes its place), nothing when muted."""
    if c.get("muted"):
        return 0.0
    return 1.0 if c.get("keys") else c.get("volume", 100) / 100


def _streams(run: list[dict], tid: str, mode: str, level: float, stem_ready: bool):
    """Which streams of the file a run plays, with each piece's level in it. The music track plays at
    its volume (`level`). On the background track, the upload's own sound follows the background mode
    and the track's volume; another video's own sound plays at its clips' volume."""
    cf = [clip_factor(p["clip"]) for p in run]
    if tid != "background" or run[0]["media"] != "source":
        yield "original", [c * (level if tid == "audio" else 1.0) for c in cf]
        return
    keep = [bool(p["clip"].get("keep_voice")) for p in run]  # the original voice plays there, at the clip's volume
    if mode == "separate" and stem_ready:
        if not all(keep):
            yield "stem", [0.0 if k else c * level for k, c in zip(keep, cf)]
        if any(keep):
            yield "original", [c if k else 0.0 for k, c in zip(keep, cf)]
    elif mode == "duck" or mode == "separate":
        base = level if mode == "duck" else level * 0.3  # separate, before the stem exists: quietly, like the preview
        yield "original", [c if k else c * base for k, c in zip(keep, cf)]
    else:  # replace: silent, except where the original voice is kept
        yield "original", [c if k else 0.0 for k, c in zip(keep, cf)]


def _run(run: list[dict], tid: str, stream: str, gains: list[float], duck: dict | None) -> dict:
    start = run[0]["start"]
    sp = run[0]["speed"]
    pieces = [{"start": round(p["start"] - start, 4), "end": round(p["end"] - start, 4), "level": g,
               "keys": p["clip"].get("keys") if g > 0 else None, "source_in": round(p["source_in"], 4),
               "fade_in": p["fade_in"], "fade_out": p["fade_out"]} for p, g in zip(run, gains)]
    n = len(pieces)
    # The run starts from silence and ends in silence; where two pieces meet at different levels and
    # neither has a fade, the later one changes over 10 ms. Nothing ever jumps.
    if pieces[0]["fade_in"] <= 0:
        pieces[0]["fade_in"] = MIN_FADE
    if pieces[-1]["fade_out"] <= 0:
        pieces[-1]["fade_out"] = MIN_FADE
    for a, b in zip(pieces, pieces[1:]):
        if abs(value(a, a["end"], sp) - value(b, b["start"], sp)) > 1e-6 and a["fade_out"] <= 0 and b["fade_in"] <= 0:
            b["fade_in"] = MIN_FADE
    for p in pieces:
        p["fade_in"], p["fade_out"] = round(p["fade_in"], 3), round(p["fade_out"], 3)
    for i, p in enumerate(pieces):  # the other side of each join's ramp: the neighbour's fade towards this piece
        p["lead_in"] = pieces[i - 1]["fade_out"] if i > 0 else 0.0
        p["lead_out"] = pieces[i + 1]["fade_in"] if i + 1 < n else 0.0
    return {
        "media": run[0]["media"], "track": tid, "stream": stream, "speed": sp,
        "start": round(start, 4), "end": round(run[-1]["end"], 4),
        "source_in": round(run[0]["source_in"], 4), "source_out": round(run[-1]["source_out"], 4),
        "pieces": pieces, "duck": duck,
    }


def line(keys: list[dict], at):
    """A volume line's value (percent) at `at` seconds of its clip's sound; level before the first
    point and after the last. `at` may be a number or a numpy array."""
    if np.ndim(at) == 0:
        return float(np.interp(at, [k["at"] for k in keys], [k["v"] for k in keys]))
    return np.interp(at, [k["at"] for k in keys], [k["v"] for k in keys])


def value(piece: dict, t, speed: float):
    """A piece's level at t seconds into its run, with its clip's volume line (it carries on past the
    piece's ends, so a neighbour can change into it)."""
    if not piece["keys"]:
        return piece["level"] if np.ndim(t) == 0 else np.full(np.shape(t), piece["level"])
    return piece["level"] * line(piece["keys"], piece["source_in"] + (t - piece["start"]) * speed) / 100


def gain_at(run: dict, t: float) -> float:
    """How loud a run plays at t seconds into it (0 outside it)."""
    return float(gains(run, np.array([t], dtype=float))[0])


def gains(run: dict, t: np.ndarray) -> np.ndarray:
    """gain_at for many moments at once (seconds into the run)."""
    out = np.zeros(len(t))
    pieces, sp = run["pieces"], run["speed"]
    for i, p in enumerate(pieces):
        m = (t >= p["start"]) & (t < p["end"])
        if not m.any():
            continue
        x = t[m]
        a = np.clip((x - p["start"] + p["lead_in"]) / (p["lead_in"] + p["fade_in"]), 0, 1) if p["fade_in"] > 0 else np.ones(len(x))
        b = np.clip((p["end"] + p["lead_out"] - x) / (p["lead_out"] + p["fade_out"]), 0, 1) if p["fade_out"] > 0 else np.ones(len(x))
        cur = value(p, x, sp)
        prev = value(pieces[i - 1], x, sp) if i > 0 else 0.0
        nxt = value(pieces[i + 1], x, sp) if i + 1 < len(pieces) else 0.0
        out[m] = np.where(a < b, prev + (cur - prev) * a, nxt + (cur - nxt) * b)
    if run["duck"]:
        out *= duck_factor(run["duck"], run["start"] + t)
    return out


def envelope(run: dict, rate: int = ENVELOPE_RATE) -> np.ndarray:
    """The run's gain, `rate` times a second from its start (a little past its end), for the export."""
    n = int(np.ceil((run["end"] - run["start"]) * rate)) + 2
    return gains(run, np.arange(n) / rate).astype(np.float32)


# ---------- ducking: the background and the music go down while the Khmer voice speaks ----------

def audible(s: dict) -> bool:
    """A voice clip that makes a sound: not muted, and not at 0 % all along."""
    if s.get("muted"):
        return False
    return max(k["v"] for k in s["keys"]) > 0 if s.get("keys") else s.get("volume", 100) > 0


def speech(project: dict, kept: list[tuple[float, float]], skipped: list[dict]) -> list[tuple[float, float]]:
    """Where the Khmer voice speaks, in output time: each voiced clip from its start until its sound
    ends (or its time slot does)."""
    track = timeline.track(project, "voice")
    if track["muted"] or track.get("volume", 100) <= 0:
        return []
    spans = []
    for s in _voice(project, skipped):
        if not s["khmer_text"] or not sentences.has_clip(s) or not audible(s):
            continue
        finish = s["start"] + min(s["audio_duration"], s["end"] - s["start"])
        spans += [(at, at + hi - lo) for lo, hi, at in to_output(s["start"], finish, kept)]
    return _join(sorted(spans), EPS)


def _join(spans: list[tuple[float, float]], gap: float) -> list[tuple[float, float]]:
    """Sorted spans, those less than `gap` apart joined into one."""
    out: list[tuple[float, float]] = []
    for a, b in spans:
        if out and a - out[-1][1] < gap:
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


def _duck(track: dict, voice: list[tuple[float, float]]) -> dict | None:
    """How a track goes down while the voice speaks: to `ratio` of its level, over `fade` seconds
    before each sentence and after it. Pauses too short for the level to come back up are bridged."""
    d = track.get("duck") or {}
    vol = track.get("volume", 100)
    if not d.get("on") or not voice or vol <= 0 or d["level"] >= vol:
        return None
    fade = d.get("fade", 0.3)
    return {"ratio": d["level"] / vol, "fade": fade, "spans": _join(voice, 2 * fade + DUCK_HOLD)}


def duck_factor(duck: dict, t):
    """The ducking's share of the level at output time t (a number or a numpy array): 1, going down
    to `ratio` over the `fade` before the voice speaks, back up over the `fade` after."""
    spans, fade = duck["spans"], duck["fade"]
    starts = np.array([a for a, _ in spans])
    ends = np.array([b for _, b in spans])
    x = np.atleast_1d(np.asarray(t, dtype=float))
    k = np.searchsorted(starts - fade, x, side="right") - 1  # the last sentence whose ramp has begun
    kk = np.clip(k, 0, len(spans) - 1)
    w = np.where(x < starts[kk], (x - starts[kk] + fade) / fade, np.where(x <= ends[kk], 1.0, (ends[kk] + fade - x) / fade))
    w = np.where(k >= 0, np.clip(w, 0, 1), 0.0)
    f = 1 - (1 - duck["ratio"]) * w
    return float(f[0]) if np.ndim(t) == 0 else f


# ---------- voice and subtitles ----------

def _voice(project: dict, skipped: list[dict]) -> list[dict]:
    if timeline.track(project, "voice")["muted"]:
        return []
    return [s for s in timeline.clips(project, "voice") if not s.get("skipped") and not timeline.inside(s["start"], s["end"], skipped)]


def voice_gains(s: dict, t: np.ndarray, audible: float, cut: bool) -> np.ndarray:
    """A voice clip's gain t seconds after it starts (its track's volume aside): its volume or its
    volume line, its fades, and the short fade where a clip too long for its time slot is cut.
    `audible`: how long it plays (its sound, or its slot when it's cut there)."""
    if s.get("muted"):
        return np.zeros(len(t))
    g = line(s["keys"], t) / 100 if s.get("keys") else np.full(len(t), s.get("volume", 100) / 100)
    if s.get("fade_in", 0) > 0:
        g = g * np.clip(t / s["fade_in"], 0, 1)
    if s.get("fade_out", 0) > 0:
        g = g * np.clip((audible - t) / s["fade_out"], 0, 1)
    if cut:
        g = g * np.clip((audible - t) / VOICE_CUT_FADE, 0, 1)
    return g


def subtitle_text(s: dict) -> str:
    return s["khmer_text"] if s["subtitle_text"] is None else s["subtitle_text"]


def subtitle_spans(project: dict, skipped: list[dict], length: float) -> list[tuple[dict, str, float, float]]:
    """(voice clip, text, start, end) in output time for every subtitle shown. A subtitle stays at least
    half a second and never runs into the next one."""
    lines = []
    for s in timeline.clips(project, "voice"):
        text = subtitle_text(s)
        if s.get("skipped") or not text or timeline.inside(s["start"], s["end"], skipped):
            continue
        timing = s.get("subtitle_timing")
        start = s["start"] + timing["from"] if timing else s["start"]
        finish = s["start"] + timing["to"] if timing else max(s["end"], s["start"] + 0.5)
        lines.append((s, text, start, finish))
    lines.sort(key=lambda x: x[2])
    out = []
    for i, (s, text, start, finish) in enumerate(lines):
        limit = lines[i + 1][2] if i + 1 < len(lines) else length
        finish = min(finish, limit, length)
        if finish - start < EPS:
            continue
        a, b = timeline.output_time(start, skipped), timeline.output_time(finish, skipped)
        if b - a > EPS:
            out.append((s, text, round(a, 3), round(b, 3)))
    return out


# ---------- text clips ----------

def _texts(project: dict, kept: list[tuple[float, float]]) -> list[dict]:
    track = timeline.track(project, "text")
    if track["hidden"]:
        return []
    out = []
    for c in track["clips"]:
        if c.get("skipped") or not str(c.get("text", "")).strip():
            continue
        for lo, hi, at in to_output(c["start"], c["end"], kept):
            out.append({"clip": c, "start": round(at, 3), "end": round(at + hi - lo, 3),
                        "enters": abs(lo - c["start"]) < EPS, "leaves": abs(hi - c["end"]) < EPS})
    return out


# ---------- watermarks ----------

def watermark_pieces(project: dict, kept: list[tuple[float, float]], skipped: list[dict]) -> list[dict]:
    """Each watermark where it shows, in output time: its clip less the parts it hides during (ads,
    intro, outro). The animation runs in output time from where the watermark starts."""
    track = timeline.track(project, "watermark")
    if track["hidden"]:
        return []
    out = []
    for c in track["clips"]:
        if c.get("skipped") or c["end"] - c["start"] < EPS:
            continue
        parts = [(c["start"], c["end"])]
        for r in watermarks.hidden_ranges(project, c.get("hide_during") or []):
            parts = [(a, b) for lo, hi in parts for a, b in ((lo, min(hi, r["start"])), (max(lo, r["end"]), hi)) if b - a > EPS]
        first, last = timeline.output_time(c["start"], skipped), timeline.output_time(c["end"], skipped)
        for lo, hi in parts:
            for a, b, at in to_output(lo, hi, kept):
                out.append({"clip": c, "start": round(at, 3), "end": round(at + b - a, 3), "since": round(at - first, 3),
                            "until": round(last - at, 3), "enters": abs(a - c["start"]) < EPS, "leaves": abs(b - c["end"]) < EPS})
    return out
