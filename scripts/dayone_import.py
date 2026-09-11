#!/usr/bin/env python3
"""Plan and perform a conservative Day One -> Obsidian daily-note import."""

from __future__ import annotations

import argparse
import collections
import contextlib
import dataclasses
import datetime as dt
import hashlib
import json
import mimetypes
import os
import pathlib
import plistlib
import re
import shutil
import sqlite3
import sys
import tempfile
import zipfile
from typing import Any, Iterator


APPLE_EPOCH = 978307200
DEFAULT_DB = pathlib.Path.home() / "Library/Group Containers/5U8NS4GX82.dayoneapp2/Data/Documents/DayOne.sqlite"
START = "<!-- dayone-entry:{uuid}:start -->"
END = "<!-- dayone-entry:{uuid}:end -->"
MOMENT_RE = re.compile(r"!\[\]\(dayone-moment:(?://)?(?:photo/|video/|audio/|pdf/)?([^)]+)\)", re.I)


@dataclasses.dataclass
class Media:
    identifier: str
    digest: str
    extension: str
    kind: str
    locator: str | None

    @property
    def filename(self) -> str:
        stem = self.digest or self.identifier.lower() or "attachment"
        ext = self.extension.lower().lstrip(".") or "bin"
        return f"{stem}.{ext}"


@dataclasses.dataclass
class Entry:
    uuid: str
    local_date: dt.date
    local_time: str | None
    sort_key: str
    text: str
    journal: str | None
    tags: list[str]
    location: str | None
    weather: str | None
    starred: bool
    media: list[Media]
    unsupported_rich_text: bool = False


@dataclasses.dataclass
class Source:
    path: pathlib.Path
    kind: str
    entries: list[Entry]
    zip_file: zipfile.ZipFile | None = None

    def close(self) -> None:
        if self.zip_file:
            self.zip_file.close()

    def copy_media(self, media: Media, destination: pathlib.Path) -> None:
        if not media.locator:
            raise FileNotFoundError(media.filename)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if self.zip_file:
            with self.zip_file.open(media.locator) as src, open(destination, "wb") as out:
                shutil.copyfileobj(src, out)
        else:
            shutil.copy2(media.locator, destination)


def scalar(value: Any) -> str | None:
    return str(value).strip() if value is not None and str(value).strip() else None


def safe_ext(value: Any, fallback: str = "bin") -> str:
    ext = re.sub(r"[^A-Za-z0-9]", "", scalar(value) or "").lower()
    return ext or fallback


def parse_iso(value: str) -> dt.datetime:
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def json_local_datetime(item: dict[str, Any]) -> dt.datetime:
    created = parse_iso(item["creationDate"])
    zone_name = scalar(item.get("timeZone"))
    if zone_name:
        try:
            from zoneinfo import ZoneInfo
            return created.astimezone(ZoneInfo(zone_name))
        except Exception:
            pass
    offset = item.get("creationDeviceTimeZoneOffset")
    if isinstance(offset, (int, float)):
        return created.astimezone(dt.timezone(dt.timedelta(seconds=float(offset))))
    return created.astimezone()


def location_text(value: Any) -> str | None:
    if not isinstance(value, dict):
        return None
    parts = []
    for key in ("placeName", "localityName", "administrativeArea", "country"):
        part = scalar(value.get(key))
        if part and part not in parts:
            parts.append(part)
    if parts:
        return ", ".join(parts)
    lat, lon = value.get("latitude"), value.get("longitude")
    if isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
        return f"{lat:.6f}, {lon:.6f}"
    return None


def weather_text(value: Any) -> str | None:
    if not isinstance(value, dict):
        return None
    description = scalar(value.get("conditionsDescription") or value.get("weatherCode"))
    temp = value.get("temperatureCelsius")
    if isinstance(temp, (int, float)):
        return f"{description + ', ' if description else ''}{temp:g}°C"
    return description


def choose_export_json(zf: zipfile.ZipFile) -> tuple[str, dict[str, Any]]:
    candidates = [n for n in zf.namelist() if n.lower().endswith(".json") and not n.endswith("/")]
    for name in sorted(candidates, key=lambda n: zf.getinfo(n).file_size, reverse=True):
        try:
            data = json.loads(zf.read(name))
            if isinstance(data, dict) and isinstance(data.get("entries"), list):
                return name, data
        except Exception:
            continue
    raise ValueError("No Day One entries JSON found in ZIP")


