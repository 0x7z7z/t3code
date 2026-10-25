import type { TranscriptWord } from "./sequenceTranscript";

export const defaultMusicRoot = String.raw`D:\0. PROJECTS\~ AnimeAddicts\~ AnimeAddicts Editing Template\7. Music`;
export interface MusicRange {
  start: number;
  end: number;
}
export interface MusicTrack {
  path: string;
  filename: string;
  category: string;
  duration: number;
  loudnessDbfs: number;
  energy: number[];
  rises: Array<MusicRange & { db: number }>;
  loudWindows: MusicRange[];
  quietRanges: MusicRange[];
  phraseBoundaries: number[];
  tempo: number | null;
  description: string;
  tags: string[];
  fingerprint?: string;
}
export interface MusicChapter extends MusicRange {
  title: string;
  text: string;
  beat?: number;
  sponsor: boolean;
}
export interface MusicCue extends MusicRange {
  id: string;
  chapter: string;
  track: string;
  sourceOffset: number;
  reason: string;
  fadeIn: number;
  fadeOut: number;
  baseDb: number;
  enabled: boolean;
  alternatives: Array<{ track: string; sourceOffset: number; reason: string }>;
}
export interface MusicPlan {
  version: 1;
  cues: MusicCue[];
  silence: Array<MusicRange & { reason: string }>;
}
export interface MusicMix {
  baseDb: number;
  duckDb: number;
  attack: number;
  release: number;
  mergeGap: number;
}
export const defaultMusicMix: MusicMix = {
  baseDb: -22,
  duckDb: -8,
  attack: 0.25,
  release: 0.6,
  mergeGap: 0.85,
};
const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
const range = (r: MusicRange) =>
  finite(r.start) && finite(r.end) && r.start >= 0 && r.end > r.start;

