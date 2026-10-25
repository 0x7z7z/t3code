import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import {
  NodeId,
  MessageId,
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
import type { MusicPlan, MusicTrack } from "./music";
import { transcriptStorageKey } from "./TranscriptView";
import "./styles.css";

const state = vi.hoisted(() => ({
  environmentId: "premiere-permission-test",
  allowed: true,
  signedIn: true,
  run: vi.fn(),
  dismiss: vi.fn(),
  projection: null as OrchestrationV2ThreadProjection | null,
  host: { connected: true, context: null as PremiereContext | null },
  frame: vi.fn(),
  handoff: vi.fn(),
  music: vi.fn(),
  snapshot: vi.fn(),
  audioProvider: false,
  upload: vi.fn(),
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
    command.label === "dismiss-user-input"
      ? state.dismiss
      : command.label === "music-upload"
        ? state.upload
        : state.run,
}));
vi.mock("../state/attachments", () => ({
  attachmentEnvironment: { createUploadUrl: { label: "music-upload" } },
}));
vi.mock("../state/session", async (original) => ({
  ...(await original()),
  readPreparedConnection: () => ({ httpBaseUrl: "http://axis-test.invalid" }),
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
            driver: state.audioProvider ? "antigravity" : "codex",
            enabled: true,
            installed: true,
            auth: { status: state.signedIn ? "authenticated" : "unauthenticated", email: "" },
            slashCommands: [],
            skills: [],
            models: [
              {
                slug: state.audioProvider ? "gemini-test" : "gpt-6-luna",
                name: "Luna",
                isCustom: false,
                capabilities: {
                  optionDescriptors: [
                    {
                      id: "reasoningEffort",
                      label: "Reasoning",
                      type: "select",
                      currentValue: "max",
                      options: [
                        { id: "high", label: "High" },
                        { id: "max", label: "Max" },
                      ],
                    },
                    {
                      id: "serviceTier",
                      label: "Service Tier",
                      type: "select",
                      currentValue: "priority",
                      options: [
                        { id: "priority", label: "Priority" },
                        { id: "flex", label: "Flex" },
                      ],
                    },
                  ],
                },
              },
            ],
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
  requestTimelineSnapshot: state.snapshot,
}));
vi.mock("./interactiveHost", async (original) => ({
  ...(await original()),
  requestTimelineAction: state.music,
}));
vi.mock("./whisperTranscription", async (original) => ({
  ...(await original()),
  loadWhisperTranscript: state.handoff,
}));

import { modelOptionsStorageKey, PremiereApp } from "./PremiereApp";

function setup(name: string, allowed: boolean) {
  state.handoff.mockReset().mockResolvedValue({
    content: null,
    outputPath: "D:/workspace/axis-transcripts/test.json",
    helperPath: "D:/extension/tools/axis_transcript.py",
  });
  state.environmentId = `premiere-permission-${name}`;
  state.allowed = allowed;
  state.signedIn = true;
  state.audioProvider = false;
  state.upload
    .mockReset()
    .mockResolvedValue({ _tag: "Success", value: { relativeUrl: "/api/assets/music" } });
  state.music.mockReset();
  state.snapshot.mockReset().mockRejectedValue(new Error("No timeline in tests."));
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
  localStorage.removeItem(modelOptionsStorageKey);
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

it("guides a signed-out account to setup and disables sending", async () => {
  setup("signed-out", true);
  state.signedIn = false;
  // The docked panel has no router navigation.
  await using screen = await render(
    <AppAtomRegistryProvider>
      <PremiereApp />
    </AppAtomRegistryProvider>,
    { router: false },
  );
  await screen
    .getByRole("textbox", { name: "Message your editing assistant" })
    .fill("Help me edit.");
  await expect.element(screen.getByRole("button", { name: "Open account setup" })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
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

it("grows the composer to its line and panel caps and shrinks after clearing or sending", async () => {
  setup("composer-height", true);
  await page.viewport(440, 720);
  try {
    const container = document.createElement("div");
    container.style.height = "100vh";
    // The docked panel has no router navigation.
    await using screen = await render(
      <AppAtomRegistryProvider>
        <PremiereApp />
      </AppAtomRegistryProvider>,
      { router: false, container },
    );
    const message = screen.getByRole("textbox", { name: "Message your editing assistant" });
    const input = message.element() as HTMLTextAreaElement;
    const initialHeight = input.clientHeight;
    const sendBounds = screen
      .getByRole("button", { name: "Send", exact: true })
      .element()
      .getBoundingClientRect();
    const usageBounds = screen
      .getByRole("button", { name: /^Context window/ })
      .element()
      .getBoundingClientRect();
    expect(usageBounds.right).toBeLessThanOrEqual(sendBounds.left);
    expect(Math.abs(usageBounds.top - sendBounds.top)).toBeLessThanOrEqual(2);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(440);
    await message.fill(Array.from({ length: 6 }, (_, i) => `Line ${i + 1}`).join("\n"));
    await expect.poll(() => input.clientHeight).toBeGreaterThan(initialHeight + 40);
    await page.screenshot({ path: "./__screenshots__/axis-composer-after.png" });
    await message.fill(Array.from({ length: 30 }, (_, i) => `Line ${i + 1}`).join("\n"));
    await expect.poll(() => input.scrollHeight > input.clientHeight).toBe(true);
    expect(input.clientHeight).toBeLessThanOrEqual(
      12 * parseFloat(getComputedStyle(input).lineHeight) + 8,
    );
    expect(getComputedStyle(input, "::-webkit-scrollbar").width).toBe("4px");
    await page.viewport(440, 360);
    await expect.poll(() => input.clientHeight).toBeLessThanOrEqual(144);
    await message.fill("");
    await expect.poll(() => input.clientHeight).toBe(initialHeight);
    await message.fill("Send this\nwith several\nlines of\ncontext.");
    await expect.element(screen.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
    await screen.getByRole("button", { name: "Send", exact: true }).click();
    await expect.element(message).toHaveValue("");
    await expect.poll(() => input.clientHeight).toBe(initialHeight);
  } finally {
    await page.viewport(1280, 720);
  }
});

it("opens compact model controls by default and remembers the user's toggle across mounts", async () => {
  setup("model-controls", true);
  // The docked panel has no router navigation.
  await using screen = await render(
    <AppAtomRegistryProvider>
      <PremiereApp />
    </AppAtomRegistryProvider>,
    { router: false },
  );
  await expect
    .element(screen.getByRole("combobox", { name: "Reasoning", exact: true }))
    .toHaveValue("max");
  await expect
    .element(screen.getByRole("combobox", { name: "Service Tier", exact: true }))
    .toHaveValue("priority");
  await screen.getByRole("button", { name: "Model settings" }).click();
  await expect
    .element(screen.getByRole("button", { name: "Model settings" }))
    .toHaveAttribute("aria-expanded", "false");
  await screen.rerender(null);
  await screen.rerender(
    <AppAtomRegistryProvider>
      <PremiereApp />
    </AppAtomRegistryProvider>,
  );
  await expect
    .element(screen.getByRole("combobox", { name: "Reasoning", exact: true }))
    .not.toBeInTheDocument();
  await screen.getByRole("button", { name: "Model settings" }).click();
  await screen.rerender(null);
  await screen.rerender(
    <AppAtomRegistryProvider>
      <PremiereApp />
    </AppAtomRegistryProvider>,
  );
  await expect
    .element(screen.getByRole("combobox", { name: "Reasoning", exact: true }))
    .toHaveValue("max");
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

it("starts a dedicated WhisperX artifact turn while the composer stays in Plan and keeps its draft", async () => {
  setup("whisper-turn", true);
  state.host = {
    connected: true,
    context: {
      projectName: "Film",
      projectPath: "D:/Film.prproj",
      projectDocumentId: "film",
      sequenceName: "VO",
      sequenceId: "vo",
      fps: 25,
      playheadSeconds: 0,
    },
  };
  // The CEP panel has no router navigation.
  await using screen = await render(
    <AppAtomRegistryProvider>
      <PremiereApp />
    </AppAtomRegistryProvider>,
    { router: false },
  );
  await screen
    .getByRole("textbox", { name: "Message your editing assistant" })
    .fill("Keep this draft");
  await screen.getByRole("button", { name: "Transcript", exact: true }).click();
  await expect
    .element(screen.getByRole("button", { name: "Transcribe with WhisperX" }))
    .toBeEnabled();
  await screen.getByRole("button", { name: "Transcribe with WhisperX" }).click();
  await vi.waitFor(() =>
    expect(state.run).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          interactionMode: "default",
          bootstrap: expect.objectContaining({
            createThread: expect.objectContaining({ interactionMode: "default" }),
          }),
          message: expect.objectContaining({
            text: expect.stringContaining('<axis-whisper-instructions version="1">'),
          }),
        }),
      }),
    ),
  );
  await screen.getByRole("button", { name: "Conversation", exact: true }).click();
  await expect
    .element(screen.getByRole("textbox", { name: "Message your editing assistant" }))
    .toHaveValue("Keep this draft");
  await expect
    .element(screen.getByRole("radio", { name: "Plan", exact: true }))
    .toHaveAttribute("aria-checked", "true");
});

function setupMusic(name: string) {
  setup(name, true);
  state.audioProvider = true;
  const context: PremiereContext = {
    projectName: "Film",
    projectPath: "D:/Film.prproj",
    projectDocumentId: `film-${name}`,
    sequenceId: "main",
    sequenceName: "Main edit",
    fps: 25,
    playheadSeconds: 0,
  };
  state.host = { connected: true, context };
  localStorage.setItem(
    transcriptStorageKey(context),
    JSON.stringify({
      transcript: {
        source: "WhisperX (Axis)",
        timing: "word",
        offset: 0,
        words: Array.from({ length: 600 }, (_, i) => ({
          text: ["Um,", "Every", "frame", "matters."][i % 4],
          start: i,
          end: i + 0.4,
        })),
      },
      link: null,
      undo: null,
      uncertain: false,
    }),
  );
  localStorage.removeItem(`axis-music:${JSON.stringify(context.projectDocumentId)}`);
  const track: MusicTrack = {
    path: "D:/Music/Strings.wav",
    filename: "Strings.wav",
    category: "Action",
    duration: 1200,
    loudnessDbfs: -18,
    energy: [],
    rises: [],
    loudWindows: [{ start: 10, end: 40 }],
    quietRanges: [],
    phraseBoundaries: [0, 8],
    description: "",
    tags: [],
    tempo: null,
  };
  const plan: MusicPlan = {
    version: 1,
    cues: [
      {
        id: "agent-cue",
        chapter: "Agent chapter",
        start: 0,
        end: 20,
        track: track.path,
        sourceOffset: 12,
        reason: "A measured opening bed.",
        fadeIn: 1,
        fadeOut: 1,
        baseDb: -22,
        enabled: true,
        alternatives: [],
      },
    ],
    silence: [],
  };
  state.music.mockImplementation(async (_type, request) => {
    if (request.action === "index")
      return { tracks: [track], pending: 2, failures: [], tool: "D:/Axis/tools/axis_music.py" };
    if (request.action === "audition")
      return { dataUrl: "data:audio/wav;base64,UklGRg==", sizeBytes: 6 };
    return {};
  });
  state.snapshot.mockResolvedValue({
    signature: "before",
    snapshot: { projectId: context.projectDocumentId },
  });
  const projection = makeThreadProjectionFixture();
  state.projection = {
    ...projection,
    thread: {
      ...projection.thread,
      modelSelection: { instanceId: projection.thread.providerInstanceId, model: "gemini-test" },
    },
    turnItems: [
      {
        id: TurnItemId.make("music-reply"),
        threadId: projection.thread.id,
        runId: null,
        nodeId: null,
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
        type: "assistant_message",
        messageId: MessageId.make("music-reply"),
        streaming: false,
        text: `${"A long conversation about the edit.\n\n".repeat(100)}\n\`\`\`axis-music\n${JSON.stringify(plan)}\n\`\`\``,
      },
    ],
  };
  return { context, plan, track, threadId: projection.thread.id };
}

function musicApp() {
  return (
    <AppAtomRegistryProvider>
      <PremiereApp />
    </AppAtomRegistryProvider>
  );
}

it("keeps the Music draft through tabs, stable polling, agent delivery, describe and a missing context poll", async () => {
  const f = setupMusic("music-lifetime");
  using _upload = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(null, { status: 200 }));
  // The CEP panel has no router navigation.
  await using screen = await render(musicApp(), { router: false });
  await screen.getByRole("combobox", { name: "Editing conversation" }).selectOptions(f.threadId);
  await screen.getByRole("button", { name: "Transcript", exact: true }).click();
  await screen.getByRole("button", { name: "Transcript options" }).click();
  await screen.getByRole("button", { name: "Music", exact: true }).click();
  await screen.getByRole("textbox", { name: "Music library folder" }).fill("D:/Music");
  await screen.getByRole("button", { name: "Index library", exact: true }).click();
  await screen.getByLabelText("Music levels and exclusions").click();
  await screen.getByRole("textbox", { name: "Sponsor and silence ranges" }).fill("60-90");
  await screen.getByRole("button", { name: "Conversation", exact: true }).click();
  state.host = {
    connected: true,
    context: {
      ...f.context,
      projectPath: "d:\\Film.prproj",
      sequenceName: "Renamed edit",
      playheadSeconds: 25,
    },
  };
  expect(transcriptStorageKey(state.host.context!)).toBe(transcriptStorageKey(f.context));
  await screen.rerender(musicApp());
  await screen.getByRole("button", { name: "Review music", exact: true }).click();
  await expect.element(screen.getByRole("region", { name: "Music", exact: true })).toBeVisible();
  await screen.getByRole("spinbutton", { name: "Source offset for Agent chapter" }).fill("17");
  await screen.getByRole("checkbox", { name: "Include Agent chapter" }).click();
  await screen.getByRole("button", { name: "Describe library", exact: true }).click();
  await vi.waitFor(() =>
    expect(state.run).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          message: expect.objectContaining({ attachments: expect.any(Array) }),
        }),
      }),
    ),
  );
  await expect.element(screen.getByRole("region", { name: "Music", exact: true })).toBeVisible();
  await screen.getByRole("button", { name: "Conversation", exact: true }).click();
  await screen.getByRole("button", { name: "Transcript", exact: true }).click();
  state.host = { connected: true, context: null };
  await screen.rerender(musicApp());
  state.host = { connected: true, context: f.context };
  await screen.rerender(musicApp());
  await expect
    .element(screen.getByRole("textbox", { name: "Music library folder" }))
    .toHaveValue("D:/Music");
  await expect
    .element(screen.getByRole("textbox", { name: "Sponsor and silence ranges" }))
    .toHaveValue("60-90");
  await expect
    .element(screen.getByRole("spinbutton", { name: "Source offset for Agent chapter" }))
    .toHaveValue(17);
  await expect
    .element(screen.getByRole("checkbox", { name: "Include Agent chapter" }))
    .not.toBeChecked();
  await expect.element(screen.getByRole("button", { name: "Resume index (2)" })).toBeEnabled();
  expect(state.music.mock.calls.filter(([, r]) => r.action === "index")).toHaveLength(1);
  expect(screen.container.querySelector("[data-music-panel] [role=status]")?.textContent).toContain(
    "Library description sent.",
  );
  state.host = { connected: true, context: { ...f.context, sequenceId: "another-sequence" } };
  await screen.rerender(musicApp());
  await expect
    .element(screen.getByRole("button", { name: "Import transcript", exact: true }))
    .toBeVisible();
  expect(screen.container.querySelector("[data-music-panel]")).toBeNull();
});

