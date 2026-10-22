"""Advert scripts: the AI writes three Khmer voiceover scripts for a product, in three tones, sized to
the ad's length (the ad wizard, step 5). Each script is a list of scenes; a scene is one shot of the
video: the Khmer line the voice says, a short caption on screen, and which picture or clip it shows.

The answer is checked before anyone sees it: every voice line must be readable Khmer, numbers are
spelled out as words (the voice misreads digits), and the script must fit in the time. A script that
doesn't is sent back once with what to fix.
"""
import json
import logging
import re

from errors import AppError
from services import translate, voicecheck

log = logging.getLogger("adscript")

CHARS_PER_SECOND = translate.KHMER_CHARS_PER_SECOND  # what the Khmer voice comfortably says per second
SPEECH_SHARE = 0.85  # of the ad's length is speech; the rest is pauses between shots and the end screen
HOOK_SECONDS = 3
SCENE_PAUSE = 0.25  # seconds between two voice lines
MIN_SCENE = 1.2  # seconds a shot is shown at least
CAPTION_CHARS = 30
LENGTHS = {15: (3, 5), 30: (5, 8), 60: (8, 12)}  # seconds -> (fewest, most) scenes

TONES = (
    ("friendly", "Friendly", "ស្និទ្ធស្នាល", "warm and chatty, like a friend telling you about a find; relaxed, caring"),
    ("energetic", "Energetic", "រស់រវើក", "fast, exciting, full of energy and urgency; short punchy lines and exclamations"),
    ("professional", "Professional", "អាជីព", "calm, polished and trustworthy, like a premium brand; clear and confident"),
)
STYLES = {
    "product": ("Product showcase", "show the product: how it looks, what makes it special, how it makes life better"),
    "sale": ("Sale / promotion", "the offer is the star: the discount or gift, the limited time, urgency (don't miss it, while stocks last)"),
    "food": ("Restaurant / food", "make people hungry: taste, freshness, smell and texture words (ឆ្ងាញ់ ស្រស់ ក្រអូប ស្រួយ), the place and the atmosphere"),
    "shop": ("Shop / brand intro", "who the shop or brand is, what it offers, why customers love and trust it, where to find it"),
    "service": ("Service", "a salon, clinic, school, repair or similar: the problem it solves, the result the customer gets, trust, how to book"),
    "real_estate": ("Real estate", "location, size and key features, the lifestyle it gives, the price or payment plan, booking a visit"),
}
TONE_HOW = {key: how for key, _, _, how in TONES}
ROLES = ("hook", "problem", "benefit", "feature", "proof", "price", "promo", "cta")

SYSTEM = """You are an experienced Cambodian advertising copywriter. You write voiceover scripts for short video ads in Khmer (ភាសាខ្មែរ); a Khmer AI voice reads them aloud over the product's pictures.

Language
- Write natural, correct, spoken Khmer, the way Cambodians really talk in ads on TikTok and Facebook: lively, warm and persuasive. Never stiff written style, never a word-for-word translation.
- Use short sentences, one idea each, easy to say in one breath. They must sound good read aloud.
- Spell every word correctly. End a statement with ។ or !, and a question with ?. Put a space between phrases, as Khmer is normally written, so the voice pauses there.
- Speak to the viewer warmly and politely (បង / អ្នក / លោកអ្នក), as fits the product and the tone.
- In "voice", write every number as Khmer words so the voice reads it right: prices ($2.50 → ពីរដុល្លារកន្លះ, 15000៛ → មួយម៉ឺនប្រាំពាន់រៀល), percentages (20% → ម្ភៃភាគរយ), dates, and phone numbers digit by digit (012 345 678 → សូន្យ មួយ ពីរ បី បួន ប្រាំ ប្រាំមួយ ប្រាំពីរ ប្រាំបី). No digits, symbols, emoji or hashtags in "voice". The brand or product name may stay as the owner wrote it.
- Never read out a web address, Facebook link or Telegram username in "voice": say where to find you ("ឆាតមកតាមតេឡេក្រាម", "ផ្ញើសារមកផេកយើង") and put the handle or link in the caption.
- "caption" is the short text shown on screen during the scene: at most 5 words or 24 characters, punchy. Digits and symbols are good here ($2.50, -20%, 012 345 678). Leave it empty when the picture says enough.
- Use only the facts the owner gave. Never invent prices, discounts, gifts, phone numbers, addresses, awards, numbers of customers or health claims.

Structure
- Each scene is one shot of the video. Scene 1 has role "hook": the first 3 seconds, which must stop the scroll (a question, a surprising benefit, or the offer itself).
- Then sell the benefits: what the customer gets, feels or saves, not only the features.
- Say the price and the promotion clearly, when the owner gave them.
- The last scene has role "cta": a clear call to action with how to order, call or find the shop.
- For each scene choose the owner's picture or clip that fits best ("media": its number), or -1 for none (the brand colours and logo are shown).
- "post" is the text to post with the video on Facebook or TikTok: 2 to 4 short lines in Khmer with the offer and the contact details, then 3 to 6 hashtags."""

