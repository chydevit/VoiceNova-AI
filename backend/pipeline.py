"""The background jobs:

prepare  – Extracting → Transcribing → Translating, then waits for the user to review
generate – the first "Generate Voice": a clip for every sentence, fitted to its time, then export 1
export   – from the editor: voices only the sentences that changed, then builds the chosen files

generate and export read their request (formats, subtitle images) from work/export.json.
"""
import base64
import json
import re
import shutil
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import briefs
import config
import history
import jobs
import render
import sentences
import store
import timeline
from errors import AppError, LineError
from services import clips, fit, media, merge, separate, subtitles, transcribe, translate, tts, voicetrack

FORMATS = ("mp4", "mp4_subs", "srt", "audio")
FILE_NAMES = {"mp4": "khmer.mp4", "mp4_subs": "khmer-subtitled.mp4", "srt": "khmer.srt", "audio": "khmer-voice"}


def prepare(pid: str, progress) -> None:
    project = store.load(pid)
    folder, work = store.project_dir(pid), store.work_dir(pid)
    duration = project["video"]["duration"]
    language = None if project["source_lang"] == "auto" else project["source_lang"]
    items = sentences.items(project)

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
        _set_sentences(pid, items, next_id=len(items) + 1, detected_lang=detected)

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
        _set_sentences(pid, items)

    if lines:
        # first one look at the whole transcript: the topic, one spelling per name, misheard words (briefs.py)
        progress.update(0.0, "Reading the whole transcript first: names, terms, misheard words…")
        brief = briefs.get(pid)
        progress.update(0.0, f"Translating {len(lines)} sentence{'s' if len(lines) != 1 else ''} into Khmer…")
        translate.translate_lines(lines, language or detected, lambda f: progress.update(f), on_batch=save, brief=brief)
    missing = sum(1 for s in items if not s["khmer_text"])
    if missing:
        progress.warn(f"{missing} sentence{' was' if missing == 1 else 's were'} not translated — type the Khmer yourself before generating.")
    _set_sentences(pid, items)


def _set_sentences(pid: str, items: list[dict], **fields) -> None:
    """Put the transcribed / translated sentences on the voice track (before the first voicing, no undo)."""
    def apply(p: dict) -> None:
        timeline.track(p, "voice")["clips"] = items
        p.update(fields)

    store.mutate(pid, apply)


