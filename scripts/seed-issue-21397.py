#!/usr/bin/env python3
"""With dev stopped: python3 scripts/seed-issue-21397.py --replace [matching|absent|unrelated] [--now [ISO]].

Replaces ALL thread/project projections in this worktree's .t3 database with a
synthetic stopped usage-limit run, so --replace is required. Run dev once to
initialize migrations first. Never targets the live T3 home.

Fixture times are frozen around the evidence clock, 2026-10-22T19:00:00Z (usage
limit hit; reset and matching snooze at 2026-10-23T08:50:00Z). By default they
are seeded unchanged, reproducing the PR captures. After that reset, pass --now
(current time) or --now ISO to shift every timestamp so the failure happens then.
"""
import argparse
import datetime
import json
import pathlib
import re
import sqlite3

EVIDENCE_CLOCK = datetime.datetime(2026, 10, 22, 19, tzinfo=datetime.timezone.utc)
ISO = re.compile(r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$')


def parse_iso(value):
    parsed = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=datetime.timezone.utc)


def shift(value, delta):
    if isinstance(value, dict):
        return {k: shift(v, delta) for k, v in value.items()}
    if isinstance(value, str) and ISO.match(value):
        moved = parse_iso(value) + delta
        return moved.strftime('%Y-%m-%dT%H:%M:%S.') + f'{moved.microsecond // 1000:03d}Z'
    return value


parser = argparse.ArgumentParser()
parser.add_argument('mode', nargs='?', default='matching', choices=('matching', 'absent', 'unrelated'))
parser.add_argument('--replace', action='store_true', help='confirm deleting existing worktree projections')
parser.add_argument('--now', nargs='?', const='now', help='shift fixture times so the limit is hit at this ISO time')
args = parser.parse_args()
mode = args.mode
now = None if args.now is None else datetime.datetime.now(datetime.timezone.utc) if args.now == 'now' else parse_iso(args.now)
delta = datetime.timedelta() if now is None else now - EVIDENCE_CLOCK

root = pathlib.Path(__file__).resolve().parent.parent
path = root / '.t3/userdata/statev2.sqlite'
if not path.is_file() or path.resolve() != path.absolute():
    raise SystemExit('Expected a migrated, isolated worktree .t3 database')
if not args.replace:
    raise SystemExit(f'Refusing to replace thread and project projections in {path} without --replace')
fixture = json.loads((root / 'scripts/fixtures/issue-21397.json').read_text())
with sqlite3.connect(path) as db:
    # Prevent the old V1 import from bringing unrelated conversations back.
    tables = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")]
    for table in tables:
        if table.startswith('orchestration_v2_projection_') and table != 'orchestration_v2_projection_metadata':
            db.execute(f'DELETE FROM "{table}"')
        elif table.startswith('projection_thread') or table == 'projection_projects':
            db.execute(f'DELETE FROM "{table}"')
    db.execute("UPDATE orchestration_v2_effect_outbox SET status='cancelled' WHERE status IN ('pending','running')")
    for table, rows in fixture.items():
        for row in rows:
            row = shift(dict(row), delta)
            if table == 'projection_projects':
                row['workspace_root'] = str(root)
            if table == 'orchestration_v2_projection_threads':
                payload = json.loads(row['payload_json'])
                if mode == 'absent':
                    payload['snoozedUntil'] = None
                elif mode == 'unrelated':
                    payload['snoozedUntil'] = '2026-10-24T08:50:00.000Z'
                row['payload_json'] = json.dumps(shift(payload, delta))
            elif delta and 'payload_json' in row:
                row['payload_json'] = json.dumps(shift(json.loads(row['payload_json']), delta))
            columns = ','.join(f'"{k}"' for k in row)
            placeholders = ','.join('?' for _ in row)
            db.execute(f'INSERT INTO "{table}" ({columns}) VALUES ({placeholders})', list(row.values()))
settings_path = root / '.t3/userdata/settings.json'
settings = json.loads(settings_path.read_text()) if settings_path.exists() else {}
settings.update(snoozeLimitedThreads=False, autoResumeLimitedThreads=False)
settings_path.write_text(json.dumps(settings, indent=2) + '\n')
print(f'Seeded synthetic {mode} fixture in {path} (limit hit at {now or EVIDENCE_CLOCK:%Y-%m-%dT%H:%M:%SZ})')