SCENE_SCHEMA = {
    "type": "object",
    "properties": {
        "role": {"type": "string", "enum": list(ROLES)},
        "voice": {"type": "string"},
        "caption": {"type": "string"},
        "media": {"type": "integer"},
    },
    "required": ["role", "voice", "caption", "media"],
    "additionalProperties": False,
}
SCRIPT_SCHEMA = {
    "type": "object",
    "properties": {
        "tone": {"type": "string", "enum": [t[0] for t in TONES]},
        "title": {"type": "string"},
        "scenes": {"type": "array", "items": SCENE_SCHEMA},
        "post": {"type": "string"},
    },
    "required": ["tone", "title", "scenes", "post"],
    "additionalProperties": False,
}
SCHEMA = {
    "type": "object",
    "properties": {"scripts": {"type": "array", "items": SCRIPT_SCHEMA}},
    "required": ["scripts"],
    "additionalProperties": False,
}


def budget(length: int) -> dict:
    """How much a script for an ad of `length` seconds may say."""
    if length not in LENGTHS:
        raise AppError(f"An ad can be {', '.join(map(str, LENGTHS))} seconds long, not {length}.")
    fewest, most = LENGTHS[length]
    return {
        "seconds": length, "chars": round(length * SPEECH_SHARE * CHARS_PER_SECOND),
        "hook_chars": round(HOOK_SECONDS * CHARS_PER_SECOND), "scenes": (fewest, most),
    }


# ---------- asking the AI ----------

def write(brief: dict, style: str, length: int, media: list[dict]) -> list[dict]:
    """Three scripts (friendly, energetic, professional) for the product in `brief`.
    `media`: the owner's pictures and clips, [{name, media: image|video}] in order."""
    if style not in STYLES:
        raise AppError(f"“{style}” isn't an ad style.", hint=f"Use one of: {', '.join(STYLES)}.")
    if not (brief.get("product") or "").strip():
        raise AppError("Write the product's name first.", hint="Step 1 of the ad wizard: Product info.")
    b = budget(length)
    tones = "\n".join(f'- "{key}": {how}' for key, how in TONE_HOW.items())
    ask = (f"Write three different scripts, one in each tone:\n{tones}\n"
           "Give each a short Khmer title. The three must differ in their hook and wording, not only in tone.")
    data = translate._call(SYSTEM, _prompt(brief, style, b, media, ask), SCHEMA)
    scripts = {}
    for raw in data.get("scripts") or []:
        if raw.get("tone") in TONE_HOW and raw.get("tone") not in scripts:
            scripts[raw["tone"]] = raw
    out = []
    for tone, *_ in TONES:
        raw = scripts.get(tone)
        phone = (brief.get("contact") or {}).get("phone") or ""
        script = clean(raw, b, len(media), phone) if raw else None
        problems = check(script, b, brief) if script else ["it is missing"]
        if problems:  # one more try for this tone, saying what was wrong
            log.info("asking again for the %s script: %s", tone, "; ".join(problems))
            try:
                again = _again(brief, style, b, media, tone, raw, problems)
            except AppError as err:
                log.warning("asking again for the %s script failed: %s", tone, err.message)
                again = None
            if again and len(check(again, b, brief)) < len(problems):
                script, problems = again, check(again, b, brief)
        if script:
            script["warnings"] = problems
            out.append(script)
    if not out:
        raise AppError("The AI didn't write a usable script.", hint="Press “Write again”, or add more about the product.")
    return out


