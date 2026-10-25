import { describe, expect, it } from "vite-plus/test";
import {
  mergeMusicSpeech,
  musicChapters,
  musicKeyframes,
  musicOffset,
  planMusic,
  subtractMusicRanges,
  validateMusicPlan,
  defaultMusicMix,
  type MusicCue,
  type MusicTrack,
} from "./music";

const track = (path = "D:/Music/one.wav"): MusicTrack => ({
  path,
  filename: path,
  category: "action",
  duration: 300,
  loudnessDbfs: -18,
  energy: [],
  rises: [{ start: 12, end: 18, db: 8 }],
  loudWindows: [],
  quietRanges: [],
  phraseBoundaries: [8, 24],
  tempo: null,
  description: "",
  tags: [],
});
const cue = (): MusicCue => ({
  id: "1",
  chapter: "Opening",
  start: 10,
  end: 30,
  track: "one",
  sourceOffset: 0,
  reason: "bed",
  fadeIn: 1,
  fadeOut: 2,
  baseDb: -22,
  enabled: true,
  alternatives: [],
});
const words = (text: string, start = 0) =>
  text.split(" ").map((text, i) => ({ text, start: start + i, end: start + i + 0.8 }));
describe("music planning", () => {
  it("keeps a coherent bed rather than changing every sentence", () => {
    const input = words(
      Array.from({ length: 110 }, (_, i) => (i % 15 === 14 ? "ends." : "action")).join(" "),
    );
    const chapters = musicChapters(input);
    expect(chapters.length).toBeLessThanOrEqual(3);
    expect(chapters[0]!.end).toBeGreaterThan(45);
    const plan = planMusic(input, [track(), track("two"), track("three"), track("four")]);
    expect(new Set(plan.cues.map((c) => c.track)).size).toBe(plan.cues.length);
    expect(plan.cues[0]!.alternatives).toHaveLength(3);
    for (let i = 1; i < plan.cues.length; i++)
      expect(plan.cues[i]!.start).toBe(plan.cues[i - 1]!.end);
  });
  it("aligns only real rises within source duration", () => {
    expect(musicOffset(track(), 40, 6)).toBe(12);
    expect(musicOffset(track(), 295, 6)).toBe(0);
    expect(() => musicOffset(track(), 301)).toThrow("too short");
    expect(musicOffset({ ...track(), rises: [] }, 40, 6)).toBe(8);
  });
  it("splits sponsor and deliberate silence ranges without overlaps", () => {
    expect(
      subtractMusicRanges({ start: 0, end: 60 }, [
        { start: 10, end: 20 },
        { start: 15, end: 30 },
      ]),
    ).toEqual([
      { start: 0, end: 10 },
      { start: 30, end: 60 },
    ]);
    const plan = planMusic(
      words("An action reveal keeps growing for a while"),
      [track(), track("two")],
      -22,
      [{ start: 2, end: 4 }],
    );
    expect(plan.cues.every((c) => c.end <= 2 || c.start >= 4)).toBe(true);
    expect(plan.silence).toHaveLength(1);
  });
  it("excludes sponsor narration and resumes at original content", () => {
    const input = words("Opening. This video is sponsored by Brand. Now back to the action.");
    const chapters = musicChapters(input);
    expect(chapters.map((c) => c.sponsor)).toEqual([false, true, false]);
    const plan = planMusic(input, [track(), track("two")]);
    expect(plan.silence.some((s) => s.reason.includes("Sponsor"))).toBe(true);
  });
  it("leaves explicit silence when unused tracks cannot cover a chapter", () => {
    const plan = planMusic(words("one two three four five"), [{ ...track(), duration: 1 }]);
    expect(plan.cues).toHaveLength(0);
    expect(plan.silence[0]!.reason).toContain("no unused track");
  });
  it("rejects overlapping, repeated, unsafe or sponsor-crossing plans", () => {
    const c = cue();
    for (const cues of [
      [c, { ...c, id: "2", track: "two", start: 29 }],
      [c, { ...c, id: "2", start: 40, end: 60 }],
      [{ ...c, sourceOffset: -1 }],
      [{ ...c, fadeIn: 40 }],
    ])
      expect(() => validateMusicPlan({ version: 1, cues, silence: [] })).toThrow();
    expect(() =>
      validateMusicPlan({
        version: 1,
        cues: [c],
        silence: [{ start: 15, end: 18, reason: "sponsor" }],
      }),
    ).toThrow("silence");
  });
});
describe("music automation", () => {
  it("merges short speech gaps, overlaps and duplicate regions", () => {
    expect(
      mergeMusicSpeech(
        [
          { start: 1, end: 2 },
          { start: 2.2, end: 3 },
          { start: 5, end: 6 },
          { start: 1, end: 1.5 },
        ],
        0.85,
      ),
    ).toEqual([
      { start: 1, end: 3 },
      { start: 5, end: 6 },
    ]);
  });
  it("ramps attack and release without pumping between words", () => {
    const c = { ...cue(), fadeIn: 0, fadeOut: 0 };
    const keys = musicKeyframes(
      c,
      [
        { start: 12, end: 13 },
        { start: 13.3, end: 14 },
      ],
      defaultMusicMix,
    );
    expect(keys.map((k) => k.time)).toEqual([0, 1.75, 2, 4, 4.6, 20]);
    expect(keys[2]!.value).toBeCloseTo(Math.pow(10, -30 / 20));
    expect(keys[4]!.value).toBeCloseTo(Math.pow(10, -22 / 20));
  });
  it("clips speech at cue edges and combines fades with ducking", () => {
    const keys = musicKeyframes(
      cue(),
      [
        { start: 9, end: 11 },
        { start: 29, end: 35 },
      ],
      defaultMusicMix,
    );
    expect(keys[0]).toEqual({ time: 0, value: 0 });
    expect(keys.at(-1)).toEqual({ time: 20, value: 0 });
    expect(keys.every((k) => k.time >= 0 && k.time <= 20 && k.value >= 0)).toBe(true);
    expect(new Set(keys.map((k) => k.time)).size).toBe(keys.length);
  });
  it("rejects positive ducking or nonfinite settings", () => {
    expect(() => musicKeyframes(cue(), [], { ...defaultMusicMix, duckDb: 8 })).toThrow("duck");
    expect(() => musicKeyframes(cue(), [], { ...defaultMusicMix, attack: NaN })).toThrow("duck");
  });
  it("supports instant duck attack and release without stretching a ramp across the gap", () => {
    const c = { ...cue(), fadeIn: 0, fadeOut: 0 };
    const keys = musicKeyframes(c, [{ start: 14, end: 16 }], {
      ...defaultMusicMix,
      attack: 0,
      release: 0,
      mergeGap: 0,
    });
    expect(
      keys.some(
        (k) => k.time > 3.9 && k.time < 4 && Math.abs(k.value - Math.pow(10, -22 / 20)) < 0.00001,
      ),
    ).toBe(true);
    expect(
      keys.some(
        (k) => k.time > 6 && k.time < 6.1 && Math.abs(k.value - Math.pow(10, -22 / 20)) < 0.00001,
      ),
    ).toBe(true);
  });
});
