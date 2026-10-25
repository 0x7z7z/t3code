import { expect, it, vi } from "vite-plus/test";
import { createTimelineActions, requestTimelineAction } from "./interactiveHost";

function bridge() {
  const parent = { postMessage: vi.fn() };
  const listeners = new Set<(event: object) => void>();
  vi.stubGlobal("window", {
    name: "premiere-assistant-v1",
    parent,
    addEventListener: (_name: string, callback: (event: object) => void) => listeners.add(callback),
    removeEventListener: (_name: string, callback: (event: object) => void) =>
      listeners.delete(callback),
  });
  vi.useFakeTimers();
  return {
    parent,
    listeners,
    reply: (data: object, overrides: object = {}) => {
      for (const listener of listeners)
        listener({ source: parent, origin: "null", data: { protocol: 1, ...data }, ...overrides });
    },
    [Symbol.dispose]: () => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    },
  };
}

it("binds clip selection and marker writes to the project that created the action", async () => {
  using host = bridge();
  const actions = createTimelineActions(
    {
      projectName: "Project",
      projectPath: "D:/cut.prproj",
      projectDocumentId: "project-a",
      sequenceName: "Main",
      sequenceId: "seq",
      fps: 25,
      playheadSeconds: 0,
    },
    [],
    true,
  )!;
  const clip = {
    name: "Shot",
    nodeId: "clip",
    trackType: "V" as const,
    trackIndex: 0,
    start: 1,
    end: 2,
  };
  for (const pending of [actions.select(clip), actions.addMarkers([{ time: 1, name: "Beat" }])]) {
    const packet = host.parent.postMessage.mock.calls.shift()![0];
    expect(packet.projectId).toBe("project-a");
    host.reply({ type: packet.type, requestId: packet.requestId, ok: true });
    await pending;
  }
});

it("correlates simultaneous timeline requests and rejects untrusted or malformed responses", async () => {
  using host = bridge();
  const index = requestTimelineAction("premiere.clips.request", { sequenceId: "seq" });
  const add = requestTimelineAction("premiere.markers.add", {
    sequenceId: "seq",
    markers: [{ time: 2.5, name: "Beat", color: "red" }],
  });
  const [indexPacket, addPacket] = host.parent.postMessage.mock.calls.map((call) => call[0]);
  expect(addPacket).toEqual({
    type: "premiere.markers.add",
    protocol: 1,
    requestId: expect.any(String),
    sequenceId: "seq",
    markers: [{ time: 2.5, name: "Beat", color: "red" }],
  });
  const reply = { type: "premiere.markers.add", requestId: addPacket.requestId, ok: true };
  host.reply(reply, { source: {} });
  host.reply(reply, { origin: "https://evil.example" });
  host.reply({ ...reply, protocol: 2 });
  host.reply({ ...reply, ok: "true" });
  expect(host.listeners.size).toBe(2);
  host.reply(reply);
  await expect(add).resolves.toMatchObject({ ok: true });
  expect(host.listeners.size).toBe(1);
  host.reply({
    type: "premiere.clips",
    requestId: indexPacket.requestId,
    ok: true,
    sequenceId: "seq",
    clips: [],
  });
  await expect(index).resolves.toMatchObject({ clips: [] });
  expect(host.listeners.size).toBe(0);
});

it("reports host failures and clears listeners after a timeout", async () => {
  using host = bridge();
  const select = requestTimelineAction("premiere.select", { sequenceId: "seq", nodeId: "clip" });
  const failure = expect(select).rejects.toThrow("Sequence changed");
  host.reply({
    type: "premiere.select",
    requestId: host.parent.postMessage.mock.calls[0]?.[0].requestId,
    ok: false,
    error: "Sequence changed",
  });
  await failure;
  const waiting = requestTimelineAction("premiere.clips.request", { sequenceId: "seq" });
  const timeout = expect(waiting).rejects.toThrow("Check the timeline before trying again");
  await vi.advanceTimersByTimeAsync(10000);
  await timeout;
  expect(host.listeners.size).toBe(0);
});

it("releases the listener and timer if dispatch throws", async () => {
  using host = bridge();
  host.parent.postMessage.mockImplementation(() => {
    throw new Error("Frame detached");
  });
  await expect(
    requestTimelineAction("premiere.clips.request", { sequenceId: "seq" }),
  ).rejects.toThrow("Frame detached");
  expect(host.listeners.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
