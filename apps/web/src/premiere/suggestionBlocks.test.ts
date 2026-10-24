import { describe, expect, it } from "vite-plus/test";
import {
  markerColors,
  parseSuggestion,
  shotMarkers,
  shotsCsv,
  suggestionKind,
} from "./suggestionBlocks";

describe("suggestions", () => {
  it("parses frame timecodes and optional marker values", () => {
    expect(
      parseSuggestion(
        "axis-markers",
        '[{"time":"00:01:02:03","name":"Beat","comment":"Cut","color":"red","duration":2}]',
        24,
      ),
    ).toEqual({
      kind: "markers",
      markers: [{ time: 62.125, name: "Beat", comment: "Cut", color: "red", duration: 2 }],
    });
    expect(markerColors).toEqual({
      green: 0,
      red: 1,
      purple: 2,
      magenta: 2,
      orange: 3,
      yellow: 4,
      blue: 6,
      cyan: 7,
    });
  });
  it.each([
    "no json",
    "{}",
    "[]",
    '[{"time":-1,"name":"x"}]',
    '[{"time":1,"name":"x","duration":-1}]',
    '[{"time":1,"name":2}]',
    '[{"time":1,"name":"x","color":"white"}]',
    '[{"time":"00:00:01:24","name":"x"}]',
    '[{"time":"01:02","name":"x"}]',
    '[{"time":1,"name":"x","extra":true}]',
    JSON.stringify(Array.from({ length: 201 }, () => ({ time: 1, name: "Beat" }))),
    " ".repeat(600001),
  ])("rejects malformed or oversized marker data %#", (source) => {
    expect(parseSuggestion("axis-markers", source, 24).kind).toBe("invalid");
  });
  it("normalizes shots to connector field names and builds marker payloads", () => {
    const parsed = parseSuggestion(
      "axis-shots",
      '[{"shot":"1","in":"00:00:01:00","out":"00:00:04:12","description":"Hero arrives","source":"Hero.mov","notes":"Hold","status":"done"}]',
      24,
    );
    expect(parsed).toEqual({
      kind: "shots",
      shots: [
        {
          shotId: "1",
          timelineInSeconds: 1,
          timelineOutSeconds: 4.5,
          durationSeconds: 3.5,
          rationale: "Hero arrives",
          assetName: "Hero.mov",
          notes: "Hold",
          status: "done",
        },
      ],
    });
    if (parsed.kind !== "shots") throw new Error("Expected shots");
    expect(shotMarkers(parsed.shots)).toEqual([
      {
        time: 1,
        duration: 3.5,
        name: "Shot 1",
        comment: "Hero arrives\nHero.mov\nHold",
        color: "green",
      },
    ]);
  });
  it.each([
    [{ shot: "1", in: 5, out: 1, description: "Bad" }],
    [{ shot: "1", in: 1, out: 1, description: "Empty" }],
    [{ shot: "", in: 0, out: 1, description: "No ID" }],
    [
      { shot: "1", in: 0, out: 1, description: "A" },
      { shot: "1", in: 2, out: 3, description: "B" },
    ],
    [{ shot: "1", in: 0, out: 1, description: "A", status: "invalid" }],
  ])("rejects invalid shot ranges or IDs %#", (...rows) => {
    expect(parseSuggestion("axis-shots", JSON.stringify(rows), 24).kind).toBe("invalid");
  });
  it("exports connector-compatible CSV with quotes, newlines and formula protection", () => {
    expect(
      shotsCsv([
        {
          shotId: "1",
          timelineInSeconds: 1,
          timelineOutSeconds: 2,
          durationSeconds: 1,
          rationale: 'A, "B"\nC',
          assetName: "=BAD()",
          notes: "",
          status: "todo",
        },
      ]),
    ).toBe(
      '"shot_id","timeline_in_seconds","timeline_out_seconds","duration_seconds","rationale","asset_name","notes","status"\r\n"1","1","2","1","A, ""B""\nC","\'=BAD()","","todo"',
    );
  });

  it("caps shots at 200 and preserves the maximum valid marker batch", () => {
    const shots = Array.from({ length: 201 }, (_, shot) => ({
      shot: String(shot),
      in: shot,
      out: shot + 1,
      description: "Cut",
    }));
    expect(parseSuggestion("axis-shots", JSON.stringify(shots), 24).kind).toBe("invalid");
    const markers = Array.from({ length: 200 }, (_, time) => ({ time, name: "Beat" }));
    const result = parseSuggestion("axis-markers", JSON.stringify(markers), 24);
    expect(result.kind === "markers" && result.markers.length).toBe(200);
  });
});

describe("suggestionKind", () => {
  const shots = JSON.stringify([
    { shot: "OPEN-01", in: "00:00:00:00", out: "00:00:02:36", description: "Cold open" },
  ]);
  it("keeps explicit Axis fences", () => {
    expect(suggestionKind("axis-markers", "[]", 60)).toBe("axis-markers");
  });
  it("recognizes a valid shot list in a plain JSON fence", () => {
    expect(suggestionKind("json", shots, 60)).toBe("axis-shots");
    expect(suggestionKind("", shots, 60)).toBe("axis-shots");
  });
  it("recognizes markers in a plain JSON fence", () => {
    expect(suggestionKind("json", JSON.stringify([{ time: 12, name: "Hit" }]), 60)).toBe(
      "axis-markers",
    );
  });
  it("leaves other code alone", () => {
    expect(suggestionKind("json", '{"a":1}', 60)).toBeNull();
    expect(suggestionKind("ts", shots, 60)).toBeNull();
  });
});
