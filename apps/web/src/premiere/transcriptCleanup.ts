import type { TranscriptWord } from "./sequenceTranscript";
import type { ClipSegment } from "./transcriptSync";

export interface CleanupSettings {
  readonly pauseThreshold: number;
  readonly padding: number;
  readonly fillers: readonly string[];
  readonly restartWindow: number;
}

export const defaultCleanupSettings: CleanupSettings = {
  pauseThreshold: 0.6,
  padding: 0.12,
  fillers: ["um", "uh", "erm", "like", "you know"],
  restartWindow: 5,
};

export const cleanupLabels = {
  silence: "Pauses",
  filler: "Filler words",
  repeat: "Repeated words / stutters",
  retake: "Restarted takes",
} as const;
export type CleanupType = keyof typeof cleanupLabels;
export interface CleanupRange {
  readonly start: number;
  readonly end: number;
}
export interface CleanupCut extends CleanupRange {
  readonly id: string;
  readonly type: CleanupType;
  readonly label: string;
}

const token = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
const sentenceEnd = (text: string) => /[.!?]["')\]]*$/.test(text);
const priority: Record<CleanupType, number> = { retake: 0, repeat: 1, filler: 2, silence: 3 };

/** Union cuts before summing or applying them, so overlapping suggestions never ripple twice. */
export function mergeCleanupRanges(ranges: readonly CleanupRange[]): CleanupRange[] {
  const result: CleanupRange[] = [];
  for (const range of [...ranges].sort((a, b) => a.start - b.start)) {
    if (
      !Number.isFinite(range.start) ||
      !Number.isFinite(range.end) ||
      range.start < 0 ||
      range.end <= range.start
    )
      throw new Error("Invalid cleanup range.");
    const previous = result.at(-1);
    if (previous && range.start <= previous.end) {
      result[result.length - 1] = { start: previous.start, end: Math.max(previous.end, range.end) };
    } else result.push({ start: range.start, end: range.end });
  }
  return result;
}

/**
 * All input/output times are SEQUENCE seconds. Place source words through clip segments first
 * (including speed). Treat each clip as a separate speech region: a timeline gap or edit is
 * not evidence of recorded silence or a restarted take. No audio/RMS dependency is required.
 */
export function detectTranscriptCleanup(
  words: readonly TranscriptWord[],
  settings: CleanupSettings = defaultCleanupSettings,
  fps = 30,
  segments?: readonly ClipSegment[],
): CleanupCut[] {
  if (
    ![fps, settings.pauseThreshold, settings.padding, settings.restartWindow].every(
      Number.isFinite,
    ) ||
    fps <= 0 ||
    fps > 240 ||
    settings.pauseThreshold < 0 ||
    settings.padding < 0 ||
    settings.restartWindow < 0 ||
    settings.restartWindow > 30 ||
    settings.fillers.length > 100
  )
    throw new Error("Invalid cleanup settings.");
  if (
    words.some(
      (word, i) =>
        !Number.isFinite(word.start) ||
        !Number.isFinite(word.end) ||
        word.start < 0 ||
        word.end <= word.start ||
        (i > 0 && word.start < words[i - 1]!.start),
    )
  )
    throw new Error("Cleanup needs ordered, positive word timings.");
  if (!words.length) return [];
  const phrases = settings.fillers
    .map((phrase) => phrase.trim().split(/\s+/).map(token).filter(Boolean))
    .filter((phrase) => phrase.length > 0 && phrase.length <= 10);
  const mappedRegions: Array<{ start: number; end: number; clip: number | undefined }> = [];
  for (const word of words) {
    const previous = mappedRegions.at(-1);
    if (previous && previous.clip === word.clip) previous.end = Math.max(previous.end, word.end);
    else mappedRegions.push({ start: word.start, end: word.end, clip: word.clip });
  }
  const regions = segments
    ? segments
        .filter(
          (segment) =>
            Number.isFinite(segment.sequenceStart) &&
            Number.isFinite(segment.sequenceEnd) &&
            segment.sequenceStart >= 0 &&
            segment.sequenceEnd > segment.sequenceStart,
        )
        .map((segment) => ({
          start: segment.sequenceStart,
          end: segment.sequenceEnd,
          clip: undefined,
        }))
    : mappedRegions;
  const proposals: CleanupCut[] = [];
  for (const region of regions) {
    const speech = words.filter(
      (word) =>
        word.start < region.end &&
        word.end > region.start &&
        (region.clip === undefined || word.clip === region.clip),
    );
    const normalized = speech.map((word) => token(word.text));
    const add = (start: number, end: number, type: CleanupType, label: string) => {
      // Round inward. Never remove a neighbouring spoken word or cross a clip boundary.
      const a = Math.max(0, Math.ceil((Math.max(start, region.start) - 1e-7) * fps) / fps);
      const b = Math.floor((Math.min(end, region.end) + 1e-7) * fps) / fps;
      if (b > a) proposals.push({ start: a, end: b, type, label, id: `${type}:${a}:${b}` });
    };
    let spokenEnd = region.start;
    for (const word of speech) {
      if (word.start - spokenEnd > settings.pauseThreshold + 1e-7)
        add(spokenEnd + settings.padding, word.start - settings.padding, "silence", "Pause");
      spokenEnd = Math.max(spokenEnd, word.end);
    }
    if (region.end - spokenEnd > settings.pauseThreshold + 1e-7)
      add(spokenEnd + settings.padding, region.end - settings.padding, "silence", "Pause");
    for (let i = 0; i < speech.length; i++) {
      const word = speech[i]!;
      for (const phrase of phrases) {
        const last = i + phrase.length - 1;
        if (last >= speech.length || !phrase.every((part, k) => part === normalized[i + k]))
          continue;
        if (
          speech
            .slice(i, last)
            .some((part, k) => sentenceEnd(part.text) || speech[i + k + 1]!.start - part.end > 0.6)
        )
          continue;
        // "I like this" and "looks like rain" carry meaning. Only propose hesitant/isolated
        // "like": punctuation on the token or a pause on BOTH sides. It remains reviewable.
        if (phrase.length === 1 && phrase[0] === "like") {
          const before = word.start - (speech[i - 1]?.end ?? region.start);
          const after = (speech[i + 1]?.start ?? region.end) - word.end;
          if (!/[,;:]$/.test(word.text) && !(before >= 0.25 && after >= 0.25)) continue;
        }
        add(
          word.start,
          speech[last]!.end,
          "filler",
          speech
            .slice(i, last + 1)
            .map((part) => part.text)
            .join(" "),
        );
      }
      const next = speech[i + 1];
      if (
        next &&
        next.start - word.end <= 0.8 &&
        !sentenceEnd(word.text) &&
        normalized[i] &&
        (normalized[i] === normalized[i + 1] ||
          (/[-\u2010]$/.test(word.text) && normalized[i + 1]!.startsWith(normalized[i]!)))
      )
        add(word.start, Math.min(word.end, next.start), "repeat", word.text);
      // A restart repeats at least two opening words within a bounded window. Prefer the
      // LAST occurrence, including chains of three takes; overlapping earlier takes merge.
      const opening =
        i === 0 || sentenceEnd(speech[i - 1]!.text) || word.start - speech[i - 1]!.end >= 0.25;
      if (!opening || !normalized[i] || i + 1 >= speech.length) continue;
      for (
        let j = i + 2;
        j + 1 < speech.length &&
        j < i + 80 &&
        speech[j]!.start - word.start <= settings.restartWindow;
        j++
      ) {
        if (normalized[j] !== normalized[i] || normalized[j + 1] !== normalized[i + 1]) continue;
        const boundary =
          sentenceEnd(speech[j - 1]!.text) ||
          speech[j]!.start - speech[j - 1]!.end >= 0.25 ||
          /[-,]$/.test(speech[j - 1]!.text);
        if (!boundary) continue;
        // Shared openings are common in finished narration. A completed sentence is
        // a retake only when the whole earlier text repeats, not just its first words.
        const earlier = speech.slice(i, j);
        if (
          earlier.some((part) => sentenceEnd(part.text)) &&
          (!earlier.every((_, k) => normalized[i + k] === normalized[j + k]) ||
            !sentenceEnd(speech[j + earlier.length - 1]?.text ?? ""))
        )
          continue;
        add(
          word.start,
          Math.min(
            speech[j]!.start,
            Math.max(speech[j - 1]!.end, speech[j]!.start - settings.padding),
          ),
          "retake",
          "Earlier take",
        );
      }
    }
  }
  // A restart often contains a filler or stutter. Present one proposal for the union so
  // rejecting it really keeps the entire take, and counts/time saved remain unambiguous.
  const result: CleanupCut[] = [];
  for (const cut of proposals.sort(
    (a, b) => a.start - b.start || priority[a.type] - priority[b.type],
  )) {
    const previous = result.at(-1);
    if (previous && cut.start < previous.end) {
      const owner = priority[previous.type] <= priority[cut.type] ? previous : cut;
      const end = Math.max(previous.end, cut.end);
      result[result.length - 1] = {
        ...owner,
        start: previous.start,
        end,
        id: `${owner.type}:${previous.start}:${end}`,
      };
    } else result.push(cut);
  }
  return result;
}
