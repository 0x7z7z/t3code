import { useEffect, useRef, useState } from "react";
import type { PremiereContext } from "./host";
import { requestTimelineAction } from "./interactiveHost";

interface CleanupResult {
  outputPath: string;
  silencePath: string | null;
  breathsPath: string | null;
  regionsPath: string | null;
  regions: number;
  beforeSeconds: number;
  afterSeconds: number;
}

interface TimelineAnchor {
  sourcePath: string;
  projectName: string;
  sequenceName: string;
  projectId: string;
  sequenceId: string;
  nodeId: string;
  trackId: string;
  trackIndex: number;
  start: number;
  end: number;
  inPoint: number;
  outPoint: number;
}

interface Placement {
  recovery: boolean;
  path: string;
  sequenceId: string;
  trackIndex: number;
  start: number;
  checkpointId: string;
  checkpointSignature: string;
  expectedSignature: string;
  message: string;
}

function parseAnchor(value: unknown): TimelineAnchor | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Partial<TimelineAnchor>;
  if (
    typeof data.sequenceId !== "string" ||
    !data.sequenceId ||
    [data.projectId, data.nodeId, data.trackId, data.sourcePath].some(
      (field) => typeof field !== "string" || !field,
    ) ||
    !Number.isInteger(data.trackIndex) ||
    [data.start, data.end, data.inPoint, data.outPoint].some(
      (field) => typeof field !== "number" || !Number.isFinite(field),
    )
  )
    return null;
  return data as TimelineAnchor;
}

function parseResult(packet: object): CleanupResult {
  const data = packet as Partial<CleanupResult>;
  if (
    typeof data.outputPath !== "string" ||
    !data.outputPath ||
    !Number.isInteger(data.regions) ||
    data.regions! < 0 ||
    typeof data.beforeSeconds !== "number" ||
    !Number.isFinite(data.beforeSeconds) ||
    typeof data.afterSeconds !== "number" ||
    !Number.isFinite(data.afterSeconds)
  )
    throw new Error("Invalid VO cleanup result. Check the output folder before trying again.");
  return data as CleanupResult;
}

