# Axis

Axis, the editing agent, is a dockable Premiere Pro extension with conversations,
account selection, approvals, and orchestration. Its install includes the Premiere
MCP server, and the extension runs the Premiere bridge itself.

## Install the development extension

Build this fork, then install the extension:

```powershell
vp i
vp run --filter t3 build
node scripts/premiere-extension.mjs
```

The installer uses the prebuilt connector in `build/premiere-connector`. For a
development build without that bundle, it builds one from the compiled sibling
checkout at `../premiere-pro-mcp-aftr`. Use `--connector-root <checkout>` to rebuild
from another compiled checkout, or `--connector-bundle <directory>` to install a
prebuilt bundle. The checkout is needed only when building the bundle, never when
running the installed extension.

Restart Premiere and open **Window > Extensions > Axis**. Axis
starts its local backend, pairs the panel, and runs its bridge
automatically. There is no second panel to start or temp directory to type. The
installer creates a private bridge directory at `~/.premiere-pro-mcp/axis-bridge` by
default; `--bridge-dir` selects another private path. Its accounts and conversations
use `%LOCALAPPDATA%\Axis` on Windows or `~/Library/Application Support/Axis` on macOS.
When upgrading, the installer moves the previous `PremiereAssistant` data directory
to `Axis` if the backend is stopped and `Axis` does not already exist. If the backend
is running or the move fails, it keeps using the previous directory and prints a
note. Accounts and conversations are preserved. An existing `Axis` directory takes
precedence; the directories are never merged. An explicit `--data-dir` uses that
directory directly. The installer removes the previous CEP installation only when
its manifest identifies it as the old extension, preventing duplicate panels.

Choose **Accounts** to finish provider setup in Axis's browser interface, then return
to the panel and choose the editing workspace and **New edit**. Select the account and model in the composer. Codex and Claude receive the
bundled Premiere connector directly from the installed host when running in the editing
workspace, including when Codex does not trust local project configuration. The
installer also writes local MCP configuration for standalone use. Other providers need their
normal MCP configuration pointed at the installed connector and bridge directory.

Each request includes the current project, sequence, frame rate, and playhead.
The panel re-reads that context before sending. Context is a planning aid; the
editing agent must inspect the host before changing the timeline. Multiple agents
may research and review, while one agent owns timeline edits.

The installer accepts `--port`, `--data-dir`, `--bridge-dir`, and `--destination`. Use `--dry-run`
to check paths and generated MCP configuration without building or installing.
Run it again after updating the panel files; pass `--connector-root` when updating
the connector server too. Existing extension-owned MCP entries migrate to the
bundled server on reinstall.
Closing the panel keeps its backend and running tasks alive. Restart that dedicated
backend after reinstalling so new sessions use the updated connector configuration.
Stop it when it is no longer needed.

## Transcribe a sequence

Open **Transcript** and choose **Transcribe with WhisperX** to ask the selected agent
to transcribe the active sequence's voice-over. You can start it while the composer
is in Plan mode. It opens a separate conversation with permission to write transcript
files and does not edit the timeline. WhisperX and its Python transcriber must be installed on the
backend machine. The agent reads the original media and maps word times to the clips
used in the sequence, including trims and constant speed changes.

**Fix with script** is enabled by default. The agent looks for a matching TXT,
Markdown, DOCX or PDF script beside the project or media and corrects recognized
words while preserving their timing. PDF text extraction requires `pypdf` or
`pdftotext`. If the script is missing or does not match, Axis keeps the original
transcription. Check Conversation for questions, correction counts and uncertain
regions. The finished transcript loads and saves for the current project and sequence.

You can still import WhisperX JSON, SRT or VTT manually. **Stop waiting** stops the
automatic import; use the conversation's stop control to interrupt the agent itself.

## Clean up voice-over

To clean an audio file, choose **Menu > Clean VO**. Browse to the file, paste its
full path, or select the VO clip on the timeline (or one item in the Project
panel) and choose **Use selected clip**. Video files work too; their audio is
cleaned. Choose silence, breaths, silence followed by breaths, or **Silence,
breaths, then silence**. The last mode closes the gaps left by lowered breaths
with a second silence pass using the same retained-silence value.
Silence removal retains 50 ms by default and shortens the audio; breath
removal lowers breaths by 40 dB while preserving length and samples outside the
breath regions. Quiet consonant onsets and tails get extra protection at cut edges.
Word timings are generated after the first silence pass and also protect
consonants during the final pass.

Each run saves uniquely named lossless WAV files beside the source, retaining
the silence-only and breath-cleaned intermediates, plus a breath region CSV when
applicable. The final file in the fourth mode ends in `_SilenceBreathsSilence.wav`.
The CSV uses the breath-cleaned intermediate's timing.
**Import result into project bin** adds the final file
to **Axis VO cleanup**; you can also import after processing. Open a sequence in
the intended project to enable import. The original files are preserved.

