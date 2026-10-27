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
    .mockImplementation(async (_type: string, payload: { action: string; path?: string }) => {
      if (payload.action === "pick" || payload.action === "selected")
        return { path: "D:/Film/VO.wav" };
      if (payload.action === "resolve") return { path: payload.path };
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

function timelineAnchor() {
  return {
    projectId: "film",
    projectName: "Film",
    sequenceId: "main",
    sequenceName: "Main",
    sourcePath: "D:/Film/VO.wav",
    trackId: "vo-track",
    nodeId: "vo",
    trackIndex: 2,
    start: 12,
    end: 100,
    inPoint: 2,
    outPoint: 90,
  };
}

it("auto-anchors Browse and typed paths, and places the fourth mode at the returned current location", async () => {
  await page.viewport(440, 900);
  const props = setup();
  const run = host.request.getMockImplementation()!;
  host.request.mockImplementation(async (type, payload) => {
    if (payload.action === "resolve")
      return payload.path === "D:/Film/VO.wav"
        ? { path: payload.path, anchor: timelineAnchor() }
        : { path: payload.path, message: "No clip using this file was found in sequence Main." };
    if (payload.action === "run")
      return {
        ...(await run(type, payload)),
        outputPath: "D:/Film/VO_SilenceBreathsSilence.wav",
        breathsPath: "D:/Film/VO_NoBreaths.wav",
      };
    if (payload.action === "place")
      return {
        status: "placed",
        trackIndex: 6,
        start: 120,
        checkpointId: "saved",
        checkpointSignature: "before",
        expectedSignature: "after",
        message:
          "Placed on A7 at 120.000 s. Used the bottom track because Premiere added it there.",
      };
    if (payload.action === "unplace") return { status: "unplaced" };
    return run(type, payload);
  });
  await using screen = await render(<VOCleanupPanel {...props} />);
  screen.container.style.width = "440px";
  const timeline = () => screen.getByRole("checkbox", { name: /Import into timeline/ });
  await screen.getByRole("button", { name: "Browse...", exact: true }).click();
  await expect.element(timeline()).toBeEnabled();
  await screen.getByRole("textbox", { name: "Audio file" }).fill("D:/Film/Other.wav");
  await expect.element(timeline()).toBeDisabled();
  await expect.element(screen.getByRole("note")).toBeVisible();
  await screen.getByRole("textbox", { name: "Audio file" }).fill("D:/Film/VO.wav");
  await expect.element(timeline()).toBeEnabled();
  await timeline().click();
  await screen.getByRole("combobox", { name: "Remove" }).selectOptions("sandwich");
  await screen.getByRole("spinbutton", { name: "Keep silence (ms)" }).fill("80");
  await screen.getByRole("button", { name: "Clean VO", exact: true }).click();
  await expect.element(screen.getByRole("button", { name: "Undo placement" })).toBeEnabled();
  expect(host.request.mock.calls.find((call) => call[1].action === "run")?.[1]).toMatchObject({
    mode: "sandwich",
    keepMs: 80,
  });
  expect(host.request.mock.calls.find((call) => call[1].action === "place")?.[1]).toMatchObject({
    ...timelineAnchor(),
    keepTiming: false,
    confirmed: true,
  });
  expect(screen.container.textContent).toContain("Placed on A7 at 120.000 s.");
  expect(screen.container.textContent).toContain("Breath-cleaned copy: D:/Film/VO_NoBreaths.wav");
  expect(screen.container.scrollWidth).toBeLessThanOrEqual(440);
  await page.screenshot({ path: "./__screenshots__/axis-vo-cleanup-v3-440.png" });
  await screen.getByRole("button", { name: "Undo placement" }).click();
  await expect
    .element(screen.getByRole("button", { name: "Undo placement" }))
    .not.toBeInTheDocument();
  expect(host.request.mock.calls.some((call) => call[1].action === "selected")).toBe(false);
});

it("asks which repeated instance to use and enables placement after selecting one", async () => {
  const props = setup();
  const run = host.request.getMockImplementation()!;
  let selected = false;
  host.request.mockImplementation(async (type, payload) => {
    if (payload.action === "selected") {
      selected = true;
      return { path: "D:/Film/VO.wav", anchor: timelineAnchor() };
    }
    if (payload.action === "resolve")
      return selected
        ? { path: payload.path, anchor: timelineAnchor() }
        : {
            path: payload.path,
            message:
              "Select the VO clip to use, then click Use selected clip. This file appears more than once.",
          };
    return run(type, payload);
  });
  await using screen = await render(<VOCleanupPanel {...props} />);
  await screen.getByRole("textbox", { name: "Audio file" }).fill("D:/Film/VO.wav");
  await expect.element(screen.getByRole("note")).toBeVisible();
  await expect
    .element(screen.getByRole("checkbox", { name: /Import into timeline/ }))
    .toBeDisabled();
  expect(screen.container.textContent).toContain("Select the VO clip to use");
  await screen.getByRole("button", { name: "Use selected clip" }).click();
  await expect
    .element(screen.getByRole("checkbox", { name: /Import into timeline/ }))
    .toBeEnabled();
  await expect.element(screen.getByRole("note")).not.toBeInTheDocument();
});

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
  expect(
    host.request.mock.calls.map((call) => call[1].action).filter((action) => action !== "resolve"),
  ).toEqual(["pick", "run"]);
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
          sourcePath: "D:/Film/VO.wav",
          projectName: "Film",
          sequenceName: "Main",
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
    sourcePath: "D:/Film/VO.wav",
    projectName: "Film",
    sequenceName: "Main",
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
          sourcePath: "D:/Film/VO.wav",
          projectName: "Film",
          sequenceName: "Main",
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
