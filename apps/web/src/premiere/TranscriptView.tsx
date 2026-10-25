import { memo, useEffect, useEffectEvent, useRef, useState, type KeyboardEvent } from "react";
import { randomUUID } from "../lib/utils";
import { seekPremiere, type PremiereContext } from "./host";
import { importWhisperHandoff, loadWhisperTranscript, whisperPrompt } from "./whisperTranscription";
import {
  cutTranscriptRange,
  cutTranscriptRanges,
  pruneCheckpoints,
  requestTimelineSnapshot,
  restoreTimeline,
  TimelineRequestError,
} from "./timelineHost";
import {
  mapTranscript,
  parseStoredTranscript,
  parseTranscript,
  rippleTranscript,
  selectionRange,
  transcriptContext,
  transcriptTime,
  type SequenceTranscript,
  type TranscriptWord,
} from "./sequenceTranscript";
import {
  findVoiceLink,
  lastWordBefore,
  placeWords,
  refreshVoiceLink,
  seekTime,
  voiceCandidates,
  wordAtTime,
  type VoiceLink,
} from "./transcriptSync";
import { usePlayheadClock } from "./usePlayheadClock";
import { CaptionsPanel } from "./CaptionsPanel";
import { CleanupReview } from "./CleanupReview";
import {
  defaultCleanupSettings,
  detectTranscriptCleanup,
  mergeCleanupRanges,
  type CleanupCut,
  type CleanupSettings,
} from "./transcriptCleanup";

interface CutUndo {
  readonly beforeLink?: VoiceLink | null | undefined;
  readonly before: SequenceTranscript;
  readonly checkpointId: string;
  readonly checkpointSignature: string;
  readonly expectedSignature: string;
}
interface StoredTranscript {
  readonly transcript: SequenceTranscript | null;
  readonly undo: CutUndo | null;
  readonly uncertain: boolean;
  /**
   * A linked transcript keeps source-media times and is placed through the voice-over
   * clips on the timeline, so trims, moves and cuts made anywhere stay in sync.
   * `undefined` marks records saved before linking existed.
   */
  readonly link?: VoiceLink | null | undefined;
}

export function transcriptStorageKey(context: PremiereContext, sequenceId = context.sequenceId) {
  return `axis-transcript-v1:${JSON.stringify([context.projectDocumentId || context.projectPath, sequenceId])}`;
}

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

function parseLink(value: unknown): VoiceLink | null | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null) return null;
  const link = value as Record<string, unknown>;
  if (
    !finite(link.trackIndex) ||
    typeof link.mediaName !== "string" ||
    link.mediaName.length > 2048 ||
    !Array.isArray(link.segments) ||
    link.segments.length > 2000 ||
    !link.segments.every(
      (segment: Record<string, unknown>) =>
        typeof segment === "object" &&
        segment !== null &&
        finite(segment.sequenceStart) &&
        finite(segment.sequenceEnd) &&
        finite(segment.sourceIn) &&
        finite(segment.speed) &&
        (segment.speed as number) > 0,
    )
  )
    return null;
  return value as VoiceLink;
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
        ? { ...candidate, before, beforeLink: parseLink(candidate.beforeLink) }
        : null;
    return { transcript, undo, uncertain: data?.uncertain === true, link: parseLink(data?.link) };
  } catch {
    return { transcript: null, undo: null, uncertain: false };
  }
}

/** Imported files carry source-media times; Axis WhisperX output is already in sequence time. */
const linkable = (doc: SequenceTranscript) => !doc.source.startsWith("WhisperX (Axis)");
const sourceFile = (doc: SequenceTranscript) => doc.source.split(" · ").at(-1) ?? doc.source;
const sourceTimes = (doc: SequenceTranscript): TranscriptWord[] =>
  doc.offset
    ? doc.words.map((word) => ({
        ...word,
        start: Math.max(0, word.start - doc.offset),
        end: Math.max(0, word.end - doc.offset),
      }))
    : [...doc.words];

