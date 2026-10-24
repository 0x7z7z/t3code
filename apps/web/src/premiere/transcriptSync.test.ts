import { describe, expect, it } from "vite-plus/test";
import type { TranscriptWord } from "./sequenceTranscript";
import type { TimelineClip, TimelineSnapshot } from "./turnChanges";
import {
  findVoiceLink,
  lastWordBefore,
  mediaStem,
  placeWords,
  PlayheadClock,
  refreshVoiceLink,
  seekTime,
  sequenceToSource,
  voiceCandidates,
  wordAtTime,
  type ClipSegment,
} from "./transcriptSync";

const mediaName = "VO_Every_final_form_in_dragonball_SilenceRemoved-Final.wav";
const transcriptName = "VO_Every_final_form_in_dragonball_SilenceRemoved-Final_sentences.json";

function clip(overrides: Partial<TimelineClip> = {}): TimelineClip {
  return {
    name: "Narration cut",
    projectItemName: mediaName,
    nodeId: "vo",
    start: 0,
    end: 5,
    inPoint: 0,
    outPoint: 5,
    enabled: true,
    ...overrides,
  };
}

function snapshot(audioTracks: TimelineSnapshot["audioTracks"]): TimelineSnapshot {
  return {
    projectId: "project",
    sequenceId: "sequence",
    name: "Edit",
    audioTrackCount: audioTracks.length,
    videoTrackCount: 0,
    audioTracks,
    videoTracks: [],
    markers: [],
    inPoint: null,
    outPoint: null,
    truncated: false,
  };
}

const segments: readonly ClipSegment[] = [
  {
    trackIndex: 0,
    clipName: "Trimmed head",
    sequenceStart: 10,
    sequenceEnd: 12,
    sourceIn: 1,
    speed: 1,
  },
  { trackIndex: 0, clipName: "Middle", sequenceStart: 15, sequenceEnd: 17, sourceIn: 4, speed: 1 },
  {
    trackIndex: 0,
    clipName: "Double speed",
    sequenceStart: 20,
    sequenceEnd: 22,
    sourceIn: 8,
    speed: 2,
  },
];