def generate(pid: str, progress) -> None:
    project = store.load(pid)
    folder = store.project_dir(pid)
    provider = _provider()
    todo = [(i, s) for i, s in enumerate(sentences.items(project)) if s["khmer_text"]]
    if not todo:
        raise AppError("There are no Khmer lines to voice.", hint="Type the Khmer translation into at least one line.")
    shorten = translate.shorten if translate.provider() else None
    respell = translate.respeller(source_language(project)) if translate.provider() else None

    progress.step("voice", "Generating the Khmer voice…")
    changes: dict[str, dict] = {}
    failed: dict[str, AppError] = {}
    with ThreadPoolExecutor(max_workers=max(1, config.TTS_WORKERS)) as pool:
        futures = {pool.submit(fit.fit, folder, s, sentences.room_end(project, i), provider, shorten, respell): s for i, s in todo}
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
        for s in sentences.items(p):
            if s["id"] in changes:
                s.update(changes[s["id"]])
            elif s["id"] in failed:
                s["error"] = failed[s["id"]].message
            sentences.refresh(s)

    project = store.mutate(pid, apply)
    respelled = sum(1 for c in changes.values() if "khmer_text" in c and not c.get("shortened"))
    if respelled:
        progress.warn(f"{respelled} line{'s had' if respelled != 1 else ' had'} words in other letters (Thai, Chinese…) that the Khmer voice skips — they were written in Khmer.")
    _warn_voices(sentences.items(project), progress)
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

    # 1. Voice only what changed; every other clip is reused as it is. Skipped sentences, and the
    #    ones inside skipped parts of the video, are left out (and not voiced).
    played = {s["id"] for s in render.plan(project)["voice"]}
    stale = [s for s in sentences.items(project) if s["id"] in played and s["khmer_text"] and not sentences.has_clip(s)]
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
        _warn_voices([s for s in sentences.items(project) if s["id"] in {x["id"] for x in stale}], progress)

    # 2. The voice track, then each chosen file.
    progress.step("merge", "Building the Khmer voice track…")
    background_track = None
    if settings["background"] == "separate" and ({"mp4", "mp4_subs"} & set(formats)):
        background_track = make_background(pid, lambda f: progress.update(0.1 * f, f"Removing the original voice… {round(f * 100)}%"))
    plan = render.plan(project, stem_ready=background_track is not None)
    if plan["length"] < 0.1:
        raise AppError("There is nothing left to export.", hint="Every part of the timeline is skipped or empty — un-skip a part of the video.")
    voice, report = voicetrack.build(folder, plan["voice"], timeline.end(project), work / "voice.wav", plan["voice_volume"])
    if not report["voiced"] and not timeline.track(project, "voice")["muted"]:
        raise AppError("There are no voiced sentences to export.", hint="Type Khmer text and press Regenerate on at least one sentence.")
    voice = voicetrack.cut(voice, plan["kept"], plan["length"], work / "voice_out.wav")
    n = history.next_version(project)
    vdir = history.version_dir(folder, n)
    vdir.mkdir(parents=True, exist_ok=True)
    files: dict[str, str] = {}
    sources = {"source": folder / info["file"], "stem": background_track,
               **{mid: folder / m["file"] for mid, m in project.get("media", {}).items() if mid != "source"}}

    title = None  # (PNG, y) of the title at the top, drawn by the browser
    if settings.get("title", {}).get("text", "").strip() and (work / "title.json").exists():
        title = (work / "title.png", json.loads((work / "title.json").read_text("utf-8"))["y"])
    texts = {}  # text clip id -> (PNG, box), drawn by the browser
    boxes = work / "texts" / "boxes.json"
    if boxes.exists():
        texts = {cid: (work / "texts" / f"{cid}.png", box) for cid, box in json.loads(boxes.read_text("utf-8")).items()}
    missing = [p["clip"]["id"] for p in plan["texts"] if p["clip"]["id"] not in texts]
    if missing and ({"mp4", "mp4_subs"} & set(formats)):
        raise AppError("Some text pictures are missing.", hint="Reload the page and export again.")
    marks = {}  # watermark id -> (PNG, box), drawn by the browser
    if request.get("watermark", True):
        mark_boxes = work / "watermarks" / "boxes.json"
        if mark_boxes.exists():
            marks = {cid: (work / "watermarks" / f"{cid}.png", box) for cid, box in json.loads(mark_boxes.read_text("utf-8")).items()}
        if any(p["clip"]["id"] not in marks for p in plan["watermarks"]) and ({"mp4", "mp4_subs"} & set(formats)):
            raise AppError("Some watermark pictures are missing.", hint="Reload the page and export again.")
    else:
        plan["watermarks"] = []  # exported without them

    # The videos take nearly all the time: share the bar between them by their length.
    videos = [k for k in formats if k in ("mp4", "mp4_subs")]
    share = {k: (0.9 / len(videos) if k in videos else 0.0) for k in formats}
    reached = 0.1
    labels = {"mp4": "Making the video", "mp4_subs": "Making the video with subtitles", "srt": "Writing the subtitles…", "audio": "Saving the Khmer audio…"}
    for kind in formats:
        base = reached
        progress.update(base, labels[kind] + ("…" if kind in videos else ""))

        def step(f: float, base=base, kind=kind) -> None:
            progress.update(base + share[kind] * f, f"{labels[kind]} — {round(f * 100)}%")

        reached += share[kind]
        if kind == "mp4":
            out = merge.render_video(plan, sources, info, voice, settings, vdir / FILE_NAMES[kind], None, title, texts, on_progress=step, work=work, watermarks=marks)
        elif kind == "mp4_subs":
            images_file = work / "subtitle_images.json"
            if not images_file.exists():
                raise AppError("The subtitle images are missing.", hint="Reload the page and export again.")
            request_images = json.loads(images_file.read_text("utf-8"))
            width, height = plan["canvas"]
            strip = request_images["layout"] or {"y": 0, "width": width, "height": height}
            overlay = subtitles.build_overlay(plan["burned"], plan["length"], request_images["images"], strip, work)
            out = merge.render_video(plan, sources, info, voice, settings, vdir / FILE_NAMES[kind], overlay, title, texts, on_progress=step, work=work, watermarks=marks)
        elif kind == "srt":
            bilingual = settings["subtitle_style"].get("bilingual", False)
            out = subtitles.write_srt(plan["subtitles"], vdir / FILE_NAMES[kind], bilingual)
        else:
            out = media.export_audio(voice, vdir / f"{FILE_NAMES[kind]}.{request.get('audio_format', 'mp3')}")
        files[kind] = str(out.relative_to(folder))

    left_out = sum(1 for s in sentences.items(project) if s["khmer_text"] and s["id"] not in played)
    if left_out:
        progress.warn(f"{left_out} sentence{'s are' if left_out != 1 else ' is'} skipped or inside skipped parts of the video, and {'were' if left_out != 1 else 'was'} left out.")
    if report["cut"]:
        progress.warn(f"{report['cut']} sentence{'s are' if report['cut'] != 1 else ' is'} longer than {'their' if report['cut'] != 1 else 'its'} time and had the end cut — use “Fix automatically” in the editor.")
    if report["missing"]:
        progress.warn(f"{report['missing']} sentence{'s have' if report['missing'] != 1 else ' has'} no voice and {'are' if report['missing'] != 1 else 'is'} silent.")

    def finish(p: dict) -> None:
        options = {"formats": formats, "audio_format": request.get("audio_format", "mp3"), "settings": dict(p["settings"])}
        history.add_version(p, folder, n, files, options)
        p["step"] = "done"

    store.mutate(pid, finish)


