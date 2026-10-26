---
name: axis-vo-cleanup
description: Clean a chosen voice-over file with silence removal, breath attenuation, or both, preserving originals and leaving the Premiere timeline alone.
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
workflow never changes the timeline. Any later timeline replacement needs the
normal preview, confirmation and Axis checkpoint/undo flow.
