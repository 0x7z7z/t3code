import math
import struct
import wave

import pytest

from axis_music import describe, estimate_tempo, index_library


def wav(path, duration=12):
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as out:
        out.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
        out.writeframes(b"".join(struct.pack("<h", int((1200 if i < 32000 else 12000)*math.sin(2*math.pi*220*i/8000))) for i in range(duration*8000)))


def test_index_resumes_and_keeps_library_unchanged(tmp_path):
    root, cache = tmp_path / "library", tmp_path / "cache" / "music.sqlite"
    wav(root / "Action" / "one.wav")
    wav(root / "Quiet" / "two.WAV")
    before = {p: p.read_bytes() for p in root.rglob("*") if p.is_file()}
    first = index_library(root, cache, limit=1)
    assert (len(first["tracks"]), first["pending"], first["analyzed"]) == (1, 1, 1)
    second = index_library(root, cache, limit=1)
    assert (len(second["tracks"]), second["pending"], second["analyzed"]) == (2, 0, 1)
    assert index_library(root, cache)["analyzed"] == 0
    track = second["tracks"][0]
    assert track["duration"] == 12
    assert -40 < track["loudnessDbfs"] < -5
    assert len(track["energy"]) == 12
    assert track["rises"] and track["loudWindows"]
    assert track["category"] == "Action"
    assert all(p.read_bytes() == content for p, content in before.items())


def test_description_and_invalidation(tmp_path):
    root, cache = tmp_path / "music", tmp_path / "index.sqlite"
    path = root / "one.wav"
    wav(path)
    track = index_library(root, cache)["tracks"][0]
    describe(path, "Heard 30s excerpt: sparse piano", ["calm"], cache, track["fingerprint"])
    assert index_library(root, cache)["tracks"][0]["tags"] == ["calm"]
    wav(path, 14)
    with pytest.raises(ValueError, match="changed"):
        describe(path, "stale", [], cache, track["fingerprint"])
    updated = index_library(root, cache)
    assert updated["analyzed"] == 1
    assert updated["tracks"][0]["description"] == ""


def test_corrupt_and_deleted_files_do_not_poison_resume(tmp_path):
    root, cache = tmp_path / "music", tmp_path / "index.sqlite"
    wav(root / "good.wav")
    (root / "broken.mp3").write_bytes(b"not audio")
    report = index_library(root, cache)
    assert len(report["tracks"]) == len(report["failures"]) == 1
    (root / "good.wav").unlink()
    assert index_library(root, cache)["tracks"] == []


def test_weak_tempo_is_unknown_and_pulse_is_measured():
    assert estimate_tempo([1]*500) is None
    assert estimate_tempo([10 if i % 10 == 0 else 0 for i in range(500)]) == 120


def test_failures_do_not_starve_later_batches_and_can_be_retried(tmp_path):
    root, cache = tmp_path / "music", tmp_path / "index.sqlite"
    wav(root / "zz-good.wav")
    (root / "aa-bad.mp3").write_bytes(b"bad audio")
    assert index_library(root, cache, limit=1)["pending"] == 1
    resumed = index_library(root, cache, limit=1)
    assert len(resumed["tracks"]) == 1
    assert len(resumed["failures"]) == 1
    root2, cache2 = tmp_path / "other", tmp_path / "other.sqlite"
    wav(root2 / "good.wav")
    assert len(index_library(root2, cache2, ffmpeg="axis-nonexistent-ffmpeg")["failures"]) == 1
    assert index_library(root2, cache2)["tracks"] == []
    assert len(index_library(root2, cache2, retry_failures=True)["tracks"]) == 1


def test_compact_response_keeps_envelopes_in_cache(tmp_path):
    root, cache = tmp_path / "music", tmp_path / "index.sqlite"
    wav(root / "one.wav")
    assert index_library(root, cache, compact=True)["tracks"][0]["energy"] == []
    assert len(index_library(root, cache)["tracks"][0]["energy"]) == 12
from axis_music import catalogue_hints, peak_dbfs


def test_full_channel_peak_survives_antiphase_downmix(tmp_path):
    path = tmp_path / "stereo.wav"
    with wave.open(str(path), "wb") as out:
        out.setparams((2, 2, 48000, 0, "NONE", "not compressed"))
        out.writeframes(b"".join(struct.pack("<hh", value, -value) for value in [16384, -16384] * 4800))
    assert peak_dbfs(path) == pytest.approx(-6.0206, abs=0.01)


def test_catalogue_is_secondary_read_only_and_duplicates_are_not_decoded(tmp_path):
    root = tmp_path / "music"
    wav(root / "hype music" / "track.wav")
    duplicate = root / "00. duplicate copies - review" / "broken.mp3"
    duplicate.parent.mkdir()
    duplicate.write_bytes(b"not audio")
    references = root / "AGENTS.md"
    references.mkdir()
    (references / "MUSIC_LIBRARY_CATALOGUE_AND_ANALYSIS.md").write_text(
        "### Hype `hype music`\n| 1 | `track.wav` | 0:12 | 120 | electronic; energy 80%; brightness 60% |", encoding="utf-8")
    (references / "audio_mood_analysis.json").write_text(
        '{"results":[{"name":"track.wav","low_level":{"bpm":122},"audio_summary":{"energy":0.82,"brightness":0.61}}]}', encoding="utf-8")
    before = {p: p.read_bytes() for p in root.rglob("*") if p.is_file()}
    result = index_library(root, tmp_path / "cache.sqlite")
    assert len(result["tracks"]) == 1
    assert result["failures"] == []
    track = result["tracks"][0]
    assert track["category"] == "hype music"
    assert track["tempo"] == 120
    assert track["catalogueEnergy"] == 0.82
    assert track["brightness"] == 0.61
    assert -10 < track["peakDbfs"] < -8
    assert all(p.read_bytes() == content for p, content in before.items())


def test_silent_sources_cannot_be_peak_normalized(tmp_path):
    path = tmp_path / "silent.wav"
    with wave.open(str(path), "wb") as out:
        out.setparams((1, 2, 8000, 0, "NONE", "not compressed"))
        out.writeframes(b"\0" * 16000)
    with pytest.raises(ValueError, match="finite source peak"):
        peak_dbfs(path)
