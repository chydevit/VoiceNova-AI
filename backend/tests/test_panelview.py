"""The editor's panel layout (panelview.py, api_view.py): saved per project, never an edit.

Run from the backend folder:  .venv/bin/python -m unittest discover -s tests -t .
"""
import json
import shutil
import tempfile
import unittest
from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import JSONResponse
from fastapi.testclient import TestClient

import api_view
import config
import store
import views
from errors import AppError

VIEW = {"mode": "collapsed", "height": 420, "follow": False, "hide_empty": True, "sheet": "expanded",
        "tracks": {"voice": {"collapsed": False, "height": 120}, "audio": {"collapsed": True, "height": None}}}


class PanelView(unittest.TestCase):
    def setUp(self):
        self.data = Path(tempfile.mkdtemp(prefix="kva-data-"))
        self._old = (config.DATA_DIR, config.PROJECTS_DIR)
        config.DATA_DIR, config.PROJECTS_DIR = self.data, self.data / "projects"
        config.PROJECTS_DIR.mkdir(parents=True)
        app = FastAPI()

        @app.exception_handler(AppError)
        async def app_error(_req, err: AppError):
            return JSONResponse({"error": err.to_dict()}, status_code=err.status)

        app.include_router(api_view.router)
        self.client = TestClient(app)
        self.pid = store.create("clip.mp4")["id"]

    def tearDown(self):
        config.DATA_DIR, config.PROJECTS_DIR = self._old
        shutil.rmtree(self.data, ignore_errors=True)

    def test_saved_with_the_project_but_not_an_edit(self):
        before = store.load(self.pid)
        self.assertIsNone(views.public(before)["view"])  # nothing saved yet: the editor's defaults
        res = self.client.put(f"/api/projects/{self.pid}/view", json=VIEW)
        self.assertEqual(res.status_code, 200, res.text)
        after = store.load(self.pid)
        self.assertEqual(views.public(after)["view"], VIEW)
        self.assertEqual(after["rev"], before["rev"])  # no new revision
        self.assertEqual(after["updated_at"], before["updated_at"])  # not "edited just now"
        self.assertEqual(after["history"], before["history"])  # no undo step
        self.assertNotIn("view", json.loads((store.project_dir(self.pid) / "project.json").read_text()))

    def test_defaults_and_checks(self):
        res = self.client.put(f"/api/projects/{self.pid}/view", json={})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(views.public(store.load(self.pid))["view"]["mode"], "open")
        for bad in ({"mode": "huge"}, {"height": 5}, {"sheet": "half"}, {"tracks": {"voice": {"height": 900}}}, {"zoom": 2},
                    {"tracks": {"voice": {"collapsed": True, "color": "red"}}}):
            with self.subTest(bad=bad):
                self.assertEqual(self.client.put(f"/api/projects/{self.pid}/view", json=bad).status_code, 422)

    def test_unknown_project(self):
        self.assertEqual(self.client.put("/api/projects/nope123/view", json=VIEW).status_code, 404)
        self.assertEqual(self.client.put("/api/projects/../x/view", json=VIEW).status_code, 404)


if __name__ == "__main__":
    unittest.main()
