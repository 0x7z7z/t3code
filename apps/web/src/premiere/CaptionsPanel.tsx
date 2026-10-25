import { useRef, useState } from "react";
import {
  captionTimestamp,
  exportSrt,
  segmentCaptions,
  shortsCaptions,
  youtubeCaptions,
  type CaptionOptions,
} from "./captions";
import type { PremiereContext } from "./host";
import { requestTimelineAction } from "./interactiveHost";
import type { TranscriptWord } from "./sequenceTranscript";

interface CaptionUndo {
  binId: string;
  itemId: string;
  checkpointId?: string;
  checkpointSignature?: string;
  expectedSignature?: string;
}
function readUndo(key: string): CaptionUndo | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (
      value &&
      typeof value === "object" &&
      "binId" in value &&
      typeof value.binId === "string" &&
      "itemId" in value &&
      typeof value.itemId === "string" &&
      (!("checkpointId" in value) ||
        (typeof value.checkpointId === "string" &&
          "checkpointSignature" in value &&
          typeof value.checkpointSignature === "string" &&
          "expectedSignature" in value &&
          typeof value.expectedSignature === "string"))
    )
      return value as CaptionUndo;
  } catch {
    /* Storage can be unavailable in CEP. */
  }
  return null;
}

export function CaptionsPanel({
  context,
  words,
  disabled,
  onBusy,
  onClose,
  onRestored,
}: {
  context: PremiereContext;
  words: readonly TranscriptWord[];
  disabled: boolean;
  onBusy: (busy: boolean) => void;
  onClose: () => void;
  onRestored?: (sequenceId: string) => void;
}) {
  const [preset, setPreset] = useState("youtube");
  const [options, setOptions] = useState<CaptionOptions>(youtubeCaptions);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const lock = useRef(false);
  const projectId = context.projectDocumentId || context.projectPath;
  const storageKey = `axis-captions-undo:${JSON.stringify([projectId, context.sequenceId])}`;
  const [undo, setUndo] = useState(() => readUndo(storageKey));
  let cues: ReturnType<typeof segmentCaptions> = [];
  let validation: string | null = null;
  try {
    cues = segmentCaptions(words, options);
  } catch (problem) {
    validation = problem instanceof Error ? problem.message : "Invalid caption options.";
  }
  function change(patch: Partial<CaptionOptions>) {
    setPreset("custom");
    setOptions({ ...options, ...patch });
  }
  function saveUndo(value: CaptionUndo | null) {
    setUndo(value);
    try {
      if (value) localStorage.setItem(storageKey, JSON.stringify(value));
      else localStorage.removeItem(storageKey);
    } catch {
      setError(
        "Undo could not be saved. Keep Captions open to retain undo, or open the pre-caption sequence in Axis checkpoints.",
      );
    }
  }
  async function run(action: "add" | "save" | "undo") {
    if (
      lock.current ||
      (action !== "save" && disabled) ||
      (action !== "undo" && (validation || !cues.length))
    )
      return;
    lock.current = true;
    setBusy(true);
    onBusy(true);
    setError(null);
    setNotice(null);
    try {
      const packet = await requestTimelineAction("premiere.captions.request", {
        action,
        sequenceId: context.sequenceId,
        projectId,
        ...(action === "undo" ? undo : { srt: exportSrt(cues), confirmed: action === "add" }),
      });
      if (!("status" in packet)) throw new Error("Invalid captions response.");
      if (action === "undo") {
        if (packet.status !== "undone") throw new Error("Invalid captions undo response.");
        if (undo?.checkpointId) {
          if (
            !("sequenceId" in packet) ||
            typeof packet.sequenceId !== "string" ||
            !packet.sequenceId
          )
            throw new Error(
              "Premiere restored the checkpoint without its sequence ID. Reopen the transcript in that sequence.",
            );
          onRestored?.(packet.sequenceId);
        }
        saveUndo(null);
        setNotice(
          undo?.checkpointId
            ? "Opened the pre-caption checkpoint. The captioned version is preserved in Axis checkpoints."
            : "Imported caption source removed.",
        );
      } else if (packet.status === "added" || packet.status === "imported") {
        if (
          !("binId" in packet) ||
          typeof packet.binId !== "string" ||
          !("itemId" in packet) ||
          typeof packet.itemId !== "string"
        )
          throw new Error(
            "Captions may have been imported. Inspect the Axis captions bin before retrying.",
          );
        const checkpoint =
          "checkpointId" in packet &&
          typeof packet.checkpointId === "string" &&
          "checkpointSignature" in packet &&
          typeof packet.checkpointSignature === "string" &&
          "expectedSignature" in packet &&
          typeof packet.expectedSignature === "string"
            ? {
                checkpointId: packet.checkpointId,
                checkpointSignature: packet.checkpointSignature,
                expectedSignature: packet.expectedSignature,
              }
            : {};
        if (packet.status === "added" && !checkpoint.checkpointId)
          throw new Error(
            "Captions may have been added without undo information. Inspect the sequence before retrying.",
          );
        saveUndo({ binId: packet.binId, itemId: packet.itemId, ...checkpoint });
        const bin = "binName" in packet ? String(packet.binName) : "Axis captions";
        setNotice(
          packet.status === "added"
            ? "Captions added at sequence time. Undo opens the pre-caption checkpoint."
            : `SRT imported into ${bin}. This Premiere build could not create a caption track. Drag the SRT from that bin onto the sequence at 00:00:00:00.`,
        );
      } else if (packet.status === "saved") setNotice("SRT saved.");
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Captions failed.");
    } finally {
      lock.current = false;
      setBusy(false);
      onBusy(false);
    }
  }
  return (
    <section data-captions-panel="" role="region" aria-label="Captions">
      <header>
        <strong>Captions</strong>
        <button type="button" aria-label="Close captions" disabled={busy} onClick={onClose}>
          ×
        </button>
      </header>
      <fieldset disabled={busy}>
        <label>
          Preset
          <select
            aria-label="Caption preset"
            value={preset}
            onChange={(event) => {
              const value = event.target.value;
              setPreset(value);
              if (value !== "custom")
                setOptions(value === "shorts" ? shortsCaptions : youtubeCaptions);
            }}
          >
            <option value="youtube">YouTube 2-line</option>
            <option value="shorts">Shorts 1–3 words</option>
            <option value="custom">Custom</option>
          </select>
        </label>
        <div data-caption-fields="">
          <label>
            Characters / line
            <input
              aria-label="Characters per line"
              type="number"
              min={1}
              max={120}
              value={options.maxCharacters}
              onChange={(e) => change({ maxCharacters: Number(e.target.value) })}
            />
          </label>
          <label>
            Lines
            <select
              aria-label="Caption lines"
              value={options.maxLines}
              onChange={(e) => change({ maxLines: Number(e.target.value) as 1 | 2 })}
            >
              <option value={1}>1</option>
              <option value={2}>2</option>
            </select>
          </label>
          <label>
            Min seconds
            <input
              aria-label="Minimum duration"
              type="number"
              min={0.8}
              max={6}
              step={0.1}
              value={options.minDuration}
              onChange={(e) => change({ minDuration: Number(e.target.value) })}
            />
          </label>
          <label>
            Max seconds
            <input
              aria-label="Maximum duration"
              type="number"
              min={0.8}
              max={6}
              step={0.1}
              value={options.maxDuration}
              onChange={(e) => change({ maxDuration: Number(e.target.value) })}
            />
          </label>
          <label>
            Words / cue
            <select
              aria-label="Words per cue"
              value={options.wordsPerCue ?? "auto"}
              onChange={(e) =>
                change({ wordsPerCue: e.target.value === "auto" ? null : Number(e.target.value) })
              }
            >
              <option value="auto">Auto</option>
              {[1, 2, 3].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label>
            Case
            <select
              aria-label="Caption case"
              value={options.case}
              onChange={(e) => change({ case: e.target.value as CaptionOptions["case"] })}
            >
              <option value="as-is">As-is</option>
              <option value="upper">UPPER</option>
              <option value="lower">lower</option>
            </select>
          </label>
          <label>
            Pause seconds
            <input
              aria-label="Pause boundary"
              type="number"
              min={0}
              max={10}
              step={0.1}
              value={options.pause}
              onChange={(e) => change({ pause: Number(e.target.value) })}
            />
          </label>
        </div>
        <label data-transcript-check="">
          <input
            type="checkbox"
            checked={options.stripPunctuation}
            onChange={(e) => change({ stripPunctuation: e.target.checked })}
          />
          Strip punctuation
        </label>
      </fieldset>
      <p>
        {cues.length} cues · Preview of first {Math.min(5, cues.length)}
      </p>
      <ol aria-label="Caption preview">
        {cues.slice(0, 5).map((cue) => (
          <li key={cue.start}>
            <time>
              {captionTimestamp(cue.start, ".")} - {captionTimestamp(cue.end, ".")}
            </time>
            <span data-caption-text="">{cue.text}</span>
          </li>
        ))}
      </ol>
      <p>
        Uses sequence time. Fast speech can be shorter than the minimum; long words stay intact.
      </p>
      {validation || error ? <p role="alert">{validation || error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {undo?.checkpointId ? (
        <p>Undo opens a saved sequence. Later caption edits cannot be checked.</p>
      ) : null}
      <footer>
        <button
          type="button"
          data-primary=""
          disabled={disabled || busy || !!validation || !cues.length || !!undo}
          onClick={() => void run("add")}
        >
          Add to sequence
        </button>
        <button
          type="button"
          disabled={busy || !!validation || !cues.length}
          onClick={() => void run("save")}
        >
          Save .srt…
        </button>
        {undo ? (
          <button type="button" disabled={disabled || busy} onClick={() => void run("undo")}>
            Undo captions
          </button>
        ) : null}
      </footer>
    </section>
  );
}
