import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { MusicPanel } from "./MusicPanel";
import type { PremiereContext } from "./host";
import type { MusicTrack } from "./music";
import "./styles.css";

const host = vi.hoisted(() => ({ request: vi.fn(), snapshot: vi.fn(), seek: vi.fn() }));
vi.mock("./interactiveHost", () => ({ requestTimelineAction: host.request }));
vi.mock("./timelineHost", () => ({ requestTimelineSnapshot: host.snapshot }));
vi.mock("./host", () => ({ seekPremiere: host.seek }));
function setup(id: string) {
  localStorage.removeItem(`axis-music:${JSON.stringify("music-film")}`);
  localStorage.removeItem(`axis-music:${JSON.stringify("music-film")}:${id}:undo`);
  const context: PremiereContext = {
    projectName: "AnimeAddicts",
    projectDocumentId: "music-film",
    projectPath: "D:/film.prproj",
    sequenceId: id,
    sequenceName: "Main",
    fps: 25,
    playheadSeconds: 0,
  };
  const tracks: MusicTrack[] = [
    "Heroic strings.wav",
    "Low tension.wav",
    "Quiet piano.wav",
    "Epic drums.wav",
  ].map((filename, i) => ({
    path: `D:/Music/${filename}`,
    filename,
    category: i ? "Emotional" : "Action",
    duration: 180,
    loudnessDbfs: -18,
    energy: [],
    rises: [{ start: 12, end: 18, db: 8 }],
    loudWindows: [{ start: 10, end: 19 }],
    quietRanges: [],
    phraseBoundaries: [0, 8],
    description:
      i === 2
        ? ""
        : i
          ? "Sparse instrumental bed; audition mood."
          : "Orchestral momentum, wide strings and light percussion. Heard in a 30-second excerpt.",
    tags: [],
    tempo: null,
  }));
  host.seek.mockReset();
  host.snapshot
    .mockReset()
    .mockResolvedValue({ signature: "before", snapshot: { projectId: "music-film" } });
  host.request.mockReset().mockImplementation(async (_type, request) => {
    if (request.action === "index")
      return { tracks, pending: 0, failures: [], tool: "D:/Axis/tools/axis_music.py" };
    if (request.action === "audition")
      return { dataUrl: "data:audio/wav;base64,UklGRg==", sizeBytes: 6 };
    if (request.action === "undo") return { status: "undone", sequenceId: "restored" };
    return {
      status: "applied",
      checkpointId: "checkpoint",
      checkpointSignature: "saved",
      expectedSignature: "after",
    };
  });
  const words = "The action begins. But this reveal changes everything about our hero."
    .split(" ")
    .map((text, i) => ({ text, start: i * 2, end: i * 2 + 1.8 }));
  return {
    context,
    words,
    disabled: false,
    onBusy: vi.fn(),
    onClose: vi.fn(),
    onAsk: vi.fn(),
    onRestored: vi.fn(),
    onDescribe: vi.fn().mockResolvedValue(undefined),
  };
}
it("reviews at 440px, auditions measured offsets, swaps alternatives and nudges starts", async () => {
  await page.viewport(440, 920);
  const props = setup("music-review");
  await using screen = await render(<MusicPanel {...props} />);
  screen.container.style.width = "440px";
  await screen.getByRole("button", { name: "Index library", exact: true }).click();
  await screen.getByRole("button", { name: "Build music plan" }).click();
  await expect
    .element(screen.getByRole("checkbox", { name: "I reviewed cues", exact: false }))
    .toBeEnabled();
  const cue = screen.container.querySelector("li")!;
  const chapter = cue.querySelector("strong")!.textContent!;
  await screen.getByRole("button", { name: "Audition" }).click();
  await expect.element(screen.getByLabelText("Music source preview")).toBeVisible();
  expect(host.seek).toHaveBeenCalledWith(0, "music-review");
  await screen
    .getByRole("combobox", { name: `Track for ${chapter}` })
    .selectOptions("D:/Music/Low tension.wav");
  await screen.getByRole("spinbutton", { name: `Start for ${chapter}` }).fill("0.5");
  await screen.getByRole("checkbox", { name: `Include ${chapter}` }).click();
  await expect.element(screen.getByRole("button", { name: "Apply 0 cues" })).toBeDisabled();
  await screen.getByRole("checkbox", { name: `Include ${chapter}` }).click();
  expect(screen.container.scrollWidth).toBeLessThanOrEqual(440);
  await page.screenshot({ path: "./__screenshots__/axis-music-review-440.png" });
});
it("requires confirmation, applies speech automation and retains undo after remount", async () => {
  const props = setup("music-apply");
  await using screen = await render(<MusicPanel {...props} />);
  await screen.getByRole("button", { name: "Index library", exact: true }).click();
  await screen.getByRole("button", { name: "Build music plan" }).click();
  await expect.element(screen.getByRole("button", { name: "Apply 1 cues" })).toBeDisabled();
  await screen.getByRole("checkbox", { name: "I reviewed cues", exact: false }).click();
  await screen.getByLabelText("Music levels and exclusions").click();
  await page.screenshot({ path: "./__screenshots__/axis-music-confirm-440.png" });
  await screen.getByRole("button", { name: "Apply 1 cues" }).click();
  await expect.element(screen.getByRole("button", { name: "Undo music" })).toBeEnabled();
  expect(host.request).toHaveBeenLastCalledWith(
    "premiere.music.request",
    expect.objectContaining({
      action: "apply",
      confirmed: true,
      expectedSignature: "before",
      cues: [
        expect.objectContaining({
          keys: expect.arrayContaining([expect.objectContaining({ time: 0, value: 0 })]),
        }),
      ],
    }),
  );
  await screen.rerender(<MusicPanel {...props} key="remount" />);
  await screen.getByRole("button", { name: "Undo music" }).click();
  expect(props.onRestored).toHaveBeenCalledWith("restored");
  await expect.element(screen.getByRole("button", { name: "Undo music" })).not.toBeInTheDocument();
});
it("prevents apply after failed operations and respects editing permissions", async () => {
  const props = setup("music-disabled");
  await using screen = await render(<MusicPanel {...props} disabled />);
  await expect
    .element(screen.getByRole("button", { name: "Index library", exact: true }))
    .toBeDisabled();
  await screen.rerender(<MusicPanel {...props} />);
  host.request.mockRejectedValue(new Error("Library not found"));
  await screen.getByRole("button", { name: "Index library", exact: true }).click();
  await expect.element(screen.getByRole("alert")).toBeVisible();
  expect(screen.container.querySelector("[role=alert]")?.textContent).toBe("Library not found");
  expect(host.snapshot).not.toHaveBeenCalled();
});
it("describes actual attached audio excerpts with the current audio-capable agent", async () => {
  const props = setup("music-describe");
  await using screen = await render(<MusicPanel {...props} />);
  await screen.getByRole("button", { name: "Index library", exact: true }).click();
  await screen.getByRole("button", { name: "Describe library" }).click();
  await vi.waitFor(() => expect(props.onDescribe).toHaveBeenCalledOnce());
  expect(props.onDescribe).toHaveBeenCalledWith(
    expect.stringContaining("listen to each"),
    expect.arrayContaining([
      expect.objectContaining({
        type: "file",
        mimeType: "audio/wav",
        dataUrl: "data:audio/wav;base64,UklGRg==",
      }),
    ]),
  );
});

