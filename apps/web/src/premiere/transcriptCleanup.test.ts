import { describe, expect, it } from "vite-plus/test";
import {
  defaultCleanupSettings as defaults,
  detectTranscriptCleanup as detect,
  mergeCleanupRanges,
} from "./transcriptCleanup";
import type { TranscriptWord } from "./sequenceTranscript";
import { placeWords, type ClipSegment } from "./transcriptSync";

const speech = (text: string, step = 0.4): TranscriptWord[] =>
  text.split(" ").map((text, i) => ({ text, start: i * step, end: i * step + 0.2 }));
const segment = (start: number, end: number, sourceIn = 0, speed = 1): ClipSegment => ({
  sequenceStart: start,
  sequenceEnd: end,
  sourceIn,
  speed,
  trackIndex: 0,
  clipName: "VO.wav",
});

describe("transcript cleanup detection", () => {
  it("keeps 120 ms on either side of pauses over 600 ms and rounds inward to frames", () => {
    const cuts = detect(
      [
        { text: "one", start: 0, end: 0.5 },
        { text: "two", start: 1.5, end: 2 },
      ],
      defaults,
      25,
    );
    expect(cuts).toMatchObject([{ type: "silence", start: 0.64, end: 1.36 }]);
  });
  it("does not cut pauses equal to or shorter than the threshold", () => {
    expect(
      detect([
        { text: "one", start: 0, end: 0.5 },
        { text: "two", start: 1.1, end: 1.5 },
      ]),
    ).toEqual([]);
  });
  it("updates thresholds and padding, including zero padding and fully padded pauses", () => {
    const words = [
      { text: "one", start: 0, end: 0.5 },
      { text: "two", start: 1.5, end: 2 },
    ];
    expect(detect(words, { ...defaults, pauseThreshold: 2 })).toEqual([]);
    expect(detect(words, { ...defaults, padding: 0 }, 25)).toMatchObject([
      { start: 0.52, end: 1.48 },
    ]);
    expect(detect(words, { ...defaults, padding: 0.6 })).toEqual([]);
  });
  it("normalizes case and punctuation in editable filler phrases", () => {
    expect(detect(speech("Um, UH erm you know okay"))).toMatchObject([
      { type: "filler", label: "Um," },
      { type: "filler", label: "UH" },
      { type: "filler", label: "erm" },
      { type: "filler", label: "you know" },
    ]);
    expect(detect(speech("well okay"), { ...defaults, fillers: ["well"] })).toMatchObject([
      { label: "well" },
    ]);
    expect(detect(speech("um okay"), { ...defaults, fillers: [] })).toEqual([]);
  });
  it.each(["I like this", "looks like rain", "unlike this", "you knew that"])(
    "preserves meaningful speech: %s",
    (text) => {
      expect(detect(speech(text))).toEqual([]);
    },
  );
  it("only proposes hesitant like, including isolated pauses on both sides", () => {
    expect(detect(speech("I like, think"))).toMatchObject([{ type: "filler", label: "like," }]);
    expect(detect(speech("I like think", 0.5))).toMatchObject([{ type: "filler", label: "like" }]);
  });
  it("does not join filler phrases across sentence ends or long gaps", () => {
    expect(detect(speech("you. know"))).toEqual([]);
    expect(detect(speech("you know", 2)).every((cut) => cut.type === "silence")).toBe(true);
  });
  it("keeps the last repeated word and identifies partial-word stutters", () => {
    expect(detect(speech("I I I think"))).toMatchObject([
      { type: "repeat", start: 0 },
      { type: "repeat", start: 0.4 },
    ]);
    expect(detect(speech("th- think"))).toMatchObject([{ type: "repeat", label: "th-" }]);
    expect(detect(speech("I. I think"))).toEqual([]);
  });
  it("keeps the last take after an aborted sentence", () => {
    const cuts = detect(speech("I think- I think this works."));
    expect(cuts).toMatchObject([{ type: "retake", start: 0, end: 0.6666666666666666 }]);
    expect(cuts[0]!.end).toBeLessThan(0.8);
  });
  it("keeps the final take in a chain, unions fillers inside it and avoids double counting", () => {
    const cuts = detect(speech("I think um- I think- I think yes."));
    expect(cuts).toHaveLength(1);
    expect(cuts[0]).toMatchObject({ type: "retake", start: 0 });
    expect(cuts[0]!.end).toBeLessThan(2);
    expect(cuts[0]!.end).toBeGreaterThan(1.7);
  });
  it("requires a repeated prefix, restart boundary and bounded restart window", () => {
    expect(detect(speech("I think I think this"))).toEqual([]);
    expect(detect(speech("I think- I think this"), { ...defaults, restartWindow: 0.5 })).toEqual(
      [],
    );
    expect(detect(speech("I think- you think this"))).toEqual([]);
  });
  it("preserves distinct complete sentences with the same opening and keeps the last identical sentence", () => {
    expect(detect(speech("I love tea. I love coffee."))).toEqual([]);
    expect(detect(speech("This is fine. This is fine."))).toMatchObject([
      { type: "retake", start: 0 },
    ]);
  });
  it("preserves sequence gaps and never joins speech across clip boundaries", () => {
    const segments = [segment(10, 11), segment(20, 21)];
    const words = [
      { text: "you", start: 10, end: 11 },
      { text: "know", start: 20, end: 21 },
    ];
    expect(detect(words, defaults, 25, segments)).toEqual([]);
    expect(detect(speech("I I"), defaults, 25, [segment(0, 0.3), segment(0.4, 0.7)])).toEqual([]);
  });
  it("respects clip identities in sequence-mapped Axis transcripts without a source link", () => {
    expect(
      detect([
        { text: "you", start: 0, end: 0.4, clip: 0 },
        { text: "know", start: 10, end: 10.4, clip: 1 },
      ]),
    ).toEqual([]);
    expect(
      detect([
        { text: "I", start: 0, end: 0.4, clip: 0 },
        { text: "I", start: 0.4, end: 0.8, clip: 1 },
      ]),
    ).toEqual([]);
  });
  it("bounds head/tail silence to the linked clip, with padding", () => {
    const words = [{ text: "okay", start: 11, end: 12 }];
    expect(detect(words, defaults, 25, [segment(10, 14)])).toMatchObject([
      { start: 10.12, end: 10.88 },
      { start: 12.12, end: 13.88 },
    ]);
    expect(detect(words)).toEqual([]);
  });
  it.each([0.5, 2])(
    "uses sequence seconds for %sx speed clips and relinks surviving source words after ripple",
    (speed) => {
      const source = [
        { text: "um", start: 0, end: 0.4 },
        { text: "yes", start: 1.6, end: 2 },
      ];
      const segments = [segment(10, 10 + 2 / speed, 0, speed)];
      const placed = placeWords(source, segments);
      const cuts = detect(placed, { ...defaults, padding: 0 }, 25, segments);
      expect(cuts[0]!.start).toBe(10);
      expect(cuts.every((cut) => cut.end <= segments[0]!.sequenceEnd)).toBe(true);
      const after = placeWords(source, [segment(10, 10 + 0.4 / speed, 1.6, speed)]);
      expect(after).toMatchObject([{ text: "yes", start: 10 }]);
    },
  );
  it("handles overlapping words without inventing silence and clamps cuts inside clip edges", () => {
    expect(
      detect([
        { text: "one", start: 0, end: 3 },
        { text: "two", start: 1, end: 2 },
        { text: "three", start: 2.5, end: 4 },
      ]),
    ).toEqual([]);
    const cuts = detect([{ text: "um", start: 0, end: 1 }], defaults, 25, [segment(0.2, 0.8)]);
    expect(cuts).toMatchObject([{ start: 0.2, end: 0.8 }]);
  });
  it("returns no cuts for empty input or cuts smaller than one frame", () => {
    expect(detect([])).toEqual([]);
    expect(detect([{ text: "um", start: 0.001, end: 0.002 }])).toEqual([]);
  });
  it("rejects invalid settings and malformed timings", () => {
    expect(() => detect(speech("okay"), { ...defaults, padding: NaN })).toThrow();
    expect(() => detect(speech("okay"), defaults, 0)).toThrow();
    expect(() => detect([{ text: "bad", start: 2, end: 1 }])).toThrow();
    expect(() => detect([{ text: "bad", start: NaN, end: 1 }])).toThrow();
  });
  it("unions overlapping, adjacent and duplicate ranges before summing and applying", () => {
    expect(
      mergeCleanupRanges([
        { start: 2, end: 4 },
        { start: 1, end: 3 },
        { start: 4, end: 5 },
        { start: 2, end: 4 },
      ]),
    ).toEqual([{ start: 1, end: 5 }]);
    expect(() => mergeCleanupRanges([{ start: 1, end: Infinity }])).toThrow();
  });
});
