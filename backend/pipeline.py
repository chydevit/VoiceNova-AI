"""The background jobs:

prepare  – Extracting → Transcribing → Translating, then waits for the user to review
generate – the first "Generate Voice": a clip for every sentence, fitted to its time, then export 1
export   – from the editor: voices only the sentences that changed, then builds the chosen files

generate and export read their request (formats, subtitle images) from work/export.json.
"""
import json
import shutil
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import config
import history
import sentences
import store
from errors import AppError, LineError
from services import clips, fit, media, merge, separate, subtitles, transcribe, translate, tts, voicetrack

FORMATS = ("mp4", "mp4_subs", "srt", "audio")
FILE_NAMES = {"mp4": "khmer.mp4", "mp4_subs": "khmer-subtitled.mp4", "srt": "khmer.srt", "audio": "khmer-voice"}


def prepare(pid: str, progress) -> None:
    project = store.load(pid)
    folder, work = store.project_dir(pid), store.work_dir(pid)
    duration = project["video"]["duration"]
    language = None if project["source_lang"] == "auto" else project["source_lang"]
    items = project["sentences"]

    if items:  # "Try again" after translating failed: keep the transcript and the lines already translated
        detected = project["detected_lang"]
    else:
        progress.step("extract", "Extracting the audio…")
        wav = media.extract_audio(folder / project["video"]["file"], work / "speech16k.wav")
        (folder / "waveform.json").write_text(json.dumps(media.waveform(wav)), "utf-8")

        progress.step("transcribe", "Listening to the speech…")
        found, detected = transcribe.transcribe(wav, language, duration, lambda f: progress.update(f))
        settings = project["settings"]
        items = [
            sentences.make(f"s{i + 1}", s["start"], s["end"], original_text=s["text"], voice=settings["voice"], speed=settings["speed"])
            for i, s in enumerate(sorted(found, key=lambda s: s["start"]))
        ]
        store.update(pid, sentences=items, next_id=len(items) + 1, detected_lang=detected)

    lines = [
        {"id": s["id"], "text": s["original_text"], "room": (items[i + 1]["start"] if i + 1 < len(items) else duration) - s["start"]}
        for i, s in enumerate(items)
        if not s["khmer_text"]
    ]
    progress.step("translate", f"Translating {len(lines)} sentence{'s' if len(lines) != 1 else ''} into Khmer…")
    by_id = {s["id"]: s for s in items}

    def save(batch: dict[str, str]) -> None:
        for sid, text in batch.items():
            by_id[sid]["khmer_text"] = sentences.clean(text)
            sentences.refresh(by_id[sid])
        store.update(pid, sentences=items)

    if lines:
        translate.translate_lines(lines, language or detected, lambda f: progress.update(f), on_batch=save)
    missing = sum(1 for s in items if not s["khmer_text"])
    if missing:
        progress.warn(f"{missing} sentence{' was' if missing == 1 else 's were'} not translated — type the Khmer yourself before generating.")
    store.update(pid, sentences=items)