def _brief_text(brief: dict) -> str:
    contact = brief.get("contact") or {}
    rows = [
        ("Product or business", brief.get("product")),
        ("About it", brief.get("description")),
        ("Price", brief.get("price")),
        ("Promotion / discount", brief.get("promo")),
        ("Phone", contact.get("phone")),
        ("Facebook", contact.get("facebook")),
        ("Telegram", contact.get("telegram")),
        ("Address", contact.get("address")),
        ("Website", contact.get("website")),
        ("Call to action", brief.get("cta")),
    ]
    return "\n".join(f"- {name}: {json.dumps(str(value).strip(), ensure_ascii=False)}" for name, value in rows if str(value or "").strip())


def _prompt(brief: dict, style: str, b: dict, media: list[dict], ask: str) -> str:
    fewest, most = b["scenes"]
    name, how = STYLES[style]
    pictures = "\n".join(f"- {i}: {'video clip' if m.get('media') == 'video' else 'photo'} “{m.get('name') or ''}”" for i, m in enumerate(media)) or "- none (use -1)"
    return (
        f"The owner's product:\n{_brief_text(brief)}\n\n"
        f"Ad style: {name}: {how}.\n\n"
        f"The owner's pictures and clips:\n{pictures}\n\n"
        f"The ad is {b['seconds']} seconds long. Each script has {fewest} to {most} scenes, and all its voice lines together have "
        f"at most {b['chars']} Khmer characters (about {CHARS_PER_SECOND} characters a second); the hook at most {b['hook_chars']}.\n\n"
        + ask
    )


def _again(brief, style, b, media, tone, raw, problems) -> dict | None:
    ask = f"Write one script in the \"{tone}\" tone: {TONE_HOW[tone]}."
    if raw:
        fix = "\n".join(f"- {p}" for p in problems)
        ask += f"\nAn earlier version had these problems; fix them:\n{fix}\nThe earlier version:\n{json.dumps(raw, ensure_ascii=False)}"
    data = translate._call(SYSTEM, _prompt(brief, style, b, media, ask), SCHEMA)
    for s in data.get("scripts") or []:
        return clean({**s, "tone": tone}, b, len(media), (brief.get("contact") or {}).get("phone") or "")
    return None


# ---------- checking the answer ----------

def clean(raw: dict, b: dict, media_count: int, phone: str = "") -> dict:
    """Tidy one script from the AI: clean text, numbers in the voice spelled out (the phone number in
    the groups it is written in), media in range, the time each scene takes."""
    scenes = []
    for i, s in enumerate(raw.get("scenes") or []):
        voice = space_phone(spell_numbers(_tidy(s.get("voice"))), phone)
        caption = _tidy(s.get("caption"))
        if not voice and not caption:
            continue
        m = s.get("media")
        role = s.get("role") if s.get("role") in ROLES else "benefit"
        scenes.append({
            "id": f"sc{i + 1}", "role": role, "voice": voice, "caption": caption,
            "media": m if isinstance(m, int) and 0 <= m < media_count else -1,
            "seconds": scene_seconds(voice),
        })
    if scenes and scenes[0]["role"] != "hook":
        scenes[0]["role"] = "hook"
    tone = raw.get("tone")
    return {
        "tone": tone, "label": next((t[1] for t in TONES if t[0] == tone), tone), "title": _tidy(raw.get("title")),
        "scenes": scenes, "post": "\n".join(_tidy(line) for line in str(raw.get("post") or "").splitlines()).strip(),
        "chars": sum(len(s["voice"]) for s in scenes), "seconds": round(sum(s["seconds"] for s in scenes), 1),
    }