export function musicChapters(words: readonly TranscriptWord[]): MusicChapter[] {
  const result: MusicChapter[] = [];
  let from = 0;
  let sponsored = false;
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (!range(word) || (i && word.start < words[i - 1]!.start))
      throw new Error("Music needs ordered transcript word timings.");
    const next = words[i + 1];
    const nextText = words
      .slice(i + 1, i + 9)
      .map((w) => w.text)
      .join(" ");
    const boundary =
      /^(?:this (?:video|episode) is (?:sponsored|brought)|a word from|thanks to .{0,35}sponsor)/i.test(
        nextText,
      ) ||
      /^(?:now back to|let's get back)/i.test(nextText) ||
      (/^back to (?:the|our)/i.test(nextText) && !/^(?:now|let's)$/i.test(word.text));
    const duration = word.end - words[from]!.start;
    if (
      !next ||
      boundary ||
      (duration >= 45 && (next.start - word.end >= 2.5 || /[.!?]$/.test(word.text))) ||
      duration >= 180
    ) {
      const span = words.slice(from, i + 1);
      const text = span.map((w) => w.text).join(" ");
      if (/^(?:back to|now back to|let's get back)/i.test(text)) sponsored = false;
      if (/\bsponsor(?:ed)?\b|\buse (?:my|our) (?:code|link)\b/i.test(text)) sponsored = true;
      const beat = span.find((w) =>
        /^(?:but|suddenly|finally|reveal|however|until)\b/i.test(w.text),
      )?.start;
      result.push({
        start: span[0]!.start,
        end: Math.max(word.end, next?.start ?? word.end),
        text,
        title: span
          .slice(0, 8)
          .map((w) => w.text)
          .join(" "),
        sponsor: sponsored,
        ...(beat === undefined ? {} : { beat }),
      });
      from = i + 1;
    }
  }
  return result;
}

/** Align an actual measured rise end to a narration beat, or start at a phrase candidate. */
export function musicOffset(track: MusicTrack, duration: number, beatOffset?: number): number {
  const maximum = track.duration - duration;
  if (maximum < 0) throw new Error("Track is too short for this chapter.");
  if (beatOffset !== undefined) {
    const candidates = track.rises
      .filter((r) => r.db >= 3)
      .map((r) => ({ offset: r.end - beatOffset, db: r.db }))
      .filter((r) => r.offset >= 0 && r.offset <= maximum)
      .sort((a, b) => b.db - a.db);
    if (candidates[0]) return candidates[0].offset;
  }
  return track.phraseBoundaries.find((t) => t >= 0 && t <= maximum) ?? 0;
}

export function subtractMusicRanges(
  span: MusicRange,
  excluded: readonly MusicRange[],
): MusicRange[] {
  let spans = [span];
  for (const cut of excluded) {
    if (!range(cut)) throw new Error("Invalid silence or sponsor range.");
    spans = spans.flatMap((r) =>
      cut.end <= r.start || cut.start >= r.end
        ? [r]
        : [
            ...(cut.start > r.start ? [{ start: r.start, end: cut.start }] : []),
            ...(cut.end < r.end ? [{ start: cut.end, end: r.end }] : []),
          ],
    );
  }
  return spans;
}

export function planMusic(
  words: readonly TranscriptWord[],
  tracks: readonly MusicTrack[],
  baseDb = -22,
  exclusions: readonly MusicRange[] = [],
): MusicPlan {
  const chapters = musicChapters(words);
  const plan: MusicPlan = {
    version: 1,
    cues: [],
    silence: exclusions.map((r) => ({ ...r, reason: "Editor excluded / sponsor" })),
  };
  if (words[0] && words[0].start > 0)
    plan.silence.push({ start: 0, end: words[0].start, reason: "Silence before narration" });
  const used = new Set<string>();
  for (const chapter of chapters) {
    if (chapter.sponsor) {
      plan.silence.push({
        start: chapter.start,
        end: chapter.end,
        reason: "Sponsor audio only - verify boundaries",
      });
      continue;
    }
    const textTokens = new Set(chapter.text.toLowerCase().match(/[a-z]{4,}/g));
    const spans = subtractMusicRanges(chapter, exclusions);
    for (const span of spans) {
      const duration = span.end - span.start;
      const ranked = tracks
        .filter((t) => !used.has(t.path) && t.duration >= duration)
        .map((track) => {
          const hints =
            `${track.category} ${track.description} ${track.tags.join(" ")}`
              .toLowerCase()
              .match(/[a-z]{4,}/g) ?? [];
          const score = hints.reduce((n, token) => n + (textTokens.has(token) ? 1 : 0), 0);
          const sourceOffset = musicOffset(
            track,
            duration,
            chapter.beat === undefined ? undefined : chapter.beat - span.start,
          );
          const aligned =
            chapter.beat !== undefined &&
            track.rises.some(
              (r) =>
                r.db >= 3 && Math.abs(r.end - sourceOffset - (chapter.beat! - span.start)) < 0.01,
            );
          return {
            track: track.path,
            sourceOffset,
            score: score + (aligned ? 0.5 : 0),
            reason: `${track.description || `Category: ${track.category || "uncategorized"}; mood unverified`}. ${aligned ? "Measured rise aligned to narration pivot." : "Chapter bed from an energy phrase candidate; audition phrasing."}`,
          };
        })
        .sort((a, b) => b.score - a.score || a.track.localeCompare(b.track));
      const chosen = ranked[0];
      if (!chosen) {
        plan.silence.push({ ...span, reason: "Deliberate silence: no unused track long enough" });
        continue;
      }
      used.add(chosen.track);
      plan.cues.push({
        ...span,
        id: `music-${plan.cues.length + 1}`,
        chapter: chapter.title,
        track: chosen.track,
        sourceOffset: chosen.sourceOffset,
        reason: chosen.reason,
        fadeIn: Math.min(1, duration / 4),
        fadeOut: Math.min(1.5, duration / 4),
        baseDb,
        enabled: true,
        alternatives: ranked
          .slice(1, 4)
          .map(({ track, sourceOffset, reason }) => ({ track, sourceOffset, reason })),
      });
    }
  }
  return validateMusicPlan(plan);
}

export function validateMusicPlan(value: unknown): MusicPlan {
  if (!value || typeof value !== "object") throw new Error("Expected a music plan.");
  const plan = value as MusicPlan;
  if (
    plan.version !== 1 ||
    !Array.isArray(plan.cues) ||
    plan.cues.length > 200 ||
    !Array.isArray(plan.silence) ||
    plan.silence.length > 500
  )
    throw new Error("Invalid music plan size or version.");
  const ids = new Set<string>();
  const paths = new Set<string>();
  const active = [];
  for (const c of plan.cues) {
    if (
      !c ||
      !range(c) ||
      typeof c.id !== "string" ||
      !c.id ||
      ids.has(c.id) ||
      typeof c.track !== "string" ||
      !c.track ||
      c.track.length > 32768 ||
      typeof c.chapter !== "string" ||
      typeof c.reason !== "string" ||
      c.reason.length > 2000 ||
      typeof c.enabled !== "boolean" ||
      !finite(c.sourceOffset) ||
      c.sourceOffset < 0 ||
      !finite(c.baseDb) ||
      c.baseDb < -60 ||
      c.baseDb > 0 ||
      !finite(c.fadeIn) ||
      !finite(c.fadeOut) ||
      c.fadeIn < 0 ||
      c.fadeOut < 0 ||
      c.fadeIn + c.fadeOut > c.end - c.start ||
      !Array.isArray(c.alternatives) ||
      c.alternatives.length > 3
    )
      throw new Error("Invalid music cue.");
    for (const a of c.alternatives)
      if (
        !a ||
        typeof a.track !== "string" ||
        !a.track ||
        !finite(a.sourceOffset) ||
        a.sourceOffset < 0 ||
        typeof a.reason !== "string"
      )
        throw new Error("Invalid music alternative.");
    ids.add(c.id);
    if (c.enabled) {
      const key = c.track.replaceAll("\\", "/").toLowerCase();
      if (paths.has(key)) throw new Error("A track repeats. Choose another cue or disable it.");
      paths.add(key);
      active.push(c);
    }
  }
  active.sort((a, b) => a.start - b.start);
  for (let i = 1; i < active.length; i++)
    if (active[i]!.start < active[i - 1]!.end)
      throw new Error("Music cues overlap. Nudge or shorten the preceding cue.");
  for (const s of plan.silence)
    if (
      !s ||
      !range(s) ||
      typeof s.reason !== "string" ||
      active.some((c) => c.start < s.end && c.end > s.start)
    )
      throw new Error("A cue crosses a silence or sponsor range.");
  return plan;
}

export function mergeMusicSpeech(words: readonly MusicRange[], gap: number): MusicRange[] {
  const output: MusicRange[] = [];
  for (const w of [...words].sort((a, b) => a.start - b.start)) {
    if (!range(w)) throw new Error("Invalid speech timing.");
    const previous = output.at(-1);
    if (previous && w.start - previous.end <= gap) previous.end = Math.max(previous.end, w.end);
    else output.push({ start: w.start, end: w.end });
  }
  return output;
}

/** Relative cue times; host converts these to source-media Time objects. */
export function musicKeyframes(cue: MusicCue, speech: readonly MusicRange[], mix: MusicMix) {
  if (
    !finite(mix.duckDb) ||
    mix.duckDb > 0 ||
    mix.duckDb < -60 ||
    !finite(mix.attack) ||
    mix.attack < 0 ||
    mix.attack > 10 ||
    !finite(mix.release) ||
    mix.release < 0 ||
    mix.release > 10 ||
    !finite(mix.mergeGap) ||
    mix.mergeGap < 0 ||
    mix.mergeGap > 10
  )
    throw new Error("Invalid duck settings.");
  const duration = cue.end - cue.start;
  // Two keys one audio sample apart represent a zero-duration edge without
  // interpolating from the previous distant key across the whole silent gap.
  const attack = Math.max(1 / 48000, mix.attack);
  const release = Math.max(1 / 48000, mix.release);
  const regions = mergeMusicSpeech(speech, Math.max(mix.mergeGap, attack + release)).filter(
    (r) => r.end + release > cue.start && r.start - attack < cue.end,
  );
  const points = new Set([0, duration, cue.fadeIn, duration - cue.fadeOut]);
  for (const r of regions)
    for (const t of [r.start - attack, r.start, r.end, r.end + release])
      points.add(Math.max(0, Math.min(duration, t - cue.start)));
  return [...points]
    .sort((a, b) => a - b)
    .map((time) => {
      const absolute = cue.start + time;
      let duck = 0;
      for (const r of regions) {
        const factor =
          absolute < r.start
            ? 1 - (r.start - absolute) / attack
            : absolute > r.end
              ? 1 - (absolute - r.end) / release
              : 1;
        duck = Math.min(duck, mix.duckDb * Math.max(0, Math.min(1, factor)));
      }
      const fade = Math.min(
        cue.fadeIn ? time / cue.fadeIn : 1,
        cue.fadeOut ? (duration - time) / cue.fadeOut : 1,
        1,
      );
      return { time, value: Math.pow(10, (cue.baseDb + duck) / 20) * Math.max(0, fade) };
    });
}