it("keeps an agent plan while indexing and rejects a later source overrun", async () => {
  const props = setup("music-agent-plan");
  const initialPlan = {
    version: 1 as const,
    cues: [
      {
        id: "agent-1",
        chapter: "Agent chapter",
        start: 0,
        end: 20,
        track: "D:\\Music\\Heroic strings.wav",
        sourceOffset: 12,
        reason: "Measured rise",
        fadeIn: 1,
        fadeOut: 1,
        baseDb: -22,
        enabled: true,
        alternatives: [],
      },
    ],
    silence: [],
  };
  await using screen = await render(<MusicPanel {...props} initialPlan={initialPlan} />);
  await screen.getByRole("button", { name: "Index library", exact: true }).click();
  await screen.getByRole("button", { name: "Validate plan against timeline" }).click();
  await expect
    .element(screen.getByRole("checkbox", { name: "Include Agent chapter" }))
    .toBeVisible();
  await screen.getByRole("spinbutton", { name: "Source offset for Agent chapter" }).fill("179");
  await expect.element(screen.getByRole("alert")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Apply 1 cues" })).toBeDisabled();
});

it("enforces sponsor exclusions added after planning", async () => {
  const props = setup("music-exclusions");
  await using screen = await render(<MusicPanel {...props} />);
  await screen.getByRole("button", { name: "Index library", exact: true }).click();
  await screen.getByRole("button", { name: "Build music plan" }).click();
  await screen.getByLabelText("Music levels and exclusions").click();
  await screen.getByRole("textbox", { name: "Sponsor and silence ranges" }).fill("2-4");
  await screen.getByRole("button", { name: "Validate plan against timeline" }).click();
  await expect.element(screen.getByRole("alert")).toBeVisible();
  expect(screen.container.querySelector("[role=alert]")?.textContent).toContain(
    "silence or sponsor",
  );
  await expect
    .element(screen.getByRole("checkbox", { name: "I reviewed cues", exact: false }))
    .toBeDisabled();
});
