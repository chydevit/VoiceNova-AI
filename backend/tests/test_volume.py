"""Volumes in whole percents (0–200) on tracks and clips, muting, volume lines, fades and ducking
under the Khmer voice — in the plan, the voice track and the exported file."""
import copy
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

import numpy as np
from fastapi.testclient import TestClient

import config
import main
import render
import sentences
import store
import timeline
from services import media, merge, voicetrack
from tests.test_timeline import VIDEO, project_v3, sentence


def project(background="duck", level=0.3, voice=()):
    return project_v3({"sentences": list(voice), "settings": {"background": background, "background_volume": level}, "original_gaps": [], "next_id": 10})


def voiced(s, seconds):
    """Give a sentence a voice clip `seconds` long (as if it was voiced)."""
    s.update(audio_file_path=f"clips/{s['id']}.wav", audio_key=sentences.clip_key(s), audio_duration=seconds)
    return sentences.refresh(s)


def with_music(p, start=0.0, end=60.0, **fields):
    p["media"]["m1"] = {"kind": "audio", "file": "media/m1.wav", "name": "music.wav", "duration": 300}
    clip = {"id": "a1", "type": "audio", "media": "m1", "start": start, "end": end, "source_in": 0.0, "source_out": end - start,
            "volume": 100, "muted": False, "fade_in": 0.0, "fade_out": 0.0, "skipped": False, **fields}
    timeline.clips(p, "audio").append(clip)
    return clip


def level(plan, t, media_id="source", stream="original"):
    """How loud a file plays at output time t."""
    return sum(render.gain_at(r, t - r["start"]) for r in plan["sound"]
               if r["media"] == media_id and r["stream"] == stream and r["start"] <= t < r["end"])


class Upgrade(unittest.TestCase):
    def v3(self):
        """A schema 3 project's editable state: fractions, the background's level in the settings."""
        p = project(level=0.3, voice=[sentence("s1", 1, 2)])
        p["settings"]["background_volume"] = 0.3
        for t in p["timeline"]["tracks"]:
            t.pop("volume", None)
            t.pop("duck", None)
            for c in t["clips"]:
                if "volume" in c:
                    c["volume"] = 1.0
                c.pop("muted", None)
        timeline.clips(p, "voice")[0]["volume"] = 1.25
        timeline.clips(p, "background")[0]["volume"] = 0.5
        return p

    def test_fractions_become_percents(self):
        p = self.v3()
        self.assertTrue(timeline.is_v3(p))
        timeline.upgrade_v4(p)
        self.assertFalse(timeline.is_v3(p))
        self.assertNotIn("background_volume", p["settings"])
        self.assertEqual(timeline.track(p, "background")["volume"], 30)
        self.assertEqual(timeline.track(p, "voice")["volume"], 100)
        self.assertEqual(timeline.track(p, "audio")["duck"], timeline.default_duck())
        self.assertEqual(timeline.clips(p, "background")[0]["volume"], 50)
        self.assertEqual((timeline.clips(p, "voice")[0]["volume"], timeline.clips(p, "voice")[0]["muted"]), (125, False))
        self.assertAlmostEqual(level(render.plan(p), 50), 0.15)  # 30 % of the track x 50 % of the piece, as before

    def test_stored_project_is_upgraded_with_a_backup(self):
        with tempfile.TemporaryDirectory() as d:
            old = config.PROJECTS_DIR
            config.PROJECTS_DIR = Path(d)
            try:
                p = store.create("x.mp4")
                state = self.v3()
                folder = store.project_dir(p["id"])
                (folder / "history").mkdir(exist_ok=True)
                raw = {**json.loads((folder / "project.json").read_text("utf-8")), "version": 3, "video": dict(VIDEO),
                       "media": state["media"], "timeline": state["timeline"], "settings": {**store.default_settings(), "background_volume": 0.3}}
                (folder / "project.json").write_text(json.dumps(raw), "utf-8")
                loaded = store.load(p["id"])
                self.assertEqual(loaded["version"], store.SCHEMA_VERSION)
                self.assertEqual(timeline.track(loaded, "background")["volume"], 30)
                self.assertTrue((folder / "project.v3.json").exists())
                self.assertTrue((folder / "history.v3").exists())
                self.assertEqual(json.loads((folder / "project.v3.json").read_text("utf-8"))["settings"]["background_volume"], 0.3)
            finally:
                config.PROJECTS_DIR = old

    def test_new_projects_start_at_their_mode_level(self):
        self.assertEqual(timeline.default_level("duck"), round(config.DUCK_VOLUME * 100))
        self.assertEqual(timeline.default_level("separate"), 100)
        self.assertEqual(timeline.default_level("replace"), 0)
        self.assertEqual(timeline.volume(37.4), 37)
        self.assertEqual(timeline.volume(-3), 0)
        self.assertEqual(timeline.volume(999), 200)


