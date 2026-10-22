"""Undo / redo with steps that store only what changed."""
import copy
import tempfile
import time
import unittest
from pathlib import Path

import history
import sentences
import timeline
from tests.test_timeline import project_v3, sentence


def edit(folder, project, fn, label="Edit", group=None):
    before = history.snapshot(project)
    fn(project)
    timeline.sort(project)
    history.record(folder, project, before, label, group)


class Steps(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.folder = Path(self.dir.name)
        self.p = project_v3({"sentences": [sentence("s1", 1, 2, "មួយ"), sentence("s2", 3, 4, "ពីរ")], "settings": {"background": "duck", "background_volume": 0.15}, "original_gaps": [], "next_id": 3})
        self.p["history"] = dict(history.EMPTY_COUNTS)

    def tearDown(self):
        self.dir.cleanup()

    def text(self):
        return [s["khmer_text"] for s in sentences.items(self.p)]

    def test_undo_redo_text_and_structure(self):
        start = history.snapshot(self.p)
        edit(self.folder, self.p, lambda p: sentences.patch(p, "s1", {"khmer_text": "បី"}, ("female",)), "Edit Khmer text")
        edit(self.folder, self.p, lambda p: timeline.split_at(p, timeline.clips(p, "video")[0], 50), "Split clip")
        edit(self.folder, self.p, lambda p: sentences.remove(p, "s2", "original"), "Delete sentence")
        after = history.snapshot(self.p)
        self.assertEqual(self.p["history"]["undo"], 3)
        self.assertEqual(history.step(self.folder, self.p, "undo"), "Delete sentence")
        self.assertEqual(self.text(), ["បី", "ពីរ"])
        history.step(self.folder, self.p, "undo")
        history.step(self.folder, self.p, "undo")
        self.assertEqual(history.snapshot(self.p), start)
        self.assertIsNone(history.step(self.folder, self.p, "undo"))
        for _ in range(3):
            history.step(self.folder, self.p, "redo")
        self.assertEqual(history.snapshot(self.p), after)

    def test_typing_is_one_step(self):
        for text in ("ក", "កខ", "កខគ"):
            edit(self.folder, self.p, lambda p, t=text: sentences.patch(p, "s1", {"khmer_text": t}, ("female",)), "Edit Khmer text", group="s1:khmer_text")
        self.assertEqual(self.p["history"]["undo"], 1)
        history.step(self.folder, self.p, "undo")
        self.assertEqual(self.text(), ["មួយ", "ពីរ"])

    def test_typing_back_to_where_it_was_is_no_step(self):
        edit(self.folder, self.p, lambda p: sentences.patch(p, "s1", {"khmer_text": "ក"}, ("female",)), "Edit", group="g")
        edit(self.folder, self.p, lambda p: sentences.patch(p, "s1", {"khmer_text": "មួយ"}, ("female",)), "Edit", group="g")
        self.assertEqual(self.p["history"]["undo"], 0)

    def test_redo_brings_back_a_clip_voiced_meanwhile(self):
        edit(self.folder, self.p, lambda p: sentences.patch(p, "s1", {"khmer_text": "ថ្មី"}, ("female",)), "Edit Khmer text")
        s1 = sentences.items(self.p)[0]
        s1.update(audio_file_path="clips/new.wav", audio_key=sentences.clip_key(s1), audio_duration=0.5)  # voiced, without an undo step
        history.step(self.folder, self.p, "undo")
        history.step(self.folder, self.p, "redo")
        self.assertEqual(sentences.items(self.p)[0]["audio_file_path"], "clips/new.wav")

    def test_new_edit_forgets_redo(self):
        edit(self.folder, self.p, lambda p: sentences.patch(p, "s1", {"khmer_text": "ក"}, ("female",)))
        history.step(self.folder, self.p, "undo")
        self.assertEqual(self.p["history"]["redo"], 1)
        edit(self.folder, self.p, lambda p: sentences.patch(p, "s2", {"khmer_text": "ខ"}, ("female",)))
        self.assertEqual(self.p["history"]["redo"], 0)
        self.assertEqual(len(list((self.folder / "history").glob("*.json"))), 2)  # index + one step

    def test_steps_are_small(self):
        big = project_v3({"sentences": [sentence(f"s{i}", i * 2, i * 2 + 1) for i in range(1, 1200)], "settings": {}, "original_gaps": [], "next_id": 1200})
        big["history"] = dict(history.EMPTY_COUNTS)
        edit(self.folder, big, lambda p: sentences.patch(p, "s600", {"khmer_text": "ថ្មី"}, ("female",)))
        step = next(f for f in (self.folder / "history").glob("*.json") if f.name != "index.json")
        self.assertLess(step.stat().st_size, 3000)

    def test_old_steps_dropped_past_the_budget(self):
        old = history.HISTORY_BYTES
        history.HISTORY_BYTES = 2000
        try:
            for i in range(30):
                edit(self.folder, self.p, lambda p, i=i: sentences.patch(p, "s1", {"khmer_text": f"ក{i}"}, ("female",)))
            self.assertLess(self.p["history"]["undo"], 30)
            self.assertGreater(self.p["history"]["undo"], 1)
        finally:
            history.HISTORY_BYTES = old

    def test_compose_keeps_first_before(self):
        a = {"keys": {"settings": [1, 2]}, "tracks": {"voice": {"clips": {"s1": [{"x": 1}, {"x": 2}]}}}}
        b = {"keys": {"settings": [2, 3]}, "tracks": {"voice": {"clips": {"s1": [{"x": 2}, {"x": 3}], "s2": [None, {"x": 9}]}}}}
        c = history.compose(copy.deepcopy(a), b)
        self.assertEqual(c["keys"]["settings"], [1, 3])
        self.assertEqual(c["tracks"]["voice"]["clips"], {"s1": [{"x": 1}, {"x": 3}], "s2": [None, {"x": 9}]})


if __name__ == "__main__":
    unittest.main()
