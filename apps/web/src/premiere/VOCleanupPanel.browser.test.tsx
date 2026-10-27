import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { VOCleanupPanel } from "./VOCleanupPanel";
import type { PremiereContext } from "./host";
import "./styles.css";

const host = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./interactiveHost", () => ({ requestTimelineAction: host.request }));
function setup() {
  host.request
    .mockReset()
    .mockImplementation(async (_type: string, payload: { action: string }) => {
      if (payload.action === "pick" || payload.action === "selected")
        return { path: "D:/Film/VO.wav" };
      if (payload.action === "import") return { status: "imported" };
      return {
        outputPath: "D:/Film/VO_AxisVO_123_NoBreaths.wav",
        silencePath: "D:/Film/VO_AxisVO_123_SilenceRemoved.wav",
        regionsPath: "D:/Film/VO_AxisVO_123_breaths.csv",
        regions: 136,
        beforeSeconds: 1500,
        afterSeconds: 1286.287,
      };
    });
  const context: PremiereContext = {
    projectName: "Film",
    projectPath: "D:/Film.prproj",
    projectDocumentId: "film",
    sequenceId: "main",
    sequenceName: "Main",
    fps: 60,
    playheadSeconds: 0,
  };
  return { context, onClose: vi.fn() };
}

it("cleans both steps at 440px, preserves the source choice and offers explicit bin import", async () => {
  await page.viewport(440, 720);
  const props = setup();
  await using screen = await render(<VOCleanupPanel {...props} />);
  screen.container.style.width = "440px";
  await screen.getByRole("button", { name: "Browse...", exact: true }).click();
  await expect
    .element(screen.getByRole("textbox", { name: "Audio file" }))
    .toHaveValue("D:/Film/VO.wav");
  await expect
    .element(screen.getByRole("spinbutton", { name: "Keep silence (ms)" }))
    .toHaveValue(50);
  await page.screenshot({ path: "./__screenshots__/axis-vo-cleanup-440.png" });
  await screen.getByRole("button", { name: "Clean VO", exact: true }).click();
  await expect
    .element(screen.getByRole("textbox", { name: "Cleaned audio" }))
    .toHaveValue("D:/Film/VO_AxisVO_123_NoBreaths.wav");
  expect(host.request.mock.calls.map((call) => call[1].action)).toEqual(["pick", "run"]);
  expect(host.request).toHaveBeenLastCalledWith("premiere.vo-cleanup.request", {
    action: "run",
    path: "D:/Film/VO.wav",
    mode: "both",
    keepMs: 50,
  });
  await screen.getByRole("button", { name: "Import cleaned VO" }).click();
  expect(host.request).toHaveBeenLastCalledWith("premiere.vo-cleanup.request", {
    action: "import",
    path: "D:/Film/VO_AxisVO_123_NoBreaths.wav",
    projectId: "film",
  });
  expect(screen.container.scrollWidth).toBeLessThanOrEqual(440);
  await page.screenshot({ path: "./__screenshots__/axis-vo-cleanup-result-440.png" });
});

it("chooses a project item and runs either individual step with retained-silence validation", async () => {
  const props = setup();
  await using screen = await render(<VOCleanupPanel {...props} />);
  await screen.getByRole("button", { name: "Use selected clip" }).click();
  await screen.getByRole("combobox", { name: "Remove" }).selectOptions("silence");
  await screen.getByRole("spinbutton", { name: "Keep silence (ms)" }).fill("-1");
  await expect
    .element(screen.getByRole("button", { name: "Clean VO", exact: true }))
    .toBeDisabled();
  await screen.getByRole("spinbutton", { name: "Keep silence (ms)" }).fill("80");
  await screen.getByRole("button", { name: "Clean VO", exact: true }).click();
  await expect.element(screen.getByRole("button", { name: "Clean VO", exact: true })).toBeEnabled();
  expect(host.request).toHaveBeenLastCalledWith(
    "premiere.vo-cleanup.request",
    expect.objectContaining({ mode: "silence", keepMs: 80 }),
  );
  await screen.getByRole("combobox", { name: "Remove" }).selectOptions("breaths");
  await expect
    .element(screen.getByRole("spinbutton", { name: "Keep silence (ms)" }))
    .not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Clean VO", exact: true }).click();
  await expect.element(screen.getByRole("button", { name: "Clean VO", exact: true })).toBeEnabled();
  expect(host.request).toHaveBeenLastCalledWith(
    "premiere.vo-cleanup.request",
    expect.objectContaining({ mode: "breaths" }),
  );
});

it("retains saved results after an optional import fails and retries without cleaning again", async () => {
  const props = setup();
  await using screen = await render(<VOCleanupPanel {...props} />);
  await screen.getByRole("textbox", { name: "Audio file" }).fill("D:/Film/VO.wav");
  await screen.getByRole("checkbox", { name: "Import result into project bin" }).click();
  const run = host.request.getMockImplementation()!;
  host.request.mockImplementation(async (type, payload) => {
    if (payload.action === "import") throw new Error("The project changed");
    return run(type, payload);
  });
  await screen.getByRole("button", { name: "Clean VO", exact: true }).click();
  await expect.element(screen.getByRole("alert")).toBeVisible();
  await expect.element(screen.getByRole("textbox", { name: "Cleaned audio" })).toBeVisible();
  host.request.mockImplementation(run);
  await screen.getByRole("button", { name: "Import cleaned VO" }).click();
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  expect(host.request.mock.calls.filter((call) => call[1].action === "run")).toHaveLength(1);
});