class Levels(unittest.TestCase):
    def test_track_times_clip(self):
        p = project(level=0.3)
        music = with_music(p, volume=50)
        timeline.track(p, "audio")["volume"] = 37
        plan = render.plan(p)
        self.assertAlmostEqual(level(plan, 10), 0.30)
        self.assertAlmostEqual(level(plan, 10, "m1"), 0.37 * 0.5)
        music["volume"] = 1  # 1 % steps all the way down
        timeline.track(p, "audio")["volume"] = 100
        self.assertAlmostEqual(level(render.plan(p), 10, "m1"), 0.01)

    def test_mute_keeps_the_volume(self):
        p = project()
        music = with_music(p, volume=12)
        timeline.set_props(p, "a1", {"muted": True})
        self.assertEqual(level(render.plan(p), 10, "m1"), 0)
        self.assertEqual(music["volume"], 12)
        timeline.set_props(p, "a1", {"muted": False})
        self.assertAlmostEqual(level(render.plan(p), 10, "m1"), 0.12)
        timeline.track(p, "background")["muted"] = True
        self.assertEqual(level(render.plan(p), 10), 0)
        self.assertEqual(timeline.track(p, "background")["volume"], 30)

    def test_boost_to_200(self):
        p = project()
        with_music(p, volume=200)
        timeline.track(p, "audio")["volume"] = 150
        self.assertAlmostEqual(level(render.plan(p), 10, "m1"), 3.0)

    def test_modes(self):
        p = project("separate", 0.8)
        self.assertAlmostEqual(level(render.plan(p, stem_ready=True), 10, stream="stem"), 0.8)
        self.assertAlmostEqual(level(render.plan(p, stem_ready=False), 10), 0.8 * 0.3)  # quietly until the voice is removed
        p = project("replace", 0.0)
        self.assertEqual(render.plan(p)["sound"], [])
        timeline.volume_range(p, "background", 20, 30, 80)
        timeline.set_props(p, timeline.clips(p, "background")[1]["id"], {"keep_voice": True})
        self.assertAlmostEqual(level(render.plan(p), 25), 0.8)  # the original voice kept there, at its piece's volume

    def test_an_added_videos_sound_plays_at_its_clips_volume(self):
        p = project(level=0.15)
        p["media"]["v2"] = {"kind": "video", "file": "media/v2.mp4", "name": "intro.mp4", "duration": 10, "width": 640, "height": 360, "fps": 30, "audio": True}
        timeline.insert_media(p, "v2", 0)
        plan = render.plan(p)
        self.assertAlmostEqual(level(plan, 5, "v2"), 1.0)
        self.assertAlmostEqual(level(plan, 50), 0.15)

    def test_fades_in_tenths(self):
        p = project()
        with_music(p, start=10, end=20)
        timeline.set_props(p, "a1", {"fade_in": 0.4, "fade_out": 2.0})
        plan = render.plan(p)
        self.assertAlmostEqual(level(plan, 10.2, "m1"), 0.5)
        self.assertAlmostEqual(level(plan, 19.0, "m1"), 0.5)
        self.assertAlmostEqual(level(plan, 15.0, "m1"), 1.0)