def build_zip_index(zf: zipfile.ZipFile) -> dict[str, str]:
    result: dict[str, str] = {}
    for name in zf.namelist():
        if not name.endswith("/"):
            result.setdefault(pathlib.PurePosixPath(name).name.lower(), name)
    return result


def json_media(item: dict[str, Any], index: dict[str, str] | None, base: pathlib.Path) -> list[Media]:
    result = []
    for key, default_ext in (("photos", "jpeg"), ("videos", "mp4"), ("audios", "m4a"), ("pdfs", "pdf")):
        for raw in item.get(key) or []:
            if not isinstance(raw, dict):
                continue
            identifier = scalar(raw.get("identifier")) or ""
            digest = (scalar(raw.get("md5")) or identifier).lower()
            ext = safe_ext(raw.get("type") or raw.get("format"), default_ext)
            wanted = f"{digest}.{ext}".lower()
            locator = index.get(wanted) if index else None
            if index and not locator:
                locator = next((v for k, v in index.items() if digest and k.startswith(digest + ".")), None)
                if locator:
                    ext = safe_ext(pathlib.PurePosixPath(locator).suffix, ext)
            if index is None:
                matches = list(base.rglob(f"{digest}.*")) if digest else []
                locator = str(matches[0]) if matches else None
                if matches:
                    ext = safe_ext(matches[0].suffix, ext)
            result.append(Media(identifier, digest, ext, key.rstrip("s"), locator))
    return result


def load_json_source(path: pathlib.Path) -> Source:
    zf = zipfile.ZipFile(path) if path.suffix.lower() == ".zip" else None
    if zf:
        _, data = choose_export_json(zf)
        index = build_zip_index(zf)
        base = path.parent
    else:
        data = json.loads(path.read_text(encoding="utf-8"))
        index = None
        base = path.parent
    entries = []
    for number, item in enumerate(data.get("entries") or [], 1):
        if not isinstance(item, dict) or not item.get("creationDate"):
            continue
        local = json_local_datetime(item)
        text = item.get("text") if isinstance(item.get("text"), str) else ""
        uuid = scalar(item.get("uuid")) or f"missing-uuid-{number}"
        journal = scalar(item.get("journal") or item.get("journalName"))
        entries.append(Entry(
            uuid=uuid,
            local_date=local.date(),
            local_time=None if item.get("isAllDay") else local.strftime("%I:%M %p").lstrip("0"),
            sort_key=local.isoformat(),
            text=text,
            journal=journal,
            tags=[str(x) for x in (item.get("tags") or []) if scalar(x)],
            location=location_text(item.get("location")),
            weather=weather_text(item.get("weather")),
            starred=bool(item.get("starred")),
            media=json_media(item, index, base),
            unsupported_rich_text=not bool(text) and bool(item.get("richText")),
        ))
    return Source(path, "json-zip" if zf else "json", entries, zf)


def table_columns(conn: sqlite3.Connection, table: str) -> list[str]:
    return [row[1] for row in conn.execute(f'PRAGMA table_info("{table}")')]


def decode_timezone(blob: Any) -> dt.tzinfo | None:
    if not isinstance(blob, bytes):
        return None
    with contextlib.suppress(Exception):
        obj = plistlib.loads(blob)
        text = str(obj)
        match = re.search(r"[A-Za-z]+/[A-Za-z_+-]+", text)
        if match:
            from zoneinfo import ZoneInfo
            return ZoneInfo(match.group(0))
    return None


def find_db_media(documents: pathlib.Path, digest: str) -> tuple[str | None, str]:
    if not digest:
        return None, "bin"
    for folder in ("DayOnePhotos", "DayOneVideos", "DayOneAudios", "DayOnePDFs"):
        root = documents / folder
        if root.is_dir():
            for match in root.glob(f"{digest}.*"):
                if match.parent.name.lower() != "thumbnails":
                    return str(match), safe_ext(match.suffix)
    return None, "bin"


