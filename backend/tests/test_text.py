"""Stage 3: text clips (add, move, style, animation) and subtitle timing, in the plan and the export."""
import subprocess
import tempfile
import unittest
from pathlib import Path

import numpy as np

import config
import render
import timeline
from errors import AppError
from services import media, merge
from tests.test_edits import make
from tests.test_timeline import project_v3, sentence


class Text(unittest.TestCase):
    def test_add_move_and_skip(self):
        p = make()
        c = timeline.add_text(p, 5, "ជំរាបសួរ")
        self.assertEqual((c["start"], c["end"], c["animation"]), (5, 8, {"in": "pop", "out": "fade"}))
        timeline.move(p, [c["id"]], -10)  # never before the start
        self.assertEqual((c["start"], c["end"]), (0, 3))
        timeline.set_props(p, c["id"], {"x": 30.0, "y": 80.0, "style": {**c["style"], "color": "#fde047"}})
        self.assertEqual((c["x"], c["style"]["color"]), (30, "#fde047"))
        with self.assertRaises(AppError):
            timeline.set_props(p, c["id"], {"volume": 1.0})

    def test_pieces_around_a_skipped_part(self):
        p = make()
        c = timeline.add_text(p, 10, "ក", seconds=20)
        timeline.skip_range(p, 15, 20)
        pieces = render.plan(p)["texts"]
        self.assertEqual([(x["start"], x["end"], x["enters"], x["leaves"]) for x in pieces], [(10, 15, True, False), (15, 25, False, True)])
        timeline.track(p, "text")["hidden"] = True
        self.assertEqual(render.plan(p)["texts"], [])
        c["skipped"] = True

    def test_ripple_cuts_text_too(self):
        p = make()
        timeline.add_text(p, 10, "ក", seconds=20)  # 10–30
        timeline.remove_range(p, 15, 20)
        self.assertEqual([(c["start"], c["end"]) for c in timeline.clips(p, "text")], [(10, 15), (15, 25)])

    def test_subtitle_timing_moves_with_its_sentence(self):
        p = make(sentence("s1", 10, 12), sentence("s2", 20, 22))
        timeline.set_subtitle_timing(p, "s1", 9.5, 13)
        spans = render.plan(p)["subtitles"]
        self.assertEqual([(s["id"], a, b) for s, _, a, b in spans], [("s1", 9.5, 13), ("s2", 20, 22)])
        timeline.remove_range(p, 0, 5)  # everything moves up 5 s, the subtitle with its sentence
        self.assertEqual([(s["id"], a, b) for s, _, a, b in render.plan(p)["subtitles"]], [("s1", 4.5, 8), ("s2", 15, 17)])
        timeline.set_subtitle_timing(p, "s1", None, None)
        self.assertIsNone(timeline.clips(p, "voice")[0]["subtitle_timing"])
        with self.assertRaises(AppError):
            timeline.set_subtitle_timing(p, "s1", 5, 5.1)


@unittest.skipUnless(config.FFMPEG, "needs FFmpeg")
class TextExport(unittest.TestCase):
    """A white box over a grey test video: it shows only during its time, and animates in."""

    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.TemporaryDirectory()
        d = Path(cls.dir.name)
        cls.video = d / "source.mp4"
        media.ffmpeg("-f", "lavfi", "-i", "color=c=gray:s=320x240:r=30:d=4", "-f", "lavfi", "-i", "sine=f=220:d=4",
                     "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", cls.video, what="test video")
        cls.png = d / "box.png"
        media.ffmpeg("-f", "lavfi", "-i", "color=c=white:s=80x40,format=rgba", "-frames:v", 1, cls.png, what="test box")
        cls.voice = media.write_wav(d / "voice.wav", np.zeros(4 * media.VOICE_RATE, dtype=np.int16))

    @classmethod
    def tearDownClass(cls):
        cls.dir.cleanup()

    def render(self, animation):
        info = {**media.probe(self.video), "file": "source.mp4"}
        p = project_v3({"sentences": [], "settings": {"background": "duck", "background_volume": 0.5}, "original_gaps": [], "next_id": 1}, video=info)
        c = timeline.add_text(p, 1, "box", seconds=2)
        c["animation"] = animation
        out = Path(self.dir.name) / f"out-{animation['in']}.mp4"
        plan = render.plan(p)
        merge.render_video(plan, {"source": self.video}, info, self.voice, p["settings"], out,
                           texts={c["id"]: (self.png, {"x": 120, "y": 100, "width": 80, "height": 40})})
        return out

    def brightness(self, video, t, box=(130, 110, 60, 20)):
        x, y, w, h = box
        raw = subprocess.run([config.FFMPEG, "-v", "error", "-ss", str(t), "-i", str(video), "-frames:v", "1", "-vf", f"crop={w}:{h}:{x}:{y}",
                              "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True).stdout
        return float(np.frombuffer(raw, np.uint8).mean())

    def test_shown_only_during_its_time(self):
        out = self.render({"in": "none", "out": "none"})
        self.assertLess(self.brightness(out, 0.5), 160)  # grey: no box yet
        self.assertGreater(self.brightness(out, 2.0), 240)  # white box
        self.assertLess(self.brightness(out, 3.5), 160)  # gone again

    def test_fade_and_pop(self):
        fade = self.render({"in": "fade", "out": "fade"})
        self.assertLess(self.brightness(fade, 1.1), self.brightness(fade, 2.0) - 20)  # still fading in
        pop = self.render({"in": "pop", "out": "none"})
        edge = (121, 101, 8, 8)  # the box's corner is outside it while it is still small
        self.assertLess(self.brightness(pop, 1.03, edge), 200)
        self.assertGreater(self.brightness(pop, 2.0, edge), 240)

    def test_slide_rises_into_place(self):
        out = self.render({"in": "slide", "out": "none"})
        top = (130, 100, 60, 4)
        self.assertLess(self.brightness(out, 1.05, top), self.brightness(out, 2.0, top) - 30)


if __name__ == "__main__":
    unittest.main()
