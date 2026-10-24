import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import type { PremiereContext } from "./host";

const state = vi.hoisted(() => ({
  environmentId: "premiere-permission-test",
  allowed: true,
  run: vi.fn(),
  host: { connected: true, context: null as PremiereContext | null },
  frame: vi.fn(),
}));

vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("@t3tools/client-runtime/state/session", async () => {
  const { Atom } = await import("effect/reactivity");
  const Effect = await import("effect/Effect");
  const { AuthOrchestrationOperateScope } = await import("@t3tools/contracts");
  const sessions = Atom.family((_environmentId: string) =>
    Atom.make(
      Effect.promise(async () => ({
        authenticated: true,
        scopes: state.allowed ? [AuthOrchestrationOperateScope] : [],
        permissions: state.allowed ? [AuthOrchestrationOperateScope] : [],
      })),
    ),
  );
  return { createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }) };
});
vi.mock("../connection/onboarding", () => ({ connectPairing: {} }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => state.run }));
vi.mock("../state/entities", () => ({
  useProjects: () => [{ id: "editing", environmentId: state.environmentId, name: "Editing" }],
  useThreadShellsForProjectRefs: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: [{ environmentId: state.environmentId }] }),
  useEnvironmentProviders: () =>
    new Map([
      [
        state.environmentId,
        [
          {
            instanceId: "codex",
            enabled: true,
            installed: true,
            auth: { email: "" },
            slashCommands: [],
            skills: [],
            models: [{ slug: "gpt-6-luna", name: "Luna", isCustom: false, capabilities: null }],
          },
        ],
      ],
    ]),
}));
vi.mock("../state/shell", () => ({ useEnvironmentShellStatus: () => "live" }));
vi.mock("../state/threads", async () => {
  const Option = await import("effect/Option");
  return {
    threadEnvironment: {
      startTurn: {},
      interruptTurn: {},
      respondToApproval: {},
      respondToUserInput: {},
    },
    useEnvironmentThread: () => ({ data: Option.none() }),
  };
});
vi.mock("./host", async (original) => ({
  ...(await original()),
  getPremiereHostState: () => state.host,
  subscribePremiereHost: () => () => {},
  requestPremiereContext: async () => state.host.context,
  requestPremiereFrame: () => state.frame(),
}));

vi.mock("./timelineHost", async (original) => ({
  ...(await original()),
  requestTimelineSnapshot: async () => {
    throw new Error("No timeline in tests.");
  },
}));

import { PremiereApp } from "./PremiereApp";

function setup(name: string, allowed: boolean) {
  state.environmentId = `premiere-permission-${name}`;
  state.allowed = allowed;
  state.run.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  state.host = { connected: true, context: null };
  state.frame.mockReset().mockResolvedValue({
    id: "current-frame",
    name: "frame-main-00-00-00-00.png",
    mimeType: "image/png",
    sizeBytes: 68,
    dataUrl:
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1cAAAAASUVORK5CYII=",
  });
  localStorage.removeItem(`premiere-draft:${state.environmentId}:editing:new`);
}

