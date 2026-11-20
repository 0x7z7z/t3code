import { describe, expect, it } from "vite-plus/test";
import { findTimecodes } from "./timecode";

const seconds = (text: string, fps = 25) => findTimecodes(text).map((match) => match.seconds(fps));

describe("findTimecodes", () => {
  it("reads Premiere timecode, clock times and decimal seconds", () => {
    expect(seconds("Cut at 00:21:26:17 then 23:05.7, and 1:02:03.", 25)).toEqual([
      21 * 60 + 26 + 17 / 25,
      23 * 60 + 5.7,
      3600 + 2 * 60 + 3,
    ]);
    expect(findTimecodes("at 00:00:01;12 drop frame")[0]?.seconds(30)).toBeCloseTo(1.4);
  });

  it("counts fractional-rate timecode the way Premiere does", () => {
    const ntsc30 = 30000 / 1001;
    const ntsc60 = 60000 / 1001;
    const frame = (text: string, fps: number) =>
      Math.round(findTimecodes(text)[0]!.seconds(fps) * fps);
    expect(frame("01:00:00:00", ntsc30)).toBe(108000);
    expect(frame("00:01:00;02", ntsc30)).toBe(1800);
    expect(frame("00:10:00;00", ntsc30)).toBe(17982);
    expect(frame("00:09:00;04", ntsc60)).toBe(32368);
    expect(frame("00:00:10:12", 23.976)).toBe(252);
  });

  it("does not move the playhead for a frame number the rate cannot have", () => {
    expect(seconds("00:00:11:45", 24)[0]).toBeNaN();
    // 00:01:00;00 is skipped in 29.97 drop-frame timecode.
    expect(seconds("00:01:00;00", 30000 / 1001)[0]).toBeNaN();
    expect(seconds("00:00:11:23", 24)[0]).toBeCloseTo(11 + 23 / 24);
  });

  it("ignores ratios, versions and invalid minutes", () => {
    expect(seconds("16:9 frame, v1.2:3, 12:75, 10.5:30, http://a:80")).toEqual([]);
  });

  it("reports where each timestamp sits in the text", () => {
    expect(findTimecodes("Go to 00:10 now").map(({ index, text }) => ({ index, text }))).toEqual([
      { index: 6, text: "00:10" },
    ]);
  });
});
