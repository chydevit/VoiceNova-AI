"""Watermarks: logos (uploaded, background removed), their settings, the watermark track on the
timeline, the upgrade to schema 5, and where they show in the export plan."""
import copy
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
from fastapi.testclient import TestClient

import config
import main
import render
import store
import timeline
import watermarks
from errors import AppError
from tests.test_timeline import VIDEO, project_v3, sentence


def logo_png(path: Path, w=200, h=100) -> Path:
    """A red disc on a transparent background."""
    y, x = np.mgrid[0:h, 0:w]
    px = np.zeros((h, w, 4), np.uint8)
    inside = (x - w / 2) ** 2 / (w / 2.5) ** 2 + (y - h / 2) ** 2 / (h / 2.5) ** 2 <= 1
    px[inside] = (220, 30, 30, 255)
    return watermarks.write_png(px, path)


def logo_jpg(path: Path, w=240, h=120) -> Path:
    """A blue box with a white hole in it, on a white background (the hole must stay white)."""
    px = np.full((h, w, 4), 255, np.uint8)
    px[20:100, 40:200, :3] = (20, 40, 200)
    px[45:75, 100:140, :3] = 255  # white inside the logo, not joined to the background
    png = watermarks.write_png(px, path.with_suffix(".tmp.png"))
    subprocess.run([config.FFMPEG, "-v", "error", "-y", "-i", str(png), "-q:v", "2", str(path)], check=True)
    png.unlink()
    return path


def project(**kw):
    p = project_v3({"sentences": [sentence("s1", 1, 3)], "settings": {"background": "duck", "background_volume": 0.15}, "original_gaps": [], "next_id": 2})
    p["media"]["m9"] = {"kind": "image", "file": "media/m9.png", "name": "logo.png", "width": 200, "height": 100, "role": "watermark"}
    return p


class Settings(unittest.TestCase):
    def test_defaults_and_checks(self):
        s = watermarks.clean({"kind": "image", "width": 12.4, "opacity": 101, "rotation": -200, "margin": 3.6})
        self.assertEqual((s["width"], s["opacity"], s["rotation"], s["margin"]), (12, 100, -180, 4))  # whole percents, clamped
        self.assertEqual(s["anchor"], "bottom-right")
        for bad in ({"anchor": "upside"}, {"font": "Arial"}, {"color": "red"}, {"effects": {"sparkle": True}}, {"hide_during": ["credits"]},
                    {"animation": {"type": "spin"}}, {"nonsense": 1}):
            with self.assertRaises(AppError, msg=bad):
                watermarks.clean(bad)
        s = watermarks.clean({"effects": {"color": "white", "radius": 20}, "animation": {"type": "corners", "every": 1}}, s)
        self.assertEqual((s["effects"]["color"], s["effects"]["radius"], s["animation"]["every"], s["width"]), ("white", 20, 2, 12))  # the rest kept

    def test_tiled_and_text_defaults(self):
        self.assertEqual(watermarks.defaults("tiled")["opacity"], 15)
        p = project()
        c = watermarks.new_clip(p, {"kind": "text", "text": ""})
        self.assertEqual(c["text"], "x")  # the project's name when nothing is typed
        self.assertEqual((c["start"], c["end"], c["whole"]), (0.0, 100.0, True))


