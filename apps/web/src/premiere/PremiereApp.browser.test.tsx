import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import {
  NodeId,
  ProviderSessionId,
  RuntimeRequestId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { render } from "../../test/render";
import { AppAtomRegistryProvider } from "../rpc/atomRegistry";
import { makeThreadProjectionFixture } from "../test-fixtures";
import type { PremiereContext } from "./host";
import { transcriptStorageKey } from "./TranscriptView";

const state = vi.hoisted(() => ({
  environmentId: "premiere-permission-test",
  allowed: true,
  run: vi.fn(),
  dismiss: vi.fn(),
  projection: null as OrchestrationV2ThreadProjection | null,
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
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: { label?: string }) =>
    command.label === "dismiss-user-input" ? state.dismiss : state.run,
}));
vi.mock("../state/entities", () => ({
  useProjects: () => [{ id: "editing", environmentId: state.environmentId, name: "Editing" }],
  useThreadShellsForProjectRefs: () =>
    state.projection
      ? [{ ...state.projection.thread, environmentId: state.environmentId, runtime: null }]
      : [],
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
      dismissUserInput: { label: "dismiss-user-input" },
    },
    useEnvironmentThread: (_environmentId: string, threadId: string | null) => ({
      data:
        state.projection?.thread.id === threadId ? Option.some(state.projection) : Option.none(),
      status: "live",
    }),
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
  state.dismiss.mockReset().mockResolvedValue({ _tag: "Success", value: undefined });
  state.projection = null;
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

function setupQuestion(name: string, capability: "live" | "message" | "not_resumable" = "live") {
  setup(name, true);
  const projection = makeThreadProjectionFixture();
  const requestId = RuntimeRequestId.make(`footage-${name}`);
  const nodeId = NodeId.make("question-node");
  state.projection = {
    ...projection,
    runtimeRequests: [
      {
        id: requestId,
        nodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability:
          capability === "live"
            ? { type: "live", providerSessionId: ProviderSessionId.make("codex-session") }
            : capability === "message"
              ? { type: "message" }
              : { type: "not_resumable", reason: "Session expired." },
        createdAt: projection.updatedAt,
        resolvedAt: null,
      },
    ],
    turnItems: [
      {
        id: TurnItemId.make("footage-question"),
        threadId: projection.thread.id,
        runId: null,
        nodeId,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 0,
        status: "completed",
        title: null,
        startedAt: projection.updatedAt,
        completedAt: projection.updatedAt,
        updatedAt: projection.updatedAt,
        type: "user_input_request",
        requestId,
        questions: [
          {
            id: "footage",
            header: "Source footage",
            question: "Which footage should I use?",
            options: [
              { label: "Use clean 480p footage", value: "clean-480p", description: "Clean source" },
              { label: "Use 1080p footage", description: "Larger source" },
            ],
            allowCustomAnswer: true,
            multiSelect: false,
          },
        ],
      },
    ],
  };
  return { threadId: projection.thread.id, requestId };
}

it("sends custom text as a string keyed by question id instead of the selected option", async () => {
  const { threadId, requestId } = setupQuestion("custom-answer");
  // The docked panel has no router navigation.
  await using screen = await render(
    <AppAtomRegistryProvider>
      <PremiereApp />
    </AppAtomRegistryProvider>,
    { router: false },
  );
  await screen.getByRole("combobox", { name: "Editing conversation" }).selectOptions(threadId);
  await screen.getByRole("radio", { name: /Use clean 480p footage/ }).click();
  await screen
    .getByRole("textbox", { name: /Custom answer:/ })
    .fill("  use the clean 480p footage  ");
  await expect
    .element(screen.getByRole("radio", { name: /Use clean 480p footage/ }))
    .not.toBeChecked();
  await screen.getByRole("button", { name: "Send answer" }).click();
  await vi.waitFor(() =>
    expect(state.run).toHaveBeenCalledWith({
      environmentId: state.environmentId,
      input: { threadId, requestId, answers: { footage: "use the clean 480p footage" } },
    }),
  );
  await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
});

it("sends a selected radio's value as a string and clears previous custom text", async () => {
  const { threadId, requestId } = setupQuestion("radio-answer");
  // The docked panel has no router navigation.
  await using screen = await render(
    <AppAtomRegistryProvider>
      <PremiereApp />
    </AppAtomRegistryProvider>,
    { router: false },
  );
  await screen.getByRole("combobox", { name: "Editing conversation" }).selectOptions(threadId);
  await screen.getByRole("textbox", { name: /Custom answer:/ }).fill("old custom answer");
  await screen.getByRole("radio", { name: /Use clean 480p footage/ }).click();
  await expect.element(screen.getByRole("textbox", { name: /Custom answer:/ })).toHaveValue("");
  await screen.getByRole("button", { name: "Send answer" }).click();
  await vi.waitFor(() =>
    expect(state.run).toHaveBeenCalledWith({
      environmentId: state.environmentId,
      input: { threadId, requestId, answers: { footage: "clean-480p" } },
    }),
  );
});

it("shows the backend error for an answer that fails and keeps the question available", async () => {
  const { threadId } = setupQuestion("stale-answer");
  state.run.mockResolvedValue({
    _tag: "Failure",
    cause: Cause.fail(new Error("This question has already been answered.")),
  });
  // The docked panel has no router navigation.
  await using screen = await render(
    <AppAtomRegistryProvider>
      <PremiereApp />
    </AppAtomRegistryProvider>,
    { router: false },
  );
  await screen.getByRole("combobox", { name: "Editing conversation" }).selectOptions(threadId);
  await screen.getByRole("radio", { name: /Use clean 480p footage/ }).click();
  await screen.getByRole("button", { name: "Send answer" }).click();
  await expect
    .element(screen.getByRole("alert"))
    .toHaveTextContent("This question has already been answered.");
  await expect.element(screen.getByRole("button", { name: "Dismiss question" })).toBeEnabled();
});

it("dismisses an expired question locally and remembers it after remounting", async () => {
  const { threadId } = setupQuestion("dismiss-expired", "not_resumable");
  // The docked panel has no router navigation.
  await using screen = await render(
    <AppAtomRegistryProvider>
      <PremiereApp />
    </AppAtomRegistryProvider>,
    { router: false },
  );
  await screen.getByRole("combobox", { name: "Editing conversation" }).selectOptions(threadId);
  await expect.element(screen.getByRole("button", { name: "Send answer" })).toBeDisabled();
  await screen.getByRole("button", { name: "Dismiss question" }).click();
  await expect.element(screen.getByRole("button", { name: "Send answer" })).not.toBeInTheDocument();
  expect(state.dismiss).not.toHaveBeenCalled();
  expect(state.run).not.toHaveBeenCalled();
  await screen.rerender(<span />);
  await screen.rerender(
    <AppAtomRegistryProvider>
      <PremiereApp />
    </AppAtomRegistryProvider>,
  );
  await screen.getByRole("combobox", { name: "Editing conversation" }).selectOptions(threadId);
  await expect.element(screen.getByRole("button", { name: "Send answer" })).not.toBeInTheDocument();
});

it("also dismisses asynchronous questions on the server", async () => {
  const { threadId, requestId } = setupQuestion("dismiss-message", "message");
  // The docked panel has no router navigation.
  await using screen = await render(
    <AppAtomRegistryProvider>
      <PremiereApp />
    </AppAtomRegistryProvider>,
    { router: false },
  );
  await screen.getByRole("combobox", { name: "Editing conversation" }).selectOptions(threadId);
  await screen.getByRole("button", { name: "Dismiss question" }).click();
  await expect.element(screen.getByRole("button", { name: "Send answer" })).not.toBeInTheDocument();
  await vi.waitFor(() =>
    expect(state.dismiss).toHaveBeenCalledWith({
      environmentId: state.environmentId,
      input: { threadId, requestId },
    }),
  );
  expect(state.run).not.toHaveBeenCalled();
});

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

it("inserts quoted transcript context into the existing composer draft and opens the conversation", async () => {
  setup("transcript-context", true);
  const context: PremiereContext = {
    projectName: "Film",
    projectPath: "D:/Film.prproj",
    projectDocumentId: "film",
    sequenceId: "ask-axis",
    sequenceName: "Opening",
    fps: 25,
    playheadSeconds: 0,
  };
  state.host = { connected: true, context };
  localStorage.setItem(
    transcriptStorageKey(context),
    JSON.stringify({
      transcript: {
        source: "WhisperX JSON · voice.json",
        timing: "word",
        offset: 0,
        words: [
          { text: "Look", start: 2, end: 2.4 },
          { text: "closer.", start: 2.5, end: 3 },
        ],
      },
      undo: null,
      uncertain: false,
    }),
  );
  // The CEP panel has no router navigation.
  await using screen = await render(
    <AppAtomRegistryProvider>
      <PremiereApp />
    </AppAtomRegistryProvider>,
    { router: false },
  );
  await screen
    .getByRole("textbox", { name: "Message your editing assistant" })
    .fill("Put a shot here:");
  await screen.getByRole("button", { name: "Transcript", exact: true }).click();
  await screen.getByRole("button", { name: "Look at 00:00:02.000" }).click();
  await screen
    .getByRole("button", { name: "closer. at 00:00:02.500" })
    .click({ modifiers: ["Shift"] });
  await screen.getByRole("button", { name: "Ask Axis", exact: true }).click();
  await expect
    .element(screen.getByRole("textbox", { name: "Message your editing assistant" }))
    .toHaveValue(
      'Put a shot here:\n\nTranscript from "Opening" [00:00:02.000 - 00:00:03.000] (WhisperX JSON · voice.json):\n> Look closer.\n\n',
    );
  await expect
    .element(screen.getByRole("button", { name: "Conversation", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
});