**Import into timeline** finds the source file on the active sequence, including
files chosen with Browse or a pasted path. If there are several instances, select
the one to use and choose **Use selected clip**. Axis places the result on a new
audio track named **Clean VO** below the VO. If Premiere adds the track elsewhere,
Axis can use an entirely empty, unlocked track directly below the VO or a verified
bottom track. The result reports the actual track and start time, with the reason
for any fallback. Nothing on existing clips is moved, trimmed or overwritten.
Axis sets its own freshly imported item to one mono or stereo clip when needed,
then verifies the mapping and every existing audio and video clip. If Premiere
cannot set a safe mapping, timeline import is refused.
Breath-only results keep the VO's trim and line up with it exactly; results with
silence removed start where the VO clip starts. If you move or retrim the VO while
processing, placement follows its current position, track and trim. Deleted or
ambiguous clips are refused. Timeline import requires forward playback at 100% speed, with
the VO track and all audio tracks below it unlocked. Select only one instance;
linked mono channels with identical source and timing count as one, and placement
goes below the bottom channel. Errors identify locked tracks and the intended
project or sequence so you can resolve the problem.

Axis saves a verified sequence checkpoint before placement. A placement failure
automatically restores it. **Undo placement** restores the whole sequence and its
original track layout; later timeline edits make Undo unavailable. The changed
sequence, including its added track, remains in **Axis checkpoints**. If restore
fails, Axis says so and keeps Undo available. After a response timeout, check the
timeline and use Premiere's Undo before trying another placement.

Python 3.12 with `numpy`, `soundfile` and `pydub`, plus FFmpeg, must be available
on the Premiere machine. Breath cleanup also requires the existing WhisperX
setup in **Menu > Diagnostics**. Transcription runs locally on CPU and long VOs
can take a while. Transcription stops after five hours; the complete job stops
before six hours and removes unfinished outputs and temporary files. Keep Axis
open until processing finishes. Compressed sources
are decoded before cleaning; sample identity applies to the decoded audio.

### Review transcript cuts

In Transcript, open the options menu and choose **Clean up**, or ask Axis to
"clean up the VO" and open its cleanup suggestion. Import or transcribe first.
Review pauses, filler words, repeated words, stutters and restarted takes before
applying them. Restarted takes keep the last take. The default pause threshold is
0.6 seconds, with 0.12 seconds retained on each side; thresholds and the filler
list update the preview as you edit them.

Red, struck-through text and pause chips show proposed cuts. Click one to keep
or cut it and seek nearby to listen. Apply removes all accepted ranges across
unlocked audio and video tracks. Locked tracks, captions and markers stay put;
clips linked to locked tracks and affected transitions must be resolved first.
**Undo transcript cut** restores the whole cleanup from one checkpoint. Further
timeline edits can invalidate that undo, so review the result before continuing.

## Score with local music

Import or transcribe the voice-over, then choose **Transcript > options > Music**.
Python, `ffmpeg` and `ffprobe` must be available on the Premiere machine.

1. Choose your library folder and **Index library**. The folder and level settings
   are remembered per project. Large libraries index in resumable batches; use
   **Resume index** until no tracks remain pending. Music files are never modified.
2. Choose **Build music plan**, or ask the agent to "score this video" and open
   **Review music** on its suggestion. The first pass covers the transcribed
   narration; check any footage after the narration separately.
3. Audition the source offsets, swap alternatives, disable cues or nudge their starts.
   Set fades and ducking, and enter exact sponsor or silence ranges in seconds.
   Rebuild after changing exclusions. Verify detected sponsor boundaries.
4. Confirm the preview and apply. Axis uses an empty dedicated Music audio track,
   imports sources into a Music bin and adds fades and voice-over ducking.
   **Undo music** opens the pre-music sequence checkpoint; the scored version and
   imported source files remain available. Review before making further edits.

Energy analysis cannot establish mood. With an Antigravity Gemini model selected,
**Describe library** sends up to three actual 30-second excerpts to the current
agent, which saves descriptions in the local index. Refresh the index and repeat
for more tracks. Other providers use folder categories, energy and saved tags;
audition those recommendations. Always listen for voice-over masking before export.

If Premiere cannot create an audio track or automate Volume / Level, undo the
partial result. Add an empty track named Music manually and try again after
checking compatibility with your Premiere version.

## Compatibility

The CEP manifest targets Premiere 25.x and later, including 25.3. This development
build still requires testing in the exact installed Premiere version. UXP-only
editing tools require the separate UXP connector and Premiere 25.6 or later.

The editing interface targets CEP 12's Chromium 99 engine. Account setup opens
Axis's full interface in your browser. This is an initial integration, not a signed
distributable release.

## About

Axis is built on an open-source T3 Code fork.