class Timeline(unittest.TestCase):
    def test_whole_video_follows_the_video(self):
        p = project()
        w = watermarks.new_clip(p, {"kind": "image", "media": "m9"})
        self.assertEqual(w["id"][0], "w")
        timeline.remove_range(p, 20, 30)
        watermarks.fit_whole(p)  # (store.edit does this after every edit)
        self.assertEqual((w["start"], w["end"]), (0.0, 90.0))
        self.assertEqual(timeline.end(p), 90.0)

    def test_a_watermark_never_makes_the_video_longer(self):
        p = project()
        watermarks.new_clip(p, {"kind": "image", "media": "m9"}, 80, 150)
        self.assertEqual(timeline.end(p), 100.0)

    def test_needs_a_logo(self):
        with self.assertRaises(AppError):
            watermarks.new_clip(project(), {"kind": "image", "media": None})

    def test_trim_split_move_duplicate_make_it_a_part(self):
        p = project()
        w = watermarks.new_clip(p, {"kind": "image", "media": "m9"})
        right = timeline.split_at(p, w, 40)
        self.assertEqual([(c["start"], c["end"], c["whole"]) for c in timeline.clips(p, "watermark")], [(0, 40, False), (40, 100, False)])
        timeline.trim(p, right["id"], "start", 50)
        timeline.move(p, [right["id"]], -5)
        self.assertEqual((right["start"], right["end"]), (45, 95))
        made = timeline.duplicate(p, [w["id"]])
        self.assertEqual(timeline.find(p, made[0])[1]["start"], 40)
        timeline.delete(p, [w["id"]])
        self.assertEqual(len(timeline.clips(p, "watermark")), 2)

    def test_set_props_and_locked_track(self):
        p = project()
        w = watermarks.new_clip(p, {"kind": "image", "media": "m9"})
        watermarks.set_props(p, w["id"], {"opacity": 33, "anchor": "top-left"})
        self.assertEqual((w["opacity"], w["anchor"], w["width"]), (33, "top-left", 12))
        timeline.track(p, "watermark")["locked"] = True
        with self.assertRaises(AppError):
            watermarks.set_props(p, w["id"], {"opacity": 40})

    def test_plan_hides_it_during_the_intro_and_skipped_parts(self):
        p = project()
        p["media"]["i1"] = {"kind": "image", "file": "media/i1.png", "name": "intro.png", "width": 64, "height": 64}
        timeline.insert_media(p, "i1", 0, seconds=5)  # an intro picture, 0–5
        timeline.skip_range(p, 50, 60)
        w = watermarks.new_clip(p, {"kind": "image", "media": "m9", "hide_during": ["intro"]})
        watermarks.fit_whole(p)
        pieces = [(x["start"], x["end"], x["since"], x["enters"], x["leaves"]) for x in render.plan(p)["watermarks"]]
        self.assertEqual(pieces, [(5.0, 50.0, 5.0, False, False), (50.0, 95.0, 50.0, False, True)])
        w["hide_during"] = []
        self.assertEqual(render.plan(p)["watermarks"][0]["start"], 0.0)
        timeline.track(p, "watermark")["hidden"] = True
        self.assertEqual(render.plan(p)["watermarks"], [])


class Logos(unittest.TestCase):
    def test_background_removal_keeps_white_inside_the_logo(self):
        with tempfile.TemporaryDirectory() as d:
            src = logo_jpg(Path(d) / "logo.jpg")
            found = watermarks.remove_background(src, Path(d) / "out.png", 40)
            self.assertEqual(found["color"], "#ffffff")
            px = watermarks.read_rgba(Path(d) / "out.png")
            self.assertEqual(px[5, 5, 3], 0)  # the corner: background, gone
            self.assertEqual(px[60, 60, 3], 255)  # the blue box stays
            self.assertEqual(px[60, 120, 3], 255)  # the white hole inside it stays too
            self.assertGreater(found["removed"], 0.3)

    def test_transparent_logo_needs_no_removal(self):
        with tempfile.TemporaryDirectory() as d:
            src = logo_png(Path(d) / "logo.png")
            with self.assertRaises(AppError):
                watermarks.remove_background(src, Path(d) / "out.png")


class Upgrade(unittest.TestCase):
    def test_old_project_gets_the_track_and_keeps_its_undo(self):
        with tempfile.TemporaryDirectory() as d:
            old = config.PROJECTS_DIR
            config.PROJECTS_DIR = Path(d)
            try:
                p = store.create("x.mp4")
                store.mutate(p["id"], lambda q: (q.update(video=dict(VIDEO)), timeline.init(q, q["video"], "x.mp4")))
                store.edit(p["id"], lambda q: timeline.split_at(q, timeline.clips(q, "video")[0], 10), "Split clip")
                folder = store.project_dir(p["id"])
                raw = json.loads((folder / "project.json").read_text("utf-8"))
                raw["version"] = 4
                raw["timeline"]["tracks"] = [t for t in raw["timeline"]["tracks"] if t["id"] != "watermark"]
                (folder / "project.json").write_text(json.dumps(raw), "utf-8")
                loaded = store.load(p["id"])
                self.assertEqual([t["id"] for t in loaded["timeline"]["tracks"]], list(timeline.TRACKS))
                self.assertEqual(loaded["history"]["undo"], 1)
                self.assertTrue((folder / "project.v4.json").exists())
            finally:
                config.PROJECTS_DIR = old


