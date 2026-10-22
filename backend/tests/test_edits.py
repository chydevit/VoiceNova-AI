"""Stage 2 edits: trim, delete (leave a gap / close it), remove a range, skip, close a gap."""
import unittest

import render
import sentences
import timeline
from errors import AppError
from tests.test_timeline import project_v3, sentence


def make(*voice, music=None):
    p = project_v3({"sentences": list(voice), "settings": {"background": "duck", "background_volume": 0.5, "voice": "female", "speed": 1.0},
                    "original_gaps": [], "next_id": 10})
    if music:
        p["media"]["m1"] = {"kind": "audio", "file": "media/m1.mp3", "name": "music.mp3", "duration": 300}
        timeline.clips(p, "audio").append({"id": "a1", "type": "audio", "media": "m1", "start": music[0], "end": music[1],
                                           "source_in": 0.0, "source_out": music[1] - music[0], "volume": 100, "muted": False, "fade_in": 0, "fade_out": 0, "skipped": False})
    return p


def spans(p, tid):
    return [(c["start"], c["end"]) for c in timeline.clips(p, tid)]


class Trim(unittest.TestCase):
    def test_shrink_and_grow_back_keeps_one_sound_piece(self):
        p = make()
        v = timeline.clips(p, "video")[0]
        timeline.trim(p, v["id"], "end", 80)
        self.assertEqual(spans(p, "background"), [(0, 80)])
        timeline.trim(p, v["id"], "end", 90)
        self.assertEqual(spans(p, "background"), [(0, 90)])
        self.assertEqual(len(timeline.clips(p, "background")), 1)

    def test_grow_cannot_pass_the_file_or_the_next_clip(self):
        p = make()
        v = timeline.clips(p, "video")[0]
        right = timeline.split_at(p, v, 50)
        timeline.trim(p, v["id"], "end", 70)  # the next clip starts at 50
        self.assertEqual(v["end"], 50)
        timeline.trim(p, right["id"], "end", 140)  # the file is 100 s long
        self.assertEqual((right["end"], right["source_out"]), (100, 100))
        timeline.trim(p, right["id"], "start", 70)  # trimming the start leaves a gap; the picture stays put
        self.assertEqual((right["start"], right["source_in"]), (70, 70))
        self.assertEqual(spans(p, "background"), [(0, 50), (70, 100)])

    def test_a_silent_edge_stays_silent_and_new_part_gets_sound(self):
        p = make()
        v = timeline.clips(p, "video")[0]
        timeline.trim(p, v["id"], "end", 80)
        timeline.volume_range(p, "background", 70, 80, 0)
        timeline.trim(p, v["id"], "end", 90)
        self.assertEqual([(b["start"], b["end"], b["volume"]) for b in timeline.clips(p, "background")], [(0, 70, 100), (70, 90, 0)])
        timeline.trim(p, v["id"], "end", 80)
        timeline.clips(p, "background")[-1]["source_out"] = 75  # leave a hole at the end on purpose
        timeline.relink(p)
        timeline.trim(p, v["id"], "end", 90)
        self.assertEqual([(b["start"], b["end"], b["volume"]) for b in timeline.clips(p, "background")], [(0, 70, 100), (70, 75, 0), (80, 90, 100)])

    def test_background_piece_stays_inside_its_clip(self):
        p = make()
        timeline.volume_range(p, "background", 30, 40, 0)
        piece = timeline.clips(p, "background")[1]
        timeline.trim(p, piece["id"], "start", 10)  # the piece before it ends at 30
        self.assertEqual(piece["start"], 30)
        timeline.trim(p, piece["id"], "end", 35)
        self.assertEqual(spans(p, "background"), [(0, 30), (30, 35), (40, 100)])  # 35–40 is now silent

    def test_locked_track(self):
        p = make()
        timeline.track(p, "video")["locked"] = True
        with self.assertRaises(AppError):
            timeline.trim(p, timeline.clips(p, "video")[0]["id"], "end", 50)


