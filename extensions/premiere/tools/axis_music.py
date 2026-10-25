#!/usr/bin/env python3
"""Read-only music analysis. Incremental SQLite cache, one committed file at a time.

Adapted from video-music-revisions/scripts/analyze_audio_structure.py.
Energy boundaries are audition points, not proof of musical phrases or mood.
"""
from __future__ import annotations

import argparse
from array import array
import hashlib
import json
import math
import os
import re
from pathlib import Path
import sqlite3
import subprocess
import sys

AUDIO = {".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".aif", ".aiff", ".wma"}
VERSION = 2


def peak_dbfs(path, ffmpeg="ffmpeg"):
    """Full-source, all-channel sample peak, before mono/resampled structure analysis."""
    result = subprocess.run([ffmpeg, "-hide_banner", "-nostats", "-i", str(path), "-vn", "-af",
        "astats=measure_perchannel=Peak_level:measure_overall=Peak_level", "-f", "null", "-"],
        check=True, capture_output=True, text=True, timeout=600)
    values = [float(v) for v in re.findall(r"Peak level dB:\s*([-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?|-?inf)(?=\s|$)", result.stderr)]
    if not values or not all(math.isfinite(v) for v in values):
        raise ValueError("Cannot measure a finite source peak (silent or unreadable audio)")
    return max(values)


def catalogue_hints(root):
    """Read owner-maintained references; never write inside the library."""
    hints = {}
    folder = root / "AGENTS.md"
    document = folder / "MUSIC_LIBRARY_CATALOGUE_AND_ANALYSIS.md"
    if document.is_file():
        category = ""
        for line in document.read_text(encoding="utf-8").splitlines():
            if line.startswith("###"):
                match = re.search(r"`([^`]+)`", line)
                category = match.group(1) if match else ""
            match = re.search(r"\|\s*\d+\s*\|\s*`([^`]+)`\s*\|\s*(\d+):(\d+)\s*\|\s*(\d+)\s*\|.*energy (\d+)%; brightness (\d+)%", line)
            if match:
                filename, minutes, seconds, bpm, energy, brightness = match.groups()
                hints[(category.lower(), filename.lower())] = {"catalogueDuration": int(minutes)*60+int(seconds),
                    "tempo": float(bpm), "catalogueEnergy": int(energy)/100, "brightness": int(brightness)/100}
    analysis = folder / "audio_mood_analysis.json"
    if analysis.is_file():
        try:
            for row in json.loads(analysis.read_text(encoding="utf-8")).get("results", []):
                # Catalogue folder is authoritative; analysis can refer to pre-sort locations.
                for key, value in hints.items():
                    if key[1] == str(row.get("name", "")).lower():
                        value["analysisBpm"] = row.get("low_level", {}).get("bpm")
                        value["catalogueEnergy"] = row.get("audio_summary", {}).get("energy", value["catalogueEnergy"])
                        value["brightness"] = row.get("audio_summary", {}).get("brightness", value["brightness"])
        except (ValueError, TypeError, AttributeError):
            pass
    return hints


def cache_path():
    return Path(os.environ.get("LOCALAPPDATA", Path.home() / ".cache")) / "PremiereAssistant" / "music-index" / "v1" / "tracks.sqlite"


def connect(path):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path, timeout=30)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("CREATE TABLE IF NOT EXISTS tracks (path TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, data TEXT NOT NULL)")
    return db


def fingerprint(path):
    stat = path.stat()
    return hashlib.sha256(f"{VERSION}|{path.resolve()}|{stat.st_size}|{stat.st_mtime_ns}".encode()).hexdigest()


def merge_ranges(indexes, gap=1):
    ranges = []
    for i in indexes:
        if ranges and i <= ranges[-1][1] + gap:
            ranges[-1][1] = i + 1
        else:
            ranges.append([i, i + 1])
    return ranges


def separated(scores, count=4, spacing=14):
    selected = []
    for i in sorted(range(len(scores)), key=scores.__getitem__, reverse=True):
        if all(abs(i - j) >= spacing for j in selected):
            selected.append(i)
        if len(selected) >= count:
            break
    return sorted(selected)


