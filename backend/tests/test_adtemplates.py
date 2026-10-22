"""Ad templates (adtemplates.py) and how drafts use them.

Run from the backend folder:  .venv/bin/python -m unittest discover -s tests -t .
"""
import copy
import shutil
import tempfile
import unittest
from pathlib import Path

import adtemplates
import adverts
import config
from errors import AppError
from services import adscript


class Templates(unittest.TestCase):
    def setUp(self):
        self.data = Path(tempfile.mkdtemp(prefix="kva-data-"))
        self._old = config.DATA_DIR
        config.DATA_DIR = self.data

    def tearDown(self):
        config.DATA_DIR = self._old
        shutil.rmtree(self.data, ignore_errors=True)

    def test_a_builtin_template_for_every_style(self):
        ts = adtemplates.all_templates()
        self.assertEqual([t["style"] for t in ts], list(adscript.STYLES))
        for t in ts:
            with self.subTest(t=t["id"]):
                self.assertTrue(t["builtin"])
                self.assertEqual(adtemplates.for_style(t["style"])["id"], t["id"])
                self.assertIn("cta", t["captions"])

    def test_positions_stay_inside_the_safe_area(self):
        for aspect, safe in adtemplates.SAFE.items():
            for name in adtemplates.POSITIONS:
                with self.subTest(aspect=aspect, name=name):
                    p = adtemplates.place(name, aspect)
                    self.assertGreaterEqual(p["x"], safe["left"] - 1e-9)
                    self.assertLessEqual(p["x"], 1 - safe["right"] + 1e-9)
                    self.assertGreaterEqual(p["y"], safe["top"] - 1e-9)
                    self.assertLessEqual(p["y"], 1 - safe["bottom"] + 1e-9)
        self.assertEqual(adtemplates.place("lower_left", "16:9")["align"], "left")
        self.assertLess(adtemplates.place("lower", "9:16")["y"], 0.78)  # clear of TikTok's caption area
        with self.assertRaises(AppError):
            adtemplates.place("middle", "9:16")
        with self.assertRaises(AppError):
            adtemplates.place("center", "4:5")

    def test_check_names_what_is_wrong(self):
        good = adtemplates.get("sale_flash")
        cases = [
            (["shots", "fit"], "stretch", "picture fit"), (["shots", "transition", "type"], "spin", "transition"),
            (["captions", "price", "preset"], "comic", "caption style"), (["captions", "price", "position"], "middle", "position"),
            (["logo", "size"], 0.9, "logo size"), (["end_screen", "seconds"], 30, "end screen length"),
            (["music", "mood"], "sad", "music mood"), (["fonts", "title"], "Arial", "Khmer font"), (["style"], "cinema", "ad style"),
        ]
        for path, value, words in cases:
            with self.subTest(path=path):
                t = copy.deepcopy(good)
                target = t
                for key in path[:-1]:
                    target = target[key]
                target[path[-1]] = value
                with self.assertRaises(AppError) as err:
                    adtemplates.check(t)
                self.assertIn(words, err.exception.message)

    def test_saved_templates(self):
        mine = adtemplates.save({**adtemplates.get("food_tasty"), "name": "My noodle look"})
        self.assertTrue(mine["id"].startswith("my_"))
        self.assertFalse(mine["builtin"])
        ids = [t["id"] for t in adtemplates.all_templates()]
        self.assertEqual(ids[-1], mine["id"])
        self.assertEqual(adtemplates.get(mine["id"])["name"], "My noodle look")
        (adtemplates._user_dir() / "broken.json").write_text("{nope")
        self.assertEqual(len(adtemplates.all_templates()), 7)  # a damaged file is left out
        adtemplates.delete(mine["id"])
        self.assertEqual(len(adtemplates.all_templates()), 6)
        with self.assertRaises(AppError):
            adtemplates.delete("sale_flash")

    def test_drafts_follow_the_style_until_a_template_is_picked(self):
        d = adverts.create()
        self.assertEqual(d["template"], "product_clean")
        d = adverts.patch(d["id"], {"style": "food"})
        self.assertEqual(d["template"], "food_tasty")
        d = adverts.patch(d["id"], {"template": "estate_luxury"})
        d = adverts.patch(d["id"], {"style": "sale"})
        self.assertEqual(d["template"], "estate_luxury")  # picked on purpose: kept
        with self.assertRaises(AppError):
            adverts.patch(d["id"], {"template": "nope"})


if __name__ == "__main__":
    unittest.main()
