// Finds timestamps an assistant writes about the timeline: mm:ss, h:mm:ss,
// hh:mm:ss:ff (Premiere timecode, ";" for drop frame) and decimal seconds.
const TIMECODE =
  /(?<![\w:.])(\d{1,2}):([0-5]\d)(?::([0-5]\d))?(?:[:;](\d{2}))?(?:\.(\d{1,3}))?(?![\w:])/g;

export interface TimecodeMatch {
  readonly index: number;
  readonly text: string;
  /** Position in seconds; frame counts are converted with the sequence frame rate. */
  readonly seconds: (fps: number) => number;
}

export function findTimecodes(text: string): TimecodeMatch[] {
  const matches: TimecodeMatch[] = [];
  for (const match of text.matchAll(TIMECODE)) {
    const [whole, first, second, third, frames, fraction] = match;
    const a = Number(first);
    const b = Number(second);
    const fractionSeconds = fraction ? Number(`0.${fraction}`) : 0;
    // A frame count only follows a full hours:minutes:seconds timecode.
    if (frames !== undefined && third === undefined) continue;
    matches.push({
      index: match.index,
      text: whole,
      seconds:
        third === undefined
          ? () => a * 60 + b + fractionSeconds
          : (fps) =>
              a * 3600 +
              b * 60 +
              Number(third) +
              (frames !== undefined && fps > 0 ? Number(frames) / fps : 0) +
              fractionSeconds,
    });
  }
  return matches;
}
