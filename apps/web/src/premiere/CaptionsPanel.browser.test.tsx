import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { CaptionsPanel } from "./CaptionsPanel";
import type { PremiereContext } from "./host";
import "./styles.css";

const host = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./interactiveHost", () => ({ requestTimelineAction: host.request }));
function setup(id: string) {
  const context: PremiereContext = {
    projectName: "Film",
    projectPath: "D:/Film.prproj",
    projectDocumentId: "film",
    sequenceId: id,
    sequenceName: "Main edit",
    fps: 25,
    playheadSeconds: 40,
  };
  localStorage.removeItem(`axis-captions-undo:${JSON.stringify(["film", id])}`);
  host.request.mockReset().mockResolvedValue({
    status: "added",
    binId: "bin-a",
    itemId: "item-a",
    checkpointId: "checkpoint-a",
    checkpointSignature: "before",
    expectedSignature: "after",
  });
  const words = "Every frame matters. Give each moment room to breathe."
    .split(" ")
    .map((text, i) => ({ text, start: 12 + i * 0.4, end: 12 + i * 0.4 + 0.3 }));
  return {
    context,
    words,
    disabled: false,
    onBusy: vi.fn(),
    onClose: vi.fn(),
    onRestored: vi.fn(),
  };
}

it("previews defaults at 440px and updates presets, case, punctuation and word grouping", async () => {
  await page.viewport(440, 720);
  const props = setup("caption-preview");
  await using screen = await render(<CaptionsPanel {...props} />);
  screen.container.style.width = "440px";
  await expect.element(screen.getByRole("combobox", { name: "Caption lines" })).toHaveValue("2");
  expect(screen.container.querySelector("time")?.textContent).toContain("00:00:12.000");
  await screen.getByRole("combobox", { name: "Caption preset" }).selectOptions("shorts");
  await expect.element(screen.getByRole("combobox", { name: "Words per cue" })).toHaveValue("3");
  await expect.element(screen.getByRole("combobox", { name: "Caption lines" })).toHaveValue("1");
  await screen.getByRole("combobox", { name: "Caption case" }).selectOptions("upper");
  await screen.getByRole("checkbox", { name: "Strip punctuation" }).click();
  await screen.getByRole("combobox", { name: "Words per cue" }).selectOptions("1");
  expect(screen.container.querySelector("[data-caption-text]")?.textContent).toBe("EVERY");
  await expect
    .element(screen.getByRole("combobox", { name: "Caption preset" }))
    .toHaveValue("custom");
  expect(screen.container.scrollWidth).toBeLessThanOrEqual(440);
  await page.screenshot({ path: "./__screenshots__/axis-captions-440.png" });
  expect(host.request).not.toHaveBeenCalled();
});

it("adds the preview at sequence time and persists undo across a remount", async () => {
  const props = setup("caption-add");
  await using screen = await render(<CaptionsPanel {...props} />);
  await screen.getByRole("button", { name: "Add to sequence" }).click();
  await expect.element(screen.getByRole("button", { name: "Undo captions" })).toBeEnabled();
  expect(host.request).toHaveBeenCalledWith(
    "premiere.captions.request",
    expect.objectContaining({
      action: "add",
      confirmed: true,
      projectId: "film",
      sequenceId: "caption-add",
      srt: expect.stringContaining("00:00:12,000"),
    }),
  );
  expect(props.onBusy.mock.calls).toEqual([[true], [false]]);
  await screen.rerender(<CaptionsPanel {...props} key="remount" />);
  await expect.element(screen.getByRole("button", { name: "Add to sequence" })).toBeDisabled();
  host.request.mockResolvedValue({ status: "undone", sequenceId: "restored-sequence" });
  await screen.getByRole("button", { name: "Undo captions" }).click();
  await expect.element(screen.getByRole("button", { name: "Add to sequence" })).toBeEnabled();
  expect(props.onRestored).toHaveBeenCalledWith("restored-sequence");
  expect(host.request).toHaveBeenLastCalledWith(
    "premiere.captions.request",
    expect.objectContaining({ action: "undo", binId: "bin-a", itemId: "item-a" }),
  );
});

