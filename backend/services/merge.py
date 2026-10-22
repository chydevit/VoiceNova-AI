"""Render a plan (render.py) into an MP4 with FFmpeg: the picture segments one after another, the
background and added sound mixed with the Khmer voice, and the title and subtitles on top."""
from pathlib import Path

import render
import watermarks
from services import cover, media

COPYABLE_VIDEO = {"h264", "hevc"}  # can go into MP4 untouched; anything else is re-encoded to H.264
QUALITY = {"high": ("veryfast", 20, "192k"), "medium": ("veryfast", 23, "160k"), "small": ("veryfast", 27, "128k")}
SAMPLE_RATE = 48000
ANIMATION = 0.35  # seconds a text takes to come in or go out; keep in sync with frontend lib/subtitleImages.js


def render_video(plan: dict, files: dict, info: dict, voice: Path, settings: dict, out: Path,
                 overlay: tuple[Path, int] | None = None, title: tuple[Path, int] | None = None,
                 texts: dict | None = None, on_progress=None, work: Path | None = None, watermarks: dict | None = None) -> Path:
    """files: media id -> its file ("stem": the upload's sound without the original voice).
    info: the upload's probe (size, fps, codec). `voice`: the Khmer voice track, in output time.
    `work`: a folder for the volume envelopes (next to `out` when not given).
    `watermarks`: watermark id -> (PNG, {x, y, width, height, corners}) — each watermark, drawn by the browser.
    `overlay` = (subtitle stream, y) and `title` = (PNG, y), both drawn by the browser at the canvas size.
    `texts`: text clip id -> (PNG, {x, y, width, height}) — each text clip, drawn by the browser."""
    texts = {cid: t for cid, t in (texts or {}).items()}
    pieces = [p for p in plan.get("texts", []) if p["clip"]["id"] in texts]
    marks = {}  # watermark id -> its pieces
    for p in plan.get("watermarks", []):
        if p["clip"]["id"] in (watermarks or {}):
            marks.setdefault(p["clip"]["id"], []).append(p)
    length = plan["length"]
    width, height = plan["canvas"]
    fps = info.get("fps") or 30
    export = settings.get("export") or {}
    preset, crf, audio_rate = QUALITY.get(export.get("quality"), QUALITY["high"])
    inputs: list[list[str]] = []

    def add(*args) -> int:
        inputs.append([str(a) for a in args])
        return len(inputs) - 1

    parts: list[str] = []
    segments = plan["video"]
    covered = cover.ffmpeg_chain(settings.get("cover"), info["width"], info["height"], src="[x]", out="[y]")
    one = segments[0] if len(segments) == 1 else None
    untouched = (
        one and one["kind"] == "video" and one["media"] == "source" and one["speed"] == 1 and one["source_in"] < 0.5 / fps
        and abs(one["source_out"] - info["duration"]) < 1.5 / fps and (width, height) == (info["width"], info["height"])
        and not covered and not overlay and not title and not pieces and not marks
    )
    if untouched and info.get("vcodec") in COPYABLE_VIDEO:  # nothing to draw: copy the picture as it is
        video_map = f"{add('-i', files['source'])}:v:0"
        video_codec = ["-c:v", "copy"] + (["-tag:v", "hvc1"] if info["vcodec"] == "hevc" else [])
    else:
        labels = []
        for k, seg in enumerate(segments):
            frames = round(seg["end"] * fps) - round(seg["start"] * fps)  # on the frame grid, so nothing drifts
            if frames <= 0:
                continue
            exact = f"fps={fps},tpad=stop_mode=clone:stop_duration=2,trim=end_frame={frames},setpts=PTS-STARTPTS,format=yuv420p[s{k}]"
            if seg["kind"] == "video":
                i = add("-ss", f"{seg['source_in']:.3f}", "-t", f"{seg['source_out'] - seg['source_in'] + 1:.3f}", "-i", files[seg["media"]])
                chain = f"[{i}:v]"
                if seg["media"] == "source" and covered:
                    parts.append(covered.replace("[x]", chain, 1).replace("[y]", f"[c{k}]"))
                    chain = f"[c{k}]"
                parts.append(f"{chain}setpts=(PTS-STARTPTS)/{seg['speed']},{_fit(width, height, export)},{exact}")
            elif seg["kind"] == "image":
                i = add("-loop", "1", "-framerate", fps, "-t", f"{seg['end'] - seg['start'] + 1:.3f}", "-i", files[seg["media"]])
                parts.append(f"[{i}:v]{_fit(width, height, export)},{exact}")
            else:
                parts.append(f"color=c=black:s={width}x{height}:r={fps},{exact}")
            labels.append(f"[s{k}]")
        if len(labels) > 1:
            parts.append(f"{''.join(labels)}concat=n={len(labels)}:v=1:a=0[vcat]")
            picture = "[vcat]"
        else:
            picture = labels[0]
        if title:
            png, y = title
            i = add("-i", png)
            parts.append(f"[{i}:v]format=rgba[title];{picture}[title]overlay=0:{y}:eof_action=repeat:format=auto[tv]")
            picture = "[tv]"
        for k, piece in enumerate(pieces):
            png, box = texts[piece["clip"]["id"]]
            picture = _text(parts, add, piece, png, box, fps, height, picture, k)
        if overlay:
            listing, y = overlay
            i = add("-f", "concat", "-safe", "0", "-i", listing)
            parts.append(f"[{i}:v]format=rgba[subs];{picture}[subs]overlay=0:{y}:eof_action=repeat:format=auto[sv]")
            picture = "[sv]"
        for k, (cid, mark_pieces) in enumerate(marks.items()):  # on top of everything
            png, box = watermarks[cid]
            picture = _watermark(parts, add, mark_pieces, png, box, fps, length, picture, k)
        parts.append(f"{picture}format=yuv420p[v]")
        video_map = "[v]"
        video_codec = ["-c:v", "libx264", "-preset", preset, "-crf", str(crf), "-r", str(fps)]

    audio = _audio(plan, files, voice, add, work or out.parent)
    parts.extend(audio)
    media.ffmpeg_progress(
        *[a for args in inputs for a in args],
        "-filter_complex", ";".join(parts),
        "-map", video_map, "-map", "[a]",
        *video_codec,
        "-c:a", "aac", "-b:a", audio_rate,
        "-t", f"{length:.3f}",
        "-movflags", "+faststart",
        out,
        seconds=length, on_progress=on_progress or (lambda f: None), what="Merging the Khmer voice into the video",
    )
    return out


