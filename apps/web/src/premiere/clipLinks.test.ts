import { describe, expect, it } from "vite-plus/test";
import { clipNames, findClipNames, parseClipIndex, type TimelineClip } from "./clipLinks";

const clip = (name: string): TimelineClip => ({
  name,
  nodeId: name,
  trackType: "V",
  trackIndex: 0,
  start: 1,
  end: 4,
});

describe("clip links", () => {
  it("prefers the longest exact match and respects case and Unicode word boundaries", () => {
    const names = clipNames([
      clip("Hero"),
      clip("Hero closeup"),
      clip("intro.mov"),
      clip("a+b.mov"),
    ]);
    expect(
      findClipNames("Hero closeup, Hero. hero Heroic éHero Heroé intro.mov a+b.mov", names),
    ).toEqual([
      { text: "Hero closeup", index: 0 },
      { text: "Hero", index: 14 },
      { text: "intro.mov", index: 44 },
      { text: "a+b.mov", index: 54 },
    ]);
  });
  it("omits short and generic names and deduplicates the index", () => {
    expect(
      clipNames([
        clip("ab"),
        clip("Video"),
        clip("Adjustment Layer"),
        clip("Final.mov"),
        clip("Final.mov"),
      ]),
    ).toEqual(["Final.mov"]);
  });
  it("rejects malformed, oversized and reversed clip indexes", () => {
    expect(parseClipIndex([{ ...clip("a"), start: 8 }])).toBeNull();
    expect(parseClipIndex([{ ...clip("a"), nodeId: 10 }])).toBeNull();
    expect(parseClipIndex(Array.from({ length: 2001 }, () => clip("Hero")))).toBeNull();
    expect(parseClipIndex([clip("Hero")])).toEqual([clip("Hero")]);
  });
});