class Lines(unittest.TestCase):
    def test_line_follows_the_sound(self):
        p = project()
        with_music(p, start=10, end=30)
        timeline.set_props(p, "a1", {"keys": [{"at": 10, "v": 100}, {"at": 0, "v": 0}, {"at": 10.0004, "v": 50}]})
        music = timeline.find(p, "a1")[1]
        self.assertEqual(music["keys"], [{"at": 0.0, "v": 0}, {"at": 10.0, "v": 50}])  # in time order, one point per moment
        plan = render.plan(p)
        self.assertAlmostEqual(level(plan, 15, "m1"), 0.25)  # halfway along the line
        self.assertAlmostEqual(level(plan, 25, "m1"), 0.50)  # level after the last point
        timeline.move(p, ["a1"], 5)  # the line moves with its sound
        self.assertAlmostEqual(level(render.plan(p), 20, "m1"), 0.25)

    def test_line_takes_the_place_of_the_volume(self):
        p = project()
        with_music(p, volume=10)
        timeline.set_props(p, "a1", {"keys": [{"at": 0, "v": 80}]})
        self.assertAlmostEqual(level(render.plan(p), 5, "m1"), 0.8)
        timeline.set_props(p, "a1", {"keys": []})  # removed: the volume again
        self.assertNotIn("keys", timeline.find(p, "a1")[1])
        self.assertAlmostEqual(level(render.plan(p), 5, "m1"), 0.1)

    def test_split_keeps_each_parts_points(self):
        p = project()
        music = with_music(p, start=0, end=40)
        timeline.set_props(p, "a1", {"keys": [{"at": t, "v": t} for t in (5, 15, 25, 35)]})
        right = timeline.split_at(p, music, 20)
        self.assertEqual([k["at"] for k in music["keys"]], [5, 15, 25])  # its own, and the next one the line runs to
        self.assertEqual([k["at"] for k in right["keys"]], [15, 25, 35])
        self.assertAlmostEqual(level(render.plan(p), 20, "m1"), 0.20)  # the same line across the cut

    def test_two_lines_meet_without_a_jump(self):
        p = project()
        with_music(p, start=0, end=10, keys=[{"at": 0, "v": 100}])
        with_music(p, start=10, end=20)["id"] = "a2"
        clip = timeline.find(p, "a2")[1]
        clip.update(source_in=10, source_out=20, keys=[{"at": 10, "v": 20}])
        plan = render.plan(p)
        run = next(r for r in plan["sound"] if r["media"] == "m1")
        values = [render.gain_at(run, 10 + i / 1000) for i in range(-20, 20)]
        self.assertTrue(all(abs(a - b) < 0.1 for a, b in zip(values, values[1:])))  # a 10 ms ramp, never a step


