---
name: dayone-to-obsidian
description: Safely import Day One journals and media into Obsidian, then install and configure a Day One-like journal, calendar, and quick-capture experience. Use for Day One migration or making a dedicated Obsidian journal feel familiar; do not use for unrelated Obsidian setup.
---

# Day One to Obsidian

Move the history, preserve the habit. Imported entries keep useful Day One metadata, while new entries require only writing. The bundled companion plugin derives dates, previews, photos, and location presentation from ordinary Markdown.

## Safety and consent

- Never write to Day One's database or media directories.
- Do not print journal prose while discovering or planning.
- Prefer an official Day One JSON export ZIP with fully downloaded media. The local macOS database is a version-sensitive fallback.
- Dry-run the import and vault setup before changing anything. Both scripts back up affected files when applied.
- If more than one plausible vault exists, ask one destination question. Treat an explicit request to migrate and configure the chosen vault as authorization for both changes.
- If originals are missing, stop unless the user explicitly accepts a text-first import with those files omitted.
- Merge imported UUID-delimited blocks; never overwrite unrelated note content or configuration keys.
- Never require new-note metadata such as title, tags, mood, weather, or location.

## Workflow

1. Locate the Day One source and Obsidian vault. Inspect counts and paths, not prose.
2. Read [references/migration.md](references/migration.md), then run:

   ```bash
   python3 scripts/dayone_import.py preflight --source /path/to/Journal.zip --vault /path/to/vault
   python3 scripts/dayone_import.py import --source /path/to/Journal.zip --vault /path/to/vault
   python3 scripts/setup_obsidian.py --vault /path/to/vault
   ```

   Omit `--source` on macOS only when intentionally using the detected local database.
3. Report entries, days, multiple-entry days, media, missing originals, collisions, and planned configuration files. Ask only for unresolved destination or missing-media consent.
4. Apply the import, using `--allow-missing-media` only after explicit acceptance:

   ```bash
   python3 scripts/dayone_import.py import --source /path/to/Journal.zip --vault /path/to/vault --apply
   python3 scripts/setup_obsidian.py --vault /path/to/vault --apply
   ```

5. Rerun both commands without `--apply`. A completed migration skips every imported UUID, and setup reports `already_ready: true`.
6. Open the vault in Obsidian when requested. The enabled companion plugin opens its Day One-like shell at startup; no manual theme or plugin steps should remain.

## Result

- One `daily/YYYY-MM-DD.md` note per local calendar day.
- Multiple entries stay separate and chronological.
- Timeline cards target the exact entry; multi-entry dates show counts and gain a time switcher plus `+ New` inside the daily note.
- Imported metadata is preserved compactly; the plugin presents it rather than asking the user to manage it.
- Daily Notes uses a minimal `## Journal` template.
- `Cmd/Ctrl+Shift+J` opens Quick Capture and appends a timestamped entry.
- List, photo, map, and interactive calendar views lead into Obsidian's normal Markdown editor.
- Phones use a touch-first timeline, photo calendar, bottom journal navigation, full-width editor, and safe-area-aware capture sheet.
- The first embedded image supplies calendar artwork. Missing remote originals remain explicitly reported.

In the handoff, give the source, vault, entry/day/media totals, missing items, backup paths, verification result, and whether Obsidian was opened. Never quote private journal content.
