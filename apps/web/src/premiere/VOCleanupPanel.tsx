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

interface CleanupProgress {
  steps: string[];
  index: number;
  stepPercent: number | null;
  percent: number;
  audioSeconds: number | null;
}

interface CleanupJob {
  startedAt: number;
  finishStep: string | null;
  secondsPerAudioSecond: number | null;
}

const STUCK_MS = 5 * 60 * 1000;
const SPEED_KEY = "axis.voCleanup.secondsPerAudioSecond.";

function parseProgress(value: unknown): CleanupProgress | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Partial<CleanupProgress>;
  if (
    !Array.isArray(data.steps) ||
    !data.steps.every((step) => typeof step === "string") ||
    !Number.isInteger(data.index) ||
    data.index! < 0 ||
    data.index! >= data.steps.length ||
    typeof data.percent !== "number" ||
    !Number.isFinite(data.percent)
  )
    return null;
  return {
    steps: data.steps,
    index: data.index!,
    stepPercent: typeof data.stepPercent === "number" ? data.stepPercent : null,
    percent: Math.min(100, Math.max(0, data.percent)),
    audioSeconds: typeof data.audioSeconds === "number" ? data.audioSeconds : null,
  };
}

// Browser storage can be unavailable, and an estimate is never worth failing a run.
function savedSpeed(mode: string) {
  try {
    const value = Number(localStorage.getItem(SPEED_KEY + mode));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function saveSpeed(mode: string, value: number) {
  try {
    if (Number.isFinite(value) && value > 0) localStorage.setItem(SPEED_KEY + mode, String(value));
  } catch {
    // The next run shows no estimate until its own percentage arrives.
  }
}

function timeLeftMs(progress: CleanupProgress | null, elapsedMs: number, speed: number | null) {
  if (!progress) return null;
  if (progress.percent >= 10) return (elapsedMs * (100 - progress.percent)) / progress.percent;
  if (speed === null || progress.audioSeconds === null) return null;
  const left = speed * progress.audioSeconds * 1000 - elapsedMs;
  return left > 0 ? left : null;
}

function clock(ms: number) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function timeLeftLabel(ms: number) {
  return ms < 60000 ? "Less than a minute left" : `About ${Math.ceil(ms / 60000)} min left`;
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
  const [job, setJob] = useState<CleanupJob | null>(null);
  const [progress, setProgress] = useState<CleanupProgress | null>(null);
  const [now, setNow] = useState(0);
  const [stuck, setStuck] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [notice, setNotice] = useState("");
  const lock = useRef(false);
  const projectId = context?.projectDocumentId || context?.projectPath || "";
  const sequenceId = context?.sequenceId || "";
  const projectName = context?.projectName || "";
  const sequenceName = context?.sequenceName || "";
  const validKeep = mode === "breaths" || (/^\d+$/.test(keepMs) && Number(keepMs) <= 5000);

  // oxlint-disable-next-line t3code/react-effect-budget -- Resolve the selected source against Premiere after the host or path changes.
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

  // oxlint-disable-next-line t3code/react-effect-budget -- Poll the external cleanup job while it runs.
  useEffect(() => {
    if (!job) return;
    let disposed = false;
    let reading = false;
    let lastSeen = "";
    let lastChange = Date.now();
    const poll = () => {
      if (reading) return;
      reading = true;
      void requestTimelineAction("premiere.vo-cleanup.request", { action: "progress" })
        .then((packet) => {
          if (disposed) return;
          const found = parseProgress("progress" in packet ? packet.progress : null);
          if (!found) return;
          setProgress(found);
          const seen = JSON.stringify([found.index, found.stepPercent]);
          if (seen !== lastSeen) {
            lastSeen = seen;
            lastChange = Date.now();
          }
        })
        // A missed poll only delays the display. The run itself reports any failure.
        .catch(() => undefined)
        .finally(() => {
          reading = false;
        });
    };
    poll();
    const timer = setInterval(() => {
      setNow(Date.now());
      setStuck(Date.now() - lastChange > STUCK_MS);
      poll();
    }, 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [job]);

  async function action(work: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    return await (async () => {
      await work();
    })()
      .catch((failure) => {
        setError(failure instanceof Error ? failure.message : "VO cleanup failed.");
      })
      .finally(() => {
        lock.current = false;
        setBusy(false);
      });
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
      const startedAt = Date.now();
      setResult(null);
      setImported(false);
      setPlacement(null);
      setPlacementMessage("");
      setNotice("");
      setProgress(null);
      setStuck(false);
      setFinishing(false);
      setCancelling(false);
      setNow(startedAt);
      setJob({
        startedAt,
        finishStep:
          targetAnchor && targetProject
            ? "Placing on timeline"
            : importResult && targetProject
              ? "Importing into project"
              : null,
        secondsPerAudioSecond: savedSpeed(mode),
      });
      return await (async () => {
        const packet = await requestTimelineAction("premiere.vo-cleanup.request", {
          action: "run",
          path: source.trim(),
          mode,
          keepMs: mode === "breaths" ? 50 : Number(keepMs),
        });
        const output = parseResult(packet);
        saveSpeed(mode, (Date.now() - startedAt) / 1000 / output.beforeSeconds);
        setResult(output);
        setResultProject(targetProject);
        setFinishing(true);
        if (targetAnchor && targetProject) {
          try {
            await place(output.outputPath, targetProject, targetAnchor, mode === "breaths");
          } catch (failure) {
            setAnchor(null);
            setToTimeline(false);
            throw failure;
          }
        } else if (importResult && targetProject)
          await importFile(output.outputPath, targetProject);
      })()
        .catch((failure: unknown) => {
          if (!(failure instanceof Error) || !failure.message.startsWith("VO cleanup cancelled"))
            throw failure;
          setNotice(failure.message);
        })
        .finally(() => setJob(null));
    });
  }
  async function cancel() {
    setCancelling(true);
    await requestTimelineAction("premiere.vo-cleanup.request", { action: "cancel" }).catch(
      (failure: unknown) => {
        setCancelling(false);
        setError(failure instanceof Error ? failure.message : "Could not cancel VO cleanup.");
      },
    );
  }

  const elapsedMs = job ? Math.max(0, now - job.startedAt) : 0;
  const leftMs =
    job && !finishing ? timeLeftMs(progress, elapsedMs, job.secondsPerAudioSecond) : null;
  const stepLabels = [...(progress?.steps ?? []), ...(job?.finishStep ? [job.finishStep] : [])];
  const currentStep = finishing ? (progress?.steps.length ?? 0) : (progress?.index ?? 0);
  const barPercent = finishing ? 100 : (progress?.percent ?? 0);

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
      {job ? (
        <div data-vo-progress="" role="status">
          <progress
            aria-label="Clean VO progress"
            max={100}
            {...(barPercent > 0 ? { value: barPercent } : {})}
          />
          {stepLabels.length ? (
            <ol>
              {stepLabels.map((label, index) => (
                <li
                  key={label}
                  data-step={
                    index < currentStep ? "done" : index === currentStep ? "current" : "waiting"
                  }
                  aria-current={index === currentStep ? "step" : undefined}
                >
                  {index < currentStep ? "✓ " : ""}
                  {label}
                  {index === currentStep && !finishing && progress?.stepPercent != null
                    ? ` ${Math.floor(progress.stepPercent)}%`
                    : ""}
                </li>
              ))}
            </ol>
          ) : (
            <p>Starting...</p>
          )}
          <p>
            {clock(elapsedMs)} elapsed
            {leftMs !== null ? `. ${timeLeftLabel(leftMs)}` : ""}
          </p>
          {stuck ? (
            <p data-vo-stuck="">
              No progress for 5 minutes. Axis is still running it, and you can keep waiting or
              cancel.
            </p>
          ) : null}
          {finishing ? null : (
            <button type="button" disabled={cancelling} onClick={() => void cancel()}>
              {cancelling ? "Cancelling..." : "Cancel"}
            </button>
          )}
          <p>Keep Axis open until it finishes.</p>
        </div>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
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