class Ducking(unittest.TestCase):
    def setUp(self):
        self.s1 = voiced(sentence("s1", 10, 13), 1.5)  # speaks 10–11.5
        self.p = project(level=0.3, voice=[self.s1])
        timeline.track(self.p, "background")["duck"] = {"on": True, "level": 5, "fade": 0.5}

    def test_lower_while_the_voice_speaks(self):
        plan = render.plan(self.p)
        self.assertEqual(plan["sound"][0]["duck"]["spans"], [(10, 11.5)])
        for t, want in ((9.0, 0.30), (9.75, 0.175), (10.0, 0.05), (11.0, 0.05), (11.5, 0.05), (11.75, 0.175), (12.5, 0.30)):
            self.assertAlmostEqual(level(plan, t), want, msg=f"t={t}")

    def test_short_pauses_stay_low(self):
        s2 = voiced(sentence("s2", 12.6, 14), 1.0)  # 1.1 s after s1 ends: less than two fades and the hold
        timeline.clips(self.p, "voice").append(s2)
        plan = render.plan(self.p)
        self.assertEqual(plan["sound"][0]["duck"]["spans"], [(10, 13.6)])
        self.assertAlmostEqual(level(plan, 12.0), 0.05)

    def test_nothing_to_duck_under(self):
        for change in (lambda p: timeline.track(p, "voice").update(muted=True), lambda p: timeline.track(p, "voice").update(volume=0),
                       lambda p: timeline.clips(p, "voice")[0].update(muted=True), lambda p: timeline.clips(p, "voice")[0].update(volume=0),
                       lambda p: timeline.clips(p, "voice")[0].update(skipped=True), lambda p: timeline.clips(p, "voice")[0].update(khmer_text="ថ្មី")):
            p = copy.deepcopy(self.p)
            change(p)
            self.assertAlmostEqual(level(render.plan(p), 10.5), 0.30)

    def test_duck_level_above_the_track_does_nothing(self):
        timeline.track(self.p, "background")["duck"]["level"] = 40
        self.assertAlmostEqual(level(render.plan(self.p), 10.5), 0.30)

    def test_music_ducks_too(self):
        with_music(self.p, volume=50)
        timeline.track(self.p, "audio")["duck"] = {"on": True, "level": 10, "fade": 0.3}
        self.assertAlmostEqual(level(render.plan(self.p), 10.5, "m1"), 0.05)  # 10 % of the track, times the clip's 50 %
        self.assertAlmostEqual(level(render.plan(self.p), 5, "m1"), 0.5)

    def test_in_output_time(self):
        timeline.skip_range(self.p, 2, 4)  # 2 s earlier in the export
        plan = render.plan(self.p)
        self.assertEqual(plan["sound"][-1]["duck"]["spans"], [(8, 9.5)])
        self.assertAlmostEqual(level(plan, 8.5), 0.05)


class Ranges(unittest.TestCase):
    def test_one_volume_for_part_of_a_track(self):
        p = project(voice=[sentence("s1", 5, 8), sentence("s2", 9, 12), sentence("s3", 20, 22)])
        with_music(p, start=0, end=50, keys=[{"at": 0, "v": 70}])
        self.assertEqual(timeline.volume_range(p, "background", 10, 20, 7), 1)
        self.assertEqual([(b["start"], b["end"], b["volume"]) for b in timeline.clips(p, "background")], [(0, 10, 100), (10, 20, 7), (20, 100, 100)])
        self.assertEqual(timeline.volume_range(p, "audio", 10, 20, 0), 1)
        music = timeline.clips(p, "audio")
        self.assertEqual([("keys" in c, c["volume"]) for c in music], [(True, 100), (False, 0), (True, 100)])
        self.assertEqual(timeline.volume_range(p, "voice", 7, 10, 150), 2)  # sentences are never cut: those in the part
        self.assertEqual([s["volume"] for s in timeline.clips(p, "voice")], [150, 150, 100])
        timeline.track(p, "voice")["locked"] = True
        with self.assertRaises(Exception):
            timeline.volume_range(p, "voice", 0, 30, 10)


class Sentences(unittest.TestCase):
    def test_split_and_merge_keep_mute_and_outer_fades(self):
        p = project(voice=[sentence("s1", 10, 14, "មួយពីរបីបួន")])
        s1 = timeline.find(p, "s1")[1]
        s1.update(volume=40, muted=True, fade_in=0.5, fade_out=0.7, keys=[{"at": 0, "v": 10}])
        first, second = sentences.split(p, "s1", 6, None)
        self.assertEqual((first["volume"], first["muted"], first["fade_in"], first["fade_out"], "keys" in first), (40, True, 0.5, 0.0, False))
        self.assertEqual((second["volume"], second["muted"], second.get("fade_in", 0.0), second["fade_out"]), (40, True, 0.0, 0.7))
        merged = sentences.merge(p, first["id"])
        self.assertEqual((merged["fade_in"], merged["fade_out"]), (0.5, 0.7))


