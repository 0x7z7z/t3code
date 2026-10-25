import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
import { page } from "vite-plus/test/browser";
import { SetupPanel } from "./SetupPanel";
import "./styles.css";

const host = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./host", () => ({
  isPremierePanel: () => true,
  requestPremiereContext: async () => null,
}));
vi.mock("./interactiveHost", () => ({ requestTimelineAction: host.request }));

function setup() {
  host.request.mockReset().mockResolvedValue({
    report: {
      axis: "test-release",
      node: "v24.22.1",
      git: "git version 2.56",
      backend: "unavailable",
      backendUrl: "http://127.0.0.1:5740/",
      extensionPath: "D:/Axis panel",
      runtimePath: "D:/Axis runtime",
      dataPath: "D:/PremiereAssistant/backend",
      workspacePath: "D:/PremiereAssistant/workspace",
      bridgePath: "D:/Axis bridge",
      bridgeState: "error",
      ffmpeg: null,
      python: { path: null, version: null, whisperx: false },
    },
  });
}

it("shows actionable setup without a backend, account or CEP bridge", async () => {
  setup();
  await page.viewport(440, 720);
  const accounts = vi.fn();
  await using screen = await render(
    <SetupPanel
      ready={false}
      connected={false}
      providers={[]}
      diagnostics={false}
      onAccounts={accounts}
    />,
  );
  await expect.element(screen.getByRole("region", { name: "Axis setup" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Open account setup" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Retry bridge" })).toBeVisible();
  await vi.waitFor(() => expect(host.request).toHaveBeenCalled());
  await screen.getByRole("button", { name: "Open account setup" }).click();
  expect(accounts).toHaveBeenCalledOnce();
  if (import.meta.env.VITE_AXIS_CAPTURE_SETUP === "1")
    await page.screenshot({ path: "./__screenshots__/axis-first-run-440.png" });
});

it("keeps diagnostics and a selectable support report available while disconnected", async () => {
  setup();
  await using screen = await render(
    <SetupPanel
      ready={false}
      connected={false}
      providers={[]}
      diagnostics={true}
      onAccounts={() => {}}
    />,
  );
  await expect.element(screen.getByRole("region", { name: "Diagnostics" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Copy report" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Check again" })).toBeVisible();
  await vi.waitFor(() =>
    expect(screen.getByRole("region", { name: "Diagnostics" }).element().textContent).toContain(
      "test-release",
    ),
  );
  using copy = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
  await screen.getByRole("button", { name: "Copy report" }).click();
  expect(copy).toHaveBeenCalledWith(expect.stringContaining("D:/PremiereAssistant/backend"));
  await screen.getByRole("button", { name: "Check again" }).click();
  expect(host.request).toHaveBeenCalledTimes(2);
  if (import.meta.env.VITE_AXIS_CAPTURE_SETUP === "1")
    await page.screenshot({ path: "./__screenshots__/axis-diagnostics-440.png" });
});