/** Paragraphs break on sentence ends once long enough, on pauses, and at a hard cap. */
function paragraphs(words: readonly TranscriptWord[]): Array<readonly [number, number]> {
  const result: Array<readonly [number, number]> = [];
  let from = 0;
  for (let index = 0; index < words.length; index++) {
    const size = index - from + 1;
    const next = words[index + 1];
    const pause = next ? next.start - words[index]!.end : 0;
    if (
      !next ||
      pause >= 1.5 ||
      size >= 90 ||
      (size >= 28 && /[.?!…]["')\]]*$/.test(words[index]!.text))
    ) {
      result.push([from, index + 1]);
      from = index + 1;
    }
  }
  return result;
}

const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");

function clock(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  const pad = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(whole / 3600);
  return hours
    ? `${hours}:${pad(Math.floor(whole / 60) % 60)}:${pad(whole % 60)}`
    : `${Math.floor(whole / 60)}:${pad(whole % 60)}`;
}

const Paragraph = memo(function Paragraph({
  words,
  from,
  to,
  active,
  selFirst,
  selLast,
  marks,
  current,
  busy,
  cleanupWords,
  cleanupPauses,
  excluded,
}: {
  words: readonly TranscriptWord[];
  from: number;
  to: number;
  active: number;
  selFirst: number;
  selLast: number;
  marks: Uint8Array;
  current: boolean;
  busy: boolean;
  cleanupWords: readonly (CleanupCut | undefined)[];
  cleanupPauses: ReadonlyMap<number, readonly CleanupCut[]>;
  excluded: ReadonlySet<string>;
}) {
  const items = [];
  for (let index = from; index < to; index++) {
    const word = words[index]!;
    for (const pause of cleanupPauses.get(index) ?? []) {
      items.push(
        <button
          type="button"
          key={pause.id}
          data-cut-id={pause.id}
          data-cleanup-cut={excluded.has(pause.id) ? "kept" : "accepted"}
          disabled={busy}
          aria-label={`Toggle pause at ${transcriptTime(pause.start)}`}
        >
          [{(pause.end - pause.start).toFixed(2)} s pause]
        </button>,
      );
    }
    const cut = cleanupWords[index];
    items.push(
      <button
        type="button"
        data-transcript-word=""
        data-index={index}
        data-cut-id={cut?.id}
        data-cleanup-cut={cut ? (excluded.has(cut.id) ? "kept" : "accepted") : undefined}
        key={index}
        aria-label={`${word.text} at ${transcriptTime(word.start)}`}
        aria-pressed={cut ? !excluded.has(cut.id) : index >= selFirst && index <= selLast}
        aria-current={index === active ? "true" : undefined}
        data-match={marks[index] === 2 ? "current" : marks[index] === 1 ? "" : undefined}
        disabled={busy}
      >
        {word.text}
      </button>,
    );
  }
  if (to === words.length)
    for (const pause of cleanupPauses.get(to) ?? [])
      items.push(
        <button
          type="button"
          key={pause.id}
          data-cut-id={pause.id}
          data-cleanup-cut={excluded.has(pause.id) ? "kept" : "accepted"}
          disabled={busy}
          aria-label={`Toggle pause at ${transcriptTime(pause.start)}`}
        >
          [{(pause.end - pause.start).toFixed(2)} s pause]
        </button>,
      );
  return (
    <div data-transcript-paragraph="" data-current={current ? "" : undefined}>
      <button
        type="button"
        data-transcript-time=""
        data-seek={from}
        tabIndex={-1}
        aria-label={`Seek to ${transcriptTime(words[from]!.start)}`}
        disabled={busy}
      >
        {clock(words[from]!.start)}
      </button>
      <p>{items}</p>
    </div>
  );
});

export function TranscriptView({
  context,
  disabled,
  onAsk,
  onBusy,
  onTranscribe,
  transcriptionDisabled = false,
  agentStatus = "idle",
  agentOutcome = null,
  active = true,
  cleanupRequest,
}: {
  context: PremiereContext;
  disabled: boolean;
  onAsk: (text: string) => void;
  onBusy: (busy: boolean) => void;
  onTranscribe?: (prompt: string) => Promise<void>;
  transcriptionDisabled?: boolean;
  agentStatus?: string;
  agentOutcome?: string | null;
  /** The tab is visible; only then does the view follow the playhead and timeline. */
  active?: boolean;
  cleanupRequest?: { settings: CleanupSettings } | null;
}) {
  const key = transcriptStorageKey(context);
  const [stored, setStored] = useState(() => readStored(key));
  const [selection, setSelection] = useState<{ anchor: number; focus: number } | null>(null);
  const [following, setFollowing] = useState(true);
  const [offset, setOffset] = useState(String(stored.transcript?.offset ?? 0));
  const [operationBusy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmCut, setConfirmCut] = useState(false);
  const [fixScript, setFixScript] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [captionsOpen, setCaptionsOpen] = useState(false);
  const [cleanup, setCleanup] = useState<{ signature: string } | null>(null);
  const [cleanupSettings, setCleanupSettings] = useState(defaultCleanupSettings);
  const [excluded, setExcluded] = useState<ReadonlySet<string>>(new Set());
  const [candidates, setCandidates] = useState<ReturnType<typeof voiceCandidates> | null>(null);
  const [query, setQuery] = useState("");
  const [matchCursor, setMatchCursor] = useState(0);
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
  const search = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const wordArea = useRef<HTMLDivElement>(null);
  const operation = useRef(false);
  // Async work reads the latest record; persist() also updates it synchronously.
  const storedRef = useRef(stored);
  useEffect(() => {
    storedRef.current = stored;
  }, [stored]);

  const live = usePlayheadClock(active);
  // The hook is mocked to null in tests that drive the playhead through context.
  const playhead = active && live != null ? live : context.playheadSeconds;
  const fps = context.fps > 0 ? context.fps : 30;
  const doc = stored.transcript;
  const link = stored.link ?? null;
  const words: readonly TranscriptWord[] = !doc
    ? []
    : link
      ? placeWords(sourceTimes(doc), link.segments)
      : doc.words;
  const blocks = paragraphs(words);
  const current = wordAtTime(words, playhead, fps);
  const anchorWord = current >= 0 ? current : lastWordBefore(words, playhead, fps);
  const range = selection ? selectionRange(words, selection.anchor, selection.focus, fps) : null;
  const cleanupCuts = cleanup
    ? detectTranscriptCleanup(words, cleanupSettings, fps, link?.segments)
    : [];
  const cleanupWords = Array.from<CleanupCut | undefined>({ length: words.length });
  const cleanupPauses = new Map<number, CleanupCut[]>();
  let cleanupCursor = 0;
  for (const cut of cleanupCuts) {
    while (cleanupCursor < words.length && words[cleanupCursor]!.end <= cut.start) cleanupCursor++;
    let index = cleanupCursor;
    while (index < words.length && words[index]!.start < cut.end) cleanupWords[index++] = cut;
    if (index === cleanupCursor)
      cleanupPauses.set(index, [...(cleanupPauses.get(index) ?? []), cut]);
  }

  const normalized = words.map((word) => normalize(word.text));
  const tokens = query.split(/\s+/).map(normalize).filter(Boolean);
  const matches: number[] = [];
  if (tokens.length)
    for (
      let index = 0;
      index + tokens.length <= normalized.length && matches.length < 5000;
      index++
    )
      if (
        tokens.every((token, k) =>
          k === tokens.length - 1
            ? normalized[index + k]!.startsWith(token)
            : normalized[index + k] === token,
        )
      )
        matches.push(index);
  const cursor = matches.length ? Math.min(matchCursor, matches.length - 1) : -1;
  const marks = new Uint8Array(words.length);
  matches.forEach((start, n) => {
    for (let k = 0; k < tokens.length; k++) marks[start + k] = n === cursor ? 2 : 1;
  });

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  function persist(next: StoredTranscript, destination = key) {
    if (storedRef.current.transcript !== next.transcript) setCleanup(null);
    storedRef.current = next;
    setStored(next);
    try {
      localStorage.setItem(destination, JSON.stringify(next));
    } catch {
      setError(
        "Browser storage is full or unavailable. Keep this panel open; the transcript and undo could not be saved.",
      );
    }
  }

  async function snapshot() {
    const reply = await requestTimelineSnapshot(false, context.sequenceId);
    return reply.snapshot ?? null;
  }

  // Older imports are linked to their voice-over clip once, when the timeline allows it.
  const autoLink = useEffectEvent(async (legacy: SequenceTranscript, cancelled: () => boolean) => {
    const timeline = linkable(legacy) ? await snapshot().catch(() => null) : null;
    if (cancelled() || storedRef.current.transcript !== legacy) return;
    const found = timeline ? findVoiceLink(timeline, sourceFile(legacy)) : null;
    persist({
      ...storedRef.current,
      transcript: found ? { ...legacy, offset: 0, words: sourceTimes(legacy) } : legacy,
      link: found,
    });
    if (found) setOffset("0");
  });
  const unlinked = stored.link === undefined;
  useEffect(() => {
    if (!active || !doc || !unlinked) return;
    let disposed = false;
    void autoLink(doc, () => disposed);
    return () => {
      disposed = true;
    };
  }, [active, doc, unlinked]);

  // A linked transcript re-reads its clips while the playhead rests, so edits made
  // anywhere in Premiere move the words with the audio.
  const resting = useRef({ playhead, still: 0 });
  const refreshLink = useEffectEvent(async (cancelled: () => boolean) => {
    const timeline = await snapshot().catch(() => null);
    const saved = storedRef.current;
    if (cancelled() || !timeline || !saved.link) return;
    const fresh = refreshVoiceLink(timeline, saved.link);
    if (!fresh) {
      setNotice(
        `"${saved.link.mediaName}" is no longer on A${saved.link.trackIndex + 1}. Relink it from the menu.`,
      );
      return;
    }
    setNotice(null);
    if (JSON.stringify(fresh.segments) !== JSON.stringify(saved.link.segments)) {
      persist({ ...saved, link: fresh });
      setCleanup(null);
      setSelection(null);
      setConfirmCut(false);
    }
  });
  const linked = link !== null;
  useEffect(() => {
    if (!active || !linked || busy) return;
    let disposed = false;
    let reading = false;
    const timer = setInterval(() => {
      if (reading || resting.current.still < 2) return;
      reading = true;
      void refreshLink(() => disposed).finally(() => {
        reading = false;
      });
    }, 1000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [active, linked, busy]);
  useEffect(() => {
    const rest = resting.current;
    if (rest.playhead !== playhead) resting.current = { playhead, still: 0 };
  }, [playhead]);
  useEffect(() => {
    const timer = setInterval(() => resting.current.still++, 1000);
    return () => clearInterval(timer);
  }, []);

  const pollJob = useEffectEvent(async (id: string, cancelled: () => boolean) => {
    try {
      const handoff = await loadWhisperTranscript(context, id);
      if (cancelled()) return;
      if (!handoff.content) {
        if (outcome.current)
          throw new Error(`The agent finished without a transcript: ${outcome.current}`);
        return;
      }
      const transcript = importWhisperHandoff(handoff.content, context, id);
      persist({ transcript, undo: storedRef.current.undo, uncertain: false, link: null });
      setOffset("0");
      setSelection(null);
      setFollowing(true);
      setConfirmCut(false);
      setWhisperState("loaded");
      setJob(null);
    } catch (problem) {
      if (cancelled()) return;
      setError(problem instanceof Error ? problem.message : "Transcription failed.");
      setWhisperState("failed");
      setJob(null);
    }
  });
  useEffect(() => {
    if (!job) return;
    let disposed = false;
    let reading = false;
    const poll = () => {
      if (reading) return;
      reading = true;
      void pollJob(job, () => disposed).finally(() => {
        reading = false;
      });
    };
    poll();
    const timer = setInterval(poll, 3000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [job]);

  async function transcribe() {
    if (!onTranscribe || starting.current || job || operation.current || transcriptionDisabled)
      return;
    starting.current = true;
    setMenuOpen(false);
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

  // Keeps the spoken word in the upper part of the view without jumping on every word.
  useEffect(() => {
    const area = wordArea.current;
    if (!following || anchorWord < 0 || !area?.offsetParent) return;
    const element = area.querySelector<HTMLElement>(`[data-index="${anchorWord}"]`);
    if (!element) return;
    const box = area.getBoundingClientRect();
    const target = element.getBoundingClientRect();
    const top = target.top - box.top;
    if (top >= box.height * 0.12 && top + target.height <= box.height * 0.7) return;
    const distance = top - box.height * 0.3;
    area.scrollTo({
      top: area.scrollTop + distance,
      behavior: Math.abs(distance) > box.height * 1.5 ? "auto" : "smooth",
    });
  }, [anchorWord, following]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [menuOpen]);

  async function importFile(file: File) {
    if (operation.current) return;
    operation.current = true;
    setBusy(true);
    setError(null);
    setMenuOpen(false);
    try {
      if (file.size > 10000000) throw new Error("Choose a transcript smaller than 10 MB.");
      const transcript = parseTranscript(await file.text(), file.name);
      const timeline = await snapshot().catch(() => null);
      const found = timeline ? findVoiceLink(timeline, file.name) : null;
      persist({ transcript, undo: storedRef.current.undo, uncertain: false, link: found });
      setNotice(
        found
          ? null
          : "No clip on the timeline matches this file name. Times start at sequence zero; pick the voice-over clip in the menu to sync it.",
      );
      setOffset("0");
      setSelection(null);
      setFollowing(true);
      setConfirmCut(false);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Could not read this transcript.");
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }

  async function openMenu() {
    const opening = !menuOpen;
    setMenuOpen(opening);
    if (opening && doc && linkable(doc)) {
      const timeline = await snapshot().catch(() => null);
      if (mounted.current) setCandidates(timeline ? voiceCandidates(timeline) : []);
    }
  }

  async function chooseLink(value: string) {
    if (!doc) return;
    setError(null);
    if (value === "sequence") {
      persist({
        ...stored,
        transcript: { ...doc, offset: 0, words: sourceTimes(doc) },
        link: null,
      });
      setOffset("0");
      setNotice(null);
      return;
    }
    const choice = candidates?.[Number(value)];
    const timeline = choice ? await snapshot().catch(() => null) : null;
    const fresh = timeline && choice ? refreshVoiceLink(timeline, choice) : null;
    if (!fresh) {
      setError("That clip is no longer on the timeline. Reopen the menu to refresh the list.");
      return;
    }
    persist({
      ...storedRef.current,
      transcript: { ...doc, offset: 0, words: sourceTimes(doc) },
      link: fresh,
    });
    setOffset("0");
    setNotice(null);
    setSelection(null);
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
      // Linked words follow the cut through the refreshed clip positions instead.
      const timeline = link ? await snapshot().catch(() => null) : null;
      const fresh = timeline && link ? refreshVoiceLink(timeline, link) : null;
      persist({
        transcript: result.cutError || link ? doc : rippleTranscript(doc, range.start, range.end),
        undo: {
          before: doc,
          checkpointId: result.checkpointId,
          checkpointSignature: result.checkpointSignature,
          expectedSignature: result.expectedSignature,
        },
        uncertain: result.cutError !== null,
        link: fresh ?? link,
      });
      await pruneCheckpoints(context.sequenceId, result.checkpointId).catch(() => {});
      setSelection(null);
      setConfirmCut(false);
      if (result.cutError) setError(`${result.cutError} The checkpoint is available below.`);
    } catch (problem) {
      // A timeout can mean the host changed the sequence without returning the checkpoint ID.
      persist({ ...storedRef.current, uncertain: true });
      setError(
        `${problem instanceof Error ? problem.message : "Cut failed."} Inspect the timeline and Axis checkpoints before reimporting or retrying.`,
      );
    } finally {
      operation.current = false;
      setBusy(false);
      onBusy(false);
    }
  }

  async function openCleanup(settings = cleanupSettings) {
    if (!doc || operation.current || busy) {
      if (!doc) setNotice("Import or transcribe the voice-over before reviewing cleanup.");
      return;
    }
    setMenuOpen(false);
    operation.current = true;
    setBusy(true);
    setError(null);
    try {
      const reply = await requestTimelineSnapshot(false, context.sequenceId);
      if (
        reply.snapshot &&
        reply.snapshot.projectId !== (context.projectDocumentId || context.projectPath)
      )
        throw new Error("The active Premiere project changed.");
      const saved = storedRef.current;
      if (saved.link && reply.snapshot) {
        const fresh = refreshVoiceLink(reply.snapshot, saved.link);
        persist({ ...saved, link: fresh ?? { ...saved.link, segments: [] } });
      }
      setCleanupSettings(settings);
      setExcluded(new Set());
      setSelection(null);
      setConfirmCut(false);
      setFollowing(false);
      setCleanup({ signature: reply.signature });
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Could not open cleanup review.");
    } finally {
      operation.current = false;
      setBusy(false);
    }
  }

  const requestedCleanup = useEffectEvent((settings: CleanupSettings) => {
    void openCleanup(settings);
  });
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- A suggestion starts a Premiere snapshot request, which must mark the view busy before awaiting the host.
    if (cleanupRequest) requestedCleanup(cleanupRequest.settings);
  }, [cleanupRequest]);

  function toggleCleanup(id: string) {
    const cut = cleanupCuts.find((candidate) => candidate.id === id);
    if (cut) seekPremiere(Math.max(0, cut.start - 0.3), context.sequenceId);
    const next = new Set(excluded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExcluded(next);
  }

  async function applyCleanup() {
    if (!doc || !cleanup || disabled || operation.current || stored.uncertain) return;
    const ranges = mergeCleanupRanges(cleanupCuts.filter((cut) => !excluded.has(cut.id)));
    if (!ranges.length || ranges.length > 2000) return;
    operation.current = true;
    setBusy(true);
    onBusy(true);
    setError(null);
    try {
      const result = await cutTranscriptRanges({
        sequenceId: context.sequenceId,
        projectId: context.projectDocumentId || context.projectPath,
        ranges,
        expectedSignature: cleanup.signature,
      });
      // Source words remain intact. The after snapshot places them through the surviving,
      // speed-aware clip segments; an entirely removed VO has zero surviving segments.
      const fresh = link
        ? (refreshVoiceLink(result.snapshot, link) ?? { ...link, segments: [] })
        : null;
      let transcript = doc;
      if (!link && !result.cutError)
        for (let i = ranges.length - 1; i >= 0; i--) {
          const range = ranges[i]!;
          transcript = rippleTranscript(transcript, range.start, range.end);
        }
      persist({
        transcript,
        link: fresh,
        uncertain: result.cutError !== null,
        undo: {
          before: doc,
          beforeLink: link,
          checkpointId: result.checkpointId,
          checkpointSignature: result.checkpointSignature,
          expectedSignature: result.expectedSignature,
        },
      });
      setCleanup(null);
      setSelection(null);
      await pruneCheckpoints(context.sequenceId, result.checkpointId).catch(() => {});
      if (result.cutError)
        setError(`${result.cutError} Undo transcript cut restores the entire cleanup.`);
    } catch (problem) {
      const unchanged = problem instanceof TimelineRequestError && problem.unchanged;
      persist({ ...storedRef.current, uncertain: !unchanged });
      setCleanup(null);
      setError(
        `${problem instanceof Error ? problem.message : "Cleanup failed."} ${unchanged ? "Open Clean up to review again." : "Inspect the timeline and Axis checkpoints before retrying."}`,
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
      const reply = await requestTimelineSnapshot(false, context.sequenceId);
      if (
        reply.signature !== saved.expectedSignature ||
        !reply.checkpointIds.includes(saved.checkpointId)
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
      const next = {
        transcript: saved.before,
        undo: null,
        uncertain: false,
        link: saved.beforeLink === undefined ? link : saved.beforeLink,
      };
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

  function goToMatch(step: number) {
    if (!matches.length) return;
    const next = (cursor + step + matches.length) % matches.length;
    const start = matches[next]!;
    setMatchCursor(next);
    setFollowing(false);
    setSelection({ anchor: start, focus: start + tokens.length - 1 });
    setConfirmCut(false);
    seekPremiere(seekTime(words[start]!.start, fps), context.sequenceId);
    requestAnimationFrame(() =>
      wordArea.current
        ?.querySelector(`[data-index="${start}"]`)
        ?.scrollIntoView({ block: "center" }),
    );
  }

  function wordIndex(target: EventTarget | null) {
    const element = (target as HTMLElement | null)?.closest?.("[data-index]");
    return element ? Number(element.getAttribute("data-index")) : -1;
  }

  function onSearchKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") {
      event.preventDefault();
      goToMatch(event.shiftKey ? -1 : 1);
    } else if (event.key === "Escape") {
      setQuery("");
      search.current?.blur();
    }
  }

  const transcribing = whisperState === "transcribing";
  const whisperButton = (
    <button
      type="button"
      data-primary={doc ? undefined : ""}
      disabled={!onTranscribe || transcriptionDisabled || busy}
      onClick={() => void transcribe()}
    >
      Transcribe with WhisperX
    </button>
  );
  const scriptToggle = (
    <label data-transcript-check="">
      <input
        type="checkbox"
        checked={fixScript}
        disabled={transcribing}
        onChange={(event) => setFixScript(event.target.checked)}
      />
      Fix with script
    </label>
  );
  const fileInput = (
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
  );
  const linkValue = link
    ? String(
        candidates?.findIndex(
          (candidate) =>
            candidate.trackIndex === link.trackIndex && candidate.mediaName === link.mediaName,
        ) ?? -1,
      )
    : "sequence";

  return (
    <section data-sequence-transcript="" aria-label="Sequence transcript" aria-busy={busy}>
      {fileInput}
      {doc ? (
        <header data-transcript-bar="">
          <div data-transcript-search="">
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.5 10.5 14 14" />
            </svg>
            <input
              ref={search}
              type="search"
              placeholder="Search transcript"
              aria-label="Search transcript"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setMatchCursor(0);
              }}
              onKeyDown={onSearchKey}
            />
            {tokens.length ? (
              <>
                <span data-transcript-count="" aria-live="polite">
                  {matches.length
                    ? `${cursor + 1} / ${matches.length.toLocaleString()}`
                    : "No matches"}
                </span>
                <button
                  type="button"
                  data-icon=""
                  aria-label="Previous match"
                  disabled={!matches.length}
                  onClick={() => goToMatch(-1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  data-icon=""
                  aria-label="Next match"
                  disabled={!matches.length}
                  onClick={() => goToMatch(1)}
                >
                  ↓
                </button>
              </>
            ) : null}
          </div>
          <button
            type="button"
            data-transcript-follow=""
            aria-label="Follow playhead"
            aria-pressed={following}
            onClick={() => setFollowing(!following)}
          >
            <span aria-hidden="true" />
            Follow
          </button>
          <div data-transcript-menu="" ref={menu}>
            <button
              type="button"
              data-icon=""
              aria-label="Transcript options"
              aria-expanded={menuOpen}
              onClick={() => void openMenu()}
            >
              ⋯
            </button>
            {menuOpen ? (
              <div data-transcript-popover="" role="dialog" aria-label="Transcript options">
                <section>
                  <h3>Source</h3>
                  <p>{doc.source}</p>
                  <div data-row="">
                    <button
                      type="button"
                      disabled={busy || stored.uncertain || !words.length}
                      onClick={() => {
                        setCaptionsOpen(false);
                        void openCleanup();
                      }}
                    >
                      Clean up
                    </button>
                    <button
                      type="button"
                      disabled={busy || !words.length}
                      onClick={() => {
                        setMenuOpen(false);
                        setCleanup(null);
                        setCaptionsOpen(true);
                      }}
                    >
                      Captions
                    </button>
                    <button type="button" disabled={busy} onClick={() => input.current?.click()}>
                      Replace transcript
                    </button>
                  </div>
                </section>
                <section>
                  <h3>WhisperX</h3>
                  <div data-row="">
                    {whisperButton}
                    {scriptToggle}
                  </div>
                  <p>Runs in its own conversation. It writes a transcript file only.</p>
                </section>
                {linkable(doc) ? (
                  <section>
                    <h3>Sync</h3>
                    <select
                      aria-label="Sync transcript to"
                      value={linkValue}
                      disabled={busy || candidates === null}
                      onChange={(event) => void chooseLink(event.target.value)}
                    >
                      {link && linkValue === "-1" ? (
                        <option value="-1">
                          A{link.trackIndex + 1} · {link.mediaName}
                        </option>
                      ) : null}
                      {(candidates ?? []).map((candidate, index) => (
                        <option
                          key={`${candidate.trackIndex}:${candidate.mediaName}`}
                          value={index}
                        >
                          A{candidate.trackIndex + 1} · {candidate.mediaName}
                        </option>
                      ))}
                      <option value="sequence">Sequence time (manual offset)</option>
                    </select>
                    {link ? (
                      <p>Words follow this clip, including trims and cuts made in Premiere.</p>
                    ) : (
                      <form
                        data-row=""
                        onSubmit={(event) => {
                          event.preventDefault();
                          setError(null);
                          try {
                            if (!offset.trim())
                              throw new Error("Enter a sequence offset in seconds.");
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
                            setError(
                              problem instanceof Error ? problem.message : "Invalid offset.",
                            );
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
                      </form>
                    )}
                  </section>
                ) : null}
                {doc.timing === "estimated" ? (
                  <p data-transcript-warn="">
                    Subtitle files only time whole cues, so word times are estimated. Check a range
                    before cutting it.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        </header>
      ) : null}
      {doc && captionsOpen ? (
        <CaptionsPanel
          key={key}
          context={context}
          words={words}
          disabled={disabled || busy || stored.uncertain}
          onBusy={(value) => {
            setBusy(value);
            onBusy(value);
          }}
          onClose={() => setCaptionsOpen(false)}
          onRestored={(sequenceId) => {
            localStorage.setItem(
              transcriptStorageKey(context, sequenceId),
              JSON.stringify({ ...storedRef.current, undo: null }),
            );
          }}
        />
      ) : null}
      {doc ? (
        <p data-transcript-meta="">
          <span data-synced={link ? "" : undefined} aria-hidden="true" />
          <span data-transcript-source="">
            {link
              ? `Synced to A${link.trackIndex + 1} · ${link.mediaName}`
              : linkable(doc)
                ? `Sequence time${doc.offset ? ` + ${doc.offset} s` : ""} · ${sourceFile(doc)}`
                : doc.source}
          </span>
          <span>· {words.length.toLocaleString()} words</span>
        </p>
      ) : null}
      {transcribing || whisperState === "loaded" || whisperState === "failed" ? (
        <div data-transcript-banner={whisperState}>
          <p role="status">
            {transcribing
              ? `Transcribing · ${agentStatus}. Agent details and questions are in Conversation. Stop waiting does not stop the agent.`
              : whisperState === "loaded"
                ? "WhisperX transcript loaded and saved."
                : "WhisperX transcription failed. See the reason below."}
          </p>
          {transcribing ? (
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
          ) : (
            <button
              type="button"
              data-icon=""
              aria-label="Dismiss"
              onClick={() => setWhisperState("idle")}
            >
              ×
            </button>
          )}
        </div>
      ) : null}
      {error ? (
        <p role="alert" data-error="">
          {error}
        </p>
      ) : null}
      {notice ? <p data-notice="">{notice}</p> : null}
      {stored.uncertain ? (
        <p data-notice="">
          Transcript timing needs review. Undo the cut or reimport after checking the timeline.
        </p>
      ) : null}
      {stored.undo ? (
        <div data-transcript-undo="">
          <span>Last transcript cut is protected by a checkpoint.</span>
          <button type="button" disabled={disabled || busy} onClick={() => void undo()}>
            Undo transcript cut
          </button>
        </div>
      ) : null}
      {!doc ? (
        <div data-transcript-empty="">
          <h1>Edit the story in words</h1>
          <p>
            Transcribe this sequence's voice-over, or import a WhisperX JSON, SRT or VTT file.
            Imported files sync to their clip on the timeline automatically.
          </p>
          <div data-row="">
            {whisperButton}
            <button type="button" disabled={busy} onClick={() => input.current?.click()}>
              Import transcript
            </button>
          </div>
          {scriptToggle}
        </div>
      ) : (
        <>
          {cleanup ? (
            <CleanupReview
              cuts={cleanupCuts}
              excluded={excluded}
              settings={cleanupSettings}
              busy={busy}
              canApply={!disabled && !stored.uncertain}
              onSettings={setCleanupSettings}
              onToggle={toggleCleanup}
              onSeek={(seconds) => seekPremiere(Math.max(0, seconds - 0.3), context.sequenceId)}
              onApply={() => void applyCleanup()}
              onClose={() => setCleanup(null)}
            />
          ) : null}
          <div data-transcript-body="">
            <div
              ref={wordArea}
              data-transcript-words=""
              data-shot-scroll=""
              tabIndex={-1}
              onWheel={() => setFollowing(false)}
              onTouchMove={() => setFollowing(false)}
              onPointerDown={(event) => {
                if (cleanup) return;
                if (event.target === event.currentTarget) setFollowing(false);
                const index = wordIndex(event.target);
                if (event.button !== 0 || index < 0) return;
                gesture.current = {
                  anchor: event.shiftKey && selection ? selection.anchor : index,
                  dragged: false,
                };
              }}
              onPointerOver={(event) => {
                const index = wordIndex(event.target);
                if (!gesture.current || event.buttons !== 1 || index < 0) return;
                if (index === gesture.current.anchor && !gesture.current.dragged) return;
                gesture.current.dragged = true;
                setSelection({ anchor: gesture.current.anchor, focus: index });
                setConfirmCut(false);
                setFollowing(false);
              }}
              onPointerLeave={() => {
                gesture.current = null;
              }}
              onClick={(event) => {
                const cut = (event.target as HTMLElement).closest?.("[data-cut-id]");
                if (cleanup && cut) {
                  toggleCleanup(cut.getAttribute("data-cut-id")!);
                  return;
                }
                const seek = (event.target as HTMLElement).closest?.("[data-seek]");
                if (seek) {
                  const index = Number(seek.getAttribute("data-seek"));
                  seekPremiere(seekTime(words[index]!.start, fps), context.sequenceId);
                  setFollowing(true);
                  return;
                }
                const index = wordIndex(event.target);
                if (index < 0) return;
                if (!gesture.current?.dragged) {
                  setSelection({
                    anchor: event.shiftKey && selection ? selection.anchor : index,
                    focus: index,
                  });
                  setConfirmCut(false);
                  if (!event.shiftKey) {
                    seekPremiere(seekTime(words[index]!.start, fps), context.sequenceId);
                    setFollowing(true);
                  }
                }
                gesture.current = null;
              }}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  setSelection(null);
                  setConfirmCut(false);
                }
              }}
            >
              {!words.length ? (
                <p data-transcript-none="">
                  {doc.words.length
                    ? "None of these words are on the timeline. Check the sync clip in the menu."
                    : "The imported words have all been cut. Undo to restore them."}
                </p>
              ) : null}
              {blocks.map(([from, to]) => (
                <Paragraph
                  key={from}
                  words={words}
                  from={from}
                  to={to}
                  active={current >= from && current < to ? current : -1}
                  selFirst={range && range.last >= from && range.first < to ? range.first : -1}
                  selLast={range && range.last >= from && range.first < to ? range.last : -2}
                  marks={marks}
                  current={anchorWord >= from && anchorWord < to}
                  busy={busy}
                  cleanupWords={cleanupWords}
                  cleanupPauses={cleanupPauses}
                  excluded={excluded}
                />
              ))}
            </div>
            {!following && words.length ? (
              <button type="button" data-transcript-jump="" onClick={() => setFollowing(true)}>
                Jump to playhead
              </button>
            ) : null}
          </div>
        </>
      )}
      {range ? (
        <div data-transcript-actions="" role="group" aria-label="Transcript selection actions">
          {confirmCut ? (
            <>
              <span>
                Ripple-cut {(range.end - range.start).toFixed(2)} s from every unlocked track?
                Locked tracks, captions and markers stay put.
              </span>
              <button type="button" data-danger="" disabled={busy} onClick={() => void cut()}>
                Confirm ripple cut
              </button>
              <button type="button" disabled={busy} onClick={() => setConfirmCut(false)}>
                Cancel cut
              </button>
            </>
          ) : (
            <>
              <span>
                {range.last - range.first + 1} word{range.last === range.first ? "" : "s"} ·{" "}
                {transcriptTime(range.start)} - {transcriptTime(range.end)}
              </span>
              <button
                type="button"
                data-primary=""
                disabled={busy}
                onClick={() => onAsk(transcriptContext(doc!, range, context.sequenceName))}
              >
                Ask Axis
              </button>
              <button
                type="button"
                disabled={busy || disabled || stored.uncertain}
                onClick={() => void cut()}
              >
                Cut from timeline
              </button>
              <button
                type="button"
                data-icon=""
                aria-label="Clear selection"
                onClick={() => setSelection(null)}
              >
                ×
              </button>
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
