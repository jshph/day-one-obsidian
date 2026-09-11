# Day One to Obsidian

Import a Day One journal into a dedicated Obsidian vault, then make Obsidian feel familiar: journal rail, entry list, photo browser, location history, interactive calendar, clean reading layout, and quick capture.

Your journal remains ordinary local Markdown. Imported metadata is preserved, but new entries require no forms or frontmatter—just write.

## Use it with an agent

Install this repository as a Codex skill, or give its URL to a coding agent and say:

> Use the Day One to Obsidian skill to import my Day One journal into a new Obsidian vault, install the companion experience, verify it, and open the vault.

The agent will:

1. Find an official Day One JSON export, or use the local macOS database as a fallback.
2. Report entry and media counts without printing private journal text.
3. Dry-run the migration and ask only when the destination is ambiguous or original media is missing.
4. Import entries into `daily/YYYY-MM-DD.md` notes without overwriting unrelated content.
5. Install and enable the bundled Obsidian companion plugin and configure Daily Notes, attachments, system appearance, and the blue accent.
6. Rerun both tools to verify that the result is idempotent, then open Obsidian.

Backups and reports are written beneath `~/.dayone-to-obsidian/backups/`.

## What everyday use feels like

- Open **Today** and write.
- Press `Cmd/Ctrl+Shift+J` for Quick Capture.
- Use the list, photos, map, or calendar to browse.
- Click an existing calendar date to open it; click an empty date to create it.
- The first image in a note becomes its calendar thumbnail.
- New notes never require title, tags, mood, weather, or location metadata.

Remote-only attachment records, encrypted placeholders, and unsupported rich text are reported rather than silently invented or discarded.

## Manual commands

The scripts are dry-run by default:

```bash
python3 scripts/dayone_import.py preflight --source /path/to/Journal.zip --vault /path/to/vault
python3 scripts/dayone_import.py import --source /path/to/Journal.zip --vault /path/to/vault
python3 scripts/setup_obsidian.py --vault /path/to/vault
```

After reviewing the plans:

```bash
python3 scripts/dayone_import.py import --source /path/to/Journal.zip --vault /path/to/vault --apply
python3 scripts/setup_obsidian.py --vault /path/to/vault --apply
```

Omit `--source` on macOS to use Day One's local database. Add `--allow-missing-media` only when you explicitly accept importing text while unavailable originals remain omitted.

## Develop the companion plugin

```bash
npm install
npm run build
python3 -m unittest discover -s scripts -p 'test_*.py'
```

`main.js`, `manifest.json`, and `styles.css` are committed so the installer does not require Node.js on the destination Mac.

## License

[MIT](LICENSE)

Day One is a trademark of Bloom Built, Inc. This independent project is not affiliated with or endorsed by Bloom Built or Obsidian.
