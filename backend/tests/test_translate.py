"""Translating into Khmer (services/translate.py, briefs.py): no line left out silently, the video's brief
in every request, and "Improve translation". The AI is replaced by a fake.

Run from the backend folder:  .venv/bin/python -m unittest discover -s tests -t .
"""
import re
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import briefs
import config
import sentences
import store
import timeline
from errors import AppError
from services import translate

BRIEF = {"topic": "A drama about a village official in old China.", "names": [{"original": "周元", "khmer": "ចូវ យាន", "note": "a rich family"}],
         "terms": [], "misheard": [{"heard": "筷债", "meant": "赌债"}]}


def numbered(user: str) -> list[int]:
    """The line numbers a translation request asks for."""
    return [int(n) for n in re.findall(r"^\[(\d+)\]", user, re.M)]


class Fake:
    """Stands in for translate._call. `skip(user, n)` says whether to leave line n out of an answer
    (as a weak model does); `fail(user)` raises like an overloaded service. Remembers every request."""

    def __init__(self, skip=lambda user, n: False, fail=lambda user: False, brief=None, improve=None):
        self.skip, self.fail, self.brief, self.improve = skip, fail, brief, improve
        self.asked = []

    def __call__(self, system, user, schema=translate.SCHEMA):
        self.asked.append(user)
        if self.fail(user):
            raise AppError("Gemini is overloaded or your rate limit was reached.")
        if schema is translate.BRIEF_SCHEMA:
            return self.brief or {"topic": "", "names": [], "terms": [], "misheard": []}
        if schema is translate.IMPROVE_SCHEMA:
            return self.improve
        return {"lines": [{"id": str(n), "text": f"បន្ទាត់{n}"} for n in numbered(user) if not self.skip(user, n)]}


def lines_of(n: int) -> list[dict]:
    return [{"id": f"s{i}", "text": f"第{i}句", "room": 2.0} for i in range(1, n + 1)]


class TranslateLines(unittest.TestCase):
    def test_lines_left_out_are_asked_for_again(self):
        # the first answer for each batch of 20 leaves out lines 10–20; asked again, they come back
        fake = Fake(skip=lambda user, n: translate.AGAIN_NOTE not in user and n >= 10)  # only asking again brings them back
        saved = {}
        with mock.patch("services.translate._call", fake):
            out = translate.translate_lines(lines_of(45), "zh", lambda f: None, on_batch=saved.update, brief=BRIEF)
        self.assertEqual(len(out), 45)
        self.assertEqual(saved, out)  # every line reached on_batch
        again = [u for u in fake.asked if translate.AGAIN_NOTE in u]
        self.assertTrue(again)
        self.assertTrue(all(len(numbered(u)) <= translate.RETRY_CHUNK for u in again))
        self.assertTrue(all("About this video" in u and "周元 → ចូវ យាន" in u and "筷债 → 赌债" in u for u in fake.asked))  # the brief, every time
        self.assertIn("Earlier lines, for context only", again[0])

    def test_one_by_one_when_runs_fail(self):
        # runs of several lines keep coming back empty; single lines work
        fake = Fake(skip=lambda user, n: len(numbered(user)) > 1)
        with mock.patch("services.translate._call", fake):
            out = translate.translate_lines(lines_of(12), "zh", lambda f: None)
        self.assertEqual(len(out), 12)
        self.assertTrue(any(len(numbered(u)) == 1 for u in fake.asked))

    def test_a_failed_batch_is_recovered(self):
        calls = {"n": 0}

        def fail(user):  # the very first request fails (the service is busy), later ones work
            calls["n"] += 1
            return calls["n"] == 1

        with mock.patch("services.translate._call", Fake(fail=fail)):
            out = translate.translate_lines(lines_of(30), "zh", lambda f: None)
        self.assertEqual(len(out), 30)  # no error: everything came back in the end

    def test_still_failing_keeps_what_was_translated(self):
        fake = Fake(fail=lambda user: re.search(r"^\[\d+\].*第25句", user, re.M))  # the service never answers for line 25
        saved = {}
        with mock.patch("services.translate._call", fake), self.assertRaises(AppError) as err:
            translate.translate_lines(lines_of(30), "zh", lambda f: None, on_batch=saved.update)
        self.assertIn("lines are translated and kept", err.exception.hint)
        self.assertEqual(len(saved), 29)  # every line but 25, kept

    def test_progress_ends_at_one(self):
        seen = []
        with mock.patch("services.translate._call", Fake(skip=lambda user, n: translate.AGAIN_NOTE not in user and n == 3)):
            translate.translate_lines(lines_of(10), "zh", seen.append)
        self.assertEqual(seen[-1], 1.0)
        self.assertEqual(seen, sorted(seen))


class Brief(unittest.TestCase):
    def test_brief_is_tidied(self):
        answer = {"topic": " A  drama ", "names": [{"original": "周元", "khmer": "ចូវ យាន", "note": "rich"}, {"original": "李镇", "khmer": "Li Zhen", "note": ""},
                                                {"original": "", "khmer": "x", "note": ""}],
                  "terms": [{"original": "两", "khmer": "តម្លឹង"}], "misheard": [{"heard": "筷债", "meant": "赌债"}, {"heard": "a", "meant": "a"}]}
        with mock.patch("services.translate._call", Fake(brief=answer)) as fake:
            b = translate.brief([f"第{i}句" for i in range(10)], "zh")
        self.assertEqual(b["topic"], "A drama")
        self.assertEqual([n["original"] for n in b["names"]], ["周元"])  # a name not in Khmer letters is left out
        self.assertEqual(b["misheard"], [{"heard": "筷债", "meant": "赌债"}])
        self.assertIn("(Chinese)", fake.asked[0])

    def test_long_transcripts_are_sampled_and_short_ones_skipped(self):
        fake = Fake(brief={"topic": "x", "names": [], "terms": [], "misheard": []})
        with mock.patch("services.translate._call", fake):
            translate.brief(["很长的一句话" * 10] * 2000, "zh")
            self.assertIsNone(translate.brief(["一", "二"], "zh"))
        self.assertLessEqual(len(fake.asked[0]), translate.BRIEF_CHARS + 2000)
        self.assertEqual(len(fake.asked), 1)

    def test_failure_means_no_brief(self):
        with mock.patch("services.translate._call", Fake(fail=lambda user: True)):
            self.assertIsNone(translate.brief(["一", "二", "三"], "zh"))


