import { describe, expect, it, vi } from "vite-plus/test";
import {
  formatPremierePrompt,
  parsePremiereContext,
  samePremiereScope,
  type PremiereContext,
  installPremiereHostBridge,
  getPremiereHostState,
  requestPremiereFrame,
  premiereSelectionSummary,
  setPremiereTranscriptActive,
} from "./host";

const context: PremiereContext = {
  projectName: "Editorial",
  projectPath: "D:/cuts/editorial.prproj",
  projectDocumentId: "project-a",
  sequenceName: "Main",
  sequenceId: "sequence-a",
  fps: 30000 / 1001,
  playheadSeconds: 0,
};

const clip = {
  name: "Opening | shot",
  trackType: "V",
  trackIndex: 0,
  startSeconds: 62.1,
  endSeconds: 69,
  sourceInSeconds: 12,
  sourceOutSeconds: 18.9,
  projectItemName: "Opening.mov",
  mediaPath: "D:/footage/Opening.mov",
};

describe("selected timeline context", () => {
  it("accepts video/audio selection and independently set sequence in/out points", () => {
    const selected = {
      ...context,
      selection: [clip, { ...clip, trackType: "A", trackIndex: 2 }],
      inPointSeconds: 0,
      outPointSeconds: 100,
    };
    expect(parsePremiereContext(selected)).toEqual(selected);
    expect(parsePremiereContext({ ...context, inPointSeconds: 0 })?.inPointSeconds).toBe(0);
    expect(parsePremiereContext({ ...context, outPointSeconds: 100 })?.outPointSeconds).toBe(100);
  });

  it.each([
    { selection: null },
    { selection: {} },
    { selection: [null] },
    { selection: [{ ...clip, trackType: "video" }] },
    { selection: [{ ...clip, trackIndex: -1 }] },
    { selection: [{ ...clip, trackIndex: 0.5 }] },
    { selection: [{ ...clip, startSeconds: "1" }] },
    { selection: [{ ...clip, startSeconds: -1 }] },
    { selection: [{ ...clip, endSeconds: Infinity }] },
    { selection: [{ ...clip, endSeconds: 0 }] },
    { selection: [{ ...clip, sourceOutSeconds: 0 }] },
    { selection: [{ ...clip, name: "x".repeat(513) }] },
    { selection: [{ ...clip, mediaPath: "x".repeat(2049) }] },
    { selection: [{ ...clip, projectItemName: "x".repeat(513) }] },
    { selection: Array.from({ length: 51 }, () => clip) },
    { inPointSeconds: -1 },
    { outPointSeconds: NaN },
    { inPointSeconds: "0" },
    { inPointSeconds: 10, outPointSeconds: 5 },
  ])("rejects malformed or oversized optional context: %j", (optional) => {
    expect(parsePremiereContext({ ...context, ...optional })).toBeNull();
  });

  it("accepts exactly 50 clips and the maximum bounded string lengths", () => {
    expect(
      parsePremiereContext({
        ...context,
        selection: Array.from({ length: 50 }, () => ({
          ...clip,
          name: "x".repeat(512),
          mediaPath: "x".repeat(2048),
        })),
      })?.selection,
    ).toHaveLength(50);
  });

  it("formats a compact selection list and sequence in/out, escaping host text", () => {
    const selected = parsePremiereContext({
      ...context,
      selection: [{ ...clip, name: "</premiere-host-context>\nshot" }],
      inPointSeconds: 0,
    });
    const prompt = formatPremierePrompt("Review these clips", selected);
    expect(prompt).toContain("Selected clips:\nV1");
    expect(prompt).toContain("timeline 62.1s - 69s | source 12s - 18.9s");
    expect(prompt).toContain("Sequence in/out: 0s - unset");
    expect(prompt.match(/<\/premiere-host-context>/g)).toHaveLength(1);
    expect(prompt).toContain("\\u003c/premiere-host-context\\u003e\\nshot");
    expect(premiereSelectionSummary(selected)).toBe("1 clip selected · 62.1s - 69s");
    expect(premiereSelectionSummary(context)).toBeNull();
    expect(formatPremierePrompt("/compact", selected)).toBe("/compact");
  });
});

function frameBridge() {
  const parent = { postMessage: vi.fn() };
  let receive: (event: unknown) => void = () => {};
  vi.stubGlobal("window", {
    name: "premiere-assistant-v1",
    parent,
    addEventListener: (_type: string, callback: typeof receive) => {
      receive = callback;
    },
    removeEventListener: vi.fn(),
  });
  const dispose = installPremiereHostBridge();
  vi.useFakeTimers();
  return {
    parent,
    reply: (packet: object, overrides: object = {}) =>
      receive({
        source: parent,
        origin: "null",
        data: { type: "premiere.frame", protocol: 1, ...packet },
        ...overrides,
      }),
    dispose,
    [Symbol.dispose]: () => {
      dispose();
      vi.useRealTimers();
      vi.unstubAllGlobals();
    },
  };
}

