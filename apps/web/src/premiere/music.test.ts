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
  chooseMusicTrack,
  fillMusicGaps,
  matchingMusic,
  mergeShortMusicSections,
  musicLevel,
  musicScope,
  validateMusicCoverage,
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
    expect(musicOffset({ ...track(), rises: [] }, 40, 6)).toBe(0);
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
    expect(plan.silence[0]!.reason).toContain("No different matching track");
  });
  it("rejects overlapping, repeated, unsafe or sponsor-crossing plans", () => {
    const c = cue();
    for (const cues of [
      [c, { ...c, id: "2", track: "two", start: 29 }],
      [c, { ...c, id: "2", start: 30, end: 60 }],
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
      { ...defaultMusicMix, duckDb: -8 },
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
      duckDb: -8,
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

it("splits subject pivots without a timer changing music inside one character", () => {
  const input = [
    ...words("Goku fights through the entire battle. Next up, Jiren reveals his power."),
  ];
  const chapters = musicChapters(input);
  expect(chapters).toHaveLength(2);
  expect(chapters[1]!.text).toContain("Jiren");
  expect(chapters[0]!.end).toBe(chapters[1]!.start);
  const long = words(
    Array.from({ length: 190 }, (_, i) => (i % 20 === 19 ? "continues." : "Goku")).join(" "),
  );
  expect(musicChapters(long)).toHaveLength(1);
});

it("prefers the mood folder over misleading descriptions and permits non-neighbour repeats", () => {
  const calm = { ...track("calm"), category: "calm music", description: "intense epic fight" };
  const hype = { ...track("hype"), category: "hype music", description: "quiet piano" };
  const duplicate = { ...hype, path: "D:/Music/00. duplicate copies - review/copy.wav" };
  const unsorted = { ...hype, path: "D:/Music/00. unsorted - review/one.wav" };
  expect(matchingMusic("hype", 0.9, 50, [calm, hype, duplicate, unsorted])[0]).toBe(hype);
  expect(matchingMusic("hype", 0.9, 50, [hype], ["HYPE"])).toEqual([]);
  expect(matchingMusic("hype", 0.9, 50, [unsorted, duplicate])[0]).toBe(unsorted);
  const a = { ...cue(), id: "a", start: 0, end: 20 };
  const b = { ...cue(), id: "b", track: "two", start: 20, end: 40 };
  const c = { ...a, id: "c", start: 40, end: 60 };
  expect(validateMusicPlan({ version: 1, cues: [a, b, c], silence: [] }).cues).toHaveLength(3);
  expect(() =>
    validateMusicPlan({ version: 1, cues: [a, { ...b, track: a.track }], silence: [] }),
  ).toThrow("Neighbouring");
});

it("uses the populated library track before empty tracks and fills only empty intervals", () => {
  const snapshot = {
    projectId: "p",
    sequenceId: "s",
    name: "edit",
    videoTrackCount: 0,
    audioTrackCount: 3,
    videoTracks: [],
    audioTracks: [
      { index: 0, name: "Voice", locked: true, clips: [] },
      { index: 1, name: "Custom empty", clips: [] },
      {
        index: 2,
        name: "Audio 5",
        clips: [
          {
            name: "music",
            nodeId: "m",
            projectItemName: "one",
            mediaPath: track().path,
            start: 20,
            end: 40,
            inPoint: 0,
            outPoint: 20,
            enabled: true,
          },
        ],
      },
    ],
    markers: [],
    inPoint: null,
    outPoint: null,
    truncated: false,
  };
  expect(chooseMusicTrack(snapshot, [track()]).index).toBe(2);
  expect(chooseMusicTrack(snapshot, []).index).toBe(1);
  expect(() => chooseMusicTrack({ ...snapshot, truncated: true }, [])).toThrow("large");
  expect(() =>
    chooseMusicTrack(
      { ...snapshot, audioTracks: snapshot.audioTracks.map((t) => ({ ...t, locked: true })) },
      [track()],
    ),
  ).toThrow("Unlock");
  expect(() =>
    chooseMusicTrack({ ...snapshot, audioTracks: [snapshot.audioTracks[2]!] }, []),
  ).toThrow("empty audio track");
  const filled = fillMusicGaps(
    { version: 1, cues: [{ ...cue(), start: 0, end: 60 }], silence: [] },
    { start: 10, end: 50 },
    snapshot.audioTracks[2]!.clips,
  );
  expect(filled.cues.map(({ start, end }) => [start, end])).toEqual([
    [10, 20],
    [40, 50],
  ]);
  expect(filled.cues.every((c) => c.sourceOffset === 0)).toBe(true);
  expect(musicScope(snapshot, words("one two"))).toEqual({ start: 0, end: 40 });
  expect(musicScope({ ...snapshot, inPoint: 5, outPoint: 15 }, [], { start: 7, end: 9 })).toEqual({
    start: 7,
    end: 9,
  });
  expect(musicScope({ ...snapshot, inPoint: 5, outPoint: 15 }, [])).toEqual({ start: 5, end: 15 });
});

it("allows a returning song when existing music separates the new sections", () => {
  const a = { ...cue(), id: "a", start: 0, end: 20 };
  const b = { ...a, id: "b", start: 40, end: 60 };
  const plan = validateMusicPlan({ version: 1, cues: [a, b], silence: [] });
  expect(() =>
    validateMusicCoverage(plan, { start: 0, end: 60 }, [{ start: 20, end: 40 }], 60),
  ).not.toThrow();
});

it("normalizes from peak, clamps positive Level at +15, and does not duck by default", () => {
  expect(musicLevel({ ...track(), peakDbfs: -3 })).toBe(-30);
  expect(musicLevel({ ...track(), peakDbfs: -60 })).toBe(15);
  expect(() => musicLevel(track())).toThrow("peak");
  const keys = musicKeyframes(
    { ...cue(), baseDb: -30, fadeIn: 0, fadeOut: 0 },
    words("speech", 15),
    defaultMusicMix,
  );
  expect(keys).toEqual([
    { time: 0, value: Math.pow(10, -30 / 20) },
    { time: 20, value: Math.pow(10, -30 / 20) },
  ]);
});

it("merges three short fusion subjects while keeping the 17 worked-example sections contiguous", () => {
  const subjects = [
    "Baby",
    "Super 17",
    "Omega Shenron",
    "Toppo",
    "Kale",
    "Broly",
    "Moro",
    "Gas",
    "Goku Black",
    "Fused Zamasu",
    "Cumber",
    "Fu",
    "Hearts",
    "Gotenks",
    "Gogeta",
    "Vegito",
    "Ultra Instinct",
    "Ultra Ego",
    "Gohan Beast",
  ];
  let start = 375;
  const cues = subjects.map((chapter, i) => {
    const fusion = i >= 13 && i <= 15;
    const duration = fusion ? 20 : i === 18 ? 44 : 48;
    const next = {
      ...cue(),
      id: String(i),
      chapter,
      start,
      end: start + duration,
      mood: "hype",
      theme: fusion ? "Fusions" : chapter,
      track: `song-${i}`,
      sourceOffset: 0,
    };
    start += duration;
    return next;
  });
  const merged = validateMusicPlan(mergeShortMusicSections({ version: 1, cues, silence: [] }));
  expect(merged.cues).toHaveLength(17);
  expect(merged.cues[13]).toMatchObject({
    chapter: "Fusions",
    start: 999,
    end: 1059,
    track: "song-13",
  });
  expect(merged.cues.at(-1)!.end).toBe(1199);
  for (let i = 1; i < merged.cues.length; i++)
    expect(merged.cues[i]!.start).toBe(merged.cues[i - 1]!.end);
  expect(() => validateMusicCoverage(merged, { start: 375, end: 1199 }, [], 60)).not.toThrow();
});

it("keeps short emotional changes and unrelated subjects distinct", () => {
  const a = { ...cue(), id: "a", start: 0, end: 20, theme: "Kale", mood: "hype" };
  const b = { ...a, id: "b", start: 20, end: 40, mood: "sad", track: "two" };
  const c = { ...b, id: "c", start: 40, end: 60, theme: "Broly", track: "three" };
  expect(mergeShortMusicSections({ version: 1, cues: [a, b, c], silence: [] }).cues).toHaveLength(
    3,
  );
});

it("shares a rounded section boundary, protects occupied edges and rejects an unscored range", () => {
  const a = { ...cue(), id: "a", start: 0, end: 30.01 };
  const b = { ...cue(), id: "b", track: "two", start: 30.01, end: 60 };
  const plan = fillMusicGaps(
    { version: 1, cues: [b, a], silence: [] },
    { start: 0, end: 60 },
    [],
    60,
  );
  expect(plan.cues[0]!.end).toBe(plan.cues[1]!.start);
  expect(() => validateMusicCoverage(plan, { start: 0, end: 60 }, [], 60)).not.toThrow();
  expect(() => validateMusicCoverage(plan, { start: 0, end: 90 }, [], 60)).toThrow("unscored");
  expect(() =>
    validateMusicCoverage(
      { ...plan, silence: [{ start: 60, end: 90, reason: "Sponsor" }] },
      { start: 0, end: 90 },
      [],
      60,
    ),
  ).not.toThrow();
  const protectedPlan = fillMusicGaps(
    { version: 1, cues: [{ ...a, end: 60 }], silence: [] },
    { start: 0, end: 60 },
    [{ start: 40.01, end: 60 }],
    60,
  );
  expect(protectedPlan.cues[0]!.end).toBeLessThanOrEqual(40.01);
});
