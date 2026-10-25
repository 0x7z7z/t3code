---
name: axis-music-placement
description: Score a transcribed Axis Premiere sequence from a local music library, review chapter cues, and apply levels, fades and voice-over ducking with a sequence checkpoint. Use for music placement or "score this video" inside Axis.
---

# Axis music placement

Use Axis's bundled `premiere` capabilities and private CEP bridge only. Discover tools with `mcp__premiere__get_capabilities`. Never use the standalone premiere-pro MCP or start another bridge. Respect Plan mode and the session's editing permissions.

Read the active project and sequence, then the sequence-time word transcript. Do not score guessed timing or an untranscribed voice-over. Transcript > options > Music is the normal editor entry point. That panel remembers the library folder and mix settings per project and validates source duration before applying.

## Index and describe

Use the shipped `tools/axis_music.py` beside `axis_transcript.py`, resolved from the Axis extension directory, never an assumed installation path:

```text
python <extension>/tools/axis_music.py index --root <library> --limit 100 --compact
```

Repeat until `pending` is zero. Each analyzed file is independently committed to `%LOCALAPPDATA%/PremiereAssistant/music-index/v1/tracks.sqlite`, keyed by full path, size and nanosecond mtime. `--compact` keeps envelopes in the cache and returns measured events without thousands of energy arrays. Broken files are cached too, so they cannot starve later batches; use `--retry-failures` after fixing a decoder or media issue. Do not rename or clear the parent cache. `--cache <file>` is available for isolated tests. Library media are read-only. The AnimeAddicts default is `D:\0. PROJECTS\~ AnimeAddicts\~ AnimeAddicts Editing Template\7. Music`; verify it exists. Other projects need their own folder.

The index contains RMS loudness in dBFS (not LUFS), second-resolution energy, measured rises, loud windows, quiet ranges and energy-based phrase candidates. These are audition points, not evidence of genre, mood or a real musical drop. Tempo is a cheap onset-autocorrelation estimate over up to 90 seconds, unknown when evidence is weak; verify it before beat edits.

Antigravity's Axis adapter supports audio attachments. With a Gemini model selected, the Music panel's **Describe library** sends up to three real 30-second track excerpts to that agent. Listen to those attachments, describe audible mood/genre/instrumentation and coverage honestly, then save the description for the exact indexed fingerprint:

```text
python <extension>/tools/axis_music.py describe --path <track> --fingerprint <indexed fingerprint> --description <short description mentioning excerpt coverage> --tags <JSON string array>
```

Refresh the library index and repeat for the next batch. Do not claim full-track listening from an excerpt. For providers without audio input, use folder categories, measured energy and optional user tags as hints and explicitly mark mood unverified. Never infer listening from a filename. A changed file invalidates its old description.

## Editorial plan

- The voice-over always wins. Start around -22 dB, then audition masking; this is not a universal loudness guarantee.
- Prefer a coherent bed for a whole chapter. Change tracks only on a genuine narration pivot, not every paragraph.
- Align actual measured rises or phrase candidates to reveals, jokes, action, emotional pivots and the outro. Give exact offsets and never invent a drop.
- Avoid repeating tracks. Do not silently loop a short source.
- Use deliberate silence where it helps. Put every sponsor interval in `silence`; preserve the sponsor's supplied audio. Ask for exact sponsor boundaries if uncertain.
- Leave enough source duration after the offset. Include explicit reasons and transitions; audition each shortlisted track.

Emit this JSON in an `axis-music` fence. The panel renders a review table and **Review music** opens the full Music panel:

```axis-music
{"version":1,"cues":[{"id":"music-1","chapter":"Opening reveal","start":0,"end":45,"track":"D:/Music/exact-file.wav","sourceOffset":12,"reason":"Measured source rise at 18s maps to the reveal at sequence 6s; mood checked in attached excerpt.","fadeIn":1,"fadeOut":1.5,"baseDb":-22,"enabled":true,"alternatives":[]}],"silence":[{"start":45,"end":60,"reason":"Sponsor audio only"}]}
```

Alternatives contain at most three `{track,sourceOffset,reason}` objects. All times are sequence seconds except source offsets. Positive ranges, no overlapping enabled cues, no repeated tracks, and no cue crossing silence are required. Excluded cues remain in the plan with `enabled:false`.

## Review, apply and undo

Prefer the panel: index, build or open the plan, audition, swap/toggle/nudge cues, set fade lengths and duck depth/attack/release, validate against the timeline, then review the confirmation and Apply. Sponsor exclusions entered in settings require rebuilding the deterministic plan. Defaults are -8 dB duck, 0.25s attack, 0.6s release and merged short speech gaps.

For an explicitly authorized agent apply, discover the registered CEP execute-script tool. The panel registers ES3 `$.global.axisMusicOperation(request)`. If missing, use the panel instead. `apply` requires `projectId`, `sequenceId`, `confirmed:true`, a fresh Axis timeline snapshot `expectedSignature`, and sorted `cues` containing `track,start,end,sourceOffset,keys:[{time,value}]`. Key times are cue-relative seconds; values are linear amplitude gains, not normalized Premiere Level values. Generate fades and ducking from the transcript speech regions, merge gaps shorter than attack+release, and bound every key to its cue. The host applies Premiere's Level normalization and source-time conversion. Never pass raw dB as a key value.

The result is `axis:music|applied` or `partial`, followed by URI-encoded `checkpointId`, `checkpointSignature`, `expectedSignature`, `message`, `sequenceId`. Retain all fields. `partial` means stop and offer Undo before retrying, since some changes may exist. Undo passes `{action:'undo',projectId,sequenceId,checkpointId,checkpointSignature,expectedSignature}` and opens the pre-music sequence clone while preserving the scored version. It restores the timeline; imported sources remain in the Music bin. Later timeline changes can prevent a checkpoint swap.

All music goes on an empty dedicated Music audio track. The host can attempt QE track creation; if unavailable, have the editor add an empty Music track. Never place music on a populated VO or SFX track. Verify transitions, source offsets, audible fades and VO masking in live Premiere before final export.