FIXTURE = Path(__file__).parent / "fixtures" / "watermark_parity.json"


def parity_cases() -> dict:
    """Animation values and hidden parts the browser must match (frontend tests/watermark.test.js).
    Write the file again with UPDATE_FIXTURES=1 after changing the maths (on both sides)."""
    anims = [{"type": "none"}, {"type": "fade", "fade": 0.7}, {"type": "pulse", "period": 3.0}, {"type": "pulse", "period": 1.3},
             {"type": "corners", "every": 4.0}, {"type": "corners", "every": 2.5}]
    out = {"animations": []}
    for anchor in ("bottom-right", "top-center", "free"):
        for a in anims:
            w = {**watermarks.defaults(), "anchor": anchor, "animation": {**watermarks.defaults()["animation"], **a}}
            samples = []
            for i in range(0, 400):
                since = round(i * 0.0731, 4)
                alpha, at = watermarks.animation_at(w, since, 20 - since)
                samples.append([since, 20 - since, alpha, at])
            out["animations"].append({"w": w, "samples": samples})
    p = project()
    p["media"]["i1"] = {"kind": "image", "file": "media/i1.png", "name": "intro.png", "width": 64, "height": 64}
    p["media"]["ad"] = {"kind": "image", "file": "media/ad.png", "name": "ad.png", "width": 64, "height": 64, "role": "ad"}
    timeline.insert_media(p, "i1", 0, seconds=5)
    timeline.insert_media(p, "ad", 40, seconds=6)
    timeline.insert_media(p, "i1", timeline.end(p), seconds=4)
    out["hidden"] = {"timeline": p["timeline"], "media": p["media"],
                     "ranges": {",".join(h): watermarks.hidden_ranges(p, list(h)) for h in (["ads"], ["intro"], ["outro"], ["ads", "intro", "outro"], [])}}
    return out


class Parity(unittest.TestCase):
    def test_fixture_is_up_to_date(self):
        cases = json.loads(json.dumps(parity_cases()))
        if __import__("os").environ.get("UPDATE_FIXTURES"):
            FIXTURE.write_text(json.dumps(cases, separators=(",", ":")), "utf-8")
        self.assertEqual(cases, json.loads(FIXTURE.read_text("utf-8")))

    def test_animation(self):
        w = {**watermarks.defaults(), "animation": {"type": "corners", "every": 5}}
        self.assertEqual([watermarks.animation_at(w, t)[1] for t in (0, 4.9, 5, 10, 15, 20)],
                         ["bottom-right", "bottom-right", "bottom-left", "top-left", "top-right", "bottom-right"])
        w["animation"] = {"type": "pulse", "period": 2}
        self.assertAlmostEqual(watermarks.animation_at(w, 1.0)[0], 1 - watermarks.PULSE_DEPTH)
        self.assertEqual(watermarks.animation_at(w, 1.05)[0], watermarks.animation_at(w, 1.0)[0])  # it steps ten times a second
        w["animation"] = {"type": "fade", "fade": 0.5}
        self.assertEqual([watermarks.animation_at(w, t, 3 - t)[0] for t in (0, 0.25, 1, 2.75, 3)], [0, 0.5, 1, 0.5, 0])


