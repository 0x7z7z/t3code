import csv
import json
import os
from pathlib import Path

import numpy as np
import pytest
import soundfile as sf

from axis_vo_cleanup import breath_regions, cleanup, protect_silence_edges, render_breaths, remove_silence


def fricative_noise(count, sr, db=-52):
    spectrum = np.fft.rfft(np.random.default_rng(73).normal(size=count))
    spectrum[np.fft.rfftfreq(count, 1 / sr) < 2500] = 0
    noise = np.fft.irfft(spectrum, n=count)
    return noise / np.sqrt(np.mean(noise ** 2)) * 10 ** (db / 20)


@pytest.mark.parametrize("keep_ms", [0, 50])
def test_silence_preserves_quiet_fricative_onset_and_tail(tmp_path, keep_ms):
    sr = 16000
    hiss = fricative_noise(1600, sr)
    vowel = .1 * np.sin(np.arange(6400) * 2 * np.pi * 300 / sr)
    source, output = tmp_path / "voice.wav", tmp_path / "clean.wav"
    sf.write(source, np.r_[np.zeros(8000), hiss, vowel, hiss, np.zeros(8000)], sr)
    remove_silence(source, output, keep_ms)
    before, _ = sf.read(source, dtype="int16")
    after, _ = sf.read(output, dtype="int16")
    assert before[8100:9500].tobytes() in after.tobytes()
    assert before[16100:17500].tobytes() in after.tobytes()
    assert len(after) < len(before)


def test_breath_end_protects_a_whisperx_start_after_the_opening_fricative(tmp_path, monkeypatch):
    import axis_vo_cleanup as module
    sr = 16000
    source = tmp_path / "voice.wav"
    samples = np.zeros(sr)
    samples[6400:8000] = fricative_noise(1600, sr, -44)
    sf.write(source, samples, sr)
    monkeypatch.setattr(module, "select_breaths", lambda *args: [{"a": .2, "b": .5, "prev": .15, "next": .52}])
    regions, _ = breath_regions(source, [{"word": "She", "start": .52, "end": .8}])
    assert len(regions) == 1
    assert regions[0][1] / sr <= .4


@pytest.mark.parametrize("word,edge", [
    ("She", "start"), ("the", "start"), ("voice", "start"), ("phone", "start"),
    ("John", "start"), ("his", "start"), ("fox", "end"), ("judge.", "end"),
    ("voice,", "end"), ("with", "end"), ("buzz", "end"), ("laugh", "end"),
])
def test_spelling_protects_weak_fricatives_on_second_silence_pass(word, edge):
    # Deliberately below the spectral/level floor: spelling adds protection even
    # when lowering a neighbouring breath made the acoustic boundary ambiguous.
    words = [{"word": word, "start": .55, "end": .95}]
    ranges = protect_silence_edges([[500, 1000]], np.full(200, -80), np.zeros(200), 16000, 2000, words)
    assert ranges[0][0 if edge == "start" else 1] == (470 if edge == "start" else 1030)


def test_silence_extensions_are_capped_and_overlap_is_kept_once():
    rms, hf = np.full(200, -52), np.ones(200)
    assert protect_silence_edges([[500, 700]], rms, hf, 16000, 2000, []) == [[380, 820]]
    assert protect_silence_edges([[500, 700], [800, 1000]], rms, hf, 16000, 2000, []) == [[380, 1120]]