def generate(pid: str, progress) -> None:
    project = store.load(pid)
    folder = store.project_dir(pid)
    provider = _provider()
    todo = [(i, s) for i, s in enumerate(project["sentences"]) if s["khmer_text"]]
    if not todo:
        raise AppError("There are no Khmer lines to voice.", hint="Type the Khmer translation into at least one line.")
    shorten = translate.shorten if translate.provider() else None

    progress.step("voice", "Generating the Khmer voice…")
    changes: dict[str, dict] = {}
    failed: dict[str, AppError] = {}
    with ThreadPoolExecutor(max_workers=max(1, config.TTS_WORKERS)) as pool:
        futures = {pool.submit(fit.fit, folder, s, sentences.room_end(project, i), provider, shorten): s for i, s in todo}
        for done, future in enumerate(as_completed(futures), 1):
            s = futures[future]
            try:
                changes[s["id"]] = future.result()[0]
            except AppError as err:
                failed[s["id"]] = err
            progress.update(done / len(todo), f"Generating Khmer voice — line {done} of {len(todo)}")
    if not changes:
        first = next(iter(failed.values()))
        if not isinstance(first, LineError):
            raise first
        raise AppError("None of the lines could be voiced.", hint="Check the Khmer text and your voice settings, then try again.", detail=first.message)

    def apply(p: dict) -> None:
        for s in p["sentences"]:
            if s["id"] in changes:
                s.update(changes[s["id"]])
            elif s["id"] in failed:
                s["error"] = failed[s["id"]].message
            sentences.refresh(s)

    project = store.mutate(pid, apply)
    shortened = sum(1 for c in changes.values() if c.get("shortened"))
    if shortened:
        progress.warn(f"{shortened} line{'s were' if shortened != 1 else ' was'} shortened to fit the timing (marked in the editor).")
    if failed:
        progress.warn(f"{len(failed)} line{'s' if len(failed) != 1 else ''} couldn't be voiced: {next(iter(failed.values())).message}")
    _export(pid, progress)


def export(pid: str, progress) -> None:
    _export(pid, progress)


def _export(pid: str, progress) -> None:
    project = store.load(pid)
    folder, work = store.project_dir(pid), store.work_dir(pid)
    info, settings = project["video"], project["settings"]
    request = json.loads((work / "export.json").read_text("utf-8"))
    formats = [f for f in FORMATS if f in request["formats"]]

    # 1. Voice only what changed; every other clip is reused as it is.
    stale = [s for s in project["sentences"] if s["khmer_text"] and not sentences.has_clip(s)]
    if stale:
        provider = _provider()
        progress.step("voice", f"Voicing {len(stale)} changed sentence{'s' if len(stale) != 1 else ''}…")
        results = clips.ensure_many(folder, stale, provider, on_done=lambda d, n: progress.update(d / n, f"Voicing changed sentences — {d} of {n}"))
        errors: list[AppError] = []
        project = store.mutate(pid, lambda p: errors.extend(clips.apply(p, results)))
        if errors and len(errors) == len(stale) and not isinstance(errors[0], LineError):
            raise errors[0]  # the voice service is down: say so instead of exporting silence
        if errors:
            progress.warn(f"{len(errors)} sentence{'s' if len(errors) != 1 else ''} couldn't be voiced and will be silent: {errors[0].message}")

    # 2. The voice track, then each chosen file.
    progress.step("merge", "Building the Khmer voice track…")
    voice, report = voicetrack.build(folder, project["sentences"], info["duration"], work / "voice.wav")
    if not report["voiced"]:
        raise AppError("There are no voiced sentences to export.", hint="Type Khmer text and press Regenerate on at least one sentence.")
    n = history.next_version(project)
    vdir = history.version_dir(folder, n)
    vdir.mkdir(parents=True, exist_ok=True)
    files: dict[str, str] = {}
    video = folder / info["file"]

    background_track = None
    if settings["background"] == "separate" and ({"mp4", "mp4_subs"} & set(formats)):
        background_track = make_background(pid, lambda f: progress.update(0.1 * f, f"Removing the original voice… {round(f * 100)}%"))

    for k, kind in enumerate(formats):
        progress.update(0.1 + 0.9 * k / len(formats), {
            "mp4": "Merging the voice into the video…",
            "mp4_subs": "Burning in the Khmer subtitles…",
            "srt": "Writing the subtitles…",
            "audio": "Saving the Khmer audio…",
        }[kind])
        if kind == "mp4":
            out = merge.render(video, info, voice, settings, background_track, project["original_gaps"], None, vdir / FILE_NAMES[kind])
        elif kind == "mp4_subs":
            images_file = work / "subtitle_images.json"
            if not images_file.exists():
                raise AppError("The subtitle images are missing.", hint="Reload the page and export again.")
            request_images = json.loads(images_file.read_text("utf-8"))
            strip = request_images["layout"] or {"y": 0, "width": info["width"], "height": info["height"]}
            overlay = subtitles.build_overlay(project["sentences"], info["duration"], request_images["images"], strip, work)
            out = merge.render(video, info, voice, settings, background_track, project["original_gaps"], overlay, vdir / FILE_NAMES[kind])
        elif kind == "srt":
            bilingual = project["settings"]["subtitle_style"].get("bilingual", False)
            out = subtitles.write_srt(project["sentences"], info["duration"], vdir / FILE_NAMES[kind], bilingual)
        else:
            out = media.export_audio(voice, vdir / f"{FILE_NAMES[kind]}.{request.get('audio_format', 'mp3')}")
        files[kind] = str(out.relative_to(folder))

    if report["cut"]:
        progress.warn(f"{report['cut']} sentence{'s are' if report['cut'] != 1 else ' is'} longer than {'their' if report['cut'] != 1 else 'its'} time and had the end cut — use “Fix automatically” in the editor.")
    if report["missing"]:
        progress.warn(f"{report['missing']} sentence{'s have' if report['missing'] != 1 else ' has'} no voice and {'are' if report['missing'] != 1 else 'is'} silent.")

    def finish(p: dict) -> None:
        options = {"formats": formats, "audio_format": request.get("audio_format", "mp3"), "settings": dict(p["settings"])}
        history.add_version(p, folder, n, files, options)
        p["step"] = "done"

    store.mutate(pid, finish)