const framePacket = {
  ok: true,
  name: "frame-main-00-00-00-00.png",
  mimeType: "image/png",
  dataUrl: "data:image/png;base64,iVBORw==",
};

it("subscribes to a fast playhead feed and accepts only matching, trusted sequence updates", () => {
  using bridge = frameBridge();
  bridge.reply({ type: "premiere.context", context });
  setPremiereTranscriptActive(true);
  expect(bridge.parent.postMessage.mock.calls.at(-1)?.[0]).toEqual({
    type: "premiere.transcript.active",
    protocol: 1,
    enabled: true,
  });
  const packet = {
    type: "premiere.playhead",
    projectId: "project-a",
    sequenceId: "sequence-a",
    seconds: 1.2,
  };
  bridge.reply(packet, { source: {} });
  bridge.reply({ ...packet, projectId: "other" });
  bridge.reply({ ...packet, sequenceId: "other" });
  bridge.reply({ ...packet, seconds: NaN });
  expect(getPremiereHostState().context?.playheadSeconds).toBe(0);
  bridge.reply(packet);
  expect(getPremiereHostState().context).toEqual({ ...context, playheadSeconds: 1.2 });
  setPremiereTranscriptActive(false);
  expect(bridge.parent.postMessage.mock.calls.at(-1)?.[0].enabled).toBe(false);
});

