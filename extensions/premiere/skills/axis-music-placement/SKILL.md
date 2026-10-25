---
name: axis-music-placement
description: Place one mood-matched library song per script section in Axis, back to back with crossfades, LUFS-based beds, intro swells and best-effort mix effects and checkpoint undo. No ducking by default.
---

# Axis music placement

Use Axis's bundled Premiere capabilities and private CEP bridge only. Never use the standalone premiere-pro MCP or another bridge. Read the active project, sequence and sequence-time VO transcript. Do not guess timings.

## One-click panel flow

Transcript > Music remembers the library folder and indexes it automatically in the background. **Place music** sends a focused planning request to the selected chat agent. Return the requested `axis-music` fence with the exact `requestId`; do not write the timeline from that planning turn. The panel validates the fresh timeline, checkpoints, applies, and shows section / time / mood / song rows with **Swap** and **Undo all**. The user's click plus checkpoint and Undo is the confirmation for this flow. Other timeline changes still require preview/confirmation.

Divide the VO by script subject, character or object. Sections are usually 30-90 seconds, but time alone never causes a change. Keep the same character together until the story's emotional context changes; land every change on a section boundary. Merge neighbouring subjects shorter than about 28 seconds when they share a theme and mood, such as three short fusion characters into Fusions. Optional `theme` labels let the panel merge these before placement. Read the meaning: a loss is sad, Jiren vs Goku can be hype, ominous lore can be tense. Give each section a label, mood and energy from 0 to 1.

Use one matching song per section, contiguous with the next. A song can recur later, but never in neighbouring sections, including existing music at either edge. Skip each song's measured silent head. For a soft intro longer than 12 seconds, start about 7 seconds before the loud part. Include keyTime from the transcript for a form-name reveal or other decisive moment so the panel can align a measured drop within source bounds. Trim to the section; never loop, stretch, or overrun the source. Cover the whole sequence by default, transcript selection first or sequence in/out second. Exclude sponsor audio explicitly.

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

## Mix defaults learned from the finished 17-song mix

1. **Loudness bed.** The user's preference is "-29 is the best, -33 is way too quiet even with headphones." Measure full-source EBU R128 integrated LUFS and set clip Volume Level to `clamp(-38 - integratedLUFS, -35, -25)` dB. The named bed target is -38 LUFS. Keep the all-channel sample peak as a safety measurement; cap the intro gain to keep its predicted sample peak below -1 dBFS. Missing LUFS or peak requires reindexing.
2. **Intro swell, default on.** Start 12 dB above the bed, then ramp in linear gain to the bed over 8 seconds. A soft opening can ramp until its loud part arrives, up to 28 seconds and capped to the section before its final fade. A feasible aligned drop is the preferred ramp endpoint. Static sections can request `swell:false`; ducking remains off unless the editor enables Lower music during speech.
3. **Skip silence.** The index finds the first audible point using 50 ms windows around -50 dBFS RMS. Never start earlier, even when a drop alignment would require it. A source must have enough audible duration to cover the section.
4. **Long soft intros.** More than 12 seconds of soft opening selects an offset about 7 seconds before the measured loud part, bounded by first audible and the last source point that covers the whole section. Settle to the bed where it gets loud, up to the 28-second ramp cap. The cached 0.5-second RMS curve describes structure, not mood.
5. **Drop alignment.** Read timed transcript words for the section's key moment, such as "his final form, Beast", and give `keyTime` in sequence seconds. The panel tries `sourceOffset = biggestDrop - (keyTime - sectionStart)`, accepting only offsets after silence and with enough remaining source. Otherwise it tries measured rises, then the soft-intro/first-audible fallback. Never invent a keyTime.
6. **Vocals.** Mark `vocals:true` only from explicit catalogue/listener evidence, or use an indexed vocals flag/tag. Unknown means skip Lowpass. Vocal songs request **Lowpass**, Cutoff raw **0.25**, and hold the bed at **-28 to -30 dB**. No ML vocal detector. An explicit `vocals:false` overrides tags; omit song-specific evidence when swapping to another song.
7. **Quiet/uneven songs.** Request **Hard Limiter** if integrated LUFS is <= -18 or the audible RMS curve's 90th-to-10th percentile spread is >12 dB. Exclude sub--50 dBFS silence from spread. After the intro, apply coarse 2-second Volume compensation, bounded -3 to +6 dB, without boosting silence. Preset raw values: Maximum Amplitude **0.72** (user range 0.71-0.73), Input Boost **0.6667**, Look-Ahead **0.1333**, Release **0.375**, Link Channels **1**, Decay to Ceiling **1**, Limit True Peak **0**. Apply only to newly placed/replacement clips through QE. On unavailable effect, insertion, parameter, or readback failure, continue and report the failure in that song's result line; never claim it applied.
8. **Crossfades.** Use **3-second Constant Power joins**, capped at half each adjoining section's length. Use 1.5-second Volume edge fades on each side when QE rejects a join, shortened to one quarter of tiny sections; always fade out the final clip. Successful transitions remove only edge fades, preserving the intro swell and compensation. Longer blends can be chosen deliberately after audition.
9. **Praised mood choices.** Nordic/epic dark for a dragon villain; trailer metal for a destroyer; melodic phonk for berserk-but-tender; stylish phonk for Goku Black; haunting violin for god-complex horror; aggressive phonk for Vegeta. Use these as semantic selection hints within the authoritative mood folders, never as evidence of unheard audio.

