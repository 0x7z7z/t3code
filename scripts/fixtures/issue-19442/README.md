# Agent browser recording rate reproduction

Use an isolated T3 home and the repository's normal desktop/web test workflow. Do not seed or run against live userdata. The fixture needs only a project and a thread in which an agent can call preview tools; it contains no user data.

1. Run `python3 scripts/fixtures/issue-19442/replay.py serve`. Keep that process running during captures.
2. In the real client, set Settings → Integrations → Browser recording frame rate to 60 fps. Ask the agent to open `http://127.0.0.1:19443/moving.html`, resize the content to 1280×800, call `preview_recording_start`, wait four seconds, then call `preview_recording_stop`. Preserve the server-produced attachment unchanged.
3. Reset the real setting to 30 fps and repeat on the same page. Repeat the matched 30/60 pair at 800×450 to reduce frame-transfer cost. Include a click on `#n` in one recording.
4. Measure the source separately with `preview_evaluate`: count requestAnimationFrame intervals for one second using their timestamps. The fixture increments its counter on every callback.
5. For lifecycle controls, call start twice and compare `startedAt`; change the real setting during a recording, then stop and start a new recording. Navigate to `http://127.0.0.1:19443/idle.html` and immediately start/stop without an artificial wait to check idle export.
6. Run `python3 scripts/fixtures/issue-19442/replay.py probe /absolute/path/to/attachment.mp4` for each artifact. Compare decoded counts, intervals and one-second windows; nominal `r_frame_rate` is not achieved cadence. A maximum of 60 does not guarantee 60 on the host.

For a before/after comparison, keep the fixture, display, content viewport, theme, duration and machine constant. The moving HTML is the literal counter used for the original reproduction. No pacing or replacement encoder is injected. Restart with a fresh preview tab if a development reload invalidates its desktop webview.
