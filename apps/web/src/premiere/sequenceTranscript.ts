export interface TranscriptWord {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  /** Axis sequence mapping preserves clip boundaries even without a source-media link. */
  readonly clip?: number;
}

// Importers and a future transcription service share this sequence-relative format.
export interface SequenceTranscript {
  readonly source: string;
  readonly timing: "word" | "estimated";
  readonly offset: number;
  readonly words: readonly TranscriptWord[];
}

const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;
const time = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 8640000;

function validateWords(values: unknown): TranscriptWord[] {
  if (!Array.isArray(values) || !values.length || values.length > 100000)
    throw new Error("Expected 1-100,000 timestamped words.");
  let previous = -1;
  return values.map((value: unknown) => {
    if (
      !object(value) ||
      typeof value.text !== "string" ||
      !value.text.trim() ||
      value.text.length > 2000 ||
      !time(value.start) ||
      !time(value.end) ||
      value.end <= value.start ||
      value.start < previous
    )
      throw new Error("Every word needs text and ordered, positive start/end timestamps.");
    previous = value.start;
    return {
      text: value.text.trim(),
      start: value.start,
      end: value.end,
      ...(typeof value.clip === "number" && Number.isSafeInteger(value.clip) && value.clip >= 0
        ? { clip: value.clip }
        : {}),
    };
  });
}

/**
 * WhisperX leaves some tokens (often numbers) untimed and can emit zero-length
 * or slightly overlapping words; these get times from their neighbours.
 */
function fillWordTimes(rows: unknown[] | undefined): unknown[] | undefined {
  if (!rows) return rows;
  const words = rows.map((row) =>
    object(row) && typeof row.text === "string"
      ? { ...row, start: time(row.start) ? row.start : null, end: time(row.end) ? row.end : null }
      : row,
  ) as Array<{ text: string; start: number | null; end: number | null } | unknown>;
  const timed = (index: number, key: "start" | "end") => {
    const value = words[index];
    return object(value) && typeof value[key] === "number" ? (value[key] as number) : null;
  };
  let previousStart = 0;
  let previousEnd = 0;
  return words.map((value, index) => {
    if (!object(value) || typeof value.text !== "string") return value;
    let start = timed(index, "start");
    let end = timed(index, "end");
    if (start === null) start = previousEnd;
    if (end === null) {
      let next: number | null = null;
      for (let after = index + 1; after < words.length && next === null; after++)
        next = timed(after, "start");
      end = next !== null && next > start ? next : start + 0.1;
    }
    // Overlaps with the previous word are trimmed; truly out-of-order words are
    // left for validation to reject.
    if (start >= previousStart) start = Math.max(start, previousEnd);
    if (end <= start) end = start + 0.01;
    previousStart = start;
    previousEnd = end;
    return { ...value, start, end };
  });
}

function cueTime(value: string): number {
  const match = /^(?:(\d{2,}):)?([0-5]\d):([0-5]\d)[.,](\d{3})$/.exec(value);
  if (!match) throw new Error(`Invalid subtitle timestamp: ${value}`);
  return (
    Number(match[1] ?? 0) * 3600 +
    Number(match[2]) * 60 +
    Number(match[3]) +
    Number(match[4]) / 1000
  );
}

function subtitleWords(input: string): TranscriptWord[] {
  const words: TranscriptWord[] = [];
  for (const block of input
    .replace(/^\uFEFF/, "")
    .replace(/\r/g, "")
    .trim()
    .split(/\n\s*\n/)) {
    if (/^(WEBVTT(?:\s|$)|NOTE(?:\s|$)|STYLE(?:\s|$)|REGION(?:\s|$))/.test(block)) continue;
    const lines = block.split("\n");
    const index = lines.findIndex((line) => line.includes("-->"));
    if (index < 0) throw new Error("A subtitle cue is missing its timestamp range.");
    const range = /^(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(lines[index]!.trim());
    if (!range) throw new Error("Invalid subtitle timestamp range.");
    const start = cueTime(range[1]!);
    const end = cueTime(range[2]!);
    const text = lines
      .slice(index + 1)
      .join(" ")
      .replace(/<[^>]*>/g, "")
      .replace(
        /&(?:amp|lt|gt|quot|apos|nbsp);/g,
        (entity) =>
          ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " " })[
            entity
          ]!,
      );
    const parts = text.trim().split(/\s+/).filter(Boolean);
    if (!parts.length || end <= start)
      throw new Error("Subtitle cues need text and a positive duration.");
    parts.forEach((part, i) =>
      words.push({
        text: part,
        start: start + ((end - start) * i) / parts.length,
        end: start + ((end - start) * (i + 1)) / parts.length,
      }),
    );
  }
  return validateWords(words);
}