export function VOCleanupPanel({
  context,
  onClose,
}: {
  context: PremiereContext | null;
  onClose: () => void;
}) {
  const [sourceInput, setSourceInput] = useState({ path: "" });
  const source = sourceInput.path;
  const [mode, setMode] = useState("both");
  const [keepMs, setKeepMs] = useState("50");
  const [importResult, setImportResult] = useState(false);
  const [anchor, setAnchor] = useState<TimelineAnchor | null>(null);
  const [anchorMessage, setAnchorMessage] = useState("");
  const [toTimeline, setToTimeline] = useState(false);
  const [placement, setPlacement] = useState<Placement | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<CleanupResult | null>(null);
  const [imported, setImported] = useState(false);
  const [placementMessage, setPlacementMessage] = useState("");
  const [resultProject, setResultProject] = useState("");
  const lock = useRef(false);
  const projectId = context?.projectDocumentId || context?.projectPath || "";
  const sequenceId = context?.sequenceId || "";
  const projectName = context?.projectName || "";
  const sequenceName = context?.sequenceName || "";
  const validKeep = mode === "breaths" || (/^\d+$/.test(keepMs) && Number(keepMs) <= 5000);

  useEffect(() => {
    if (!sourceInput.path.trim() || !projectId || !sequenceId || placement) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void requestTimelineAction("premiere.vo-cleanup.request", {
        action: "resolve",
        path: sourceInput.path.trim(),
        projectId,
        sequenceId,
        projectName,
        sequenceName,
      }).then(
        (packet) => {
          if (cancelled) return;
          const found = parseAnchor("anchor" in packet ? packet.anchor : null);
          setAnchor(found);
          setAnchorMessage(
            "message" in packet && typeof packet.message === "string" ? packet.message : "",
          );
          if (!found) setToTimeline(false);
        },
        (failure: unknown) => {
          if (cancelled) return;
          setAnchor(null);
          setToTimeline(false);
          setAnchorMessage(
            failure instanceof Error ? failure.message : "Could not find this VO on the timeline.",
          );
        },
      );
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sourceInput, projectId, sequenceId, projectName, sequenceName, placement]);
  const currentAnchor =
    anchor?.projectId === projectId && anchor.sequenceId === sequenceId ? anchor : null;

  async function action(work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "VO cleanup failed.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }

  async function choose(selection: "pick" | "selected") {
    await action(async () => {
      const packet = await requestTimelineAction("premiere.vo-cleanup.request", {
        action: selection,
      });
      if ("path" in packet && typeof packet.path === "string" && packet.path) {
        setSourceInput({ path: packet.path });
        const found = parseAnchor("anchor" in packet ? packet.anchor : null);
        setAnchor(found);
        setAnchorMessage("");
        if (!found) setToTimeline(false);
      }
    });
  }
  async function importFile(path: string, project: string) {
    await requestTimelineAction("premiere.vo-cleanup.request", {
      action: "import",
      path,
      projectId: project,
    });
    setImported(true);
  }
  async function place(path: string, project: string, at: TimelineAnchor, keepTiming: boolean) {
    const packet = await requestTimelineAction("premiere.vo-cleanup.request", {
      action: "place",
      path,
      projectId: project,
      sequenceId: at.sequenceId,
      nodeId: at.nodeId,
      trackId: at.trackId,
      trackIndex: at.trackIndex,
      sourcePath: at.sourcePath,
      projectName: at.projectName,
      sequenceName: at.sequenceName,
      start: at.start,
      end: at.end,
      inPoint: at.inPoint,
      outPoint: at.outPoint,
      keepTiming,
      confirmed: true,
    });
    const data = packet as Partial<Placement> & { status?: string; message?: string };
    if (
      !Number.isInteger(data.trackIndex) ||
      typeof data.start !== "number" ||
      typeof data.checkpointId !== "string" ||
      !data.checkpointId ||
      typeof data.checkpointSignature !== "string" ||
      !data.checkpointSignature ||
      typeof data.expectedSignature !== "string" ||
      (data.status !== "placed" && data.status !== "recovery")
    )
      throw new Error("Placement could not be verified. Check the timeline.");
    setImported(true);
    setPlacement({
      recovery: data.status === "recovery",
      path,
      sequenceId: at.sequenceId,
      trackIndex: data.trackIndex as number,
      start: data.start,
      checkpointId: data.checkpointId,
      checkpointSignature: data.checkpointSignature,
      expectedSignature: data.expectedSignature,
      message: data.message || `Placed on A${data.trackIndex! + 1} at ${data.start.toFixed(3)} s.`,
    });
    if (data.status === "recovery")
      throw new Error(data.message || "Check the timeline and use Undo placement.");
  }
  async function unplace(placed: Placement, project: string) {
    const packet = await requestTimelineAction("premiere.vo-cleanup.request", {
      action: "unplace",
      projectId: project,
      sequenceId: placed.sequenceId,
      checkpointId: placed.checkpointId,
      checkpointSignature: placed.checkpointSignature,
      expectedSignature: placed.expectedSignature,
    });
    if (!("status" in packet) || packet.status !== "unplaced")
      throw new Error("Checkpoint restore could not be verified. Check the timeline.");
    setPlacement(null);
    setPlacementMessage(
      "message" in packet && typeof packet.message === "string"
        ? packet.message
        : "Checkpoint restored.",
    );
    setAnchor(null);
    setToTimeline(false);
  }
  async function clean() {
    if (!source.trim() || !validKeep) return;
    await action(async () => {
      const targetAnchor = toTimeline ? currentAnchor : null;
      const targetProject = targetAnchor?.projectId || projectId;
      setResult(null);
      setImported(false);
      setPlacement(null);
      setPlacementMessage("");
      const packet = await requestTimelineAction("premiere.vo-cleanup.request", {
        action: "run",
        path: source.trim(),
        mode,
        keepMs: mode === "breaths" ? 50 : Number(keepMs),
      });
      const output = parseResult(packet);
      setResult(output);
      setResultProject(targetProject);
      if (targetAnchor && targetProject) {
        try {
          await place(output.outputPath, targetProject, targetAnchor, mode === "breaths");
        } catch (failure) {
          setAnchor(null);
          setToTimeline(false);
          throw failure;
        }
      } else if (importResult && targetProject) await importFile(output.outputPath, targetProject);
    });
  }

  return (
    <section data-vo-cleanup="" aria-label="VO cleanup" aria-busy={busy}>
      <header>
        <strong>Clean VO</strong>
        <button type="button" data-ghost-button="" onClick={onClose}>
          Close
        </button>
      </header>
      <p>Save a cleaned copy beside your audio. The source is never changed.</p>
      <fieldset disabled={busy}>
        <label>
          <span>Audio file</span>
          <input
            value={source}
            onChange={(event) => {
              setSourceInput({ path: event.target.value });
              setAnchor(null);
              setAnchorMessage("");
              setToTimeline(false);
            }}
            placeholder="Choose audio or paste its full path"
          />
        </label>
        <div data-vo-actions="">
          <button type="button" onClick={() => void choose("pick")}>
            Browse...
          </button>
          <button type="button" onClick={() => void choose("selected")}>
            Use selected clip
          </button>
        </div>
        <label>
          <span>Remove</span>
          <select value={mode} onChange={(event) => setMode(event.target.value)}>
            <option value="both">Silence, then breaths</option>
            <option value="sandwich">Silence, breaths, then silence</option>
            <option value="silence">Silence only</option>
            <option value="breaths">Breaths only</option>
          </select>
        </label>
        {mode !== "breaths" ? (
          <label>
            <span>Keep silence (ms)</span>
            <input
              type="number"
              min="0"
              max="5000"
              step="1"
              value={keepMs}
              aria-invalid={!validKeep}
              onChange={(event) => setKeepMs(event.target.value)}
            />
          </label>
        ) : null}
        <label data-vo-import="">
          <input
            type="checkbox"
            checked={importResult}
            disabled={!projectId}
            onChange={(event) => setImportResult(event.target.checked)}
          />
          Import result into project bin
        </label>
        <label data-vo-import="">
          <input
            type="checkbox"
            checked={toTimeline}
            disabled={!currentAnchor || placement !== null}
            onChange={(event) => setToTimeline(event.target.checked)}
          />
          {currentAnchor
            ? `Import into timeline below A${currentAnchor.trackIndex + 1}`
            : "Import into timeline"}
        </label>
        {anchorMessage ? (
          <p role="note" data-vo-anchor-message="">
            {anchorMessage}
          </p>
        ) : null}
        {mode !== "silence" ? (
          <p>
            Breath cleanup uses WhisperX word timings. Breaths only keeps the audio length. Long VOs
            can take a while.
          </p>
        ) : null}
        <button
          type="button"
          data-primary-button=""
          disabled={!source.trim() || !validKeep || placement !== null}
          onClick={() => void clean()}
        >
          Clean VO
        </button>
      </fieldset>
      {busy ? <p role="status">Working on your VO. Keep Axis open until it finishes.</p> : null}
      {result ? (
        <div data-vo-result="" role="status">
          <strong>
            {result.beforeSeconds.toFixed(2)} s to {result.afterSeconds.toFixed(2)} s
          </strong>
          <p>{result.regions} breath regions lowered</p>
          <label>
            <span>Cleaned audio</span>
            <input readOnly value={result.outputPath} />
          </label>
          {result.silencePath && result.silencePath !== result.outputPath ? (
            <p>Silence-only copy: {result.silencePath}</p>
          ) : null}
          {result.breathsPath && result.breathsPath !== result.outputPath ? (
            <p>Breath-cleaned copy: {result.breathsPath}</p>
          ) : null}
          {result.regionsPath ? <p>Breath regions: {result.regionsPath}</p> : null}
          {placement ? (
            <div data-vo-actions="">
              <span>{placement.recovery ? "Placement needs recovery." : placement.message}</span>
              <button
                type="button"
                disabled={busy}
                onClick={() => void action(() => unplace(placement, resultProject))}
              >
                Undo placement
              </button>
            </div>
          ) : imported ? (
            <p>{placementMessage || "Imported into Axis VO cleanup."}</p>
          ) : resultProject ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void action(() => importFile(result.outputPath, resultProject))}
            >
              Import cleaned VO
            </button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert">
          {error}
          {result ? " Your cleaned files are saved." : ""}
        </p>
      ) : null}
    </section>
  );
}