def load_db_source(path: pathlib.Path) -> Source:
    temp = tempfile.NamedTemporaryFile(prefix="dayone-snapshot-", suffix=".sqlite", delete=False)
    temp.close()
    try:
        src = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        dst = sqlite3.connect(temp.name)
        src.backup(dst)
        src.close(); dst.close()
        conn = sqlite3.connect(temp.name)
        conn.row_factory = sqlite3.Row
        journals = {r["Z_PK"]: r["ZNAME"] for r in conn.execute("SELECT Z_PK,ZNAME FROM ZJOURNAL")}
        tags: dict[int, list[str]] = collections.defaultdict(list)
        tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")]
        for table in tables:
            cols = table_columns(conn, table)
            entry_col = next((c for c in cols if c.endswith("ENTRIES")), None)
            tag_col = next((c for c in cols if c.endswith("TAGS1")), None)
            if entry_col and tag_col:
                query = f'SELECT j."{entry_col}",t.ZNAME FROM "{table}" j JOIN ZTAG t ON t.Z_PK=j."{tag_col}"'
                for entry_pk, name in conn.execute(query):
                    if name:
                        tags[entry_pk].append(name)
        documents = path.parent
        media_by_entry: dict[int, list[Media]] = collections.defaultdict(list)
        for row in conn.execute("SELECT ZENTRY,ZIDENTIFIER,ZMD5,ZTYPE,ZFORMAT FROM ZATTACHMENT"):
            digest = (scalar(row[2]) or "").lower()
            locator, found_ext = find_db_media(documents, digest)
            ext = found_ext if locator else safe_ext(row[4] or row[3])
            media_by_entry[row[0]].append(Media(scalar(row[1]) or "", digest, ext, scalar(row[3]) or "attachment", locator))
        locations = {}
        for r in conn.execute("SELECT * FROM ZLOCATION"):
            locations[r["Z_PK"]] = location_text({
                "placeName": r["ZPLACENAME"], "localityName": r["ZLOCALITYNAME"],
                "administrativeArea": r["ZADMINISTRATIVEAREA"], "country": r["ZCOUNTRY"],
                "latitude": r["ZLATITUDE"], "longitude": r["ZLONGITUDE"],
            })
        weather = {}
        for r in conn.execute("SELECT * FROM ZWEATHER"):
            weather[r["Z_PK"]] = weather_text({"conditionsDescription": r["ZCONDITIONSDESCRIPTION"], "temperatureCelsius": r["ZTEMPERATURECELSIUS"]})
        entries = []
        for n, r in enumerate(conn.execute("SELECT * FROM ZENTRY ORDER BY ZCREATIONDATE"), 1):
            created = dt.datetime.fromtimestamp((r["ZCREATIONDATE"] or 0) + APPLE_EPOCH, tz=dt.timezone.utc)
            zone = decode_timezone(r["ZTIMEZONE"])
            local = created.astimezone(zone or dt.datetime.now().astimezone().tzinfo)
            if r["ZGREGORIANYEAR"] and r["ZGREGORIANMONTH"] and r["ZGREGORIANDAY"]:
                local_date = dt.date(r["ZGREGORIANYEAR"], r["ZGREGORIANMONTH"], r["ZGREGORIANDAY"])
            else:
                local_date = local.date()
            text = r["ZMARKDOWNTEXT"] or ""
            entries.append(Entry(
                uuid=scalar(r["ZUUID"]) or f"missing-uuid-{n}", local_date=local_date,
                local_time=None if r["ZISALLDAY"] else local.strftime("%I:%M %p").lstrip("0"),
                sort_key=created.isoformat(), text=text, journal=scalar(journals.get(r["ZJOURNAL"])),
                tags=tags.get(r["Z_PK"], []), location=locations.get(r["ZLOCATION"]),
                weather=weather.get(r["ZWEATHER"]), starred=bool(r["ZSTARRED"]),
                media=media_by_entry.get(r["Z_PK"], []),
                unsupported_rich_text=not bool(text) and bool(r["ZRICHTEXTJSON"]),
            ))
        conn.close()
        return Source(path, "sqlite-snapshot", entries)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temp.name)


def load_source(path_arg: str | None) -> Source:
    path = pathlib.Path(path_arg).expanduser().resolve() if path_arg else DEFAULT_DB
    if not path.exists():
        raise FileNotFoundError(f"Day One source not found: {path}")
    if path.suffix.lower() in (".zip", ".json"):
        return load_json_source(path)
    return load_db_source(path)


def detect_daily_folder(vault: pathlib.Path, override: str | None) -> pathlib.Path:
    if override:
        return vault / override
    config = vault / ".obsidian/daily-notes.json"
    if config.exists():
        with contextlib.suppress(Exception):
            folder = json.loads(config.read_text()).get("folder")
            if folder:
                return vault / folder
    return vault / "daily"


