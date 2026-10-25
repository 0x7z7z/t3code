import { useEffect, useEffectEvent, useRef, useState } from "react";
import { seekPremiere, type PremiereContext } from "./host";
import { requestTimelineAction } from "./interactiveHost";
import { requestTimelineSnapshot } from "./timelineHost";
import { transcriptTime, type TranscriptWord } from "./sequenceTranscript";
import {
  defaultMusicMix,
  defaultMusicRoot,
  musicChapters,
  musicKeyframes,
  planMusic,
  validateMusicPlan,
  type MusicCue,
  type MusicMix,
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
function stored<T>(key: string, fallback: T): T {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? "null") as T) ?? fallback;
  } catch {
    return fallback;
  }
}
function readSettings(key: string, root: string) {
  const fallback = { root, mix: defaultMusicMix };
  const value = stored<unknown>(key, null);
  if (
    !value ||
    typeof value !== "object" ||
    !("root" in value) ||
    typeof value.root !== "string" ||
    value.root.length > 32768 ||
    !("mix" in value) ||
    !value.mix ||
    typeof value.mix !== "object"
  )
    return fallback;
  const mix = value.mix as MusicMix;
  if (
    Object.keys(defaultMusicMix).some(
      (key) =>
        typeof mix[key as keyof MusicMix] !== "number" ||
        !Number.isFinite(mix[key as keyof MusicMix]),
    )
  )
    return fallback;
  if (
    mix.baseDb < -60 ||
    mix.baseDb > 0 ||
    mix.duckDb < -60 ||
    mix.duckDb > 0 ||
    [mix.attack, mix.release, mix.mergeGap].some((n) => n < 0 || n > 10)
  )
    return fallback;
  return { root: value.root, mix };
}
function readUndo(key: string): MusicUndo | null {
  const value = stored<unknown>(key, null);
  if (!value || typeof value !== "object") return null;
  const undo = value as MusicUndo;
  return [undo.checkpointId, undo.checkpointSignature, undo.expectedSignature].every(
    (v) => typeof v === "string" && v.length > 0 && v.length <= 4000000,
  )
    ? undo
    : null;
}
const name = (path: string) => path.split(/[\\/]/).at(-1) ?? path;
const pathKey = (path: string) => path.replaceAll("\\", "/").toLowerCase();