def test_fourth_mode_uses_post_silence_timings_and_keeps_intermediates(tmp_path, monkeypatch):
    import axis_vo_cleanup as module
    source = tmp_path / "voice.wav"
    sf.write(source, np.r_[np.ones(8000) * .1, np.zeros(8000), np.ones(8000) * .1], 8000)
    calls = []
    remove = module.remove_silence

    def silence(current, destination, keep_ms, words=None):
        calls.append((current, keep_ms, words))
        remove(current, destination, keep_ms, words)

    def transcribe(current, directory):
        assert current.name.endswith("_SilenceRemoved.wav")
        filename = directory / "words.json"
        filename.write_text(json.dumps({"words": [{"word": "She.", "start": .1, "end": .4}]}))
        return filename

    monkeypatch.setattr(module, "remove_silence", silence)
    monkeypatch.setattr(module, "transcribe_words", transcribe)
    result = cleanup(source, "sandwich", keep_ms=80)
    assert len(calls) == 2
    assert calls[0][1:] == (80, None)
    assert calls[1][1:] == (80, [{"word": "She.", "start": .1, "end": .4}])
    assert calls[1][0] == Path(result["breathsPath"])
    assert result["outputPath"].endswith("_SilenceBreathsSilence.wav")
    assert all(Path(result[key]).is_file() for key in ("silencePath", "breathsPath", "outputPath", "regionsPath"))
    with pytest.raises(ValueError, match="source timings"):
        cleanup(source, "sandwich", transcript=tmp_path / "old.json")


def test_final_silence_pass_closes_a_lowered_breath_gap(tmp_path, monkeypatch):
    import axis_vo_cleanup as module
    sr = 16000
    source = tmp_path / "voice.wav"
    vowel = .1 * np.sin(np.arange(6400) * 2 * np.pi * 300 / sr)
    sf.write(source, np.r_[vowel, fricative_noise(4800, sr, -39), vowel], sr)
    seen = []

    def transcribe(current, directory):
        seen.append(current)
        filename = directory / "words.json"
        filename.write_text(json.dumps({"words": [
            {"word": "one.", "start": 0, "end": .4},
            {"word": "again", "start": .7, "end": 1.1},
        ]}))
        return filename

    monkeypatch.setattr(module, "transcribe_words", transcribe)
    monkeypatch.setattr(module, "breath_regions", lambda *args: ([(6400, 11200)], sr))
    result = cleanup(source, "sandwich", keep_ms=50)
    assert len(seen) == 1
    assert sf.info(result["silencePath"]).frames == sf.info(result["breathsPath"]).frames
    assert sf.info(result["outputPath"]).frames < sf.info(result["breathsPath"]).frames - 1000


@pytest.mark.parametrize("subtype,dtype,quantum", [
    ("PCM_U8", "int16", 256), ("PCM_16", "int16", 1), ("PCM_24", "int32", 256),
    ("PCM_32", "int32", 1), ("FLOAT", "float32", 1), ("DOUBLE", "float64", 1),
])
def test_breath_render_preserves_samples_and_edges(tmp_path, subtype, dtype, quantum):
    rng = np.random.default_rng(49)
    data = rng.uniform(-.8, .8, (16000, 2))
    source, output = tmp_path / "source.wav", tmp_path / "result.wav"
    sf.write(source, data, 8000, subtype=subtype)
    before, sr = sf.read(source, dtype=dtype, always_2d=True)
    regions = [(1500, 2600), (2400, 3100), (7900, 9100)]
    render_breaths(source, output, regions)
    after, _ = sf.read(output, dtype=dtype, always_2d=True)
    outside = np.ones(len(before), dtype=bool)
    for a, b in regions:
        outside[a:b] = False
    assert len(after) == len(before)
    assert sf.info(output).subtype == subtype
    assert before[outside].tobytes() == after[outside].tobytes()
    assert np.array_equal(after[1500], before[1500])
    assert np.array_equal(after[3099], before[3099])
    assert np.max(np.abs(after[1700:2000].astype(float))) <= np.max(np.abs(before[1700:2000].astype(float))) * .011 + quantum
    assert sr == 8000


