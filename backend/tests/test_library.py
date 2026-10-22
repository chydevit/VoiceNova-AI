"""Ad Library and Brand Kits (library.py, api_library.py).

Run from the backend folder:  .venv/bin/python -m unittest discover -s tests -t .
"""
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

import api_library
import config
import library
from errors import AppError


def ffmpeg(*args: str) -> None:
    subprocess.run([config.FFMPEG, "-hide_banner", "-loglevel", "error", "-y", *args], check=True)


def make_media(folder: Path) -> dict[str, Path]:
    """Small files of every kind the library takes."""
    files = {
        "logo.png": ["-f", "lavfi", "-i", "color=c=red@0.5:s=200x100,format=rgba", "-frames:v", "1"],
        "photo.jpg": ["-f", "lavfi", "-i", "testsrc=s=640x480", "-frames:v", "1"],
        "clip.mp4": ["-f", "lavfi", "-i", "testsrc=s=320x568:d=2:r=25", "-f", "lavfi", "-i", "sine=f=440:d=2",
                     "-shortest", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-c:a", "aac"],
        "silent.mp4": ["-f", "lavfi", "-i", "testsrc=s=320x240:d=1.5:r=25", "-pix_fmt", "yuv420p", "-c:v", "libx264"],
        "song.wav": ["-f", "lavfi", "-i", "sine=f=220:d=3"],
    }
    out = {}
    for name, args in files.items():
        out[name] = folder / name
        ffmpeg(*args, str(out[name]))
    (folder / "notes.txt").write_text("not media")
    out["notes.txt"] = folder / "notes.txt"
    return out


class LibraryTest(unittest.TestCase):
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
        self.client = TestClient(app)

    def tearDown(self):
        config.DATA_DIR = self._old
        shutil.rmtree(self.data, ignore_errors=True)

    def upload(self, name: str, kind: str, label: str = ""):
        with self.media[name].open("rb") as f:
            return self.client.post("/api/library/assets", files={"file": (name, f)}, data={"kind": kind, "name": label})

    # ---------- assets ----------

    def test_empty_library(self):
        body = self.client.get("/api/library").json()
        self.assertEqual(body["assets"], [])
        self.assertEqual(body["brands"], [])
        self.assertIn("Moul", body["fonts"])
        self.assertEqual(body["kinds"]["music"], ["audio"])

    def test_upload_every_kind(self):
        cases = [("logo.png", "logo", "image"), ("photo.jpg", "product", "image"), ("clip.mp4", "ad_clip", "video"),
                 ("silent.mp4", "product", "video"), ("song.wav", "music", "audio")]
        for name, kind, what in cases:
            with self.subTest(name=name):
                res = self.upload(name, kind)
                self.assertEqual(res.status_code, 200, res.text)
                a = res.json()["asset"]
                self.assertEqual((a["kind"], a["media"]), (kind, what))
                self.assertTrue((library.root() / a["file"]).exists())
                self.assertEqual(self.client.get(a["url"]).status_code, 200)
                if what == "audio":
                    self.assertIsNone(a["thumb_url"])
                else:
                    self.assertEqual(self.client.get(a["thumb_url"]).status_code, 200)
        assets = {a["original_name"]: a for a in self.client.get("/api/library").json()["assets"]}
        self.assertEqual(len(assets), 5)
        self.assertTrue(assets["logo.png"]["alpha"])
        self.assertFalse(assets["photo.jpg"]["alpha"])
        self.assertEqual((assets["photo.jpg"]["width"], assets["photo.jpg"]["height"]), (640, 480))
        self.assertAlmostEqual(assets["clip.mp4"]["duration"], 2.0, delta=0.1)
        self.assertTrue(assets["clip.mp4"]["audio"])
        self.assertFalse(assets["silent.mp4"]["audio"])  # a silent clip is fine for an ad
        self.assertAlmostEqual(assets["song.wav"]["duration"], 3.0, delta=0.05)
        self.assertFalse(list((library.root() / "incoming").iterdir()))  # nothing left behind

    def test_wrong_kind_or_file_is_refused(self):
        res = self.upload("song.wav", "logo")
        self.assertEqual(res.status_code, 400)
        self.assertIn("A logo must be a picture", res.json()["error"]["message"])
        res = self.upload("notes.txt", "image")
        self.assertEqual(res.status_code, 400)
        self.assertIn("can't go in the Ad Library", res.json()["error"]["message"])
        self.assertEqual(self.upload("photo.jpg", "banner").status_code, 400)
        self.assertEqual(self.client.get("/api/library").json()["assets"], [])

    def test_damaged_file_is_refused(self):
        bad = self.data / "broken.png"
        bad.write_bytes(b"\x89PNG not really")
        with bad.open("rb") as f:
            res = self.client.post("/api/library/assets", files={"file": ("broken.png", f)}, data={"kind": "image"})
        self.assertEqual(res.status_code, 400)
        self.assertEqual(self.client.get("/api/library").json()["assets"], [])

    def test_rename_rekind_delete(self):
        a = self.upload("photo.jpg", "product", "Iced coffee").json()["asset"]
        self.assertEqual(a["name"], "Iced coffee")
        res = self.client.patch(f"/api/library/assets/{a['id']}", json={"name": "  Latte  ", "kind": "image", "tags": ["drink", "drink", " cafe "]})
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual((res.json()["asset"]["name"], res.json()["asset"]["kind"]), ("Latte", "image"))
        self.assertEqual(res.json()["asset"]["tags"], ["cafe", "drink"])
        self.assertEqual(self.client.patch(f"/api/library/assets/{a['id']}", json={"kind": "music"}).status_code, 400)
        res = self.client.delete(f"/api/library/assets/{a['id']}")
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.json()["library"]["assets"], [])
        self.assertFalse((library.root() / a["file"]).exists())
        self.assertEqual(self.client.get(a["url"]).status_code, 404)
        self.assertEqual(self.client.delete(f"/api/library/assets/{a['id']}").status_code, 404)

    # ---------- colours ----------

    def test_colors(self):
        res = self.client.put("/api/library/colors", json={"colors": [{"name": "Kafe red", "hex": "#d62828"}]})
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json()["colors"], [{"name": "Kafe red", "hex": "#D62828"}])
        self.assertEqual(self.client.put("/api/library/colors", json={"colors": [{"hex": "red"}]}).status_code, 400)
        self.assertEqual(len(self.client.get("/api/library").json()["colors"]), 1)  # unchanged

    # ---------- brand kits ----------

    def test_brand_kits(self):
        logo = self.upload("logo.png", "logo").json()["asset"]
        res = self.client.post("/api/library/brands", json={
            "name": "Kafe", "logo": logo["id"], "colors": {"primary": "#112233"}, "fonts": {"title": "Koulen"},
            "contact": {"phone": "012 345 678", "telegram": "@kafe"},
        })
        self.assertEqual(res.status_code, 200, res.text)
        kafe = res.json()["brand"]
        self.assertTrue(kafe["default"])  # the first kit is the default
        self.assertEqual(kafe["colors"]["primary"], "#112233")
        self.assertEqual(kafe["colors"]["text"], "#FFFFFF")  # the rest from the defaults
        self.assertEqual((kafe["fonts"]["title"], kafe["fonts"]["body"]), ("Koulen", "Kantumruy Pro"))
        self.assertEqual(kafe["contact"]["phone"], "012 345 678")
        self.assertEqual(kafe["sponsored_label"], "ផ្សាយពាណិជ្ជកម្ម")

        salon = self.client.post("/api/library/brands", json={"name": "Salon"}).json()["brand"]
        self.assertFalse(salon["default"])
        self.assertEqual(self.client.get("/api/library/brands/default").json()["brand"]["id"], kafe["id"])
        self.client.post(f"/api/library/brands/{salon['id']}/default")
        self.assertEqual(self.client.get("/api/library/brands/default").json()["brand"]["id"], salon["id"])

        res = self.client.patch(f"/api/library/brands/{kafe['id']}", json={"cta": "ហៅឥឡូវនេះ", "contact": {"address": "ភ្នំពេញ"}})
        self.assertEqual(res.status_code, 200, res.text)
        self.assertEqual(res.json()["brand"]["cta"], "ហៅឥឡូវនេះ")
        self.assertEqual(res.json()["brand"]["contact"]["phone"], "012 345 678")  # kept

        for bad in ({"fonts": {"title": "Comic Sans"}}, {"colors": {"primary": "blue"}}, {"colors": {"glow": "#000000"}},
                    {"contact": {"email": "x"}}, {"logo": "as_missing"}):
            with self.subTest(bad=bad):
                self.assertIn(self.client.patch(f"/api/library/brands/{kafe['id']}", json=bad).status_code, (400, 404))

        song = self.upload("song.wav", "music").json()["asset"]
        self.assertEqual(self.client.patch(f"/api/library/brands/{kafe['id']}", json={"logo": song["id"]}).status_code, 400)

        # deleting the logo leaves the brand without one
        res = self.client.delete(f"/api/library/assets/{logo['id']}")
        self.assertEqual(res.json()["cleared_brands"], ["Kafe"])
        brands = {b["id"]: b for b in res.json()["library"]["brands"]}
        self.assertIsNone(brands[kafe["id"]]["logo"])

        # deleting the default kit makes another one the default
        self.client.delete(f"/api/library/brands/{salon['id']}")
        self.assertEqual(self.client.get("/api/library/brands/default").json()["brand"]["id"], kafe["id"])
        self.client.delete(f"/api/library/brands/{kafe['id']}")
        self.assertIsNone(self.client.get("/api/library/brands/default").json()["brand"])

    def test_survives_reload(self):
        self.upload("photo.jpg", "product")
        self.client.post("/api/library/brands", json={"name": "Kafe"})
        data = library.load()
        self.assertEqual((len(data["assets"]), len(data["brands"])), (1, 1))
        self.assertTrue((library.root() / "library.json").exists())


if __name__ == "__main__":
    unittest.main()