describe("voice-over links", () => {
  it.each([
    transcriptName,
    `${mediaName}.words.json`,
    "VO_Every_final_form_in_dragonball_SilenceRemoved-Final.whisperx.json",
    "VO_Every_final_form_in_dragonball_SilenceRemoved-Final-whisperx_aligned.json",
    "D:\\VO\\VO_Every_final_form_in_dragonball_SilenceRemoved-Final_TRANSCRIPT.json",
  ])("normalises transcript and media stems: %s", (name) => {
    expect(mediaStem(name)).toBe(mediaStem(mediaName));
  });

  it("chooses the audio track with the most matching enabled duration, or a matching preference", () => {
    const data = snapshot([
      { index: 0, clips: [clip(), clip({ start: 7, end: 10, outPoint: 3 })] },
      { index: 2, clips: [clip({ end: 7, outPoint: 7 })] },
      { index: 3, clips: [clip({ end: 100, outPoint: 100, enabled: false })] },
    ]);
    data.videoTracks = [{ index: 0, clips: [clip({ end: 1000, outPoint: 1000 })] }];
    const link = findVoiceLink(data, transcriptName)!;
    expect(link.trackIndex).toBe(0);
    expect(link.mediaName).toBe(mediaName);
    expect(link.segments).toHaveLength(2);
    expect(findVoiceLink(data, transcriptName, 2)?.trackIndex).toBe(2);
    expect(findVoiceLink(data, transcriptName, 3)?.trackIndex).toBe(0);
    expect(findVoiceLink(data, "unrelated.json")).toBeNull();
    expect(findVoiceLink(data, "")).toBeNull();
  });

  it("matches long partial stems in either direction, falls back to clip names, and rejects short partials", () => {
    const data = snapshot([
      {
        index: 4,
        clips: [clip({ projectItemName: "", name: "narration_main.wav", enabled: null })],
      },
    ]);
    expect(findVoiceLink(data, "narration_main_cleaned_words.json")?.trackIndex).toBe(4);
    expect(findVoiceLink(data, "narration.json")?.trackIndex).toBe(4);
    expect(findVoiceLink(data, "main.json")).toBeNull();
    expect(
      findVoiceLink(
        snapshot([{ index: 0, clips: [clip({ projectItemName: "short.wav" })] }]),
        "short.json",
      ),
    ).not.toBeNull();
  });

  it("groups candidates by project item and track, sorts by duration, and caps the picker at 50", () => {
    const data = snapshot([
      {
        index: 0,
        clips: [
          clip(),
          clip({ start: 7, end: 10 }),
          clip({ projectItemName: "", name: "Fallback.wav", end: 2 }),
        ],
      },
      { index: 1, clips: [clip({ end: 20 })] },
    ]);
    expect(voiceCandidates(data)).toEqual([
      { trackIndex: 1, mediaName, duration: 20 },
      { trackIndex: 0, mediaName, duration: 8 },
      { trackIndex: 0, mediaName: "Fallback.wav", duration: 2 },
    ]);
    const many = snapshot([
      {
        index: 0,
        clips: Array.from({ length: 60 }, (_, i) =>
          clip({ projectItemName: `${i}.wav`, end: i + 1 }),
        ),
      },
    ]);
    expect(voiceCandidates(many)).toHaveLength(50);
    expect(voiceCandidates(many)[0]?.duration).toBe(60);
  });

  it("refreshes exact media on its track after trims, moves, cuts, and speed changes", () => {
    const data = snapshot([
      {
        index: 0,
        clips: [
          clip({ start: 20, end: 22, inPoint: 8, outPoint: 12, name: "Double speed" }),
          clip({ start: 10, end: 12, inPoint: 1, outPoint: 3, name: "Trimmed head" }),
          clip({ start: 15, end: 17, inPoint: 4, outPoint: 6, name: "Middle" }),
          clip({ projectItemName: "Other.wav" }),
        ],
      },
    ]);
    const link = refreshVoiceLink(data, { trackIndex: 0, mediaName })!;
    expect(link.segments).toEqual(segments);
    expect(refreshVoiceLink(data, { trackIndex: 1, mediaName })).toBeNull();
    expect(refreshVoiceLink(data, { trackIndex: 0, mediaName: "Other version.wav" })).toBeNull();
    expect(refreshVoiceLink(snapshot([]), link)).toBeNull();
  });

  it("ignores disabled clips, invalid ranges, and nonpositive or nonfinite speeds", () => {
    for (const overrides of [
      { enabled: false },
      { end: 0 },
      { outPoint: 0 },
      { inPoint: 10 },
      { end: Infinity },
      { start: NaN },
      { inPoint: -1 },
    ]) {
      const data = snapshot([{ index: 0, clips: [clip(overrides)] }]);
      expect(findVoiceLink(data, transcriptName)).toBeNull();
      expect(refreshVoiceLink(data, { trackIndex: 0, mediaName })).toBeNull();
    }
  });
});

describe("source and sequence mapping", () => {
  it("maps three cut pieces with gaps, a trimmed head and 2x playback, preserving source indices", () => {
    const words = [
      { text: "trimmed away", start: 0, end: 0.5 },
      { text: "clamped head", start: 0.8, end: 1.4 },
      { text: "first", start: 2, end: 2.5 },
      { text: "removed", start: 3.2, end: 3.8 },
      { text: "middle", start: 4, end: 4.5 },
      { text: "clamped tail", start: 5.7, end: 6.1 },
      { text: "fast", start: 8.2, end: 9 },
      { text: "ending", start: 11, end: 12 },
    ];
    const placed = placeWords(words, segments.toReversed());
    expect(placed.map((word) => [word.text, word.start, word.end, word.sourceIndex])).toEqual([
      ["clamped head", 10, 10.4, 1],
      ["first", 11, 11.5, 2],
      ["middle", 15, 15.5, 4],
      ["clamped tail", 16.7, 17, 5],
      ["fast", 20.1, 20.5, 6],
      ["ending", 21.5, 22, 7],
    ]);
    expect(words[1]?.start).toBe(0.8);
  });

  it("places duplicated source ranges twice and uses half-open midpoint boundaries", () => {
    const words = [
      { text: "midpoint at in", start: 0.5, end: 1.5 },
      { text: "midpoint at out", start: 2.5, end: 3.5 },
    ];
    const placed = placeWords(words, [
      segments[0]!,
      { ...segments[0]!, sequenceStart: 30, sequenceEnd: 32 },
    ]);
    expect(placed.map(({ start, end, sourceIndex }) => ({ start, end, sourceIndex }))).toEqual([
      { start: 10, end: 10.5, sourceIndex: 0 },
      { start: 30, end: 30.5, sourceIndex: 0 },
    ]);
  });

  it("trims overlaps without zero-duration words or changing its inputs", () => {
    const words = [
      { text: "early", start: 0, end: 1 },
      { text: "later", start: 0.8, end: 1.5 },
      { text: "last same start", start: 0.8, end: 2 },
    ];
    const placed = placeWords(words, [{ ...segments[0]!, sourceIn: 0 }]);
    expect(placed.map(({ text, start, end }) => ({ text, start, end }))).toEqual([
      { text: "early", start: 10, end: 10.8 },
      { text: "last same start", start: 10.8, end: 12 },
    ]);
    expect(words[0]?.end).toBe(1);
    expect(placeWords(words, [{ ...segments[0]!, speed: 0 }])).toEqual([]);
    expect(placeWords([], segments)).toEqual([]);
  });

  it("inverts visible sequence times, including speed changes, and leaves gaps unmapped", () => {
    for (const [sequence, source] of [
      [10, 1],
      [11.5, 2.5],
      [15, 4],
      [20.5, 9],
      [21.5, 11],
    ])
      expect(sequenceToSource(sequence!, segments)).toBe(source);
    for (const seconds of [0, 12, 14.99, 17, 22, NaN])
      expect(sequenceToSource(seconds, segments)).toBeNull();
  });
});

