"""Axis VO Studio: clean voice-overs without Premiere.

A small local web app. This server runs the same cleanup engine as the Premiere
panel (../premiere/tools/axis_vo_cleanup.py) and serves the page in index.html.
It only listens on 127.0.0.1 and every API call needs the token baked into the page.
"""
import json
import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HERE = Path(__file__).resolve().parent
TOOLS = HERE.parent / "premiere" / "tools"
sys.path.insert(0, str(TOOLS))
import axis_vo_cleanup as engine  # noqa: E402

PORT = int(os.environ.get("AXIS_VO_STUDIO_PORT", "8790"))
TOKEN = secrets.token_urlsafe(24)
DATA = Path(os.environ.get("LOCALAPPDATA", str(Path.home()))) / "AxisVOStudio"
SPEEDS = DATA / "speeds.json"
AUDIO_TYPES = {".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".aac": "audio/aac",
               ".flac": "audio/flac", ".ogg": "audio/ogg", ".opus": "audio/ogg", ".aif": "audio/aiff",
               ".aiff": "audio/aiff", ".wma": "audio/x-ms-wma", ".mp4": "video/mp4", ".mov": "video/quicktime",
               ".m4v": "video/mp4", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo", ".mxf": "application/mxf"}
MODE_LABELS = {"sandwich": "Silence, breaths, then silence", "both": "Silence, then breaths",
               "silence": "Silence only", "breaths": "Breaths only"}
NO_WINDOW = {"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt" else {}

lock = threading.Lock()
job = None          # The one running or last finished job.
served = set()      # Files the page may play: inputs and outputs of this session's jobs.


def load_speeds():
    try:
        return json.loads(SPEEDS.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_speed(key, value):
    speeds = load_speeds()
    # Blend with the last run so one odd run does not swing the estimate.
    speeds[key] = value if key not in speeds else speeds[key] * .5 + value * .5
    try:
        DATA.mkdir(parents=True, exist_ok=True)
        SPEEDS.write_text(json.dumps(speeds), encoding="utf-8")
    except OSError:
        pass


def audio_seconds(path):
    try:
        return engine.sf.info(str(path)).duration
    except Exception:  # Video files and odd formats: the estimate waits for real progress.
        return None


def kill(process):
    if process and process.poll() is None:
        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True, **NO_WINDOW)


class Job:
    def __init__(self, source, mode, keep_ms, transcript):
        self.source, self.mode, self.keep_ms, self.transcript = source, mode, keep_ms, transcript
        self.started = time.time()
        self.finished = None
        self.control = Path(tempfile.mkdtemp(prefix="axis-vo-studio-"))
        self.progress_file = self.control / "progress.json"
        self.cancel_file = self.control / "stop"
        self.process = None
        self.phase = "cleanup"
        self.transcript_percent = 0
        self.cancelled = False
        self.error = None
        self.result = None
        self.seconds = audio_seconds(source)
        self.speed_key = mode + ("+transcript" if transcript else "")
        # Share of the run spent cleaning when a transcript is also made. Breath modes
        # already transcribe once, so the two halves take about the same time.
        self.cleanup_share = 100 if not transcript else (12 if mode == "silence" else 50)

    def steps(self):
        try:
            data = json.loads(self.progress_file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            data = None
        labels = data["steps"] if data else [engine.STEP_LABELS[s] for s in engine.cleanup_steps(self.mode, None)]
        index = data["index"] if data else 0
        step_percent = data.get("stepPercent") if data else None
        cleanup_percent = data["percent"] if data else 0
        if self.transcript:
            labels = labels + ["Making the transcript"]
        if self.phase == "transcript":
            index, step_percent = len(labels) - 1, self.transcript_percent
            cleanup_percent = 100
        if self.phase == "done":
            index, cleanup_percent = len(labels), 100
        percent = cleanup_percent * self.cleanup_share / 100
        if self.transcript and self.phase == "transcript":
            percent += self.transcript_percent * (100 - self.cleanup_share) / 100
        if self.phase == "done":
            percent = 100
        return labels, index, step_percent, percent

    def snapshot(self):
        labels, index, step_percent, percent = self.steps()
        elapsed = (self.finished or time.time()) - self.started
        left = None
        if self.phase not in ("done", "failed", "cancelled"):
            if percent >= 5:
                left = elapsed * (100 - percent) / percent
            elif self.seconds:
                speed = load_speeds().get(self.speed_key)
                if speed:
                    left = max(0, speed * self.seconds - elapsed)
        return {"source": str(self.source), "mode": self.mode, "modeLabel": MODE_LABELS[self.mode],
                "keepMs": self.keep_ms, "transcript": self.transcript, "phase": self.phase,
                "steps": labels, "index": index, "stepPercent": step_percent, "percent": percent,
                "elapsed": elapsed, "secondsLeft": left, "audioSeconds": self.seconds,
                "cancelling": self.cancelled and self.phase not in ("done", "failed", "cancelled"),
                "error": self.error, "result": self.result}

    def cancel(self):
        self.cancelled = True
        try:
            self.cancel_file.write_text("stop", encoding="utf-8")
        except OSError:
            pass
        if self.phase == "transcript":
            kill(self.process)

    def run(self):
        try:
            self.result = self.clean()
            if self.transcript and not self.cancelled:
                self.phase = "transcript"
                self.result["transcript"] = self.make_transcript(Path(self.result["outputPath"]))
            if self.cancelled:
                raise RuntimeError("cancelled")
            self.phase = "done"
            if self.seconds:
                save_speed(self.speed_key, (time.time() - self.started) / self.seconds)
        except Exception as error:  # Shown on the page; the source file is never touched.
            if self.cancelled:
                self.phase, self.error = "cancelled", None
            else:
                self.phase, self.error = "failed", str(error)[-1500:]
        finally:
            self.finished = time.time()
            if self.result:
                files = [self.result.get(k) for k in ("outputPath", "silencePath", "breathsPath", "regionsPath")]
                files += list((self.result.get("transcript") or {}).values())
                for file in files:
                    if file:
                        served.add(os.path.normcase(str(Path(file).resolve())))
            shutil.rmtree(self.control, ignore_errors=True)

    def clean(self):
        command = [sys.executable, str(TOOLS / "axis_vo_cleanup.py"), "--input", str(self.source),
                   "--mode", self.mode, "--keep-ms", str(self.keep_ms),
                   "--cancel-file", str(self.cancel_file), "--progress-file", str(self.progress_file)]
        self.process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                        encoding="utf-8", errors="replace", **NO_WINDOW)
        out, err = self.process.communicate()
        if self.process.returncode != 0:
            raise RuntimeError((err or out or "Cleanup failed.").strip())
        try:
            return json.loads(out)
        except ValueError as error:
            raise RuntimeError("Cleanup gave no result. Check the audio folder before retrying.") from error

    def make_transcript(self, audio):
        """WhisperX on the finished file, so word times match the cleaned audio exactly."""
        work = self.control / "transcript"
        work.mkdir()
        log_path = work / "whisperx.log"
        with open(log_path, "wb") as log:
            self.process = subprocess.Popen(
                [sys.executable, "-u", "-m", "whisperx", str(audio), "--output_dir", str(work),
                 "--output_format", "all", "--model", "medium.en", "--compute_type", "int8",
                 "--batch_size", "8", "--device", "cpu", "--print_progress", "True"],
                stdout=log, stderr=subprocess.STDOUT, **NO_WINDOW)
            raw, aligning, read_at = None, False, 0
            while self.process.poll() is None:
                time.sleep(1)
                with open(log_path, "rb") as reader:
                    reader.seek(read_at)
                    chunk = reader.read()
                end = chunk.rfind(b"\n") + 1
                read_at += end
                percent, raw, aligning = engine.whisperx_percent(chunk[:end].decode("utf-8", "replace"),
                                                                 raw, aligning)
                if percent is not None:
                    # Hold alignment at 95: its own number is not shown, see TRANSCRIBE_SHARE.
                    self.transcript_percent = 95 if aligning else percent * 95 / engine.TRANSCRIBE_SHARE
        if self.cancelled:
            raise RuntimeError("cancelled")
        if self.process.returncode != 0:
            tail = log_path.read_text(encoding="utf-8", errors="replace")[-1200:]
            raise RuntimeError("Transcript failed. The cleaned audio is saved.\n" + tail)
        saved = {}
        for extension in ("srt", "txt", "json", "vtt"):
            made = work / (audio.stem + "." + extension)
            if made.exists():
                target = audio.with_name(audio.stem + "_transcript." + extension)
                os.replace(made, target)
                saved[extension] = str(target)
        if "srt" not in saved:
            raise RuntimeError("WhisperX made no transcript. The cleaned audio is saved.")
        return saved


def checked_audio(value):
    if not isinstance(value, str) or not value.strip() or "\0" in value:
        raise ValueError("Choose an audio file.")
    path = Path(value.strip().strip('"'))
    if not path.is_file():
        raise ValueError("That file was not found.")
    if path.suffix.lower() not in AUDIO_TYPES:
        raise ValueError("Choose an audio or video file (wav, mp3, m4a, flac, mov, mp4...).")
    return path.resolve()


def pick_file():
    import tkinter
    from tkinter import filedialog
    root = tkinter.Tk()
    root.withdraw()
    root.attributes("-topmost", True)
    try:
        return filedialog.askopenfilename(
            parent=root, title="Choose a voice-over",
            filetypes=[("Audio and video", " ".join("*" + e for e in AUDIO_TYPES)), ("All files", "*.*")])
    finally:
        root.destroy()


def setup_problem(needs_whisperx=False):
    """Return a plain message when Python is missing a package Clean VO needs, else None."""
    import importlib.util as util
    missing = [m for m in ("numpy", "soundfile", "pydub") if not util.find_spec(m)]
    if missing:
        return "Clean VO needs " + ", ".join(missing) + ". Run: py -3.12 -m pip install numpy soundfile pydub==0.25.1"
    if needs_whisperx and not util.find_spec("whisperx"):
        return "Breath cleanup and transcripts need WhisperX. Run: py -3.12 -m pip install whisperx"
    return None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send(self, status, body, content_type="application/json"):
        data = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def allowed(self, query=None):
        # Block other websites (no token) and DNS rebinding (wrong Host).
        if self.headers.get("Host") not in (f"127.0.0.1:{PORT}", f"localhost:{PORT}"):
            return False
        token = self.headers.get("X-Axis-Token") or (query or {}).get("token", [""])[0]
        return secrets.compare_digest(token, TOKEN)

    def do_GET(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        if url.path == "/":
            if self.headers.get("Host") not in (f"127.0.0.1:{PORT}", f"localhost:{PORT}"):
                return self.send(403, {"error": "Forbidden"})
            page = (HERE / "index.html").read_text(encoding="utf-8").replace("__AXIS_TOKEN__", TOKEN)
            return self.send(200, page.encode("utf-8"), "text/html; charset=utf-8")
        if not self.allowed(query):
            return self.send(403, {"error": "Forbidden"})
        if url.path == "/api/status":
            with lock:
                return self.send(200, {"job": job.snapshot() if job else None, "setup": setup_problem()})
        if url.path == "/api/audio":
            return self.audio(query.get("path", [""])[0])
        self.send(404, {"error": "Not found"})

    def audio(self, value):
        path = Path(value)
        if os.path.normcase(str(path.resolve())) not in served or not path.is_file():
            return self.send(404, {"error": "Not available"})
        size = path.stat().st_size
        start, end = 0, size - 1
        ranged = self.headers.get("Range", "")
        if ranged.startswith("bytes="):
            first, _, last = ranged[6:].split(",")[0].partition("-")
            if first:
                start, end = int(first), int(last) if last else size - 1
            elif last:
                start = max(0, size - int(last))
            end = min(end, size - 1)
            if start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
        self.send_response(206 if ranged else 200)
        self.send_header("Content-Type", AUDIO_TYPES.get(path.suffix.lower(), "application/octet-stream"))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        if ranged:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        with open(path, "rb") as file:
            file.seek(start)
            remaining = end - start + 1
            try:
                while remaining > 0:
                    chunk = file.read(min(1 << 20, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
            except (ConnectionError, OSError):
                pass  # The player seeked away.

    def do_POST(self):
        global job
        url = urlparse(self.path)
        if not self.allowed():
            return self.send(403, {"error": "Forbidden"})
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)) or b"{}")
        except ValueError:
            return self.send(400, {"error": "Bad request"})
        try:
            if url.path == "/api/pick":
                chosen = pick_file()
                if chosen:
                    path = checked_audio(chosen)
                    served.add(os.path.normcase(str(path)))
                    return self.send(200, {"path": str(path), "seconds": audio_seconds(path)})
                return self.send(200, {"path": None})
            if url.path == "/api/check":
                path = checked_audio(body.get("path"))
                served.add(os.path.normcase(str(path)))
                return self.send(200, {"path": str(path), "seconds": audio_seconds(path)})
            if url.path == "/api/run":
                source = checked_audio(body.get("path"))
                mode, keep_ms = body.get("mode"), body.get("keepMs")
                if mode not in MODE_LABELS or not isinstance(keep_ms, int) or not 0 <= keep_ms <= 5000:
                    raise ValueError("Choose a cleanup mode and 0-5000 ms of kept silence.")
                problem = setup_problem(mode != "silence" or body.get("transcript") is True)
                if problem:
                    raise ValueError(problem)
                with lock:
                    if job and job.phase in ("cleanup", "transcript"):
                        raise ValueError("A VO is already being cleaned. Wait for it or cancel it.")
                    served.add(os.path.normcase(str(source)))
                    job = Job(source, mode, keep_ms, body.get("transcript") is True)
                    threading.Thread(target=job.run, daemon=True).start()
                return self.send(200, {"ok": True})
            if url.path == "/api/cancel":
                with lock:
                    if job:
                        job.cancel()
                return self.send(200, {"ok": True})
            if url.path in ("/api/open", "/api/reveal"):
                path = Path(body.get("path") or "")
                if os.path.normcase(str(path.resolve())) not in served or not path.exists():
                    raise ValueError("That file is not available.")
                if url.path == "/api/open":
                    os.startfile(str(path))
                else:
                    subprocess.Popen(["explorer", "/select,", str(path)])
                return self.send(200, {"ok": True})
        except ValueError as error:
            return self.send(400, {"error": str(error)})
        self.send(404, {"error": "Not found"})


def main():
    url = f"http://127.0.0.1:{PORT}/"
    try:
        server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError:
        webbrowser.open(url)  # Already running: just show it.
        return
    if "--no-browser" not in sys.argv:
        threading.Timer(.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    finally:
        with lock:
            if job:
                job.cancel()


if __name__ == "__main__":
    main()
