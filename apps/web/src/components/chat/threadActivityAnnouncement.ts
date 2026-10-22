import type { OrchestrationV2RunStatus, RunId } from "@t3tools/contracts";

import { liveWorkEntryLabel, type MessagesTimelineRow } from "./MessagesTimeline.logic";

export type ThreadActivityStatus = "working" | "approval" | "input" | "idle";

export interface ThreadActivitySnapshot {
  readonly status: ThreadActivityStatus;
  /** The live row's label while the agent works, null when no row is live. */
  readonly activity: string | null;
  readonly runId: RunId | null;
  readonly runStatus: OrchestrationV2RunStatus | null;
}

export interface ThreadAnnouncementMemory {
  readonly snapshot: ThreadActivitySnapshot;
  /** Work started that has not been announced as ended yet. */
  readonly outcomePending: boolean;
  /** The run whose ending is already known, so a stale run is never announced as this turn's. */
  readonly settledRunId: RunId | null;
}

export interface ThreadAnnouncement {
  /** Activity updates are throttled; status changes are spoken at once. */
  readonly kind: "status" | "activity";
  readonly text: string;
}

/**
 * The live activity row's label. Reasoning is announced as "Thinking" and
 * never read aloud; its text stays in the timeline.
 */
export function liveActivityAnnouncementLabel(
  rows: ReadonlyArray<MessagesTimelineRow>,
  workspaceRoot: string | undefined,
): string | null {
  const row = rows.findLast(
    (candidate) =>
      (candidate.kind === "work-live" && candidate.active) || candidate.kind === "thinking",
  );
  if (row?.kind !== "work-live") return row === undefined ? null : "Thinking";
  if (row.entry.itemType === "reasoning") return "Thinking";
  return liveWorkEntryLabel(row.entry, workspaceRoot, true);
}

function runOutcomeText(status: OrchestrationV2RunStatus | null): string | null {
  switch (status) {
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "interrupted":
    case "cancelled":
      return "Stopped";
    default:
      return null;
  }
}

/**
 * Decides what a screen reader hears when the open thread changes. The first
 * snapshot of a thread is a silent baseline, so opening or switching threads
 * never replays what already happened.
 */
export function nextThreadAnnouncement(
  previous: ThreadAnnouncementMemory | null,
  next: ThreadActivitySnapshot,
): {
  readonly memory: ThreadAnnouncementMemory;
  readonly announcements: ReadonlyArray<ThreadAnnouncement>;
} {
  if (previous === null) {
    return {
      memory: {
        snapshot: next,
        outcomePending: next.status !== "idle",
        settledRunId: runOutcomeText(next.runStatus) === null ? null : next.runId,
      },
      announcements: [],
    };
  }
  const before = previous.snapshot.status;
  const memory = { ...previous, snapshot: next };
  const status = (text: string) => ({ kind: "status", text }) as const;
  const activity =
    next.activity === null ? [] : [{ kind: "activity", text: next.activity } as const];

  if (next.status === "approval") {
    return {
      memory: { ...memory, outcomePending: true },
      announcements: before === "approval" ? [] : [status("Needs approval")],
    };
  }
  if (next.status === "input") {
    return {
      memory: { ...memory, outcomePending: true },
      announcements: before === "input" ? [] : [status("Needs your input")],
    };
  }
  if (next.status === "working") {
    const working = { ...memory, outcomePending: true };
    if (before === "idle") {
      return { memory: working, announcements: [status("Working"), ...activity] };
    }
    return {
      memory: working,
      announcements: next.activity === previous.snapshot.activity ? [] : activity,
    };
  }

  // Work can stop a moment before the run settles; the ending waits for the run.
  const outcome = runOutcomeText(next.runStatus);
  if (!previous.outcomePending) {
    // A run that settled unseen is history too, or the next failed send would claim it.
    const settledRunId = outcome === null ? previous.settledRunId : next.runId;
    return { memory: { ...memory, settledRunId }, announcements: [] };
  }
  if (outcome === null || next.runId === previous.settledRunId) {
    return { memory, announcements: [] };
  }
  return {
    memory: { ...memory, outcomePending: false, settledRunId: next.runId },
    announcements: [status(outcome)],
  };
}