def _provider():
    provider = tts.get()
    ok, reason = provider.status()
    if not ok:
        raise AppError(f"The {provider.label} voice isn't ready.", hint=reason)
    return provider


def write_request(pid: str, formats: list[str], audio_format: str, subtitle_images: dict | None, layout=None) -> None:
    work = store.work_dir(pid)
    (work / "export.json").write_text(json.dumps({"formats": formats, "audio_format": audio_format}), "utf-8")
    if subtitle_images:
        # Older pages send full-frame images and no layout; the strip is then the whole frame.
        strip = layout.model_dump() if layout else None
        (work / "subtitle_images.json").write_text(json.dumps({"layout": strip, "images": subtitle_images}), "utf-8")


def download_name(project: dict, kind: str, path: str) -> str:
    stem = Path(project["name"]).stem
    suffix = {"mp4": "-khmer", "mp4_subs": "-khmer-subtitled", "srt": "-khmer", "audio": "-khmer-voice"}.get(kind, "")
    return f"{stem}{suffix}{Path(path).suffix}"


# ---------- removing the original voice ----------

BACKGROUND_TRACK = "background_no_vocals.m4a"  # music & effects without the original voice, made once per project


def make_background(pid: str, on_progress=None) -> Path:
    """The project's background track without the original voice (Demucs), made once and reused by
    every export and by the editor's preview. Also saves its waveform for the timeline."""
    folder = store.project_dir(pid)
    out = folder / BACKGROUND_TRACK
    if not out.exists():
        project = store.load(pid)
        work = folder / "separate_work"  # not work/: an export job may be using that
        last = [-1]

        def progress(fraction: float) -> None:
            if on_progress and round(fraction * 100) != last[0]:  # Demucs reports many times a second
                last[0] = round(fraction * 100)
                on_progress(fraction)

        try:
            separate.remove_vocals(folder / project["video"]["file"], work, out, progress)
        finally:
            shutil.rmtree(work, ignore_errors=True)
    wave = folder / "waveform_background.json"
    if not wave.exists():
        wave.write_text(json.dumps(media.waveform(out)), "utf-8")
    return out


def separate_task(pid: str, report) -> None:
    """Side task started from the editor; editing goes on while it runs."""
    report(0.0, f"Removing the original voice (on the {'GPU' if separate.device() != 'cpu' else 'CPU'})…")
    make_background(pid, lambda f: report(f, f"Removing the original voice… {round(f * 100)}%"))
