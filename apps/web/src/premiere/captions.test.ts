import { describe, expect, it } from "vite-plus/test";
import {
  captionTimestamp,
  exportSrt,
  exportWebVtt,
  segmentCaptions,
  shortsCaptions,
} from "./captions";
import type { TranscriptWord } from "./sequenceTranscript";

const words = (text: string, start = 0, step = 0.4): TranscriptWord[] =>
  text
    .split(" ")
    .map((text, i) => ({ text, start: start + i * step, end: start + i * step + step * 0.8 }));
const textOf = (cues: ReturnType<typeof segmentCaptions>) =>
  cues.map((cue) => cue.text.replaceAll("\n", " ")).join(" ");

describe("caption segmentation", () => {
  it("accepts an empty transcript", () => expect(segmentCaptions([])).toEqual([]));
  it("preserves sequence offsets and leaves long pauses empty", () => {
    const cues = segmentCaptions([...words("Hello there.", 12), ...words("Welcome back.", 20)]);
    expect(cues.map((cue) => cue.start)).toEqual([12, 20]);
    expect(cues[0]!.end).toBeLessThan(14);
  });
  it("breaks at sentences and keeps punctuation", () => {
    const cues = segmentCaptions(words("One complete sentence. Another complete sentence."));
    expect(cues.map((cue) => cue.text)).toEqual([
      "One complete sentence.",
      "Another complete sentence.",
    ]);
  });
  it("does not treat common titles as sentence ends", () => {
    expect(segmentCaptions(words("Meet our Dr. Smith today."))).toHaveLength(1);
  });
  it("keeps short sentences separate even when the reading-time target cannot fit", () => {
    const cues = segmentCaptions(words("Hi! Bye.", 0, 0.3));
    expect(cues.map((cue) => cue.text)).toEqual(["Hi!", "Bye."]);
    expect(cues[0]!.end).toBe(cues[1]!.start);
  });
  it("recognizes non-Latin sentence endings", () => {
    expect(segmentCaptions(words("你好。 再见！")).map((cue) => cue.text)).toEqual([
      "你好。",
      "再见！",
    ]);
  });
  it("breaks on configurable pauses even when the text would fit", () => {
    const source = [...words("Before", 5), ...words("after", 5.6)];
    expect(segmentCaptions(source, { pause: 0.2 })).toHaveLength(2);
    expect(segmentCaptions(source, { pause: 0.4 })).toHaveLength(1);
  });
  it("uses punctuation boundaries before stripping punctuation", () => {
    const cues = segmentCaptions(words("One complete sentence! Another complete sentence?"), {
      stripPunctuation: true,
    });
    expect(cues.map((cue) => cue.text)).toEqual([
      "One complete sentence",
      "Another complete sentence",
    ]);
  });
  it("wraps within two lines without dropping words", () => {
    const source = words("This is a useful example with several short words to display nicely");
    const cues = segmentCaptions(source, { maxCharacters: 20 });
    expect(textOf(cues)).toBe(source.map((word) => word.text).join(" "));
    expect(cues.some((cue) => cue.text.includes("\n"))).toBe(true);
    for (const cue of cues) {
      expect(cue.text.split("\n").length).toBeLessThanOrEqual(2);
      for (const line of cue.text.split("\n")) expect(line.length).toBeLessThanOrEqual(20);
    }
  });
  it("prefers a comma to a mid-phrase split at capacity", () => {
    const cues = segmentCaptions(words("Hello friend, this is a lovely day"), {
      maxCharacters: 24,
      maxLines: 1,
    });
    expect(cues[0]!.text).toBe("Hello friend,");
  });
  it("keeps articles with their nouns where capacity permits", () => {
    const cues = segmentCaptions(words("Look at the beautiful sky"), {
      maxCharacters: 17,
      maxLines: 1,
    });
    expect(cues[0]!.text.endsWith("the")).toBe(false);
    expect(textOf(cues)).toBe("Look at the beautiful sky");
  });
  it.each([1, 2, 3])("supports %i words per cue", (count) => {
    const source = words("Every frame has a story to tell");
    const cues = segmentCaptions(source, { ...shortsCaptions, wordsPerCue: count });
    expect(textOf(cues)).toBe(source.map((word) => word.text).join(" "));
    for (const cue of cues) expect(cue.text.split(" ").length).toBeLessThanOrEqual(count);
  });
  it("uppercases and lowercases without mutating input", () => {
    const source = Object.freeze(words("Hello World!"));
    expect(textOf(segmentCaptions(source, { case: "upper" }))).toBe("HELLO WORLD!");
    expect(textOf(segmentCaptions(source, { case: "lower" }))).toBe("hello world!");
    expect(source[0]!.text).toBe("Hello");
  });
  it("normalizes whitespace, strips Unicode punctuation and handles non-Latin text", () => {
    expect(
      textOf(
        segmentCaptions([{ text: "  你好，世界！\n", start: 0, end: 1 }], {
          stripPunctuation: true,
        }),
      ),
    ).toBe("你好世界");
  });
  it("counts Unicode codepoints without splitting a long word", () => {
    const cues = segmentCaptions(words("😀😀 abc extraordinarilylong"), {
      maxCharacters: 6,
      maxLines: 1,
    });
    expect(cues[0]!.text).toBe("😀😀 abc");
    expect(cues.at(-1)!.text).toBe("extraordinarilylong");
  });
  it("extends short cues to the minimum when space allows", () => {
    expect(segmentCaptions(words("Hello"))[0]!.end).toBe(0.8);
  });
  it("never overlaps adjacent cues to meet the minimum during fast speech", () => {
    const cues = segmentCaptions(words("one two three four", 0, 0.1), { wordsPerCue: 1 });
    expect(cues[0]!.end).toBe(0.1);
    for (let i = 1; i < cues.length; i++)
      expect(cues[i - 1]!.end).toBeLessThanOrEqual(cues[i]!.start);
  });
  it("limits long cues and unusually long word timings to six seconds", () => {
    const cues = segmentCaptions([
      ...words("one two three four five six seven eight", 0, 1),
      { text: "held", start: 20, end: 35 },
    ]);
    for (const cue of cues) expect(cue.end - cue.start).toBeLessThanOrEqual(6);
    expect(textOf(cues)).toBe("one two three four five six seven eight held");
  });
  it("preserves every word across a large transcript and maintains all hard limits", () => {
    const source = Array.from({ length: 10000 }, (_, i) => ({
      text: `w${i}${i % 13 === 0 ? "," : ""}`,
      start: 20 + i * 0.13,
      end: 20 + i * 0.13 + 0.1,
    }));
    const cues = segmentCaptions(source);
    expect(textOf(cues)).toBe(source.map((word) => word.text).join(" "));
    cues.forEach((cue, i) => {
      expect(cue.end).toBeGreaterThan(cue.start);
      expect(cue.end - cue.start).toBeLessThanOrEqual(6);
      if (i) expect(cues[i - 1]!.end).toBeLessThanOrEqual(cue.start);
      expect(cue.text.split("\n").length).toBeLessThanOrEqual(2);
      cue.text.split("\n").forEach((line) => expect(line.length).toBeLessThanOrEqual(32));
    });
  });
  it.each([
    { maxCharacters: 0 },
    { maxLines: 3 },
    { minDuration: 0 },
    { maxDuration: 7 },
    { minDuration: 5, maxDuration: 2 },
    { pause: NaN },
    { wordsPerCue: 4 },
    { case: "bad" },
  ])("rejects invalid options %j", (options) => {
    expect(() => segmentCaptions(words("Hello"), options as never)).toThrow(
      "Invalid caption options",
    );
  });
  it("preserves simultaneous speakers in one cue instead of losing text", () => {
    const cues = segmentCaptions(
      [
        { text: "Hello", start: 0, end: 1 },
        { text: "there", start: 0, end: 1 },
      ],
      { wordsPerCue: 1 },
    );
    expect(textOf(cues)).toBe("Hello there");
    expect(cues).toHaveLength(1);
  });
  it("groups sub-millisecond words so SRT never contains zero-length cues", () => {
    const cues = segmentCaptions(
      [
        { text: "a", start: 0, end: 0.0001 },
        { text: "b", start: 0.0002, end: 0.0003 },
      ],
      { wordsPerCue: 1 },
    );
    expect(textOf(cues)).toBe("a b");
    expect(cues).toHaveLength(1);
    expect(exportSrt(cues)).toContain("00:00:00,000 --> 00:00:00,800");
  });
  it.each(
    [
      [{ text: "bad", start: -1, end: 1 }],
      [{ text: "bad", start: 1, end: 1 }],
      [{ text: "bad", start: 0, end: Infinity }],
      [...words("a", 2), ...words("b", 1)],
    ].map((source) => ({ source })),
  )("rejects invalid word timings", ({ source }) => {
    expect(() => segmentCaptions(source)).toThrow("word timings");
  });
});

describe("caption exports", () => {
  it("exports numbered SRT with absolute timestamps and line breaks", () => {
    expect(
      exportSrt([
        { start: 65.25, end: 67, text: "Hello\nworld." },
        { start: 70, end: 71, text: "Next" },
      ]),
    ).toBe(
      "1\n00:01:05,250 --> 00:01:07,000\nHello\nworld.\n\n2\n00:01:10,000 --> 00:01:11,000\nNext\n",
    );
  });
  it("exports WebVTT and escapes cue markup", () => {
    expect(exportWebVtt([{ start: 1, end: 2, text: "A & <B>" }])).toBe(
      "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nA &amp; &lt;B&gt;\n",
    );
  });
  it("rounds milliseconds with carry into hours", () => {
    expect(captionTimestamp(3599.9996)).toBe("01:00:00,000");
    expect(captionTimestamp(360000)).toBe("100:00:00,000");
    expect(() => captionTimestamp(-1)).toThrow();
  });
  it("exports empty documents", () => {
    expect(exportSrt([])).toBe("");
    expect(exportWebVtt([])).toBe("WEBVTT\n\n");
  });
});