it("retains an indexing job and tool drafts when switching away, closing and reopening tools", async () => {
  const f = setupMusic("music-index-lifetime");
  let finishIndex!: (value: object) => void;
  const indexed = new Promise<object>((resolve) => {
    finishIndex = resolve;
  });
  state.music.mockImplementationOnce(() => indexed);
  // The CEP panel has no router navigation.
  await using screen = await render(musicApp(), { router: false });
  await screen.getByRole("button", { name: "Transcript", exact: true }).click();
  await screen.getByRole("button", { name: "Transcript options" }).click();
  await screen.getByRole("button", { name: "Music", exact: true }).click();
  await screen.getByRole("textbox", { name: "Music library folder" }).fill("D:/Music");
  await screen.getByRole("button", { name: "Index library", exact: true }).click();
  await screen.getByRole("button", { name: "Conversation", exact: true }).click();
  state.host = { connected: true, context: null };
  await screen.rerender(musicApp());
  state.host = { connected: true, context: f.context };
  await screen.rerender(musicApp());
  finishIndex({ tracks: [f.track], pending: 2, failures: [] });
  await screen.getByRole("button", { name: "Transcript", exact: true }).click();
  await expect.element(screen.getByRole("button", { name: "Resume index (2)" })).toBeEnabled();
  await screen.getByRole("button", { name: "Build music plan" }).click();
  await screen.getByRole("button", { name: "Close Music" }).click();
  await screen.getByRole("button", { name: "Transcript options" }).click();
  await screen.getByRole("button", { name: "Captions", exact: true }).click();
  await screen.getByRole("combobox", { name: "Caption case" }).selectOptions("upper");
  await screen.getByRole("button", { name: "Close captions" }).click();
  await screen.getByRole("button", { name: "Transcript options" }).click();
  await screen.getByRole("button", { name: "Music", exact: true }).click();
  await expect.element(screen.getByRole("button", { name: "Resume index (2)" })).toBeEnabled();
  expect(screen.container.querySelector("[data-music-cues] li")).not.toBeNull();
  await screen.getByRole("button", { name: "Close Music" }).click();
  await screen.getByRole("button", { name: "Transcript options" }).click();
  await screen.getByRole("button", { name: "Captions", exact: true }).click();
  await expect.element(screen.getByRole("combobox", { name: "Caption case" })).toHaveValue("upper");
  expect(state.music.mock.calls.filter(([, r]) => r.action === "index")).toHaveLength(1);
});

