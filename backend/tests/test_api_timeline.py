"""The timeline edit API: one request = one undo step, errors the user can act on."""
import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

import config
import main
import sentences
import store
import timeline
from services import media
from tests.test_timeline import VIDEO, sentence


class Api(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.old = config.PROJECTS_DIR
        config.PROJECTS_DIR = Path(self.dir.name)
        p = store.create("x.mp4")

        def setup(q):
            q["video"] = dict(VIDEO)
            timeline.init(q, q["video"], "x.mp4")
            timeline.track(q, "voice")["clips"] = [sentence("s1", 10, 12, "មួយ"), sentence("s2", 30, 34, "ពីរបីបួន")]
            q["status"] = "done"

        self.pid = store.mutate(p["id"], setup)["id"]
        self.client = TestClient(main.app)

    def tearDown(self):
        config.PROJECTS_DIR = self.old
        self.dir.cleanup()

    def edit(self, **op):
        return self.client.post(f"/api/projects/{self.pid}/timeline/edit", json={"edit": op})

    def tracks(self, body):
        return {t["id"]: t for t in body["project"]["timeline"]["tracks"]}

    def test_split_trim_delete_undo(self):
        r = self.edit(op="split", at=20)
        self.assertEqual(r.status_code, 200, r.text)
        right = r.json()["ids"][0]
        self.assertEqual(r.json()["project"]["history"]["undo_label"], "Split clip")
        r = self.edit(op="trim", clip=right, side="start", to=25)
        self.assertEqual([(c["start"], c["end"]) for c in self.tracks(r.json())["video"]["clips"]], [(0, 20), (25, 100)])
        r = self.edit(op="close_gap", at=22)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual([(c["start"], c["end"]) for c in self.tracks(r.json())["video"]["clips"]], [(0, 20), (20, 95)])
        self.assertEqual([(s["start"], s["end"]) for s in r.json()["project"]["sentences"]], [(10, 12), (25, 29)])
        for _ in range(3):
            r = self.client.post(f"/api/projects/{self.pid}/undo")
        self.assertEqual([(c["start"], c["end"]) for c in self.tracks(r.json())["video"]["clips"]], [(0, 100)])

    def test_split_a_sentence_at_the_playhead(self):
        r = self.edit(op="split", at=32, clips=["s2"], indexes={"s2": 3})
        self.assertEqual(r.status_code, 200, r.text)
        items = r.json()["project"]["sentences"]
        self.assertEqual([(s["start"], s["end"], s["khmer_text"]) for s in items[1:]], [(30, 32, "ពីរ"), (32, 34, "បីបួន")])

    def test_ripple_delete_and_skip(self):
        right = self.edit(op="split", at=20).json()["ids"][0]
        self.edit(op="split", at=40, clips=[right])
        r = self.edit(op="delete", clips=[right], ripple=True)
        self.assertEqual(r.json()["project"]["history"]["undo_label"], "Ripple delete")
        self.assertEqual([(s["id"], s["start"]) for s in r.json()["project"]["sentences"]], [("s1", 10)])  # s2 was in 20–40
        r = self.edit(op="skip_range", start=50, end=60)
        self.assertEqual([c["skipped"] for c in self.tracks(r.json())["video"]["clips"]], [False, False, True, False])

    def test_background_and_clip_settings(self):
        r = self.edit(op="background", start=10, end=20, volume=0)
        pieces = self.tracks(r.json())["background"]["clips"]
        self.assertEqual([(b["start"], b["end"], b["volume"]) for b in pieces], [(0, 10, 100), (10, 20, 0), (20, 100, 100)])
        for v in (20, 40, 60):  # a slider: one undo step
            r = self.edit(op="set", clip=pieces[0]["id"], fields={"volume": v})
        self.assertEqual(r.json()["project"]["history"]["undo"], 2)

    def test_add_media_insert_and_remove(self):
        d = Path(self.dir.name)
        png, wav = d / "logo.png", d / "beep.wav"
        media.ffmpeg("-f", "lavfi", "-i", "color=c=red:s=64x32", "-frames:v", 1, png, what="test picture")
        media.ffmpeg("-f", "lavfi", "-i", "sine=f=440:d=2", wav, what="test sound")
        r = self.client.post(f"/api/projects/{self.pid}/media", files={"file": ("logo.png", png.read_bytes(), "image/png")})
        self.assertEqual(r.status_code, 200, r.text)
        mid = r.json()["id"]
        self.assertEqual({k: r.json()["project"]["media"][mid][k] for k in ("kind", "width", "height", "name")},
                         {"kind": "image", "width": 64, "height": 32, "name": "logo.png"})
        r = self.client.post(f"/api/projects/{self.pid}/media", files={"file": ("beep.wav", wav.read_bytes(), "audio/wav")})
        sound = r.json()["id"]
        self.assertEqual(r.json()["project"]["media"][sound]["duration"], 2.0)
        self.assertEqual(self.client.get(r.json()["project"]["media"][sound]["wave_url"]).status_code, 200)
        r = self.edit(op="insert", media=mid, at=20, seconds=2)
        self.assertEqual([(c["type"], c["start"], c["end"]) for c in self.tracks(r.json())["video"]["clips"]], [("video", 0, 20), ("image", 20, 22), ("video", 22, 102)])
        self.assertEqual(r.json()["project"]["history"]["undo_label"], "Add clip")
        r = self.client.delete(f"/api/projects/{self.pid}/media/{mid}")
        self.assertEqual(r.status_code, 409)  # it's on the timeline
        r = self.client.delete(f"/api/projects/{self.pid}/media/{sound}")
        self.assertTrue(r.json()["project"]["media"][sound]["removed"])
        r = self.client.post(f"/api/projects/{self.pid}/media", files={"file": ("notes.txt", b"hello", "text/plain")})
        self.assertEqual(r.status_code, 400)

    def test_errors(self):
        r = self.edit(op="close_gap", at=50)
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.json()["error"]["message"], "There's no gap here.")
        self.client.patch(f"/api/projects/{self.pid}/timeline/tracks/video", json={"locked": True})
        r = self.edit(op="split", at=20)
        self.assertEqual(r.json()["error"]["message"], "The video track is locked.")
        r = self.edit(op="trim", clip="v1", side="sideways", to=1)
        self.assertEqual(r.status_code, 422)


if __name__ == "__main__":
    unittest.main()
