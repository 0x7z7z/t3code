import importlib.util
import threading
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("axis_vo_studio", HERE / "server.py")
studio = importlib.util.module_from_spec(spec)
spec.loader.exec_module(studio)


class Whisper:
    """Stands in for the WhisperX process: writes an SRT into its output folder."""

    returncode = 0

    def __init__(self, args, **_):
        output = Path(args[args.index("--output_dir") + 1])
        audio = Path(args[args.index("-m") + 2])
        (output / (audio.stem + ".srt")).write_text("captions", encoding="utf-8")

    def poll(self):
        return self.returncode


def files(tmp_path):
    source = tmp_path / "VO Test Zoë.wav"
    cleaned = tmp_path / "VO Test Zoë_AxisVO.wav"
    source.write_bytes(b"original")
    cleaned.write_bytes(b"cleaned")
    return source, cleaned


def test_transcript_is_kept_when_the_output_cannot_be_renamed(tmp_path):
    source, cleaned = files(tmp_path)
    job = studio.Job(source, "silence", 50, True)

    def cross_drive(*_):
        raise OSError("[WinError 17] The system cannot move the file to a different disk drive")

    with (
        patch.object(job, "clean", return_value={"outputPath": str(cleaned)}),
        patch.object(studio.subprocess, "Popen", Whisper),
        patch.object(studio.os, "replace", cross_drive),
    ):
        job.run()
    assert job.phase == "done", job.error
    srt = Path(job.result["transcript"]["srt"])
    assert srt.read_text(encoding="utf-8") == "captions"
    assert srt.parent == tmp_path
    assert source.read_bytes() == b"original"
    # The working folder next to the VO is removed afterwards.
    assert not list(tmp_path.glob(".axis-transcript-*"))
    assert not job.control.exists()


def test_cancel_while_whisperx_is_starting_stops_it(tmp_path):
    source, cleaned = files(tmp_path)
    job = studio.Job(source, "silence", 50, True)
    entering = threading.Event()
    allow = threading.Event()
    killed = []

    class SlowStart(Whisper):
        returncode = None

        def __init__(self, args, **kwargs):
            entering.set()
            assert allow.wait(2)
            super().__init__(args, **kwargs)

    def kill(process):
        killed.append(process)
        if isinstance(process, SlowStart):
            process.returncode = 1

    job.process = Whisper.__new__(Whisper)  # The finished cleanup process.
    with (
        patch.object(job, "clean", return_value={"outputPath": str(cleaned)}),
        patch.object(studio.subprocess, "Popen", SlowStart),
        patch.object(studio, "kill", kill),
        patch.object(studio.time, "sleep", lambda _: None),
    ):
        worker = threading.Thread(target=job.run, daemon=True)
        worker.start()
        assert entering.wait(2)
        job.cancel()
        allow.set()
        worker.join(5)
    assert not worker.is_alive()
    assert job.phase == "cancelled"
    assert any(isinstance(process, SlowStart) for process in killed)


def test_server_module_loads_without_the_cleanup_engine():
    # The engine is imported on first use, so a missing package cannot stop the page opening.
    assert "axis_vo_cleanup" not in studio.__dict__
    assert isinstance(studio.engine, studio._Engine)