class VoiceTrack(unittest.TestCase):
    def test_gains(self):
        with tempfile.TemporaryDirectory() as d:
            d = Path(d)
            (d / "clips").mkdir()
            sr = media.VOICE_RATE
            media.write_wav(d / "clips/s1.wav", np.full(2 * sr, 10000, dtype=np.int16))  # 2 s of a steady level
            s = voiced(sentence("s1", 1, 4), 2.0)
            s.update(volume=40, fade_in=0.5)
            track, _ = voicetrack.build(d, [s], 5.0, d / "voice.wav", volume=50)
            v = media.read_wav(track).astype(float)
            at = lambda t: v[int(t * sr)]  # noqa: E731
            self.assertAlmostEqual(at(2.0), 10000 * 0.4 * 0.5, delta=2)
            self.assertAlmostEqual(at(1.25), 10000 * 0.4 * 0.5 * 0.5, delta=2)  # halfway into its fade
            self.assertEqual(at(3.5), 0)  # its sound ended at 3 s
            s.update(keys=[{"at": 0, "v": 0}, {"at": 2, "v": 200}], fade_in=0)
            v = media.read_wav(voicetrack.build(d, [s], 5.0, d / "voice.wav")[0]).astype(float)
            self.assertAlmostEqual(v[int(2.0 * sr)], 10000 * 1.0, delta=2)  # the line at 1 s into the clip: 100 %
            s.update(muted=True)
            v = media.read_wav(voicetrack.build(d, [s], 5.0, d / "voice.wav")[0])
            self.assertEqual(int(np.abs(v).max()), 0)


class Api(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.old = config.PROJECTS_DIR
        config.PROJECTS_DIR = Path(self.dir.name)
        p = store.create("x.mp4")

        def setup(q):
            q["video"] = dict(VIDEO)
            timeline.init(q, q["video"], "x.mp4")
            timeline.track(q, "voice")["clips"] = [sentence("s1", 10, 12, "មួយ"), sentence("s2", 30, 34, "ពីរ")]
            q["status"] = "done"

        self.pid = store.mutate(p["id"], setup)["id"]
        self.client = TestClient(main.app)

    def tearDown(self):
        config.PROJECTS_DIR = self.old
        self.dir.cleanup()

    def track(self, body, tid):
        return next(t for t in body["project"]["timeline"]["tracks"] if t["id"] == tid)

    def patch_track(self, tid, **fields):
        return self.client.patch(f"/api/projects/{self.pid}/timeline/tracks/{tid}", json=fields)

    def test_track_volume_and_ducking(self):
        r = self.patch_track("background", volume=37)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.track(r.json(), "background")["volume"], 37)
        for v in (38, 39, 40):  # dragging: the same undo step
            r = self.patch_track("background", volume=v)
        self.assertEqual(r.json()["project"]["history"]["undo"], 1)
        self.assertEqual(r.json()["project"]["history"]["undo_label"], "Change track volume")
        r = self.patch_track("audio", duck={"on": True, "level": 4, "fade": 0.75})
        self.assertEqual(self.track(r.json(), "audio")["duck"], {"on": True, "level": 4, "fade": 0.75})
        self.assertEqual(self.patch_track("background", volume=201).status_code, 422)
        self.assertEqual(self.patch_track("background", volume=12.5).status_code, 422)  # whole percents only
        self.assertEqual(self.patch_track("background", duck={"on": True, "level": 4, "fade": 3}).status_code, 422)  # fades 0.1–2 s
        self.assertEqual(self.patch_track("video", volume=50).status_code, 400)

    def test_settings_background_volume_is_the_tracks(self):
        r = self.client.patch(f"/api/projects/{self.pid}/settings", json={"background_volume": 12})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.track(r.json(), "background")["volume"], 12)
        r = self.client.patch(f"/api/projects/{self.pid}/settings", json={"background": "separate"})
        self.assertEqual(self.track(r.json(), "background")["volume"], 100)  # a new mode starts at its own level

    def test_range_and_clip_volumes(self):
        r = self.client.post(f"/api/projects/{self.pid}/timeline/edit", json={"edit": {"op": "volume", "track": "background", "start": 20, "end": 25, "volume": 1}})
        self.assertEqual(r.status_code, 200, r.text)
        pieces = self.track(r.json(), "background")["clips"]
        self.assertEqual([(b["start"], b["end"], b["volume"]) for b in pieces], [(0, 20, 100), (20, 25, 1), (25, 100, 100)])
        self.assertEqual(r.json()["project"]["history"]["undo_label"], "Change volume")
        r = self.client.post(f"/api/projects/{self.pid}/timeline/edit", json={"edit": {
            "op": "set", "clip": pieces[1]["id"], "fields": {"muted": True, "keys": [{"at": 21, "v": 5}, {"at": 23, "v": 60}], "fade_in": 0.3}}})
        self.assertEqual(r.status_code, 200, r.text)
        piece = self.track(r.json(), "background")["clips"][1]
        self.assertEqual((piece["muted"], piece["keys"], piece["fade_in"]), (True, [{"at": 21, "v": 5}, {"at": 23, "v": 60}], 0.3))
        r = self.client.patch(f"/api/projects/{self.pid}/sentences/s1", json={"volume": 37, "muted": True})
        self.assertEqual(r.status_code, 200, r.text)
        s1 = next(s for s in r.json()["project"]["sentences"] if s["id"] == "s1")
        self.assertEqual((s1["volume"], s1["muted"]), (37, True))
        self.assertEqual(self.client.patch(f"/api/projects/{self.pid}/sentences/s1", json={"volume": 0.5}).status_code, 422)


