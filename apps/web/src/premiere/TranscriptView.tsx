import { useEffect, useRef, useState } from "react";
import { randomUUID } from "../lib/utils";
import { seekPremiere, type PremiereContext } from "./host";
import { importWhisperHandoff, loadWhisperTranscript, whisperPrompt } from "./whisperTranscription";
import {
  cutTranscriptRange,
  pruneCheckpoints,
  requestTimelineSnapshot,
  restoreTimeline,
} from "./timelineHost";
import {
  precedingWord,
  mapTranscript,
  parseStoredTranscript,
  parseTranscript,
  rippleTranscript,
  selectionRange,
  transcriptContext,
  transcriptTime,
  type SequenceTranscript,
} from "./sequenceTranscript";

interface CutUndo {
  readonly before: SequenceTranscript;
  readonly checkpointId: string;
  readonly checkpointSignature: string;
  readonly expectedSignature: string;
}
interface StoredTranscript {
  readonly transcript: SequenceTranscript | null;
  readonly undo: CutUndo | null;
  readonly uncertain: boolean;
}

export function transcriptStorageKey(context: PremiereContext, sequenceId = context.sequenceId) {
  return `axis-transcript-v1:${JSON.stringify([context.projectDocumentId || context.projectPath, sequenceId])}`;
}

function readStored(key: string): StoredTranscript {
  try {
    const data = JSON.parse(localStorage.getItem(key) ?? "null") as Record<string, unknown> | null;
    const transcript = parseStoredTranscript(data?.transcript);
    const candidate = data?.undo as CutUndo | undefined;
    const before = parseStoredTranscript(candidate?.before);
    const undo =
      before &&
      candidate &&
      typeof candidate.checkpointId === "string" &&
      candidate.checkpointId.length <= 512 &&
      typeof candidate.checkpointSignature === "string" &&
      candidate.checkpointSignature.length <= 4000000 &&
      typeof candidate.expectedSignature === "string" &&
      candidate.expectedSignature.length <= 4000000
        ? { ...candidate, before }
        : null;
    return { transcript, undo, uncertain: data?.uncertain === true };
  } catch {
    return { transcript: null, undo: null, uncertain: false };
  }
}

const PAGE_SIZE = 120;

