import { useEffect, useEffectEvent, useRef, useState } from "react";
import { newMessageId } from "../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import type { PremiereContext } from "./host";
import { requestTimelineAction } from "./interactiveHost";
import { requestTimelineSnapshot } from "./timelineHost";
import { transcriptTime, type TranscriptWord } from "./sequenceTranscript";
import {
  chooseMusicTrack,
  defaultMusicMix,
  defaultMusicRoot,
  fillMusicGaps,
  matchingMusic,
  mergeShortMusicSections,
  musicKeyframes,
  musicCrossfadeSeconds,
  musicEnvelopeGain,
  prepareMusicCue,
  musicPathKey,
  musicScope,
  subtractMusicRanges,
  validateMusicCoverage,
  validateMusicPlan,
  type MusicCue,
  type MusicPlan,
  type MusicRange,
  type MusicTrack,
} from "./music";

export interface MusicAudioAttachment {
  type: "file";
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl: string;
}
interface MusicUndo {
  checkpointId: string;
  checkpointSignature: string;
  expectedSignature: string;
}
interface MusicResult {
  plan: MusicPlan;
  undo: MusicUndo;
  trackIndex: number;
  partial: boolean;
  summary?: string;
}
function stored<T>(key: string, fallback: T): T {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? "null") as T) ?? fallback;
  } catch {
    return fallback;
  }
}
const name = (path: string) => path.split(/[\\/]/).at(-1) ?? path;