it.each(["Captions", "Clean up"])(
  "keeps %s edits through Conversation and context polling",
  async (tool) => {
    const f = setupMusic(`tool-lifetime-${tool}`);
    // The CEP panel has no router navigation.
    await using screen = await render(musicApp(), { router: false });
    await screen.getByRole("button", { name: "Transcript", exact: true }).click();
    await screen.getByRole("button", { name: "Transcript options" }).click();
    await screen.getByRole("button", { name: tool, exact: true }).click();
    if (tool === "Captions") {
      await screen.getByRole("combobox", { name: "Caption case" }).selectOptions("upper");
      await screen.getByRole("checkbox", { name: "Strip punctuation" }).click();
    } else {
      await screen.getByRole("spinbutton", { name: "Pause threshold (s)" }).fill("2");
      await page
        .elementLocator(screen.container.querySelectorAll("[data-cleanup-groups] summary")[1]!)
        .click();
      await screen.getByRole("checkbox", { name: /Include Um,/ }).click();
    }
    await screen.getByRole("button", { name: "Conversation", exact: true }).click();
    state.host = { connected: true, context: { ...f.context, playheadSeconds: 30 } };
    await screen.rerender(musicApp());
    state.host = { connected: true, context: null };
    await screen.rerender(musicApp());
    state.host = { connected: true, context: f.context };
    await screen.rerender(musicApp());
    await screen.getByRole("button", { name: "Transcript", exact: true }).click();
    if (tool === "Captions") {
      await expect
        .element(screen.getByRole("combobox", { name: "Caption case" }))
        .toHaveValue("upper");
      await expect
        .element(screen.getByRole("checkbox", { name: "Strip punctuation" }))
        .toBeChecked();
    } else {
      await expect
        .element(screen.getByRole("spinbutton", { name: "Pause threshold (s)" }))
        .toHaveValue(2);
      await expect.element(screen.getByRole("checkbox", { name: /Include Um,/ })).not.toBeChecked();
      await screen.getByRole("button", { name: "Transcript options" }).click();
      await screen.getByRole("button", { name: "Music", exact: true }).click();
      await screen.getByRole("button", { name: "Close Music" }).click();
      await screen.getByRole("button", { name: "Um, at 00:00:00.000" }).click();
      await expect
        .element(screen.getByRole("group", { name: "Transcript selection actions" }))
        .toBeVisible();
    }
  },
);

