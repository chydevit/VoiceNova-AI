"""A project's translation brief (services/translate.brief): what the video is about, one Khmer spelling
for each name and special term, and the words the speech recognition probably misheard. It is made once
from the whole transcript, the first time something of the project is translated, and kept in
project.json (`translation_brief`); every translation of its lines uses it, so names stay the same and
misheard words are understood. It isn't an edit: no undo step."""
import sentences
import store
from services import translate


def source_language(project: dict) -> str | None:  # as pipeline.source_language (which imports this module's users)
    return project["detected_lang"] if project["source_lang"] == "auto" else project["source_lang"]


def get(pid: str, project: dict | None = None, fresh: bool = False) -> dict | None:
    """The project's brief, made now if it has none yet (or `fresh`). None when no translator is set up,
    the transcript is too short, or making it failed: translating then simply goes on without one."""
    project = project or store.load(pid)
    if project.get("translation_brief") and not fresh:
        return project["translation_brief"]
    if not translate.provider():
        return None
    made = translate.brief([s["original_text"] for s in sentences.items(project)], source_language(project))
    if made:
        store.update(pid, translation_brief=made)
    return made
