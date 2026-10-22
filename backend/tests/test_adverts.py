"""Ad scripts (services/adscript.py) and the ad wizard's drafts (adverts.py, api_adverts.py).
The AI is replaced by a fake that returns prepared answers.

Run from the backend folder:  .venv/bin/python -m unittest discover -s tests -t .
"""
import copy
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

import api_adverts
import api_library
import config
import library
from errors import AppError
from services import adscript
from tests.test_library import make_media

BRIEF = {"product": "កាហ្វេទឹកដោះគោទឹកកក", "description": "កាហ្វេខ្មែរ ក្រអូប ឆ្ងាញ់", "price": "$2.50",
         "promo": "ទិញ ២ ថែម ១", "cta": "កុម្ម៉ង់ឥឡូវនេះ", "contact": {"phone": "012 345 678", "telegram": "@kafepp"}}


def scene(role, voice, caption="", media=0):
    return {"role": role, "voice": voice, "caption": caption, "media": media}


def good_script(tone):
    return {"tone": tone, "title": "កាហ្វេត្រជាក់", "post": "កាហ្វេទឹកកកឆ្ងាញ់!\n☎ 012 345 678\n#កាហ្វេ #ភ្នំពេញ", "scenes": [
        scene("hook", "ក្តៅខ្លាំងមែនទេបង?", "ក្តៅមែនទេ?", 0),
        scene("benefit", "កាហ្វេទឹកដោះគោទឹកកក ត្រជាក់ស្រួល ក្រអូបឆ្ងាញ់។", "", 1),
        scene("price", "តម្លៃត្រឹមតែ $2.50 ប៉ុណ្ណោះ!", "$2.50", 0),  # digits left in the voice: spelled out
        scene("promo", "ទិញពីរ ថែមមួយ ថ្ងៃនេះតែប៉ុណ្ណោះ!", "ទិញ ២ ថែម ១", 7),  # no picture 7: none
        scene("cta", "កុម្ម៉ង់ឥឡូវនេះ តាមតេឡេក្រាម!", "☎ 012 345 678", -1),
    ]}


def too_long(tone):
    s = good_script(tone)
    s["scenes"][1]["voice"] = "ក" * 300  # past the 30-second budget
    s["scenes"] = s["scenes"][:-1]  # and no call to action
    return s


class Fake:
    """Stands in for translate._call: answers in order, and remembers what it was asked."""

    def __init__(self, *answers):
        self.answers = list(answers)
        self.asked = []

    def __call__(self, system, user, schema):
        self.asked.append(user)
        if not self.answers:
            raise AppError("No more answers.")
        return copy.deepcopy(self.answers.pop(0))