def _text(parts: list[str], add, piece: dict, png: Path, box: dict, fps: float, height: int, picture: str, k: int) -> str:
    """Lay one text clip over the picture during its time, with its animation: fade, pop (it grows
    into place, a little past full size and back) or slide (it rises into place as it fades in)."""
    start, end = piece["start"], piece["end"]
    anim = piece["clip"].get("animation") or {}
    come = anim.get("in", "none") if piece["enters"] else "none"
    go = anim.get("out", "none") if piece["leaves"] else "none"
    d = min(ANIMATION, (end - start) / 2)
    i = add("-loop", "1", "-framerate", fps, "-t", f"{end - start + 0.1:.3f}", "-i", png)
    chain = f"[{i}:v]format=rgba,setpts=PTS-STARTPTS+{start:.3f}/TB"
    if come != "none":
        chain += f",fade=t=in:st={start:.3f}:d={d / 2 if come == 'pop' else d:.3f}:alpha=1"
    if go != "none":
        chain += f",fade=t=out:st={end - d:.3f}:d={d:.3f}:alpha=1"
    scales = []
    if come == "pop":
        p = f"clip((t-{start:.3f})/{d:.3f},0,1)"
        scales.append(f"(0.5+0.5*(1+2.70158*pow({p}-1,3)+1.70158*pow({p}-1,2)))")
    if go == "pop":
        q = f"clip((t-{end - d:.3f})/{d:.3f},0,1)"
        scales.append(f"(1-0.4*{q}*{q})")
    if scales:
        size = "*".join(scales)
        chain += f",scale=w='max(2,iw*{size})':h='max(2,ih*{size})':eval=frame"
    parts.append(f"{chain}[tx{k}]")
    cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    y = f"{cy:.1f}-h/2"
    if come == "slide":
        y += f"+{height * 0.06:.1f}*pow(1-clip((t-{start:.3f})/{d:.3f},0,1),2)"
    if go == "slide":
        y += f"-{height * 0.05:.1f}*pow(clip((t-{end - d:.3f})/{d:.3f},0,1),2)"
    parts.append(f"{picture}[tx{k}]overlay=x='{cx:.1f}-w/2':y='{y}':enable='between(t,{start:.3f},{end:.3f})':eof_action=pass:format=auto[pt{k}]")
    return f"[pt{k}]"


