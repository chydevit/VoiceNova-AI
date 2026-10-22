"""Built-in background music (services/music.py).

Run from the backend folder:  .venv/bin/python -m unittest discover -s tests -t .
"""
import shutil
import tempfile
import unittest
from pathlib import Path

import numpy as np

import config
from errors import AppError
from services import media, music


class Music(unittest.TestCase):
    def test_every_piece_sounds_and_stays_the_same(self):
        for pid, piece in music.PIECES.items():
            with self.subTest(pid=pid):
                a = music.render(piece, seconds=6)
                self.assertEqual(a.shape[1], 2)
                self.assertGreater(len(a), 6 * music.RATE)
                self.assertTrue(np.all(np.isfinite(a)))
                self.assertLess(np.max(np.abs(a)), 0.9)  # never clips
                self.assertGreater(np.sqrt(np.mean(a ** 2)), 0.02)  # not silent
                self.assertLess(abs(float(np.mean(a))), 0.01)  # no DC offset
                self.assertTrue(np.array_equal(a, music.render(piece, seconds=6)))  # same id, same music
        self.assertFalse(np.array_equal(music.render(music.PIECES["fun_1"], 4)[:1000], music.render(music.PIECES["fun_2"], 4)[:1000]))

    def test_moods(self):
        self.assertEqual(music.for_mood("calm"), "calm_1")
        self.assertEqual(music.for_mood("calm", 1), "calm_2")
        self.assertEqual({m["mood"] for m in music.catalog()}, set(music.MOODS))
        with self.assertRaises(AppError):
            music.for_mood("sad")
        with self.assertRaises(AppError):
            music.track("sad_1")

    def test_file_is_made_once(self):
        data = Path(tempfile.mkdtemp(prefix="kva-music-"))
        old, config.DATA_DIR = config.DATA_DIR, data
        try:
            path = music.track("calm_2")
            info = media.run([config.FFPROBE, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", str(path)], "probe")
            self.assertGreater(float(info), 60)  # longer than the longest ad
            made = path.stat().st_mtime_ns
            self.assertEqual(music.track("calm_2").stat().st_mtime_ns, made)
            self.assertEqual([p.name for p in path.parent.iterdir()], ["calm_2.m4a"])  # nothing left behind
        finally:
            config.DATA_DIR = old
            shutil.rmtree(data, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
