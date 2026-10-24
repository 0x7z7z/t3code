import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, render } from "../../test/render";
import type { PremiereContext } from "./host";
import { TranscriptView, transcriptStorageKey } from "./TranscriptView";
import { parseTranscript } from "./sequenceTranscript";
import "./styles.css";

const host = vi.hoisted(() => ({
  seek: vi.fn(),
  cut: vi.fn(),
  snapshot: vi.fn(),
  restore: vi.fn(),
  load: vi.fn(),
}));
vi.mock("./host", () => ({ seekPremiere: host.seek }));
vi.mock("./usePlayheadClock", () => ({ usePlayheadClock: () => null }));
vi.mock("./interactiveHost", () => ({ requestTimelineAction: host.load }));
vi.mock("./timelineHost", () => ({
  pruneCheckpoints: async () => {},
  cutTranscriptRange: host.cut,
  requestTimelineSnapshot: host.snapshot,
  restoreTimeline: host.restore,
}));

function setup(id: string, count = 3) {
  host.load.mockReset().mockResolvedValue({
    content: null,
    outputPath: "D:/workspace/result.json",
    helperPath: "D:/extension/tools/axis_transcript.py",
  });
  host.seek.mockReset();
  host.cut.mockReset().mockResolvedValue({
    checkpointId: "checkpoint",
    checkpointSignature: "before",
    expectedSignature: "after",
    cutError: null,
  });
  host.snapshot
    .mockReset()
    .mockResolvedValue({ signature: "after", checkpointIds: ["checkpoint"] });
  host.restore.mockReset().mockResolvedValue("restored-sequence");
  const context: PremiereContext = {
    projectName: "Film",
    projectPath: "D:/Film.prproj",
    projectDocumentId: "film",
    sequenceId: id,
    sequenceName: "Main edit",
    fps: 25,
    playheadSeconds: 0,
  };
  const words = Array.from({ length: count }, (_, i) => ({
    word: ["Every", "frame", "matters."][i % 3],
    start: i,
    end: i + 0.8,
  }));
  const transcript = parseTranscript(JSON.stringify({ segments: [{ words }] }), "voice.json");
  const key = transcriptStorageKey(context);
  localStorage.setItem(key, JSON.stringify({ transcript, undo: null, uncertain: false }));
  const props = { context, disabled: false, onAsk: vi.fn(), onBusy: vi.fn() };
  return { props, key, transcript };
}

it("transcribes in Plan mode, imports the matching handoff and persists the corrected sequence transcript", async () => {
  const f = setup("whisper");
  const onTranscribe = vi.fn(async (prompt: string) => {
    const requestId = /"requestId":"([^"]+)"/.exec(prompt)![1];
    host.load.mockResolvedValue({
      outputPath: "D:/workspace/result.json",
      helperPath: "D:/extension/tools/axis_transcript.py",
      content: JSON.stringify({
        version: 1,
        requestId,
        projectId: "film",
        sequenceId: "whisper",
        status: "complete",
        metadata: { scriptChecked: true },
        words: [{ word: "Frieza", start: 12, end: 13 }],
      }),
    });
  });
  await using screen = await render(
    <TranscriptView {...f.props} disabled onTranscribe={onTranscribe} agentStatus="running" />,
  );
  screen.container.style.width = "440px";
  await screen.getByRole("button", { name: "Transcript options" }).click();
  await expect.element(screen.getByRole("checkbox", { name: "Fix with script" })).toBeChecked();
  await screen.getByRole("button", { name: "Transcribe with WhisperX" }).click();
  await expect
    .element(screen.getByRole("button", { name: "Frieza at 00:00:12.000" }))
    .toBeVisible();
  expect(onTranscribe).toHaveBeenCalledWith(expect.stringContaining("reconcile --input"));
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent("WhisperX transcript loaded and saved.");
  await act(() => screen.rerender(<TranscriptView {...f.props} key="reload-whisper" />));
  await expect.element(screen.getByText("WhisperX (Axis) · script-checked")).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Frieza at 00:00:12.000" }))
    .toBeVisible();
});

