#!/usr/bin/env python3
"""Plan or install the Day One companion experience into an Obsidian vault."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pathlib
import shutil
import sys
from typing import Any


ROOT = pathlib.Path(__file__).resolve().parent.parent
PLUGIN_ID = "day-one-shell"
PLUGIN_FILES = ("main.js", "manifest.json", "styles.css")


def load_json(path: pathlib.Path, default: Any) -> Any:
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def write_atomic(path: pathlib.Path, value: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".dayone-tmp")
    temporary.write_text(value, encoding="utf-8")
    os.replace(temporary, path)


def json_text(value: Any) -> str:
    return json.dumps(value, indent=2, ensure_ascii=False) + "\n"


def enable_core_plugin(config: Any, plugin: str) -> Any:
    if isinstance(config, list):
        return config if plugin in config else [*config, plugin]
    if isinstance(config, dict):
        return {**config, plugin: True}
    raise ValueError("core-plugins.json must contain an object or array")


def merged_configuration(vault: pathlib.Path, daily_folder: str, template: str) -> dict[pathlib.Path, str]:
    obsidian = vault / ".obsidian"
    community_path = obsidian / "community-plugins.json"
    community = load_json(community_path, [])
    if not isinstance(community, list):
        raise ValueError("community-plugins.json must contain an array")
    if PLUGIN_ID not in community:
        community.append(PLUGIN_ID)

    core_path = obsidian / "core-plugins.json"
    core = enable_core_plugin(load_json(core_path, {}), "daily-notes")

    daily_path = obsidian / "daily-notes.json"
    daily = load_json(daily_path, {})
    if not isinstance(daily, dict):
        raise ValueError("daily-notes.json must contain an object")
    daily = {**daily, "folder": daily_folder, "format": "YYYY-MM-DD", "template": template.removesuffix(".md")}

    appearance_path = obsidian / "appearance.json"
    appearance = load_json(appearance_path, {})
    if not isinstance(appearance, dict):
        raise ValueError("appearance.json must contain an object")
    appearance = {**appearance, "theme": "system", "accentColor": "#42b8f5"}

    app_path = obsidian / "app.json"
    app = load_json(app_path, {})
    if not isinstance(app, dict):
        raise ValueError("app.json must contain an object")
    app = {
        **app,
        "attachmentFolderPath": "journal-assets",
        "defaultViewMode": "source",
        "livePreview": True,
        "propertiesInDocument": "hidden",
        "readableLineLength": True,
    }

    template_path = vault / pathlib.PurePosixPath(template)
    if template_path.suffix.lower() != ".md":
        template_path = template_path.with_suffix(".md")
    existing_template = template_path.read_text(encoding="utf-8") if template_path.exists() else ""
    template_text = existing_template
    if not any(line.strip() == "## Journal" for line in existing_template.splitlines()):
        template_text = existing_template.rstrip() + ("\n\n" if existing_template.strip() else "") + "## Journal\n"

    desired = {
        community_path: json_text(community),
        core_path: json_text(core),
        daily_path: json_text(daily),
        appearance_path: json_text(appearance),
        app_path: json_text(app),
        template_path: template_text,
    }
    plugin_dir = obsidian / "plugins" / PLUGIN_ID
    for name in PLUGIN_FILES:
        source = ROOT / name
        if not source.is_file():
            raise FileNotFoundError(f"bundled plugin file is missing: {source}")
        desired[plugin_dir / name] = source.read_text(encoding="utf-8")
    return desired


def backup_file(path: pathlib.Path, vault: pathlib.Path, backup: pathlib.Path) -> None:
    if not path.exists():
        return
    target = backup / path.relative_to(vault)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(path, target)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--vault", required=True, help="Path to the destination Obsidian vault")
    parser.add_argument("--daily-folder", default="daily", help="Vault-relative daily-note folder")
    parser.add_argument("--template", default="Templates/Daily Journal.md", help="Vault-relative daily-note template")
    parser.add_argument("--apply", action="store_true", help="Write changes; default is a dry-run plan")
    args = parser.parse_args(argv)

    vault = pathlib.Path(args.vault).expanduser().resolve()
    if not (vault / ".obsidian").is_dir():
        print(f"error: not an Obsidian vault: {vault}", file=sys.stderr)
        return 2
    if pathlib.PurePosixPath(args.daily_folder).is_absolute() or ".." in pathlib.PurePosixPath(args.daily_folder).parts:
        print("error: --daily-folder must be a safe vault-relative path", file=sys.stderr)
        return 2
    if pathlib.PurePosixPath(args.template).is_absolute() or ".." in pathlib.PurePosixPath(args.template).parts:
        print("error: --template must be a safe vault-relative path", file=sys.stderr)
        return 2

    try:
        desired = merged_configuration(vault, args.daily_folder, args.template)
    except (ValueError, OSError, json.JSONDecodeError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 2

    changes = [path for path, content in desired.items() if not path.exists() or path.read_text(encoding="utf-8") != content]
    plan = {
        "vault": str(vault),
        "plugin": PLUGIN_ID,
        "changes": [str(path.relative_to(vault)) for path in changes],
        "already_ready": not changes,
        "restart_required": bool(changes),
    }
    print(json_text(plan), end="")
    if not args.apply or not changes:
        return 0

    timestamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    backup = pathlib.Path.home() / ".dayone-to-obsidian" / "backups" / vault.name / f"setup-{timestamp}"
    backup.mkdir(parents=True, exist_ok=False)
    for path in changes:
        backup_file(path, vault, backup)
        write_atomic(path, desired[path])
    report = {**plan, "backup": str(backup), "applied": True}
    (backup / "report.json").write_text(json_text(report), encoding="utf-8")
    print(json_text(report), end="")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
