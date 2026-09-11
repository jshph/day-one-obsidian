import json
import pathlib
import subprocess
import tempfile
import unittest


SCRIPT = pathlib.Path(__file__).with_name("setup_obsidian.py")


class SetupObsidianTests(unittest.TestCase):
    def test_setup_is_preserving_and_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            vault = pathlib.Path(directory) / "Journal"
            obsidian = vault / ".obsidian"
            obsidian.mkdir(parents=True)
            (obsidian / "appearance.json").write_text('{"cssTheme":"My Theme"}\n', encoding="utf-8")
            (obsidian / "community-plugins.json").write_text('["existing-plugin"]\n', encoding="utf-8")

            first = subprocess.run(
                ["python3", str(SCRIPT), "--vault", str(vault), "--apply"],
                check=True, capture_output=True, text=True,
            )
            self.assertIn('"applied": true', first.stdout)
            community = json.loads((obsidian / "community-plugins.json").read_text(encoding="utf-8"))
            self.assertEqual(community, ["existing-plugin", "day-one-shell"])
            appearance = json.loads((obsidian / "appearance.json").read_text(encoding="utf-8"))
            self.assertEqual(appearance["cssTheme"], "My Theme")
            self.assertEqual(appearance["theme"], "system")
            self.assertTrue((obsidian / "plugins/day-one-shell/main.js").is_file())
            self.assertEqual((vault / "Templates/Daily Journal.md").read_text(encoding="utf-8"), "## Journal\n")

            second = subprocess.run(
                ["python3", str(SCRIPT), "--vault", str(vault)],
                check=True, capture_output=True, text=True,
            )
            self.assertTrue(json.loads(second.stdout)["already_ready"])


if __name__ == "__main__":
    unittest.main()
