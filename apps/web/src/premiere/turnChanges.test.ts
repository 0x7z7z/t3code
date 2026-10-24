import { describe, expect, it } from "vite-plus/test";
import {
  diffTimeline,
  summarizeChanges,
  readTurnChanges,
  writeTurnChanges,
  type TimelineSnapshot,
  type TurnChangeRecord,
} from "./turnChanges";
import { parseTimelineSnapshot } from "./timelineHost";

function snapshot(): TimelineSnapshot {
  return {
    projectId: "project",
    sequenceId: "sequence",
    name: "Main Edit",
    videoTrackCount: 1,
    audioTrackCount: 0,
    videoTracks: [
      {
        index: 0,
        clips: [
          {
            name: "Clip",
            nodeId: "clip",
            projectItemName: "Source",
            start: 5,
            end: 15,
            inPoint: 0,
            outPoint: 10,
            enabled: true,
          },
        ],
      },
    ],
    audioTracks: [],
    markers: [{ id: "marker", name: "Beat", start: 10, end: 10, comments: "", color: 0 }],
    inPoint: 0,
    outPoint: 15,
    truncated: false,
  };
}
function pair() {
  const before = snapshot();
  return { before, after: structuredClone(before) };
}

describe("timeline diff", () => {
  it("omits an unchanged timeline and rejects comparisons across sequences or projects", () => {
    const { before, after } = pair();
    expect(diffTimeline(before, after)).toEqual([]);
    after.sequenceId = "other";
    expect(diffTimeline(before, after)).toEqual([]);
    after.sequenceId = before.sequenceId;
    after.projectId = "other";
    expect(diffTimeline(before, after)).toEqual([]);
    expect(summarizeChanges([])).toBe("");
  });
  it("reports a head trim once without also counting it as a move", () => {
    const { before, after } = pair();
    const clip = after.videoTracks[0]!.clips[0]!;
    clip.start = 7;
    clip.inPoint = 2;
    expect(diffTimeline(before, after).map((c) => c.kind)).toEqual(["trim"]);
    expect(summarizeChanges(diffTimeline(before, after))).toBe("1 clip trimmed");
  });
  it("reports a tail trim", () => {
    const { before, after } = pair();
    after.videoTracks[0]!.clips[0]!.end = 12;
    after.videoTracks[0]!.clips[0]!.outPoint = 7;
    expect(diffTimeline(before, after)[0]?.kind).toBe("trim");
  });
  it("matches node IDs across tracks and reports a move", () => {
    const { before, after } = pair();
    after.audioTrackCount = 1;
    after.audioTracks = [{ index: 0, clips: after.videoTracks[0]!.clips.splice(0) }];
    after.audioTracks[0]!.clips[0]!.start = 20;
    after.audioTracks[0]!.clips[0]!.end = 30;
    expect(diffTimeline(before, after).map((c) => c.kind)).toEqual(["move", "tracks"]);
  });
  it("reports clip additions and removals without pairing distinct node IDs", () => {
    const { before, after } = pair();
    after.videoTracks[0]!.clips[0]!.nodeId = "new-clip";
    expect(diffTimeline(before, after).map((c) => c.kind)).toEqual(["remove", "add"]);
  });
  it("matches missing node IDs by source, track and in point, including repeated source clips", () => {
    const { before, after } = pair();
    before.videoTracks[0]!.clips[0]!.nodeId = "";
    after.videoTracks[0]!.clips[0]!.nodeId = "";
    const other = {
      ...before.videoTracks[0]!.clips[0]!,
      inPoint: 20,
      outPoint: 30,
      start: 30,
      end: 40,
    };
    before.videoTracks[0]!.clips.push(other);
    after.videoTracks[0]!.clips.unshift({ ...other });
    expect(diffTimeline(before, after)).toEqual([]);
    after.videoTracks[0]!.clips[1]!.start = 7;
    after.videoTracks[0]!.clips[1]!.inPoint = 2;
    expect(diffTimeline(before, after).map((c) => c.kind)).toEqual(["trim"]);
  });
  it("reserves reliable node matches before matching unidentified repeated sources", () => {
    const { before, after } = pair();
    before.videoTracks[0]!.clips.unshift({ ...before.videoTracks[0]!.clips[0]!, nodeId: "" });
    expect(diffTimeline(before, after).map((c) => c.kind)).toEqual(["remove"]);
  });
  it("reports a clip being disabled or renamed", () => {
    const { before, after } = pair();
    after.videoTracks[0]!.clips[0]!.enabled = false;
    expect(diffTimeline(before, after)[0]?.text).toBe("Clip disabled on V1");
    after.videoTracks[0]!.clips[0]!.enabled = true;
    after.videoTracks[0]!.clips[0]!.name = "New name";
    expect(diffTimeline(before, after)[0]?.kind).toBe("clipEdit");
  });
  it("reports marker additions and removals", () => {
    const { before, after } = pair();
    after.markers[0]!.id = "new-marker";
    expect(diffTimeline(before, after).map((c) => c.kind)).toEqual(["markerRemove", "markerAdd"]);
    expect(summarizeChanges(diffTimeline(before, after))).toBe("1 marker removed · 1 marker added");
  });
  it.each(["name", "comments", "color", "start", "end"] as const)(
    "reports marker %s edits",
    (field) => {
      const { before, after } = pair();
      const marker = after.markers[0]!;
      if (field === "name" || field === "comments") marker[field] = "Changed";
      else marker[field] = field === "color" ? 3 : field === "start" ? 9 : 11;
      expect(diffTimeline(before, after).map((c) => c.kind)).toEqual(["markerEdit"]);
    },
  );
  it("matches markers without GUIDs at their original time", () => {
    const { before, after } = pair();
    before.markers[0]!.id = "";
    after.markers[0]!.id = "";
    after.markers[0]!.name = "Changed";
    expect(diffTimeline(before, after).map((c) => c.kind)).toEqual(["markerEdit"]);
  });
  it("reports sequence ranges, track counts, and readable plural summaries", () => {
    const { before, after } = pair();
    after.inPoint = null;
    after.outPoint = 30;
    after.videoTrackCount = 2;
    const changes = diffTimeline(before, after);
    expect(changes.map((c) => c.kind)).toEqual(["range", "tracks"]);
    const trims = [0, 1, 2].map((n) => ({
      id: String(n),
      kind: "trim" as const,
      text: "trim",
      seconds: n,
    }));
    expect(
      summarizeChanges([...trims, { id: "x", kind: "remove", text: "removed", seconds: 0 }]),
    ).toBe("3 clips trimmed · 1 clip removed");
  });
});