def scene_seconds(voice: str) -> float:
    """About how long a scene with this voice line lasts."""
    return round(max(MIN_SCENE, len(voice) / CHARS_PER_SECOND + SCENE_PAUSE), 2)


def check(script: dict, b: dict, brief: dict) -> list[str]:
    """What is wrong with a cleaned script ([] when nothing)."""
    problems = []
    scenes = script["scenes"]
    fewest, most = b["scenes"]
    if not fewest <= len(scenes) <= most:
        problems.append(f"it has {len(scenes)} scenes; it needs {fewest} to {most}")
    for s in scenes:
        if not s["voice"]:
            continue
        foreign = voicecheck.unreadable(s["voice"])
        if foreign:
            problems.append(f"scene {s['id'][2:]} has words a Khmer voice can't read ({foreign}); write them in Khmer")
        elif not translate.KHMER_SCRIPT.search(s["voice"]):
            problems.append(f"scene {s['id'][2:]} isn't in Khmer")
    if script["chars"] > b["chars"] * 1.1:
        problems.append(f"the voice lines have {script['chars']} characters, too long for {b['seconds']} seconds; make them at most {b['chars']}")
    if scenes and len(scenes[0]["voice"]) > b["hook_chars"] * 1.3:
        problems.append(f"the hook has {len(scenes[0]['voice'])} characters; it must be said in {HOOK_SECONDS} seconds (at most {b['hook_chars']})")
    if not scenes or scenes[-1]["role"] != "cta":
        problems.append("the last scene must be the call to action (role \"cta\")")
    long_captions = [s["id"][2:] for s in scenes if len(s["caption"]) > CAPTION_CHARS]
    if long_captions:
        problems.append(f"the captions of scenes {', '.join(long_captions)} are too long; at most {CAPTION_CHARS - 6} characters")
    phone = re.sub(r"\D", "", (brief.get("contact") or {}).get("phone") or "")
    if phone and not any(phone in re.sub(r"\D", "", s["caption"]) for s in scenes):
        problems.append(f"no caption shows the phone number {(brief.get('contact') or {}).get('phone')}; put it in the call to action's caption")
    return problems


def _tidy(text) -> str:
    return " ".join(str(text or "").split()).strip().strip('"“”')


# ---------- numbers as Khmer words ----------

DIGITS = ("សូន្យ", "មួយ", "ពីរ", "បី", "បួន", "ប្រាំ", "ប្រាំមួយ", "ប្រាំពីរ", "ប្រាំបី", "ប្រាំបួន")
TENS = ("", "ដប់", "ម្ភៃ", "សាមសិប", "សែសិប", "ហាសិប", "ហុកសិប", "ចិតសិប", "ប៉ែតសិប", "កៅសិប")
PLACES = ((100_000, "សែន"), (10_000, "ម៉ឺន"), (1_000, "ពាន់"), (100, "រយ"))
KHMER_DIGITS = str.maketrans("០១២៣៤៥៦៧៨៩", "0123456789")


