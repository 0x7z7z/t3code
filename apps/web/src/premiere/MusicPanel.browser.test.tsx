import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { MusicPanel } from "./MusicPanel";
import type { PremiereContext } from "./host";
import type { MusicPlan, MusicTrack } from "./music";
import type { TimelineSnapshot } from "./turnChanges";
import "./styles.css";

const host = vi.hoisted(() => ({ request: vi.fn(), snapshot: vi.fn() }));
vi.mock("./interactiveHost", () => ({ requestTimelineAction: host.request }));
vi.mock("./timelineHost", () => ({ requestTimelineSnapshot: host.snapshot }));
function setup(id: string) {
  localStorage.setItem(`axis-music:${JSON.stringify(id)}`, JSON.stringify({ root: "D:/Music" }));
  localStorage.removeItem(`axis-music:${JSON.stringify(id)}:main:result`);
  const context: PremiereContext = {
    projectName: "Film",
    projectDocumentId: id,
    projectPath: "D:/film.prproj",
    sequenceId: "main",
    sequenceName: "Final forms",
    fps: 30,
    playheadSeconds: 0,
  };
  const tracks: MusicTrack[] = [
    "hype music/fight.wav",
    "sad music/loss.wav",
    "hype music/power.wav",
  ].map((filename) => ({
    path: `D:/Music/${filename}`,
    filename,
    category: filename.split("/")[0]!,
    duration: 200,
    peakDbfs: -3,
    loudnessDbfs: -18,
    integratedLufs: -9,
    firstAudible: 1.85,
    loudPartStart: 29,
    biggestDrop: 40,
    loudnessSpread: 4,
    energy: [],
    rises: [],
    loudWindows: [],
    quietRanges: [],
    phraseBoundaries: [],
    tempo: 120,
    description: "",
    tags: [],
  }));
  tracks[0]!.vocals = true;
  tracks[1]!.integratedLufs = -20;
  const snapshot: TimelineSnapshot = {
    projectId: id,
    sequenceId: "main",
    name: "Final forms",
    videoTrackCount: 0,
    audioTrackCount: 1,
    videoTracks: [],
    audioTracks: [{ index: 0, name: "Audio 5", clips: [] }],
    markers: [],
    inPoint: null,
    outPoint: null,
    truncated: false,
  };
  host.snapshot.mockReset().mockResolvedValue({ signature: "before", snapshot });
  host.request.mockReset().mockImplementation(async (_type, request) => {
    if (request.action === "index") return { tracks, pending: 0, failures: [] };
    if (request.action === "undo") return { status: "undone", sequenceId: "restored" };
    return {
      status: "applied",
      checkpointId: "checkpoint",
      checkpointSignature: "saved",
      expectedSignature: "after",
      sequenceId: "",
      message: "1 Constant Power joins; remaining edges use Volume fades.",
      effectReports: request.cues?.map((cue: { id: string; effects?: string[] }) => ({
        id: cue.id,
        results: (cue.effects ?? []).map((effect) =>
          effect === "Hard Limiter" ? "Hard Limiter failed (QE unavailable)" : effect,
        ),
      })),
    };
  });
  const props = {
    context,
    words: [
      { text: "Goku fights.", start: 0, end: 59 },
      { text: "Next, Vegeta mourns his loss.", start: 60, end: 120 },
    ],
    disabled: false,
    onBusy: vi.fn(),
    onClose: vi.fn(),
    onPlace: vi.fn().mockResolvedValue(undefined),
    onRestored: vi.fn(),
  };
  const plan = (): MusicPlan => {
    const prompt = String(props.onPlace.mock.calls[0]![0]);
    const requestId = JSON.parse(prompt.match(/requestId:("[^"]+")/)![1]!) as string;
    return {
      version: 1,
      requestId,
      cues: tracks.slice(0, 2).map((t, i) => ({
        id: `section-${i}`,
        chapter: i ? "Vegeta's loss" : "Goku's final form",
        mood: i ? "sad" : "hype",
        energy: i ? 0.2 : 0.9,
        start: i * 60,
        end: (i + 1) * 60,
        track: t.path,
        sourceOffset: 0,
        reason: "Folder mood matches the script.",
        fadeIn: 0.75,
        fadeOut: 0.75,
        baseDb: 0,
        enabled: true,
        alternatives: [],
      })),
      silence: [],
    };
  };
  return { props, plan, tracks, snapshot };
}

it.each([440, 1000])(
  "places from one click, shows results and Undo all at %i px",
  async (width) => {
    await page.viewport(width, 840);
    const f = setup(`music-single-${width}`);
    await using screen = await render(<MusicPanel {...f.props} />);
    screen.container.style.cssText = `width:${width}px;max-width:100%;box-sizing:border-box;padding:12px;`;
    await expect
      .element(screen.getByRole("button", { name: "Place music", exact: true }))
      .toBeEnabled();
    expect(screen.container.querySelector("details")?.open).toBe(false);
    await expect
      .element(screen.getByRole("checkbox", { name: "Lower music during speech" }))
      .not.toBeChecked();
    await page.screenshot({ path: `../../../../.t3/music-mix/before-${width}.png` });
    await screen.getByRole("button", { name: "Place music", exact: true }).click();
    await vi.waitFor(() => expect(f.props.onPlace).toHaveBeenCalledOnce());
    expect(f.props.onPlace.mock.calls[0]![0]).toContain("requestId:");
    await screen.rerender(<MusicPanel {...f.props} initialPlan={f.plan()} agentFinished />);
    await expect.element(screen.getByRole("button", { name: "Undo all" })).toBeEnabled();
    expect(screen.container.querySelectorAll("[data-music-cues] li")).toHaveLength(2);
    const apply = host.request.mock.calls.find(([, r]) => r.action === "apply")![1];
    expect(apply.crossfade).toBe(3);
    expect(apply.cues[0].fadeOut + apply.cues[1].fadeIn).toBe(3);
    expect(apply.ducking).toBe(false);
    expect(apply.cues[0].baseDb).toBe(-29);
    expect(apply.cues[0].sourceOffset).toBe(22);
    expect(apply.cues[0].swellSeconds).toBe(7);
    expect(apply.cues[0].keys.find((k: { time: number }) => k.time === 7).value).toBeCloseTo(
      Math.pow(10, -29 / 20),
    );
    expect(screen.container.querySelector("[data-music-mix]")?.textContent).toContain("-29.0 dB");
    expect(screen.container.querySelector("[data-music-mix]")?.textContent).toContain("Lowpass");
    expect(screen.container.querySelectorAll("[data-music-mix]")[1]?.textContent).toContain(
      "Hard Limiter failed",
    );
    expect(screen.container.querySelector("[data-music-panel]")!.scrollWidth).toBeLessThanOrEqual(
      width,
    );
    await page.screenshot({ path: `../../../../.t3/music-mix/after-${width}.png` });
    await screen.getByRole("button", { name: "Undo all" }).click();
    expect(host.request).toHaveBeenLastCalledWith(
      "premiere.music.request",
      expect.objectContaining({
        action: "undo",
        sequenceId: "main",
        checkpointId: "checkpoint",
        expectedSignature: "after",
      }),
    );
    await expect
      .element(screen.getByRole("button", { name: "Place music", exact: true }))
      .toBeEnabled();
    expect(f.props.onRestored).toHaveBeenCalledWith("restored");
  },
);

it("ignores stale plans and refuses a timeline that changed during agent planning", async () => {
  const f = setup("music-stale");
  await using screen = await render(<MusicPanel {...f.props} />);
  await expect
    .element(screen.getByRole("button", { name: "Place music", exact: true }))
    .toBeEnabled();
  await screen.getByRole("button", { name: "Place music", exact: true }).click();
  await vi.waitFor(() => expect(f.props.onPlace).toHaveBeenCalledOnce());
  const plan = f.plan();
  await screen.rerender(<MusicPanel {...f.props} initialPlan={{ ...plan, requestId: "old" }} />);
  expect(host.request.mock.calls.some(([, r]) => r.action === "apply")).toBe(false);
  host.snapshot.mockResolvedValue({ signature: "changed", snapshot: f.snapshot });
  await screen.rerender(<MusicPanel {...f.props} initialPlan={plan} agentFinished />);
  await expect.element(screen.getByRole("alert")).toBeVisible();
  expect(screen.container.querySelector("[role=alert]")?.textContent).toContain("timeline changed");
  expect(host.request.mock.calls.some(([, r]) => r.action === "apply")).toBe(false);
});

it("swaps a matching song while preserving the original undo receipt across remount", async () => {
  const f = setup("music-swap");
  await using screen = await render(<MusicPanel {...f.props} />);
  await expect
    .element(screen.getByRole("button", { name: "Place music", exact: true }))
    .toBeEnabled();
  await screen.getByRole("button", { name: "Place music", exact: true }).click();
  await vi.waitFor(() => expect(f.props.onPlace).toHaveBeenCalledOnce());
  f.tracks[2]!.integratedLufs = -20;
  f.tracks[2]!.vocals = true;
  const plan = f.plan();
  plan.cues[0]!.keyTime = 10;
  await screen.rerender(<MusicPanel {...f.props} initialPlan={plan} />);
  await expect.element(screen.getByRole("button", { name: "Undo all" })).toBeEnabled();
  f.snapshot.audioTracks[0]!.clips = plan.cues.map((c) => ({
    name: c.chapter,
    nodeId: c.id,
    projectItemName: c.track,
    mediaPath: c.track,
    start: c.start,
    end: c.end,
    inPoint: 0,
    outPoint: 60,
    enabled: true,
  }));
  host.snapshot.mockResolvedValue({ signature: "after", snapshot: f.snapshot });
  await screen.getByRole("button", { name: "Swap Goku's final form" }).click();
  await vi.waitFor(() =>
    expect(host.request.mock.calls.some(([, r]) => r.action === "swap")).toBe(true),
  );
  const swap = host.request.mock.calls.find(([, r]) => r.action === "swap")![1];
  expect(swap.cues[0].track).toBe(f.tracks[2]!.path);
  expect(swap.checkpointId).toBe("checkpoint");
  expect(swap.cues[0].sourceOffset).toBe(30);
  expect(swap.cues[0].swellSeconds).toBe(10);
  expect(swap.cues[0].baseDb).toBe(-28);
  expect(swap.cues[0].effects).toEqual(["Hard Limiter", "Lowpass"]);
  await screen.rerender(<MusicPanel {...f.props} key="remount" />);
  await expect.element(screen.getByRole("button", { name: "Undo all" })).toBeEnabled();
});

it("reports failed agent requests and keeps background indexing automatic", async () => {
  const f = setup("music-failure");
  f.props.onPlace.mockRejectedValue(new Error("Agent disconnected"));
  await using screen = await render(<MusicPanel {...f.props} />);
  await expect
    .element(screen.getByRole("button", { name: "Place music", exact: true }))
    .toBeEnabled();
  await screen.getByRole("button", { name: "Place music", exact: true }).click();
  await expect.element(screen.getByRole("alert")).toBeVisible();
  expect(host.request.mock.calls.filter(([, r]) => r.action === "index")).toHaveLength(1);
  expect(screen.container.querySelector("[role=alert]")?.textContent).toContain(
    "Agent disconnected",
  );
});
