import type { TranscriptWord } from "./sequenceTranscript";
import type { TimelineClip, TimelineSnapshot } from "./turnChanges";

export interface ClipSegment {
  readonly trackIndex: number;
  readonly clipName: string;
  readonly sequenceStart: number;
  readonly sequenceEnd: number;
  readonly sourceIn: number;
  readonly speed: number;
}

export interface VoiceLink {
  readonly trackIndex: number;
  readonly mediaName: string;
  readonly segments: readonly ClipSegment[];
}

export function mediaStem(name: string): string {
  let stem = name.replaceAll("\\", "/").split("/").at(-1)!.trim().toLowerCase();
  for (;;) {
    const next = stem.replace(
      /(?:[_.-](?:sentences|words|transcript|whisperx|aligned)|\.[a-z0-9]+)$/,
      "",
    );
    if (next === stem) return stem;
    stem = next;
  }
}

const clipMediaName = (clip: TimelineClip) => clip.projectItemName || clip.name;

function segmentFor(clip: TimelineClip, trackIndex: number): ClipSegment | null {
  const duration = clip.end - clip.start;
  const speed = (clip.outPoint - clip.inPoint) / duration;
  if (
    clip.enabled === false ||
    ![clip.start, clip.end, clip.inPoint, clip.outPoint, speed].every(Number.isFinite) ||
    clip.start < 0 ||
    clip.inPoint < 0 ||
    duration <= 0 ||
    speed <= 0
  )
    return null;
  return {
    trackIndex,
    clipName: clip.name,
    sequenceStart: clip.start,
    sequenceEnd: clip.end,
    sourceIn: clip.inPoint,
    speed,
  };
}

export function findVoiceLink(
  snapshot: TimelineSnapshot,
  transcriptName: string,
  preferredTrack?: number,
): VoiceLink | null {
  const stem = mediaStem(transcriptName);
  if (!stem) return null;
  const tracks = snapshot.audioTracks.flatMap((track) => {
    const matches = track.clips.flatMap((clip) => {
      const mediaName = clipMediaName(clip);
      const candidate = mediaStem(mediaName);
      if (
        !candidate ||
        !(
          candidate === stem ||
          (Math.min(candidate.length, stem.length) >= 8 &&
            (candidate.includes(stem) || stem.includes(candidate)))
        )
      )
        return [];
      const segment = segmentFor(clip, track.index);
      return segment ? [{ mediaName, segment }] : [];
    });
    if (!matches.length) return [];
    const durations = new Map<string, number>();
    for (const { mediaName, segment } of matches)
      durations.set(
        mediaName,
        (durations.get(mediaName) ?? 0) + segment.sequenceEnd - segment.sequenceStart,
      );
    return [
      {
        trackIndex: track.index,
        mediaName: [...durations].sort((a, b) => b[1] - a[1])[0]![0],
        segments: matches
          .map(({ segment }) => segment)
          .sort((a, b) => a.sequenceStart - b.sequenceStart),
        duration: [...durations.values()].reduce((sum, duration) => sum + duration, 0),
      },
    ];
  });
  const chosen =
    tracks.find((track) => track.trackIndex === preferredTrack) ??
    tracks.sort((a, b) => b.duration - a.duration)[0];
  return chosen
    ? { trackIndex: chosen.trackIndex, mediaName: chosen.mediaName, segments: chosen.segments }
    : null;
}

export function voiceCandidates(
  snapshot: TimelineSnapshot,
): { trackIndex: number; mediaName: string; duration: number }[] {
  return snapshot.audioTracks
    .flatMap((track) => {
      const durations = new Map<string, number>();
      for (const clip of track.clips) {
        const duration = clip.end - clip.start;
        const name = clipMediaName(clip);
        if (name && Number.isFinite(duration) && duration > 0)
          durations.set(name, (durations.get(name) ?? 0) + duration);
      }
      return [...durations].map(([mediaName, duration]) => ({
        trackIndex: track.index,
        mediaName,
        duration,
      }));
    })
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 50);
}

