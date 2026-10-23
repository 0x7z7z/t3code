import { expect, it, vi } from "vite-plus/test";
import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";

const state = vi.hoisted(() => ({
  environmentId: "premiere-permission-test",
  allowed: true,
  run: vi.fn(),
  host: { connected: true, context: null },
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
  requestPremiereContext: async () => null,
}));

import { PremiereApp } from "./PremiereApp";

function setup(name: string, allowed: boolean) {
  state.environmentId = `premiere-permission-${name}`;
  state.allowed = allowed;
  state.run.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
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
