import type { TranscriptWord } from "./sequenceTranscript";

export interface CaptionOptions {
  maxCharacters: number;
  maxLines: 1 | 2;
  minDuration: number;
  maxDuration: number;
  pause: number;
  wordsPerCue: number | null;
  case: "as-is" | "upper" | "lower";
  stripPunctuation: boolean;
}

export interface CaptionCue {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export const youtubeCaptions: Readonly<CaptionOptions> = Object.freeze({
  maxCharacters: 32,
  maxLines: 2,
  minDuration: 0.8,
  maxDuration: 6,
  pause: 0.6,
  wordsPerCue: null,
  case: "as-is",
  stripPunctuation: false,
});
export const shortsCaptions: Readonly<CaptionOptions> = Object.freeze({
  ...youtubeCaptions,
  maxLines: 1,
  wordsPerCue: 3,
});

const length = (text: string) => Array.from(text).length;
const sentence = (text: string) =>
  /[.!?…。！？]["'’”\])]*$/.test(text) && !/\b(?:Mr|Mrs|Ms|Dr|Prof|St|vs|etc)\.$/i.test(text);
const dependent =
  /^(?:a|an|the|of|to|in|on|at|for|with|and|or|but|if|is|are|was|were|my|your|our|their)$/i;
function boundary(left: string, right: string, pause = 0): number {
  if (sentence(left)) return 100;
  if (pause >= 0.3) return 70;
  if (/[,;:]["'’”\])]*$/.test(left)) return 50;
  if (/^(?:and|but|because|although|while)\b/i.test(right)) return 25;
  return dependent.test(left) ? -30 : 0;
}

/** Wrap only between words. A single oversized word stays intact. */
function wrap(tokens: readonly string[], options: CaptionOptions): string[] | null {
  const whole = tokens.join(" ");
  if (length(whole) <= options.maxCharacters || tokens.length === 1) return [whole];
  if (options.maxLines === 1) return null;
  let best: { lines: string[]; score: number } | null = null;
  for (let i = 1; i < tokens.length; i++) {
    const lines = [tokens.slice(0, i).join(" "), tokens.slice(i).join(" ")];
    if (lines.some((line) => length(line) > options.maxCharacters)) continue;
    const score =
      boundary(tokens[i - 1]!, tokens[i]!) - Math.abs(length(lines[0]!) - length(lines[1]!));
    if (!best || score > best.score) best = { lines, score };
  }
  return best?.lines ?? null;
}

/** Sequence seconds stay absolute, including gaps. Minimum duration is a target:
 * dense speech must not overlap the next cue. Oversized words remain unsplit. */
export function segmentCaptions(
  words: readonly TranscriptWord[],
  overrides: Partial<CaptionOptions> = {},
): CaptionCue[] {
  const options = { ...youtubeCaptions, ...overrides };
  if (
    !Number.isInteger(options.maxCharacters) ||
    options.maxCharacters < 1 ||
    options.maxCharacters > 120 ||
    ![1, 2].includes(options.maxLines) ||
    !Number.isFinite(options.minDuration) ||
    !Number.isFinite(options.maxDuration) ||
    options.minDuration < 0.8 ||
    options.maxDuration > 6 ||
    options.minDuration > options.maxDuration ||
    !Number.isFinite(options.pause) ||
    options.pause < 0 ||
    options.pause > 10 ||
    (options.wordsPerCue !== null &&
      (!Number.isInteger(options.wordsPerCue) ||
        options.wordsPerCue < 1 ||
        options.wordsPerCue > 3)) ||
    !["as-is", "upper", "lower"].includes(options.case) ||
    typeof options.stripPunctuation !== "boolean"
  )
    throw new Error("Invalid caption options.");
  let previous = -1;
  const normalized = words
    .map((word) => {
      if (
        !Number.isFinite(word.start) ||
        !Number.isFinite(word.end) ||
        word.start < 0 ||
        word.end <= word.start ||
        word.start < previous
      )
        throw new Error("Captions require ordered, positive word timings.");
      previous = word.start;
      let text = word.text.replace(/\s+/g, " ").trim();
      if (options.stripPunctuation) text = text.replace(/\p{P}/gu, "");
      if (options.case === "upper") text = text.toUpperCase();
      if (options.case === "lower") text = text.toLowerCase();
      const start = Math.round(word.start * 1000) / 1000;
      return {
        ...word,
        start,
        end: Math.max(start + 0.001, Math.round(word.end * 1000) / 1000),
        text,
        original: word.text,
      };
    })
    .filter((word) => word.text);
  const prepared: typeof normalized = [];
  for (const word of normalized) {
    const last = prepared.at(-1);
    // Overlapping speakers can share the exact same start. Keep their text in
    // one cue rather than emit a zero-length cue or silently lose a word.
    if (last?.start === word.start) {
      prepared[prepared.length - 1] = {
        ...last,
        text: `${last.text} ${word.text}`,
        original: `${last.original} ${word.original}`,
        end: Math.max(last.end, word.end),
      };
    } else prepared.push(word);
  }
  const cues: CaptionCue[] = [];
  for (let from = 0; from < prepared.length;) {
    let to = from + 1;
    let preferred = to;
    let bestScore = -Infinity;
    while (to <= prepared.length) {
      const last = prepared[to - 1]!;
      const next = prepared[to];
      const gap = next ? next.start - last.end : 0;
      const score = next ? boundary(last.original, next.original, gap) : 100;
      if (score >= bestScore) {
        preferred = to;
        bestScore = score;
      }
      if (!next || gap >= options.pause || sentence(last.original)) break;
      const candidate = prepared.slice(from, to + 1);
      if (
        (options.wordsPerCue !== null && candidate.length > options.wordsPerCue) ||
        next.end - prepared[from]!.start > options.maxDuration ||
        !wrap(
          candidate.map((word) => word.text),
          options,
        )
      ) {
        // Backtrack to a nearby phrase boundary rather than leave a dangling article.
        if (options.wordsPerCue === null && preferred > from && preferred >= to - 3) to = preferred;
        break;
      }
      to++;
    }
    const first = prepared[from]!;
    const last = prepared[to - 1]!;
    const next = prepared[to];
    const end = Math.min(
      first.start + options.maxDuration,
      Math.max(last.end, first.start + options.minDuration),
      next?.start ?? Infinity,
    );
    // Simultaneous words belong together where possible; an unavoidable overlap
    // is clipped at the next cue so exported tracks never stack captions.
    if (end > first.start)
      cues.push({
        start: first.start,
        end,
        text: wrap(
          prepared.slice(from, to).map((word) => word.text),
          options,
        )!.join("\n"),
      });
    from = to;
  }
  return cues;
}

export function captionTimestamp(seconds: number, separator = ","): string {
  if (!Number.isFinite(seconds) || seconds < 0) throw new Error("Invalid caption time.");
  const ms = Math.round(seconds * 1000);
  const pad = (value: number, size = 2) => String(value).padStart(size, "0");
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}${separator}${pad(ms % 1000, 3)}`;
}

export function exportSrt(cues: readonly CaptionCue[]): string {
  return cues
    .map(
      (cue, i) =>
        `${i + 1}\n${captionTimestamp(cue.start)} --> ${captionTimestamp(cue.end)}\n${cue.text}\n`,
    )
    .join("\n");
}

export function exportWebVtt(cues: readonly CaptionCue[]): string {
  const escape = (text: string) =>
    text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `WEBVTT\n\n${cues.map((cue) => `${captionTimestamp(cue.start, ".")} --> ${captionTimestamp(cue.end, ".")}\n${escape(cue.text)}\n`).join("\n")}`;
}
