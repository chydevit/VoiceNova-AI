"""The render plan: what the export draws and plays, in output time."""
import unittest

import render
import timeline
from tests.test_timeline import VIDEO, project_v3, sentence


def old_level(normal: float, gaps: list, in_gaps: float, parts: list, t: float) -> float:
    """The background level of the export before the edit list (services/merge._level, schema 2)."""
    base = in_gaps if any(g["start"] <= t <= g["end"] for g in gaps) else normal
    factor = 1.0
    for p in parts:
        fade = max(p.get("fade", 0.05), 0.01)
        factor += (p["gain"] - 1) * min(1.0, max(0.0, min(t - p["start"], p["end"] - t) / fade))
    return base * max(0.0, factor)


def new_level(plan: dict, stream: str, t: float) -> float:
    return sum(render.gain_at(run, t - run["start"]) for run in plan["sound"] if run["stream"] == stream and run["start"] <= t < run["end"])


class Plan(unittest.TestCase):
    def test_untouched_project(self):
        p = project_v3({"sentences": [sentence("s1", 1, 2)], "settings": {"background": "duck", "background_volume": 0.15}, "original_gaps": [], "next_id": 2})
        plan = render.plan(p)
        self.assertEqual(plan["length"], 100)
        self.assertEqual(plan["canvas"], (640, 360))
        self.assertEqual(plan["video"], [{"kind": "video", "start": 0, "end": 100, "media": "source", "source_in": 0, "source_out": 100, "speed": 1.0}])
        self.assertEqual(len(plan["sound"]), 1)
        self.assertEqual([s["id"] for s in plan["voice"]], ["s1"])

    def test_skipped_parts_are_left_out_everywhere(self):
        state = {"sentences": [sentence("s1", 5, 8), sentence("s2", 12, 15), sentence("s3", 30, 33)],
                 "settings": {"background": "duck", "background_volume": 0.5, "video_cuts": [{"start": 10, "end": 20}]},
                 "original_gaps": [], "next_id": 4}
        p = project_v3(state)
        plan = render.plan(p)
        self.assertEqual(plan["length"], 90)
        self.assertEqual([(v["start"], v["end"], v["source_in"], v["source_out"]) for v in plan["video"]], [(0, 10, 0, 10), (10, 90, 20, 100)])
        self.assertEqual([s["id"] for s in plan["voice"]], ["s1", "s3"])  # s2 is inside the skipped part
        self.assertEqual([(s["id"], a, b) for s, _, a, b in plan["subtitles"]], [("s1", 5, 8), ("s3", 20, 23)])
        self.assertEqual([(r["start"], r["end"], r["source_in"]) for r in plan["sound"]], [(0, 10, 0), (10, 90, 20)])

    def test_gaps_are_black(self):
        p = project_v3()
        v = timeline.clips(p, "video")[0]
        right = timeline.split_at(p, v, 50)
        right["start"], right["end"] = 60, 110
        timeline.relink(p)
        plan = render.plan(p)
        self.assertEqual([(s["kind"], s["start"], s["end"]) for s in plan["video"]], [("video", 0, 50), ("black", 50, 60), ("video", 60, 110)])
        self.assertEqual(plan["length"], 110)

    def test_continuous_splits_play_as_one(self):
        p = project_v3()
        v = timeline.clips(p, "video")[0]
        timeline.split_at(p, v, 30)
        timeline.split_at(p, timeline.clips(p, "video")[1], 60)
        plan = render.plan(p)
        self.assertEqual(len(plan["video"]), 1)
        self.assertEqual(len(plan["sound"]), 1)

    def test_hidden_and_muted_tracks(self):
        p = project_v3({"sentences": [sentence("s1", 1, 2)], "settings": {"background": "duck", "background_volume": 0.5}, "original_gaps": [], "next_id": 2})
        timeline.track(p, "video")["hidden"] = True
        timeline.track(p, "background")["muted"] = True
        timeline.track(p, "voice")["muted"] = True
        timeline.track(p, "text")["hidden"] = True
        plan = render.plan(p)
        self.assertEqual([s["kind"] for s in plan["video"]], ["black"])
        self.assertEqual(plan["sound"], [])
        self.assertEqual(plan["voice"], [])
        self.assertEqual(plan["burned"], [])
        self.assertEqual(len(plan["subtitles"]), 1)  # the .srt still has it

    def test_canvas(self):
        p = project_v3(video={**VIDEO, "width": 1920, "height": 1080})
        p["settings"]["export"] = {"resolution": "720p", "aspect": "9:16", "fit": "fit", "quality": "high"}
        self.assertEqual(render.canvas(p), (720, 1280))
        p["settings"]["export"] = {"resolution": "original", "aspect": "1:1", "fit": "fit", "quality": "high"}
        self.assertEqual(render.canvas(p), (1080, 1080))
        p["settings"]["export"] = {"resolution": "720p", "aspect": "original", "fit": "fit", "quality": "high"}
        self.assertEqual(render.canvas(p), (1280, 720))


