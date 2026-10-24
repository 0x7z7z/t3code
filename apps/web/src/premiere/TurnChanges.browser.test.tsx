import { expect, it, vi } from "vite-plus/test";
import { useState } from "react";
import { render } from "../../test/render";
import type { OrchestrationV2Run, OrchestrationV2TurnItem } from "@t3tools/contracts";
import { TurnChanges } from "./TurnChangesCard";
import { useTurnChanges } from "./useTurnChanges";
import type { TranscriptBlock } from "./transcript";
import type { PremiereHostState } from "./host";
import type { TurnChangeRecord } from "./turnChanges";

const state = vi.hoisted(() => ({ snapshot: vi.fn(), restore: vi.fn(), seek: vi.fn() }));
vi.mock("./timelineHost", async (original) => ({
  ...(await original()),
  requestTimelineSnapshot: state.snapshot,
  restoreTimeline: state.restore,
}));
vi.mock("./host", async (original) => ({ ...(await original()), seekPremiere: state.seek }));

function setup() {
  const snapshot = {
    projectId: "project",
    sequenceId: "sequence",
    name: "Main Edit",
    videoTrackCount: 0,
    audioTrackCount: 0,
    videoTracks: [],
    audioTracks: [],
    markers: [],
    inPoint: null,
    outPoint: null,
    truncated: false,
  };
  const record: TurnChangeRecord = {
    threadId: "thread",
    turnId: "turn",
    messageId: "message",
    turnNumber: 2,
    createdAt: 1,
    before: snapshot,
    after: snapshot,
    signature: "after",
    checkpointSignature: "before",
    checkpointId: "checkpoint",
    checkpointError: null,
    changes: [{ id: "trim:clip", kind: "trim", seconds: 5.25, text: "Clip trimmed on V1" }],
  };
  const host: PremiereHostState = {
    connected: true,
    context: {
      projectName: "Project",
      projectPath: "D:/cut.prproj",
      projectDocumentId: "project",
      sequenceName: "Main Edit",
      sequenceId: "sequence",
      fps: 30,
      playheadSeconds: 0,
    },
  };
  state.snapshot
    .mockReset()
    .mockResolvedValue({ snapshot, signature: "after", checkpointIds: ["checkpoint"] });
  state.restore.mockReset().mockResolvedValue(undefined);
  state.seek.mockReset().mockReturnValue(true);
  return { record, host, onRestored: vi.fn() };
}

it("expands changes, seeks the original sequence, and requires inline confirmation before undo", async () => {
  const props = setup();
  // The docked timeline card has no router navigation.
  await using screen = await render(<TurnChanges {...props} latest busy={false} />, {
    router: false,
  });
  await expect
    .element(screen.getByRole("button", { name: "Undo this turn", exact: true }))
    .toBeEnabled();
  await screen.getByText("Changed in Main Edit: 1 clip trimmed").click();
  await screen.getByRole("button", { name: "Move playhead to 00:00:05.250" }).click();
  expect(state.seek).toHaveBeenCalledWith(5.25, "sequence");
  await screen.getByRole("button", { name: "Undo this turn", exact: true }).click();
  expect(state.restore).not.toHaveBeenCalled();
  await expect
    .element(screen.getByText("Undo this turn? The current version will be kept."))
    .toBeVisible();
  await screen.getByRole("button", { name: "Undo", exact: true }).click();
  await vi.waitFor(() => expect(props.onRestored).toHaveBeenCalledWith("message"));
  expect(state.restore).toHaveBeenCalledWith({
    sequenceId: "sequence",
    checkpointId: "checkpoint",
    expectedSignature: "after",
    checkpointSignature: "before",
    turnNumber: 2,
  });
});

it("cancels confirmation without restoring or changing the card", async () => {
  const props = setup();
  // The docked timeline card has no router navigation.
  await using screen = await render(<TurnChanges {...props} latest busy={false} />, {
    router: false,
  });
  await expect
    .element(screen.getByRole("button", { name: "Undo this turn", exact: true }))
    .toBeEnabled();
  await screen.getByRole("button", { name: "Undo this turn", exact: true }).click();
  await screen.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect
    .element(screen.getByRole("button", { name: "Undo this turn", exact: true }))
    .toBeEnabled();
  expect(state.restore).not.toHaveBeenCalled();
});