export function refreshVoiceLink(
  snapshot: TimelineSnapshot,
  link: Pick<VoiceLink, "trackIndex" | "mediaName">,
): VoiceLink | null {
  const segments = snapshot.audioTracks
    .filter((track) => track.index === link.trackIndex)
    .flatMap((track) =>
      track.clips.flatMap((clip) => {
        if (clipMediaName(clip) !== link.mediaName) return [];
        const segment = segmentFor(clip, track.index);
        return segment ? [segment] : [];
      }),
    )
    .sort((a, b) => a.sequenceStart - b.sequenceStart);
  return segments.length
    ? { trackIndex: link.trackIndex, mediaName: link.mediaName, segments }
    : null;
}

export interface PlacedWord extends TranscriptWord {
  readonly sourceIndex: number;
}

function validSegment(segment: ClipSegment): boolean {
  return (
    [segment.sequenceStart, segment.sequenceEnd, segment.sourceIn, segment.speed].every(
      Number.isFinite,
    ) &&
    segment.sequenceStart >= 0 &&
    segment.sequenceEnd > segment.sequenceStart &&
    segment.sourceIn >= 0 &&
    segment.speed > 0
  );
}

export function placeWords(
  words: readonly TranscriptWord[],
  segments: readonly ClipSegment[],
): PlacedWord[] {
  const mapped: PlacedWord[] = [];
  for (const segment of segments) {
    if (!validSegment(segment)) continue;
    const sourceEnd =
      segment.sourceIn + (segment.sequenceEnd - segment.sequenceStart) * segment.speed;
    words.forEach((word, sourceIndex) => {
      const midpoint = word.start + (word.end - word.start) / 2;
      if (midpoint < segment.sourceIn || midpoint >= sourceEnd) return;
      const start =
        segment.sequenceStart +
        (Math.max(word.start, segment.sourceIn) - segment.sourceIn) / segment.speed;
      const end = Math.min(
        segment.sequenceEnd,
        segment.sequenceStart + (Math.min(word.end, sourceEnd) - segment.sourceIn) / segment.speed,
      );
      if (Number.isFinite(start) && Number.isFinite(end) && end > start)
        mapped.push({ ...word, start, end, sourceIndex });
    });
  }
  mapped.sort((a, b) => a.start - b.start);
  const placed: PlacedWord[] = [];
  for (const word of mapped) {
    // Later starts own an overlap, including words from overlapping timeline segments.
    while (placed.length) {
      const previous = placed.at(-1)!;
      if (previous.end <= word.start) break;
      if (previous.start < word.start) {
        placed[placed.length - 1] = { ...previous, end: word.start };
        break;
      }
      placed.pop();
    }
    placed.push(word);
  }
  return placed;
}

export function sequenceToSource(seconds: number, segments: readonly ClipSegment[]): number | null {
  if (!Number.isFinite(seconds)) return null;
  const segment = segments.find(
    (candidate) =>
      validSegment(candidate) &&
      seconds >= candidate.sequenceStart &&
      seconds < candidate.sequenceEnd,
  );
  return segment ? segment.sourceIn + (seconds - segment.sequenceStart) * segment.speed : null;
}

const validFps = (fps: number) => Number.isFinite(fps) && fps > 0;
const frameEpsilon = 1e-6;