class Scripts(unittest.TestCase):
    def test_numbers_as_words(self):
        cases = {
            "តម្លៃ $2.50": "តម្លៃ ពីរដុល្លារកន្លះ", "$3": "បីដុល្លារ", "$2.25": "ពីរដុល្លារ ម្ភៃប្រាំសេន",
            "បញ្ចុះ 20%": "បញ្ចុះ ម្ភៃភាគរយ", "15000៛": "មួយម៉ឺនប្រាំពាន់រៀល", "12,500 រៀល": "មួយម៉ឺនពីរពាន់ប្រាំរយរៀល",
            "012 345 678": "សូន្យមួយពីរ បីបួនប្រាំ ប្រាំមួយប្រាំពីរប្រាំបី", "ឆ្នាំ 2024": "ឆ្នាំ ពីរពាន់ម្ភៃបួន",
            "ទិញ ១ ថែម ១": "ទិញ មួយ ថែម មួយ", "1250000": "មួយលានពីរសែនប្រាំម៉ឺន", "2.5 ម៉ែត្រ": "ពីរចុចប្រាំ ម៉ែត្រ",
            "11": "ដប់មួយ", "100": "មួយរយ", "105": "មួយរយប្រាំ", "គ្មានលេខ": "គ្មានលេខ",
        }
        for text, want in cases.items():
            with self.subTest(text=text):
                self.assertEqual(adscript.spell_numbers(text), want)

    def test_sample_is_too_long_for_15_seconds(self):
        b = adscript.budget(15)
        problems = adscript.check(adscript.clean(good_script("friendly"), b, 2), b, BRIEF)
        self.assertEqual(len(problems), 1)
        self.assertIn("too long for 15 seconds", problems[0])

    def test_phone_number_in_its_groups(self):
        run_on = "ទាក់ទងមកសូន្យមួយពីរបីបួនប្រាំប្រាំមួយប្រាំពីរប្រាំបី។"
        self.assertEqual(adscript.space_phone(run_on, "012 345 678"), "ទាក់ទងមក សូន្យមួយពីរ បីបួនប្រាំ ប្រាំមួយប្រាំពីរប្រាំបី។")
        spaced = "ហៅ សូន្យ មួយ ពីរ បី បួន ប្រាំ ប្រាំមួយ ប្រាំពីរ ប្រាំបី ឥឡូវនេះ"
        self.assertEqual(adscript.space_phone(spaced, "012-345-678"), "ហៅ សូន្យមួយពីរ បីបួនប្រាំ ប្រាំមួយប្រាំពីរប្រាំបី ឥឡូវនេះ")
        self.assertEqual(adscript.space_phone("គ្មានលេខ", "012 345 678"), "គ្មានលេខ")
        self.assertEqual(adscript.space_phone(run_on, ""), run_on)

    def test_budget(self):
        self.assertEqual(adscript.budget(15)["chars"], 140)
        self.assertEqual(adscript.budget(30)["scenes"], (5, 8))
        self.assertEqual(adscript.budget(60)["hook_chars"], 33)
        with self.assertRaises(AppError):
            adscript.budget(45)

    def test_three_good_scripts(self):
        fake = Fake({"scripts": [good_script(t) for t in ("friendly", "energetic", "professional")]})
        with mock.patch("services.translate._call", fake):
            scripts = adscript.write(BRIEF, "food", 30, [{"name": "cup", "media": "image"}, {"name": "pour", "media": "video"}])
        self.assertEqual(len(fake.asked), 1)  # nothing needed asking again
        prompt = fake.asked[0]
        for part in ("កាហ្វេទឹកដោះគោទឹកកក", "$2.50", "012 345 678", "30 seconds", "at most 280", "Restaurant / food", "video clip “pour”"):
            self.assertIn(part, prompt)
        self.assertEqual([s["tone"] for s in scripts], ["friendly", "energetic", "professional"])
        s = scripts[0]
        self.assertEqual(s["warnings"], [])
        self.assertEqual(s["scenes"][2]["voice"], "តម្លៃត្រឹមតែ ពីរដុល្លារកន្លះ ប៉ុណ្ណោះ!")
        self.assertEqual(s["scenes"][2]["caption"], "$2.50")  # captions keep their digits
        self.assertEqual([sc["media"] for sc in s["scenes"]], [0, 1, 0, -1, -1])
        self.assertEqual(s["scenes"][-1]["role"], "cta")
        self.assertGreaterEqual(min(sc["seconds"] for sc in s["scenes"]), adscript.MIN_SCENE)
        self.assertLessEqual(s["seconds"], 30)

    def test_a_bad_script_is_asked_for_again(self):
        first = {"scripts": [good_script("friendly"), too_long("energetic")]}  # and no professional one
        fake = Fake(first, {"scripts": [good_script("energetic")]}, {"scripts": [good_script("professional")]})
        with mock.patch("services.translate._call", fake):
            scripts = adscript.write(BRIEF, "sale", 30, [{"name": "cup", "media": "image"}])
        self.assertEqual(len(fake.asked), 3)
        self.assertIn("characters, too long for 30 seconds", fake.asked[1])
        self.assertIn("the last scene must be the call to action", fake.asked[1])
        self.assertIn('"energetic" tone', fake.asked[1])
        self.assertIn('"professional" tone', fake.asked[2])
        self.assertEqual([s["tone"] for s in scripts], ["friendly", "energetic", "professional"])
        self.assertTrue(all(not s["warnings"] for s in scripts))

    def test_still_bad_after_asking_again_keeps_the_warnings(self):
        fake = Fake({"scripts": [too_long("friendly"), good_script("energetic"), good_script("professional")]},
                    AppError("Gemini is overloaded."))
        fake.answers[1:] = []  # asking again fails
        with mock.patch("services.translate._call", fake):
            scripts = adscript.write(BRIEF, "sale", 30, [])
        self.assertEqual(len(scripts), 3)
        self.assertTrue(any("too long" in w for w in scripts[0]["warnings"]))

    def test_foreign_words_and_missing_phone(self):
        s = good_script("friendly")
        s["scenes"][1]["voice"] = "កាហ្វេ 冰咖啡 ឆ្ងាញ់"
        s["scenes"][-1]["caption"] = "កុម្ម៉ង់ឥឡូវនេះ"
        clean = adscript.clean(s, adscript.budget(30), 2)
        problems = adscript.check(clean, adscript.budget(30), BRIEF)
        self.assertTrue(any("can't read (冰咖啡)" in p for p in problems))
        self.assertTrue(any("phone number" in p for p in problems))

    def test_needs_a_product(self):
        with self.assertRaises(AppError):
            adscript.write({"product": " "}, "food", 15, [])
        with self.assertRaises(AppError):
            adscript.write(BRIEF, "cinema", 15, [])


