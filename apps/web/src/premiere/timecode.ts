// Finds timestamps an assistant writes about the timeline: mm:ss, h:mm:ss,
// hh:mm:ss:ff (Premiere timecode, ";" for drop frame) and decimal seconds.
const TIMECODE =
  /(?<![\w:.])(\d{1,2}):([0-5]\d)(?::([0-5]\d))?(?:([:;])(\d{2}))?(?:\.(\d{1,3}))?(?![\w:])/g;

export interface TimecodeMatch {
  readonly index: number;
  readonly text: string;
  /**
   * Position in seconds; frame counts are converted with the sequence frame
   * rate. NaN when the frame field cannot exist at that rate.
   */
  readonly seconds: (fps: number) => number;
}

/**
 * Premiere timecode to seconds. Frames count at the whole rate (30 for 29.97).
 * Drop frame (";") skips frames 0-1 (0-3 at 59.94) each minute but every tenth.
 * NaN for a frame number the rate cannot have.
 */
export function timecodeSeconds(
  hours: number,
  minutes: number,
  seconds: number,
  frames: number,
  fps: number,
  dropFrame = false,
): number {
  if (!Number.isFinite(fps) || fps <= 0) return Number.NaN;
  const nominal = Math.round(fps);
  if (frames >= nominal) return Number.NaN;
  let index = ((hours * 60 + minutes) * 60 + seconds) * nominal + frames;
  const ntsc = Math.abs((fps * 1001) / 1000 - nominal) < 0.01;
  if (dropFrame && ntsc && nominal % 30 === 0) {
    const skipped = nominal / 15;
    if (seconds === 0 && frames < skipped && minutes % 10 !== 0) return Number.NaN;
    const totalMinutes = hours * 60 + minutes;
    index -= skipped * (totalMinutes - Math.floor(totalMinutes / 10));
  }
  return index / fps;
}

export function findTimecodes(text: string): TimecodeMatch[] {
  const matches: TimecodeMatch[] = [];
  for (const match of text.matchAll(TIMECODE)) {
    const [whole, first, second, third, separator, frames, fraction] = match;
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
          : frames === undefined
            ? () => a * 3600 + b * 60 + Number(third) + fractionSeconds
            : (fps) =>
                timecodeSeconds(a, b, Number(third), Number(frames), fps, separator === ";") +
                fractionSeconds,
    });
  }
  return matches;
}
