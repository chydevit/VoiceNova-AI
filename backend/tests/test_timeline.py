"""The edit list: upgrading old projects, splitting clips, background pieces, skipped parts.

Run from the backend folder:  .venv/bin/python -m unittest discover tests
"""
import unittest

import sentences
import timeline

VIDEO = {"file": "source.mp4", "duration": 100.0, "width": 640, "height": 360, "fps": 30}


def sentence(sid, start, end, text="សួស្តី"):
    return sentences.make(sid, start, end, original_text="hi", khmer_text=text)


def project_v3(state=None, video=VIDEO):
    """A schema 2 state upgraded to today's edit list (its sentences are made as today's: their volumes
    go back to schema 2's fractions first)."""
    state = state or {"sentences": [], "settings": {"background": "duck", "background_volume": 0.15}, "original_gaps": [], "next_id": 1}
    state = {**state, "sentences": [{**s, "volume": s.get("volume", 100) / 100} for s in state.get("sentences", [])]}
    p = {"video": dict(video), "name": "x.mp4", **timeline.migrate_state(state, video)}
    p["media"] = {"source": timeline.source_media(video, "x.mp4")}
    return p


class Migration(unittest.TestCase):
    def test_plain_project_is_one_clip_with_its_sound(self):
        p = project_v3({"sentences": [sentence("s1", 1, 2), sentence("s2", 3, 4)], "settings": {}, "original_gaps": [], "next_id": 3})
        video = timeline.clips(p, "video")
        self.assertEqual(len(video), 1)
        self.assertEqual((video[0]["start"], video[0]["end"], video[0]["source_in"], video[0]["source_out"]), (0, 100, 0, 100))
        bg = timeline.clips(p, "background")
        self.assertEqual(len(bg), 1)
        self.assertEqual(bg[0]["link"], video[0]["id"])
        self.assertEqual([s["id"] for s in timeline.clips(p, "voice")], ["s1", "s2"])
        self.assertEqual(timeline.clips(p, "voice")[0]["type"], "voice")
        self.assertEqual(p["settings"]["export"], timeline.default_export())
        self.assertNotIn("video_cuts", p["settings"])

    def test_video_cuts_become_skipped_clips(self):
        settings = {"video_cuts": [{"start": 10, "end": 20}, {"start": 50, "end": 55}]}
        p = project_v3({"sentences": [], "settings": settings, "original_gaps": [], "next_id": 1})
        video = timeline.clips(p, "video")
        self.assertEqual([(c["start"], c["end"], c["skipped"]) for c in video],
                         [(0, 10, False), (10, 20, True), (20, 50, False), (50, 55, True), (55, 100, False)])
        self.assertEqual(timeline.skipped_ranges(p), [{"start": 10, "end": 20}, {"start": 50, "end": 55}])
        # every background piece sits on the video clip it plays under
        for b in timeline.clips(p, "background"):
            v = next(c for c in video if c["id"] == b["link"])
            self.assertTrue(v["start"] <= b["start"] and b["end"] <= v["end"])

    def test_background_parts_and_gaps_become_pieces(self):
        settings = {"background_cuts": [{"start": 30, "end": 40, "gain": 0.0, "fade": 1.0}, {"start": 60, "end": 70, "gain": 1.5, "fade": 0.05}]}
        p = project_v3({"sentences": [], "settings": settings, "original_gaps": [{"start": 35, "end": 45}], "next_id": 1})
        pieces = [(b["start"], b["end"], b["volume"], b["keep_voice"], b["fade_in"], b["fade_out"]) for b in timeline.clips(p, "background")]
        self.assertEqual(pieces, [
            (0, 30, 100, False, 0, 0),  # volumes are percents since schema 4
            (30, 35, 0, False, 1.0, 0),  # the part's fade, at its own edges only
            (35, 40, 0, True, 0, 1.0),
            (40, 45, 100, True, 0, 0),
            (45, 60, 100, False, 0, 0),
            (60, 70, 150, False, 0.05, 0.05),
            (70, 100, 100, False, 0, 0),
        ])

    def test_snapshot_without_video(self):
        out = timeline.migrate_state({"sentences": [], "settings": {}, "next_id": 4}, None)
        self.assertEqual(out["next_id"], 4)
        self.assertEqual(timeline.clips(out, "video"), [])