FIXTURE = Path(__file__).parent / "fixtures" / "volume_parity.json"


def parity_projects() -> list[tuple[dict, bool]]:
    """Projects with every kind of volume (and whether the voice-free stem is ready)."""
    cases = []
    # 1. duck mode: track and clip volumes, a volume line, mute, the original voice kept, fades, a
    #    skipped part, ducking on both tracks, music with a line and fades, voice clips of every kind
    voice = [voiced(sentence("s1", 3, 6), 2.5), voiced(sentence("s2", 6.3, 8), 1.2), voiced(sentence("s3", 32, 35), 2.0),
             voiced(sentence("s4", 45, 50), 6.0), voiced(sentence("s5", 70, 72), 1.5), voiced(sentence("s6", 85, 88), 2.0),
             sentence("s7", 90, 92)]
    p = project(level=0.3, voice=voice)
    v = timeline.clips(p, "video")[0]
    timeline.split_at(p, v, 30)
    timeline.split_at(p, timeline.clips(p, "video")[1], 40)
    timeline.set_skipped(p, [timeline.clips(p, "video")[1]["id"]], True)
    timeline.volume_range(p, "background", 0, 10, 80)
    timeline.volume_range(p, "background", 10, 20, 100)
    timeline.volume_range(p, "background", 50, 55, 100)
    timeline.volume_range(p, "background", 60, 65, 120)
    bg = {round(b["start"]): b for b in timeline.clips(p, "background")}
    timeline.set_props(p, bg[10]["id"], {"keys": [{"at": 12, "v": 50}, {"at": 18, "v": 150}]})
    timeline.set_props(p, bg[50]["id"], {"muted": True})
    timeline.set_props(p, bg[60]["id"], {"keep_voice": True, "fade_in": 0.7})
    timeline.track(p, "background")["duck"] = {"on": True, "level": 5, "fade": 0.4}
    with_music(p, start=5, end=80, volume=70, fade_in=1.5, fade_out=2.3)
    music = timeline.find(p, "a1")[1]
    music["keys"] = [{"at": 20, "v": 100}, {"at": 22.5, "v": 30}, {"at": 60, "v": 30}, {"at": 61, "v": 180}]
    timeline.track(p, "audio").update(volume=90, duck={"on": True, "level": 20, "fade": 0.25})
    timeline.track(p, "voice")["volume"] = 80
    s4 = timeline.find(p, "s4")[1]
    s4.update(keys=[{"at": 0, "v": 0}, {"at": 1, "v": 100}], fade_out=0.5)
    timeline.find(p, "s5")[1]["muted"] = True
    timeline.find(p, "s6")[1]["volume"] = 0
    timeline.find(p, "s2")[1]["fade_in"] = 0.3
    cases.append((p, False))
    # 2. separate mode with the voice removed: the stem, the original voice kept in one part, ducked
    p = project("separate", 0.8, voice=[voiced(sentence("s1", 10, 14), 3.0)])
    timeline.volume_range(p, "background", 20, 30, 100)
    timeline.set_props(p, {round(b["start"]): b for b in timeline.clips(p, "background")}[20]["id"], {"keep_voice": True})
    timeline.track(p, "background")["duck"] = {"on": True, "level": 25, "fade": 1.2}
    cases.append((p, True))
    return cases