export function TranscriptView({
  context,
  disabled,
  onAsk,
  onBusy,
  onTranscribe,
  transcriptionDisabled = false,
  agentStatus = "idle",
  agentOutcome = null,
}: {
  context: PremiereContext;
  disabled: boolean;
  onAsk: (text: string) => void;
  onBusy: (busy: boolean) => void;
  onTranscribe?: (prompt: string) => Promise<void>;
  transcriptionDisabled?: boolean;
  agentStatus?: string;
  agentOutcome?: string | null;
}) {
  const key = transcriptStorageKey(context);
  const [stored, setStored] = useState(() => readStored(key));
  const [selection, setSelection] = useState<{ anchor: number; focus: number } | null>(null);
  const [page, setPage] = useState(0);
  const [following, setFollowing] = useState(true);
  const [offset, setOffset] = useState(String(stored.transcript?.offset ?? 0));
  const [operationBusy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmCut, setConfirmCut] = useState(false);
  const [fixScript, setFixScript] = useState(true);
  const [job, setJob] = useState<string | null>(null);
  const [whisperState, setWhisperState] = useState<"idle" | "transcribing" | "loaded" | "failed">(
    "idle",
  );
  const busy = operationBusy || whisperState === "transcribing";
  const mounted = useRef(true);
  const starting = useRef(false);
  const generation = useRef(0);
  const outcome = useRef(agentOutcome);
  useEffect(() => {
    outcome.current = agentOutcome;
  }, [agentOutcome]);
  const gesture = useRef<{ anchor: number; dragged: boolean } | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const wordArea = useRef<HTMLDivElement>(null);
  const operation = useRef(false);
  const doc = stored.transcript;
  const words = doc?.words ?? [];
  const preceding = precedingWord(words, context.playheadSeconds);
  const current =
    preceding >= 0 && words[preceding]!.end > context.playheadSeconds ? preceding : -1;
  const currentPage =
    following && preceding >= 0
      ? Math.floor(preceding / PAGE_SIZE)
      : Math.min(page, Math.max(0, Math.ceil(words.length / PAGE_SIZE) - 1));
  const first = currentPage * PAGE_SIZE;
  const range = selection
    ? selectionRange(words, selection.anchor, selection.focus, context.fps)
    : null;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (!job) return;
    let disposed = false;
    let reading = false;
    const poll = async () => {
      if (reading) return;
      reading = true;
      try {
        const handoff = await loadWhisperTranscript(context, job);
        if (disposed) return;
        if (!handoff.content) {
          if (outcome.current)
            throw new Error(`The agent finished without a transcript: ${outcome.current}`);
          return;
        }
        const transcript = importWhisperHandoff(handoff.content, context, job);
        persist({ transcript, undo: stored.undo, uncertain: false });
        setOffset("0");
        setSelection(null);
        setPage(0);
        setFollowing(false);
        setConfirmCut(false);
        setWhisperState("loaded");
        setJob(null);
      } catch (problem) {
        if (disposed) return;
        setError(problem instanceof Error ? problem.message : "Transcription failed.");
        setWhisperState("failed");
        setJob(null);
      } finally {
        reading = false;
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
    // Playhead updates must not restart in-flight file reads.
    // A job is scoped to this keyed sequence view.
  }, [job]);

  async function transcribe() {
    if (!onTranscribe || starting.current || job || operation.current || transcriptionDisabled)
      return;
    starting.current = true;
    const attempt = ++generation.current;
    setWhisperState("transcribing");
    setError(null);
    const id = randomUUID();
    try {
      const handoff = await loadWhisperTranscript(context, id, true);
      if (!mounted.current || generation.current !== attempt) return;
      await onTranscribe(whisperPrompt(context, id, handoff, fixScript));
      if (mounted.current && generation.current === attempt) setJob(id);
    } catch (problem) {
      if (!mounted.current || generation.current !== attempt) return;
      setError(problem instanceof Error ? problem.message : "Could not start transcription.");
      setWhisperState("failed");
    } finally {
      starting.current = false;
    }
  }

  useEffect(() => {
    if (following && current >= 0 && wordArea.current?.offsetParent)
      wordArea.current.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
  }, [current, following]);

  function persist(next: StoredTranscript, destination = key) {
    setStored(next);
    try {
      localStorage.setItem(destination, JSON.stringify(next));
    } catch {
      setError(
        "Browser storage is full or unavailable. Keep this panel open; the transcript and undo could not be saved.",
      );
    }
  }

  async function importFile(file: File) {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError(null);
    try {
      if (file.size > 10000000) throw new Error("Choose a transcript smaller than 10 MB.");
      const transcript = parseTranscript(await file.text(), file.name);
      persist({ transcript, undo: stored.undo, uncertain: false });
      setOffset("0");
      setSelection(null);
      setPage(0);
      setFollowing(false);
      setConfirmCut(false);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Could not read this transcript.");
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }

  async function cut() {
    if (!doc || !range || disabled || operation.current || stored.uncertain) return;
    if (!confirmCut) {
      setConfirmCut(true);
      return;
    }
    operation.current = true;
    setBusy(true);
    onBusy(true);
    setError(null);
    try {
      const result = await cutTranscriptRange({
        sequenceId: context.sequenceId,
        projectId: context.projectDocumentId || context.projectPath,
        start: range.start,
        end: range.end,
      });
      persist({
        transcript: result.cutError ? doc : rippleTranscript(doc, range.start, range.end),
        undo: {
          before: doc,
          checkpointId: result.checkpointId,
          checkpointSignature: result.checkpointSignature,
          expectedSignature: result.expectedSignature,
        },
        uncertain: result.cutError !== null,
      });
      await pruneCheckpoints(context.sequenceId, result.checkpointId).catch(() => {});
      setSelection(null);
      setConfirmCut(false);
      if (result.cutError) setError(`${result.cutError} The checkpoint is available below.`);
    } catch (problem) {
      // A timeout can mean the host changed the sequence without returning the checkpoint ID.
      persist({ ...stored, uncertain: true });
      setError(
        `${problem instanceof Error ? problem.message : "Cut failed."} Inspect the timeline and Axis checkpoints before reimporting or retrying.`,
      );
    } finally {
      operation.current = false;
      setBusy(false);
      onBusy(false);
    }
  }

  async function undo() {
    const saved = stored.undo;
    if (!saved || disabled || operation.current) return;
    operation.current = true;
    setBusy(true);
    onBusy(true);
    setError(null);
    try {
      const live = await requestTimelineSnapshot(false, context.sequenceId);
      if (
        live.signature !== saved.expectedSignature ||
        !live.checkpointIds.includes(saved.checkpointId)
      )
        throw new Error(
          "The timeline changed or its checkpoint was pruned. Open the preserved Axis checkpoint manually to recover the earlier version.",
        );
      const restoredId = await restoreTimeline({
        sequenceId: context.sequenceId,
        checkpointId: saved.checkpointId,
        checkpointSignature: saved.checkpointSignature,
        expectedSignature: saved.expectedSignature,
        turnNumber: 1,
      });
      if (!restoredId)
        throw new Error(
          "Premiere restored the checkpoint but did not return its sequence ID. Reimport the transcript in the restored sequence.",
        );
      const next = { transcript: saved.before, undo: null, uncertain: false };
      persist(next, transcriptStorageKey(context, restoredId));
      // Restore opens the clone; the preserved after sequence keeps its own transcript.
      localStorage.setItem(key, JSON.stringify({ ...stored, undo: null }));
      setSelection(null);
      setOffset(String(saved.before.offset));
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Could not restore the cut.");
    } finally {
      operation.current = false;
      setBusy(false);
      onBusy(false);
    }
  }

  return (
    <section data-sequence-transcript="" aria-label="Sequence transcript" aria-busy={busy}>
      <div data-transcript-tools="">
        <div>
          <strong>{context.sequenceName}</strong>
          <small>{doc?.source ?? "Import a voice-over or dialogue transcript"}</small>
        </div>
        <button type="button" disabled={busy} onClick={() => input.current?.click()}>
          {doc ? "Replace transcript" : "Import transcript"}
        </button>
        <input
          ref={input}
          type="file"
          accept=".json,.srt,.vtt"
          aria-label="Import transcript file"
          hidden
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importFile(file);
            event.target.value = "";
          }}
        />
      </div>
      <div data-whisper-controls="">
        <button
          type="button"
          disabled={!onTranscribe || transcriptionDisabled || busy}
          onClick={() => void transcribe()}
        >
          Transcribe with WhisperX
        </button>
        <label>
          <input
            type="checkbox"
            checked={fixScript}
            disabled={whisperState === "transcribing"}
            onChange={(event) => setFixScript(event.target.checked)}
          />{" "}
          Fix with script
        </label>
        {whisperState === "transcribing" ? (
          <button
            type="button"
            onClick={() => {
              generation.current++;
              setJob(null);
              setWhisperState("idle");
            }}
          >
            Stop waiting
          </button>
        ) : null}
      </div>
      <p role="status" data-transcript-hint="">
        {whisperState === "transcribing"
          ? `Transcribing · ${agentStatus}. Agent details and questions are in Conversation. Stop waiting does not stop the agent.`
          : whisperState === "loaded"
            ? "WhisperX transcript loaded and saved."
            : whisperState === "failed"
              ? "WhisperX transcription failed. See the reason below."
              : "Transcription uses a separate conversation that can write transcript files. It does not edit the timeline."}
      </p>
      {doc ? (
        <>
          <form
            data-transcript-mapping=""
            onSubmit={(event) => {
              event.preventDefault();
              setError(null);
              try {
                if (!offset.trim()) throw new Error("Enter a sequence offset in seconds.");
                const delta = Number(offset) - doc.offset;
                persist({
                  ...stored,
                  transcript: {
                    ...doc,
                    offset: Number(offset),
                    words: mapTranscript(doc.words, delta),
                  },
                });
                setSelection(null);
                setConfirmCut(false);
              } catch (problem) {
                setError(problem instanceof Error ? problem.message : "Invalid offset.");
              }
            }}
          >
            <label>
              Sequence offset (seconds)
              <input
                type="number"
                step="any"
                value={offset}
                disabled={busy}
                onChange={(event) => setOffset(event.target.value)}
              />
            </label>
            <button type="submit" disabled={busy}>
              Apply offset
            </button>
            <button
              type="button"
              aria-pressed={following}
              onClick={() => {
                setPage(currentPage);
                setFollowing(!following);
              }}
            >
              Follow playhead
            </button>
          </form>
          <p data-transcript-hint="">
            Click to seek. Drag or Shift-click to select words.{" "}
            {doc.timing === "estimated"
              ? "Subtitle word times are estimated within each cue. Check the range before cutting."
              : "Word timestamps from your imported file."}{" "}
            Reimport after edits made outside this view.
          </p>
          <div data-transcript-actions="" aria-label="Transcript selection actions">
            <span>
              {range
                ? `${transcriptTime(range.start)} - ${transcriptTime(range.end)}`
                : `${words.length.toLocaleString()} words`}
            </span>
            <button
              type="button"
              disabled={!range || busy}
              onClick={() => {
                if (range) onAsk(transcriptContext(doc, range, context.sequenceName));
              }}
            >
              Ask Axis
            </button>
            <button
              type="button"
              disabled={!range || busy || disabled || stored.uncertain}
              onClick={() => void cut()}
            >
              {confirmCut ? "Confirm ripple cut" : "Cut from timeline"}
            </button>
            {confirmCut ? (
              <button type="button" disabled={busy} onClick={() => setConfirmCut(false)}>
                Cancel cut
              </button>
            ) : null}
          </div>
          {confirmCut ? (
            <p data-transcript-hint="">
              Removes this range from every unlocked audio/video track and closes the gap. Locked
              tracks, captions and sequence markers stay in place. A sequence checkpoint protects
              the cut.
            </p>
          ) : null}
        </>
      ) : null}
      {error ? (
        <p role="alert" data-error="">
          {error}
        </p>
      ) : null}
      {stored.uncertain ? (
        <p data-notice="">
          Transcript timing needs review. Undo the cut or reimport after checking the timeline.
        </p>
      ) : null}
      {stored.undo ? (
        <div data-transcript-undo="">
          <span>Last transcript cut protected by a sequence checkpoint.</span>
          <button type="button" disabled={disabled || busy} onClick={() => void undo()}>
            Undo transcript cut
          </button>
        </div>
      ) : null}
      <div
        ref={wordArea}
        data-transcript-words=""
        data-shot-scroll=""
        onPointerLeave={() => {
          gesture.current = null;
        }}
      >
        {!doc ? (
          <div data-transcript-empty="">
            <h1>Edit the story in words.</h1>
            <p>
              Import WhisperX JSON for precise word timing, or SRT / VTT for estimated word timing.
            </p>
            <p>
              File times start at sequence zero. Apply an offset to align a voice-over placed later
              in the sequence.
            </p>
          </div>
        ) : null}
        {doc && !words.length ? (
          <p>The imported words have all been cut. Undo to restore them.</p>
        ) : null}
        {Array.from(
          { length: Math.ceil(Math.min(PAGE_SIZE, words.length - first) / 24) },
          (_, row) => (
            <div data-transcript-paragraph="" key={first + row * 24}>
              <span data-transcript-time="">{transcriptTime(words[first + row * 24]!.start)}</span>
              <p>
                {words
                  .slice(first + row * 24, Math.min(first + (row + 1) * 24, first + PAGE_SIZE))
                  .map((word, n) => {
                    const index = first + row * 24 + n;
                    return (
                      <button
                        type="button"
                        data-transcript-word=""
                        key={index}
                        aria-label={`${word.text} at ${transcriptTime(word.start)}`}
                        aria-pressed={!!range && index >= range.first && index <= range.last}
                        aria-current={current === index ? "true" : undefined}
                        disabled={busy}
                        onPointerDown={(event) => {
                          if (event.button !== 0) return;
                          gesture.current = {
                            anchor: event.shiftKey && selection ? selection.anchor : index,
                            dragged: false,
                          };
                        }}
                        onPointerEnter={(event) => {
                          if (gesture.current && event.buttons === 1) {
                            gesture.current.dragged = true;
                            setSelection({ anchor: gesture.current.anchor, focus: index });
                            setConfirmCut(false);
                            setFollowing(false);
                          }
                        }}
                        onClick={(event) => {
                          if (!gesture.current?.dragged) {
                            setSelection({
                              anchor: event.shiftKey && selection ? selection.anchor : index,
                              focus: index,
                            });
                            setConfirmCut(false);
                            if (!event.shiftKey) seekPremiere(word.start, context.sequenceId);
                          }
                          gesture.current = null;
                        }}
                      >
                        {word.text}
                      </button>
                    );
                  })}
              </p>
            </div>
          ),
        )}
      </div>
      {words.length > PAGE_SIZE ? (
        <nav data-transcript-pages="" aria-label="Transcript pages">
          <button
            type="button"
            disabled={currentPage === 0}
            onClick={() => {
              setPage(currentPage - 1);
              setFollowing(false);
            }}
          >
            Previous words
          </button>
          <span>
            {first + 1}-{Math.min(first + PAGE_SIZE, words.length)} of {words.length}
          </span>
          <button
            type="button"
            disabled={first + PAGE_SIZE >= words.length}
            onClick={() => {
              setPage(currentPage + 1);
              setFollowing(false);
            }}
          >
            Next words
          </button>
        </nav>
      ) : null}
    </section>
  );
}
