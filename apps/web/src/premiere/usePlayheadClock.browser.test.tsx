import { expect, it, vi } from "vite-plus/test";
import { act, render } from "../../test/render";
import type { PremiereContext, PremierePlayheadSample } from "./host";
import { usePlayheadClock } from "./usePlayheadClock";

const host = vi.hoisted(() => ({
  sample: null as PremierePlayheadSample | null,
  context: null as PremiereContext | null,
  listeners: new Set<() => void>(),
}));

vi.mock("./host", () => ({
  getPremierePlayheadSample: () => host.sample,
  getPremiereHostState: () => ({ context: host.context }),
  samePremiereScope: (a: PremiereContext | null, b: PremiereContext | null) =>
    a?.sequenceId === b?.sequenceId && a?.projectDocumentId === b?.projectDocumentId,
  subscribePremiereHost: (listener: () => void) => {
    host.listeners.add(listener);
    return () => host.listeners.delete(listener);
  },
}));

function setup() {
  host.sample = { seconds: 2, receivedAt: 0, readId: 1 };
  host.context = {
    projectName: "Film",
    projectPath: "D:/Film.prproj",
    projectDocumentId: "film",
    sequenceName: "Main",
    sequenceId: "main",
    fps: 30,
    playheadSeconds: 2,
  };
  host.listeners.clear();
  return {
    emit: (sample: PremierePlayheadSample | null) =>
      act(() => {
        host.sample = sample;
        for (const listener of host.listeners) listener();
      }),
  };
}

function Clock({ enabled = true }: { enabled?: boolean }) {
  return <output aria-label="Playhead">{usePlayheadClock(enabled).toFixed(3)}</output>;
}

it("updates stationary samples without scheduling animation and stops listening when disabled", async () => {
  const f = setup();
  using now = vi.spyOn(performance, "now").mockReturnValue(0);
  await using screen = await render(<Clock />);
  using frames = vi.spyOn(window, "requestAnimationFrame");
  await expect.element(screen.getByLabelText("Playhead")).toHaveTextContent("2.000");
  now.mockReturnValue(100);
  await f.emit({ seconds: 2, receivedAt: 100, readId: 2 });
  expect(frames).not.toHaveBeenCalled();
  now.mockReturnValue(200);
  await f.emit({ seconds: 1, receivedAt: 200, readId: 3 });
  await expect.element(screen.getByLabelText("Playhead")).toHaveTextContent("1.000");
  await screen.rerender(<Clock enabled={false} />);
  expect(host.listeners.size).toBe(0);
  await f.emit({ seconds: 5, receivedAt: 300, readId: 4 });
  await expect.element(screen.getByLabelText("Playhead")).toHaveTextContent("1.000");
  await screen.rerender(<Clock />);
  await expect.element(screen.getByLabelText("Playhead")).toHaveTextContent("5.000");
  await f.emit(null);
  await expect.element(screen.getByLabelText("Playhead")).toHaveTextContent("2.000");
});

it("starts animation during playback, stops on pause, and resets on sequence changes and unmount", async () => {
  const f = setup();
  using now = vi.spyOn(performance, "now").mockReturnValue(0);
  await using screen = await render(<Clock />);
  using frames = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(7);
  using cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  now.mockReturnValue(100);
  await f.emit({ seconds: 2.1, receivedAt: 100, readId: 2 });
  expect(frames).toHaveBeenCalledTimes(1);
  await expect.element(screen.getByLabelText("Playhead")).toHaveTextContent("2.150");
  now.mockReturnValue(200);
  await f.emit({ seconds: 2.1, receivedAt: 200, readId: 3 });
  expect(cancel).toHaveBeenCalledWith(7);
  await expect.element(screen.getByLabelText("Playhead")).toHaveTextContent("2.100");
  host.context = { ...host.context!, sequenceId: "other" };
  now.mockReturnValue(300);
  await f.emit({ seconds: 2.2, receivedAt: 300, readId: 4 });
  expect(frames).toHaveBeenCalledTimes(1);
  now.mockReturnValue(400);
  await f.emit({ seconds: 2.3, receivedAt: 400, readId: 5 });
  expect(frames).toHaveBeenCalledTimes(2);
  cancel.mockClear();
  await screen.unmount();
  expect(host.listeners.size).toBe(0);
  expect(cancel).toHaveBeenCalledWith(7);
});

it("extrapolates between samples at 30 fps despite rounded animation timestamps", async () => {
  const f = setup();
  using now = vi.spyOn(performance, "now").mockReturnValue(0);
  await using screen = await render(<Clock />);
  using frames = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(7);
  using _cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  now.mockReturnValue(100);
  await f.emit({ seconds: 2.1, receivedAt: 100, readId: 2 });
  const animate = frames.mock.calls[0]![0];
  await act(() => animate(116.667));
  await expect.element(screen.getByLabelText("Playhead")).toHaveTextContent("2.150");
  await act(() => animate(133.333));
  await expect.element(screen.getByLabelText("Playhead")).toHaveTextContent("2.183");
  await act(() => animate(150));
  await expect.element(screen.getByLabelText("Playhead")).toHaveTextContent("2.183");
  await act(() => animate(166.667));
  await expect.element(screen.getByLabelText("Playhead")).toHaveTextContent("2.217");
  await screen.unmount();
});
