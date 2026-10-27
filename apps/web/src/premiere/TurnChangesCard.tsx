import { useEffect, useState } from "react";
import { ChevronRightIcon, ListChecksIcon, Undo2Icon } from "lucide-react";
import { seekPremiere, type PremiereHostState } from "./host";
import { requestTimelineSnapshot, restoreTimeline } from "./timelineHost";
import { summarizeChanges, type TurnChangeRecord } from "./turnChanges";

function timecode(seconds: number) {
  const ms = Math.round(Math.max(0, seconds) * 1000);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${String(ms % 1000).padStart(3, "0")}`;
}

export function TurnChanges({
  record,
  host,
  latest,
  busy,
  onRestored,
  onRestoring,
}: {
  record: TurnChangeRecord;
  host: PremiereHostState;
  latest: boolean;
  busy: boolean;
  onRestored: (messageId: string) => void;
  onRestoring?: (restoring: boolean) => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const connected = host.connected && host.context?.sequenceId === record.before.sequenceId;
  const reason = record.restored
    ? "This turn has been undone. The after version is preserved."
    : !host.connected
      ? "Connect to Premiere to undo this turn."
      : !connected
        ? "Open this turn's sequence in Premiere to undo it."
        : busy && !restoring
          ? "Wait for the current turn and its timeline snapshot to finish."
          : !latest
            ? "Only the latest turn that changed the timeline can be undone."
            : (record.error ??
              (record.before.truncated || record.after?.truncated
                ? "This timeline exceeds the snapshot limit; undo is unavailable."
                : !record.checkpointId
                  ? (record.checkpointError ??
                    "No checkpoint was created for this turn (Plan mode).")
                  : !record.signature || !record.checkpointSignature
                    ? "Checkpoint verification data is unavailable."
                    : (problem ?? (!checked ? "Checking the timeline checkpoint..." : null))));

  // oxlint-disable-next-line t3code/react-effect-budget -- Revalidate the undo checkpoint against the live Premiere timeline.
  useEffect(() => {
    if (!connected || !latest || busy || record.restored || !record.checkpointId || !record.after)
      return;
    let disposed = false;
    void requestTimelineSnapshot(false, record.before.sequenceId)
      .then((current) => {
        if (disposed) return;
        setProblem(
          !current.checkpointIds.includes(record.checkpointId!)
            ? "This turn's checkpoint is gone or was renamed."
            : current.signature !== record.signature
              ? "The timeline changed after this turn. Undo is unavailable."
              : null,
        );
        setChecked(true);
      })
      .catch((error: unknown) => {
        if (!disposed) {
          setProblem(error instanceof Error ? error.message : "Could not check the checkpoint.");
          setChecked(true);
        }
      });
    return () => {
      disposed = true;
    };
  }, [connected, latest, busy, record]);

  async function undo() {
    const { checkpointId, signature, checkpointSignature } = record;
    if (reason || !checkpointId || !signature || !checkpointSignature) return;
    if (!confirm) {
      setConfirm(true);
      return;
    }
    setRestoring(true);
    onRestoring?.(true);
    return await (async () => {
      await restoreTimeline({
        checkpointId,
        sequenceId: record.before.sequenceId,
        expectedSignature: signature,
        checkpointSignature,
        turnNumber: record.turnNumber,
      });
      onRestored(record.messageId);
    })()
      .catch((error) => {
        setProblem(
          error instanceof Error ? error.message : "Premiere could not restore this turn.",
        );
      })
      .finally(() => {
        setRestoring(false);
        onRestoring?.(false);
        setConfirm(false);
      });
  }

  if (!record.changes.length && !record.error) return null;
  return (
    <section data-turn-changes="" aria-label={`Timeline changes for turn ${record.turnNumber}`}>
      <details>
        <summary>
          <ChevronRightIcon size={12} data-change-chevron="" aria-hidden="true" />
          <ListChecksIcon size={13} aria-hidden="true" />
          <span>
            {record.error ? "Timeline summary unavailable for" : "Changed in"} {record.before.name}:{" "}
            {summarizeChanges(record.changes) || "Snapshot unavailable"}
          </span>
        </summary>
        <ol>
          {record.changes.map((change) => (
            <li key={change.id}>
              <button
                type="button"
                data-timestamp=""
                disabled={!connected}
                aria-label={`Move playhead to ${timecode(change.seconds)}`}
                onClick={() => seekPremiere(change.seconds, record.before.sequenceId)}
              >
                {timecode(change.seconds)}
              </button>
              <span>{change.text}</span>
            </li>
          ))}
        </ol>
        {record.before.truncated || record.after?.truncated ? (
          <p>Partial summary: limited to 2,000 clips and 500 markers.</p>
        ) : null}
      </details>
      <div data-turn-undo="">
        <button
          type="button"
          disabled={Boolean(reason) || restoring}
          aria-describedby={reason ? `undo-${record.messageId}` : undefined}
          onClick={() => void undo()}
        >
          <Undo2Icon size={12} aria-hidden="true" />
          {restoring ? "Restoring..." : confirm ? "Undo" : "Undo this turn"}
        </button>
        {confirm && !reason ? (
          <>
            <span>Undo this turn? The current version will be kept.</span>
            <button type="button" disabled={restoring} onClick={() => setConfirm(false)}>
              Cancel
            </button>
          </>
        ) : null}
      </div>
      {reason ? (
        <p id={`undo-${record.messageId}`} role={problem || record.error ? "status" : undefined}>
          {reason}
        </p>
      ) : null}
    </section>
  );
}