def parity_cases() -> list[dict]:
    """How loud each file and voice clip plays in the parity projects. The browser's maths (frontend
    lib/timeline.js) is checked against the same numbers: frontend/tests/timeline.test.js. Write the
    file again with UPDATE_FIXTURES=1 after changing the maths (on both sides)."""
    out = []
    for p, stem_ready in parity_projects():
        plan = render.plan(p, stem_ready=stem_ready)
        skipped = timeline.skipped_ranges(p)
        edges = [x for r in skipped for x in (r["start"], r["end"])]
        streams = sorted({(r["media"], r["stream"]) for r in plan["sound"]})
        levels = []
        for i in range(1, 1620):
            t = round(i * 0.0617, 4)
            if t >= timeline.end(p) or timeline.inside(t, t, skipped) or any(abs(t - e) < 0.02 for e in edges):
                continue
            at = timeline.output_time(t, skipped)
            for media_id, stream in streams:
                levels.append([t, media_id, stream, level(plan, at, media_id, stream)])
        gains = []
        volume_pct = plan["voice_volume"]
        for s in sentences.items(p):
            if not s["audio_duration"]:
                continue
            slot = s["end"] - s["start"]
            plays, cut = min(s["audio_duration"], slot), s["audio_duration"] > slot
            for local in np.arange(0, plays, 0.0371):
                g = float(render.voice_gains(s, np.array([local]), plays, cut)[0]) * volume_pct / 100
                gains.append([s["id"], round(float(local), 4), plays, cut, g])
        view = [{**s, "audio_url": f"/clips/{s['id']}.wav" if sentences.has_clip(s) else None} for s in sentences.items(p)]
        out.append({"timeline": p["timeline"], "sentences": view, "settings": p["settings"], "stem_ready": stem_ready,
                    "speech": render.speech(p, timeline.kept_ranges(skipped, timeline.end(p)), skipped), "levels": levels, "voice": gains})
    return out


class Parity(unittest.TestCase):
    def test_fixture_is_up_to_date(self):
        cases = json.loads(json.dumps(parity_cases()))
        if os.environ.get("UPDATE_FIXTURES"):
            FIXTURE.write_text(json.dumps({"cases": cases}, ensure_ascii=False, indent=None, separators=(",", ":")), "utf-8")
        stored = json.loads(FIXTURE.read_text("utf-8"))["cases"]
        self.assertEqual(len(stored), len(cases))
        for got, want in zip(cases, stored):
            self.assertEqual(got["timeline"], want["timeline"])
            self.assertEqual(len(got["levels"]), len(want["levels"]))
            for a, b in zip(got["levels"], want["levels"]):
                self.assertEqual(a[:3], b[:3])
                self.assertAlmostEqual(a[3], b[3], places=12)
            for a, b in zip(got["voice"], want["voice"]):
                self.assertAlmostEqual(a[4], b[4], places=12)

    def test_cases_cover_what_they_should(self):
        duck, separate = parity_cases()
        # s3 is in the skipped part, s5 muted, s6 at 0 %, s7 not voiced; s4 is cut at its slot's end
        self.assertEqual(np.round(duck["speech"], 6).tolist(), [[3, 5.5], [6.3, 7.5], [35, 40]])
        sound = render.plan(parity_projects()[0][0])["sound"]
        ducks = {r["track"]: np.round(r["duck"]["spans"], 6).tolist() for r in sound if r["duck"]}
        self.assertEqual(ducks["background"], [[3, 7.5], [35, 40]])  # 0.8 s apart: less than its two fades and the hold
        self.assertEqual(ducks["audio"], [[3, 5.5], [6.3, 7.5], [35, 40]])  # shorter fades: back up in between
        self.assertTrue(any(x[3] > 1 for x in duck["levels"]))  # a boost above 100 %
        self.assertTrue(any(0 < x[3] < 0.02 for x in duck["levels"]))  # ducked low
        self.assertTrue({x[2] for x in separate["levels"]} == {"original", "stem"})