def _watermark(parts: list[str], add, pieces: list[dict], png: Path, box: dict, fps: float, length: float, picture: str, k: int) -> str:
    """Lay one watermark over the picture while it shows, with its animation (watermarks.animation_at,
    the same as the preview): fade in and out at its own start and end; a pulse, one period of its
    opacity drawn PULSE_RATE times a second and looped; a corner switch, its position changed every
    `every` seconds. Its look, opacity and rotation are in the PNG."""
    c = pieces[0]["clip"]
    anim = c.get("animation") or {}
    kind = anim.get("type", "none")
    start = pieces[0]["start"] - pieces[0]["since"]  # where the watermark starts and ends, in output time
    end = pieces[0]["start"] + pieces[0]["until"]
    enable = "+".join(f"between(t,{p['start']:.3f},{p['end'] - 0.0005:.4f})" for p in pieces)
    # The picture is read and turned into the video's colours once; the loop filter then repeats that
    # frame (decoding the PNG again for every frame made long exports several times slower).
    if kind == "pulse":
        n = max(1, round(anim["period"] * watermarks.PULSE_RATE))
        i = add("-loop", "1", "-framerate", watermarks.PULSE_RATE, "-i", png)
        a = f"alpha(X,Y)*(1-{watermarks.PULSE_DEPTH}*(1-cos(2*PI*N/{n}))/2)"
        chain = (f"[{i}:v]format=rgba,trim=end_frame={n},geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='{a}',format=yuva420p,"
                 f"loop=loop=-1:size={n},setpts=N/{watermarks.PULSE_RATE}/TB+{start:.3f}/TB")
    else:
        i = add("-i", png)
        chain = f"[{i}:v]format=yuva420p,loop=loop=-1:size=1,setpts=N/({fps})/TB,trim=end={length + 1:.3f}"
        if kind == "fade":
            d = min(anim["fade"], (end - start) / 2)
            chain += f",fade=t=in:st={start:.3f}:d={d:.3f}:alpha=1,fade=t=out:st={end - d:.3f}:d={d:.3f}:alpha=1"
    x, y = f"{box['x']:.1f}", f"{box['y']:.1f}"
    if kind == "corners" and c.get("kind") != "tiled" and box.get("corners"):
        first = watermarks.CORNERS.index(watermarks.nearest_corner(c["anchor"]))
        at = f"mod({first}+floor((t-{start:.3f})/{anim['every']}+1e-9),4)"
        pick = lambda axis: "if(eq({0},0),{1},if(eq({0},1),{2},if(eq({0},2),{3},{4})))".format(  # noqa: E731
            at, *(f"{p[axis]:.1f}" for p in box["corners"]))
        x, y = pick("x"), pick("y")
    parts.append(f"{chain}[wm{k}]")
    parts.append(f"{picture}[wm{k}]overlay=x='{x}':y='{y}':enable='{enable}':eof_action=pass:format=auto[wv{k}]")
    return f"[wv{k}]"