export function MusicPanel({
  context,
  words,
  disabled,
  onBusy,
  onClose,
  onAsk,
  onRestored,
  initialPlan,
  onDescribe,
}: {
  context: PremiereContext;
  words: readonly TranscriptWord[];
  disabled: boolean;
  onBusy: (busy: boolean) => void;
  onClose: () => void;
  onAsk: (prompt: string) => void;
  onRestored?: (sequenceId: string) => void;
  initialPlan?: MusicPlan | undefined;
  onDescribe?: ((prompt: string, audio: MusicAudioAttachment[]) => Promise<void>) | undefined;
}) {
  const projectId = context.projectDocumentId || context.projectPath;
  const key = `axis-music:${JSON.stringify(projectId)}`;
  const undoKey = `${key}:${context.sequenceId}:undo`;
  const [settings, setSettings] = useState(() =>
    readSettings(
      key,
      context.projectName.toLowerCase().includes("animeaddicts") ||
        /animeaddicts/i.test(context.projectPath)
        ? defaultMusicRoot
        : "",
    ),
  );
  const [undo, setUndo] = useState<MusicUndo | null>(() => readUndo(undoKey));
  const [tracks, setTracks] = useState<MusicTrack[]>([]);
  const libraryByPath = new Map(tracks.map((track) => [pathKey(track.path), track]));
  const [pending, setPending] = useState(0);
  const [failures, setFailures] = useState(0);
  const [tool, setTool] = useState("");
  const [plan, setPlan] = useState<MusicPlan | null>(initialPlan ?? null);
  const [signature, setSignature] = useState("");
  const [exclusions, setExclusions] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [preview, setPreview] = useState<{ url: string; label: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const lock = useRef(false);
  const chapters = musicChapters(words);
  let validation = "";
  try {
    if (plan) {
      validateMusicPlan(plan);
      for (const cue of plan.cues.filter((c) => c.enabled)) {
        const track = libraryByPath.get(pathKey(cue.track));
        if (track && cue.sourceOffset + cue.end - cue.start > track.duration + 0.001)
          throw new Error("The cue extends beyond the indexed source. Adjust its offset or start.");
      }
    }
  } catch (problem) {
    validation = String(problem instanceof Error ? problem.message : problem);
  }
  const receivePlan = useEffectEvent((value: MusicPlan) => {
    setPlan(value);
    setSignature("");
    setConfirmed(false);
  });
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Agent suggestion delivery resets this editable review draft.
    if (initialPlan) receivePlan(initialPlan);
  }, [initialPlan]);
  function configure(root: string, mix = settings.mix) {
    setSettings({ root, mix });
    setConfirmed(false);
    if (root !== settings.root) {
      setTracks([]);
      setSignature("");
    }
    try {
      localStorage.setItem(key, JSON.stringify({ root, mix }));
    } catch {
      setError("Project settings could not be remembered.");
    }
  }
  function saveUndo(value: MusicUndo | null) {
    setUndo(value);
    try {
      if (value) localStorage.setItem(undoKey, JSON.stringify(value));
      else localStorage.removeItem(undoKey);
    } catch {
      setError(
        "Keep Music open to retain Undo. Its sequence checkpoint is also in Axis checkpoints.",
      );
    }
  }
  async function run(action: string, fields: object = {}) {
    if (lock.current || disabled) return;
    lock.current = true;
    setBusy(true);
    onBusy(true);
    setError("");
    setMessage("");
    try {
      const packet = (await requestTimelineAction("premiere.music.request", {
        action,
        root: settings.root,
        projectId,
        sequenceId: context.sequenceId,
        ...fields,
      })) as Record<string, unknown>;
      if (action === "pick" && typeof packet.root === "string" && packet.root)
        configure(packet.root);
      if (action === "index") {
        if (!Array.isArray(packet.tracks)) throw new Error("Invalid library response.");
        setTracks(packet.tracks as MusicTrack[]);
        setPending(Number(packet.pending) || 0);
        setFailures(Array.isArray(packet.failures) ? packet.failures.length : 0);
        setTool(String(packet.tool || ""));
        if (Array.isArray(packet.failures) && packet.failures.length) {
          const failure = packet.failures[0] as { error?: unknown };
          setError(
            `Library analysis: ${String(failure.error ?? "An audio file could not be decoded.").slice(0, 600)}`,
          );
        }
        setMessage(
          `${packet.tracks.length} tracks indexed. ${Number(packet.pending) || 0} pending. ${Array.isArray(packet.failures) ? packet.failures.length : 0} failed. Failed files retry when their size or modification time changes.`,
        );
        setSignature("");
        setConfirmed(false);
      }
      if (action === "audition" && typeof packet.dataUrl === "string")
        setPreview({
          url: packet.dataUrl,
          label: name(String(fields && "path" in fields ? fields.path : "Music")),
        });
      if (action === "apply") {
        if (
          typeof packet.checkpointId !== "string" ||
          !packet.checkpointId ||
          typeof packet.checkpointSignature !== "string" ||
          typeof packet.expectedSignature !== "string"
        )
          throw new Error("Missing music undo receipt. Inspect Axis checkpoints before retrying.");
        saveUndo(packet as unknown as MusicUndo);
        setConfirmed(false);
        setSignature("");
        setMessage(
          packet.status === "partial"
            ? `Music stopped: ${String(packet.message)} Use Undo music before retrying.`
            : "Music applied. Listen through transitions and check voice-over masking.",
        );
      }
      if (action === "undo") {
        if (
          packet.status !== "undone" ||
          typeof packet.sequenceId !== "string" ||
          !packet.sequenceId
        )
          throw new Error("Missing restored sequence ID.");
        onRestored?.(packet.sequenceId);
        saveUndo(null);
        setSignature("");
        setConfirmed(false);
        setMessage("Opened the pre-music sequence checkpoint.");
      }
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Music operation failed.");
    } finally {
      lock.current = false;
      setBusy(false);
      onBusy(false);
    }
  }
  function excludedRanges(): MusicRange[] {
    return exclusions.trim()
      ? exclusions.split(",").map((part) => {
          const [start, end] = part.split("-").map(Number);
          if (start === undefined || end === undefined)
            throw new Error("Use start-end seconds, separated by commas.");
          return { start, end };
        })
      : [];
  }
  async function review(generate: boolean) {
    if (lock.current || disabled) return;
    lock.current = true;
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      const value = generate
        ? planMusic(words, tracks, settings.mix.baseDb, excludedRanges())
        : validateMusicPlan(
            plan
              ? {
                  ...plan,
                  silence: [
                    ...plan.silence,
                    ...excludedRanges()
                      .filter(
                        (r) => !plan.silence.some((s) => s.start === r.start && s.end === r.end),
                      )
                      .map((r) => ({ ...r, reason: "Editor excluded / sponsor" })),
                  ],
                }
              : null,
          );
      for (const c of value.cues.filter((c) => c.enabled)) {
        const track = libraryByPath.get(pathKey(c.track));
        if (!track || c.sourceOffset + c.end - c.start > track.duration + 0.001)
          throw new Error("Index this library first. Every cue must fit an indexed source track.");
      }
      const snapshot = await requestTimelineSnapshot(false, context.sequenceId);
      if (snapshot.snapshot.projectId !== projectId) throw new Error("The active project changed.");
      setPlan(value);
      setSignature(snapshot.signature);
      setConfirmed(false);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Could not review music.");
    } finally {
      lock.current = false;
      setBusy(false);
      onBusy(false);
    }
  }
  function updateCue(id: string, patch: Partial<MusicCue>) {
    if (!plan) return;
    setPlan({ ...plan, cues: plan.cues.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
    setConfirmed(false);
  }
  async function describeLibrary() {
    if (!onDescribe || lock.current || disabled) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const batch = tracks.filter((t) => !t.description).slice(0, 3);
      const audio: MusicAudioAttachment[] = [];
      for (const track of batch) {
        const offset = track.loudWindows[0]?.start ?? 0;
        const packet = (await requestTimelineAction("premiere.music.request", {
          action: "audition",
          root: settings.root,
          path: track.path,
          offset,
        })) as Record<string, unknown>;
        if (typeof packet.dataUrl !== "string" || typeof packet.sizeBytes !== "number")
          throw new Error("Could not prepare audio sample.");
        audio.push({
          type: "file",
          name: `${audio.length + 1}-${track.filename.slice(0, 200)}.wav`,
          mimeType: "audio/wav",
          sizeBytes: packet.sizeBytes,
          dataUrl: packet.dataUrl,
        });
      }
      await onDescribe(
        `Describe library: listen to each of the ${audio.length} attached 30-second music excerpts. Describe only audible mood, genre and instrumentation, state excerpt coverage, and save each short description using the Axis helper (shell tool, no Premiere writes): python ${JSON.stringify(tool)} describe --path <exact path> --fingerprint <fingerprint> --description <description> --tags <JSON string array>. Never infer mood from the filename or invent listening. Samples in order: ${JSON.stringify(batch.map((t) => ({ path: t.path, fingerprint: t.fingerprint, offset: t.loudWindows[0]?.start ?? 0 })))}. Then tell me to refresh the library index. Do not change the timeline.`,
        audio,
      );
      setMessage(
        "Library description sent. Follow the reply in Conversation, then refresh the index.",
      );
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Library description failed.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const active = plan?.cues.filter((c) => c.enabled) ?? [];
  const blocked = busy || disabled;
  return (
    <section data-music-panel="" role="region" aria-label="Music">
      <header>
        <strong>Music</strong>
        <span>Voice-over first</span>
        <button type="button" aria-label="Close Music" disabled={busy} onClick={onClose}>
          ×
        </button>
      </header>
      <label>
        Library folder
        <div data-music-row="">
          <input
            aria-label="Music library folder"
            value={settings.root}
            disabled={blocked}
            onChange={(e) => configure(e.target.value)}
          />
          <button type="button" disabled={blocked} onClick={() => void run("pick")}>
            Browse
          </button>
        </div>
      </label>
      <div data-music-row="">
        <button
          type="button"
          disabled={blocked || !settings.root}
          onClick={() => void run("index")}
        >
          {pending ? `Resume index (${pending})` : "Index library"}
        </button>
        <small>{tracks.length} tracks</small>
        {failures ? (
          <button
            type="button"
            disabled={blocked}
            onClick={() => void run("index", { retryFailures: true })}
          >
            Retry {failures} failed
          </button>
        ) : null}
        <button
          type="button"
          disabled={blocked || !onDescribe || !tracks.some((t) => !t.description)}
          onClick={() => void describeLibrary()}
        >
          Describe library
        </button>
      </div>
      <details>
        <summary aria-label="Music levels and exclusions">Levels, fades and exclusions</summary>
        <div data-music-settings="">
          {(
            [
              ["baseDb", "Base level (dB)", -60, 0, 1],
              ["duckDb", "Duck depth (dB)", -60, 0, 1],
              ["attack", "Attack (s)", 0, 10, 0.05],
              ["release", "Release (s)", 0, 10, 0.05],
              ["mergeGap", "Merge speech gaps (s)", 0, 10, 0.05],
            ] as const
          ).map(([field, label, min, max, step]) => (
            <label key={field}>
              {label}
              <input
                type="number"
                aria-label={label}
                min={min}
                max={max}
                step={step}
                disabled={blocked}
                value={settings.mix[field]}
                onChange={(e) => {
                  const mix: MusicMix = { ...settings.mix, [field]: Number(e.target.value) };
                  configure(settings.root, mix);
                  if (field === "baseDb" && plan)
                    setPlan({
                      ...plan,
                      cues: plan.cues.map((c) => ({ ...c, baseDb: mix.baseDb })),
                    });
                }}
              />
            </label>
          ))}
        </div>
        <label>
          Sponsor / silence ranges (seconds)
          <input
            aria-label="Sponsor and silence ranges"
            placeholder="60-90, 240-250"
            value={exclusions}
            disabled={blocked}
            onChange={(e) => {
              setExclusions(e.target.value);
              setSignature("");
              setConfirmed(false);
            }}
          />
        </label>
        <small>
          Build again after changing exclusions. Sponsor detection is conservative; verify the
          boundaries.
        </small>
      </details>
      <div data-music-row="">
        <button
          type="button"
          disabled={blocked || !tracks.length || !words.length || !!undo}
          onClick={() => void review(true)}
        >
          Build music plan
        </button>
        <button
          type="button"
          disabled={blocked || !tracks.length}
          onClick={() =>
            onAsk(
              `Score this video using Axis Music. Read the axis-music-placement skill, plan coherent chapter beds with exact indexed files and measured offsets, voice-over first, no repeats, deliberate silence, exclude sponsors. Emit a version 1 axis-music JSON plan for review, do not apply yet. Transcript chapters: ${JSON.stringify(chapters)}. Library: ${JSON.stringify(tracks.slice(0, 200).map(({ energy: _energy, ...t }) => t))}`,
            )
          }
        >
          Ask agent
        </button>
      </div>
      {plan ? (
        <>
          <div data-music-bands="" aria-label="Music chapter timeline">
            {chapters.map((c) => (
              <button
                type="button"
                key={c.start}
                aria-label={c.title}
                style={{ flexGrow: c.end - c.start }}
                data-sponsor={c.sponsor || undefined}
                onClick={() => seekPremiere(c.start, context.sequenceId)}
              >
                {transcriptTime(c.start)}
              </button>
            ))}
          </div>
          <ol data-music-cues="">
            {plan.cues.map((c) => (
              <li key={c.id} data-enabled={c.enabled}>
                <div data-music-row="">
                  <input
                    type="checkbox"
                    aria-label={`Include ${c.chapter}`}
                    checked={c.enabled}
                    disabled={blocked || !!undo}
                    onChange={(e) => updateCue(c.id, { enabled: e.target.checked })}
                  />
                  <button
                    type="button"
                    data-timestamp=""
                    onClick={() => seekPremiere(c.start, context.sequenceId)}
                  >
                    {transcriptTime(c.start)}
                  </button>
                  <strong>{c.chapter}</strong>
                </div>
                <select
                  aria-label={`Track for ${c.chapter}`}
                  disabled={blocked || !!undo}
                  value={c.track}
                  onChange={(e) => {
                    const alt = c.alternatives.find((a) => a.track === e.target.value);
                    if (alt)
                      updateCue(c.id, {
                        ...alt,
                        alternatives: [
                          { track: c.track, sourceOffset: c.sourceOffset, reason: c.reason },
                          ...c.alternatives.filter((a) => a.track !== alt.track),
                        ].slice(0, 3),
                      });
                  }}
                >
                  <option value={c.track}>{name(c.track)}</option>
                  {c.alternatives.map((a) => (
                    <option key={a.track} value={a.track}>
                      {name(a.track)}
                    </option>
                  ))}
                </select>
                <p>{c.reason}</p>
                <div data-music-row="">
                  <label>
                    Start
                    <input
                      type="number"
                      aria-label={`Start for ${c.chapter}`}
                      step={1 / context.fps}
                      value={c.start}
                      disabled={blocked || !!undo}
                      onChange={(e) => updateCue(c.id, { start: Number(e.target.value) })}
                    />
                  </label>
                  <label>
                    Source
                    <input
                      type="number"
                      aria-label={`Source offset for ${c.chapter}`}
                      min={0}
                      step="0.1"
                      value={c.sourceOffset}
                      disabled={blocked || !!undo}
                      onChange={(e) => updateCue(c.id, { sourceOffset: Number(e.target.value) })}
                    />
                  </label>
                  <button
                    type="button"
                    disabled={blocked}
                    onClick={() => {
                      seekPremiere(c.start, context.sequenceId);
                      void run("audition", { path: c.track, offset: c.sourceOffset });
                    }}
                  >
                    Audition
                  </button>
                </div>
                <div data-music-row="">
                  {(["fadeIn", "fadeOut"] as const).map((field) => (
                    <label key={field}>
                      {field === "fadeIn" ? "Fade in" : "Fade out"}
                      <input
                        aria-label={`${field} for ${c.chapter}`}
                        type="number"
                        min="0"
                        step="0.1"
                        value={c[field]}
                        disabled={blocked || !!undo}
                        onChange={(e) => updateCue(c.id, { [field]: Number(e.target.value) })}
                      />
                    </label>
                  ))}
                  <small>
                    to {transcriptTime(c.end)} · {c.baseDb} dB
                  </small>
                </div>
              </li>
            ))}
          </ol>
          {plan.silence.map((s) => (
            <p data-music-silence="" key={`${s.start}:${s.end}:${s.reason}`}>
              {transcriptTime(s.start)}-{transcriptTime(s.end)} · {s.reason}
            </p>
          ))}
          {!signature && !undo ? (
            <button
              type="button"
              disabled={blocked || !tracks.length || !!validation}
              onClick={() => void review(false)}
            >
              Validate plan against timeline
            </button>
          ) : null}
          <label data-music-confirm="">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={blocked || !signature || !!validation || !!undo}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            I reviewed cues, sponsor boundaries and voice-over levels.
          </label>
          <button
            type="button"
            data-primary=""
            disabled={
              blocked || !confirmed || !signature || !active.length || !!validation || !!undo
            }
            onClick={() => {
              try {
                const cues = validateMusicPlan(plan)
                  .cues.filter((c) => c.enabled)
                  .sort((a, b) => a.start - b.start)
                  .map((c) => ({ ...c, keys: musicKeyframes(c, words, settings.mix) }));
                void run("apply", {
                  cues,
                  silence: plan.silence,
                  confirmed: true,
                  expectedSignature: signature,
                });
              } catch (problem) {
                setError(String(problem));
              }
            }}
          >
            Apply {active.length} cues
          </button>
        </>
      ) : (
        <p data-music-empty="">
          Build a chapter score from your local library, then audition and review before applying.
        </p>
      )}
      {undo ? (
        <button
          type="button"
          disabled={blocked || !undo.expectedSignature}
          onClick={() => void run("undo", undo)}
        >
          Undo music
        </button>
      ) : null}
      {preview ? (
        <div data-music-preview="">
          <small>{preview.label} · 30 second source preview</small>
          <audio
            key={preview.url}
            controls
            autoPlay
            src={preview.url}
            aria-label="Music source preview"
          />
        </div>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      {error || validation ? <p role="alert">{error || validation}</p> : null}
      <small>
        Categories and measured energy guide the first pass. Mood is unverified until listened to or
        described by an audio-capable agent.
        {!onDescribe ? " Select Antigravity with a Gemini model to describe audio excerpts." : ""}
      </small>
    </section>
  );
}