describe.each([23.976, 24000 / 1001, 29.97, 30000 / 1001, 60])("frame lookup at %s fps", (fps) => {
  const frame = 1 / fps;

  it("selects adjacent words at exact boundaries, mid-frame starts and silence", () => {
    const words = [
      { text: "one", start: 0, end: 2 * frame },
      { text: "two", start: 2 * frame, end: 4 * frame },
      { text: "three", start: 6.25 * frame, end: 8 * frame },
    ];
    for (const [seconds, expected] of [
      [0, 0],
      [frame, 0],
      [2 * frame, 1],
      [3 * frame, 1],
      [4 * frame, -1],
      [5 * frame, -1],
      [6 * frame, 2],
      [6.5 * frame, 2],
      [8 * frame, -1],
    ])
      expect(wordAtTime(words, seconds!, fps)).toBe(expected);
    for (const boundary of [1, 30, 1001, 50000]) {
      const start = boundary / fps;
      const adjacent = [
        { text: "before", start: start - frame, end: start },
        { text: "after", start, end: start + 2 * frame },
      ];
      expect(wordAtTime(adjacent, start, fps)).toBe(1);
    }
  });

  it("chooses the last word intersecting a frame and applies the microsecond tolerance", () => {
    const words = [
      { text: "first", start: 0, end: 0.5 * frame },
      { text: "last in frame", start: 0.6 * frame, end: frame },
      { text: "next", start: frame, end: 2 * frame },
    ];
    expect(wordAtTime(words, 0, fps)).toBe(1);
    expect(wordAtTime(words, frame, fps)).toBe(2);
    expect(wordAtTime([{ text: "tiny tail", start: 0, end: frame + 0.5e-6 }], frame, fps)).toBe(-1);
    expect(wordAtTime([{ text: "tiny head", start: frame - 0.5e-6, end: 2 * frame }], 0, fps)).toBe(
      -1,
    );
    const nested = [
      { text: "long overlap", start: 0, end: 10 * frame },
      { text: "short overlap", start: frame, end: 2 * frame },
    ];
    expect(wordAtTime(nested, frame, fps)).toBe(1);
    expect(wordAtTime(nested, 3 * frame, fps)).toBe(0);
    expect(wordAtTime(nested, 10 * frame, fps)).toBe(-1);
  });

  it("seeks every word in a varied fixture onto its own active frame", () => {
    let cursor = 0;
    const words: TranscriptWord[] = Array.from({ length: 250 }, (_, i) => {
      const start = cursor + ((i * 17) % 13) / 1000;
      const end = start + 0.14 + ((i * 23) % 71) / 1000;
      cursor = end + ((i * 19) % 29) / 1000;
      return { text: String(i), start, end };
    });
    for (const [index, word] of words.entries()) {
      const target = seekTime(word.start, fps);
      expect(target + 1e-6).toBeGreaterThanOrEqual(word.start);
      expect(target * fps).toBeCloseTo(Math.round(target * fps), 8);
      expect(wordAtTime(words, target, fps)).toBe(index);
    }
    expect(seekTime(30 * frame, fps)).toBeCloseTo(30 * frame, 10);
    expect(seekTime(30 * frame + 0.5e-6, fps)).toBeCloseTo(30 * frame, 10);
    expect(seekTime(30.2 * frame, fps)).toBeCloseTo(31 * frame, 10);
    expect(seekTime(0, fps)).toBe(0);
  });

  it("holds the follow position in silence using half a frame of tolerance", () => {
    const words = [
      { text: "first", start: 2 * frame, end: 3 * frame },
      { text: "second", start: 6 * frame, end: 7 * frame },
    ];
    expect(lastWordBefore(words, frame, fps)).toBe(-1);
    expect(lastWordBefore(words, 1.5 * frame, fps)).toBe(0);
    expect(lastWordBefore(words, 4 * frame, fps)).toBe(0);
    expect(lastWordBefore(words, 6 * frame, fps)).toBe(1);
    expect(lastWordBefore(words, 100, fps)).toBe(1);
  });
});