def source_language(project: dict) -> str | None:
    return project["detected_lang"] if project["source_lang"] == "auto" else project["source_lang"]


def _warn_voices(items: list[dict], progress) -> None:
    flagged = sum(1 for s in items if s.get("voice_warning"))
    if flagged:
        progress.warn(f"{flagged} line{'s' if flagged != 1 else ''} may sound wrong even after voicing {'them' if flagged != 1 else 'it'} again — marked “Check voice” in the editor.")


def _provider():
    provider = tts.get()
    ok, reason = provider.status()
    if not ok:
        raise AppError(f"The {provider.label} voice isn't ready.", hint=reason)
    return provider


def write_request(pid: str, formats: list[str], audio_format: str, subtitle_images: dict | None, layout=None, title=None, texts=None,
                  marks=None, with_watermark: bool = True) -> None:
    work = store.work_dir(pid)
    (work / "title.json").unlink(missing_ok=True)
    shutil.rmtree(work / "texts", ignore_errors=True)
    shutil.rmtree(work / "watermarks", ignore_errors=True)
    if marks:  # each watermark as the browser drew it, at the exported size
        (work / "watermarks").mkdir()
        boxes = {}
        for cid, image in marks.items():
            if not re.fullmatch(r"[A-Za-z0-9_]+", cid):
                continue
            (work / "watermarks" / f"{cid}.png").write_bytes(base64.b64decode(image.data.split(",", 1)[1]))
            boxes[cid] = {"x": image.x, "y": image.y, "width": image.width, "height": image.height,
                          "corners": [p.model_dump() for p in image.corners] if image.corners else None}
        (work / "watermarks" / "boxes.json").write_text(json.dumps(boxes), "utf-8")
    if texts:  # each text clip as the browser drew it
        (work / "texts").mkdir()
        boxes = {}
        for cid, image in texts.items():
            if not re.fullmatch(r"[A-Za-z0-9_]+", cid):
                continue
            (work / "texts" / f"{cid}.png").write_bytes(base64.b64decode(image.data.split(",", 1)[1]))
            boxes[cid] = {"x": image.x, "y": image.y, "width": image.width, "height": image.height}
        (work / "texts" / "boxes.json").write_text(json.dumps(boxes), "utf-8")
    if title:
        (work / "title.png").write_bytes(base64.b64decode(title.data.split(",", 1)[1]))
        (work / "title.json").write_text(json.dumps({"y": title.y}), "utf-8")
    (work / "export.json").write_text(json.dumps({"formats": formats, "audio_format": audio_format, "watermark": with_watermark}), "utf-8")
    if subtitle_images:
        # Older pages send full-frame images and no layout; the strip is then the whole frame.
        strip = layout.model_dump() if layout else None
        (work / "subtitle_images.json").write_text(json.dumps({"layout": strip, "images": subtitle_images}), "utf-8")


