"""Stage 6: the exported picture's shape, size, fit and quality, and the progress while it renders."""
import subprocess
import tempfile
import unittest
from pathlib import Path

import numpy as np

import config
import render
from services import media, merge
from tests.test_timeline import project_v3


@unittest.skipUnless(config.FFMPEG, "needs FFmpeg")
class Shapes(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.TemporaryDirectory()
        d = Path(cls.dir.name)
        cls.video = d / "source.mp4"  # 4:3, a white picture
        media.ffmpeg("-f", "lavfi", "-i", "color=c=white:s=320x240:r=30:d=3", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo", "-t", 3,
                     "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", cls.video, what="test video")
        cls.voice = media.write_wav(d / "voice.wav", np.zeros(3 * media.VOICE_RATE, dtype=np.int16))
        cls.info = {**media.probe(cls.video), "file": "source.mp4"}

    @classmethod
    def tearDownClass(cls):
        cls.dir.cleanup()

    def export(self, **settings):
        p = project_v3({"sentences": [], "settings": {"background": "duck", "background_volume": 0.5}, "original_gaps": [], "next_id": 1}, video=self.info)
        p["settings"]["export"] = {"resolution": "original", "aspect": "original", "fit": "fit", "quality": "high", **settings}
        out = Path(self.dir.name) / f"out-{'-'.join(map(str, settings.values())).replace(':', 'x')}.mp4"
        seen = []
        merge.render_video(render.plan(p), {"source": self.video}, self.info, self.voice, p["settings"], out, on_progress=seen.append)
        return out, seen

    def size(self, path):
        out = subprocess.run([config.FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", str(path)],
                             capture_output=True, text=True).stdout.strip()
        return tuple(map(int, out.split(",")))

    def column(self, path, w, h):
        raw = subprocess.run([config.FFMPEG, "-v", "error", "-ss", "1.5", "-i", str(path), "-frames:v", "1", "-vf", f"crop=2:{h}:{w // 2}:0",
                              "-f", "rawvideo", "-pix_fmt", "gray", "-"], capture_output=True).stdout
        return np.frombuffer(raw, np.uint8).reshape(h, 2)[:, 0]  # a 2-pixel crop: 4:2:0 pictures can't be cut 1 wide

    def test_square_fit_has_bars_and_fill_has_none(self):
        out, seen = self.export(aspect="1:1", resolution="720p", fit="fit")
        self.assertEqual(self.size(out), (720, 720))
        col = self.column(out, 720, 720)
        self.assertLess(col[:60].mean(), 30)  # black bar at the top (the 4:3 picture is 540 high)
        self.assertGreater(col[300:420].mean(), 220)  # the white picture in the middle
        self.assertTrue(seen and seen[-1] > 0.9 and seen == sorted(seen))  # progress went up to the end
        out, _ = self.export(aspect="1:1", resolution="720p", fit="fill")
        self.assertGreater(self.column(out, 720, 720)[:60].mean(), 220)  # filled: no bars

    def test_sizes(self):
        self.assertEqual(self.size(self.export(aspect="9:16", resolution="1080p")[0]), (1080, 1920))
        self.assertEqual(self.size(self.export(aspect="original", resolution="720p")[0]), (960, 720))
        out, _ = self.export()
        self.assertEqual(self.size(out), (320, 240))

    def test_smaller_files_for_lower_quality(self):
        high, _ = self.export(aspect="16:9", resolution="720p", quality="high")
        small, _ = self.export(aspect="16:9", resolution="720p", quality="small")
        self.assertLessEqual(small.stat().st_size, high.stat().st_size)


if __name__ == "__main__":
    unittest.main()