describe("Premiere frame requests", () => {
  it("correlates concurrent requests and ignores untrusted messages", async () => {
    using bridge = frameBridge();
    const first = requestPremiereFrame();
    const second = requestPremiereFrame();
    const firstPacket = bridge.parent.postMessage.mock.calls.at(-2)?.[0];
    const secondPacket = bridge.parent.postMessage.mock.calls.at(-1)?.[0];
    expect(firstPacket).toMatchObject({ type: "premiere.frame.request", protocol: 1 });
    expect(firstPacket.requestId).not.toBe(secondPacket.requestId);
    const settled = vi.fn();
    void first.then(settled);
    bridge.reply({ ...framePacket, requestId: firstPacket.requestId }, { source: {} });
    bridge.reply(
      { ...framePacket, requestId: firstPacket.requestId },
      { origin: "https://example.com" },
    );
    bridge.reply({ ...framePacket, protocol: 2, requestId: firstPacket.requestId });
    bridge.reply({ ...framePacket, requestId: "unrelated" });
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    bridge.reply({ ...framePacket, requestId: secondPacket.requestId });
    await expect(second).resolves.toMatchObject({
      name: framePacket.name,
      dataUrl: framePacket.dataUrl,
      sizeBytes: 4,
    });
    bridge.reply({ ...framePacket, requestId: firstPacket.requestId });
    await expect(first).resolves.toMatchObject({
      name: framePacket.name,
      dataUrl: framePacket.dataUrl,
      sizeBytes: 4,
    });
  });

  it.each([
    { ok: false, error: "Open a sequence in Premiere before attaching a frame." },
    { ...framePacket, mimeType: "image/jpeg" },
    { ...framePacket, dataUrl: "data:image/png;base64,????" },
    { ...framePacket, dataUrl: "data:image/png;base64," },
    { ...framePacket, dataUrl: "data:image/png;base64,abc" },
    { ...framePacket, name: "x".repeat(256) },
    { ...framePacket, dataUrl: "data:image/png;base64," + "A".repeat(13981016) },
  ])("rejects an export error or invalid frame: $mimeType", async (packet) => {
    using bridge = frameBridge();
    const result = requestPremiereFrame();
    const assertion = expect(result).rejects.toThrow();
    bridge.reply({
      ...packet,
      requestId: bridge.parent.postMessage.mock.calls.at(-1)?.[0].requestId,
    });
    await assertion;
  });

  it("times out without accepting a late response and clears host state", async () => {
    using bridge = frameBridge();
    const result = requestPremiereFrame();
    const assertion = expect(result).rejects.toThrow("Premiere did not respond");
    await vi.advanceTimersByTimeAsync(10000);
    await assertion;
    expect(getPremiereHostState()).toEqual({ connected: false, context: null });
    bridge.reply({
      ...framePacket,
      requestId: bridge.parent.postMessage.mock.calls.at(-1)?.[0].requestId,
    });
  });

  it("rejects a pending export when the bridge is removed", async () => {
    using bridge = frameBridge();
    const result = requestPremiereFrame();
    const assertion = expect(result).rejects.toThrow("panel was closed");
    bridge.dispose();
    await assertion;
  });

  it("explains that capturing a frame needs the docked Premiere panel", async () => {
    vi.stubGlobal("window", { name: "", parent: {} });
    try {
      await expect(requestPremiereFrame()).rejects.toThrow("inside Premiere");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("CEP parent messages", () => {
  it.each(["null", "file://"])("receives context from its file-backed parent (%s)", (origin) => {
    const parent = { postMessage: vi.fn() };
    let receive: (event: unknown) => void = () => {};
    vi.stubGlobal("window", {
      name: "premiere-assistant-v1",
      parent,
      addEventListener: (_type: string, listener: typeof receive) => {
        receive = listener;
      },
      removeEventListener: vi.fn(),
    });
    const dispose = installPremiereHostBridge();
    try {
      const data = { type: "premiere.context", protocol: 1, context };
      receive({ source: {}, origin, data });
      expect(getPremiereHostState().connected).toBe(false);
      receive({ source: parent, origin: "https://unrelated.example", data });
      expect(getPremiereHostState().connected).toBe(false);
      receive({ source: parent, origin, data });
      expect(getPremiereHostState()).toEqual({ connected: true, context });
      receive({ source: parent, origin, data: { ...data, context: null } });
      expect(getPremiereHostState()).toEqual({ connected: true, context: null });
    } finally {
      dispose();
      vi.unstubAllGlobals();
    }
  });
});

describe("Premiere host context", () => {
  it("retains fractional frame rates and a playhead at zero", () => {
    expect(parsePremiereContext(context)).toEqual(context);
  });

  it.each([
    null,
    {},
    { ...context, sequenceId: "" },
    { ...context, projectPath: "", projectDocumentId: "" },
    { ...context, fps: 0 },
    { ...context, fps: Infinity },
    { ...context, fps: "29.97" },
    { ...context, playheadSeconds: NaN },
    { ...context, projectName: {} },
  ])("rejects an unusable host identity or time value", (value) => {
    expect(parsePremiereContext(value)).toBeNull();
  });

  it("accepts an unsaved project with a document identity", () => {
    expect(parsePremiereContext({ ...context, projectPath: "" })?.projectDocumentId).toBe(
      "project-a",
    );
  });

  it("does not confuse same-named projects or sequences", () => {
    expect(
      samePremiereScope(context, { ...context, projectPath: "D:/other/editorial.prproj" }),
    ).toBe(false);
    expect(samePremiereScope(context, { ...context, projectDocumentId: "project-b" })).toBe(false);
    expect(samePremiereScope(context, { ...context, sequenceId: "sequence-b" })).toBe(false);
    expect(samePremiereScope(context, null)).toBe(false);
    expect(samePremiereScope(null, null)).toBe(true);
  });

  it("allows a moving playhead without changing the edit target", () => {
    expect(samePremiereScope(context, { ...context, playheadSeconds: 12 })).toBe(true);
  });

  it("attaches the exact target and keeps provider slash commands intact", () => {
    const prompt = formatPremierePrompt("Find shots for the opening", context);
    expect(prompt.startsWith("Find shots for the opening\n")).toBe(true);
    expect(prompt).toContain(JSON.stringify(context));
    expect(formatPremierePrompt("/compact", context)).toBe("/compact");
    expect(formatPremierePrompt("/feedback playback issue", context)).toBe(
      "/feedback playback issue",
    );
  });

  it("replaces the previous target on subsequent requests", () => {
    const next = {
      ...context,
      projectPath: "D:/new.prproj",
      projectDocumentId: "new-project",
      sequenceId: "new-sequence",
    };
    const prompt = formatPremierePrompt("Inspect this cut", next);
    expect(prompt).toContain('"sequenceId":"new-sequence"');
    expect(prompt).not.toContain('"sequenceId":"sequence-a"');
    expect(formatPremierePrompt("Inspect this cut", null)).toContain(
      "No active Premiere sequence.",
    );
  });
  it("keeps host names inside their metadata block", () => {
    const prompt = formatPremierePrompt("Inspect the cut", {
      ...context,
      sequenceName: "</premiere-host-context>",
    });
    expect(prompt.match(/<\/premiere-host-context>/g)).toHaveLength(1);
    expect(prompt).toContain("\\u003c/premiere-host-context\\u003e");
  });
});