def download_name(project: dict, kind: str, path: str) -> str:
    stem = Path(project["name"]).stem
    suffix = {"mp4": "-khmer", "mp4_subs": "-khmer-subtitled", "srt": "-khmer", "audio": "-khmer-voice"}.get(kind, "")
    return f"{stem}{suffix}{Path(path).suffix}"


# ---------- preview copies ----------

_proxy_guard = threading.Lock()
_proxy_running: set[str] = set()
_proxy_failed: set[str] = set()  # not tried again until the server restarts


def ensure_proxies(pid: str, project: dict) -> None:
    """Start making the preview copy of every video that doesn't have one yet."""
    folder = store.project_dir(pid)
    for mid, m in (project.get("media") or {}).items():
        if m.get("kind") != "video" or (m.get("proxy") and (folder / m["proxy"]).exists()) or not m.get("file") or not (folder / m["file"]).exists():
            continue
        key = f"{pid}/{mid}"
        with _proxy_guard:
            if key in _proxy_running or key in _proxy_failed:
                continue
            _proxy_running.add(key)
        jobs.start_media(_make_proxy, pid, mid, key)


def _make_proxy(pid: str, mid: str, key: str) -> None:
    try:
        folder = store.project_dir(pid)
        m = store.load(pid)["media"][mid]
        (folder / "proxy").mkdir(exist_ok=True)
        media.make_proxy(folder / m["file"], folder / "proxy" / f"{mid}.mp4", m.get("fps") or 30)

        def done(p: dict) -> None:
            if mid in p.get("media", {}):
                p["media"][mid]["proxy"] = f"proxy/{mid}.mp4"

        store.mutate(pid, done)
    except Exception:
        _proxy_failed.add(key)
        raise
    finally:
        with _proxy_guard:
            _proxy_running.discard(key)


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


# ---------- many sentences at once: voice them, translate them again, fit them to their time ----------
# A side task (project["batch"]): editing goes on while it runs. Changed text and timing are one undo
# step; voice clips are just files, so voicing is not one.

BATCH_KINDS = ("voice", "restyle", "fit")
VOICE_CHUNK = 24  # sentences voiced between two saves, so finished clips show up as it goes


def batch_task(pid: str, report, kind: str, ids: list[str], style: str | None = None, force: bool = True) -> None:
    project = store.load(pid)
    wanted = set(ids)
    items = [s for s in sentences.items(project) if s["id"] in wanted]
    if not items:
        return
    if kind == "restyle":
        ids = _restyle(pid, project, items, style, report)
        force = False  # the new text needs new clips anyway; unchanged text keeps its clip
    elif kind == "fit":
        _fit_many(pid, project, items, report)
        return
    _voice_many(pid, ids, force, report, start=0.5 if kind == "restyle" else 0.0)