def estimate_tempo(envelope):
    """Cheap onset autocorrelation over the first 90s; weak evidence stays unknown."""
    onset = [max(0, b-a) for a, b in zip(envelope, envelope[1:])]
    power = sum(v*v for v in onset)
    if len(onset) < 100 or power < 1e-9:
        return None
    scores = [(sum(onset[i]*onset[i-lag] for i in range(lag, len(onset))) / power, lag) for lag in range(6, 31)]
    score, lag = max(scores)
    return round(1200/lag, 1) if score >= 0.35 else None


def analyze(path, root, ffmpeg="ffmpeg", ffprobe="ffprobe"):
    peak = peak_dbfs(path, ffmpeg)
    duration = float(subprocess.run([ffprobe, "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(path)], check=True, capture_output=True, text=True, timeout=30).stdout.strip())
    if not math.isfinite(duration) or duration <= 0 or duration > 14400:
        raise ValueError("Require audio between zero and four hours")
    # Stream one second at a time, so long tracks never materialize as full PCM.
    process = subprocess.Popen([ffmpeg, "-v", "error", "-i", str(path), "-vn", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
    energy, squares, count, envelope = [], 0.0, 0, []
    try:
        while True:
            raw = process.stdout.read(16000)
            if not raw:
                break
            samples = array("h")
            samples.frombytes(raw[:len(raw) - len(raw) % 2])
            if sys.byteorder != "little":
                samples.byteswap()
            total = sum(float(x) * x for x in samples)
            if len(envelope) < 1800:
                for at in range(0, len(samples), 400):
                    frame = samples[at:at+400]
                    envelope.append(math.sqrt(sum(float(x)*x for x in frame)/max(1, len(frame))))
            squares += total
            count += len(samples)
            energy.append(10 * math.log10(max(total / max(1, len(samples)) / 32768**2, 1e-12)))
        if process.wait(timeout=30) != 0 or not energy:
            raise ValueError("Audio decoding failed")
    finally:
        process.stdout.close()
        if process.poll() is None:
            process.kill()
            process.wait()
    smooth = [sum(energy[max(0, i-4):i+5]) / len(energy[max(0, i-4):i+5]) for i in range(len(energy))]
    maximum = max(smooth)
    rises = [smooth[i+6] - smooth[i] for i in range(max(0, len(smooth)-6))]
    quiet = merge_ranges([i for i, v in enumerate(smooth) if v < maximum-16])
    # Conservative energy-change candidates. They require an audible phrase check.
    changes = [abs(smooth[i] - smooth[max(0, i-3)]) for i in range(len(smooth))]
    boundaries = [i for i in separated(changes, count=24, spacing=8) if changes[i] >= 3]
    return {"path": str(path.resolve()), "filename": path.name, "category": str(path.parent.relative_to(root)),
            "duration": round(duration, 3), "peakDbfs": round(peak, 4), "loudnessDbfs": round(10 * math.log10(max(squares/max(1, count)/32768**2, 1e-12)), 2),
            "energy": [round(x, 2) for x in smooth],
            "rises": [{"start": i, "end": i+6, "db": round(rises[i], 2)} for i in separated(rises, 3, 15) if rises[i] >= 3],
            "loudWindows": [{"start": max(0, i-4), "end": min(duration, i+5)} for i in separated(smooth)],
            "quietRanges": [{"start": a, "end": min(duration, b)} for a, b in quiet if b-a >= 3],
            "phraseBoundaries": boundaries, "tempo": estimate_tempo(envelope), "description": "", "tags": [],
            "analysisNote": "RMS dBFS, not LUFS. Energy phrase candidates require audition. Tempo is a rough onset-autocorrelation estimate from up to 90s, null when evidence is weak."}


def index_library(root, cache=None, limit=100, ffmpeg="ffmpeg", ffprobe="ffprobe", compact=False, retry_failures=False):
    root = Path(root).resolve(strict=True)
    if not root.is_dir():
        raise ValueError("Library root must be a directory")
    if not 1 <= limit <= 10000:
        raise ValueError("Batch limit must be 1-10000")
    tracks, failures, pending, analyzed = [], [], 0, 0
    hints = catalogue_hints(root)
    with connect(cache or cache_path()) as db:
        for folder, dirs, files in os.walk(root, followlinks=False):
            dirs[:] = sorted(d for d in dirs if d.lower() != "00. duplicate copies - review" and not (Path(folder) / d).is_symlink() and not getattr(os.path, "isjunction", lambda _: False)(Path(folder) / d))
            for name in sorted(files):
                path = Path(folder) / name
                if path.suffix.lower() not in AUDIO or path.is_symlink():
                    continue
                try:
                    key = fingerprint(path)
                    row = db.execute("SELECT fingerprint, data FROM tracks WHERE path=?", (str(path.resolve()),)).fetchone()
                    if row and row[0] == key and not (retry_failures and "error" in json.loads(row[1])):
                        item = json.loads(row[1])
                        if "error" in item:
                            failures.append(item)
                            continue
                    elif analyzed >= limit:
                        pending += 1
                        continue
                    else:
                        analyzed += 1
                        item = analyze(path, root, ffmpeg, ffprobe)
                        item["fingerprint"] = key
                        db.execute("INSERT OR REPLACE INTO tracks VALUES (?, ?, ?)", (item["path"], key, json.dumps(item)))
                        db.commit()
                    item = {**item, **hints.get((path.parent.name.lower(), path.name.lower()), {})}
                    tracks.append({**item, "energy": []} if compact else item)
                except (OSError, ValueError, subprocess.SubprocessError) as error:
                    failure = {"path": str(path), "error": str(error)[:300]}
                    failures.append(failure)
                    # A broken file must not consume the first batch on every resume.
                    # A size/mtime change invalidates this failure like any other result.
                    try:
                        db.execute("INSERT OR REPLACE INTO tracks VALUES (?, ?, ?)", (str(path.resolve()), fingerprint(path), json.dumps(failure)))
                        db.commit()
                    except OSError:
                        pass
    return {"version": VERSION, "root": str(root), "tracks": tracks, "analyzed": analyzed, "pending": pending, "failures": failures,
            "moodPath": "Mood folder is primary. Catalogue BPM, energy and brightness are secondary. Unsorted is last resort; duplicate-review copies are excluded."}


def describe(path, description, tags, cache=None, expected=None):
    """Persist only descriptions of the exact indexed version the listener heard."""
    if not isinstance(tags, list) or len(description) > 1000 or len(tags) > 20 or any(not isinstance(t, str) or len(t) > 80 for t in tags):
        raise ValueError("Description or tags too large")
    with connect(cache or cache_path()) as db:
        row = db.execute("SELECT fingerprint, data FROM tracks WHERE path=?", (str(Path(path).resolve()),)).fetchone()
        if not row or row[0] != fingerprint(Path(path)) or (expected and expected != row[0]):
            raise ValueError("Track changed or is not indexed. Reindex and audition again")
        data = json.loads(row[1])
        data.update(description=description.strip(), tags=tags)
        db.execute("UPDATE tracks SET data=? WHERE path=?", (json.dumps(data), data["path"]))
    return {"ok": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["index", "describe"])
    parser.add_argument("--root", type=Path)
    parser.add_argument("--cache", type=Path)
    parser.add_argument("--limit", type=int, default=100)
    parser.add_argument("--compact", action="store_true", help="Keep energy envelopes in the cache, omit them from JSON")
    parser.add_argument("--retry-failures", action="store_true")
    parser.add_argument("--path", type=Path)
    parser.add_argument("--description", default="")
    parser.add_argument("--tags", default="[]")
    parser.add_argument("--fingerprint")
    args = parser.parse_args()
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    try:
        result = index_library(args.root, args.cache, args.limit, compact=args.compact, retry_failures=args.retry_failures) if args.action == "index" else describe(args.path, args.description, json.loads(args.tags), args.cache, args.fingerprint)
        print(json.dumps(result, ensure_ascii=False))
    except (OSError, ValueError, TypeError, sqlite3.Error) as error:
        print(json.dumps({"error": str(error)}))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
