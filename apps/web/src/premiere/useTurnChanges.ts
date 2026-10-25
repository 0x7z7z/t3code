import { useEffect, useEffectEvent, useRef, useState } from "react";
import type { OrchestrationV2Run, OrchestrationV2TurnItem } from "@t3tools/contracts";
import {
  diffTimeline,
  readTurnChanges,
  writeTurnChanges,
  type TurnChangeRecord,
} from "./turnChanges";
import { pruneCheckpoints, requestTimelineSnapshot } from "./timelineHost";
import type { TranscriptBlock } from "./transcript";

const settled = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);

export function useTurnChanges(
  threadId: string | null,
  runs: readonly OrchestrationV2Run[],
  items: readonly OrchestrationV2TurnItem[],
  blocks: readonly TranscriptBlock[],
  loaded = false,
) {
  const [records, setRecords] = useState<TurnChangeRecord[]>(() => {
    try {
      return readTurnChanges(localStorage);
    } catch {
      return [];
    }
  });
  const capturing = useRef(new Set<string>());
  const dispatching = useRef(new Set<string>());
  const [undoing, setUndoing] = useState(false);
  const verifyCapture = useEffectEvent((record: TurnChangeRecord, ordinal: number) => {
    if (record.threadId !== threadId)
      throw new Error("The active thread changed before the after snapshot was captured.");
    if (
      runs.some((next) => next.ordinal > ordinal) ||
      records.some((next) => next.messageId !== record.messageId && !next.after && !next.error)
    )
      throw new Error("A later turn started before the after snapshot was captured.");
  });
  useEffect(() => {
    writeTurnChanges(localStorage, records);
  }, [records]);
  useEffect(() => {
    for (const record of records) {
      if (record.threadId !== threadId || record.after || record.error) continue;
      const run = runs.find((run) => run.userMessageId === record.messageId);
      if (!run && loaded && !dispatching.current.has(record.messageId)) {
        setRecords((current) =>
          current.map((value) =>
            value.messageId === record.messageId
              ? {
                  ...value,
                  error:
                    "This turn could not be found after reloading. Its timeline comparison is unavailable.",
                }
              : value,
          ),
        );
        continue;
      }
      if (run) dispatching.current.delete(record.messageId);
      if (!run || !settled.has(run.status) || capturing.current.has(record.messageId)) continue;
      capturing.current.add(record.messageId);
      const update = (patch: Partial<TurnChangeRecord>) =>
        setRecords((current) =>
          current.map((value) =>
            value.messageId === record.messageId
              ? { ...value, turnId: run.id, turnNumber: run.ordinal, ...patch }
              : value,
          ),
        );
      if (runs.some((next) => next.ordinal > run.ordinal)) {
        update({ error: "A later turn started before the after snapshot was captured." });
        continue;
      }
      void requestTimelineSnapshot(false, record.before.sequenceId)
        .then((after) => {
          verifyCapture(record, run.ordinal);
          if (after.snapshot.projectId !== record.before.projectId)
            throw new Error("The active Premiere project changed.");
          const changes = diffTimeline(record.before, after.snapshot);
          update({ after: after.snapshot, signature: after.signature, changes });
          // Undo only uses the latest changed turn's checkpoint, so the rest are deleted.
          const earlier = records
            .filter(
              (value) =>
                value.messageId !== record.messageId &&
                value.changes.length &&
                !value.restored &&
                value.before.sequenceId === record.before.sequenceId,
            )
            .reduce<TurnChangeRecord | null>(
              (last, value) => (!last || value.createdAt > last.createdAt ? value : last),
              null,
            );
          const keep = changes.length ? record.checkpointId : (earlier?.checkpointId ?? null);
          void pruneCheckpoints(record.before.sequenceId, keep).catch(() => {});
        })
        .catch((error: unknown) =>
          update({
            error:
              error instanceof Error ? error.message : "The after snapshot could not be captured.",
          }),
        );
    }
  }, [threadId, runs, records, loaded]);

  const visible = records.filter(
    (record) => record.threadId === threadId && (record.after || record.error),
  );
  const latest = records
    .filter((record) => record.changes.length || record.error)
    .reduce<TurnChangeRecord | null>(
      (last, record) => (!last || record.createdAt > last.createdAt ? record : last),
      null,
    );
  const byBlock = new Map<string, TurnChangeRecord>();
  const runByItem = new Map(items.map((item) => [String(item.id), item.runId]));
  const replyByRun = new Map<string, string>();
  for (const block of blocks) {
    const runId = runByItem.get(block.id);
    if (block.kind === "assistant" && runId) replyByRun.set(runId, block.id);
  }
  const unplaced: TurnChangeRecord[] = [];
  for (const record of visible) {
    if (!record.changes.length && !record.error) continue;
    const target = replyByRun.get(record.turnId);
    if (target) byBlock.set(target, record);
    else unplaced.push(record);
  }
  return {
    byBlock,
    unplaced,
    latestId: latest?.messageId,
    undoing,
    setUndoing,
    pending: records.some((record) => !record.after && !record.error),
    pendingThreadId: records.find((record) => !record.after && !record.error)?.threadId,
    async begin(
      targetThread: string,
      messageId: string,
      checkpoint: boolean,
      sequenceId?: string,
      projectId?: string,
    ) {
      if (!sequenceId) return;
      // Editing must have a complete, verified checkpoint before dispatch.
      const before = await requestTimelineSnapshot(checkpoint, sequenceId).catch(
        (error: unknown) => {
          if (checkpoint) throw error;
          return null;
        },
      );
      if (!before) return;
      if (
        checkpoint &&
        (before.snapshot.truncated || !before.checkpointId || !before.checkpointSignature)
      )
        throw new Error(
          before.checkpointError ||
            "A complete timeline checkpoint is required before editing. No turn was sent.",
        );
      if (projectId && before.snapshot.projectId !== projectId)
        throw new Error(
          "The active Premiere project changed. Check the timeline, then send again.",
        );
      const record: TurnChangeRecord = {
        threadId: targetThread,
        turnId: messageId,
        messageId,
        turnNumber: 1,
        createdAt: Date.now(),
        before: before.snapshot,
        checkpointId: before.checkpointId,
        checkpointSignature: before.checkpointSignature,
        checkpointError: before.checkpointError,
        changes: [],
      };
      // Persist before dispatch so an in-progress turn survives a panel reload.
      dispatching.current.add(messageId);
      const next = [...records, record].slice(-30);
      writeTurnChanges(localStorage, next);
      setRecords(next);
    },
    cancel(messageId: string) {
      dispatching.current.delete(messageId);
      setRecords((current) => current.filter((record) => record.messageId !== messageId));
    },
    restored(messageId: string) {
      setRecords((current) =>
        current.map((record) =>
          record.messageId === messageId ? { ...record, restored: true } : record,
        ),
      );
    },
  };
}