def daily_note_path(vault: pathlib.Path, daily: pathlib.Path, day: dt.date) -> pathlib.Path:
    config = vault / ".obsidian/daily-notes.json"
    pattern = "YYYY-MM-DD"
    if config.exists():
        with contextlib.suppress(Exception):
            pattern = json.loads(config.read_text()).get("format") or pattern
    substitutions = {"YYYY": f"{day.year:04d}", "MM": f"{day.month:02d}", "DD": f"{day.day:02d}"}
    relative = pattern
    for token, value in substitutions.items():
        relative = relative.replace(token, value)
    if re.search(r"[A-Za-z]", relative):
        raise ValueError(f"Unsupported Daily Notes date format: {pattern}; use --daily-folder with a YYYY-MM-DD layout or extend the importer")
    return daily / f"{relative}.md"


def marker(uuid: str) -> str:
    return START.format(uuid=uuid)


def media_reference_map(entry: Entry, assets_relative: pathlib.PurePosixPath) -> dict[str, str]:
    return {m.identifier.lower(): f"![[{assets_relative / m.filename}]]" for m in entry.media if m.identifier and m.locator}


def render_entry(entry: Entry, assets_relative: pathlib.PurePosixPath) -> str:
    refs = media_reference_map(entry, assets_relative)
    used: set[str] = set()
    def replace(match: re.Match[str]) -> str:
        ident = match.group(1).lower()
        if ident in refs:
            used.add(ident)
            return refs[ident]
        return match.group(0)
    body = MOMENT_RE.sub(replace, entry.text.strip())
    metadata = []
    if entry.journal and entry.journal.lower() != "journal": metadata.append(entry.journal)
    if entry.location: metadata.append(f"📍 {entry.location}")
    if entry.weather: metadata.append(f"🌤 {entry.weather}")
    if entry.tags: metadata.append("🏷 " + ", ".join(entry.tags))
    if entry.starred: metadata.append("★")
    lines = [marker(entry.uuid)]
    if entry.local_time: lines += [f"### {entry.local_time}", ""]
    if metadata: lines += [f"*{' · '.join(metadata)}*", ""]
    if body: lines.append(body)
    for item in entry.media:
        if item.locator and item.identifier.lower() not in used:
            lines += ["", f"![[{assets_relative / item.filename}]]"]
    lines += [END.format(uuid=entry.uuid)]
    return "\n".join(lines).strip()


def replace_or_append(content: str, entry: Entry, block: str, replace_existing: bool) -> tuple[str, str]:
    start = re.escape(marker(entry.uuid)); end = re.escape(END.format(uuid=entry.uuid))
    pattern = re.compile(start + r".*?" + end, re.S)
    if pattern.search(content):
        if replace_existing:
            return pattern.sub(block, content, count=1), "replace"
        return content, "skip"
    if not re.search(r"(?m)^## Journal\s*$", content):
        content = content.rstrip() + ("\n\n" if content.strip() else "") + "## Journal\n"
    return content.rstrip() + "\n\n" + block + "\n", "insert"