def number_words(n: int) -> str:
    """25 → ម្ភៃប្រាំ, 12500 → មួយម៉ឺនពីរពាន់ប្រាំរយ, 1250000 → មួយលានពីរសែនប្រាំម៉ឺន."""
    if n < 0:
        return "ដក" + number_words(-n)
    if n < 10:
        return DIGITS[n]
    if n >= 1_000_000:
        rest = n % 1_000_000
        return number_words(n // 1_000_000) + "លាន" + (number_words(rest) if rest else "")
    out = ""
    for size, word in PLACES:
        if n >= size:
            out += DIGITS[n // size] + word
            n %= size
    if n >= 10:
        out += TENS[n // 10]
        n %= 10
    if n:
        out += DIGITS[n]
    return out


def _amount(text: str) -> str:
    """'2.50' → ពីរ and 'ហាសិប' cents, '2.5' → ពីរចុចប្រាំ, '12,000' → មួយម៉ឺនពីរពាន់."""
    whole, _, frac = text.replace(",", "").partition(".")
    words = number_words(int(whole or 0))
    if frac.strip("0"):
        words += "ចុច" + "".join(DIGITS[int(d)] for d in frac.rstrip("0"))
    return words


def dollars(amount: str) -> str:
    """'2' → ពីរដុល្លារ, '2.50' → ពីរដុល្លារកន្លះ, '2.25' → ពីរដុល្លារ ម្ភៃប្រាំសេន."""
    whole, _, cents = amount.replace(",", "").partition(".")
    words = number_words(int(whole or 0)) + "ដុល្លារ"
    cents = cents.ljust(2, "0")[:2]
    if cents == "50":
        return words + "កន្លះ"
    if cents.strip("0"):
        return words + " " + number_words(int(cents)) + "សេន"
    return words


def space_phone(voice: str, phone: str) -> str:
    """Say the phone number in the groups it is written in, with a pause between them:
    'សូន្យមួយពីរបីបួន…' → 'សូន្យមួយពីរ បីបួនប្រាំ ប្រាំមួយប្រាំពីរប្រាំបី' for 012 345 678."""
    groups = [g for g in re.split(r"\D+", phone.translate(KHMER_DIGITS)) if g]
    if sum(map(len, groups)) < 6:
        return voice
    words = [DIGITS[int(d)] for g in groups for d in g]
    said = re.compile(r"\s*".join(re.escape(w) for w in words) + r"(?![\u1780-\u17d3])")  # not inside a longer word
    spaced = " ".join("".join(DIGITS[int(d)] for d in g) for g in groups)
    return re.sub(r"\s+([។៕!?])", r"\1", " ".join(said.sub(f" {spaced} ", voice).split()))


PHONE = re.compile(r"(?<![\d.,])(?:\+?855[\s-]?|0)\d{1,2}(?:[\s-]?\d){6,7}(?![\d.,])")
MONEY_BEFORE = re.compile(r"\$\s?(\d[\d,]*(?:\.\d+)?)")
MONEY_AFTER = re.compile(r"(\d[\d,]*(?:\.\d+)?)\s?(\$|ដុល្លារ|៛|រៀល|%|ភាគរយ)")
NUMBER = re.compile(r"\d[\d,]*(?:\.\d+)?")


def spell_numbers(text: str) -> str:
    """Write the digits left in a voice line as Khmer words (the AI is asked to, but sometimes doesn't):
    phone numbers digit by digit, $ and ៛ amounts with their currency, percentages, other numbers."""
    text = text.translate(KHMER_DIGITS)
    if not re.search(r"\d", text):
        return text

    def phone(m):  # in the groups it's written in
        return " ".join("".join(DIGITS[int(d)] for d in g) for g in re.split(r"\D+", m.group(0)) if g)

    def unit(m):
        word = {"$": "ដុល្លារ", "៛": "រៀល", "%": "ភាគរយ"}.get(m.group(2), m.group(2))
        return dollars(m.group(1)) if word == "ដុល្លារ" else _amount(m.group(1)) + word

    text = PHONE.sub(phone, text)
    text = MONEY_BEFORE.sub(lambda m: dollars(m.group(1)), text)
    text = MONEY_AFTER.sub(unit, text)
    text = NUMBER.sub(lambda m: _amount(m.group(0)), text)
    return " ".join(text.split())
