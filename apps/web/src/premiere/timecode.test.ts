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

  it("ignores ratios, versions and invalid minutes", () => {
    expect(seconds("16:9 frame, v1.2:3, 12:75, 10.5:30, http://a:80")).toEqual([]);
  });

  it("reports where each timestamp sits in the text", () => {
    expect(findTimecodes("Go to 00:10 now").map(({ index, text }) => ({ index, text }))).toEqual([
      { index: 6, text: "00:10" },
    ]);
  });
});
