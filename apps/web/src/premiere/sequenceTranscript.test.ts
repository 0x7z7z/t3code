import { expect, it } from "vite-plus/test";
import {
  activeWord,
  mapTranscript,
  parseStoredTranscript,
  parseTranscript,
  rippleTranscript,
  selectionRange,
  transcriptContext,
} from "./sequenceTranscript";

const words = [
  { text: "Hello", start: 0.12, end: 0.49 },
  { text: "world.", start: 0.6, end: 1.11 },
];

it("imports WhisperX segments and word_segments without losing punctuation", () => {
  const raw = words.map(({ text, ...word }) => ({ ...word, word: text }));
  for (const data of [
    { segments: [{ words: raw }] },
    { word_segments: raw },
    { words: raw },
    raw,
  ]) {
    const doc = parseTranscript(JSON.stringify(data), "voice.json");
    expect(doc.words).toEqual(words);
    expect(doc.timing).toBe("word");
    expect(doc.source).toContain("voice.json");
  }
});

it("imports transcriber sentence files and fills WhisperX gaps from neighbours", () => {
  const doc = parseTranscript(
    JSON.stringify({
      metadata: { model: "small.en" },
      sentences: [
        {
          words: [
            { word: "Top", start: 1, end: 1.4 },
            { word: "10", score: 0.2 },
            { word: "forms", start: 1.9, end: 1.9 },
            { word: "ranked.", start: 1.905, end: 2.5 },
          ],
        },
      ],
    }),
    "vo_sentences.json",
  );
  const round = (value: number) => Math.round(value * 1000) / 1000;
  expect(doc.words.map((word) => [word.text, round(word.start), round(word.end)])).toEqual([
    ["Top", 1, 1.4],
    ["10", 1.4, 1.9],
    ["forms", 1.9, 1.91],
    ["ranked.", 1.91, 2.5],
  ]);
});

it("imports SRT and VTT with explicit estimated word timing", () => {
  const srt = parseTranscript(
    "1\r\n00:00:01,000 --> 00:00:03,000\r\nHello <i>world.</i>\r\n\r\n2\r\n00:00:04,000 --> 00:00:05,000\r\nAgain",
    "vo.srt",
  );
  expect(srt.words).toEqual([
    { text: "Hello", start: 1, end: 2 },
    { text: "world.", start: 2, end: 3 },
    { text: "Again", start: 4, end: 5 },
  ]);
  const vtt = parseTranscript(
    "\uFEFFWEBVTT\n\nNOTE editor note\nignored\n\ncue-a\n00:01.000 --> 00:03.000 align:start\n<v Alice>Hello &amp; goodbye</v>",
    "vo.vtt",
  );
  expect(vtt.timing).toBe("estimated");
  expect(vtt.words.map((word) => word.text)).toEqual(["Hello", "&", "goodbye"]);
  expect(vtt.words.at(-1)?.end).toBe(3);
});

it("rejects invalid JSON, untimed words, unordered words and malformed subtitles", () => {
  for (const input of [
    "{",
    "{}",
    '{"segments":[{"text":"no words"}]}',
    JSON.stringify({ words: words.toReversed() }),
  ]) {
    expect(() => parseTranscript(input, "voice.json")).toThrow();
  }
  for (const input of [
    "",
    "just text",
    "1\n00:00:99,000 --> 00:00:03,000\nBad",
    "1\n00:00:05,000 --> 00:00:03,000\nBad",
  ]) {
    expect(() => parseTranscript(input, "voice.srt")).toThrow();
  }
});

it("maps offsets and creates frame-enclosing ranges for forward and reverse selections", () => {
  const mapped = mapTranscript(words, 5);
  expect(mapped[0]?.start).toBe(5.12);
  expect(() => mapTranscript(words, -1)).toThrow();
  expect(() => mapTranscript(words, NaN)).toThrow();
  expect(selectionRange(words, 1, 0, 25)).toEqual({
    first: 0,
    last: 1,
    start: 0.12,
    end: 1.12,
    text: "Hello world.",
  });
  expect(selectionRange(words, 0, 99, 25)).toBeNull();
  expect(selectionRange(words, 0, 1, 0)).toBeNull();
});

it("highlights only the word under the playhead and leaves silence unhighlighted", () => {
  expect(activeWord(words, 0.2)).toBe(0);
  expect(activeWord(words, 0.5)).toBe(-1);
  expect(activeWord(words, 0.6)).toBe(1);
  expect(activeWord(words, 1.11)).toBe(-1);
});

it("quotes source and sequence time range, remaps remaining words after cuts, and restores stored empty transcripts", () => {
  const doc = { source: "WhisperX JSON · voice.json", timing: "word" as const, offset: 0, words };
  const range = selectionRange(words, 0, 0, 25)!;
  expect(transcriptContext(doc, range, "Main")).toContain("[00:00:00.120 - 00:00:00.520]");
  expect(transcriptContext(doc, range, "Main")).toContain("> Hello");
  const cut = rippleTranscript(doc, 0.12, 0.52);
  expect(cut.words[0]?.start).toBeCloseTo(0.2);
  expect(parseStoredTranscript(JSON.parse(JSON.stringify(cut)))).toEqual(cut);
  expect(parseStoredTranscript({ ...doc, words: [] })?.words).toEqual([]);
  expect(parseStoredTranscript({ ...doc, words: [{ start: -1 }] })).toBeNull();
});