class Restyle(unittest.TestCase):
    def test_lines_without_khmer_are_filled(self):
        lines = [{"id": f"s{i}", "text": f"第{i}句", "room": 2.0, "khmer": "" if i > 5 else "ចាស់"} for i in range(1, 13)]
        fake = Fake(skip=lambda user, n: translate.AGAIN_NOTE not in user and n > 5)
        with mock.patch("services.translate._call", fake):
            out = translate.restyle(lines, "zh", "natural", brief=BRIEF)
        self.assertEqual(sorted(out, key=lambda x: int(x[1:])), [f"s{i}" for i in range(1, 13)])
        self.assertIn("(none yet: translate it)", fake.asked[0])
        self.assertIn("About this video", fake.asked[0])


class ProjectBriefAndImprove(unittest.TestCase):
    def setUp(self):
        self.data = Path(tempfile.mkdtemp(prefix="kva-data-"))
        self._old = (config.DATA_DIR, config.PROJECTS_DIR)
        config.DATA_DIR, config.PROJECTS_DIR = self.data, self.data / "projects"
        config.PROJECTS_DIR.mkdir(parents=True)
        p = store.create("clip.mp4")
        self.pid = p["id"]

        def setup(project):
            project.update(video={"file": "source.mp4", "duration": 30.0, "width": 640, "height": 360, "fps": 30}, detected_lang="zh", source_lang="auto")
            timeline.init(project, project["video"], "clip.mp4")
            timeline.track(project, "voice")["clips"] = [
                sentences.make(f"s{i}", i * 2.0, i * 2.0 + 1.5, original_text=t, khmer_text=k)
                for i, (t, k) in enumerate([("水这么急", "ទឹកហូរខ្លាំងម្ល៉េះ"), ("还了筷债", ""), ("明日上报李镇", "ថ្ងៃស្អែករាយការណ៍")], 1)
            ]
        store.mutate(self.pid, setup)

    def tearDown(self):
        config.DATA_DIR, config.PROJECTS_DIR = self._old
        shutil.rmtree(self.data, ignore_errors=True)

    def test_brief_is_made_once_and_kept(self):
        fake = Fake(brief=BRIEF)
        with mock.patch("services.translate._call", fake), mock.patch("services.translate.provider", return_value="gemini"):
            first = briefs.get(self.pid)
            again = briefs.get(self.pid)
        self.assertEqual(first, again)
        self.assertEqual(len(fake.asked), 1)
        project = store.load(self.pid)
        self.assertEqual(project["translation_brief"]["names"][0]["khmer"], "ចូវ យាន")
        self.assertEqual(project["history"]["undo"], 0)  # not an edit

    def test_improve_endpoint(self):
        from fastapi import FastAPI
        from fastapi.responses import JSONResponse
        from fastapi.testclient import TestClient
        import api_editor

        app = FastAPI()

        @app.exception_handler(AppError)
        async def app_error(_req, err):
            return JSONResponse({"error": err.to_dict()}, status_code=err.status)

        app.include_router(api_editor.router)
        client = TestClient(app)
        answer = {"natural": "សងបំណុលល្បែងរួចហើយ", "shorter": "សងបំណុលហើយ", "formal": "បានសងបំណុលល្បែងរួចរាល់", "meant": "还了赌债"}
        fake = Fake(brief=BRIEF, improve=answer)
        with mock.patch("services.translate._call", fake), mock.patch("services.translate.provider", return_value="gemini"), \
                mock.patch("services.translate.last_model", return_value=config.GEMINI_FALLBACK_MODEL), \
                mock.patch.object(config, "GEMINI_MODEL", "gemini-flash-latest"), mock.patch.object(config, "GEMINI_FALLBACK_MODEL", "gemini-flash-lite-latest"):
            res = client.post(f"/api/projects/{self.pid}/sentences/s2/suggest", json={"instruction": "  use  បង  "})
        self.assertEqual(res.status_code, 200, res.text)
        body = res.json()
        self.assertEqual([o["style"] for o in body["options"]], ["natural", "shorter", "formal"])
        self.assertEqual(body["meant"], "还了赌债")
        self.assertTrue(body["backup"])
        self.assertIn("budget", body)
        prompt = fake.asked[-1]
        self.assertIn("It has no Khmer yet", prompt)
        self.assertIn('"use បង"', prompt)  # the editor's wish, tidied
        self.assertIn('"水这么急" → "ទឹកហូរខ្លាំងម្ល៉េះ"', prompt)  # the lines around it, original and Khmer
        self.assertIn("周元 → ចូវ យាន", prompt)  # and the brief
        # without a body (older pages) it still works
        with mock.patch("services.translate._call", Fake(brief=BRIEF, improve={**answer, "meant": "还了筷债"})), \
                mock.patch("services.translate.provider", return_value="gemini"):
            res = client.post(f"/api/projects/{self.pid}/sentences/s2/suggest")
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json()["meant"], "")  # the same as heard: nothing to show


if __name__ == "__main__":
    unittest.main()
