"""Stage 4: inserting media, duplicating, pasting, rearranging, speed — and rendering added media."""
import subprocess
import tempfile
import unittest
from pathlib import Path

import numpy as np

import config
import render
import sentences
import timeline
from errors import AppError
from services import media, merge
from tests.test_edits import make, spans
from tests.test_timeline import project_v3, sentence


def with_media(p):
    p["media"]["img"] = {"kind": "image", "file": "media/img.png", "name": "logo.png", "width": 100, "height": 100}
    p["media"]["vid"] = {"kind": "video", "file": "media/vid.mp4", "name": "intro.mp4", "duration": 5.0, "width": 640, "height": 360, "fps": 30, "audio": True}
    p["media"]["mus"] = {"kind": "audio", "file": "media/mus.mp3", "name": "music.mp3", "duration": 60.0, "audio": True}
    return p


class Insert(unittest.TestCase):
    def test_picture_pushes_everything_later(self):
        p = with_media(make(sentence("s1", 10, 12), sentence("s2", 25, 27)))
        c = timeline.insert_media(p, "img", 20)
        self.assertEqual((c["type"], c["start"], c["end"]), ("image", 20, 23))
        self.assertEqual([(v["type"], v["start"], v["end"]) for v in timeline.clips(p, "video")], [("video", 0, 20), ("image", 20, 23), ("video", 23, 103)])
        self.assertEqual(spans(p, "voice"), [(10, 12), (28, 30)])
        self.assertEqual(spans(p, "background"), [(0, 20), (23, 103)])  # a picture has no sound
        plan = render.plan(p)
        self.assertEqual([(s["kind"], s["start"], s["end"]) for s in plan["video"]], [("video", 0, 20), ("image", 20, 23), ("video", 23, 103)])

    def test_video_brings_its_sound(self):
        p = with_media(make())
        c = timeline.insert_media(p, "vid", 0)
        bg = timeline.clips(p, "background")
        self.assertEqual([(b["media"], b["start"], b["end"], b["link"]) for b in bg], [("vid", 0, 5, c["id"]), ("source", 5, 105, "v1")])
        runs = render.plan(p)["sound"]
        self.assertEqual([(r["media"], r["start"], r["end"]) for r in runs], [("vid", 0, 5), ("source", 5, 105)])  # an added video's sound plays as it is

    def test_music_goes_on_its_own_track(self):
        p = with_media(make(sentence("s1", 10, 12)))
        c = timeline.insert_media(p, "mus", 30)
        self.assertEqual((c["start"], c["end"], c["source_out"]), (30, 90, 60))
        self.assertEqual(spans(p, "voice"), [(10, 12)])  # nothing moved
        run = next(r for r in render.plan(p)["sound"] if r["media"] == "mus")
        self.assertEqual((run["start"], run["end"]), (30, 90))

    def test_removed_media(self):
        p = with_media(make())
        p["media"]["img"]["removed"] = True
        with self.assertRaises(AppError):
            timeline.insert_media(p, "img", 0)