describe("snapshot validation and bounded persistence", () => {
  it("parses complete snapshots and rejects malformed finite times and oversized collections", () => {
    const value = snapshot();
    expect(parseTimelineSnapshot(value)).toEqual(value);
    value.videoTracks[0]!.clips[0]!.start = Infinity;
    expect(parseTimelineSnapshot(value)).toBeNull();
    value.videoTracks[0]!.clips[0]!.start = 5;
    value.markers = Array(501).fill(value.markers[0]);
    expect(parseTimelineSnapshot(value)).toBeNull();
  });
  it("persists thread and turn identities and keeps at most 30 records across reloads", () => {
    const storage = new Map<string, string>();
    const adapter = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => {
        storage.set(key, value);
      },
    };
    const records = Array.from({ length: 35 }, (_, n): TurnChangeRecord => ({
      threadId: `thread-${n}`,
      turnId: `turn-${n}`,
      messageId: `message-${n}`,
      turnNumber: n + 1,
      createdAt: n,
      before: snapshot(),
      checkpointId: null,
      checkpointSignature: null,
      checkpointError: null,
      changes: [],
    }));
    writeTurnChanges(adapter, records);
    const loaded = readTurnChanges(adapter);
    expect(loaded).toHaveLength(30);
    expect(loaded[0]?.turnId).toBe("turn-5");
    expect(loaded.at(-1)?.threadId).toBe("thread-34");
  });
  it("ignores corrupt storage and tolerates storage being unavailable", () => {
    expect(readTurnChanges({ getItem: () => "not JSON" })).toEqual([]);
    expect(readTurnChanges({ getItem: () => '{"wrong":true}' })).toEqual([]);
    expect(() =>
      writeTurnChanges(
        {
          setItem: () => {
            throw new Error("quota");
          },
        },
        [],
      ),
    ).not.toThrow();
  });
});