def sha256(path: pathlib.Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def build_plan(source: Source, vault: pathlib.Path | None, daily_override: str | None, assets_folder: str, replace_existing: bool) -> dict[str, Any]:
    by_day: dict[dt.date, list[Entry]] = collections.defaultdict(list)
    for entry in source.entries: by_day[entry.local_date].append(entry)
    attachments = [m for e in source.entries for m in e.media]
    plan: dict[str, Any] = {
        "source": str(source.path), "source_kind": source.kind, "entries": len(source.entries),
        "calendar_days": len(by_day), "multiple_entry_days": sum(len(v) > 1 for v in by_day.values()),
        "max_entries_one_day": max((len(v) for v in by_day.values()), default=0),
        "attachments": len(attachments), "attachment_types": dict(collections.Counter(m.kind for m in attachments)),
        "missing_media": sum(not m.locator for m in attachments),
        "empty_markdown_entries": sum(not e.text.strip() for e in source.entries),
        "unsupported_rich_text_entries": sum(e.unsupported_rich_text for e in source.entries),
    }
    if vault:
        daily = detect_daily_folder(vault, daily_override)
        created = modified = skipped = replaced = 0
        for day, entries in by_day.items():
            note = daily_note_path(vault, daily, day)
            content = note.read_text(encoding="utf-8") if note.exists() else ""
            changed = False
            for entry in sorted(entries, key=lambda e: e.sort_key):
                block = render_entry(entry, pathlib.PurePosixPath(assets_folder))
                content, action = replace_or_append(content, entry, block, replace_existing)
                if action == "skip": skipped += 1
                elif action == "replace": replaced += 1; changed = True
                else: changed = True
            if changed:
                if note.exists(): modified += 1
                else: created += 1
        plan.update({"vault": str(vault), "daily_folder": str(daily), "notes_created": created,
                     "notes_modified": modified, "entries_skipped": skipped, "entries_replaced": replaced})
    return plan


def apply_import(source: Source, vault: pathlib.Path, daily_override: str | None, assets_folder: str, replace_existing: bool) -> dict[str, Any]:
    daily = detect_daily_folder(vault, daily_override)
    assets = vault / assets_folder
    timestamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = pathlib.Path.home() / ".dayone-to-obsidian/backups" / vault.name / timestamp
    backup.mkdir(parents=True, exist_ok=False)
    by_day: dict[dt.date, list[Entry]] = collections.defaultdict(list)
    for entry in source.entries: by_day[entry.local_date].append(entry)
    report: dict[str, Any] = {"backup": str(backup), "created_notes": [], "modified_notes": [], "copied_media": [], "skipped_entries": []}
    # Validate destination collisions before changing any note.
    for entry in source.entries:
        for item in entry.media:
            destination = assets / item.filename
            if not item.locator or not destination.exists():
                continue
            if source.zip_file:
                with tempfile.NamedTemporaryFile(delete=False) as tmp:
                    temp_path = pathlib.Path(tmp.name)
                try:
                    source.copy_media(item, temp_path)
                    incoming_hash = sha256(temp_path)
                finally:
                    temp_path.unlink(missing_ok=True)
            else:
                incoming_hash = sha256(pathlib.Path(item.locator))
            if incoming_hash != sha256(destination):
                raise RuntimeError(f"Media collision with different contents: {destination}")
    for day, entries in sorted(by_day.items()):
        note = daily_note_path(vault, daily, day)
        original = note.read_text(encoding="utf-8") if note.exists() else ""
        content = original
        for entry in sorted(entries, key=lambda e: e.sort_key):
            content, action = replace_or_append(content, entry, render_entry(entry, pathlib.PurePosixPath(assets_folder)), replace_existing)
            if action == "skip": report["skipped_entries"].append(entry.uuid)
        if content != original:
            if note.exists():
                relative = note.relative_to(vault)
                target = backup / "notes" / relative
                target.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(note, target)
                report["modified_notes"].append(str(relative))
            else:
                report["created_notes"].append(str(note.relative_to(vault)))
            note.parent.mkdir(parents=True, exist_ok=True)
            temp = note.with_name(note.name + ".dayone-tmp")
            temp.write_text(content, encoding="utf-8"); os.replace(temp, note)
    for entry in source.entries:
        for item in entry.media:
            if not item.locator: continue
            destination = assets / item.filename
            if destination.exists(): continue
            source.copy_media(item, destination)
            report["copied_media"].append(str(destination.relative_to(vault)))
    (backup / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    return report


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="command", required=True)
    for name in ("preflight", "import"):
        q = sub.add_parser(name)
        q.add_argument("--source", help="Day One JSON, ZIP, or SQLite; default is the macOS store")
        q.add_argument("--vault", help="Obsidian vault (required to plan/apply note changes)")
        q.add_argument("--daily-folder", help="Vault-relative daily-note folder; otherwise detect settings")
        q.add_argument("--assets-folder", default="journal-assets/dayone")
        q.add_argument("--replace-existing", action="store_true")
        if name == "import":
            q.add_argument("--apply", action="store_true")
            q.add_argument("--allow-missing-media", action="store_true")
    return p


def main(argv: list[str] | None = None) -> int:
    args = parser().parse_args(argv)
    vault = pathlib.Path(args.vault).expanduser().resolve() if args.vault else None
    if args.command == "import" and not vault:
        print("error: --vault is required for import", file=sys.stderr); return 2
    if vault and not (vault / ".obsidian").is_dir():
        print(f"error: not an Obsidian vault: {vault}", file=sys.stderr); return 2
    source = load_source(args.source)
    try:
        plan = build_plan(source, vault, args.daily_folder, args.assets_folder, args.replace_existing)
        print(json.dumps(plan, indent=2))
        if args.command == "preflight" or not args.apply:
            return 0
        if plan["missing_media"] and not args.allow_missing_media:
            print("error: attachment originals are missing; download/export media or explicitly use --allow-missing-media", file=sys.stderr)
            return 3
        if plan["unsupported_rich_text_entries"]:
            print("error: entries contain rich text without Markdown; use a JSON export with text or inspect manually", file=sys.stderr)
            return 4
        report = apply_import(source, vault, args.daily_folder, args.assets_folder, args.replace_existing)
        print(json.dumps(report, indent=2))
        return 0
    finally:
        source.close()


if __name__ == "__main__":
    raise SystemExit(main())