export function parseTranscript(input: string, filename: string): SequenceTranscript {
  if (input.length > 10000000) throw new Error("Choose a transcript smaller than 10 MB.");
  const trimmed = input.trimStart();
  if (/\.json$/i.test(filename) || trimmed.startsWith("{") || trimmed.startsWith("[")) {
    let data: unknown;
    try {
      data = JSON.parse(input.replace(/^\uFEFF/, ""));
    } catch {
      throw new Error("Invalid JSON. Export WhisperX JSON with word timestamps.");
    }
    const rows = Array.isArray(data)
      ? data
      : object(data) && Array.isArray(data.word_segments)
        ? data.word_segments
        : object(data) && (Array.isArray(data.segments) || Array.isArray(data.sentences))
          ? ((data.segments ?? data.sentences) as unknown[]).flatMap((segment: unknown) =>
              object(segment) && Array.isArray(segment.words) ? segment.words : [null],
            )
          : object(data) && Array.isArray(data.words)
            ? data.words
            : null;
    const words = validateWords(
      fillWordTimes(
        rows?.map((row: unknown) =>
          object(row)
            ? { text: row.word ?? row.text, start: row.start, end: row.end, clip: row.clip }
            : row,
        ),
      ),
    );
    return { source: `WhisperX JSON · ${filename}`, timing: "word", offset: 0, words };
  }
  return {
    source: `${/^\s*\uFEFF?WEBVTT/.test(input) || /\.vtt$/i.test(filename) ? "VTT" : "SRT"} · ${filename}`,
    timing: "estimated",
    offset: 0,
    words: subtitleWords(input),
  };
}

export function parseStoredTranscript(value: unknown): SequenceTranscript | null {
  if (
    !object(value) ||
    typeof value.source !== "string" ||
    value.source.length > 2048 ||
    (value.timing !== "word" && value.timing !== "estimated") ||
    typeof value.offset !== "number" ||
    !Number.isFinite(value.offset)
  )
    return null;
  try {
    return {
      source: value.source,
      timing: value.timing,
      offset: value.offset,
      words:
        Array.isArray(value.words) && value.words.length === 0 ? [] : validateWords(value.words),
    };
  } catch {
    return null;
  }
}

export function mapTranscript(words: readonly TranscriptWord[], offset: number): TranscriptWord[] {
  if (!Number.isFinite(offset)) throw new Error("Enter a finite sequence offset.");
  if (!words.length) return [];
  return validateWords(
    words.map((word) => ({ ...word, start: word.start + offset, end: word.end + offset })),
  );
}

export function selectionRange(
  words: readonly TranscriptWord[],
  anchor: number,
  focus: number,
  fps: number,
) {
  if (
    !Number.isInteger(anchor) ||
    !Number.isInteger(focus) ||
    anchor < 0 ||
    focus < 0 ||
    anchor >= words.length ||
    focus >= words.length ||
    !Number.isFinite(fps) ||
    fps <= 0
  )
    return null;
  const first = Math.min(anchor, focus);
  const last = Math.max(anchor, focus);
  const selected = words.slice(first, last + 1);
  const start = Math.max(
    0,
    Math.floor(selected.reduce((min, word) => Math.min(min, word.start), Infinity) * fps + 1e-7) /
      fps,
  );
  const end =
    Math.ceil(selected.reduce((max, word) => Math.max(max, word.end), 0) * fps - 1e-7) / fps;
  return { first, last, start, end, text: selected.map((word) => word.text).join(" ") };
}

export function precedingWord(words: readonly TranscriptWord[], seconds: number): number {
  let low = 0;
  let high = words.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (words[middle]!.start <= seconds) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

export function activeWord(words: readonly TranscriptWord[], seconds: number): number {
  const index = precedingWord(words, seconds);
  return index >= 0 && words[index]!.end > seconds ? index : -1;
}

export function rippleTranscript(
  doc: SequenceTranscript,
  start: number,
  end: number,
): SequenceTranscript {
  return {
    ...doc,
    words: doc.words
      .filter((word) => word.end <= start || word.start >= end)
      .map((word) =>
        word.start >= end
          ? { ...word, start: word.start - (end - start), end: word.end - (end - start) }
          : word,
      ),
  };
}

export function transcriptTime(seconds: number): string {
  const ms = Math.round(seconds * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}`;
}

export function transcriptContext(
  doc: SequenceTranscript,
  range: NonNullable<ReturnType<typeof selectionRange>>,
  sequenceName: string,
): string {
  return `Transcript from ${JSON.stringify(sequenceName)} [${transcriptTime(range.start)} - ${transcriptTime(range.end)}] (${doc.source}):\n> ${range.text.replace(/\n/g, "\n> ")}`;
}