@unittest.skipUnless(config.FFMPEG, "needs FFmpeg")
class Export(unittest.TestCase):
    """The exported sound is as loud as the plan says, moment by moment (what the preview plays)."""

    @classmethod
    def setUpClass(cls):
        cls.dir = tempfile.TemporaryDirectory()
        d = Path(cls.dir.name)
        cls.video = d / "source.mp4"  # a steady 300 Hz tone, 1/8 loud, in stereo
        media.ffmpeg("-f", "lavfi", "-i", "color=c=gray:s=160x120:r=30:d=6", "-f", "lavfi", "-i", "sine=f=300:r=48000:d=6", "-ac", 2, "-t", 6,
                     "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "256k", cls.video, what="test video")
        cls.info = {**media.probe(cls.video), "file": "source.mp4"}
        cls.voice = media.write_wav(d / "voice.wav", np.zeros(6 * media.VOICE_RATE, dtype=np.int16))  # the voice itself is silent here
        raw = subprocess.run([config.FFMPEG, "-v", "error", "-i", str(cls.video), "-vn", "-f", "f32le", "-"], capture_output=True).stdout
        cls.tone = float(np.sqrt((np.frombuffer(raw, np.float32).reshape(-1, 2)[48000:240000] ** 2).mean()))

    @classmethod
    def tearDownClass(cls):
        cls.dir.cleanup()

    def export(self, p, name):
        out = Path(self.dir.name) / name
        merge.render_video(render.plan(p), {"source": self.video}, self.info, self.voice, p["settings"], out)
        raw = subprocess.run([config.FFMPEG, "-v", "error", "-i", str(out), "-vn", "-f", "f32le", "-"], capture_output=True).stdout
        return np.frombuffer(raw, np.float32).reshape(-1, 2)

    def rms(self, sound, a, b):
        return np.sqrt((sound[int(a * 48000):int(b * 48000)] ** 2).mean(axis=0)) / self.tone

    def test_one_percent(self):
        p = project_v3({"sentences": [], "settings": {"background": "duck", "background_volume": 0.01}, "original_gaps": [], "next_id": 1}, video=self.info)
        sound = self.export(p, "one.mp4")
        for side in self.rms(sound, 1, 5):
            self.assertAlmostEqual(side, 0.01, delta=0.0005)

    def test_ducked(self):
        s1 = voiced(sentence("s1", 2, 4), 1.5)  # speaks 2–3.5
        p = project_v3({"sentences": [s1], "settings": {"background": "duck", "background_volume": 0.3}, "original_gaps": [], "next_id": 2}, video=self.info)
        timeline.track(p, "background")["duck"] = {"on": True, "level": 5, "fade": 0.5}
        sound = self.export(p, "ducked.mp4")
        for (a, b), want in (((0.5, 1.4), 0.30), ((2.05, 3.45), 0.05), ((4.1, 5.5), 0.30)):
            for side in self.rms(sound, a, b):
                self.assertAlmostEqual(side, want, delta=want * 0.03, msg=f"{a}–{b}")
        # the ramp down is where the plan has it (the envelope isn't late or early)
        steps = [float(self.rms(sound, t - 0.01, t + 0.01).mean()) for t in np.arange(1.4, 2.1, 0.01)]
        half = 1.4 + 0.01 * next(i for i, v in enumerate(steps) if v < 0.175)
        self.assertAlmostEqual(half, 1.75, delta=0.02)


if __name__ == "__main__":
    unittest.main()