it("disables old turns and disconnected Premiere with a visible explanation", async () => {
  const props = setup();
  // The docked timeline card has no router navigation.
  await using screen = await render(<TurnChanges {...props} latest={false} busy={false} />, {
    router: false,
  });
  await expect
    .element(screen.getByRole("button", { name: "Undo this turn", exact: true }))
    .toBeDisabled();
  await expect
    .element(screen.getByText("Only the latest turn that changed the timeline can be undone."))
    .toBeVisible();
  await screen.rerender(
    <TurnChanges {...props} host={{ connected: false, context: null }} latest busy={false} />,
  );
  await expect.element(screen.getByText("Connect to Premiere to undo this turn.")).toBeVisible();
  expect(state.restore).not.toHaveBeenCalled();
});

it("disables undo when the checkpoint is missing or the timeline has changed", async () => {
  const props = setup();
  state.snapshot.mockResolvedValue({ signature: "after", checkpointIds: [] });
  // The docked timeline card has no router navigation.
  await using screen = await render(<TurnChanges {...props} latest busy={false} />, {
    router: false,
  });
  await expect
    .element(screen.getByText("This turn's checkpoint is gone or was renamed."))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Undo this turn", exact: true }))
    .toBeDisabled();
  state.snapshot.mockResolvedValue({ signature: "later-edit", checkpointIds: ["checkpoint"] });
  await screen.rerender(
    <TurnChanges {...props} record={{ ...props.record }} latest busy={false} />,
  );
  await expect
    .element(screen.getByText("The timeline changed after this turn. Undo is unavailable."))
    .toBeVisible();
});

it("shows authoritative restore errors and never reports success", async () => {
  const props = setup();
  state.restore.mockRejectedValue(
    new Error("The checkpoint was edited after this turn. Undo is unavailable."),
  );
  // The docked timeline card has no router navigation.
  await using screen = await render(<TurnChanges {...props} latest busy={false} />, {
    router: false,
  });
  await expect
    .element(screen.getByRole("button", { name: "Undo this turn", exact: true }))
    .toBeEnabled();
  await screen.getByRole("button", { name: "Undo this turn", exact: true }).click();
  await screen.getByRole("button", { name: "Undo", exact: true }).click();
  await expect
    .element(screen.getByRole("status"))
    .toHaveTextContent("The checkpoint was edited after this turn. Undo is unavailable.");
  expect(props.onRestored).not.toHaveBeenCalled();
});

function CaptureTurn({
  status,
  threadId = "capture-thread",
  edit = true,
  missing = false,
}: {
  status: "running" | "completed";
  threadId?: string;
  edit?: boolean;
  missing?: boolean;
}) {
  const run = {
    id: "capture-turn",
    userMessageId: "capture-message",
    ordinal: 1,
    status,
  } as OrchestrationV2Run;
  const item = {
    id: "reply",
    runId: "capture-turn",
    type: "assistant_message",
  } as OrchestrationV2TurnItem;
  const block: TranscriptBlock = { kind: "assistant", id: "reply", text: "Done", streaming: false };
  const changes = useTurnChanges(threadId, missing ? [] : [run], [item], [block], true);
  const record = changes.byBlock.get("reply");
  return (
    <div>
      <button
        type="button"
        onClick={() => void changes.begin(threadId, "capture-message", edit, "sequence")}
      >
        Start turn
      </button>
      <p>{changes.pending ? "Capturing turn" : "Ready"}</p>
      {record ? (
        <p>
          Turn {record.turnId}: {record.changes.length} changes
        </p>
      ) : null}
      {changes.unplaced.map((record) => (
        <p key={record.messageId}>{record.error}</p>
      ))}
    </div>
  );
}