export function MusicPanel({
  context,
  words,
  disabled,
  onBusy,
  onClose,
  onPlace,
  onRestored,
  initialPlan,
  selection,
  active = true,
  agentFinished = false,
}: {
  context: PremiereContext;
  words: readonly TranscriptWord[];
  disabled: boolean;
  onBusy: (busy: boolean) => void;
  onClose: () => void;
  onPlace?: ((prompt: string) => Promise<void>) | undefined;
  onRestored?: (sequenceId: string) => void;
  initialPlan?: MusicPlan | undefined;
  selection?: MusicRange | null;
  active?: boolean;
  agentFinished?: boolean;
}) {
  const projectId = context.projectDocumentId || context.projectPath;
  const key = `axis-music:${JSON.stringify(projectId)}`;
  const resultKey = `${key}:${context.sequenceId}:result`;
  const [root, setRoot] = useState(
    () => stored<{ root?: string }>(key, {}).root ?? defaultMusicRoot,
  );
  const [libraryOpen, setLibraryOpen] = useState(!root);
  const [tracks, setTracks] = useState<MusicTrack[]>([]);
  const [indexing, setIndexing] = useState(false);
  const [libraryStatus, setLibraryStatus] = useState("");
  const [duck, setDuck] = useState(false);
  const [result, setResult] = useState<MusicResult | null>(() => stored(resultKey, null));
  const [waiting, setWaiting] = useState<{
    id: string;
    signature: string;
    scope: MusicRange;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const lock = useRef(false);
  const libraryGeneration = useRef(0);
  const indexedRoot = useRef("");
  const configure = (value: string) => {
    if (value === root) return;
    libraryGeneration.current++;
    indexedRoot.current = "";
    setRoot(value);
    setTracks([]);
    setIndexing(false);
    setError("");
    setLibraryStatus("");
    try {
      localStorage.setItem(key, JSON.stringify({ root: value }));
    } catch {
      setError("The library folder could not be remembered.");
    }
  };
  function saveResult(value: MusicResult | null) {
    setResult(value);
    try {
      if (value) localStorage.setItem(resultKey, JSON.stringify(value));
      else localStorage.removeItem(resultKey);
    } catch {
      setError("Keep Music open to retain Undo. The checkpoint is also in Axis checkpoints.");
    }
  }
  async function request(action: string, fields: object = {}) {
    return (await requestTimelineAction("premiere.music.request", {
      action,
      root,
      projectId,
      sequenceId: context.sequenceId,
      ...fields,
    })) as Record<string, unknown>;
  }
  const indexLibrary = useEffectEvent(() => {
    const generation = ++libraryGeneration.current;
    indexedRoot.current = root;
    setIndexing(true);
    void (async () => {
      let pending: number;
      do {
        const packet = await request("index");
        if (libraryGeneration.current !== generation) return;
        if (!Array.isArray(packet.tracks)) throw new Error("Invalid music library response.");
        const indexed = packet.tracks as MusicTrack[];
        pending = Number(packet.pending) || 0;
        setTracks(indexed);
        setLibraryStatus(
          `${indexed.length} ${indexed.length === 1 ? "song" : "songs"}${pending ? `, indexing ${pending} more` : " ready"}${Array.isArray(packet.failures) && packet.failures.length ? `, ${packet.failures.length} unavailable` : ""}`,
        );
      } while (pending > 0);
    })()
      .catch((problem: unknown) => {
        if (libraryGeneration.current === generation)
          setError(problem instanceof Error ? problem.message : "Library indexing failed.");
      })
      .finally(() => {
        if (libraryGeneration.current === generation) setIndexing(false);
      });
  });
  // oxlint-disable-next-line t3code/react-effect-budget -- Debounce filesystem indexing through the CEP music helper.
  useEffect(() => {
    if (!active || !root.trim() || indexedRoot.current === root) return;
    const timer = setTimeout(() => indexLibrary(), 400);
    return () => clearTimeout(timer);
  }, [root, active]);
  // oxlint-disable-next-line t3code/react-effect-budget -- Invalidate asynchronous library reads when this panel unmounts.
  useEffect(
    () => () => {
      libraryGeneration.current++;
    },
    [],
  );
  function keepReceipt(packet: Record<string, unknown>, plan: MusicPlan, trackIndex: number) {
    if (
      !packet.checkpointId ||
      typeof packet.checkpointId !== "string" ||
      typeof packet.checkpointSignature !== "string" ||
      typeof packet.expectedSignature !== "string"
    )
      throw new Error("Missing undo receipt. Inspect Axis checkpoints before retrying.");
    const summary =
      packet.status === "partial"
        ? `Music stopped: ${String(packet.message)} Use Undo all before retrying.`
        : `Placed ${plan.cues.length} ${plan.cues.length === 1 ? "section" : "sections"}. ${String(packet.message || "Volume keyframe fades used.")}`;
    const reports = Array.isArray(packet.effectReports)
      ? (packet.effectReports as Array<{ id: string; results: string[] }>)
      : [];
    saveResult({
      plan: {
        ...plan,
        cues: plan.cues.map((cue) => ({
          ...cue,
          effectResults: reports.find((r) => r.id === cue.id)?.results ?? cue.effectResults,
        })),
      },
      undo: {
        checkpointId: packet.checkpointId,
        checkpointSignature: packet.checkpointSignature,
        expectedSignature: packet.expectedSignature,
      },
      trackIndex,
      partial: packet.status === "partial",
      summary,
    });
    setMessage("");
  }
  function prepared(cue: MusicCue) {
    const source = tracks.find((t) => musicPathKey(t.path) === musicPathKey(cue.track));
    if (
      !source ||
      cue.end - cue.start > source.duration + 0.001 ||
      /00\. duplicate copies - review/i.test(source.path)
    )
      throw new Error("Every section must fit a song from the indexed library.");
    const edgeFade = Math.min(musicCrossfadeSeconds / 2, (cue.end - cue.start) / 4);
    const normalized = prepareMusicCue({ ...cue, fadeIn: edgeFade, fadeOut: edgeFade }, source);
    return {
      ...normalized,
      keys: musicKeyframes(normalized, words, { ...defaultMusicMix, duckDb: duck ? -8 : 0 }).map(
        (key) => ({ ...key, envelopeValue: musicEnvelopeGain(normalized, key.time) }),
      ),
    };
  }
  async function apply(value: MusicPlan, expected?: string, scope?: MusicRange) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    onBusy(true);
    setError("");
    return await (async () => {
      const snapshot = await requestTimelineSnapshot(false, context.sequenceId);
      if (
        snapshot.snapshot.projectId !== projectId ||
        snapshot.snapshot.sequenceId !== context.sequenceId
      )
        throw new Error("The active project or sequence changed.");
      if (expected && expected !== snapshot.signature)
        throw new Error("The timeline changed while music was being planned. Place music again.");
      const target = chooseMusicTrack(snapshot.snapshot, tracks);
      const span = scope ?? musicScope(snapshot.snapshot, words, selection);
      const plan = fillMusicGaps(
        validateMusicPlan(mergeShortMusicSections(value)),
        span,
        target.clips,
        context.fps,
      );
      validateMusicCoverage(plan, span, target.clips, context.fps);
      for (const cue of plan.cues) {
        if (!cue.mood || cue.energy === undefined)
          throw new Error("Every section needs a mood and energy.");
        if (
          target.clips.some(
            (c) =>
              c.mediaPath &&
              musicPathKey(c.mediaPath) === musicPathKey(cue.track) &&
              (Math.abs(c.end - cue.start) < 0.05 || Math.abs(c.start - cue.end) < 0.05),
          )
        )
          throw new Error(
            "A section repeats the neighbouring song. Place music again to choose another.",
          );
      }
      if (!plan.cues.length) {
        setMessage("This range already has music.");
        return;
      }
      const cues = plan.cues.map(prepared);
      const packet = await request("apply", {
        confirmed: true,
        expectedSignature: snapshot.signature,
        targetTrackIndex: target.index,
        libraryPaths: tracks.map((t) => t.path),
        crossfade: musicCrossfadeSeconds,
        silence: plan.silence,
        ducking: duck,
        cues,
      });
      keepReceipt(packet, { ...plan, cues }, target.index);
    })()
      .catch((problem) => {
        setError(problem instanceof Error ? problem.message : "Music placement failed.");
      })
      .finally(() => {
        setWaiting(null);
        lock.current = false;
        setBusy(false);
        onBusy(false);
      });
  }
  const receivePlan = useEffectEvent(() => {
    if (!waiting || disabled || busy || indexing) return;
    if (initialPlan?.requestId === waiting.id)
      void apply(initialPlan, waiting.signature, waiting.scope);
    else if (agentFinished) {
      setWaiting(null);
      setError("The agent finished without a matching music plan. Place music to try again.");
    }
  });
  // oxlint-disable-next-line t3code/react-effect-budget -- Read the CEP plan handoff when the external planning run finishes.
  useEffect(() => {
    if (
      !waiting ||
      disabled ||
      busy ||
      indexing ||
      (initialPlan?.requestId !== waiting.id && !agentFinished)
    )
      return;
    void Promise.resolve().then(() => receivePlan());
  }, [initialPlan, disabled, busy, indexing, waiting, agentFinished]);
  async function place() {
    if (lock.current || disabled || waiting || indexing) return;
    lock.current = true;
    setError("");
    setMessage("");
    return await (async () => {
      if (!onPlace) throw new Error("Connect an editing agent to place music.");
      if (!tracks.length) throw new Error("Choose a library containing indexed songs.");
      const snapshot = await requestTimelineSnapshot(false, context.sequenceId);
      if (
        snapshot.snapshot.projectId !== projectId ||
        snapshot.snapshot.sequenceId !== context.sequenceId
      )
        throw new Error("The active project or sequence changed.");
      const target = chooseMusicTrack(snapshot.snapshot, tracks);
      const scope = musicScope(snapshot.snapshot, words, selection);
      if (!words.length) throw new Error("Transcribe the voice-over before placing music.");
      if (!subtractMusicRanges(scope, target.clips).length) {
        setMessage("This range already has music.");
        return;
      }
      const id = newMessageId();
      setWaiting({ id, signature: snapshot.signature, scope });
      await onPlace(
        `Use $axis-music-placement. Return a plan only; the panel will checkpoint and apply automatically. Do not call timeline-writing tools. Split the timed VO by subject, character or object and emotional changes, usually 30-90 seconds, never by elapsed time alone. Merge neighbouring subjects shorter than 28 seconds only when they share a theme and mood (for example three short fusion characters become one Fusions section); use an optional shared theme field when returning separate short subjects. One song per section, back to back, covering the entire scope except sponsors and occupied intervals. Infer each section's mood and energy from its meaning. Primary mood source: calm music for explanations; dark cinematic music for tension, danger, reveals, ominous lore and showdowns; hype music for intros, fights and phonk; sad music for genuine loss and reflection. Never use duplicate-review copies. Unsorted-review tracks are last resort. Catalogue duration, BPM, energy and brightness are secondary hints. Songs may recur, never in neighbouring sections including existing clips. Find each section's key VO moment (form-name reveal, transformation or decisive visual beat) from exact transcript timings and include keyTime in sequence seconds when there is clear evidence. Mark vocals:true only from catalogue tags or known lyrics; otherwise omit it. Never loop or overrun sources. The panel skips silence, starts long soft intros about 7 seconds before the loud part, and aligns measured drops to keyTime within source bounds. It computes bedDb=clamp(-38-integratedLUFS,-35,-25), with a default +12 dB intro swell over 8 seconds (up to 28 for soft openings), 3 second joins, and best-effort Hard Limiter for quiet/uneven songs or Lowpass for vocals at -28 to -30 dB. Swell may be disabled per section with swell:false. No ducking by default. The user said: "-29 is the best, -33 is way too quiet even with headphones." Prefer Nordic/epic dark for dragon villains, trailer metal for destroyers, melodic phonk for berserk-but-tender, stylish phonk for Goku Black, haunting violin for god-complex horror, aggressive phonk for Vegeta. Return one axis-music JSON fence: {version:1,requestId:${JSON.stringify(id)},cues:[{id,chapter,theme?,mood,energy:0.0,start,end,keyTime?,vocals?,swell?,track,sourceOffset,reason,fadeIn:1.5,fadeOut:1.5,baseDb:0,enabled:true,alternatives:[]}],silence:[]}. Mood and energy are required. Shorten fades for tiny sections. Use exact indexed paths. The checkpoint plus Undo all is the authorized single-click confirmation. Scope: ${JSON.stringify(scope)}. Target track: ${JSON.stringify(target)}. Timed VO: ${JSON.stringify(words.filter((w) => w.end > scope.start && w.start < scope.end))}. Indexed library: ${JSON.stringify(tracks.map(({ path, category, duration, tempo, catalogueEnergy, brightness, description, tags, vocals, integratedLufs, firstAudible, loudPartStart, biggestDrop }) => ({ path, category, duration, tempo, catalogueEnergy, brightness, description, tags, vocals, integratedLufs, firstAudible, loudPartStart, biggestDrop })))}`,
      );
    })()
      .catch((problem) => {
        setWaiting(null);
        setError(problem instanceof Error ? problem.message : "Could not ask the music agent.");
      })
      .finally(() => {
        lock.current = false;
      });
  }
  async function swap(cue: MusicCue) {
    if (!result || lock.current || disabled) return;
    lock.current = true;
    setBusy(true);
    onBusy(true);
    setError("");
    return await (async () => {
      const snapshot = await requestTimelineSnapshot(false, context.sequenceId);
      if (snapshot.signature !== result.undo.expectedSignature)
        throw new Error("The timeline changed. Inspect it before swapping.");
      const target = snapshot.snapshot.audioTracks.find((t) => t.index === result.trackIndex);
      const clip = target?.clips.find(
        (c) =>
          c.mediaPath &&
          musicPathKey(c.mediaPath) === musicPathKey(cue.track) &&
          Math.abs(c.start - cue.start) < 0.02 &&
          Math.abs(c.end - cue.end) < 0.05,
      );
      if (!clip) throw new Error("The placed song could not be identified safely.");
      const neighbours = target!.clips.filter(
        (c) =>
          c.nodeId !== clip.nodeId &&
          (Math.abs(c.end - cue.start) < 0.05 || Math.abs(c.start - cue.end) < 0.05),
      );
      const chosen = matchingMusic(
        cue.mood ?? "calm",
        cue.energy ?? 0.3,
        cue.end - cue.start,
        tracks,
        [cue.track, ...neighbours.map((c) => c.mediaPath ?? "")],
      )[0];
      if (!chosen) throw new Error("No different matching song is long enough for this section.");
      const replacement = prepared({
        ...cue,
        track: chosen.path,
        sourceOffset: 0,
        vocals: undefined,
      });
      const packet = await request("swap", {
        ...result.undo,
        confirmed: true,
        targetTrackIndex: result.trackIndex,
        replace: { nodeId: clip.nodeId, track: cue.track, start: cue.start, end: cue.end },
        libraryPaths: tracks.map((t) => t.path),
        crossfade: musicCrossfadeSeconds,
        ducking: duck,
        cues: [replacement],
      });
      keepReceipt(
        packet,
        { ...result.plan, cues: result.plan.cues.map((c) => (c.id === cue.id ? replacement : c)) },
        result.trackIndex,
      );
    })()
      .catch((problem) => {
        setError(problem instanceof Error ? problem.message : "Swap failed.");
      })
      .finally(() => {
        lock.current = false;
        setBusy(false);
        onBusy(false);
      });
  }
  async function undoAll() {
    if (!result || lock.current || disabled) return;
    lock.current = true;
    setBusy(true);
    onBusy(true);
    setError("");
    return await (async () => {
      const packet = await request("undo", result.undo);
      if (packet.status !== "undone" || typeof packet.sequenceId !== "string")
        throw new Error("Missing restored sequence ID.");
      onRestored?.(packet.sequenceId);
      saveResult(null);
      setMessage("Opened the sequence from before music placement.");
    })()
      .catch((problem) => {
        setError(problem instanceof Error ? problem.message : "Undo failed.");
      })
      .finally(() => {
        lock.current = false;
        setBusy(false);
        onBusy(false);
      });
  }
  const blocked = disabled || busy || !!waiting;
  return (
    <section data-music-panel="" role="region" aria-label="Music">
      <header>
        <strong>Music</strong>
        <span>One song for each section</span>
        <button type="button" aria-label="Close Music" disabled={busy} onClick={onClose}>
          ×
        </button>
      </header>
      <details
        data-music-library=""
        open={libraryOpen}
        onToggle={(event) => setLibraryOpen(event.currentTarget.open)}
      >
        <summary>Library{root ? ` · ${name(root)}` : " folder"}</summary>
        <label>
          Library folder
          <div data-music-row="">
            <input
              aria-label="Music library folder"
              value={root}
              disabled={blocked}
              onChange={(e) => configure(e.target.value)}
            />
            <button
              type="button"
              disabled={blocked || indexing}
              onClick={() => {
                void request("pick")
                  .then((packet) => {
                    if (typeof packet.root === "string" && packet.root) configure(packet.root);
                  })
                  .catch((problem: unknown) => setError(String(problem)));
              }}
            >
              Browse
            </button>
          </div>
        </label>
      </details>
      <p data-music-empty="">
        Music follows your script, matching the mood of each character or subject.
      </p>
      <button
        type="button"
        data-primary=""
        disabled={blocked || indexing || !tracks.length || !root || !!result}
        onClick={() => void place()}
      >
        {busy ? "Placing music..." : waiting ? "Matching music..." : "Place music"}
      </button>
      {!result ? (
        <label data-music-duck="">
          <input
            type="checkbox"
            checked={duck}
            disabled={blocked}
            onChange={(e) => setDuck(e.target.checked)}
          />
          Lower music during speech
        </label>
      ) : null}
      {libraryStatus ? <small>{libraryStatus}</small> : null}
      {result ? (
        <>
          <div data-music-row="">
            <strong>{result.partial ? "Placement stopped" : "Music placed"}</strong>
            <button
              type="button"
              disabled={disabled || busy || !result.undo.expectedSignature}
              onClick={() => void undoAll()}
            >
              Undo all
            </button>
          </div>
          <ol data-music-cues="">
            {result.plan.cues.map((cue) => (
              <li key={cue.id}>
                <div data-music-row="">
                  <strong>{cue.chapter}</strong>
                  <button
                    type="button"
                    aria-label={`Swap ${cue.chapter}`}
                    disabled={disabled || busy || result.partial}
                    onClick={() => void swap(cue)}
                  >
                    Swap
                  </button>
                </div>
                <small>
                  {transcriptTime(cue.start)} - {transcriptTime(cue.end)} · {cue.mood}
                </small>
                <p>{name(cue.track)}</p>
                <Tooltip>
                  <TooltipTrigger render={<small data-music-mix="" />}>
                    {cue.baseDb.toFixed(1)} dB ·{" "}
                    {cue.effectResults?.length
                      ? cue.effectResults.map((result) => result.replace(/\s+\(.*/, "")).join(", ")
                      : cue.effects?.length
                        ? "Effects unverified"
                        : "No effects"}
                  </TooltipTrigger>
                  <TooltipPopup>
                    {cue.effectResults?.join(", ") ||
                      (cue.effects?.length
                        ? "Effect application could not be verified."
                        : "No effects requested.")}
                  </TooltipPopup>
                </Tooltip>
              </li>
            ))}
          </ol>
        </>
      ) : null}
      {message || waiting || result?.summary ? (
        <p role="status">
          {waiting
            ? "Reading the script and choosing music for each section..."
            : message || result?.summary}
        </p>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}