def _fit(width: int, height: int, export: dict) -> str:
    """Scale any picture onto the canvas: whole with black bars (fit), or filling it, cropped (fill)."""
    if export.get("fit") == "fill":
        return f"scale={width}:{height}:force_original_aspect_ratio=increase,crop={width}:{height},setsar=1"
    return (f"scale={width}:{height}:force_original_aspect_ratio=decrease:force_divisible_by=2,"
            f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1")


def _audio(plan: dict, files: dict, voice: Path, add, work: Path) -> list[str]:
    """Every run of background and added sound, placed at its time and multiplied by its volume
    envelope (render.envelope: its levels, fades, volume line and ducking, the same maths the
    preview plays), mixed with the Khmer voice.

    Each file is read once from its start and every run is cut out of it with atrim: seeking into
    an AAC file with -ss can drop its first 1024 samples, which would put the sound 23 ms early.
    The mix is stereo when any of its sound is (mono otherwise); a mono sound goes to both sides at
    its full level, as a browser plays it. The limiter only catches peaks above 0.95: its "auto
    level" would make everything louder than the preview, and without `latency` its look-ahead
    would put the sound 5 ms behind the picture."""
    parts, mix = [], []
    by_file: dict[str, list[int]] = {}
    for k, run in enumerate(plan["sound"]):
        path = str(files["stem"] if run["stream"] == "stem" else files[run["media"]])
        by_file.setdefault(path, []).append(k)
    channels = {path: media.audio_channels(Path(path)) for path in by_file}
    stereo = any(n > 1 for n in channels.values())

    def layout(n: int) -> str:  # n channels to the mix's layout
        if not stereo:
            return "pan=mono|c0=c0"
        return {1: "pan=stereo|c0=c0|c1=c0", 2: "pan=stereo|c0=c0|c1=c1"}.get(n, "aformat=channel_layouts=stereo")

    for path, ks in by_file.items():
        i = add("-i", path)
        if len(ks) > 1:
            parts.append(f"[{i}:a]asplit={len(ks)}" + "".join(f"[in{k}]" for k in ks))
            sources = {k: f"[in{k}]" for k in ks}
        else:
            sources = {ks[0]: f"[{i}:a]"}
        for k in ks:
            run = plan["sound"][k]
            chain = f"{sources[k]}atrim=start={run['source_in']:.4f}:end={run['source_out']:.4f},asetpts=PTS-STARTPTS,aresample={SAMPLE_RATE}"
            if abs(run["speed"] - 1) > 0.001:
                chain += "," + _tempo(run["speed"])
            parts.append(f"{chain},{layout(channels[path])}[run{k}]")
            env = add("-i", media.write_envelope(work / f"envelope{k}.wav", render.envelope(run), render.ENVELOPE_RATE))
            parts.append(f"[{env}:a]aresample={SAMPLE_RATE},{layout(1)}[env{k}]")
            delay = round(run["start"] * SAMPLE_RATE)
            parts.append(f"[run{k}][env{k}]amultiply,adelay=delays={delay}S:all=1[r{k}]")
            mix.append(f"[r{k}]")
    parts.append(f"[{add('-i', voice)}:a]aresample={SAMPLE_RATE},{layout(1)}[voice]")
    if mix:
        parts.append(f"{''.join(mix)}[voice]amix=inputs={len(mix) + 1}:duration=longest:normalize=0,alimiter=limit=0.95:level=0:latency=1,apad[a]")
    else:
        parts.append("[voice]apad[a]")
    return parts


def _tempo(speed: float) -> str:
    """atempo takes 0.5–2 per stage; chain stages for anything beyond."""
    stages = []
    while speed > 2.0:
        stages.append(2.0)
        speed /= 2.0
    while speed < 0.5:
        stages.append(0.5)
        speed /= 0.5
    stages.append(speed)
    return ",".join(f"atempo={s:.4f}" for s in stages)