class Drafts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.media_dir = Path(tempfile.mkdtemp(prefix="kva-media-"))
        cls.media = make_media(cls.media_dir)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.media_dir, ignore_errors=True)

    def setUp(self):
        self.data = Path(tempfile.mkdtemp(prefix="kva-data-"))
        self._old = config.DATA_DIR
        config.DATA_DIR = self.data
        app = FastAPI()

        @app.exception_handler(AppError)
        async def app_error(_req, err: AppError):
            return JSONResponse({"error": err.to_dict()}, status_code=err.status)

        app.include_router(api_library.router)
        app.include_router(api_adverts.router)
        self.client = TestClient(app)

    def tearDown(self):
        config.DATA_DIR = self._old
        shutil.rmtree(self.data, ignore_errors=True)

    def asset(self, name, kind):
        with self.media[name].open("rb") as f:
            return self.client.post("/api/library/assets", files={"file": (name, f)}, data={"kind": kind}).json()["asset"]["id"]

    def patch(self, did, **fields):
        return self.client.patch(f"/api/adverts/{did}", json=fields)

    def test_new_draft_starts_from_the_brand_kit(self):
        logo = self.asset("logo.png", "logo")
        self.client.post("/api/library/brands", json={"name": "Kafe", "logo": logo, "cta": "ហៅឥឡូវនេះ", "contact": {"phone": "012 345 678"}})
        d = self.client.post("/api/adverts").json()["draft"]
        self.assertEqual(d["logo"], logo)
        self.assertEqual(d["brief"]["cta"], "ហៅឥឡូវនេះ")
        self.assertEqual(d["brief"]["contact"]["phone"], "012 345 678")
        self.assertEqual((d["format"], d["length"], d["step"]), ("9:16", 30, "product"))
        listing = self.client.get("/api/adverts").json()
        self.assertEqual([x["id"] for x in listing["drafts"]], [d["id"]])
        self.assertEqual([f["key"] for f in listing["options"]["formats"]], ["9:16", "1:1", "16:9"])
        self.assertEqual(len(listing["options"]["styles"]), 6)

    def test_without_a_brand_kit(self):
        d = self.client.post("/api/adverts").json()["draft"]
        self.assertIsNone(d["brand"])
        self.assertEqual(d["brief"]["contact"]["phone"], "")

    def test_filling_in_the_steps(self):
        photo, clip, song = self.asset("photo.jpg", "product"), self.asset("clip.mp4", "ad_clip"), self.asset("song.wav", "music")
        did = self.client.post("/api/adverts").json()["draft"]["id"]
        res = self.patch(did, brief={"product": "  កាហ្វេ  ", "price": "$2.50", "contact": {"phone": "012 345 678"}}, media=[photo, clip, photo],
                         style="food", format="1:1", length=15, voice="male", music={"mood": "fun", "asset": song}, step="script")
        self.assertEqual(res.status_code, 200, res.text)
        d = res.json()["draft"]
        self.assertEqual(d["brief"]["product"], "កាហ្វេ")
        self.assertEqual(d["brief"]["price"], "$2.50")
        self.assertEqual(d["media"], [photo, clip])  # each once
        self.assertEqual((d["style"], d["format"], d["length"], d["voice"]), ("food", "1:1", 15, "male"))
        self.assertEqual(d["music"], {"mood": "fun", "asset": song})
        d = self.patch(did, brief={"description": "ឆ្ងាញ់"}, music={"mood": "calm"}).json()["draft"]
        self.assertEqual(d["brief"]["product"], "កាហ្វេ")  # the rest of the brief is kept
        self.assertEqual(d["music"], {"mood": "calm", "asset": song})
        bad = [{"style": "cinema"}, {"format": "4:5"}, {"length": 45}, {"voice": "robot"}, {"music": {"mood": "sad"}},
               {"media": [song]}, {"media": ["as_missing"]}, {"logo": song}, {"brief": {"contact": {"email": "x"}}}, {"chosen": 0}]
        for fields in bad:
            with self.subTest(fields=fields):
                self.assertIn(self.patch(did, **fields).status_code, (400, 404, 422))

    def test_scripts_written_edited_chosen_and_exported(self):
        photo, clip = self.asset("photo.jpg", "product"), self.asset("clip.mp4", "ad_clip")
        did = self.client.post("/api/adverts").json()["draft"]["id"]
        self.patch(did, brief=BRIEF, media=[photo, clip], style="food", length=30)
        fake = Fake({"scripts": [good_script(t) for t in ("friendly", "energetic", "professional")]})
        with mock.patch("services.translate._call", fake):
            res = self.client.post(f"/api/adverts/{did}/scripts")
        self.assertEqual(res.status_code, 200, res.text)
        d = res.json()["draft"]
        self.assertEqual(d["step"], "script")
        self.assertEqual(len(d["scripts"]), 3)
        self.assertEqual([sc["media"] for sc in d["scripts"][0]["scenes"]], [photo, clip, photo, None, None])  # numbers → ids

        edited = copy.deepcopy(d["scripts"])
        edited[1]["scenes"][0]["voice"] = "  ថ្ងៃនេះ   ក្តៅណាស់!  "
        edited[1]["scenes"].append({"role": "cta", "voice": "", "caption": ""})  # an empty scene is dropped
        edited[1]["scenes"][1]["media"] = "as_not_in_this_ad"
        d = self.patch(did, scripts=edited, chosen=1).json()["draft"]
        s = d["scripts"][1]
        self.assertEqual(s["scenes"][0]["voice"], "ថ្ងៃនេះ ក្តៅណាស់!")
        self.assertEqual(len(s["scenes"]), 5)
        self.assertIsNone(s["scenes"][1]["media"])
        self.assertEqual([sc["id"] for sc in s["scenes"]], [sc["id"] for sc in edited[1]["scenes"][:5]])  # ids kept
        self.assertEqual(d["chosen"], 1)
        self.assertEqual(d["scripts_length"], 30)

        edited[1]["scenes"][1]["voice"] = "ក" * 300
        d = self.patch(did, scripts=edited).json()["draft"]
        self.assertTrue(d["scripts"][1]["warnings"])

        res = self.client.get(f"/api/adverts/{did}/script.txt")
        self.assertEqual(res.status_code, 200)
        text = res.text
        for part in ("VOICEOVER", "1. ថ្ងៃនេះ ក្តៅណាស់!", "CAPTIONS", "$2.50", "POST", "#កាហ្វេ"):
            self.assertIn(part, text)
        self.assertIn("attachment", res.headers["content-disposition"])

    def test_a_picture_deleted_from_the_library(self):
        photo, clip = self.asset("photo.jpg", "product"), self.asset("clip.mp4", "ad_clip")
        did = self.client.post("/api/adverts").json()["draft"]["id"]
        self.patch(did, media=[photo, clip])
        self.client.delete(f"/api/library/assets/{photo}")
        res = self.patch(did, media=[clip, photo])  # the page still lists the deleted one
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json()["draft"]["media"], [clip])
        self.assertEqual(self.patch(did, media=[clip, "as_never_was"]).status_code, 404)

    def test_brand_can_be_applied_again(self):
        logo = self.asset("logo.png", "logo")
        bid = self.client.post("/api/library/brands", json={"name": "Kafe", "contact": {"phone": "011 111 111"}}).json()["brand"]["id"]
        did = self.client.post("/api/adverts").json()["draft"]["id"]
        self.patch(did, brief={"contact": {"phone": "099 999 999"}})
        self.client.patch(f"/api/library/brands/{bid}", json={"logo": logo})
        d = self.client.post(f"/api/adverts/{did}/brand").json()["draft"]
        self.assertEqual(d["brief"]["contact"]["phone"], "011 111 111")
        self.assertEqual(d["logo"], logo)

    def test_delete(self):
        did = self.client.post("/api/adverts").json()["draft"]["id"]
        self.assertEqual(self.client.delete(f"/api/adverts/{did}").status_code, 200)
        self.assertEqual(self.client.get(f"/api/adverts/{did}").status_code, 404)
        self.assertEqual(self.client.get("/api/adverts/../etc").status_code, 404)


if __name__ == "__main__":
    unittest.main()
