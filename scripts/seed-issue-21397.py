#!/usr/bin/env python3
"""With dev stopped: python3 scripts/seed-issue-21397.py [matching|absent|unrelated].

Replaces isolated projection state with a synthetic stopped usage-limit run.
Run dev once to initialize migrations first. Never targets the live T3 home.
"""
import json
import pathlib
import sqlite3
import sys

root = pathlib.Path(__file__).resolve().parent.parent
path = root / '.t3/userdata/statev2.sqlite'
if not path.is_file() or path.resolve() != path.absolute():
    raise SystemExit('Expected a migrated, isolated worktree .t3 database')
mode = sys.argv[1] if len(sys.argv) > 1 else 'matching'
if mode not in ('matching', 'absent', 'unrelated'):
    raise SystemExit('Unknown fixture mode')
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
            row = dict(row)
            if table == 'projection_projects':
                row['workspace_root'] = str(root)
            if table == 'orchestration_v2_projection_threads':
                payload = json.loads(row['payload_json'])
                if mode == 'absent':
                    payload['snoozedUntil'] = None
                elif mode == 'unrelated':
                    payload['snoozedUntil'] = '2026-10-24T08:50:00.000Z'
                row['payload_json'] = json.dumps(payload)
            columns = ','.join(f'"{k}"' for k in row)
            placeholders = ','.join('?' for _ in row)
            db.execute(f'INSERT INTO "{table}" ({columns}) VALUES ({placeholders})', list(row.values()))
settings_path = root / '.t3/userdata/settings.json'
settings = json.loads(settings_path.read_text()) if settings_path.exists() else {}
settings.update(snoozeLimitedThreads=False, autoResumeLimitedThreads=False)
settings_path.write_text(json.dumps(settings, indent=2) + '\n')
print(f'Seeded synthetic {mode} fixture in {path}')
