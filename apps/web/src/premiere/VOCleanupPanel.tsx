import { useRef, useState } from "react";
import type { PremiereContext } from "./host";
import { requestTimelineAction } from "./interactiveHost";

interface CleanupResult {
  outputPath: string;
  silencePath: string | null;
  regionsPath: string | null;
  regions: number;
  beforeSeconds: number;
  afterSeconds: number;
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
  const [source, setSource] = useState("");
  const [mode, setMode] = useState("both");
  const [keepMs, setKeepMs] = useState("50");
  const [importResult, setImportResult] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<CleanupResult | null>(null);
  const [imported, setImported] = useState(false);
  const [resultProject, setResultProject] = useState("");
  const lock = useRef(false);
  const projectId = context?.projectDocumentId || context?.projectPath || "";
  const validKeep = mode === "breaths" || (/^\d+$/.test(keepMs) && Number(keepMs) <= 5000);

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
      if ("path" in packet && typeof packet.path === "string" && packet.path)
        setSource(packet.path);
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
  async function clean() {
    if (!source.trim() || !validKeep) return;
    await action(async () => {
      const targetProject = projectId;
      setResult(null);
      setImported(false);
      const packet = await requestTimelineAction("premiere.vo-cleanup.request", {
        action: "run",
        path: source.trim(),
        mode,
        keepMs: mode === "breaths" ? 50 : Number(keepMs),
      });
      const output = parseResult(packet);
      setResult(output);
      setResultProject(targetProject);
      if (importResult && targetProject) await importFile(output.outputPath, targetProject);
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
      <p>Save a cleaned copy beside your audio. The source and timeline stay as they are.</p>
      <fieldset disabled={busy}>
        <label>
          <span>Audio file</span>
          <input
            value={source}
            onChange={(event) => setSource(event.target.value)}
            placeholder="Choose audio or paste its full path"
          />
        </label>
        <div data-vo-actions="">
          <button type="button" onClick={() => void choose("pick")}>
            Browse...
          </button>
          <button type="button" onClick={() => void choose("selected")}>
            Use selected project item
          </button>
        </div>
        <label>
          <span>Remove</span>
          <select value={mode} onChange={(event) => setMode(event.target.value)}>
            <option value="both">Silence, then breaths</option>
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
        {mode !== "silence" ? (
          <p>
            Breath cleanup uses WhisperX word timings and keeps the audio length. Long VOs can take
            a while.
          </p>
        ) : null}
        <button
          type="button"
          data-primary-button=""
          disabled={!source.trim() || !validKeep}
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
          {result.regionsPath ? <p>Breath regions: {result.regionsPath}</p> : null}
          {imported ? (
            <p>Imported into Axis VO cleanup.</p>
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
