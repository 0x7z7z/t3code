import { useState } from "react";
import { CheckIcon, CopyIcon, MapPinIcon } from "lucide-react";
import { ClipButton } from "./ClipButton";
import { clipNames } from "./clipLinks";
import type { TimelineActions } from "./interactiveHost";
import { parseSuggestion, shotMarkers, shotsCsv, type MarkerSuggestion } from "./suggestionBlocks";

/** Timeline-style timecode, such as 0:02:36 at 60 fps; hours appear only when needed. */
function timecodeLabel(seconds: number, fps: number) {
  const rate = Math.max(1, Math.round(fps));
  const frames = Math.round(seconds * fps);
  const whole = Math.floor(frames / rate);
  const pad = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(whole / 3600);
  const clock = `${hours ? `${hours}:${pad(Math.floor(whole / 60) % 60)}` : Math.floor(whole / 60)}:${pad(whole % 60)}`;
  return `${clock}:${pad(frames % rate)}`;
}

function durationLabel(seconds: number) {
  return `${Math.round(seconds * 10) / 10}s`;
}

function AddMarkers({
  markers,
  actions,
  label,
}: {
  markers: readonly MarkerSuggestion[];
  actions: TimelineActions;
  label?: string;
}) {
  const [sequenceId] = useState(actions.sequenceId);
  const [result, setResult] = useState<
    | { kind: "idle" }
    | { kind: "pending" }
    | { kind: "added"; count: number }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const changed = sequenceId !== actions.sequenceId;
  const add = async () => {
    if (
      !actions.canAddMarkers ||
      changed ||
      !markers.length ||
      result.kind === "added" ||
      result.kind === "pending"
    )
      return;
    const count = markers.length;
    setResult({ kind: "pending" });
    try {
      await actions.addMarkers(markers);
      setResult({ kind: "added", count });
    } catch (error) {
      setResult({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not add markers.",
      });
    }
  };
  return (
    <>
      <button
        type="button"
        disabled={
          !actions.canAddMarkers ||
          changed ||
          !markers.length ||
          result.kind === "pending" ||
          result.kind === "added"
        }
        onClick={() => void add()}
      >
        {result.kind === "added" ? (
          <CheckIcon size={13} aria-hidden="true" />
        ) : (
          <MapPinIcon size={13} aria-hidden="true" />
        )}
        {result.kind === "added"
          ? `Added ${result.count} markers`
          : result.kind === "pending"
            ? "Adding markers..."
            : (label ?? `Add ${markers.length} markers`)}
      </button>
      {changed ? <small>Return to the original sequence to add these markers.</small> : null}
      {result.kind === "error" ? <small role="alert">{result.message}</small> : null}
    </>
  );
}

export function Suggestions({
  kind,
  source,
  actions,
  complete,
}: {
  kind: string;
  source: string;
  actions: TimelineActions;
  complete: boolean;
}) {
  const parsed = parseSuggestion(kind, source, actions.fps);
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const [copy, setCopy] = useState("");
  if (parsed.kind === "invalid" || !complete)
    return (
      <>
        <pre>
          <code>{source}</code>
        </pre>
        {complete && parsed.kind === "invalid" ? (
          <small data-action-error="">Interactive suggestion unavailable: {parsed.error}</small>
        ) : null}
      </>
    );
  const seekTime = (seconds: number) => (
    <button
      type="button"
      data-timestamp=""
      aria-label={`Move playhead to ${timecodeLabel(seconds, actions.fps)}`}
      onClick={() => actions.seek(seconds)}
    >
      {timecodeLabel(seconds, actions.fps)}
    </button>
  );
  if (parsed.kind === "markers")
    return (
      <section data-timeline-suggestions="markers" aria-label="Suggested markers">
        <ul>
          {parsed.markers.map((marker) => (
            <li key={JSON.stringify(marker)}>
              <input
                type="checkbox"
                aria-label={`Include marker ${marker.name}`}
                checked={!unchecked.has(JSON.stringify(marker))}
                onChange={(event) => {
                  const next = new Set(unchecked);
                  if (event.target.checked) next.delete(JSON.stringify(marker));
                  else next.add(JSON.stringify(marker));
                  setUnchecked(next);
                }}
              />
              <span
                data-marker-color={marker.color ?? "green"}
                aria-label={marker.color ?? "green"}
              />
              <div>
                {seekTime(marker.time)} <strong>{marker.name}</strong>
                {marker.comment ? <p>{marker.comment}</p> : null}
              </div>
            </li>
          ))}
        </ul>
        <footer>
          <AddMarkers
            markers={parsed.markers.filter((marker) => !unchecked.has(JSON.stringify(marker)))}
            actions={actions}
          />
        </footer>
      </section>
    );
  const names = clipNames(actions.clips);
  const copyCsv = async () => {
    try {
      await navigator.clipboard.writeText(shotsCsv(parsed.shots));
      setCopy("CSV copied");
    } catch {
      setCopy("Could not copy CSV. Check clipboard access.");
    }
  };
  return (
    <section data-timeline-suggestions="shots" aria-label="Shot plan">
      <div data-shot-scroll="">
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>In</th>
              <th>Out</th>
              <th>Duration</th>
              <th>Description</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {parsed.shots.map((shot) => (
              <tr key={shot.shotId} data-shot-status={shot.status}>
                <td>{shot.shotId}</td>
                <td>{seekTime(shot.timelineInSeconds)}</td>
                <td>{seekTime(shot.timelineOutSeconds)}</td>
                <td>{durationLabel(shot.durationSeconds)}</td>
                <td data-shot-description="">
                  <span data-shot-text="">{shot.rationale}</span>
                  {shot.notes ? <small data-shot-text="">{shot.notes}</small> : null}
                </td>
                <td data-shot-source="">
                  {names.includes(shot.assetName) ? (
                    <ClipButton name={shot.assetName} actions={actions} />
                  ) : (
                    <span data-shot-text="">{shot.assetName}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <footer>
        <AddMarkers markers={shotMarkers(parsed.shots)} actions={actions} label="Add as markers" />
        <button type="button" onClick={() => void copyCsv()}>
          <CopyIcon size={13} aria-hidden="true" />
          Copy CSV
        </button>
        {copy ? <small role="status">{copy}</small> : null}
      </footer>
    </section>
  );
}
