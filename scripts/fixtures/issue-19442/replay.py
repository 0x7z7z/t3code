#!/usr/bin/env python3
"""Serve the recording fixture or measure a real server-produced recording."""

import argparse
import json
from pathlib import Path
import statistics
import subprocess
import sys

parser = argparse.ArgumentParser(description=__doc__)
commands = parser.add_subparsers(dest="command", required=True)
serve = commands.add_parser("serve", help="Serve moving.html and idle.html")
serve.add_argument("--port", type=int, default=19443)
probe = commands.add_parser("probe", help="Inspect decoded timestamps, not nominal r_frame_rate")
probe.add_argument("recording", type=Path)
args = parser.parse_args()

if args.command == "serve":
    subprocess.run(
        [sys.executable, "-m", "http.server", str(args.port), "--bind", "127.0.0.1",
         "--directory", str(Path(__file__).resolve().parent)],
        check=True,
    )
else:
    result = json.loads(subprocess.check_output([
        "ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames",
        "-show_entries",
        "stream=codec_name,width,height,avg_frame_rate,nb_read_frames,duration:frame=best_effort_timestamp_time",
        "-show_frames", "-of", "json", str(args.recording),
    ]))
    timestamps = [float(frame["best_effort_timestamp_time"]) for frame in result["frames"]]
    intervals = [(right - left) * 1000 for left, right in zip(timestamps, timestamps[1:])]
    result.pop("frames")
    result["timestampsSeconds"] = timestamps
    result["intervalsMs"] = intervals
    result["medianIntervalMs"] = statistics.median(intervals) if intervals else None
    result["sub33_333msIntervals"] = sum(interval < 33.333 for interval in intervals)
    result["sub25msIntervals"] = sum(interval < 25 for interval in intervals)
    end = 0
    peak = 0
    for start, timestamp in enumerate(timestamps):
        while end < len(timestamps) and timestamps[end] < timestamp + 1:
            end += 1
        peak = max(peak, end - start)
    result["peakFramesInSlidingSecond"] = peak
    print(json.dumps(result, indent=2))
