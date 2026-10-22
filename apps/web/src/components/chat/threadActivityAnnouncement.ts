import type { OrchestrationV2RunStatus, RunId } from "@t3tools/contracts";

export type ThreadActivityStatus = "working" | "approval" | "input" | "idle";

export interface ThreadActivitySnapshot {
  readonly status: ThreadActivityStatus;
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
 * Decides what a screen reader hears when the open thread's turn changes state.
 * The first snapshot of a thread is a silent baseline, so opening or switching
 * threads never replays what already happened.
 */
export function nextThreadAnnouncement(
  previous: ThreadAnnouncementMemory | null,
  next: ThreadActivitySnapshot,
): { readonly memory: ThreadAnnouncementMemory; readonly announcement: string | null } {
  if (previous === null) {
    return {
      memory: {
        snapshot: next,
        outcomePending: next.status !== "idle",
        settledRunId: runOutcomeText(next.runStatus) === null ? null : next.runId,
      },
      announcement: null,
    };
  }
  const before = previous.snapshot.status;
  const memory = { ...previous, snapshot: next };

  if (next.status !== "idle") {
    const announcement =
      next.status === before
        ? null
        : next.status === "approval"
          ? "Needs approval"
          : next.status === "input"
            ? "Needs your input"
            : // Sending can look idle for a moment before the server reports the
              // run; that flicker is still the same turn.
              before === "idle" && !previous.outcomePending
              ? "Working"
              : null;
    return { memory: { ...memory, outcomePending: true }, announcement };
  }

  // Work can stop a moment before the run settles; the ending waits for the run.
  const outcome = runOutcomeText(next.runStatus);
  if (!previous.outcomePending) {
    // A run that settled unseen is history too, or the next failed send would claim it.
    const settledRunId = outcome === null ? previous.settledRunId : next.runId;
    return { memory: { ...memory, settledRunId }, announcement: null };
  }
  if (outcome === null) return { memory, announcement: null };
  // Work stopped without a new run, e.g. a send that failed; the retry is a new turn.
  if (next.runId === previous.settledRunId) {
    return { memory: { ...memory, outcomePending: false }, announcement: null };
  }
  return {
    memory: { ...memory, outcomePending: false, settledRunId: next.runId },
    announcement: outcome,
  };
}