class Copy(unittest.TestCase):
    def test_duplicate_a_video_clip_with_what_is_on_it(self):
        p = make(sentence("s1", 25, 27), sentence("s2", 60, 62))
        v = timeline.clips(p, "video")[0]
        middle = timeline.split_at(p, v, 20)
        timeline.split_at(p, middle, 40)
        timeline.add_text(p, 30, "ក", seconds=2)
        made = timeline.duplicate(p, [middle["id"]])
        self.assertEqual([(c["start"], c["end"], c["source_in"]) for c in timeline.clips(p, "video")], [(0, 20, 0), (20, 40, 20), (40, 60, 20), (60, 120, 40)])
        self.assertEqual(spans(p, "voice"), [(25, 27), (45, 47), (80, 82)])  # the copy has its sentence; s2 moved later
        self.assertEqual(spans(p, "text"), [(30, 32), (50, 52)])
        copy_ = next(s for s in sentences.items(p) if s["start"] == 45)
        self.assertIn(copy_["id"], made)
        self.assertNotEqual(copy_["id"], "s1")

    def test_duplicate_a_sentence_needs_room(self):
        p = make(sentence("s1", 10, 12), sentence("s2", 13, 14))
        with self.assertRaises(AppError):
            timeline.duplicate(p, ["s1"])
        timeline.duplicate(p, ["s2"])
        self.assertEqual(spans(p, "voice"), [(10, 12), (13, 14), (14, 15)])

    def test_paste_text_and_a_sentence(self):
        p = make(sentence("s1", 10, 12))
        c = timeline.add_text(p, 5, "ក", seconds=2)
        items = [{"track": "text", "clip": dict(c)}, {"track": "voice", "clip": dict(sentences.items(p)[0])}]
        out = timeline.paste(p, items, 50, ("start", "end", "khmer_text", "voice", "speed", "volume"))
        self.assertEqual(out["left_out"], 0)
        self.assertEqual(spans(p, "text"), [(5, 7), (50, 52)])
        self.assertEqual(spans(p, "voice"), [(10, 12), (55, 57)])
        out = timeline.paste(p, items, 50, ("start", "end", "khmer_text"))  # the sentence would overlap: left out
        self.assertEqual(out["left_out"], 1)


class Rearrange(unittest.TestCase):
    def setUp(self):
        self.p = make(sentence("s1", 5, 7), sentence("s2", 25, 27), sentence("s3", 50, 52))
        v = timeline.clips(self.p, "video")[0]
        self.b = timeline.split_at(self.p, v, 20)
        self.c = timeline.split_at(self.p, self.b, 40)

    def order(self):
        return [(c["start"], c["end"], c["source_in"]) for c in timeline.clips(self.p, "video")]

    def test_move_a_clip_to_the_front(self):
        timeline.move_video(self.p, self.b["id"], 0, insert=True)
        self.assertEqual(self.order(), [(0, 20, 20), (20, 40, 0), (40, 100, 40)])
        self.assertEqual([(s["id"], s["start"]) for s in sentences.items(self.p)], [("s2", 5), ("s1", 25), ("s3", 50)])
        self.assertEqual(spans(self.p, "background"), [(0, 20), (20, 40), (40, 100)])
        self.assertEqual(self.b["id"], timeline.clips(self.p, "video")[0]["id"])  # it keeps its id

    def test_move_a_clip_to_the_end(self):
        timeline.move_video(self.p, self.b["id"], 100, insert=True)
        self.assertEqual(self.order(), [(0, 20, 0), (20, 80, 40), (80, 100, 20)])
        self.assertEqual([(s["id"], s["start"]) for s in sentences.items(self.p)], [("s1", 5), ("s3", 30), ("s2", 85)])

    def test_move_into_empty_space(self):
        timeline.move_video(self.p, self.c["id"], 120, insert=False)
        self.assertEqual(self.order(), [(0, 20, 0), (20, 40, 20), (120, 180, 40)])
        self.assertEqual([(s["id"], s["start"]) for s in sentences.items(self.p)], [("s1", 5), ("s2", 25), ("s3", 130)])
        with self.assertRaises(AppError):
            timeline.move_video(self.p, self.c["id"], 10, insert=False)  # on top of another clip

    def test_speed_cuts_music_running_past_the_clip(self):
        p = with_media(self.p)
        timeline.insert_media(p, "mus", 10)  # music 10–70, across the clip's end at 40
        timeline.set_speed(p, self.b["id"], 2.0)  # 20–40 becomes 20–30
        music = [(c["start"], c["end"], c["source_in"], c["source_out"]) for c in timeline.clips(p, "audio")]
        self.assertEqual(music, [(10, 30, 0, 20), (30, 60, 30, 60)])  # 20–30 of the music went with the lost time
        runs = [r for r in render.plan(p)["sound"] if r["media"] == "mus"]
        self.assertTrue(all(a["end"] <= b["start"] + 1e-6 for a, b in zip(runs, runs[1:])))  # never twice at once
        timeline.set_speed(p, self.b["id"], 0.5)  # 20–30 becomes 20–60: time put in at its end
        self.assertEqual(self.order(), [(0, 20, 0), (20, 60, 20), (60, 120, 40)])
        self.assertEqual([(c["start"], c["end"]) for c in timeline.clips(p, "audio")], [(10, 30), (60, 90)])

    def test_speed(self):
        timeline.set_speed(self.p, self.b["id"], 2.0)
        self.assertEqual(self.order(), [(0, 20, 0), (20, 30, 20), (30, 90, 40)])
        self.assertEqual([(s["id"], s["start"]) for s in sentences.items(self.p)], [("s1", 5), ("s2", 22.5), ("s3", 40)])
        bg = timeline.clips(self.p, "background")[1]
        self.assertEqual((bg["start"], bg["end"], bg["source_in"], bg["source_out"]), (20, 30, 20, 40))
        self.assertEqual(render.plan(self.p)["sound"][1]["speed"], 2.0)


