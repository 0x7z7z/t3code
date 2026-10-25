import { expect, it, vi } from "vite-plus/test";
import { cutTranscriptRange, requestTimelineSnapshot, restoreTimeline } from "./timelineHost";

function fixture() {
  const postMessage = vi.fn();
  const parent = { postMessage };
  const listeners = new Set<(event: unknown) => void>();
  vi.stubGlobal("window", {
    name: "premiere-assistant-v1",
    parent,
    addEventListener: (_type: string, listener: (event: unknown) => void) =>
      listeners.add(listener),
    removeEventListener: (_type: string, listener: (event: unknown) => void) =>
      listeners.delete(listener),
  });
  const send = (data: object, source: object = parent, origin = "null") => {
    const packet = postMessage.mock.calls.at(-1)![0];
    for (const listener of listeners)
      listener({
        source,
        origin,
        data: {
          type: packet.type.replace(".request", ""),
          protocol: 1,
          requestId: packet.requestId,
          ...data,
        },
      });
  };
  const snapshot = {
    projectId: "project",
    sequenceId: "sequence",
    name: "Main",
    videoTrackCount: 0,
    audioTrackCount: 0,
    videoTracks: [],
    audioTracks: [],
    markers: [],
    inPoint: null,
    outPoint: null,
    truncated: false,
  };
  return { postMessage, listeners, send, snapshot };
}

it("releases the listener and timer if dispatch throws", async () => {
  const f = fixture();
  vi.useFakeTimers();
  try {
    f.postMessage.mockImplementation(() => {
      throw new Error("Frame detached");
    });
    await expect(requestTimelineSnapshot(true, "sequence")).rejects.toThrow("Frame detached");
    expect(f.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it("correlates checkpointed cut replies and keeps recovery data for partial failures", async () => {
  const f = fixture();
  try {
    const pending = cutTranscriptRange({
      sequenceId: "sequence",
      projectId: "project",
      start: 1,
      end: 2,
    });
    expect(f.postMessage.mock.calls[0]![0]).toMatchObject({
      type: "premiere.cut.request",
      start: 1,
      end: 2,
    });
    f.send({
      ok: true,
      snapshot: f.snapshot,
      signature: "after",
      checkpointId: "saved",
      checkpointSignature: "before",
      cutError: "Razor failed",
    });
    await expect(pending).resolves.toEqual({
      checkpointId: "saved",
      checkpointSignature: "before",
      expectedSignature: "after",
      cutError: "Razor failed",
    });
    const malformed = cutTranscriptRange({
      sequenceId: "sequence",
      projectId: "project",
      start: 1,
      end: 2,
    });
    f.send({ ok: true, snapshot: f.snapshot, signature: "after", checkpointId: null });
    await expect(malformed).rejects.toThrow("Invalid cut response");
    expect(f.listeners.size).toBe(0);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("correlates snapshots and ignores impostor windows, origins, protocols and request IDs", async () => {
  const f = fixture();
  try {
    const pending = requestTimelineSnapshot(true, "sequence");
    const packet = {
      ok: true,
      snapshot: f.snapshot,
      signature: "snapshot",
      checkpointId: "checkpoint",
      checkpointSignature: "checkpoint",
      checkpointError: null,
      checkpointIds: ["checkpoint"],
    };
    f.send(packet, {});
    f.send(packet, undefined, "https://untrusted.test");
    f.send({ ...packet, protocol: 2 });
    f.send({ ...packet, requestId: "another-request" });
    expect(f.listeners.size).toBe(1);
    f.send(packet);
    expect((await pending).snapshot).toEqual(f.snapshot);
    expect(f.listeners.size).toBe(0);
    expect(f.postMessage.mock.calls[0]![0]).toMatchObject({
      checkpoint: true,
      sequenceId: "sequence",
      type: "premiere.snapshot.request",
    });
  } finally {
    vi.unstubAllGlobals();
  }
});

it("rejects malformed snapshot data and surfaces explicit host errors", async () => {
  const f = fixture();
  try {
    const malformed = requestTimelineSnapshot(false);
    f.send({ ok: true, snapshot: { ...f.snapshot, videoTrackCount: NaN } });
    await expect(malformed).rejects.toThrow("invalid timeline snapshot");
    const failed = requestTimelineSnapshot(false);
    f.send({ ok: false, error: "Open a sequence first." });
    await expect(failed).rejects.toThrow("Open a sequence first.");
    expect(f.listeners.size).toBe(0);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("sends restore guards and accepts only a successful matching reply", async () => {
  const f = fixture();
  try {
    const fields = {
      checkpointId: "checkpoint",
      sequenceId: "sequence",
      expectedSignature: "after",
      checkpointSignature: "before",
      turnNumber: 2,
    };
    const pending = restoreTimeline(fields);
    expect(f.postMessage.mock.calls[0]![0]).toMatchObject({
      type: "premiere.restore.request",
      ...fields,
    });
    f.send({ ok: true });
    await pending;
    expect(f.listeners.size).toBe(0);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("cleans up timed-out timeline requests without retrying an operation", async () => {
  const f = fixture();
  vi.useFakeTimers();
  try {
    const pending = requestTimelineSnapshot(true);
    const rejected = expect(pending).rejects.toThrow("Premiere did not respond");
    await vi.advanceTimersByTimeAsync(15000);
    await rejected;
    expect(f.listeners.size).toBe(0);
    expect(f.postMessage).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
