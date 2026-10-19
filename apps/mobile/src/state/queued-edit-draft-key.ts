/**
 * The marker must contain no colon: composerDraftEnvironmentId parses before the last colon.
 * Keep queued edits under separate keys so the user's original draft survives.
 */
const QUEUED_EDIT_DRAFT_MARKER = "~queued-edit~";

export function queuedEditDraftKey(threadKey: string, runId: string): string {
  return `${threadKey}${QUEUED_EDIT_DRAFT_MARKER}${runId}`;
}

export function isQueuedEditDraftKey(draftKey: string): boolean {
  return draftKey.includes(QUEUED_EDIT_DRAFT_MARKER);
}
