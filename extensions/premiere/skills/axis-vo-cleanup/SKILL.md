---
name: axis-vo-cleanup
description: Clean a chosen voice-over file with silence removal, breath attenuation, or both, preserving originals and optionally placing a checkpointed copy below the selected VO.
---

# Axis VO cleanup

Use **Menu > Clean VO** for the normal one-action panel flow. Choose a file or one
audio item in the Project panel. Never interpret transcript cleanup cuts as file
cleanup: these are different operations.

For agent execution, resolve `tools/axis_vo_cleanup.py` from the installed Axis
extension. Run it with the Python interpreter used by Axis Transcription setup:

```text
python <extension>/tools/axis_vo_cleanup.py --input <audio> --mode both --keep-ms 50
```

Modes are `silence`, `breaths`, and `both`. Outputs always have unique names next
to the source. `--output-dir` can isolate test artifacts. Never edit source media,
reference transcripts or CSVs. Silence defaults are pydub split_on_silence,
100 ms minimum, -45 dBFS, 50 ms retained; only an empty split triggers the
source dBFS minus 16 fallback. Do not silently substitute other thresholds.

Breath detection uses the project-49 rules. It attenuates regions by -40 dB with
10 ms raised-cosine fades. It preserves channels, sample rate, sample count and
all samples outside the regions. Lossy input is decoded first. It reuses Axis's
WhisperX invocation and `axis_transcript.py` timing parser. Both mode always
transcribes the silence-removed file. `--transcript` accepts an existing matching
WhisperX or sentences JSON only for breaths-only runs; never reuse source timings
after silence removal. No automatic package installs.

Read the JSON result and report the saved path, duration change and region count.
Optional project-bin import belongs to the panel's explicit import action. This
CLI workflow never changes the timeline. The panel's **Import into timeline**
checkbox and **Clean VO** action explicitly confirm placement on exactly one new
track directly below the selected VO. Never overwrite existing tracks. Require a
verified single mono or stereo mapping; refuse separate mono, surround, unknown
mappings, retimed or reversed clips, and a locked VO track or audio track below it.
Capture project, sequence, clip and track IDs plus timing at selection and refuse
placement if the instance changed. Distinct instances of the same file are
ambiguous. Explicitly linked mono channels with the same source and timing count
as one instance; anchor the bottom selected channel.

Use the existing Axis sequence checkpoint system before any timeline mutation.
Verify source points with media type 2, placement start/end/in/out, and the full
identity and timing of every existing audio/video clip. Restore the checkpoint
automatically on any placement failure. **Undo placement** restores the verified
checkpoint and original track layout, and refuses later timeline edits. Retain
Undo until restoration is verified. The changed sequence and any added track
remain in **Axis checkpoints**. Never retry a timed-out timeline mutation: tell
the user to check the timeline and use Premiere Undo.

WhisperX has a five-hour bound. The CLI supervises the worker and its descendants,
stopping before CEP's six-hour timeout and removing reserved outputs and temporary
files on failure. `--cancel-file <path>` stops gracefully when that file exists;
`--timeout-seconds` can shorten the overall bound for testing. Never raise it.