it("sends the first draft after loading the paired session's permission", async () => {
  setup("allowed", true);
  // The docked panel has no router navigation.
  await using screen = await render(
    <AppAtomRegistryProvider>
      <PremiereApp />
    </AppAtomRegistryProvider>,
    { router: false },
  );
  const message = screen.getByRole("textbox", { name: "Message your editing assistant" });
  await message.fill("Report the project without changing it.");
  await expect.element(screen.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  await screen.getByRole("button", { name: "Send", exact: true }).click();
  await expect.element(message).toHaveValue("");
  expect(state.run).toHaveBeenCalledTimes(1);
});

it("keeps the draft and disables sending for a read-only paired session", async () => {
  setup("read-only", false);
  // The docked panel has no router navigation.
  await using screen = await render(
    <AppAtomRegistryProvider>
      <PremiereApp />
    </AppAtomRegistryProvider>,
    { router: false },
  );
  const message = screen.getByRole("textbox", { name: "Message your editing assistant" });
  await message.fill("Keep this draft until access is available.");
  await expect.element(screen.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await expect.element(message).toHaveValue("Keep this draft until access is available.");
  expect(state.run).not.toHaveBeenCalled();
});

it("answers panel commands such as /edit without sending them to the agent", async () => {
  setup("panel-command", true);
  // The docked panel has no router navigation.
  await using screen = await render(
    <AppAtomRegistryProvider>
      <PremiereApp />
    </AppAtomRegistryProvider>,
    { router: false },
  );
  const message = screen.getByRole("textbox", { name: "Message your editing assistant" });
  await message.fill("/edi");
  await expect.element(screen.getByRole("option", { name: /edit/ })).toBeVisible();
  await userEvent.keyboard("{Enter}");
  await expect
    .element(screen.getByRole("radio", { name: "Edit" }))
    .toHaveAttribute("aria-checked", "true");
  await expect.element(message).toHaveValue("");
  expect(state.run).not.toHaveBeenCalled();
});

it("attaches the current frame and sends it with fresh timeline selection context", async () => {
  setup("current-frame", true);
  state.host.context = {
    projectName: "Editorial",
    projectPath: "D:/cut.prproj",
    projectDocumentId: "project-a",
    sequenceName: "Main",
    sequenceId: "sequence-a",
    fps: 30,
    playheadSeconds: 62.1,
    selection: [
      {
        name: "Opening",
        trackType: "V",
        trackIndex: 0,
        startSeconds: 62.1,
        endSeconds: 69,
        sourceInSeconds: 0,
        sourceOutSeconds: 6.9,
      },
    ],
  };
  // The docked panel has no router navigation.
  await using screen = await render(
    <AppAtomRegistryProvider>
      <PremiereApp />
    </AppAtomRegistryProvider>,
    { router: false },
  );
  await expect.element(screen.getByText("1 clip selected · 62.1s - 69s")).toBeVisible();
  await screen.getByRole("button", { name: "Attach current frame" }).click();
  await expect
    .element(screen.getByRole("button", { name: "Remove frame-main-00-00-00-00.png" }))
    .toBeVisible();
  await screen
    .getByRole("textbox", { name: "Message your editing assistant" })
    .fill("Review this frame.");
  await screen.getByRole("button", { name: "Send", exact: true }).click();
  await vi.waitFor(() => expect(state.run).toHaveBeenCalledTimes(1));
  expect(state.run.mock.calls[0]?.[0].input.message).toMatchObject({
    text: expect.stringContaining("Selected clips:\nV1"),
    attachments: [
      {
        type: "image",
        name: "frame-main-00-00-00-00.png",
        mimeType: "image/png",
        dataUrl: expect.stringContaining("data:image/png;base64,"),
        sizeBytes: 68,
      },
    ],
  });
  await expect
    .element(screen.getByRole("button", { name: "Remove frame-main-00-00-00-00.png" }))
    .not.toBeInTheDocument();
});

it("shows export failures in the composer error area and allows a retry", async () => {
  setup("frame-error", true);
  state.frame.mockRejectedValueOnce(
    new Error("Open a sequence in Premiere before attaching a frame."),
  );
  // The docked panel has no router navigation.
  await using screen = await render(
    <AppAtomRegistryProvider>
      <PremiereApp />
    </AppAtomRegistryProvider>,
    { router: false },
  );
  await screen.getByRole("button", { name: "Attach current frame" }).click();
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("Open a sequence in Premiere before attaching a frame.");
  await screen.getByRole("button", { name: "Attach current frame" }).click();
  await expect
    .element(screen.getByRole("button", { name: "Remove frame-main-00-00-00-00.png" }))
    .toBeVisible();
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Remove frame-main-00-00-00-00.png" }).click();
  await expect.element(screen.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
});
