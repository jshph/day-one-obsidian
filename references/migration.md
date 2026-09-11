# Migration mechanics

Read this before applying an import.

## Source choice

An official Day One JSON ZIP is the preferred source because it is portable and normally packages metadata with media. On macOS, `File > Export > JSON` creates it. Ensure media is included and fully downloaded.

Current official guide: https://dayoneapp.com/guides/tips-and-tutorials/exporting-entries/

The direct-store fallback is usually:

`~/Library/Group Containers/5U8NS4GX82.dayoneapp2/Data/Documents/DayOne.sqlite`

The importer snapshots the live SQLite store through SQLite's backup API so WAL state is included. Core Data table and relationship names can change; the script discovers tag relationships rather than assuming a fixed join-table number. Database mode should still be treated as a best-effort adapter and verified against Day One counts.

Day One MCP is useful for conversational access and spot checks, not as the primary bulk-transfer format. It requires explicit journal grants and may not expose all export metadata or local media state.

Current MCP guide: https://dayoneapp.com/guides/day-one-for-mac/day-one-mcp-server/

## Commands

```bash
python3 scripts/dayone_import.py preflight --source /path/to/Journal.zip --vault /path/to/vault
python3 scripts/dayone_import.py import --source /path/to/Journal.zip --vault /path/to/vault
python3 scripts/dayone_import.py import --source /path/to/Journal.zip --vault /path/to/vault --apply
```

Omit `--source` on macOS to use the detected local Day One database. Dry-run is the default; `--apply` is required to write.

Useful overrides:

- `--daily-folder`: override the vault's Daily Notes folder.
- `--assets-folder`: default `journal-assets/dayone`.
- `--allow-missing-media`: apply text even when originals are unavailable. Use only after the user explicitly accepts that loss.
- `--replace-existing`: replace UUID-delimited blocks previously created by this importer. Ordinary reruns skip them.

## Required checks

- Compare source entry and attachment counts with Day One or the export dialog.
- Confirm every attachment has a full original, not merely a thumbnail.
- Confirm grouping uses Day One's local calendar date. Database mode uses stored Gregorian fields when present.
- Inspect planned note collisions. Existing files are merged, never overwritten wholesale.
- Confirm every source UUID is either planned for insertion or already present.
- Confirm copied-media hashes when a destination filename already exists.
- Preserve the original export ZIP and generated backup/report until the user reviews the result.

## Unsupported or ambiguous data

Do not invent conversions for opaque rich-text payloads, encrypted placeholder entries, book data, comments/reactions, or remote-only attachments. Report them. If a JSON entry has no Markdown `text`, retain its identity in the report and stop before claiming a complete migration.
