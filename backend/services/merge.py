"""Mix the Khmer voice with the chosen background and put it back into the video."""
from pathlib import Path

import sentences
from services import cover, media

COPYABLE_VIDEO = {"h264", "hevc"}  # can go into MP4 untouched; anything else is re-encoded to H.264
CUT_FADE = 0.05  # seconds the background fades out / in at the edges of a cut; keep in sync with Player.jsx


def render(video: Path, info: dict, voice: Path, settings: dict, background_track: Path | None,
           gaps: list[dict], overlay: tuple[Path, int] | None, out: Path, title: tuple[Path, int] | None = None) -> Path:
    """settings["background"]:
         replace  – only the Khmer voice
         separate – music & effects without the original speech (Demucs track) + voice
         duck     – the original audio, quieter, under the voice
       settings["background_volume"] (0–1) is the level of that background.
       `gaps` are deleted sentences where the original audio plays at full volume instead.
       settings["background_cuts"] are parts where the background (gaps included) is silent.
       settings["video_cuts"] are parts removed from the video: picture and sound are cut there.
       `overlay` = (subtitle stream, y): burned in at that height.
       `title` = (PNG, y): a still image burned in at that height for the whole video."""
    background, level = settings["background"], settings["background_volume"]
    cuts = settings.get("background_cuts") or []
    inputs = ["-i", video, "-i", voice]
    parts, mix = [], []

    original = level if background == "duck" else 0.0
    if original > 0 or gaps:
        parts.append(f"[0:a]volume='{_level(original, gaps, 1.0, cuts)}':eval=frame,aresample=48000[orig]")
        mix.append("[orig]")
    if background == "separate":
        inputs += ["-i", background_track]
        parts.append(f"[2:a]volume='{_level(level, gaps, 0.0, cuts)}':eval=frame,aresample=48000[bg]")
        mix.append("[bg]")
    if mix:
        parts.append("[1:a]aresample=48000[voice]")
        parts.append(f"{''.join(mix)}[voice]amix=inputs={len(mix) + 1}:duration=longest:normalize=0,alimiter=limit=0.95[a]")
    else:
        parts.append("[1:a]aresample=48000,apad[a]")

    # The original's burned-in subtitles are covered first, then the title and the Khmer subtitles go on top.
    covered = cover.ffmpeg_chain(settings.get("cover"), info["width"], info["height"])
    picture = "[0:v]"
    if covered:
        parts.append(covered)
        picture = "[cv]"
    if title:
        png, y = title
        inputs += ["-i", png]
        title_index = inputs.count("-i") - 1
        parts.append(f"[{title_index}:v]format=rgba[title];{picture}[title]overlay=0:{y}:eof_action=repeat:format=auto[tv]")
        picture = "[tv]"
    if overlay:
        listing, y = overlay
        inputs += ["-f", "concat", "-safe", "0", "-i", listing]
        sub_index = inputs.count("-i") - 1
        parts.append(f"[{sub_index}:v]format=rgba[subs];{picture}[subs]overlay=0:{y}:eof_action=repeat:format=auto,format=yuv420p[v]")
        video_map, video_codec = "[v]", ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]
    elif picture != "[0:v]":
        parts.append(f"{picture}format=yuv420p[v]")
        video_map, video_codec = "[v]", ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]
    elif info.get("vcodec") in COPYABLE_VIDEO:
        video_map, video_codec = "0:v:0", ["-c:v", "copy"] + (["-tag:v", "hvc1"] if info["vcodec"] == "hevc" else [])
    else:
        video_map, video_codec = "0:v:0", ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]

    # Parts removed from the video: keep the other parts of picture and sound and join them.
    audio_map, duration = "[a]", info["duration"]
    removed = settings.get("video_cuts") or []
    if removed:
        kept = sentences.kept_ranges(removed, info["duration"])
        source = video_map if video_map.startswith("[") else "[0:v]"
        n = len(kept)
        parts.append(f"{source}setpts=PTS-STARTPTS," + (f"split={n}" if n > 1 else "null") + "".join(f"[vp{i}]" for i in range(n)))
        parts.append("[a]asetpts=PTS-STARTPTS," + (f"asplit={n}" if n > 1 else "anull") + "".join(f"[ap{i}]" for i in range(n)))
        for i, (a, b) in enumerate(kept):
            parts.append(f"[vp{i}]trim=start={a:.3f}:end={b:.3f},setpts=PTS-STARTPTS[vk{i}]")
            parts.append(f"[ap{i}]atrim=start={a:.3f}:end={b:.3f},asetpts=PTS-STARTPTS[ak{i}]")
        parts.append("".join(f"[vk{i}][ak{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=1[vjoin][ajoin]")
        parts.append("[vjoin]format=yuv420p[vout]")
        video_map, audio_map = "[vout]", "[ajoin]"
        video_codec = ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]
        duration = sum(b - a for a, b in kept)

    media.ffmpeg(
        *inputs,
        "-filter_complex", ";".join(parts),
        "-map", video_map, "-map", audio_map,
        *video_codec,
        "-c:a", "aac", "-b:a", "192k",
        "-t", f"{duration:.3f}",
        "-movflags", "+faststart",
        out,
        what="Merging the Khmer voice into the video",
    )
    return out


def _level(normal: float, gaps: list[dict], in_gaps: float, parts: list[dict]) -> str:
    """A volume expression: `normal`, but `in_gaps` inside the gaps, times each background part's
    volume (0 = silent), ramped over its fade so a change never clicks. Keep in sync with Player.jsx."""
    expr = f"{normal:.3f}"
    if gaps:
        inside = "+".join(f"between(t,{g['start']:.3f},{g['end']:.3f})" for g in gaps)
        expr = f"if(gt({inside},0),{in_gaps:.3f},{normal:.3f})"
    terms = []
    for p in parts:
        gain, fade = p.get("gain", 0.0), max(p.get("fade", CUT_FADE), 0.01)
        ramp = f"clip(min(t-{p['start']:.3f},{p['end']:.3f}-t)/{fade:.3f},0,1)"
        terms.append(f"{gain - 1:.3f}*{ramp}")
    if terms:
        expr = f"({expr})*max(0,1+{'+'.join(terms)})"
    return expr
