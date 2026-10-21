"""Mix the Khmer voice with the chosen background and put it back into the video."""
from pathlib import Path

from services import cover, media

COPYABLE_VIDEO = {"h264", "hevc"}  # can go into MP4 untouched; anything else is re-encoded to H.264


def render(video: Path, info: dict, voice: Path, settings: dict, background_track: Path | None,
           gaps: list[dict], overlay: tuple[Path, int] | None, out: Path) -> Path:
    """settings["background"]:
         replace  – only the Khmer voice
         separate – music & effects without the original speech (Demucs track) + voice
         duck     – the original audio, quieter, under the voice
       settings["background_volume"] (0–1) is the level of that background.
       `gaps` are deleted sentences where the original audio plays at full volume instead.
       `overlay` = (subtitle stream, y): burned in at that height."""
    background, level = settings["background"], settings["background_volume"]
    inputs = ["-i", video, "-i", voice]
    parts, mix = [], []

    original = level if background == "duck" else 0.0
    if original > 0 or gaps:
        parts.append(f"[0:a]volume='{_level(original, gaps, 1.0)}':eval=frame,aresample=48000[orig]")
        mix.append("[orig]")
    if background == "separate":
        inputs += ["-i", background_track]
        parts.append(f"[2:a]volume='{_level(level, gaps, 0.0)}':eval=frame,aresample=48000[bg]")
        mix.append("[bg]")
    if mix:
        parts.append("[1:a]aresample=48000[voice]")
        parts.append(f"{''.join(mix)}[voice]amix=inputs={len(mix) + 1}:duration=longest:normalize=0,alimiter=limit=0.95[a]")
    else:
        parts.append("[1:a]aresample=48000,apad[a]")

    # The original's burned-in subtitles are covered first, then the Khmer subtitles go on top.
    covered = cover.ffmpeg_chain(settings.get("cover"), info["width"], info["height"])
    picture = "[0:v]"
    if covered:
        parts.append(covered)
        picture = "[cv]"
    if overlay:
        listing, y = overlay
        inputs += ["-f", "concat", "-safe", "0", "-i", listing]
        sub_index = inputs.count("-i") - 1
        parts.append(f"[{sub_index}:v]format=rgba[subs];{picture}[subs]overlay=0:{y}:eof_action=repeat:format=auto,format=yuv420p[v]")
        video_map, video_codec = "[v]", ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]
    elif covered:
        parts.append("[cv]format=yuv420p[v]")
        video_map, video_codec = "[v]", ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20"]
    elif info.get("vcodec") in COPYABLE_VIDEO:
        video_map, video_codec = "0:v:0", ["-c:v", "copy"] + (["-tag:v", "hvc1"] if info["vcodec"] == "hevc" else [])
    else:
        video_map, video_codec = "0:v:0", ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"]

    media.ffmpeg(
        *inputs,
        "-filter_complex", ";".join(parts),
        "-map", video_map, "-map", "[a]",
        *video_codec,
        "-c:a", "aac", "-b:a", "192k",
        "-t", f"{info['duration']:.3f}",
        "-movflags", "+faststart",
        out,
        what="Merging the Khmer voice into the video",
    )
    return out


def _level(normal: float, gaps: list[dict], in_gaps: float) -> str:
    """A volume expression: `normal`, but `in_gaps` inside the gaps."""
    if not gaps:
        return f"{normal:.3f}"
    inside = "+".join(f"between(t,{g['start']:.3f},{g['end']:.3f})" for g in gaps)
    return f"if(gt({inside},0),{in_gaps:.3f},{normal:.3f})"
