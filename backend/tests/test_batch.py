"""Stage 5: many sentences at once — voice them again, translate them again in a style, fit them."""
import tempfile
import unittest
from unittest import mock
from pathlib import Path

import config
import history
import pipeline
import sentences
import store
import timeline
from services import media, translate, voicecheck
from tests.test_timeline import VIDEO, sentence


class FakeVoice:
    """Speaks any text as a tone, as long as a Khmer voice would take for it."""
    name, label, genders = "fake", "Fake voice", ("female", "male")

    def __init__(self):
        self.calls = 0

    def status(self):
        return True, ""

    def synthesize(self, text, gender, speed, out, attempt=0):
        self.calls += 1
        seconds = max(0.4, voicecheck.letters(text) * voicecheck.TYPICAL_SECONDS_PER_LETTER)
        out = Path(f"{out}.wav")
        media.ffmpeg("-f", "lavfi", "-i", f"sine=f=300:d={seconds:.2f}", "-af", "volume=0.5", out, what="fake voice")
        return out


@unittest.skipUnless(config.FFMPEG, "needs FFmpeg")
class Batch(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.old = (config.PROJECTS_DIR, pipeline._provider, translate.restyle, translate.provider, config.VOICE_RETRIES)
        config.PROJECTS_DIR = Path(self.dir.name)
        config.VOICE_RETRIES = 0
        self.voice = FakeVoice()
        pipeline._provider = lambda: self.voice
        p = store.create("x.mp4")

        def setup(q):
            q["video"] = dict(VIDEO)
            timeline.init(q, q["video"], "x.mp4")
            timeline.track(q, "voice")["clips"] = [sentence("s1", 10, 13, "សួស្តីបង"), sentence("s2", 20, 21, "ខ្ញុំមិនដឹងថាត្រូវធ្វើអ្វីទៀតទេ"), sentence("s3", 30, 33, "អរគុណ")]
            q["status"] = "done"

        self.pid = store.mutate(p["id"], setup)["id"]
        self.reports = []

    def tearDown(self):
        config.PROJECTS_DIR, pipeline._provider, translate.restyle, translate.provider, config.VOICE_RETRIES = self.old
        self.dir.cleanup()

    def report(self, fraction=None, message=None):
        self.reports.append((fraction, message))

    def items(self):
        return {s["id"]: s for s in sentences.items(store.load(self.pid))}

    def test_voice_a_range(self):
        pipeline.batch_task(self.pid, self.report, "voice", ["s1", "s3"])
        items = self.items()
        self.assertTrue(sentences.has_clip(items["s1"]) and sentences.has_clip(items["s3"]))
        self.assertFalse(sentences.has_clip(items["s2"]))
        self.assertEqual(self.voice.calls, 2)
        self.assertEqual(self.reports[-1][0], 1.0)
        pipeline.batch_task(self.pid, self.report, "voice", ["s1"], force=False)  # cached: not voiced again
        self.assertEqual(self.voice.calls, 2)

    def test_translate_again_in_a_style_is_one_undo_step(self):
        seen = {}

        def restyle(lines, source_lang, style, on_progress=None, brief=None):
            seen["style"], seen["lines"] = style, [l["id"] for l in lines]
            return {l["id"]: f"{l['khmer']}ណាស់" for l in lines}

        translate.restyle, translate.provider = restyle, lambda: "fake"
        with mock.patch("briefs.get", return_value=None):  # the video's brief: see test_translate
            pipeline.batch_task(self.pid, self.report, "restyle", ["s1", "s2"], style="casual")
        items = self.items()
        self.assertEqual(seen, {"style": "casual", "lines": ["s1", "s2"]})
        self.assertEqual(items["s1"]["khmer_text"], "សួស្តីបងណាស់")
        self.assertTrue(sentences.has_clip(items["s1"]))  # voiced with its new text
        self.assertEqual(items["s3"]["khmer_text"], "អរគុណ")
        p = store.load(self.pid)
        self.assertEqual(p["history"]["undo_label"], "Translate again")
        history.step(store.project_dir(self.pid), p, "undo")
        self.assertEqual(sentences.items(p)[0]["khmer_text"], "សួស្តីបង")

    def test_fit_too_long_sentences(self):
        pipeline.batch_task(self.pid, self.report, "voice", ["s2"])
        self.assertEqual(self.items()["s2"]["status"], "too_long")  # a long line in a 1 s slot
        translate.provider = lambda: None  # no translator: it can only use the pause and speed up
        pipeline.batch_task(self.pid, self.report, "fit", ["s2"])
        s2 = self.items()["s2"]
        self.assertGreater(s2["end"], 21)  # it took the pause after it
        self.assertEqual(store.load(self.pid)["history"]["undo_label"], "Fix timing")


if __name__ == "__main__":
    unittest.main()