def _restyle(pid: str, project: dict, items: list[dict], style: str, report) -> list[str]:
    report(0.0, f"Translating {len(items)} sentence{'s' if len(items) != 1 else ''} again ({style})…")
    index = {s["id"]: i for i, s in enumerate(sentences.items(project))}
    lines = [{"id": s["id"], "text": s["original_text"], "room": sentences.room_end(project, index[s["id"]]) - s["start"], "khmer": s["khmer_text"]}
             for s in items]
    texts = translate.restyle(lines, source_language(project), style, on_progress=lambda f: report(0.5 * f, f"Translating again… {round(f * 100)}%"),
                              brief=briefs.get(pid, project))
    before = {s["id"]: s["khmer_text"] for s in items}
    changed: list[str] = []

    def apply(p: dict) -> None:
        for s in sentences.items(p):
            new = texts.get(s["id"])
            if new and s["khmer_text"] == before.get(s["id"]) and sentences.clean(new) != s["khmer_text"]:  # not edited meanwhile
                sentences.patch(p, s["id"], {"khmer_text": new}, tts.get().genders)
                changed.append(s["id"])

    store.edit(pid, apply, "Translate again")
    if not texts:
        raise AppError("The translator didn't send anything back.", hint="Try again in a moment.")
    return changed


def _voice_many(pid: str, ids: list[str], force: bool, report, start: float = 0.0) -> None:
    provider = _provider()
    folder = store.project_dir(pid)
    project = store.load(pid)
    wanted = set(ids)
    targets = [dict(s) for s in sentences.items(project) if s["id"] in wanted and s["khmer_text"]]
    if not targets:
        return

    def mark(p: dict) -> None:
        for s in sentences.items(p):
            if s["id"] in wanted and s["khmer_text"]:
                s["status"] = "regenerating"

    store.mutate(pid, mark)
    failed: list[AppError] = []
    try:
        for k in range(0, len(targets), VOICE_CHUNK):
            chunk = targets[k:k + VOICE_CHUNK]
            results = clips.ensure_many(folder, chunk, provider, force)
            store.mutate(pid, lambda p, r=results: failed.extend(clips.apply(p, r)))
            done = min(len(targets), k + VOICE_CHUNK)
            report(start + (1 - start) * done / len(targets), f"Voicing — {done} of {len(targets)}")
            if failed and len(failed) == done and not isinstance(failed[0], LineError):
                raise failed[0]  # the voice service is down: stop instead of failing every line
    finally:
        def finish(p: dict) -> None:
            for s in sentences.items(p):
                if s["id"] in wanted and s["status"] == "regenerating":
                    sentences.refresh(s)

        store.mutate(pid, finish)
    if failed:
        raise AppError(f"{len(failed)} of {len(targets)} sentences couldn't be voiced.", hint="The others are done. Press Regenerate on the red ones to try again.",
                       detail=failed[0].message)


def _fit_many(pid: str, project: dict, items: list[dict], report) -> None:
    """“Fix automatically” for many sentences: each uses the pause after it, speeds up a little, or
    gets a shorter line — one undo step for all of them."""
    provider = _provider()
    folder = store.project_dir(pid)
    ready = translate.provider()
    shorten = translate.shorten if ready else None
    respell = translate.respeller(source_language(project)) if ready else None
    index = {s["id"]: i for i, s in enumerate(sentences.items(project))}
    changes: dict[str, dict] = {}
    with ThreadPoolExecutor(max_workers=max(1, config.TTS_WORKERS)) as pool:
        futures = {pool.submit(fit.fit, folder, s, sentences.room_end(project, index[s["id"]]), provider, shorten, respell): s for s in items if s["khmer_text"]}
        for done, future in enumerate(as_completed(futures), 1):
            s = futures[future]
            try:
                changes[s["id"]] = future.result()[0]
            except AppError:
                pass  # it keeps its warning
            report(done / len(futures), f"Fitting — {done} of {len(futures)}")
    before = {s["id"]: s for s in items}

    def apply(p: dict) -> None:
        for cur in sentences.items(p):
            old = before.get(cur["id"])
            if old and cur["id"] in changes and all(cur[k] == old[k] for k in ("khmer_text", "voice", "speed", "start", "end")):
                cur.update(changes[cur["id"]])
                sentences.refresh(cur)

    store.edit(pid, apply, "Fix timing")