function lastStartBefore(
  words: readonly TranscriptWord[],
  seconds: number,
  inclusive: boolean,
): number {
  let low = 0;
  let high = words.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (inclusive ? words[middle]!.start <= seconds : words[middle]!.start < seconds)
      low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

// Imported words can have nested overlaps. Interval maxima keep even silence lookups logarithmic.
const wordEndIndexes = new WeakMap<
  readonly TranscriptWord[],
  { offset: number; ends: Float64Array }
>();

function lastIntersectingWord(
  words: readonly TranscriptWord[],
  before: number,
  after: number,
): number {
  let index = wordEndIndexes.get(words);
  if (!index) {
    const offset = 2 ** Math.ceil(Math.log2(words.length));
    const ends = new Float64Array(offset * 2);
    words.forEach((word, i) => {
      ends[offset + i] = word.end;
    });
    for (let i = offset - 1; i > 0; i--) ends[i] = Math.max(ends[i * 2]!, ends[i * 2 + 1]!);
    index = { offset, ends };
    wordEndIndexes.set(words, index);
  }
  const { offset, ends } = index;
  const search = (node: number, start: number, end: number): number => {
    if (start > before || ends[node]! <= after) return -1;
    if (end - start === 1) return start;
    const middle = (start + end) >>> 1;
    const right = search(node * 2 + 1, middle, end);
    return right >= 0 ? right : search(node * 2, start, middle);
  };
  return search(1, 0, offset);
}

export function wordAtTime(words: readonly TranscriptWord[], seconds: number, fps: number): number {
  if (!Number.isFinite(seconds) || seconds < 0 || !validFps(fps)) return -1;
  // Recover exact frame boundaries after floating-point seconds-to-frame conversion.
  const frame = Math.floor(seconds * fps + 1e-9);
  const frameStart = frame / fps;
  const frameEnd = (frame + 1) / fps;
  const index = lastStartBefore(words, frameEnd - frameEpsilon, false);
  if (index < 0) return -1;
  if (words[index]!.end > frameStart + frameEpsilon) return index;
  return lastIntersectingWord(words, index, frameStart + frameEpsilon);
}

export function lastWordBefore(
  words: readonly TranscriptWord[],
  seconds: number,
  fps: number,
): number {
  if (!Number.isFinite(seconds) || !validFps(fps)) return -1;
  return lastStartBefore(words, seconds + 0.5 / fps, true);
}

export function seekTime(start: number, fps: number): number {
  if (!Number.isFinite(start) || !validFps(fps)) return start;
  return Math.max(0, Math.ceil((start - frameEpsilon) * fps)) / fps;
}

export class PlayheadClock {
  private latest: { seconds: number; atMs: number } | null = null;
  private lastReadId = -1;
  private isPlaying = false;
  private playbackRate = 1;
  private readonly maxExtrapolation: number;
  private readonly latency: number;

  constructor(options?: { maxExtrapolation?: number; latency?: number }) {
    this.maxExtrapolation = options?.maxExtrapolation ?? 0.4;
    this.latency = options?.latency ?? 0.05;
  }

  sample(seconds: number, atMs: number, readId?: number): void {
    if (!Number.isFinite(seconds) || seconds < 0 || !Number.isFinite(atMs)) return;
    if (readId !== undefined) {
      if (!Number.isSafeInteger(readId) || readId <= this.lastReadId) return;
      this.lastReadId = readId;
    }
    const previous = this.latest;
    this.latest = { seconds, atMs };
    const advance = previous ? seconds - previous.seconds : 0;
    const elapsed = previous ? (atMs - previous.atMs) / 1000 : 0;
    const rate = elapsed > 0 ? advance / elapsed : 0;
    if (advance > 0 && advance <= 1 && rate >= 0.25 - 1e-9 && rate <= 4 + 1e-9) {
      const boundedRate = Math.max(0.25, Math.min(4, rate));
      this.playbackRate = this.isPlaying
        ? this.playbackRate * 0.75 + boundedRate * 0.25
        : boundedRate;
      this.isPlaying = true;
    } else {
      this.isPlaying = false;
      this.playbackRate = 1;
    }
  }

  now(nowMs: number): number {
    if (!this.latest) return 0;
    if (!this.isPlaying) return this.latest.seconds;
    const elapsed = Math.max(0, (nowMs - this.latest.atMs) / 1000);
    return (
      this.latest.seconds +
      Math.min(this.maxExtrapolation, this.playbackRate * elapsed + this.latency)
    );
  }

  get playing(): boolean {
    return this.isPlaying;
  }
  get rate(): number {
    return this.playbackRate;
  }
}