The schema is version 3. The existing `v1/tracks.sqlite` cache location stays stable; schema-aware fingerprints trigger incremental reanalysis without clearing the database. Listener descriptions/tags survive an unchanged version-2 source upgrade. Swaps recompute LUFS bed, source offset, swell, automation and effects from the replacement's analysis.

## Plan contract

```axis-music
{"version":1,"requestId":"copy-the-panel-request-id","cues":[{"id":"section-1","chapter":"Jiren vs Goku","mood":"hype","energy":0.9,"start":0,"end":60,"keyTime":9.7,"track":"D:/Music/hype music/exact-file.mp3","sourceOffset":0,"reason":"Fight section; primary mood folder matches.","fadeIn":1.5,"fadeOut":1.5,"baseDb":0,"enabled":true,"alternatives":[]}],"silence":[]}
```

All times are sequence seconds except source offsets. `baseDb` in an agent plan is a placeholder; the panel always computes it from integrated LUFS. `keyTime` is optional and must lie inside its section; `vocals` is optional and song-specific; `swell:false` disables the default intro swell. Include a mood and energy per section. Positive sorted ranges, no overlaps, no adjacent repeats, no sponsor crossings. Return exact indexed paths only. Never leave a gap merely to avoid reusing a song from much earlier.

## Host apply, transitions and undo

Choose the track already containing indexed library music, even if it is called Audio 5. Otherwise choose the first unlocked empty audio track. Rename it Music only when empty and unnamed/default-named. Preserve custom names. If no empty track exists, ask the editor to add one. Never overwrite VO, SFX, or existing music. Subtract all occupied target intervals and fill only the gaps.

The ES3 `$.global.axisMusicOperation(request)` is shared by panel and agent. Apply requires `projectId`, `sequenceId`, `confirmed:true`, fresh `expectedSignature`, `targetTrackIndex`, indexed `libraryPaths` and sorted cues with `keys:[{time,value}]`. Key times are cue-relative seconds and values are linear gain, not raw dB or Premiere's normalized Level. Keys may also include `envelopeValue` (unfaded linear gain) so QE joins preserve swells and compensation. Cues carry `effects:["Hard Limiter","Lowpass"]` as needed. The host converts to source time and Premiere Level normalization. Use 3-second Constant Power joins through QE when available; otherwise short Volume keyframe fades. Always fade the final clip out. Do not automate existing clips merely to make a join.

`axis:music|applied` or `partial` returns URI-encoded checkpoint ID, checkpoint signature, expected timeline signature, message, sequence ID and per-cue effect reports. Each result row shows the bed dB and actual effects or failures. Retain the receipt. On partial failure stop and offer Undo before any retry. Swap replaces only the exact identified placed clip after a fresh signature check and retains the original checkpoint, so Undo all includes swaps. Undo opens the pre-music sequence clone, preserving the scored sequence and imported Music bin. Later timeline edits may prevent checkpoint restore.

Offline ES3 tests cannot prove QE behavior on a particular Premiere build. Live-check Constant Power duration/handles, fallback fades, offset/drop timing, normalized Volume swell and compensation, QE effect availability and raw-preset readback, audible vocal masking, joins and final fade before export.
