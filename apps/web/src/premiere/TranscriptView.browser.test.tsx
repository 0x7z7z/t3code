import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, render } from "../../test/render";
import type { PremiereContext } from "./host";
import { TranscriptView, transcriptStorageKey } from "./TranscriptView";
import { parseTranscript } from "./sequenceTranscript";

const host = vi.hoisted(() => ({
  seek: vi.fn(),
  cut: vi.fn(),
  snapshot: vi.fn(),
  restore: vi.fn(),
}));
vi.mock("./host", () => ({ seekPremiere: host.seek }));
vi.mock("./timelineHost", () => ({
  pruneCheckpoints: async () => {},
  cutTranscriptRange: host.cut,
  requestTimelineSnapshot: host.snapshot,
  restoreTimeline: host.restore,
}));

function setup(id: string, count = 3) {
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

it("bounds long transcripts, follows scrubbing and allows selections across pages", async () => {
  const f = setup("long", 3000);
  await using screen = await render(<TranscriptView {...f.props} />);
  expect(screen.container.querySelectorAll("[data-transcript-word]")).toHaveLength(120);
  await screen.getByRole("button", { name: "Every at 00:00:00.000" }).click();
  await screen.getByRole("button", { name: "Next words" }).click();
  await screen
    .getByRole("button", { name: "Every at 00:02:00.000" })
    .click({ modifiers: ["Shift"] });
  await screen.getByRole("button", { name: "Ask Axis" }).click();
  expect(f.props.onAsk).toHaveBeenCalledWith(
    expect.stringContaining("[00:00:00.000 - 00:02:00.800]"),
  );
  await screen.getByRole("button", { name: "Follow playhead" }).click();
  await screen.rerender(
    <TranscriptView {...f.props} context={{ ...f.props.context, playheadSeconds: 2500.2 }} />,
  );
  await expect
    .element(screen.getByRole("button", { name: "frame at 00:41:40.000" }))
    .toHaveAttribute("aria-current", "true");
  expect(screen.container.querySelectorAll("[data-transcript-word]")).toHaveLength(120);
  await screen.rerender(
    <TranscriptView {...f.props} context={{ ...f.props.context, playheadSeconds: 2500.9 }} />,
  );
  await expect.element(screen.getByRole("button", { name: "frame at 00:41:40.000" })).toBeVisible();
  expect(screen.container.querySelector('[aria-current="true"]')).toBeNull();
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
  await screen.getByRole("spinbutton", { name: "Sequence offset (seconds)" }).fill("4");
  await screen.getByRole("button", { name: "Apply offset" }).click();
  await expect.element(screen.getByRole("button", { name: "Hello at 00:00:05.000" })).toBeVisible();
  await act(() => screen.rerender(<TranscriptView {...f.props} key="reload" />));
  await expect.element(screen.getByRole("button", { name: "Hello at 00:00:05.000" })).toBeVisible();
  await expect.element(screen.getByText("SRT · vo.srt")).toBeVisible();
});