it("explains manual placement when the host only imports captions", async () => {
  const props = setup("caption-fallback");
  host.request.mockResolvedValue({
    status: "imported",
    binId: "bin-a",
    itemId: "item-a",
    binName: "Axis captions 123",
  });
  await using screen = await render(<CaptionsPanel {...props} />);
  await screen.getByRole("button", { name: "Add to sequence" }).click();
  await expect.element(screen.getByRole("status")).toBeVisible();
  expect(screen.container.querySelector("[role=status]")?.textContent).toContain(
    "Drag the SRT from that bin onto the sequence at 00:00:00:00",
  );
  await expect.element(screen.getByRole("button", { name: "Undo captions" })).toBeEnabled();
});

it("saves SRT without creating undo and allows export when editing is disabled", async () => {
  const props = setup("caption-save");
  host.request.mockResolvedValue({ status: "saved" });
  await using screen = await render(<CaptionsPanel {...props} disabled />);
  await expect.element(screen.getByRole("button", { name: "Add to sequence" })).toBeDisabled();
  await screen.getByRole("button", { name: "Save .srt…" }).click();
  expect(host.request).toHaveBeenCalledWith(
    "premiere.captions.request",
    expect.objectContaining({
      action: "save",
      srt: expect.stringContaining("Every frame matters."),
    }),
  );
  await expect
    .element(screen.getByRole("button", { name: "Undo captions" }))
    .not.toBeInTheDocument();
});

it("shows native failures and keeps undo available when deletion fails", async () => {
  const props = setup("caption-error");
  host.request.mockRejectedValue(new Error("Sequence changed"));
  await using screen = await render(<CaptionsPanel {...props} />);
  await screen.getByRole("button", { name: "Add to sequence" }).click();
  await expect.element(screen.getByRole("alert")).toBeVisible();
  expect(screen.container.querySelector("[role=alert]")?.textContent).toBe("Sequence changed");
  host.request.mockResolvedValue({
    status: "added",
    binId: "bin-a",
    itemId: "item-a",
    checkpointId: "checkpoint-a",
    checkpointSignature: "before",
    expectedSignature: "after",
  });
  await screen.getByRole("button", { name: "Add to sequence" }).click();
  await expect.element(screen.getByRole("button", { name: "Undo captions" })).toBeEnabled();
  host.request.mockRejectedValue(new Error("Bin changed"));
  await screen.getByRole("button", { name: "Undo captions" }).click();
  await expect.element(screen.getByRole("button", { name: "Undo captions" })).toBeEnabled();
});

it("disables exports for an empty transcript", async () => {
  const props = setup("caption-empty");
  await using screen = await render(<CaptionsPanel {...props} words={[]} />);
  await expect.element(screen.getByRole("button", { name: "Add to sequence" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Save .srt…" })).toBeDisabled();
});

it("validates custom limits before exporting and updates the preview after correction", async () => {
  const props = setup("caption-validation");
  await using screen = await render(<CaptionsPanel {...props} />);
  await screen.getByRole("spinbutton", { name: "Minimum duration" }).fill("5");
  await screen.getByRole("spinbutton", { name: "Maximum duration" }).fill("2");
  await expect.element(screen.getByRole("alert")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Add to sequence" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Save .srt…" })).toBeDisabled();
  expect(host.request).not.toHaveBeenCalled();
  await screen.getByRole("spinbutton", { name: "Minimum duration" }).fill("0.8");
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  await expect.element(screen.getByRole("button", { name: "Add to sequence" })).toBeEnabled();
  expect(screen.container.querySelectorAll("[data-caption-text]").length).toBeGreaterThan(0);
});

it("keeps the panel locked while Premiere is importing and rejects incomplete undo replies", async () => {
  const props = setup("caption-pending");
  let resolveImport!: (reply: object) => void;
  host.request.mockReturnValue(
    new Promise<object>((resolve) => {
      resolveImport = resolve;
    }),
  );
  await using screen = await render(<CaptionsPanel {...props} />);
  await screen.getByRole("button", { name: "Add to sequence" }).click();
  await expect.element(screen.getByRole("button", { name: "Close captions" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Save .srt…" })).toBeDisabled();
  resolveImport({ status: "added", binId: "bin-a", itemId: "item-a" });
  await expect.element(screen.getByRole("alert")).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Undo captions" }))
    .not.toBeInTheDocument();
  expect(host.request).toHaveBeenCalledTimes(1);
});