it("places breath-only cleanup on a new track below the selected timeline clip and undoes it", async () => {
  await page.viewport(440, 720);
  const props = setup();
  const run = host.request.getMockImplementation()!;
  host.request.mockImplementation(async (type, payload) => {
    if (payload.action === "selected")
      return {
        path: "D:/Film/VO.wav",
        anchor: {
          projectId: "film",
          sequenceId: "main",
          trackId: "vo-track",
          nodeId: "vo",
          trackIndex: 2,
          start: 12,
          end: 100,
          inPoint: 2,
          outPoint: 90,
        },
      };
    if (payload.action === "place")
      return {
        status: "placed",
        trackIndex: 3,
        start: 12,
        checkpointId: "saved",
        checkpointSignature: "before",
        expectedSignature: "after",
      };
    if (payload.action === "unplace") return { status: "unplaced" };
    return run(type, payload);
  });
  await using screen = await render(<VOCleanupPanel {...props} />);
  const timeline = () => screen.getByRole("checkbox", { name: /Import into timeline/ });
  await expect.element(timeline()).toBeDisabled();
  await screen.getByRole("button", { name: "Use selected clip" }).click();
  await expect.element(timeline()).toBeEnabled();
  await timeline().click();
  await screen.getByRole("combobox", { name: "Remove" }).selectOptions("breaths");
  await screen.getByRole("button", { name: "Clean VO", exact: true }).click();
  await expect.element(screen.getByRole("button", { name: "Undo placement" })).toBeVisible();
  expect(screen.container.scrollWidth).toBeLessThanOrEqual(440);
  await page.screenshot({ path: "./__screenshots__/axis-vo-cleanup-placement-440.png" });
  expect(host.request).toHaveBeenLastCalledWith("premiere.vo-cleanup.request", {
    action: "place",
    path: "D:/Film/VO_AxisVO_123_NoBreaths.wav",
    projectId: "film",
    sequenceId: "main",
    trackId: "vo-track",
    nodeId: "vo",
    trackIndex: 2,
    start: 12,
    end: 100,
    inPoint: 2,
    outPoint: 90,
    keepTiming: true,
    confirmed: true,
  });
  await screen.getByRole("button", { name: "Undo placement" }).click();
  await expect
    .element(screen.getByRole("button", { name: "Undo placement" }))
    .not.toBeInTheDocument();
  expect(host.request).toHaveBeenLastCalledWith("premiere.vo-cleanup.request", {
    action: "unplace",
    projectId: "film",
    sequenceId: "main",
    checkpointId: "saved",
    checkpointSignature: "before",
    expectedSignature: "after",
  });
  await screen.getByRole("textbox", { name: "Audio file" }).fill("D:/Film/Other.wav");
  await expect.element(timeline()).toBeDisabled();
});

it("processes a file without a sequence and shows a failed job without a success result", async () => {
  const props = setup();
  await using screen = await render(<VOCleanupPanel {...props} context={null} />);
  await expect
    .element(screen.getByRole("checkbox", { name: "Import result into project bin" }))
    .toBeDisabled();
  await screen.getByRole("textbox", { name: "Audio file" }).fill("D:/Film/VO.wav");
  host.request.mockRejectedValue(new Error("WhisperX unavailable"));
  await screen.getByRole("button", { name: "Clean VO", exact: true }).click();
  await expect.element(screen.getByRole("alert")).toBeVisible();
  await expect
    .element(screen.getByRole("textbox", { name: "Cleaned audio" }))
    .not.toBeInTheDocument();
});

it("retains Undo after a failed or unverified restore and clears it only after verified success", async () => {
  const props = setup();
  const run = host.request.getMockImplementation()!;
  let undo: "fail" | "unverified" | "success" = "fail";
  host.request.mockImplementation(async (type, payload) => {
    if (payload.action === "selected")
      return {
        path: "D:/Film/VO.wav",
        anchor: {
          projectId: "film",
          sequenceId: "main",
          trackId: "track",
          nodeId: "vo",
          trackIndex: 0,
          start: 12,
          end: 100,
          inPoint: 2,
          outPoint: 90,
        },
      };
    if (payload.action === "place")
      return {
        status: "recovery",
        trackIndex: 1,
        start: 12,
        checkpointId: "saved",
        checkpointSignature: "before",
        expectedSignature: "after",
        message: "Automatic restore failed. The added track may still be present.",
      };
    if (payload.action === "unplace") {
      if (undo === "fail") throw new Error("Premiere could not open the checkpoint.");
      return undo === "success" ? { status: "unplaced", message: "Checkpoint restored." } : {};
    }
    return run(type, payload);
  });
  await using screen = await render(<VOCleanupPanel {...props} />);
  await screen.getByRole("button", { name: "Use selected clip" }).click();
  await screen.getByRole("checkbox", { name: /Import into timeline/ }).click();
  await screen.getByRole("button", { name: "Clean VO", exact: true }).click();
  const undoButton = () => screen.getByRole("button", { name: "Undo placement" });
  await expect.element(undoButton()).toBeEnabled();
  await expect.element(screen.getByRole("alert")).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Clean VO", exact: true }))
    .toBeDisabled();
  await expect
    .element(screen.getByRole("checkbox", { name: /Import into timeline/ }))
    .toBeDisabled();
  await undoButton().click();
  await expect.element(undoButton()).toBeEnabled();
  await expect.element(screen.getByRole("alert")).toBeVisible();
  undo = "unverified";
  await undoButton().click();
  await expect.element(undoButton()).toBeEnabled();
  await expect.element(screen.getByRole("alert")).toBeVisible();
  undo = "success";
  await undoButton().click();
  await expect.element(undoButton()).not.toBeInTheDocument();
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("checkbox", { name: /Import into timeline/ }))
    .toBeDisabled();
});
