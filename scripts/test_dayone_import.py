#!/usr/bin/env python3

import importlib.util
import json
import pathlib
import tempfile
import unittest
import zipfile
from unittest import mock


MODULE_PATH = pathlib.Path(__file__).with_name("dayone_import.py")
SPEC = importlib.util.spec_from_file_location("dayone_import", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
import sys
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class ImportTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.vault = self.root / "vault"
        (self.vault / ".obsidian").mkdir(parents=True)
        (self.vault / ".obsidian/daily-notes.json").write_text(json.dumps({"folder": "daily"}))
        (self.vault / "daily").mkdir()
        (self.vault / "daily/2026-09-08.md").write_text("## Work\n\nExisting work.\n")
        self.export = self.root / "Journal.zip"
        payload = {
            "entries": [
                {"uuid": "ONE", "creationDate": "2026-09-08T16:30:00Z", "timeZone": "America/Los_Angeles", "text": "Morning.\n\n![](dayone-moment://PHOTO1)", "tags": ["personal"], "photos": [{"identifier": "PHOTO1", "md5": "abc", "type": "jpeg"}]},
                {"uuid": "TWO", "creationDate": "2026-09-08T23:45:00Z", "timeZone": "America/Los_Angeles", "text": "Evening."},
            ]
        }
        with zipfile.ZipFile(self.export, "w") as zf:
            zf.writestr("Journal.json", json.dumps(payload))
            zf.writestr("photos/abc.jpeg", b"image-data")

    def tearDown(self):
        self.temp.cleanup()

    def test_preflight_and_dry_run_do_not_write(self):
        before = (self.vault / "daily/2026-09-08.md").read_bytes()
        source = MODULE.load_source(str(self.export))
        try:
            plan = MODULE.build_plan(source, self.vault, None, "journal-assets/dayone", False)
        finally:
            source.close()
        self.assertEqual(plan["entries"], 2)
        self.assertEqual(plan["calendar_days"], 1)
        self.assertEqual(plan["multiple_entry_days"], 1)
        self.assertEqual(plan["missing_media"], 0)
        self.assertEqual(plan["notes_modified"], 1)
        self.assertEqual(before, (self.vault / "daily/2026-09-08.md").read_bytes())
        self.assertFalse((self.vault / "journal-assets").exists())

    def test_apply_preserves_existing_content_and_is_idempotent(self):
        source = MODULE.load_source(str(self.export))
        try:
            with mock.patch.object(MODULE.pathlib.Path, "home", return_value=self.root):
                report = MODULE.apply_import(source, self.vault, None, "journal-assets/dayone", False)
        finally:
            source.close()
        note = (self.vault / "daily/2026-09-08.md").read_text()
        self.assertIn("Existing work.", note)
        self.assertIn("## Journal", note)
        self.assertEqual(note.count("dayone-entry:ONE:start"), 1)
        self.assertEqual(note.count("dayone-entry:TWO:start"), 1)
        self.assertIn("![[journal-assets/dayone/abc.jpeg]]", note)
        self.assertEqual((self.vault / "journal-assets/dayone/abc.jpeg").read_bytes(), b"image-data")
        self.assertTrue(pathlib.Path(report["backup"]).joinpath("report.json").exists())
        source = MODULE.load_source(str(self.export))
        try:
            plan = MODULE.build_plan(source, self.vault, None, "journal-assets/dayone", False)
        finally:
            source.close()
        self.assertEqual(plan["notes_modified"], 0)
        self.assertEqual(plan["entries_skipped"], 2)

    def test_missing_media_blocks_apply(self):
        broken = self.root / "Broken.zip"
        payload = {"entries": [{"uuid": "X", "creationDate": "2026-09-09T12:00:00Z", "text": "![](dayone-moment://MISSING)", "photos": [{"identifier": "MISSING", "md5": "missing", "type": "jpeg"}]}]}
        with zipfile.ZipFile(broken, "w") as zf:
            zf.writestr("Journal.json", json.dumps(payload))
        code = MODULE.main(["import", "--source", str(broken), "--vault", str(self.vault), "--apply"])
        self.assertEqual(code, 3)
        self.assertFalse((self.vault / "daily/2026-09-09.md").exists())


if __name__ == "__main__":
    unittest.main()