it("handles empty words and invalid lookup inputs", () => {
  expect(wordAtTime([], 1, 30)).toBe(-1);
  expect(lastWordBefore([], 1, 30)).toBe(-1);
  for (const fps of [0, -1, Infinity, NaN]) {
    expect(wordAtTime([{ text: "word", start: 0, end: 1 }], 0, fps)).toBe(-1);
    expect(lastWordBefore([], 1, fps)).toBe(-1);
  }
});

describe("PlayheadClock", () => {
  it("stays still without advancing samples", () => {
    const clock = new PlayheadClock();
    expect(clock.now(0)).toBe(0);
    clock.sample(2, 0);
    clock.sample(2, 100);
    expect(clock.playing).toBe(false);
    expect(clock.now(10000)).toBe(2);
  });

  it("smooths 1x playback with jitter, compensates latency and caps extrapolation", () => {
    const clock = new PlayheadClock();
    clock.sample(10, 0);
    clock.sample(10.1, 100);
    clock.sample(10.2, 210);
    clock.sample(10.3, 300);
    expect(clock.playing).toBe(true);
    expect(clock.rate).toBeCloseTo(1, 1);
    expect(clock.now(400)).toBeCloseTo(10.45, 2);
    expect(clock.now(10000)).toBeCloseTo(10.7, 10);
    const custom = new PlayheadClock({ latency: 0, maxExtrapolation: 0.2 });
    custom.sample(0, 0);
    custom.sample(0.1, 100);
    expect(custom.now(100)).toBe(0.1);
    expect(custom.now(200)).toBeCloseTo(0.2, 10);
    expect(custom.now(10000)).toBeCloseTo(0.3, 10);
  });

  it("stops immediately on pause and backwards scrubs and detects playback again", () => {
    const clock = new PlayheadClock();
    clock.sample(2, 0);
    clock.sample(2.1, 100);
    clock.sample(2.1, 200);
    expect(clock.playing).toBe(false);
    expect(clock.now(400)).toBe(2.1);
    clock.sample(2.2, 300);
    expect(clock.playing).toBe(true);
    clock.sample(1, 400);
    expect(clock.playing).toBe(false);
    expect(clock.now(500)).toBe(1);
    clock.sample(1.1, 500);
    expect(clock.playing).toBe(true);
    expect(clock.rate).toBeCloseTo(1, 10);
  });

  it("ignores stale and duplicate read IDs without disturbing playback or its baseline", () => {
    const clock = new PlayheadClock({ latency: 0 });
    clock.sample(2, 0, 10);
    clock.sample(2.1, 100, 12);
    clock.sample(1, 200, 11);
    clock.sample(20, 300, 12);
    expect(clock.playing).toBe(true);
    expect(clock.now(200)).toBeCloseTo(2.2, 10);
    clock.sample(2.2, 200);
    clock.sample(0, 400, 11);
    expect(clock.now(200)).toBeCloseTo(2.2, 10);
  });

  it("resets on jumps, invalid rates, and nonadvancing wall time", () => {
    const clock = new PlayheadClock();
    clock.sample(0, 0);
    clock.sample(0.1, 100);
    clock.sample(5, 200);
    expect(clock.playing).toBe(false);
    expect(clock.now(300)).toBe(5);
    clock.sample(5.1, 300);
    expect(clock.playing).toBe(true);
    for (const [seconds, atMs] of [
      [5.11, 400],
      [5.9, 500],
      [6, 500],
    ]) {
      clock.sample(seconds!, atMs!);
      expect(clock.playing).toBe(false);
      expect(clock.now(1000)).toBe(seconds);
    }
    clock.sample(NaN, 600);
    expect(clock.now(1000)).toBe(6);
  });

  it.each([0.25, 4])("recognises the supported playback rate boundary %sx", (rate) => {
    const clock = new PlayheadClock({ latency: 0 });
    clock.sample(1, 0);
    clock.sample(1 + rate / 10, 100);
    expect(clock.playing).toBe(true);
    expect(clock.rate).toBeCloseTo(rate, 10);
  });
});