it("captures before dispatch and after settlement, associates the reply, and restores cards after remount", async () => {
  const props = setup();
  localStorage.removeItem("axis-turn-changes-v1");
  state.snapshot.mockResolvedValueOnce({
    snapshot: props.record.before,
    signature: "before",
    checkpointId: "checkpoint",
    checkpointSignature: "before",
    checkpointError: null,
  });
  const after = { ...props.record.before, inPoint: 3 };
  state.snapshot.mockResolvedValue({ snapshot: after, signature: "after" });
  // This harness exercises the docked panel's turn lifecycle without router navigation.
  await using screen = await render(<CaptureTurn status="running" />, { router: false });
  await screen.getByRole("button", { name: "Start turn" }).click();
  await expect.element(screen.getByText("Capturing turn")).toBeVisible();
  expect(state.snapshot).toHaveBeenCalledTimes(1);
  expect(state.snapshot).toHaveBeenCalledWith(true, "sequence");
  await screen.rerender(<CaptureTurn status="completed" />);
  await expect.element(screen.getByText("Turn capture-turn: 1 changes")).toBeVisible();
  expect(state.snapshot).toHaveBeenCalledTimes(2);
  expect(state.snapshot).toHaveBeenLastCalledWith(false, "sequence");
  await screen.rerender(<CaptureTurn key="reloaded" status="completed" />);
  await expect.element(screen.getByText("Turn capture-turn: 1 changes")).toBeVisible();
  expect(state.snapshot).toHaveBeenCalledTimes(2);
});

it("uses read-only snapshots in Plan mode and completes a pending capture after reload", async () => {
  const props = setup();
  localStorage.removeItem("axis-turn-changes-v1");
  state.snapshot.mockResolvedValueOnce({
    snapshot: props.record.before,
    signature: "before",
    checkpointId: null,
    checkpointSignature: null,
    checkpointError: null,
  });
  // This harness exercises the docked panel's turn lifecycle without router navigation.
  await using screen = await render(<CaptureTurn status="running" edit={false} />, {
    router: false,
  });
  await screen.getByRole("button", { name: "Start turn" }).click();
  await expect.element(screen.getByText("Capturing turn")).toBeVisible();
  expect(state.snapshot).toHaveBeenCalledWith(false, "sequence");
  state.snapshot.mockResolvedValue({
    snapshot: { ...props.record.before, outPoint: 8 },
    signature: "after",
  });
  await screen.rerender(<CaptureTurn key="reloaded-pending" status="completed" edit={false} />);
  await expect.element(screen.getByText("Turn capture-turn: 1 changes")).toBeVisible();
  expect(state.snapshot).toHaveBeenCalledTimes(2);
  localStorage.removeItem("axis-turn-changes-v1");
});

it("unblocks capture when a reloaded draft was never accepted by the backend", async () => {
  const props = setup();
  localStorage.removeItem("axis-turn-changes-v1");
  state.snapshot.mockResolvedValue({
    snapshot: props.record.before,
    signature: "before",
    checkpointId: null,
    checkpointSignature: null,
    checkpointError: null,
  });
  // This harness exercises the docked panel's turn lifecycle without router navigation.
  await using screen = await render(<CaptureTurn status="running" />, { router: false });
  await screen.getByRole("button", { name: "Start turn" }).click();
  await expect.element(screen.getByText("Capturing turn")).toBeVisible();
  await screen.rerender(<CaptureTurn key="unaccepted-reload" status="completed" missing />);
  await expect
    .element(
      screen.getByText(
        "This turn could not be found after reloading. Its timeline comparison is unavailable.",
      ),
    )
    .toBeVisible();
  await expect.element(screen.getByText("Ready")).toBeVisible();
  expect(state.snapshot).toHaveBeenCalledTimes(1);
  localStorage.removeItem("axis-turn-changes-v1");
});

function RestoreWithSend(props: ReturnType<typeof setup>) {
  const [busy, setBusy] = useState(false);
  return (
    <>
      <button type="button" disabled={busy}>
        Send edit
      </button>
      <TurnChanges {...props} latest busy={busy} onRestoring={setBusy} />
    </>
  );
}

it("holds the shared edit lock until the checkpoint restore completes", async () => {
  const props = setup();
  let finish = () => {};
  state.restore.mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  // This harness exercises the docked panel's turn lifecycle without router navigation.
  await using screen = await render(<RestoreWithSend {...props} />, { router: false });
  await expect
    .element(screen.getByRole("button", { name: "Undo this turn", exact: true }))
    .toBeEnabled();
  await screen.getByRole("button", { name: "Undo this turn", exact: true }).click();
  await screen.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.element(screen.getByRole("button", { name: "Send edit" })).toBeDisabled();
  finish();
  await expect.element(screen.getByRole("button", { name: "Send edit" })).toBeEnabled();
  expect(props.onRestored).toHaveBeenCalledWith("message");
});