class Levels(unittest.TestCase):
    """The background is exactly as loud as the old export made it (only the ramps at the very
    start and end, and the switches at "original audio" gaps, are now 10 ms ramps instead of jumps)."""

    def check(self, mode, volume, parts, gaps):
        state = {"sentences": [], "settings": {"background": mode, "background_volume": volume, "background_cuts": parts}, "original_gaps": gaps, "next_id": 1}
        plan = render.plan(project_v3(state))
        edges = [0, 100] + [g[k] for g in gaps for k in ("start", "end")]
        for i in range(1, 20000):
            t = i * 0.005
            if any(abs(t - e) < render.MIN_FADE + 0.001 for e in edges):
                continue
            want = old_level(volume if mode == "duck" else 0.0, gaps, 1.0, parts, t)
            self.assertAlmostEqual(new_level(plan, "original", t), want, places=3, msg=f"t={t}")

    def test_duck_with_parts(self):
        self.check("duck", 0.15, [{"start": 10, "end": 20, "gain": 0.0, "fade": 0.05}, {"start": 30, "end": 31, "gain": 1.5, "fade": 2.0},
                                  {"start": 50, "end": 60, "gain": 0.5, "fade": 1.0}], [])

    def test_duck_with_gaps_inside_parts(self):
        self.check("duck", 0.3, [{"start": 10, "end": 20, "gain": 0.0, "fade": 1.0}], [{"start": 15, "end": 25}, {"start": 70, "end": 72}])

    def test_replace_plays_only_the_gaps(self):
        self.check("replace", 0.0, [{"start": 40, "end": 50, "gain": 0.5, "fade": 0.05}], [{"start": 45, "end": 55}])

    def test_separate_splits_stem_and_original(self):
        state = {"sentences": [], "settings": {"background": "separate", "background_volume": 0.8}, "original_gaps": [{"start": 10, "end": 20}], "next_id": 1}
        plan = render.plan(project_v3(state))
        self.assertAlmostEqual(new_level(plan, "stem", 5), 0.8)
        self.assertAlmostEqual(new_level(plan, "stem", 15), 0.0)
        self.assertAlmostEqual(new_level(plan, "original", 15), 1.0)
        self.assertAlmostEqual(new_level(plan, "original", 5), 0.0)

    def test_envelope_is_gain_at(self):
        state = {"sentences": [], "settings": {"background": "duck", "background_volume": 0.4,
                 "background_cuts": [{"start": 10, "end": 12, "gain": 0.0, "fade": 3.0}, {"start": 40, "end": 60, "gain": 1.5, "fade": 1.0}]},
                 "original_gaps": [{"start": 50, "end": 55}], "next_id": 1}
        run = render.plan(project_v3(state))["sound"][0]
        env = render.envelope(run)
        self.assertEqual(len(env), 100 * render.ENVELOPE_RATE + 2)
        for i in range(0, len(env), 37):
            self.assertAlmostEqual(float(env[i]), render.gain_at(run, i / render.ENVELOPE_RATE), places=6)


if __name__ == "__main__":
    unittest.main()
