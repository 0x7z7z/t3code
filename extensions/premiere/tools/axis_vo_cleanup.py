#!/usr/bin/env python3
"""Clean a VO into new lossless WAV files. Never edits a source or a timeline.

Silence settings match Remove Silence From Audio. Breath selection and rendering
match project 49's detect.py, pick_breaths.py and render.py, with bounded memory.
"""
import argparse
import csv
import json
import math
from pathlib import Path
import subprocess
import sys
import tempfile
import uuid

import numpy as np
import soundfile as sf

from axis_transcript import timed_words


def measure_frames(source):
    with sf.SoundFile(source) as audio:
        sr = audio.samplerate
        hop, win = int(sr * .01), int(sr * .02)
        if hop < 1 or win < 2:
            raise ValueError("Unsupported sample rate")
        # The reference excludes the final partial/terminal window.
        count = max(0, (len(audio) - win) // hop)
        rms, hf = np.empty(count), np.empty(count)
        window = np.hanning(win)
        high = np.fft.rfftfreq(win, 1 / sr) > 2000
        for offset in range(0, count, 2048):
            size = min(2048, count - offset)
            audio.seek(offset * hop)
            mono = audio.read((size - 1) * hop + win, always_2d=True).mean(1)
            frames = np.lib.stride_tricks.sliding_window_view(mono, win)[::hop][:size] * window
            rms[offset:offset + size] = 20 * np.log10(np.sqrt((frames ** 2).mean(1)) + 1e-9)
            spectrum = np.abs(np.fft.rfft(frames, axis=1))
            hf[offset:offset + size] = spectrum[:, high].sum(1) / (spectrum.sum(1) + 1e-9)
    return rms, hf, sr


def select_breaths(rms, hf, sr, words):
    hop = int(sr * .01)
    counted = (rms > -50) & (rms < -34) & (hf > .6)
    closed = counted.copy()
    for k in (1, 2):
        closed[k:-k] |= counted[:-2 * k] & counted[2 * k:]
    changes = np.diff(np.r_[False, closed, False].astype(np.int8))
    selected = []
    for i, j in zip(np.where(changes == 1)[0], np.where(changes == -1)[0]):
        a, b = i * hop / sr + .01, (j - 1) * hop / sr + .01 + .01
        if not .09 <= b - a <= .7:
            continue
        sl = slice(int(a * 100), int(b * 100))
        if not (rms[sl].mean() < -40.5 and .6 < hf[sl].mean() < .93):
            continue
        inside = [w for w in words if w["start"] < a < w["end"] - .01]
        if inside:
            word = inside[0]
            if (word["word"][-1] not in '.,?!;:"' or
                    (a - word["start"]) / (word["end"] - word["start"]) < .4):
                continue
        overlap = sum(max(0, min(b, w["end"]) - max(a, w["start"])) for w in words)
        # WhisperX edges have the same 40/60 ms tolerance as pick_breaths.py.
        if overlap > .06 and any(a < w["start"] < b - .04 for w in words):
            continue
        previous = [w for w in words if w["start"] < a - .01]
        if not previous or previous[-1]["word"][-1] not in '.,?!;:"':
            continue
        selected.append({"a": a, "b": b,
                         "prev": max((w["end"] for w in words if w["end"] <= a + .02), default=0),
                         "next": min((w["start"] for w in words if w["start"] > a + .02), default=math.inf)})
    return selected


def breath_regions(source, words):
    rms, hf, sr = measure_frames(source)
    selected = select_breaths(rms, hf, sr, words)
    regions = []
    with sf.SoundFile(source) as audio:
        def level(t):
            audio.seek(min(len(audio), max(0, int(t * sr))))
            mono = audio.read(max(1, int(.005 * sr)), always_2d=True).mean(1)
            return 20 * np.log10(np.sqrt((mono ** 2).mean()) + 1e-9) if len(mono) else -math.inf
        for candidate in selected:
            a = max(candidate["a"] - .02, candidate["prev"] + .005)
            b = min(candidate["b"] + .03, candidate["next"] - .02)
            # Never undo the word-boundary clamps to rescue a short candidate.
            if b - a < .07:
                continue
            while b - a > .06 and level(a) > -38:
                a += .005
            while b - a > .06 and level(b - .005) > -38:
                b -= .005
            if b - a < .07 or max(level(t) for t in np.arange(a, b - .005, .005)) > -30:
                continue
            regions.append((int(a * sr), int(b * sr)))
    return regions, sr


def render_breaths(source, destination, regions):
    """Only mutate region slices; retain sample format, channels and sample count."""
    with sf.SoundFile(source) as audio:
        subtype = audio.subtype
        formats = {"PCM_U8": ("int16", 256), "PCM_16": ("int16", 1),
                   "PCM_24": ("int32", 256), "PCM_32": ("int32", 1),
                   "FLOAT": ("float32", 1), "DOUBLE": ("float64", 1)}
        if subtype not in formats:
            raise ValueError("Breath rendering requires lossless PCM or float audio")
        dtype, quantum = formats[subtype]
        floor, fade = 10 ** (-40 / 20), max(1, int(.01 * audio.samplerate))
        with sf.SoundFile(destination, "w", samplerate=audio.samplerate, channels=audio.channels,
                          format="WAV", subtype=subtype) as output:
            offset = 0
            for block in audio.blocks(blocksize=65536, dtype=dtype, always_2d=True):
                gain = np.ones(len(block))
                for a, b in regions:
                    lo, hi = max(a, offset), min(b, offset + len(block))
                    if hi <= lo:
                        continue
                    pos = np.arange(lo, hi) - a
                    envelope = np.full(hi - lo, floor)
                    fd = min(fade, (b - a) // 2)
                    if fd > 1:
                        rise = .5 - .5 * np.cos(np.linspace(0, np.pi, fd))
                        head, tail = pos < fd, pos >= b - a - fd
                        envelope[head] = 1 - (1 - floor) * rise[pos[head]]
                        envelope[tail] = floor + (1 - floor) * rise[pos[tail] - (b - a - fd)]
                    gain[lo - offset:hi - offset] = np.minimum(gain[lo - offset:hi - offset], envelope)
                changed = gain != 1
                values = block[changed].astype(np.float64) * gain[changed, None]
                if dtype.startswith("int"):
                    values = np.round(values / quantum) * quantum
                block[changed] = values.astype(dtype)
                output.write(block)
                offset += len(block)


def remove_silence(source, destination, keep_ms=50):
    from pydub import AudioSegment
    from pydub.silence import split_on_silence
    sound = AudioSegment.from_file(source)
    chunks = split_on_silence(sound, min_silence_len=100, silence_thresh=-45, keep_silence=keep_ms)
    if not chunks:
        chunks = split_on_silence(sound, min_silence_len=100, silence_thresh=sound.dBFS - 16,
                                 keep_silence=keep_ms)
    combined = AudioSegment.empty()
    for chunk in chunks:
        combined += chunk
    if len(combined) == 0:
        combined = sound
    combined.export(destination, format="wav")


def load_words(filename, duration):
    words, _ = timed_words(json.loads(Path(filename).read_text(encoding="utf-8-sig")))
    if not words or any(w["end"] > duration + .1 for w in words):
        raise ValueError("Word timings must match the audio being cleaned")
    return sorted(words, key=lambda w: (w["start"], w["end"]))


def transcribe_words(source, directory):
    # Use Axis's existing WhisperX command and timing parser, on the post-silence audio.
    result = subprocess.run([sys.executable, "-m", "whisperx", str(source), "--output_dir", str(directory),
                             "--output_format", "json", "--model", "medium.en", "--compute_type", "int8",
                             "--batch_size", "8", "--device", "cpu"], capture_output=True,
                            encoding="utf-8", errors="replace")
    if result.returncode:
        raise ValueError("WhisperX failed. Check Transcription setup in Axis Diagnostics. " + result.stderr[-500:])
    return directory / (source.stem + ".json")


def cleanup(source, mode="both", keep_ms=50, transcript=None, output_dir=None):
    source = Path(source).resolve(strict=True)
    if mode not in ("silence", "breaths", "both") or type(keep_ms) is not int or not 0 <= keep_ms <= 5000:
        raise ValueError("Choose silence, breaths or both, and 0-5000 ms retained silence")
    if transcript and mode == "both":
        raise ValueError("Both mode transcribes after silence removal; source timings cannot be reused")
    folder = Path(output_dir).resolve() if output_dir else source.parent
    folder.mkdir(parents=True, exist_ok=True)
    # Exclusive creation reserves every output; even concurrent runs cannot overwrite files.
    base = folder / (source.stem + "_AxisVO_" + uuid.uuid4().hex[:12])
    reserved = []

    def reserve(suffix):
        filename = Path(str(base) + suffix)
        with filename.open("xb"):
            pass
        reserved.append(filename)
        return filename

    try:
        with tempfile.TemporaryDirectory(prefix="axis-vo-", dir=folder) as temporary:
            temporary = Path(temporary)
            current = source
            try:
                info = sf.info(current)
                if info.subtype not in ("PCM_U8", "PCM_16", "PCM_24", "PCM_32", "FLOAT", "DOUBLE"):
                    raise ValueError("Decode compressed audio first")
            except (sf.LibsndfileError, ValueError):
                from pydub import AudioSegment
                current = temporary / "decoded.wav"
                AudioSegment.from_file(source).export(current, format="wav")
                info = sf.info(current)
            before = info.duration
            silence_path = None
            if mode in ("silence", "both"):
                silence_path = reserve("_SilenceRemoved.wav")
                remove_silence(current, silence_path, keep_ms)
                current = silence_path
            regions = []
            csv_path = None
            if mode in ("breaths", "both"):
                timing_path = Path(transcript) if transcript else transcribe_words(current, temporary)
                words = load_words(timing_path, sf.info(current).duration)
                regions, sr = breath_regions(current, words)
                destination = reserve("_NoBreaths.wav")
                render_breaths(current, destination, regions)
                current = destination
                csv_path = reserve("_breaths.csv")
                with csv_path.open("w", newline="", encoding="utf-8") as handle:
                    writer = csv.writer(handle)
                    writer.writerow(["start_s", "end_s", "dur_s", "start_sample", "end_sample"])
                    writer.writerows([(round(a / sr, 3), round(b / sr, 3), round((b - a) / sr, 3), a, b)
                                      for a, b in regions])
            result = {"outputPath": str(current), "silencePath": str(silence_path) if silence_path else None,
                      "regionsPath": str(csv_path) if csv_path else None, "regions": len(regions),
                      "beforeSeconds": before, "afterSeconds": sf.info(current).duration}
            return result
    except BaseException:
        for filename in reserved:
            filename.unlink(missing_ok=True)
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--mode", choices=("silence", "breaths", "both"), default="both")
    parser.add_argument("--keep-ms", type=int, default=50)
    parser.add_argument("--transcript", type=Path, help="Existing source word timings, breaths-only mode")
    parser.add_argument("--output-dir", type=Path, help="Test/artifact override; default is beside source")
    args = parser.parse_args()
    try:
        print(json.dumps(cleanup(args.input, args.mode, args.keep_ms, args.transcript, args.output_dir)))
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