@pytest.mark.parametrize("amplitude", [.3, .002, 0])
@pytest.mark.parametrize("keep_ms", [0, 50, 100, 5000])
def test_silence_matches_reference_including_quiet_fallback(tmp_path, amplitude, keep_ms):
    from pydub import AudioSegment
    from pydub.silence import split_on_silence
    sr = 8000
    tone = np.sin(np.arange(sr // 2) * 2 * np.pi * 300 / sr) * amplitude
    source, output = tmp_path / "voice.wav", tmp_path / "clean.wav"
    sf.write(source, np.r_[np.zeros(4000), tone, np.zeros(8000), tone, np.zeros(4000)], sr)
    sound = AudioSegment.from_file(source)
    chunks = split_on_silence(sound, min_silence_len=100, silence_thresh=-45, keep_silence=keep_ms)
    if not chunks:
        chunks = split_on_silence(sound, min_silence_len=100, silence_thresh=sound.dBFS - 16, keep_silence=keep_ms)
    expected = sum(chunks, AudioSegment.empty()) if chunks else sound
    remove_silence(source, output, keep_ms)
    assert AudioSegment.from_file(output).raw_data == expected.raw_data


def test_pipeline_unique_outputs_and_post_silence_transcription(tmp_path, monkeypatch):
    import axis_vo_cleanup as module
    source = tmp_path / "voice.wav"
    sf.write(source, np.r_[np.ones(8000) * .1, np.zeros(8000), np.ones(8000) * .1], 8000)
    original = source.read_bytes()
    seen = []

    def transcribe(current, directory):
        seen.append((current, sf.info(current).duration))
        filename = directory / "words.json"
        filename.write_text(json.dumps({"words": [{"word": "Hello.", "start": 0, "end": .5}]}))
        return filename

    monkeypatch.setattr(module, "transcribe_words", transcribe)
    first = cleanup(source)
    second = cleanup(source)
    assert first["outputPath"] != second["outputPath"]
    assert all(path.parent == tmp_path and duration < 3 for path, duration in seen)
    assert sf.info(first["silencePath"]).frames == sf.info(first["outputPath"]).frames
    assert source.read_bytes() == original
    assert Path(first["regionsPath"]).is_file()
    with pytest.raises(ValueError, match="source timings"):
        cleanup(source, transcript=tmp_path / "old.json")


def test_failed_job_removes_only_its_new_outputs(tmp_path, monkeypatch):
    import axis_vo_cleanup as module
    source = tmp_path / "voice.wav"
    sf.write(source, np.ones(8000) * .1, 8000)
    original = source.read_bytes()

    def fail(*args):
        raise ValueError("WhisperX unavailable")

    monkeypatch.setattr(module, "transcribe_words", fail)
    with pytest.raises(ValueError, match="WhisperX"):
        cleanup(source)
    assert list(tmp_path.iterdir()) == [source]
    assert source.read_bytes() == original


def test_word_boundaries_cannot_be_discarded_to_rescue_a_short_region(tmp_path, monkeypatch):
    import axis_vo_cleanup as module
    source = tmp_path / "voice.wav"
    sf.write(source, np.zeros(8000), 8000)
    monkeypatch.setattr(module, "measure_frames", lambda _: ([], [], 8000))
    monkeypatch.setattr(module, "select_breaths", lambda *args: [{"a": .5, "b": .6, "prev": .58, "next": .62}])
    regions, _ = breath_regions(source, [])
    assert regions == []


def test_project49_reproduction():
    root = Path(os.environ.get("AXIS_PROJECT49_ROOT", r"D:\0. PROJECTS\~ AnimeAddicts\49. Every final form in dragonball"))
    source = root / "VO_Every_final_form_in_dragonball_SilenceRemoved-Final.wav"
    transcript = source.with_name(source.stem + "_sentences.json")
    reference = root / "5. AI_OUTPUT/AI_work_area/breath/breaths_removed.csv"
    if not all(path.is_file() for path in (source, transcript, reference)):
        pytest.skip("Optional project-49 private fixture missing; set AXIS_PROJECT49_ROOT")
    output = Path(os.environ.get("AXIS_VO_TEST_OUTPUT", r"D:\temp\axis-vo-cleanup"))
    result = cleanup(source, "breaths", transcript=transcript, output_dir=output)
    with open(result["regionsPath"], newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    with reference.open(newline="", encoding="utf-8-sig") as handle:
        expected = list(csv.DictReader(handle))
    marks = [5.233, 9.6, 13.65, 19.817, 24.6, 27.65, 34.083, 37.217, 45.567, 48.967, 56.117, 60.9, 63.717]
    first = [r for r in rows if float(r["start_s"]) < 64.5]
    hits = sum(any(float(r["start_s"]) - .06 <= mark <= float(r["end_s"]) for r in first) for mark in marks)
    extras = sum(not any(float(r["start_s"]) - .06 <= mark <= float(r["end_s"]) for mark in marks) for r in first)
    assert hits == 13
    assert extras == 0
    assert len(rows) == 136
    assert len(rows) == len(expected)
    max_delta = max(abs(float(row[key]) - float(ref[key])) for row, ref in zip(rows, expected) for key in ("start_s", "end_s"))
    assert max_delta <= .12
    changed = sum(any(abs(float(row[key]) - float(ref[key])) > .001 for key in ("start_s", "end_s"))
                  for row, ref in zip(rows, expected))
    shrank = sum(float(row["end_s"]) < float(ref["end_s"]) - .001 for row, ref in zip(rows, expected))
    assert all(abs(float(row["start_s"]) - float(ref["start_s"])) <= .001 and
               float(row["end_s"]) <= float(ref["end_s"]) + .001 for row, ref in zip(rows, expected))
    with sf.SoundFile(source) as before, sf.SoundFile(result["outputPath"]) as after:
        assert before.frames == after.frames
        assert before.subtype == after.subtype
        offset = 0
        for block in before.blocks(blocksize=65536, dtype="int16", always_2d=True):
            cleaned = after.read(len(block), dtype="int16", always_2d=True)
            outside = np.ones(len(block), dtype=bool)
            for row in rows:
                a, b = int(row["start_sample"]), int(row["end_sample"])
                lo, hi = max(a, offset), min(b, offset + len(block))
                if hi > lo:
                    outside[lo - offset:hi - offset] = False
            assert block[outside].tobytes() == cleaned[outside].tobytes()
            offset += len(block)
    summary = {"marksFound": hits, "falsePositivesThrough64_5": extras, "regions": len(rows),
               "referenceRegions": len(expected), "maxEdgeDifferenceSeconds": max_delta,
               "changedRegions": changed, "shrunkRegions": shrank,
               "sampleCount": offset, "outsideRegionsBitIdentical": True, **result}
    (output / "project49-result.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print(json.dumps(summary))


@pytest.mark.parametrize("failure", ["timeout", "cancel"])
def test_transcription_stops_its_process_tree_and_removes_outputs(tmp_path, monkeypatch, failure):
    import subprocess
    import axis_vo_cleanup as module
    source = tmp_path / "voice.wav"
    sf.write(source, np.ones(8000) * .1, 8000)
    stopped = []

    class Process:
        returncode = None

        def communicate(self, timeout):
            assert timeout == module.TRANSCRIBE_TIMEOUT_SECONDS
            if failure == "timeout":
                raise subprocess.TimeoutExpired("whisperx", timeout)
            raise KeyboardInterrupt("cancel")

    process = Process()
    monkeypatch.setattr(module, "managed_process", lambda _: process)
    monkeypatch.setattr(module, "kill_tree", stopped.append)
    error = ValueError if failure == "timeout" else KeyboardInterrupt
    with pytest.raises(error):
        cleanup(source)
    assert stopped == [process]
    assert list(tmp_path.iterdir()) == [source]


@pytest.mark.parametrize("failure", ["timeout", "cancel", "worker-error"])
def test_supervisor_removes_reserved_outputs_and_workspace_even_if_worker_cannot_unwind(tmp_path, monkeypatch, failure):
    import argparse
    import axis_vo_cleanup as module
    source = tmp_path / "voice.wav"
    sf.write(source, np.ones(8000) * .1, 8000)
    original = source.read_bytes()
    unrelated = tmp_path / "other_AxisVO_existing.wav"
    unrelated.write_bytes(b"keep")
    stopped = []
    commands = []

    class Process:
        pid = 123
        returncode = None

        def communicate(self, timeout):
            if failure == "worker-error":
                self.returncode = 1
                return "", "worker failed"
            raise module.subprocess.TimeoutExpired("worker", timeout)

    process = Process()
    def launch(command):
        commands.append(command)
        token = command[command.index("--job-id") + 1]
        workspace = Path(command[command.index("--workspace") + 1])
        (workspace / "unfinished-temp").write_bytes(b"temp")
        for suffix in ("_SilenceRemoved.wav", "_NoBreaths.wav", "_breaths.csv", "_SilenceBreathsSilence.wav"):
            (tmp_path / ("voice_AxisVO_" + token + suffix)).write_bytes(b"reserved")
        return process

    monkeypatch.setattr(module, "managed_process", launch)
    monkeypatch.setattr(module, "kill_tree", stopped.append)
    moments = iter([0, 0, 2])
    monkeypatch.setattr(module.time, "monotonic", lambda: next(moments))
    stop_file = tmp_path / "stop"
    if failure == "cancel":
        stop_file.touch()
    args = argparse.Namespace(input=source, output_dir=tmp_path, mode="both", keep_ms=50,
                              transcript=None, timeout_seconds=1, cancel_file=stop_file)
    with pytest.raises(ValueError, match={"timeout": "timed out", "cancel": "cancelled", "worker-error": "worker failed"}[failure]):
        module.run_job(args)
    assert stopped == [process]
    assert source.read_bytes() == original
    assert unrelated.read_bytes() == b"keep"
    assert set(tmp_path.iterdir()) == {source, unrelated} | ({stop_file} if failure == "cancel" else set())
    assert "--worker" in commands[0]


def test_cli_supervisor_success_and_missing_file(tmp_path):
    import subprocess
    import sys
    import axis_vo_cleanup as module
    source = tmp_path / "voice.wav"
    sf.write(source, np.ones(8000) * .1, 8000)
    command = [sys.executable, module.__file__, "--input", str(source), "--mode", "silence"]
    completed = subprocess.run(command, capture_output=True, text=True, timeout=30)
    assert completed.returncode == 0, completed.stderr
    result = json.loads(completed.stdout)
    assert Path(result["outputPath"]).is_file()
    assert not list(tmp_path.glob("axis-vo-*"))
    source.unlink()
    missing = subprocess.run(command, capture_output=True, text=True, timeout=30)
    assert missing.returncode == 1
    assert missing.stderr.strip() == "Audio file not found."


def test_supervisor_really_stops_a_worker_and_its_child(tmp_path):
    import sys
    import axis_vo_cleanup as module
    worker = tmp_path / "worker.py"
    # A child writing readiness proves the descendant was spawned before cancellation.
    worker.write_text(
        "import subprocess, sys, threading\n"
        "from pathlib import Path\n"
        "child = subprocess.Popen([sys.executable, '-c', "
        "'import sys; print(\"ready\", flush=True); sys.stdin.read()'], stdin=subprocess.PIPE, stdout=subprocess.PIPE)\n"
        "child.stdout.readline()\n"
        "Path(sys.argv[1]).write_text(str(child.pid))\n"
        "Path(sys.argv[2]).touch()\n"
        "threading.Event().wait()\n"
    )
    pid_file, stop_file = tmp_path / "pid", tmp_path / "stop"
    with pytest.raises(ValueError, match="cancelled"):
        module.supervise([sys.executable, str(worker), str(pid_file), str(stop_file)], 15, stop_file)
    pid = int(pid_file.read_text())
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        kernel.OpenProcess.restype = wintypes.HANDLE
        kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        handle = kernel.OpenProcess(0x100000, False, pid)
        if handle:
            try:
                assert kernel.WaitForSingleObject(handle, 0) == 0
            finally:
                kernel.CloseHandle(handle)
    else:
        # An orphaned dead process may await init's reaper; it must not still be running.
        stat = Path("/proc") / str(pid) / "stat"
        assert not stat.exists() or stat.read_text().split()[2] == "Z"