@unittest.skipUnless(config.FFMPEG, "needs FFmpeg")
class RenderAdded(unittest.TestCase):
    """A picture inserted into a grey test video, and music on its own track, end up in the file."""

    def test_picture_and_music(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            video, png, music = d / "source.mp4", d / "red.png", d / "music.wav"
            media.ffmpeg("-f", "lavfi", "-i", "color=c=gray:s=320x240:r=30:d=4", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
                         "-t", 4, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", video, what="test video")
            media.ffmpeg("-f", "lavfi", "-i", "color=c=red:s=200x100", "-frames:v", 1, png, what="test picture")
            media.ffmpeg("-f", "lavfi", "-i", "sine=f=440:d=10", "-ar", 48000, music, what="test music")
            info = {**media.probe(video), "file": "source.mp4"}
            p = project_v3({"sentences": [], "settings": {"background": "duck", "background_volume": 0.5}, "original_gaps": [], "next_id": 1}, video=info)
            p["media"]["img"] = {"kind": "image", "file": "red.png", "width": 200, "height": 100}
            p["media"]["mus"] = {"kind": "audio", "file": "music.wav", "duration": 10.0, "audio": True}
            timeline.insert_media(p, "img", 2, seconds=1)
            timeline.insert_media(p, "mus", 0)
            m = timeline.clips(p, "audio")[0]
            m.update(end=5.0, source_out=5.0, volume=50)
            plan = render.plan(p)
            self.assertEqual(plan["length"], 5.0)
            voice = media.write_wav(d / "voice.wav", np.zeros(5 * media.VOICE_RATE, dtype=np.int16))
            out = d / "out.mp4"
            merge.render_video(plan, {"source": video, "img": png, "mus": music}, info, voice, p["settings"], out)

            def rgb(t):
                raw = subprocess.run([config.FFMPEG, "-v", "error", "-ss", str(t), "-i", str(out), "-frames:v", "1", "-vf", "crop=20:20:150:110",
                                      "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True).stdout
                return np.frombuffer(raw, np.uint8).reshape(-1, 3).mean(axis=0)

            self.assertGreater(rgb(2.5)[0] - rgb(2.5)[1], 150)  # red picture in the middle of the black-barred canvas
            self.assertLess(abs(rgb(1.0)[0] - rgb(1.0)[1]), 10)  # grey video before it
            self.assertLess(abs(rgb(4.0)[0] - rgb(4.0)[1]), 10)  # and after it (moved up 1 s later)
            raw = subprocess.run([config.FFMPEG, "-v", "error", "-i", str(out), "-vn", "-ar", "8000", "-f", "f32le", "-"], capture_output=True).stdout
            sound = np.frombuffer(raw, np.float32).reshape(-1, 2)  # the video's sound is stereo: the mono music goes to both sides
            self.assertAlmostEqual(len(sound) / 8000, 5.0, delta=0.05)
            rms = np.sqrt((sound[8000:16000] ** 2).mean(axis=0))
            for side in rms:  # the music (FFmpeg's test tone is 1/8 loud), at half volume
                self.assertAlmostEqual(side / (0.125 * 0.5 / np.sqrt(2)), 1.0, delta=0.01)


if __name__ == "__main__":
    unittest.main()