@unittest.skipUnless(config.FFMPEG, "needs FFmpeg")
class Api(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.old = (config.PROJECTS_DIR, config.DATA_DIR)
        config.DATA_DIR = Path(self.dir.name)
        config.PROJECTS_DIR = config.DATA_DIR / "projects"
        p = store.create("x.mp4")

        def setup(q):
            q["video"] = dict(VIDEO)
            timeline.init(q, q["video"], "x.mp4")
            q["status"] = "done"

        self.pid = store.mutate(p["id"], setup)["id"]
        self.client = TestClient(main.app)

    def tearDown(self):
        config.PROJECTS_DIR, config.DATA_DIR = self.old
        self.dir.cleanup()

    def upload(self, path: Path, **form):
        return self.client.post(f"/api/projects/{self.pid}/watermark-logo", files={"file": (path.name, path.read_bytes())}, data=form)

    def edit(self, **op):
        return self.client.post(f"/api/projects/{self.pid}/timeline/edit", json={"edit": op})

    def test_upload_remove_background_add_change_undo(self):
        d = Path(self.dir.name)
        r = self.upload(logo_jpg(d / "brand.jpg"))
        self.assertEqual(r.status_code, 200, r.text)
        mid, asset = r.json()["id"], r.json()["asset"]
        m = r.json()["project"]["media"][mid]
        self.assertEqual((m["kind"], m["role"], m["width"], m["height"], m["transparent"], m["library"]), ("image", "watermark", 240, 120, False, asset))
        self.assertTrue(asset)  # kept in the Brand Kit for other projects
        r = self.client.post(f"/api/projects/{self.pid}/media/{mid}/remove-background", json={"tolerance": 40})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(r.json()["project"]["media"][mid]["nobg_url"])
        self.assertEqual(self.client.get(r.json()["project"]["media"][mid]["nobg_url"]).status_code, 200)
        r = self.edit(op="add_watermark", fields={"kind": "image", "media": mid, "remove_bg": True})
        self.assertEqual(r.status_code, 200, r.text)
        wid = r.json()["id"]
        self.assertEqual(r.json()["project"]["history"]["undo_label"], "Add watermark")
        for v in (60, 61, 62):  # a slider: one undo step
            r = self.edit(op="set_watermark", clip=wid, fields={"opacity": v})
        self.assertEqual(r.json()["project"]["history"]["undo"], 2)
        self.assertEqual(self.edit(op="set_watermark", clip=wid, fields={"opacity": "lots"}).status_code, 400)
        r = self.client.post(f"/api/projects/{self.pid}/undo")
        wm = next(t for t in r.json()["project"]["timeline"]["tracks"] if t["id"] == "watermark")
        self.assertEqual(wm["clips"][0]["opacity"], 75)

    def test_logo_from_the_kit_once_and_size_limit(self):
        d = Path(self.dir.name)
        r = self.upload(logo_png(d / "brand.png"))
        asset = r.json()["asset"]
        self.assertTrue(r.json()["project"]["media"][r.json()["id"]]["transparent"])
        other = store.create("y.mp4")
        r1 = self.client.post(f"/api/projects/{other['id']}/watermark-logo/from-kit", json={"asset": asset})
        r2 = self.client.post(f"/api/projects/{other['id']}/watermark-logo/from-kit", json={"asset": asset})
        self.assertEqual(r1.json()["id"], r2.json()["id"])  # one copy per project
        big = d / "big.png"
        big.write_bytes(b"\x89PNG" + b"0" * (watermarks.MAX_LOGO_MB * 1024 * 1024 + 10))
        self.assertEqual(self.upload(big).status_code, 413)
        bad = d / "logo.gif"
        bad.write_bytes(b"GIF89a")
        self.assertEqual(self.upload(bad).status_code, 400)

    def test_presets_default_and_apply_to_all(self):
        d = Path(self.dir.name)
        mid = self.upload(logo_jpg(d / "brand.jpg"), save_to_kit="no").json()["id"]
        self.client.post(f"/api/projects/{self.pid}/media/{mid}/remove-background", json={"tolerance": 40})
        self.edit(op="add_watermark", fields={"kind": "image", "media": mid, "remove_bg": True, "anchor": "top-left", "opacity": 60})
        self.edit(op="add_watermark", fields={"kind": "text", "text": "facebook.com/khmer", "font": "Moul"})
        r = self.client.post("/api/watermarks/presets", json={"name": "Brand", "project": self.pid})
        self.assertEqual(r.status_code, 200, r.text)
        preset = r.json()["id"]
        self.assertEqual(r.json()["default"], preset)  # the first one is the default
        items = r.json()["presets"][0]["watermarks"]
        self.assertEqual([i["kind"] for i in items], ["image", "text"])
        self.assertTrue(items[0]["logo"] and items[0]["logo_url"])  # the logo went into the Brand Kit for it
        self.assertEqual((items[0]["anchor"], items[0]["opacity"], items[0]["bg_tolerance"]), ("top-left", 60, 40))
        # another project: the preset once, then again (it replaces itself)
        other = store.create("y.mp4")
        store.mutate(other["id"], lambda q: (q.update(video=dict(VIDEO), status="done"), timeline.init(q, q["video"], "y.mp4")))
        for _ in range(2):
            r = self.client.post(f"/api/projects/{other['id']}/watermarks/preset", json={"preset": preset})
            self.assertEqual(r.status_code, 200, r.text)
        marks = next(t for t in r.json()["project"]["timeline"]["tracks"] if t["id"] == "watermark")["clips"]
        self.assertEqual([(c["kind"], c["whole"], c["preset"]) for c in marks], [("image", True, preset), ("text", True, preset)])
        logo = r.json()["project"]["media"][marks[0]["media"]]
        self.assertTrue(logo["nobg_url"])  # its background removed in this project too
        r = self.client.post(f"/api/watermarks/presets/{preset}/apply-all")
        self.assertEqual(r.json(), {"done": 2, "skipped": 0})
        # a new upload gets the default when it's on (and none when it's off)
        video = d / "v.mp4"
        subprocess.run([config.FFMPEG, "-v", "error", "-f", "lavfi", "-i", "color=c=gray:s=160x90:r=25:d=2", "-f", "lavfi", "-i", "sine=d=2",
                        "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(video)], check=True)
        for auto, want in ((True, 2), (False, 0)):
            self.client.post("/api/watermarks/default", json={"auto": auto})
            with mock.patch("jobs.start"), mock.patch("pipeline.ensure_proxies"):  # (no transcribing, no preview copy here)
                r = self.client.post("/api/projects", files={"file": ("v.mp4", video.read_bytes())})
            self.assertEqual(r.status_code, 200, r.text)
            marks = next(t for t in r.json()["project"]["timeline"]["tracks"] if t["id"] == "watermark")["clips"]
            self.assertEqual(len(marks), want)
        self.assertEqual(self.client.post("/api/projects", files={"file": ("v.mp4", video.read_bytes())}, data={"watermark_preset": "nope"}).status_code, 404)
        r = self.client.delete(f"/api/watermarks/presets/{preset}")
        self.assertEqual((r.json()["presets"], r.json()["default"]), ([], None))



@unittest.skipUnless(config.FFMPEG, "needs FFmpeg")
class Export(unittest.TestCase):
    """The exported video has each watermark where, when and as see-through as the preview shows it
    (the browser's picture laid over with watermarks.animation_at's opacity and position)."""
    W, H = 320, 180

    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.TemporaryDirectory()
        d = Path(cls.dir.name)
        cls.video = d / "grey.mp4"
        subprocess.run([config.FFMPEG, "-v", "error", "-f", "lavfi", "-i", f"color=c=0x808080:s={cls.W}x{cls.H}:r=25:d=12", "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
                        "-t", "12", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(cls.video)], check=True)
        cls.info = {**media_probe(cls.video), "file": "grey.mp4"}
        cls.png = d / "mark.png"
        px = np.zeros((30, 60, 4), np.uint8)
        px[...] = (255, 0, 0, 204)  # red, 80 % opacity (the browser bakes opacity into the picture)
        watermarks.write_png(px, cls.png)
        cls.voice = d / "voice.wav"
        from services import media
        media.write_wav(cls.voice, np.zeros(12 * media.VOICE_RATE, dtype=np.int16))

    @classmethod
    def tearDownClass(cls):
        cls.dir.cleanup()

    def export(self, name, mark, box, settings=None, setup=None, files=None):
        from services import merge
        p = project_v3({"sentences": [], "settings": {"background": "duck", "background_volume": 0.15}, "original_gaps": [], "next_id": 1},
                       video={**VIDEO, **self.info, "duration": 12.0})
        p["media"]["m9"] = {"kind": "image", "file": "m9.png", "name": "m", "width": 60, "height": 30, "role": "watermark"}
        if settings:
            p["settings"]["export"] = {**timeline.default_export(), **settings}
        if setup:
            setup(p)
        c = watermarks.new_clip(p, {"kind": "image", "media": "m9", **mark})
        watermarks.fit_whole(p)
        out = Path(self.dir.name) / f"{name}.mp4"
        plan = render.plan(p)
        merge.render_video(plan, {"source": self.video, **(files or {})}, self.info, self.voice, p["settings"], out, watermarks={c["id"]: (self.png, box)})
        return out, plan

    def red(self, path, t, x, y):
        """How much of the watermark's red shows at (x, y) at time t: 0 (none) to 0.8 (all of it)."""
        raw = subprocess.run([config.FFMPEG, "-v", "error", "-ss", f"{t:.3f}", "-i", str(path), "-frames:v", "1", "-vf", f"crop=8:8:{x - 4}:{y - 4}",
                              "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True).stdout
        r, g, _ = np.frombuffer(raw, np.uint8).reshape(-1, 3).mean(axis=0)
        return float((r - g) / 255)  # grey has r == g; full red over grey at opacity a gives a·(255 − 0)… minus the grey's share

    def test_static_fade_and_without(self):
        box = {"x": 250, "y": 140, "width": 60, "height": 30, "corners": None}
        out, _ = self.export("static", {}, box)
        self.assertAlmostEqual(self.red(out, 5, 280, 155), 0.8, delta=0.06)
        self.assertAlmostEqual(self.red(out, 5, 100, 50), 0.0, delta=0.03)  # nothing elsewhere
        out, _ = self.export("fade", {"animation": {"type": "fade", "fade": 2}}, box)
        for t in (0.5, 1.0, 3, 11.0):
            want, _ = watermarks.animation_at({"anchor": "bottom-right", "animation": {"type": "fade", "fade": 2}}, t, 12 - t)
            self.assertAlmostEqual(self.red(out, t, 280, 155), 0.8 * want, delta=0.07, msg=f"t={t}")

    def test_pulse_follows_the_preview(self):
        box = {"x": 250, "y": 140, "width": 60, "height": 30, "corners": None}
        w = {"anchor": "bottom-right", "animation": {"type": "pulse", "period": 2.0}}
        out, _ = self.export("pulse", {"animation": w["animation"]}, box)
        for t in (0.0, 0.5, 1.0, 1.5, 3.0, 7.04):
            want, _ = watermarks.animation_at(w, t)
            self.assertAlmostEqual(self.red(out, t, 280, 155), 0.8 * want, delta=0.07, msg=f"t={t}")

    def test_corner_switch(self):
        corners = [{"x": 10, "y": 10}, {"x": 250, "y": 10}, {"x": 250, "y": 140}, {"x": 10, "y": 140}]
        box = {"x": 250, "y": 140, "width": 60, "height": 30, "corners": corners}
        out, _ = self.export("corners", {"anchor": "bottom-right", "animation": {"type": "corners", "every": 3}}, box)
        where = {"top-left": (40, 25), "top-right": (280, 25), "bottom-right": (280, 155), "bottom-left": (40, 155)}
        for t in (1, 4, 7, 10):
            _, at = watermarks.animation_at({"anchor": "bottom-right", "animation": {"type": "corners", "every": 3}}, t)
            for name, (x, y) in where.items():
                self.assertAlmostEqual(self.red(out, t, x, y), 0.8 if name == at else 0.0, delta=0.07, msg=f"t={t} {name}")

    def test_hidden_during_the_intro_on_9_16(self):
        blue = Path(self.dir.name) / "intro.png"
        px = np.zeros((64, 64, 4), np.uint8)
        px[...] = (0, 0, 255, 255)
        watermarks.write_png(px, blue)

        def intro(p):
            p["media"]["i1"] = {"kind": "image", "file": "intro.png", "name": "intro", "width": 64, "height": 64}
            timeline.insert_media(p, "i1", 0, seconds=3)  # an intro picture before the video

        box = {"x": 60, "y": 200, "width": 60, "height": 30, "corners": None}
        out, plan = self.export("portrait", {"hide_during": ["intro"]}, box, settings={"aspect": "9:16", "resolution": "original"}, setup=intro, files={"i1": blue})
        self.assertEqual(plan["canvas"], (180, 320))
        size = subprocess.run([config.FFPROBE, "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", str(out)],
                              capture_output=True, text=True).stdout.strip()
        self.assertEqual(size, "180,320")
        self.assertEqual([(p["start"], p["end"]) for p in plan["watermarks"]], [(3.0, 15.0)])
        self.assertAlmostEqual(self.red(out, 8, 90, 215), 0.8, delta=0.07)  # on the video
        raw = subprocess.run([config.FFMPEG, "-v", "error", "-ss", "1", "-i", str(out), "-frames:v", "1", "-vf", "crop=8:8:86:211",
                              "-f", "rawvideo", "-pix_fmt", "rgb24", "-"], capture_output=True).stdout
        r, g, b = np.frombuffer(raw, np.uint8).reshape(-1, 3).mean(axis=0)
        self.assertLess(r, 40)  # the intro there: blue, no red watermark on it
        self.assertGreater(b, 150)


def media_probe(path):
    from services import media
    return media.probe(path)


if __name__ == "__main__":
    unittest.main()