it("shows agent progress, permits stopping the wait and keeps manual import", async () => {
  const f = setup("waiting-whisper");
  const onTranscribe = vi.fn(async () => {});
  await using screen = await render(
    <TranscriptView {...f.props} onTranscribe={onTranscribe} agentStatus="waiting" />,
  );
  await screen.getByRole("button", { name: "Transcript options" }).click();
  await screen.getByRole("checkbox", { name: "Fix with script" }).click();
  await screen.getByRole("button", { name: "Transcribe with WhisperX" }).click();
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent(
      "Transcribing · waiting. Agent details and questions are in Conversation. Stop waiting does not stop the agent.",
    );
  expect(onTranscribe).toHaveBeenCalledWith(expect.stringContaining("Script correction is OFF"));
  await screen.getByRole("button", { name: "Transcript options" }).click();
  await expect
    .element(screen.getByRole("button", { name: "Transcribe with WhisperX" }))
    .toBeDisabled();
  await screen.getByRole("button", { name: "Transcript options" }).click();
  await screen.getByRole("button", { name: "Stop waiting" }).click();
  await screen.getByRole("button", { name: "Transcript options" }).click();
  await expect.element(screen.getByRole("button", { name: "Replace transcript" })).toBeEnabled();
  await expect
    .element(screen.getByRole("button", { name: "Transcribe with WhisperX" }))
    .toBeEnabled();
});

it("shows a failed handoff's actual reason without replacing the existing transcript", async () => {
  const f = setup("failed-whisper");
  const onTranscribe = vi.fn(async () => {
    host.load.mockRejectedValue(new Error("No readable voice-over media"));
  });
  await using screen = await render(<TranscriptView {...f.props} onTranscribe={onTranscribe} />);
  await screen.getByRole("button", { name: "Transcript options" }).click();
  await screen.getByRole("button", { name: "Transcribe with WhisperX" }).click();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("No readable voice-over media");
  await expect.element(screen.getByRole("button", { name: "Every at 00:00:00.000" })).toBeVisible();
  await screen.getByRole("button", { name: "Transcript options" }).click();
  await expect
    .element(screen.getByRole("button", { name: "Transcribe with WhisperX" }))
    .toBeEnabled();
});

it("reports the agent's outcome when its turn ends without producing a handoff", async () => {
  const f = setup("no-handoff-whisper");
  await using screen = await render(
    <TranscriptView {...f.props} onTranscribe={async () => {}} agentOutcome="The VO is offline." />,
  );
  await screen.getByRole("button", { name: "Transcript options" }).click();
  await screen.getByRole("button", { name: "Transcribe with WhisperX" }).click();
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("The agent finished without a transcript: The VO is offline.");
  await expect.element(screen.getByRole("button", { name: "Every at 00:00:00.000" })).toBeVisible();
});

it("seeks words, highlights the playhead and quotes a selected range", async () => {
  const f = setup("seek");
  await using screen = await render(<TranscriptView {...f.props} />);
  await screen.getByRole("button", { name: "frame at 00:00:01.000" }).click();
  expect(host.seek).toHaveBeenCalledWith(1, "seek");
  await screen.rerender(
    <TranscriptView {...f.props} context={{ ...f.props.context, playheadSeconds: 1.5 }} />,
  );
  await expect
    .element(screen.getByRole("button", { name: "frame at 00:00:01.000" }))
    .toHaveAttribute("aria-current", "true");
  await screen
    .getByRole("button", { name: "matters. at 00:00:02.000" })
    .click({ modifiers: ["Shift"] });
  await screen.getByRole("button", { name: "Ask Axis" }).click();
  expect(f.props.onAsk).toHaveBeenCalledWith(
    expect.stringContaining("[00:00:01.000 - 00:00:02.800]"),
  );
  expect(f.props.onAsk).toHaveBeenCalledWith(expect.stringContaining("> frame matters."));
});

