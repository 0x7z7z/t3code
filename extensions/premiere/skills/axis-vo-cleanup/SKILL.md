---
name: axis-vo-cleanup
description: Clean a chosen voice-over file with silence removal, breath attenuation, or silence-breaths-silence, preserving originals and optionally placing a checkpointed copy relative to the current VO.
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

Modes are `silence`, `breaths`, `both` (silence then breaths), and `sandwich`
(silence, breaths, then silence). The final silence pass uses the same `--keep-ms`
and the post-first-pass word timings, since breath rendering preserves sample count.
Outputs always have unique names next
to the source. `--output-dir` can isolate test artifacts. Never edit source media,
reference transcripts or CSVs. Silence defaults are pydub split_on_silence,
100 ms minimum, -45 dBFS, 50 ms retained; only an empty split triggers the
source dBFS minus 16 fallback. Do not silently substitute other thresholds.
Cut edges extend up to 120 ms over sibilant audio (above -60 dB with an above-2 kHz
share over .93) or still-voiced audio above -45 dB. Breaths, weak f/th/h and room
hiss share the .60-.93 band, so audio alone must not extend over them: on project
49's raw VO that loosened rule kept 10.8 s more and lost 69 of 593 cuts. The final
pass protects weak fricatives by spelling, using word timings.
Keep `_SilenceRemoved.wav`, `_NoBreaths.wav`, and the final
`_SilenceBreathsSilence.wav` intermediates. The breath CSV addresses `_NoBreaths.wav`,
before the last length-changing pass.

Breath detection uses the project-49 rules. It attenuates regions by -40 dB with
10 ms raised-cosine fades. It preserves channels, sample rate, sample count and
all samples outside the regions. Lossy input is decoded first. It reuses Axis's
WhisperX invocation and `axis_transcript.py` timing parser. Both mode always
transcribes the silence-removed file, as does `sandwich`. `--transcript` accepts an existing matching
WhisperX or sentences JSON only for breaths-only runs; never reuse source timings
after silence removal. Breath ends stay 80 ms before a fricative-starting word,
with extra audio-based trimming for sibilant or louder fricative onsets. Do not
change the project-49 candidate rules or attenuation. No automatic package installs.

Read the JSON result and report the saved path, duration change and region count.
Optional project-bin import belongs to the panel's explicit import action. This
CLI workflow never changes the timeline. The panel's **Import into timeline**
checkbox and **Clean VO** action explicitly confirm placement. Resolve a Browse
or typed source against media paths on the active sequence. Use the only instance,
or the exactly one selected instance when several exist. Otherwise ask which VO
to select. Explicitly linked mono channels with the same source and timing count
as one instance; anchor the bottom channel.

Re-resolve by clip nodeId, falling back to media path plus timeline position.
Follow moved tracks, timeline starts and current trims. Refuse deleted or ambiguous
instances, wrong projects/sequences and retimed/reversed VOs; name the problem.
Locked tracks do not block placement: the destination is a new, verified, unlocked
track and locked clips are only read. Import a fresh project item and repair only
its channel mapping to one mono/stereo clip, then read it back. Never change the
user's original item. Unsettable or unknown mappings must refuse placement.

Prefer one new track directly below the current VO. If QE creates a safely verified
empty track elsewhere, try an entirely empty unlocked track below the VO or a
verified bottom insertion. Verify all original tracks after every insertion.
Never overwrite an existing clip or rename a reused existing track. Report the
actual audio track, start in seconds and fallback reason. Breath-only placement
uses the current source trim; all silence modes start the full cleaned file at
the current VO start without keepTiming.

Use the existing Axis sequence checkpoint system before any timeline mutation.
Verify source points with media type 2, placement start/end/in/out, and the full
identity and timing of every existing audio/video clip. Restore the checkpoint
automatically on any placement failure. **Undo placement** restores the verified
checkpoint and original track layout, and refuses later timeline edits. Retain
Undo until restoration is verified. Read-only lookups retry up to three times
with short waits; never retry a mutation automatically. The changed sequence and any added track
remain in **Axis checkpoints**. Never retry a timed-out timeline mutation: tell
the user to check the timeline and use Premiere Undo.

WhisperX has a five-hour bound. The CLI supervises the worker and its descendants,
stopping before CEP's six-hour timeout and removing reserved outputs and temporary
files on failure. `--cancel-file <path>` stops gracefully when that file exists;
`--timeout-seconds` can shorten the overall bound for testing. Never raise it.
