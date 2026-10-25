import type { TranscriptWord } from "./sequenceTranscript";
import type { TimelineSnapshot } from "./turnChanges";

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
  peakDbfs?: number;
  catalogueEnergy?: number;
  brightness?: number;
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
  sectionId?: string;
  chapter: string;
  theme?: string;
  mood?: string;
  energy?: number;
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
  requestId?: string;
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
  baseDb: 0,
  duckDb: 0,
  attack: 0.25,
  release: 0.6,
  mergeGap: 0.85,
};
export const musicPeakTargetDbfs = -33;
export function musicLevel(track: MusicTrack): number {
  if (track.peakDbfs === undefined || !Number.isFinite(track.peakDbfs))
    throw new Error("Reindex the library to measure each song's peak before placing music.");
  return Math.min(15, musicPeakTargetDbfs - track.peakDbfs);
}
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
    // Subject pivots and script breaks are evidence. Elapsed time alone is not.
    const subject =
      /^(?:next(?: up)?[,.:]?|moving on to|turning to|as for|now (?:for|let's (?:talk|look)|we (?:turn|move)))\b/i.test(
        nextText,
      );
    const scriptBreak = !!next && (next.start - word.end >= 2.5 || /\n\s*\n/.test(next.text));
    if (!next || boundary || ((subject || scriptBreak) && /[.!?]$/.test(word.text))) {
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
  return 0;
}

export const musicPathKey = (path: string) => path.replaceAll("\\", "/").toLowerCase();

const moods = {
  sad: /sad|grief|loss|tragic|melanchol|sorrow|death|mourn|heartbreak/gi,
  hype: /hype|fight|battle|epic|power|victory|furious|phonk|action|intense/gi,
  tense: /dark|cinematic|sinister|ominous|tense|tension|danger|threat|dread|suspense/gi,
  calm: /calm|reflect|peace|gentle|lofi|relax|quiet|hope/gi,
  mysterious: /myster|unknown|secret|eerie|enigmatic/gi,
  comedic: /comedy|comedic|funny|joke|playful|silly/gi,
};

/** Local shortlist only. The chat agent reads the script for subject and emotional context. */
export function musicMood(text: string): { mood: string; energy: number } {
  const ranked = Object.entries(moods)
    .map(([mood, pattern]) => ({
      mood,
      score: (text.match(pattern) ?? []).length,
    }))
    .sort((a, b) => b.score - a.score);
  const mood = ranked[0]?.score ? ranked[0].mood : "calm";
  return { mood, energy: mood === "hype" ? 0.9 : mood === "tense" ? 0.65 : 0.3 };
}

export function matchingMusic(
  mood: string,
  energy: number,
  duration: number,
  tracks: readonly MusicTrack[],
  excluded: readonly string[] = [],
) {
  const blocked = new Set(excluded.map(musicPathKey));
  const candidates = tracks.filter(
    (t) =>
      t.duration >= duration &&
      !blocked.has(musicPathKey(t.path)) &&
      !/00\. duplicate copies - review/i.test(t.path),
  );
  const sorted = candidates.filter((t) => !/00\. unsorted - review/i.test(t.path));
  const folderMood = (category: string) =>
    /dark cinematic music/i.test(category)
      ? "tense"
      : /hype music/i.test(category)
        ? "hype"
        : /sad music/i.test(category)
          ? "sad"
          : /calm music/i.test(category)
            ? "calm"
            : null;
  const wanted = /dark|tense|myster|ominous|sinister/i.test(mood)
    ? "tense"
    : /hype|phonk/i.test(mood)
      ? "hype"
      : /sad|grief|loss/i.test(mood)
        ? "sad"
        : "calm";
  const matched = sorted.filter((t) => folderMood(t.category) === wanted);
  return (matched.length ? matched : sorted.length ? sorted : candidates)
    .map((track) => {
      const hints = `${track.description} ${track.tags.join(" ")} ${track.category}`;
      const match = musicMood(hints);
      const score =
        (folderMood(track.category) === wanted ? 100 : 0) +
        (match.mood === mood ? 10 : 0) +
        (hints.toLowerCase().includes(mood.toLowerCase()) ? 5 : 0) -
        Math.abs((track.catalogueEnergy ?? match.energy) - energy);
      return { track, score };
    })
    .sort((a, b) => b.score - a.score || a.track.path.localeCompare(b.track.path))
    .map(({ track }) => track);
}

export function chooseMusicTrack(snapshot: TimelineSnapshot, tracks: readonly MusicTrack[]) {
  if (snapshot.truncated) throw new Error("The timeline is too large to inspect safely.");
  const paths = new Set(tracks.map((t) => musicPathKey(t.path)));
  const existing = snapshot.audioTracks.find((t) =>
    t.clips.some((c) => c.mediaPath && paths.has(musicPathKey(c.mediaPath))),
  );
  if (existing) {
    if (existing.locked) throw new Error("Unlock the existing music track first.");
    return existing;
  }
  const empty = snapshot.audioTracks.find((t) => !t.locked && !t.clips.length);
  if (!empty) throw new Error("Add an empty audio track for music first.");
  return empty;
}

export function musicScope(
  snapshot: TimelineSnapshot,
  words: readonly TranscriptWord[],
  selection?: MusicRange | null,
): MusicRange {
  if (selection && range(selection)) return selection;
  if (
    snapshot.inPoint !== null &&
    snapshot.outPoint !== null &&
    snapshot.outPoint > snapshot.inPoint
  )
    return { start: snapshot.inPoint, end: snapshot.outPoint };
  return {
    start: 0,
    end: Math.max(
      words.at(-1)?.end ?? 0,
      ...snapshot.audioTracks.flatMap((t) => t.clips.map((c) => c.end)),
      ...snapshot.videoTracks.flatMap((t) => t.clips.map((c) => c.end)),
    ),
  };
}

/** The agent supplies a shared theme only for short subjects that belong together. */
export function mergeShortMusicSections(plan: MusicPlan): MusicPlan {
  const cues: MusicCue[] = [];
  let shortTheme = "";
  for (const cue of [...plan.cues].sort((a, b) => a.start - b.start)) {
    const previous = cues.at(-1);
    const theme = cue.enabled && cue.end - cue.start < 28 ? (cue.theme?.trim() ?? "") : "";
    if (
      theme &&
      theme === shortTheme &&
      previous &&
      previous.mood === cue.mood &&
      Math.abs(previous.end - cue.start) < 0.001
    ) {
      cues[cues.length - 1] = {
        ...previous,
        end: cue.end,
        chapter: theme,
        reason: `${previous.reason} ${cue.reason}`.slice(0, 2000),
      };
    } else cues.push({ ...cue });
    shortTheme = theme;
  }
  return { ...plan, cues };
}

/** Occupied intervals include all media, including disabled clips and SFX. */
export function fillMusicGaps(
  plan: MusicPlan,
  scope: MusicRange,
  occupied: readonly MusicRange[],
  fps = 30,
): MusicPlan {
  const frame = (seconds: number) => Math.round(seconds * fps) / fps;
  return validateMusicPlan({
    ...plan,
    cues: plan.cues
      .filter((c) => c.enabled)
      .sort((a, b) => a.start - b.start)
      .flatMap((cue) => {
        const span = { start: Math.max(cue.start, scope.start), end: Math.min(cue.end, scope.end) };
        if (span.end <= span.start) return [];
        return subtractMusicRanges(span, occupied)
          .map((gap) => ({
            start:
              gap.start === scope.start || occupied.some((c) => c.end === gap.start)
                ? Math.ceil((gap.start - 0.000001) * fps) / fps
                : frame(gap.start),
            end:
              gap.end === scope.end || occupied.some((c) => c.start === gap.end)
                ? Math.floor((gap.end + 0.000001) * fps) / fps
                : frame(gap.end),
          }))
          .filter((gap) => gap.end > gap.start)
          .map((gap, i) => ({
            ...cue,
            ...gap,
            id: `${cue.id}-gap-${i}`,
            sectionId: cue.id,
            sourceOffset: cue.sourceOffset,
            fadeIn: Math.min(0.75, (gap.end - gap.start) / 4),
            fadeOut: Math.min(0.75, (gap.end - gap.start) / 4),
          }));
      }),
  });
}

export function validateMusicCoverage(
  plan: MusicPlan,
  scope: MusicRange,
  occupied: readonly MusicRange[],
  fps: number,
) {
  if (!range(scope)) throw new Error("There is no sequence range to score.");
  const missing = subtractMusicRanges(scope, [...occupied, ...plan.silence, ...plan.cues]);
  if (missing.some((gap) => gap.end - gap.start > 1 / fps + 0.000001))
    throw new Error(
      "The music plan leaves unscored sections. Place music again to cover the full range.",
    );
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
  baseDb = 0,
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
  let previous = "";
  for (const chapter of chapters) {
    if (chapter.sponsor) {
      plan.silence.push({
        start: chapter.start,
        end: chapter.end,
        reason: "Sponsor audio only - verify boundaries",
      });
      continue;
    }
    const emotion = musicMood(chapter.text);
    const spans = subtractMusicRanges(chapter, exclusions);
    for (const span of spans) {
      const duration = span.end - span.start;
      const ranked = matchingMusic(emotion.mood, emotion.energy, duration, tracks, [previous]).map(
        (track) => {
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
            reason: `${track.description || `Category: ${track.category || "uncategorized"}; mood unverified`}. ${aligned ? "Measured rise aligned to narration pivot." : "Chapter bed from an energy phrase candidate; audition phrasing."}`,
          };
        },
      );
      const chosen = ranked[0];
      if (!chosen) {
        plan.silence.push({ ...span, reason: "No different matching track long enough" });
        continue;
      }
      previous = chosen.track;
      plan.cues.push({
        ...span,
        id: `music-${plan.cues.length + 1}`,
        chapter: chapter.title,
        ...emotion,
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
      (c.theme !== undefined && (typeof c.theme !== "string" || c.theme.length > 200)) ||
      (c.mood !== undefined && (typeof c.mood !== "string" || c.mood.length > 100)) ||
      (c.energy !== undefined && (!finite(c.energy) || c.energy < 0 || c.energy > 1)) ||
      typeof c.reason !== "string" ||
      c.reason.length > 2000 ||
      typeof c.enabled !== "boolean" ||
      !finite(c.sourceOffset) ||
      c.sourceOffset < 0 ||
      !finite(c.baseDb) ||
      c.baseDb < -60 ||
      c.baseDb > 15 ||
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
      active.push(c);
    }
  }
  active.sort((a, b) => a.start - b.start);
  for (let i = 1; i < active.length; i++) {
    if (active[i]!.start < active[i - 1]!.end)
      throw new Error("Music cues overlap. Nudge or shorten the preceding cue.");
    if (
      (!active[i]!.sectionId || active[i]!.sectionId !== active[i - 1]!.sectionId) &&
      Math.abs(active[i]!.start - active[i - 1]!.end) < 0.001 &&
      musicPathKey(active[i]!.track) === musicPathKey(active[i - 1]!.track)
    )
      throw new Error("Neighbouring sections need different songs.");
  }
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
  const regions = mergeMusicSpeech(
    mix.duckDb ? speech : [],
    Math.max(mix.mergeGap, attack + release),
  ).filter((r) => r.end + release > cue.start && r.start - attack < cue.end);
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
