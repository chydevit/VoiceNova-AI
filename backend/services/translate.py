"""Translate speech into natural, spoken Khmer with an LLM.

Providers (TRANSLATE_PROVIDER): anthropic (Claude), gemini (Google), openai — or
"auto", which uses the first one that has an API key in .env.
"""
import json
import logging
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

import anthropic
import httpx

import config
from errors import AppError
from services import voicecheck

SCHEMA = {
    "type": "object",
    "properties": {
        "lines": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {"id": {"type": "string"}, "text": {"type": "string"}},
                "required": ["id", "text"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["lines"],
    "additionalProperties": False,
}

log = logging.getLogger("translate")

KHMER_CHARS_PER_SECOND = 11  # what a Khmer voice comfortably says per second (Unicode characters)
CHUNK = 20  # lines per request
RETRY_CHUNK = 5  # lines per request when asking again for lines that came back missing
MAX_SINGLE = 40  # at most this many lines are then asked for one by one
BRIEF_CHARS = 30000  # of the transcript read for the brief (a longer one is sampled evenly)

SYSTEM = """You translate the speech in a video into Khmer (ភាសាខ្មែរ) for an AI voiceover.

- Write natural, spoken Khmer the way Cambodians really talk: clear and conversational, not word-for-word and not stiff written style. Keep each line's meaning, tone and emotion.
- Choose pronouns and politeness that fit the speaker and situation (for example ខ្ញុំ / អ្នក / បង / ប្អូន / លោក).
- Each line is voiced inside the original line's time slot. Every line has a character budget; stay at or under it. If the full meaning will not fit, keep the main point and drop filler words.
- Write numbers, dates, money and symbols as Khmer words (25 → ម្ភៃប្រាំ, $10 → ដប់ដុល្លារ) so the voice reads them correctly.
- Write people's and place names in Khmer script by sound (John → ចន), or with their usual Khmer spelling. When the video's brief gives a spelling for a name or term, always use that one, so it is the same in every line.
- The original lines come from automatic speech recognition, so some words are misheard: a wrong word that sounds like the right one (very common in Chinese, e.g. 赌债 heard as 筷债). When a line doesn't make sense, work out from the context and the brief what was most likely said, and translate that.
- Translate every line, even short ones like "Yes" or "Wow". Do not merge, split, reorder or explain lines.
- "text" must contain only the Khmer line: no quotes, brackets, notes or romanization."""

LANG_NAMES = {
    "en": "English", "zh": "Chinese", "th": "Thai", "vi": "Vietnamese", "ko": "Korean", "ja": "Japanese",
    "fr": "French", "es": "Spanish", "de": "German", "ru": "Russian", "id": "Indonesian", "ms": "Malay",
    "lo": "Lao", "hi": "Hindi", "ar": "Arabic", "pt": "Portuguese", "it": "Italian", "tl": "Tagalog", "km": "Khmer",
}

FALLBACK_MODELS = {"claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"}


def provider() -> str | None:
    keys = {"anthropic": config.ANTHROPIC_API_KEY, "gemini": config.GEMINI_API_KEY, "openai": config.OPENAI_API_KEY}
    if config.TRANSLATE_PROVIDER in keys:
        return config.TRANSLATE_PROVIDER if keys[config.TRANSLATE_PROVIDER] else None
    return next((name for name, key in keys.items() if key), None)


def status() -> dict:
    name = provider()
    if name:
        model = {"anthropic": config.ANTHROPIC_MODEL, "gemini": config.GEMINI_MODEL, "openai": config.OPENAI_MODEL}[name]
        return {"provider": name, "model": model, "ok": True, "reason": ""}
    wanted = config.TRANSLATE_PROVIDER
    reason = f"{wanted} is chosen but its API key is empty — add it in Settings" if wanted != "auto" else "add a Gemini, Claude or OpenAI API key in Settings"
    return {"provider": None, "ok": False, "reason": reason}


def budget(seconds: float) -> int:
    return max(4, round(seconds * KHMER_CHARS_PER_SECOND))


BRIEF_SYSTEM = """You prepare the transcript of a video for its translation into Khmer (ភាសាខ្មែរ). The transcript comes from automatic speech recognition, so some words are misheard: a wrong word that sounds like the right one (very common in Chinese).

Read all of it and return:
- "topic": one or two sentences in English: what the video is about, its setting and era, and who talks to whom, so the translator picks the right tone and pronouns.
- "names": the people, places and groups, each with ONE Khmer spelling to use every time (by sound, or the usual Khmer name), and a few words on who or what it is.
- "terms": words that must be translated the same way every time (titles, ranks, units of money, products), with their Khmer.
- "misheard": words or phrases the speech recognition most likely got wrong, as heard → what was most likely said, in the original language. Only ones the context makes clear.
Keep each list to the 30 most important entries. Never invent people or events that aren't in the transcript."""

_PAIR = {"type": "object", "additionalProperties": False}
BRIEF_SCHEMA = {
    "type": "object",
    "properties": {
        "topic": {"type": "string"},
        "names": {"type": "array", "items": {**_PAIR, "properties": {"original": {"type": "string"}, "khmer": {"type": "string"}, "note": {"type": "string"}}, "required": ["original", "khmer", "note"]}},
        "terms": {"type": "array", "items": {**_PAIR, "properties": {"original": {"type": "string"}, "khmer": {"type": "string"}}, "required": ["original", "khmer"]}},
        "misheard": {"type": "array", "items": {**_PAIR, "properties": {"heard": {"type": "string"}, "meant": {"type": "string"}}, "required": ["heard", "meant"]}},
    },
    "required": ["topic", "names", "terms", "misheard"],
    "additionalProperties": False,
}


def brief(texts: list[str], source_lang: str | None) -> dict | None:
    """One look at the whole transcript before translating it: what the video is about, one Khmer
    spelling for each name and special term, and the words the speech recognition probably misheard.
    Every request then gets it (brief_text), so names stay the same in every batch and misheard words
    are understood. A long transcript is sampled evenly. None when there's too little to go on or the
    service fails (translating then goes on without it)."""
    lines = [" ".join(t.split()) for t in texts if t and t.strip()]
    if len(lines) < 3:
        return None
    total = sum(len(t) + 1 for t in lines)
    if total > BRIEF_CHARS:
        lines = lines[::-(-total // BRIEF_CHARS)]
    src = LANG_NAMES.get(source_lang or "", "the original language")
    try:
        data = _call(BRIEF_SYSTEM, f"The transcript ({src}), one line each:\n" + "\n".join(lines), BRIEF_SCHEMA)
    except AppError as err:
        log.warning("couldn't make the translation brief: %s", err.message)
        return None

    def pairs(items, a: str, b: str, khmer: bool) -> list[dict]:
        out = []
        for x in items if isinstance(items, list) else []:
            left, right = _clean(x.get(a, "")), _clean(x.get(b, ""))
            if left and right and left != right and (not khmer or (is_khmer(right) and KHMER_SCRIPT.search(right))):
                item = {a: left[:80], b: right[:80]}
                if x.get("note"):
                    item["note"] = _clean(x["note"])[:80]
                out.append(item)
        return out[:30]

    out = {
        "topic": _clean(data.get("topic", ""))[:400],
        "names": pairs(data.get("names"), "original", "khmer", True),
        "terms": pairs(data.get("terms"), "original", "khmer", True),
        "misheard": pairs(data.get("misheard"), "heard", "meant", False),
    }
    return out if out["topic"] or out["names"] or out["terms"] or out["misheard"] else None


def brief_text(b: dict | None) -> str:
    """The brief as a part of a request ("" without one)."""
    if not b:
        return ""
    parts = []
    if b.get("topic"):
        parts.append(b["topic"])
    if b.get("names"):
        parts.append("Names, always spelled this way: " + "; ".join(f'{n["original"]} → {n["khmer"]}' + (f' ({n["note"]})' if n.get("note") else "") for n in b["names"]))
    if b.get("terms"):
        parts.append("Terms, always translated this way: " + "; ".join(f'{t["original"]} → {t["khmer"]}' for t in b["terms"]))
    if b.get("misheard"):
        parts.append("Probably misheard by the speech recognition (heard → most likely said): " + "; ".join(f'{m["heard"]} → {m["meant"]}' for m in b["misheard"]))
    return "About this video (the brief):\n" + "\n".join(parts) if parts else ""


def translate_lines(lines: list[dict], source_lang: str | None, on_progress, on_batch=None, brief: dict | None = None) -> dict[str, str]:
    """`lines`: [{id, text, room}] in order, `room` = seconds available. Returns {id: khmer}.

    Batches run in parallel. `on_batch({id: khmer})` is called as lines come in, so a failure later
    on doesn't lose the lines already translated. Lines that come back missing (skipped, or not in
    Khmer) are asked for again in small runs, then one by one; only if some are still missing
    because the service kept failing is that an error. `brief` (see brief()) is given to every request."""
    src = LANG_NAMES.get(source_lang or "", "the original language")
    about = brief_text(brief)
    starts = range(0, len(lines), CHUNK)
    result: dict[str, str] = {}
    errors: list[AppError] = []

    def keep(batch: dict[str, str]) -> None:
        if batch:
            result.update(batch)
            if on_batch:
                on_batch(batch)

    with ThreadPoolExecutor(max_workers=max(1, config.TRANSLATE_WORKERS)) as pool:
        futures = [pool.submit(_translate_batch, lines, start, src, about) for start in starts]
        for done, future in enumerate(as_completed(futures), 1):
            try:
                keep(future.result())
            except AppError as err:
                errors.append(err)
            on_progress(0.85 * done / len(futures))
    missing = [l for l in lines if l["id"] not in result]
    if missing:
        log.info("%d of %d lines came back without Khmer; asking for them again", len(missing), len(lines))
        _ask_again(lines, missing, src, about, keep, lambda sid: sid in result, errors, lambda f: on_progress(0.85 + 0.15 * f))
    on_progress(1.0)
    still = sum(1 for l in lines if l["id"] not in result)
    if still and errors:
        err = errors[0]
        if result:
            raise AppError(err.message, hint=f"{len(result)} of {len(lines)} lines are translated and kept. Press “Try again” to translate the rest.", detail=err.detail)
        raise err
    return result


def _translate_batch(lines: list[dict], start: int, src: str, about: str = "") -> dict[str, str]:
    chunk = lines[start:start + CHUNK]
    result = _translate_chunk(chunk, lines[max(0, start - 4):start], lines[start + CHUNK:start + CHUNK + 3], src, about=about)
    wrong = [l for l in chunk if l["id"] not in result]
    if wrong:  # missing, or answered in another language (it happens with small models): ask once more
        retry = _translate_chunk(wrong, [], [], src, note=(
            "IMPORTANT: a previous answer for these lines was not in Khmer. "
            "Write every line in Khmer script (អក្សរខ្មែរ) — never Chinese, Thai or the original language."
        ), about=about)
        result.update(retry)
    return result


AGAIN_NOTE = ("IMPORTANT: an earlier answer skipped these lines or didn't write them in Khmer. Translate every numbered "
              "line, in Khmer script (អក្សរខ្មែរ) only. If a line makes no sense as heard, translate what was most likely said.")


def _ask_again(lines: list[dict], missing: list[dict], src: str, about: str, keep, have, errors: list, on_progress) -> None:
    """Ask again for the missing lines: in runs of up to RETRY_CHUNK neighbouring lines (with the lines
    around them as context), then the ones still missing one by one (at most MAX_SINGLE).
    keep(batch) stores what comes back; have(id) says whether a line is translated by now."""
    index = {l["id"]: i for i, l in enumerate(lines)}
    runs: list[list[dict]] = []
    for l in missing:
        last = runs[-1] if runs else None
        if last and len(last) < RETRY_CHUNK and index[l["id"]] == index[last[-1]["id"]] + 1:
            last.append(l)
        else:
            runs.append([l])

    def ask(group: list[dict]) -> dict[str, str]:
        i, j = index[group[0]["id"]], index[group[-1]["id"]]
        return _translate_chunk(group, lines[max(0, i - 3):i], lines[j + 1:j + 3], src, note=AGAIN_NOTE, about=about)

    _ask_all(runs, ask, keep, errors, lambda f: on_progress(f / 2))
    singles = [[l] for l in missing if not have(l["id"])][:MAX_SINGLE]
    _ask_all(singles, ask, keep, errors, lambda f: on_progress(0.5 + f / 2))


def _ask_all(groups: list, ask, keep, errors: list, on_progress) -> None:
    """ask(group) for every group in parallel; keep() what comes back, collect the errors."""
    if not groups:
        return
    with ThreadPoolExecutor(max_workers=max(1, config.TRANSLATE_WORKERS)) as pool:
        futures = [pool.submit(ask, g) for g in groups]
        for k, future in enumerate(as_completed(futures), 1):
            try:
                keep(future.result())
            except AppError as err:
                errors.append(err)
            on_progress(k / len(futures))


def _translate_chunk(chunk: list[dict], before: list[dict], after: list[dict], src: str, note: str = "", about: str = "") -> dict[str, str]:
    parts = []
    if about:
        parts.append(about)
    if before:
        parts.append("Earlier lines, for context only (do not translate):\n" + "\n".join(json.dumps(l["text"], ensure_ascii=False) for l in before))
    numbered = [f'[{i + 1}] ({l["room"]:.1f}s, budget {budget(l["room"])} chars) {json.dumps(l["text"], ensure_ascii=False)}' for i, l in enumerate(chunk)]
    parts.append(f"Translate these {src} lines into spoken Khmer:\n" + "\n".join(numbered))
    if after:
        parts.append("Following lines, for context only (do not translate):\n" + "\n".join(json.dumps(l["text"], ensure_ascii=False) for l in after))
    if note:
        parts.append(note)
    parts.append('Return {"lines": [{"id": "<number>", "text": "<Khmer>"}]} with one entry per numbered line, in order.')
    data = _call(SYSTEM, "\n\n".join(parts))
    result = {}
    for item in data.get("lines", []):
        idx = str(item.get("id", "")).strip("[] ")
        text = _clean(item.get("text", ""))
        if idx.isdigit() and 1 <= int(idx) <= len(chunk) and is_khmer(text):
            result[chunk[int(idx) - 1]["id"]] = text
    return result


KHMER_SCRIPT = re.compile(r"[\u1780-\u17ff\u19e0-\u19ff]")


def is_khmer(text: str) -> bool:
    """A usable Khmer line: no letters of another script than Khmer or Latin (Thai, Chinese… which a
    Khmer voice skips), and Khmer letters unless it is just a name or two (“Cursor”)."""
    if not text or voicecheck.unreadable(text):
        return False
    return bool(KHMER_SCRIPT.search(text)) or len(text.split()) <= 3


def shorten(source_text: str, khmer: str, seconds: float, max_chars: int) -> str | None:
    """Ask for a shorter Khmer line that can be spoken in `seconds`."""
    user = (
        f"This Khmer voiceover line is too long to say in {seconds:.1f} seconds.\n"
        f"Original: {json.dumps(source_text, ensure_ascii=False)}\n"
        f"Current Khmer ({len(khmer)} chars): {json.dumps(khmer, ensure_ascii=False)}\n"
        f"Rewrite it in natural spoken Khmer with at most {max_chars} characters. Keep the main meaning; drop details and filler.\n"
        'Return {"lines": [{"id": "1", "text": "<shorter Khmer>"}]}.'
    )
    data = _call(SYSTEM, user)
    lines = data.get("lines") or []
    text = _clean(lines[0].get("text", "")) if lines else ""
    return text if is_khmer(text) else None


def retranslate(lines: list[dict], source_lang: str | None) -> dict[str, str]:
    """Translate again the lines whose Khmer has words in another script (Thai, Lao, Chinese…), which a
    Khmer voice skips. `lines`: [{id, text, room, khmer}], text = the original. Batches run in parallel.
    Returns {id: Khmer} for the lines that came back in Khmer letters only; a failed batch is left out."""
    src = LANG_NAMES.get(source_lang or "", "the original language")

    def batch(chunk: list[dict]) -> dict[str, str]:
        bad = "; ".join(f'[{i + 1}] {json.dumps(voicecheck.unreadable(l["khmer"]), ensure_ascii=False)}' for i, l in enumerate(chunk))
        note = ("IMPORTANT: earlier answers for these lines mixed in words in other scripts, which a Khmer voice can't read: "
                f"{bad}. Write every line entirely in Khmer script (អក្សរខ្មែរ) — translate those words too.")
        return _translate_chunk([{**l, "text": l["text"] or l["khmer"]} for l in chunk], [], [], src, note)

    result: dict[str, str] = {}
    with ThreadPoolExecutor(max_workers=max(1, config.TRANSLATE_WORKERS)) as pool:
        for future in as_completed([pool.submit(batch, lines[i:i + CHUNK]) for i in range(0, len(lines), CHUNK)]):
            try:
                result.update(future.result())
            except AppError as err:
                log.warning("re-translating lines with other letters failed: %s", err.message)
    return result


RESTYLE = {
    "natural": "the most natural way a Cambodian would say it out loud",
    "shorter": "noticeably shorter than the current Khmer, keeping the main point, so it is easy to say in its time",
    "formal": "polite, formal Khmer, as a news presenter or teacher would say it",
    "casual": "relaxed, everyday Khmer, the way friends talk to each other",
}


def restyle(lines: list[dict], source_lang: str | None, style: str, on_progress=None, brief: dict | None = None) -> dict[str, str]:
    """Translate lines again, in a style (RESTYLE). `lines`: [{id, text, room, khmer}] in order, text =
    the original (empty for a line typed in Khmer: then the Khmer is rewritten). Batches run in parallel.
    Lines that had no Khmer yet and came back missing are asked for again, as translate_lines does.
    Returns {id: Khmer} for the lines that came back in Khmer."""
    src = LANG_NAMES.get(source_lang or "", "the original language")
    how = RESTYLE[style]
    about = brief_text(brief)
    starts = list(range(0, len(lines), CHUNK))

    def batch(start: int) -> dict[str, str]:
        chunk = lines[start:start + CHUNK]
        numbered = []
        for i, l in enumerate(chunk):
            room = l["room"] * (0.8 if style == "shorter" else 1.0)
            original = json.dumps(l["text"], ensure_ascii=False) if l["text"] else "(no original: rewrite the Khmer)"
            current = json.dumps(l["khmer"], ensure_ascii=False) if l["khmer"] else "(none yet: translate it)"
            numbered.append(f'[{i + 1}] ({l["room"]:.1f}s, budget {budget(room)} chars) original: {original} · current Khmer: {current}')
        before = [l["khmer"] for l in lines[max(0, start - 3):start] if l["khmer"]]
        parts = [about] if about else []
        if before:
            parts.append("Khmer lines just before, for context only:\n" + "\n".join(json.dumps(t, ensure_ascii=False) for t in before))
        parts.append(f"Translate these {src} lines into Khmer again, as {how}. The current Khmer is only for reference: "
                     "write each line fresh, keep its meaning, and stay within its budget.\n" + "\n".join(numbered))
        parts.append('Return {"lines": [{"id": "<number>", "text": "<Khmer>"}]} with one entry per numbered line, in order.')
        data = _call(SYSTEM, "\n\n".join(parts))
        out = {}
        for item in data.get("lines", []):
            idx = str(item.get("id", "")).strip("[] ")
            text = _clean(item.get("text", ""))
            if idx.isdigit() and 1 <= int(idx) <= len(chunk) and is_khmer(text):
                out[chunk[int(idx) - 1]["id"]] = text
        return out

    result: dict[str, str] = {}
    errors: list[AppError] = []
    with ThreadPoolExecutor(max_workers=max(1, config.TRANSLATE_WORKERS)) as pool:
        futures = [pool.submit(batch, start) for start in starts]
        for done, future in enumerate(as_completed(futures), 1):
            try:
                result.update(future.result())
            except AppError as err:
                errors.append(err)
            if on_progress:
                on_progress(done / len(futures))
    untranslated = [l for l in lines if l["text"] and not l["khmer"] and l["id"] not in result]
    if untranslated:
        log.info("%d lines with no Khmer came back missing; asking for them again", len(untranslated))
        _ask_again(lines, untranslated, src, about, result.update, lambda sid: sid in result, errors, lambda f: None)
    if errors and not result:
        raise errors[0]
    return result


def respeller(source_lang: str | None):
    """For services/fit.py: sentence → its Khmer again in Khmer letters only, or None."""
    def respell(s: dict) -> str | None:
        line = {"id": s["id"], "text": s["original_text"], "room": s["end"] - s["start"], "khmer": s["khmer_text"]}
        return retranslate([line], source_lang).get(s["id"])
    return respell


SUGGEST_STYLES = (
    ("natural", "More natural", "the most natural way a Cambodian would say it out loud"),
    ("shorter", "Shorter", "noticeably shorter, keeping the main point, so it is easy to say in the time"),
    ("formal", "More formal", "polite, formal Khmer, as a news presenter or teacher would say it"),
)
SUGGEST_SCHEMA = {
    "type": "object",
    "properties": {key: {"type": "string"} for key, _, _ in SUGGEST_STYLES},
    "required": [key for key, _, _ in SUGGEST_STYLES],
    "additionalProperties": False,
}


IMPROVE_SCHEMA = {
    "type": "object",
    "properties": {**{key: {"type": "string"} for key, _, _ in SUGGEST_STYLES}, "meant": {"type": "string"}},
    "required": [key for key, _, _ in SUGGEST_STYLES] + ["meant"],
    "additionalProperties": False,
}


def improve(source_text: str, khmer: str, seconds: float, before: list[dict], after: list[dict], brief: dict | None = None,
            instruction: str = "", source_lang: str | None = None) -> dict:
    """"Improve translation": three Khmer lines (more natural, shorter, more formal), written with the lines
    around it (`before` / `after`: [{original, khmer}]), the video's brief and the editor's own `instruction`.
    Returns {options: [{style, label, text}], meant: the line as it was most likely said when the speech
    recognition probably misheard it (else ""), model: which model answered, backup: whether that was the
    weaker backup model (the main one was overloaded)}."""
    src = LANG_NAMES.get(source_lang or "", "the original language")

    def show(items: list[dict]) -> str:
        return "\n".join("- " + " → ".join(json.dumps(x[k], ensure_ascii=False) for k in ("original", "khmer") if x.get(k)) for x in items)

    parts = []
    about = brief_text(brief)
    if about:
        parts.append(about)
    if before:
        parts.append("Lines before it (original → Khmer), for context:\n" + show(before))
    parts.append(f"The line ({src}): {json.dumps(source_text, ensure_ascii=False)}")
    parts.append(f"Its Khmer now: {json.dumps(khmer, ensure_ascii=False)}" if khmer else "It has no Khmer yet: write three translations of it.")
    if after:
        parts.append("Lines after it (original → Khmer), for context:\n" + show(after))
    wish = " ".join(str(instruction or "").split())[:300]
    if wish:
        parts.append(f"The editor's own wish for this line; follow it in all three, within the rules: {json.dumps(wish, ensure_ascii=False)}")
    styles = "\n".join(f'- "{key}": {how}' for key, _, how in SUGGEST_STYLES)
    parts.append(
        f"The line is spoken in {seconds:.1f} seconds (budget about {budget(seconds)} characters; \"shorter\" must stay under it).\n"
        f"Write three different Khmer lines:\n{styles}\n"
        "Each must differ from the current Khmer and from each other.\n"
        '"meant": if the speech recognition probably misheard this line, write it as it was most likely said, in the original language; otherwise "".'
    )
    data = _call(SYSTEM, "\n\n".join(parts), IMPROVE_SCHEMA)
    options = [{"style": key, "label": label, "text": _clean(data.get(key, ""))} for key, label, _ in SUGGEST_STYLES if is_khmer(_clean(data.get(key, "")))]
    meant = _clean(data.get("meant", ""))
    model = last_model()
    return {"options": options, "meant": "" if meant == " ".join(source_text.split()) else meant[:300], "model": model, "backup": is_backup(model)}


def suggest(source_text: str, khmer: str, seconds: float, before: list[str], after: list[str]) -> list[dict]:
    """improve()'s three lines, for callers that only have the Khmer of the lines around it."""
    return improve(source_text, khmer, seconds, [{"khmer": t} for t in before], [{"khmer": t} for t in after])["options"]


_answered = threading.local()  # the model that answered this thread's last request


def last_model() -> str | None:
    return getattr(_answered, "model", None)


def is_backup(model: str | None) -> bool:
    """True when an answer came from Gemini's weaker backup model (the main one was overloaded)."""
    return bool(model) and model == config.GEMINI_FALLBACK_MODEL and model != config.GEMINI_MODEL


def _clean(text: str) -> str:
    return " ".join(str(text).split()).strip().strip('"“”')


def _call(system: str, user: str, schema: dict = SCHEMA) -> dict:
    name = provider()
    if not name:
        raise AppError("No translation service is set up.", hint=status()["reason"] + ", then restart the server.", status=500)
    raw = {"anthropic": _anthropic, "gemini": _gemini, "openai": _openai}[name](system, user, schema)
    try:
        return json.loads(raw)
    except json.JSONDecodeError as err:
        raise AppError("The translator returned an unreadable answer.", hint="Press “Try again”.", detail=raw[:500]) from err


def _anthropic(system: str, user: str, schema: dict) -> str:
    client = anthropic.Anthropic(api_key=config.ANTHROPIC_API_KEY, max_retries=2)
    extra = {}
    if config.ANTHROPIC_MODEL in FALLBACK_MODELS:  # let the API retry a declined request on another model
        extra = {"betas": ["server-side-fallback-2026-07-01"], "fallbacks": "default"}
    try:
        response = client.beta.messages.create(
            model=config.ANTHROPIC_MODEL,
            max_tokens=16000,
            output_config={"effort": "medium", "format": {"type": "json_schema", "schema": schema}},
            system=system,
            messages=[{"role": "user", "content": user}],
            **extra,
        )
    except (anthropic.AuthenticationError, anthropic.PermissionDeniedError) as err:
        raise AppError("Anthropic rejected the API key.", hint="Check ANTHROPIC_API_KEY in backend/.env.", detail=str(err)) from err
    except anthropic.NotFoundError as err:
        raise AppError(f"The Claude model “{config.ANTHROPIC_MODEL}” isn't available to this key.", hint="Fix ANTHROPIC_MODEL in backend/.env.", detail=str(err)) from err
    except anthropic.RateLimitError as err:
        raise AppError("Claude is busy or your usage limit was reached.", hint="Wait a minute and press “Try again”.", detail=str(err)) from err
    except anthropic.APIConnectionError as err:
        raise AppError("Couldn't reach Anthropic.", hint="Check your internet connection and try again.", detail=str(err)) from err
    except anthropic.APIStatusError as err:
        raise AppError(f"Claude translation failed (HTTP {err.status_code}).", hint="Try again in a minute.", detail=str(err)) from err
    if response.stop_reason == "refusal":
        raise AppError("Claude declined to translate this video.", hint="Try another TRANSLATE_PROVIDER, or type the Khmer lines yourself.")
    if response.stop_reason == "max_tokens":
        raise AppError("The translation was cut off.", hint="Try again; very long videos may need to be split.")
    _answered.model = getattr(response, "model", None) or config.ANTHROPIC_MODEL
    return "".join(block.text for block in response.content if block.type == "text")


RETRY_STATUS = (429, 500, 502, 503, 504)


def _post(url: str, waits=(2, 6, 15), timeout: float = 300, **kwargs) -> httpx.Response:
    """POST, retrying the temporary failures (overload, rate limit, server error) with a growing wait."""
    for wait in (*waits, None):
        res = httpx.post(url, timeout=timeout, **kwargs)
        if res.status_code not in RETRY_STATUS or wait is None or _daily_quota(res):
            return res
        time.sleep(max(wait, _asked_delay(res)))
    return res


def _asked_delay(res: httpx.Response) -> float:
    """A per-minute limit says how long to wait ("retryDelay": "22s", or a Retry-After header); honour it, up to a minute."""
    match = re.search(r'"retryDelay":\s*"(\d+(?:\.\d+)?)s"', res.text)
    try:
        seconds = float(match.group(1) if match else res.headers.get("retry-after", "0"))
    except ValueError:  # a Retry-After date instead of seconds
        seconds = 0.0
    return min(65.0, seconds + 1) if seconds else 0.0


def _daily_quota(res: httpx.Response) -> bool:
    """A used-up daily quota: waiting seconds won't help, so don't retry."""
    return res.status_code == 429 and "PerDay" in res.text


class _Busy(Exception):
    """The Gemini model is overloaded or too slow right now; `error` is what the user sees if no other model helps."""

    def __init__(self, error: AppError):
        super().__init__(error.message)
        self.error = error


_primary_busy_until = 0.0  # while the main model is overloaded, go straight to the fallback


def _gemini(system: str, user: str, schema: dict) -> str:
    global _primary_busy_until
    models = [config.GEMINI_MODEL]
    fallback = config.GEMINI_FALLBACK_MODEL
    if fallback and fallback != config.GEMINI_MODEL:
        models = [fallback] if time.time() < _primary_busy_until else [config.GEMINI_MODEL, fallback]
    for n, model in enumerate(models):
        last = n == len(models) - 1
        try:
            # The main model gets one quick retry and 2 minutes; the last model gets the full patience.
            text = _gemini_once(model, system, user, schema, patient=last)
            _answered.model = model
            return text
        except _Busy as busy:
            if last:
                raise busy.error from None
            log.warning("Gemini %s is busy (%s); using %s for the next 10 minutes", model, busy.error.message, fallback)
            _primary_busy_until = time.time() + 600
    raise AssertionError("unreachable")


def _thinking(model: str) -> dict | None:
    """Translation needs little reasoning; the default (high) thinking makes a batch take minutes."""
    if re.search(r"gemini-(1\.|2\.0)", model):
        return None
    if "gemini-2.5" in model:
        return {"thinkingBudget": 128 if "pro" in model else 0}
    return {"thinkingLevel": "low"}


def _gemini_once(model: str, system: str, user: str, schema: dict, patient: bool, thinking: bool = True) -> str:
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
    generation = {"responseMimeType": "application/json", "responseJsonSchema": schema}
    if thinking and _thinking(model):
        generation["thinkingConfig"] = _thinking(model)
    body = {
        "systemInstruction": {"parts": [{"text": system}]},
        "contents": [{"role": "user", "parts": [{"text": user}]}],
        "generationConfig": generation,
    }
    headers = {"x-goog-api-key": config.GEMINI_API_KEY}
    try:
        res = _post(url, waits=(2, 6, 15) if patient else (2,), timeout=300 if patient else 120, headers=headers, json=body)
    except httpx.TimeoutException as err:
        error = AppError("Gemini is taking too long to answer.", hint="It is probably overloaded. Wait a few minutes and press “Try again”.", detail=f"{model}: {err}")
        if patient:
            raise error from err
        raise _Busy(error) from err
    except httpx.HTTPError as err:
        raise AppError("Couldn't reach Google Gemini.", hint="Check your internet connection and try again.", detail=str(err)) from err
    if res.status_code == 400 and "thinking" in res.text.lower() and "thinkingConfig" in generation:
        return _gemini_once(model, system, user, schema, patient, thinking=False)  # this model doesn't take that thinking setting
    if res.status_code in (401, 403) or "API_KEY_INVALID" in res.text:
        raise AppError("Google rejected the Gemini API key.", hint="Check GEMINI_API_KEY in backend/.env (create one at aistudio.google.com/apikey).", detail=res.text)
    if res.status_code == 404:
        raise AppError(f"The Gemini model “{model}” wasn't found.", hint="Fix GEMINI_MODEL / GEMINI_FALLBACK_MODEL in backend/.env.", detail=res.text)
    if _daily_quota(res):
        error = AppError(
            f"Your free Gemini quota for {model} is used up for today.",
            hint="It resets tomorrow. Or set another GEMINI_MODEL / GEMINI_FALLBACK_MODEL in backend/.env, or use a paid key.",
            detail=res.text,
        )
        if patient:
            raise error
        raise _Busy(error)
    if res.status_code in RETRY_STATUS:
        error = AppError("Gemini is overloaded or your rate limit was reached.", hint="Wait a minute and press “Try again”.", detail=f"{model}: {res.text}")
        if patient:
            raise error
        raise _Busy(error)
    if res.status_code != 200:
        raise AppError(f"Gemini translation failed (HTTP {res.status_code}).", hint="Try again in a minute.", detail=res.text)
    data = res.json()
    candidate = (data.get("candidates") or [{}])[0]
    if candidate.get("finishReason") == "MAX_TOKENS":
        raise AppError("The translation was cut off.", hint="Try again; very long videos may need to be split.")
    text = "".join(part.get("text", "") for part in candidate.get("content", {}).get("parts", []) if not part.get("thought"))
    if not text:
        reason = data.get("promptFeedback", {}).get("blockReason") or candidate.get("finishReason") or "empty answer"
        raise AppError("Gemini didn't return a translation.", hint="Try again, or switch TRANSLATE_PROVIDER.", detail=str(reason))
    return text


def _openai(system: str, user: str, schema: dict) -> str:
    body = {
        "model": config.OPENAI_MODEL,
        "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
        "response_format": {"type": "json_schema", "json_schema": {"name": "khmer_lines", "strict": True, "schema": schema}},
    }
    try:
        res = _post("https://api.openai.com/v1/chat/completions", headers={"Authorization": f"Bearer {config.OPENAI_API_KEY}"}, json=body)
    except httpx.HTTPError as err:
        raise AppError("Couldn't reach OpenAI.", hint="Check your internet connection and try again.", detail=str(err)) from err
    if res.status_code in (401, 403):
        raise AppError("OpenAI rejected the API key.", hint="Check OPENAI_API_KEY in backend/.env.", detail=res.text)
    if res.status_code == 429:
        raise AppError("OpenAI's rate limit was reached.", hint="Wait a minute and press “Try again”.", detail=res.text)
    if res.status_code != 200:
        raise AppError(f"OpenAI translation failed (HTTP {res.status_code}).", hint="Try again in a minute.", detail=res.text)
    choice = res.json()["choices"][0]
    if choice["message"].get("refusal"):
        raise AppError("OpenAI declined to translate this video.", detail=choice["message"]["refusal"])
    if choice.get("finish_reason") == "length":
        raise AppError("The translation was cut off.", hint="Try again; very long videos may need to be split.")
    _answered.model = res.json().get("model") or config.OPENAI_MODEL
    return choice["message"].get("content") or ""