class Delete(unittest.TestCase):
    def test_leave_a_gap(self):
        p = make(sentence("s1", 10, 12), sentence("s2", 60, 62))
        v = timeline.clips(p, "video")[0]
        right = timeline.split_at(p, v, 50)
        timeline.delete(p, [right["id"]])
        self.assertEqual(spans(p, "video"), [(0, 50)])
        self.assertEqual(spans(p, "background"), [(0, 50)])
        self.assertEqual(spans(p, "voice"), [(10, 12), (60, 62)])  # the voice stays, over black
        self.assertEqual(render.plan(p)["length"], 62)

    def test_ripple_delete_moves_everything_up(self):
        p = make(sentence("s1", 10, 12), sentence("s2", 25, 28), sentence("s3", 38, 44), sentence("s4", 60, 62), music=(0, 100))
        v = timeline.clips(p, "video")[0]
        middle = timeline.split_at(p, v, 20)
        timeline.split_at(p, middle, 40)
        timeline.delete(p, [middle["id"]], ripple=True)
        self.assertEqual(spans(p, "video"), [(0, 20), (20, 80)])
        self.assertEqual(spans(p, "background"), [(0, 20), (20, 80)])
        # s2 was inside: gone; s3 ran past the end: keeps its part after it (from the cut on); s4 moved up
        self.assertEqual([(s["id"], s["start"], s["end"]) for s in sentences.items(p)], [("s1", 10, 12), ("s3", 20, 24), ("s4", 40, 42)])
        # the music is cut out there too
        self.assertEqual([(c["start"], c["end"], c["source_in"], c["source_out"]) for c in timeline.clips(p, "audio")], [(0, 20, 0, 20), (20, 80, 40, 100)])

    def test_locked_tracks_are_left_alone(self):
        p = make(sentence("s1", 10, 12), sentence("s4", 60, 62), music=(0, 100))
        timeline.track(p, "audio")["locked"] = True
        timeline.remove_range(p, 20, 40)
        self.assertEqual(spans(p, "audio"), [(0, 100)])  # the music keeps playing where it was
        self.assertEqual(spans(p, "voice"), [(10, 12), (40, 42)])

    def test_a_sentence_across_the_start_keeps_its_beginning(self):
        p = make(sentence("s1", 18, 25), sentence("s2", 19.9, 20.05))
        timeline.remove_range(p, 20, 30)
        self.assertEqual(spans(p, "voice"), [(18, 20)])  # s2 would be too short: gone

    def test_close_a_gap(self):
        p = make(sentence("s1", 70, 72))
        v = timeline.clips(p, "video")[0]
        right = timeline.split_at(p, v, 50)
        timeline.trim(p, right["id"], "start", 60)
        self.assertEqual(timeline.close_gap(p, 55), (50, 60))
        self.assertEqual(spans(p, "video"), [(0, 50), (50, 90)])
        self.assertEqual(spans(p, "voice"), [(60, 62)])

    def test_close_a_gap_with_voice_in_it(self):
        p = make(sentence("s1", 52, 54))
        v = timeline.clips(p, "video")[0]
        right = timeline.split_at(p, v, 50)
        timeline.trim(p, right["id"], "start", 60)
        with self.assertRaises(AppError):
            timeline.close_gap(p, 55)
        with self.assertRaises(AppError):
            timeline.close_gap(p, 30)  # not a gap


class Skip(unittest.TestCase):
    def test_skip_a_range_and_bring_it_back(self):
        p = make(sentence("s1", 10, 12), sentence("s2", 25, 28))
        self.assertEqual(timeline.skip_range(p, 20, 30), 1)
        self.assertEqual([(c["start"], c["end"], c["skipped"]) for c in timeline.clips(p, "video")], [(0, 20, False), (20, 30, True), (30, 100, False)])
        plan = render.plan(p)
        self.assertEqual(plan["length"], 90)
        self.assertEqual([s["id"] for s in plan["voice"]], ["s1"])
        timeline.skip_range(p, 20, 30, False)
        self.assertEqual(render.plan(p)["length"], 100)
        self.assertEqual(len(render.plan(p)["video"]), 1)  # the pieces play as one again

    def test_skip_clips(self):
        p = make(sentence("s1", 10, 12))
        timeline.set_skipped(p, ["s1"], True)
        self.assertEqual(render.plan(p)["voice"], [])


class Props(unittest.TestCase):
    def test_background_volume_and_fades(self):
        p = make()
        b = timeline.clips(p, "background")[0]
        timeline.set_props(p, b["id"], {"volume": 37, "fade_in": 2.0, "keep_voice": True})
        self.assertEqual((b["volume"], b["fade_in"], b["keep_voice"]), (37, 2.0, True))
        timeline.set_props(p, b["id"], {"volume": 250.4, "muted": True})  # whole percents, at most 200
        self.assertEqual((b["volume"], b["muted"]), (200, True))
        with self.assertRaises(AppError):
            timeline.set_props(p, b["id"], {"text": "x"})


if __name__ == "__main__":
    unittest.main()