it.each(
  [
    { width: 440, height: 720 },
    { width: 1400, height: 900 },
  ].flatMap((size) => ["Music", "Captions", "Clean up"].map((tool) => ({ ...size, tool }))),
)(
  "contains $tool with long transcript and chat at $width x $height",
  async ({ width, height, tool }) => {
    const f = setupMusic(`contain-${tool}-${width}`);
    await page.viewport(width, height);
    // The CEP panel has no router navigation.
    await using screen = await render(musicApp(), { router: false });
    screen.container.style.cssText = `width:${width}px;height:${height}px;position:fixed;inset:0;`;
    await screen.getByRole("combobox", { name: "Editing conversation" }).selectOptions(f.threadId);
    await screen.getByRole("button", { name: "Transcript", exact: true }).click();
    await screen.getByRole("button", { name: "Transcript options" }).click();
    await screen.getByRole("button", { name: tool, exact: true }).click();
    if (tool === "Music") {
      await screen.getByRole("textbox", { name: "Music library folder" }).fill("D:/Music");
      await screen.getByRole("button", { name: "Index library", exact: true }).click();
      await screen.getByRole("button", { name: "Build music plan" }).click();
    }
    const selector =
      tool === "Music"
        ? "[data-music-panel]"
        : tool === "Captions"
          ? "[data-captions-panel]"
          : "[data-cleanup-review]";
    await expect
      .element(page.elementLocator(screen.container.querySelector(selector)!))
      .toBeVisible();
    const panel = screen.container.querySelector<HTMLElement>(selector)!;
    if (tool === "Music") {
      expect(
        panel.querySelector("[data-music-cues] li")!.getBoundingClientRect().height,
      ).toBeGreaterThan(48);
      expect(
        panel.querySelector("[data-music-bands]")!.getBoundingClientRect().height,
      ).toBeGreaterThan(0);
    }
    const shot = `../../../../.t3/music-panel/${tool.toLowerCase().replaceAll(" ", "-")}-${width}x${height}.png`;
    await page.screenshot({ path: shot });
    const rect = panel.getBoundingClientRect();
    const composer = screen.container.querySelector("[data-composer]")!.getBoundingClientRect();
    expect(rect.bottom).toBeLessThanOrEqual(composer.top);
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(width);
    expect(panel.scrollWidth).toBeLessThanOrEqual(panel.clientWidth);
    expect(getComputedStyle(panel).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(
      screen.container.querySelector("[data-transcript]")!.getBoundingClientRect().height,
    ).toBe(0);
    const words = screen.container.querySelector("[data-transcript-body]")!.getBoundingClientRect();
    if (tool === "Clean up") {
      expect(rect.bottom).toBeLessThanOrEqual(words.top);
      expect(words.height).toBeGreaterThan(50);
    } else expect(words.height).toBe(0);
    for (const x of [rect.left + 4, rect.right - 4]) {
      const painted = document.elementFromPoint(x, Math.min(rect.bottom - 4, rect.top + 80));
      expect(panel.contains(painted)).toBe(true);
    }
    panel.scrollTop = panel.scrollHeight;
    for (const x of [rect.left + 4, rect.right - 4]) {
      expect(panel.contains(document.elementFromPoint(x, rect.bottom - 4))).toBe(true);
    }
  },
);