it("confirms cuts, persists remapped times and restores the transcript with the checkpoint's new sequence ID", async () => {
  const f = setup("cut");
  await using screen = await render(<TranscriptView {...f.props} />);
  await screen.getByRole("button", { name: "frame at 00:00:01.000" }).click();
  await screen.getByRole("button", { name: "Cut from timeline" }).click();
  expect(host.cut).not.toHaveBeenCalled();
  await screen.getByRole("button", { name: "Confirm ripple cut" }).click();
  await vi.waitFor(() =>
    expect(host.cut).toHaveBeenCalledWith({
      sequenceId: "cut",
      projectId: "film",
      start: 1,
      end: 1.8,
    }),
  );
  await expect
    .element(screen.getByRole("button", { name: "matters. at 00:00:01.200" }))
    .toBeVisible();
  expect(JSON.parse(localStorage.getItem(f.key)!).transcript.words).toHaveLength(2);
  await screen.getByRole("button", { name: "Undo transcript cut" }).click();
  await vi.waitFor(() =>
    expect(host.restore).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpointId: "checkpoint",
        sequenceId: "cut",
        expectedSignature: "after",
      }),
    ),
  );
  await expect.element(screen.getByRole("button", { name: "frame at 00:00:01.000" })).toBeVisible();
  expect(
    JSON.parse(localStorage.getItem(transcriptStorageKey(f.props.context, "restored-sequence"))!)
      .transcript.words,
  ).toHaveLength(3);
});

it("retains checkpoint recovery after partial failures and refuses undo after later timeline edits", async () => {
  const f = setup("partial");
  host.cut.mockResolvedValueOnce({
    checkpointId: "checkpoint",
    checkpointSignature: "before",
    expectedSignature: "after",
    cutError: "QE refused a boundary",
  });
  await using screen = await render(<TranscriptView {...f.props} />);
  await screen.getByRole("button", { name: "frame at 00:00:01.000" }).click();
  await screen.getByRole("button", { name: "Cut from timeline" }).click();
  await screen.getByRole("button", { name: "Confirm ripple cut" }).click();
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("QE refused a boundary The checkpoint is available below.");
  await screen.getByRole("button", { name: "frame at 00:00:01.000" }).click();
  await expect.element(screen.getByRole("button", { name: "Cut from timeline" })).toBeDisabled();
  host.snapshot.mockResolvedValueOnce({ signature: "later edit", checkpointIds: ["checkpoint"] });
  await screen.getByRole("button", { name: "Undo transcript cut" }).click();
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent(
      "The timeline changed or its checkpoint was pruned. Open the preserved Axis checkpoint manually to recover the earlier version.",
    );
  expect(host.restore).not.toHaveBeenCalled();
});

it("renders long transcripts as paragraphs, follows scrubbing and selects across paragraphs", async () => {
  const f = setup("long", 3000);
  await using screen = await render(<TranscriptView {...f.props} />);
  screen.container.style.cssText = "height: 600px; display: flex; flex-direction: column";
  expect(screen.container.querySelectorAll("[data-transcript-word]")).toHaveLength(3000);
  expect(screen.container.querySelectorAll("[data-transcript-paragraph]").length).toBeGreaterThan(
    30,
  );
  await screen.getByRole("button", { name: "Every at 00:00:00.000" }).click();
  await screen
    .getByRole("button", { name: "Every at 00:02:00.000" })
    .click({ modifiers: ["Shift"] });
  await vi.waitFor(() =>
    expect(
      screen.container.querySelectorAll('[data-transcript-word][aria-pressed="true"]'),
    ).toHaveLength(121),
  );
  await screen.getByRole("button", { name: "Ask Axis" }).click();
  expect(f.props.onAsk).toHaveBeenCalledWith(
    expect.stringContaining("[00:00:00.000 - 00:02:00.800]"),
  );
  await screen.getByRole("button", { name: "Clear selection" }).click();
  await screen.rerender(
    <TranscriptView {...f.props} context={{ ...f.props.context, playheadSeconds: 2500.2 }} />,
  );
  await expect
    .element(screen.getByRole("button", { name: "frame at 00:41:40.000" }))
    .toHaveAttribute("aria-current", "true");
  await expect
    .element(screen.getByRole("button", { name: "frame at 00:41:40.000" }))
    .toBeInViewport();
  await screen.rerender(
    <TranscriptView {...f.props} context={{ ...f.props.context, playheadSeconds: 2500.9 }} />,
  );
  expect(screen.container.querySelector('[aria-current="true"]')).toBeNull();
});