class Splitting(unittest.TestCase):
    def test_split_video_moves_its_sound_pieces(self):
        p = project_v3({"sentences": [], "settings": {"background_cuts": [{"start": 40, "end": 60, "gain": 0.5, "fade": 0.05}]}, "original_gaps": [], "next_id": 1})
        v = timeline.clips(p, "video")[0]
        right = timeline.split_at(p, v, 50)
        self.assertEqual((v["end"], v["source_out"], right["start"], right["source_in"]), (50, 50, 50, 50))
        bg = timeline.clips(p, "background")
        links = [(b["start"], b["end"], b["link"]) for b in bg]
        self.assertEqual(links, [(0, 40, v["id"]), (40, 50, v["id"]), (50, 60, right["id"]), (60, 100, right["id"])])
        # the split doesn't add fades in the middle of the part
        self.assertEqual((bg[1]["fade_out"], bg[2]["fade_in"]), (0, 0))
        self.assertEqual((bg[1]["fade_in"], bg[2]["fade_out"]), (0.05, 0.05))

    def test_split_too_close_to_an_edge(self):
        p = project_v3()
        v = timeline.clips(p, "video")[0]
        self.assertIsNone(timeline.split_at(p, v, 0.01))
        self.assertEqual(len(timeline.clips(p, "video")), 1)

    def test_moving_a_video_clip_moves_its_sound(self):
        p = project_v3()
        v = timeline.clips(p, "video")[0]
        right = timeline.split_at(p, v, 50)
        right["start"], right["end"] = 60, 110  # leave a gap
        timeline.relink(p)
        b = timeline.clips(p, "background")[-1]
        self.assertEqual((b["start"], b["end"], b["source_in"]), (60, 110, 50))

    def test_trimmed_video_drops_sound_outside_it(self):
        p = project_v3()
        v = timeline.clips(p, "video")[0]
        v["source_out"], v["end"] = 80, 80
        timeline.relink(p)
        self.assertEqual(timeline.clips(p, "background")[0]["end"], 80)

    def test_delete_sentence_keeping_the_original_audio(self):
        p = project_v3({"sentences": [sentence("s1", 10, 12), sentence("s2", 20, 25)], "settings": {}, "original_gaps": [], "next_id": 3})
        sentences.remove(p, "s2", "original")
        kept = [(b["start"], b["end"]) for b in timeline.clips(p, "background") if b["keep_voice"]]
        self.assertEqual(kept, [(20, 25)])
        self.assertEqual([s["id"] for s in sentences.items(p)], ["s1"])


class Time(unittest.TestCase):
    def test_output_time_and_kept_ranges(self):
        skipped = [{"start": 10, "end": 20}]
        self.assertEqual(timeline.output_time(5, skipped), 5)
        self.assertEqual(timeline.output_time(15, skipped), 10)
        self.assertEqual(timeline.output_time(25, skipped), 15)
        self.assertEqual(timeline.kept_ranges(skipped, 30), [(0.0, 10), (20, 30)])

    def test_sentences_live_on_the_timeline(self):
        p = project_v3({"sentences": [sentence("s1", 10, 12)], "settings": {"voice": "female", "speed": 1.0}, "original_gaps": [], "next_id": 2})
        self.assertEqual(sentences.limit(p), 100)
        s = sentences.add(p, 50, None, "ថ្មី", "")
        self.assertEqual(s["type"], "voice")
        self.assertEqual([x["id"] for x in sentences.items(p)], ["s1", s["id"]])
        self.assertEqual(sentences.room_end(p, 1), 100)


if __name__ == "__main__":
    unittest.main()
