---
name: axis-music-placement
description: Place one mood-matched library song per script section in Axis, back to back with crossfades, peak-based levels and checkpoint undo. No ducking by default.
---

# Axis music placement

Use Axis's bundled Premiere capabilities and private CEP bridge only. Never use the standalone premiere-pro MCP or another bridge. Read the active project, sequence and sequence-time VO transcript. Do not guess timings.

## One-click panel flow

Transcript > Music remembers the library folder and indexes it automatically in the background. **Place music** sends a focused planning request to the selected chat agent. Return the requested `axis-music` fence with the exact `requestId`; do not write the timeline from that planning turn. The panel validates the fresh timeline, checkpoints, applies, and shows section / time / mood / song rows with **Swap** and **Undo all**. The user's click plus checkpoint and Undo is the confirmation for this flow. Other timeline changes still require preview/confirmation.

Divide the VO by script subject, character or object. Sections are usually 30-90 seconds, but time alone never causes a change. Keep the same character together until the story's emotional context changes; land every change on a section boundary. Merge neighbouring subjects shorter than about 28 seconds when they share a theme and mood, such as three short fusion characters into Fusions. Optional `theme` labels let the panel merge these before placement. Read the meaning: a loss is sad, Jiren vs Goku can be hype, ominous lore can be tense. Give each section a label, mood and energy from 0 to 1.

Use one matching song per section, contiguous with the next. A song can recur later, but never in neighbouring sections, including existing music at either edge. Start every song at source zero. Trim to the section; never loop, stretch, or overrun the source. Cover the whole sequence by default, transcript selection first or sequence in/out second. Exclude sponsor audio explicitly.

## Mood catalogue and index

The library folder is the primary mood signal, overriding broad machine tags:

- `calm music`: normal explanation, breathing room, reflection without genuine loss.
- `dark cinematic music`: tension, danger, reveals, ominous lore and showdowns.
- `hype music`: intro, fights, phonk and high energy.
- `sad music`: genuine loss, melancholy and emotional reflection.
- Never select anything inside `00. duplicate copies - review`.
- `00. unsorted - review` is a last resort when sorted candidates cannot fit.

The AnimeAddicts default is `D:\0. PROJECTS\~ AnimeAddicts\~ AnimeAddicts Editing Template\7. Music`. Read `AGENTS.md/MUSIC_LIBRARY_CATALOGUE_AND_ANALYSIS.md` and sibling `audio_mood_analysis.json` if present. Duration, BPM, energy and brightness are secondary hints within the needed mood. The helper reads these automatically. Never modify the library, its catalogue, or audio files. Other projects remember their own folder. Gemini descriptions are not required.

Resolve `tools/axis_music.py` from the installed Axis extension directory:

```text
python <extension>/tools/axis_music.py index --root <library> --limit 100 --compact
```

Repeat until `pending` is zero. Each file is independently cached by fingerprint in `%LOCALAPPDATA%/PremiereAssistant/music-index/v1/tracks.sqlite`. Do not clear or rename its parent. `--cache <file>` isolates tests. Failed sources are cached; retry after fixing them with `--retry-failures`. Duplicate-review folders are excluded before decoding. Measured energy is not a mood label; BPM is approximate. Optional listener descriptions belong to the exact indexed fingerprint, never invented listening.

The index measures the full-source, all-channel sample peak before downmixing for structure analysis. The channel SOP is Normalize All Peaks to about -32 to -35 dBFS. ExtendScript cannot set audio gain, so use the constant target **-33 dBFS** and clip Volume Level `min(15, -33 - peakDbfs)`. Do not use RMS in this formula. Fail closed if peak measurement is missing. Do not copy Hard Limiter effects or alter existing clips. Ducking is off; the panel offers one optional Lower music during speech toggle.

## Plan contract

```axis-music
{"version":1,"requestId":"copy-the-panel-request-id","cues":[{"id":"section-1","chapter":"Jiren vs Goku","mood":"hype","energy":0.9,"start":0,"end":60,"track":"D:/Music/hype music/exact-file.mp3","sourceOffset":0,"reason":"Fight section; primary mood folder matches.","fadeIn":0.75,"fadeOut":0.75,"baseDb":0,"enabled":true,"alternatives":[]}],"silence":[]}
```

All times are sequence seconds except source offsets. `baseDb` in an agent plan is a placeholder; the panel always computes it from the measured peak. Include a mood and energy per section. Positive sorted ranges, no overlaps, no adjacent repeats, no sponsor crossings. Return exact indexed paths only. Never leave a gap merely to avoid reusing a song from much earlier.

## Host apply, transitions and undo

Choose the track already containing indexed library music, even if it is called Audio 5. Otherwise choose the first unlocked empty audio track. Rename it Music only when empty and unnamed/default-named. Preserve custom names. If no empty track exists, ask the editor to add one. Never overwrite VO, SFX, or existing music. Subtract all occupied target intervals and fill only the gaps.

The ES3 `$.global.axisMusicOperation(request)` is shared by panel and agent. Apply requires `projectId`, `sequenceId`, `confirmed:true`, fresh `expectedSignature`, `targetTrackIndex`, indexed `libraryPaths` and sorted cues with `keys:[{time,value}]`. Key times are cue-relative seconds and values are linear gain, not raw dB or Premiere's normalized Level. The host converts to source time and Premiere Level normalization. Use 1.5-second Constant Power joins through QE when available; otherwise short Volume keyframe fades. Always fade the final clip out. Do not automate existing clips merely to make a join.

`axis:music|applied` or `partial` returns URI-encoded checkpoint ID, checkpoint signature, expected timeline signature, message and sequence ID. Retain the receipt. On partial failure stop and offer Undo before any retry. Swap replaces only the exact identified placed clip after a fresh signature check and retains the original checkpoint, so Undo all includes swaps. Undo opens the pre-music sequence clone, preserving the scored sequence and imported Music bin. Later timeline edits may prevent checkpoint restore.

Offline ES3 tests cannot prove QE behavior on a particular Premiere build. Live-check Constant Power duration/handles, the fallback fades, source trim, normalized Volume Level, audible joins and final fade before export.