it("searches phrases, steps through matches and selects the current one", async () => {
  const f = setup("search", 30);
  await using screen = await render(<TranscriptView {...f.props} />);
  await screen.getByRole("searchbox", { name: "Search transcript" }).fill("frame matt");
  await expect.element(screen.getByText("1 / 10")).toBeVisible();
  expect(screen.container.querySelectorAll('[data-match="current"]')).toHaveLength(2);
  await userEvent.keyboard("{Enter}");
  await expect.element(screen.getByText("2 / 10")).toBeVisible();
  expect(host.seek).toHaveBeenLastCalledWith(4, "search");
  await expect
    .element(screen.getByRole("button", { name: "matters. at 00:00:05.000" }))
    .toHaveAttribute("aria-pressed", "true");
  await screen.getByRole("button", { name: "Previous match" }).click();
  await expect.element(screen.getByText("1 / 10")).toBeVisible();
  await screen.getByRole("searchbox", { name: "Search transcript" }).fill("nothing here");
  await expect.element(screen.getByText("No matches")).toBeVisible();
});

it("imports a file through the file input, maps an offset and reloads scoped state", async () => {
  const f = setup("import");
  localStorage.removeItem(f.key);
  await using screen = await render(<TranscriptView {...f.props} />);
  const file = new File(["1\n00:00:01,000 --> 00:00:03,000\nHello world"], "vo.srt", {
    type: "text/plain",
  });
  await userEvent.upload(screen.getByLabelText("Import transcript file"), file);
  await expect.element(screen.getByRole("button", { name: "Hello at 00:00:01.000" })).toBeVisible();
  await screen.getByRole("button", { name: "Transcript options" }).click();
  await screen.getByRole("spinbutton", { name: "Sequence offset (seconds)" }).fill("4");
  await screen.getByRole("button", { name: "Apply offset" }).click();
  await expect.element(screen.getByRole("button", { name: "Hello at 00:00:05.000" })).toBeVisible();
  await act(() => screen.rerender(<TranscriptView {...f.props} key="reload" />));
  await expect.element(screen.getByRole("button", { name: "Hello at 00:00:05.000" })).toBeVisible();
  await expect.element(screen.getByText("Sequence time + 4 s · vo.srt")).toBeVisible();
});

it("links an imported transcript to its voice-over clip and follows trims made in Premiere", async () => {
  const f = setup("linked", 4);
  localStorage.setItem(
    f.key,
    JSON.stringify({
      transcript: { ...f.transcript, source: "WhisperX JSON · VO_take_sentences.json" },
      undo: null,
      uncertain: false,
    }),
  );
  const timeline = (start: number, inPoint: number) => ({
    signature: "s",
    checkpointIds: [],
    snapshot: {
      projectId: "film",
      sequenceId: "linked",
      name: "Main edit",
      videoTrackCount: 0,
      audioTrackCount: 1,
      videoTracks: [],
      audioTracks: [
        {
          index: 0,
          clips: [
            {
              name: "VO_take.wav",
              nodeId: "",
              projectItemName: "VO_take.wav",
              start,
              end: start + 4 - inPoint,
              inPoint,
              outPoint: 4,
              enabled: true,
            },
          ],
        },
      ],
      markers: [],
      inPoint: null,
      outPoint: null,
      truncated: false,
    },
  });
  host.snapshot.mockResolvedValue(timeline(10, 0));
  await using screen = await render(<TranscriptView {...f.props} />);
  await expect.element(screen.getByRole("button", { name: "Every at 00:00:10.000" })).toBeVisible();
  await expect.element(screen.getByText("Synced to A1 · VO_take.wav")).toBeVisible();
  // The editor trims the first second off the clip head and slides it to 20 s.
  host.snapshot.mockResolvedValue(timeline(20, 1));
  await expect
    .element(screen.getByRole("button", { name: "frame at 00:00:20.000" }), { timeout: 6000 })
    .toBeVisible();
  expect(screen.container.querySelectorAll("[data-transcript-word]")).toHaveLength(3);
  await screen.getByRole("button", { name: "matters. at 00:00:21.000" }).click();
  expect(host.seek).toHaveBeenLastCalledWith(21, "linked");
});
