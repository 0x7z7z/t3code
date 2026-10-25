import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import {
  AuthOrchestrationOperateScope,
  type RuntimeMode,
  type ThreadId,
  type UsageLimitsReport,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { createModelSelection } from "@t3tools/shared/model";
import { collectProviderUsageLimits } from "@t3tools/shared/usageLimits";
import * as Option from "effect/Option";
import { CameraIcon } from "lucide-react";

import { connectPairing } from "../connection/onboarding";
import { readHostedPairingRequest } from "../hostedPairing";
import { newMessageId, newThreadId } from "../lib/utils";
import { useProjects, useServerConfigs, useThreadShellsForProjectRefs } from "../state/entities";
import { useEnvironmentProviders, useEnvironments } from "../state/environments";
import { useEnvironmentShellStatus } from "../state/shell";
import { useEnvironmentScope } from "../state/session";
import { threadEnvironment, useEnvironmentThread } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import {
  getPremiereHostState,
  subscribePremiereHost,
  requestPremiereContext,
  requestPremiereFrame,
  premiereSelectionSummary,
  formatPremierePrompt,
  samePremiereScope,
  seekPremiere,
  setPremiereTranscriptActive,
} from "./host";
import {
  accountLabel,
  panelActionFor,
  readImages,
  type PanelAction,
  slashItems,
  slashTrigger,
  type ComposerImage,
  type SlashItem,
} from "./composer";
import { AccessModeMenu, AttachButton, ImageStrip, SlashMenu, UsageCard } from "./ComposerParts";
import { Markdown, type SeekHandler } from "./Markdown";
import { createTimelineActions, useTimelineClips } from "./interactiveHost";
import { editingModelOptions } from "./models";
import { selectEditingModel, selectEditingProvider, selectEditingWorkspace } from "./selection";
import { buildTranscript, summarizeSteps, type ToolStep } from "./transcript";
import { useTurnChanges } from "./useTurnChanges";
import { TurnChanges } from "./TurnChangesCard";
import type { TurnChangeRecord } from "./turnChanges";
import { QuestionCard } from "./QuestionCard";
import { TranscriptView, transcriptStorageKey } from "./TranscriptView";
import type { CleanupSettings } from "./transcriptCleanup";
import { ComposerUsage } from "./ComposerUsage";
import {
  deriveLatestContextWindowSnapshot,
  latestProviderTurnTokenUsage,
} from "../lib/contextWindow";
import { observeResize } from "../lib/observeResize";
import { SetupPanel } from "./SetupPanel";

export const modelOptionsStorageKey = "axis-composer-model-options-open";

const ACTIVE = new Set(["preparing", "queued", "starting", "running", "waiting"]);
const SETTLED = new Set(["completed", "failed", "cancelled", "interrupted", "rolled_back"]);

export function PremiereApp() {
  const projects = useProjects();
  const { environments } = useEnvironments();
  const providerMap = useEnvironmentProviders();
  const host = useSyncExternalStore(subscribePremiereHost, getPremiereHostState);
  const clips = useTimelineClips(host.context);
  const [workspaceKey, setWorkspaceKey] = useState<string | null>(null);
  const project = selectEditingWorkspace(projects, workspaceKey);
  const projectRef = project
    ? { environmentId: project.environmentId, projectId: project.id }
    : null;
  const environmentId = project?.environmentId ?? environments[0]?.environmentId ?? null;
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const baseTimelineActions = createTimelineActions(host.context, clips, canOperate);
  const providers = environmentId ? (providerMap.get(environmentId) ?? []) : [];
  const [providerKey, setProviderKey] = useState<string | null>(null);
  const provider = selectEditingProvider(providers, providerKey);
  const providerSignedOut = provider?.auth.status === "unauthenticated";
  const [modelKey, setModelKey] = useState<string | null>(null);
  const model = selectEditingModel(provider?.models ?? [], modelKey);
  if (workspaceKey === null && project) setWorkspaceKey(`${project.environmentId}:${project.id}`);
  if (providerKey === null && provider) setProviderKey(provider.instanceId);
  if (modelKey === null && model) setModelKey(model.slug);
  const [optionValues, setOptionValues] = useState<Record<string, string | boolean>>({});
  const threads = useThreadShellsForProjectRefs(projectRef ? [projectRef] : []).filter(
    (thread) => thread.archivedAt === null && thread.deletedAt === null,
  );
  const [selectedThread, setSelectedThread] = useState<ThreadId | null>(null);
  const thread = threads.find((candidate) => candidate.id === selectedThread) ?? null;
  const detail = useEnvironmentThread(environmentId, selectedThread);
  const projection = Option.getOrNull(detail.data);
  const shellStatus = useEnvironmentShellStatus(environmentId);
  const ready = shellStatus === "live";
  const pending = projection
    ? derivePendingThreadRequests(projection)
    : { approvals: [], userInputs: [] };
  const [draftState, setDraftState] = useState<{ key: string; value: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [panelView, setPanelView] = useState<"conversation" | "transcript">("conversation");
  const [cleanupRequest, setCleanupRequest] = useState<{
    scope: string;
    settings: CleanupSettings;
  } | null>(null);
  const timelineActions = baseTimelineActions
    ? {
        ...baseTimelineActions,
        reviewCleanup: (settings: CleanupSettings) => {
          if (!host.context) return;
          setCleanupRequest({ scope: transcriptStorageKey(host.context), settings });
          setPanelView("transcript");
        },
      }
    : undefined;
  const [transcriptBusy, setTranscriptBusy] = useState(false);
  const [transcriptionTurn, setTranscriptionTurn] = useState<{
    threadId: ThreadId;
    messageId: ReturnType<typeof newMessageId>;
  } | null>(null);
  const transcriptVisible = panelView === "transcript" && host.connected;
  useEffect(() => {
    setPremiereTranscriptActive(transcriptVisible);
    return () => setPremiereTranscriptActive(false);
  }, [transcriptVisible]);
  const [capturingFrame, setCapturingFrame] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [mode, setMode] = useState<"plan" | "default">("plan");
  const [showOptions, setShowOptions] = useState(() => {
    try {
      return localStorage.getItem(modelOptionsStorageKey) !== "false";
    } catch {
      return true;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(modelOptionsStorageKey, String(showOptions));
    } catch {
      /* CEP can disable browser storage. */
    }
  }, [showOptions]);
  // Auto lets supported providers approve routine actions; the editor can change it per message.
  const [runtimeMode, setRuntimeMode] = useState<RuntimeMode>("auto");
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [cursor, setCursor] = useState(0);
  const [slashHighlight, setSlashHighlight] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState<number | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const optionDescriptors = model?.capabilities?.optionDescriptors ?? [];
  const blocks = buildTranscript(projection?.turnItems ?? []);
  const lastBlock = blocks.at(-1);
  const lastStreaming = lastBlock?.kind === "assistant" && lastBlock.streaming;
  const status = !ready
    ? pairing
      ? "Pairing with the assistant…"
      : "Connecting to the assistant…"
    : !host.connected
      ? "Waiting for Premiere…"
      : !host.context
        ? "No active sequence. Open one to give the assistant timeline context."
        : null;
  const connect = useAtomCommand(connectPairing, { reportFailure: false });
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn);
  const stopTurn = useOrchestrationCommand(threadEnvironment.interruptTurn);
  const approve = useOrchestrationCommand(threadEnvironment.respondToApproval);
  const paired = useRef(false);
  const inFlight = useRef(false);
  const transcript = useRef<HTMLDivElement>(null);
  const followTranscript = useRef(true);
  const otherActive = threads.some(
    (candidate) =>
      candidate.id !== selectedThread && candidate.runtime && ACTIVE.has(candidate.runtime.status),
  );
  const running = thread?.runtime ? ACTIVE.has(thread.runtime.status) : false;
  const transcriptionRun =
    transcriptionTurn?.threadId === selectedThread
      ? projection?.runs.find((run) => run.userMessageId === transcriptionTurn.messageId)
      : undefined;
  const transcriptionFinished = transcriptionRun && SETTLED.has(transcriptionRun.status);
  const transcriptionThread = threads.find(
    (candidate) => candidate.id === transcriptionTurn?.threadId,
  );
  let transcriptionReply: (typeof blocks)[number] | undefined;
  for (const block of blocks) {
    if (block.kind === "assistant" || (block.kind === "notice" && block.error))
      transcriptionReply = block;
  }
  const timelineChanges = useTurnChanges(
    selectedThread,
    projection?.runs ?? [],
    projection?.turnItems ?? [],
    blocks,
    detail.status === "live",
  );
  const changeCard = (record: TurnChangeRecord) => (
    <TurnChanges
      key={record.messageId}
      record={record}
      host={host}
      latest={timelineChanges.latestId === record.messageId}
      busy={
        busy ||
        transcriptBusy ||
        running ||
        otherActive ||
        timelineChanges.pending ||
        timelineChanges.undoing
      }
      onRestored={timelineChanges.restored}
      onRestoring={timelineChanges.setUndoing}
    />
  );
  const timelineLocked =
    transcriptBusy ||
    timelineChanges.undoing ||
    (selectedThread !== null && timelineChanges.pendingThreadId === selectedThread);
  const draftKey = `premiere-draft:${environmentId}:${project?.id}:${selectedThread ?? "new"}`;
  let storedDraft = "";
  try {
    storedDraft = localStorage.getItem(draftKey) ?? "";
  } catch {
    /* Browser storage can be unavailable. */
  }
  const draft = draftState?.key === draftKey ? draftState.value : storedDraft;
  useLayoutEffect(() => {
    const input = textarea.current;
    const panel = input?.closest("[data-premiere-client]");
    if (!input || !panel || input.value !== draft) return;
    const resize = () => {
      input.style.height = "0px";
      input.style.height = `${input.scrollHeight}px`;
    };
    resize();
    return observeResize(panel, resize);
  }, [draft]);
  const activeProviderThread = projection?.providerThreads.find(
    (candidate) =>
      candidate.id === projection.thread.activeProviderThreadId &&
      candidate.providerInstanceId === provider?.instanceId,
  );
  const contextUsage = activeProviderThread
    ? deriveLatestContextWindowSnapshot(
        projection?.turnItems.map((item) => ({ item })) ?? [],
        latestProviderTurnTokenUsage(
          projection?.providerTurns.filter(
            (turn) => turn.providerThreadId === activeProviderThread.id,
          ) ?? [],
          projection,
          activeProviderThread,
        ),
        activeProviderThread,
      )
    : null;
  const trigger = slashTrigger(draft, Math.min(cursor, draft.length));
  const slashOpen = trigger !== null && slashDismissed !== trigger.start && !busy;
  const commandItems = slashOpen
    ? slashItems(
        provider,
        project?.workspaceRoot ?? null,
        trigger.query,
        draft.slice(0, trigger.start).trim() === "",
      ).slice(0, 60)
    : [];
  const highlighted = Math.min(slashHighlight, Math.max(commandItems.length - 1, 0));

  const seek: SeekHandler = (timecode) => {
    const context = host.context;
    if (!context) {
      setError("Open the sequence in Premiere to jump to that time.");
      return;
    }
    if (!seekPremiere(timecode.seconds(context.fps), context.sequenceId))
      setError("Premiere did not accept that time.");
  };

  const serverConfigs = useServerConfigs();
  const [usage, setUsage] = useState<UsageLimitsReport | null>(null);
  const modelSelect = useRef<HTMLSelectElement>(null);

  /** Runs a command the panel answers itself. Returns false when it cannot. */
  function runPanelAction(action: PanelAction): boolean {
    switch (action) {
      case "plan":
        setMode("plan");
        return true;
      case "edit":
        setMode("default");
        return true;
      case "model":
        requestAnimationFrame(() => {
          modelSelect.current?.focus();
          modelSelect.current?.showPicker?.();
        });
        return true;
      case "new":
        if (timelineChanges.pending || timelineChanges.undoing) {
          setError("Wait for this turn's timeline snapshot before switching conversations.");
          return true;
        }
        setSelectedThread(null);
        setError(null);
        return true;
      case "usage-limits": {
        const config = environmentId ? serverConfigs.get(environmentId) : undefined;
        const report = provider
          ? collectProviderUsageLimits(
              provider.instanceId,
              providers,
              config?.usageLimitSources ?? [],
              Date.now(),
            )
          : null;
        setUsage(report);
        if (!report) setError("Usage limits are not available for this account yet.");
        return true;
      }
    }
  }

  function pickSlashItem(item: SlashItem) {
    if (!trigger) return;
    if (item.action) {
      // The command itself is not sent; only the text around it stays.
      writeDraft((draft.slice(0, trigger.start) + draft.slice(trigger.end)).trim());
      setSlashHighlight(0);
      runPanelAction(item.action);
      return;
    }
    const next =
      draft.slice(0, trigger.start) + item.insert + draft.slice(trigger.end).replace(/^ /, "");
    writeDraft(next);
    const position = trigger.start + item.insert.length;
    setCursor(position);
    setSlashHighlight(0);
    requestAnimationFrame(() => textarea.current?.setSelectionRange(position, position));
  }

  async function addImages(files: File[]) {
    if (!files.length) return;
    const result = await readImages(files, images);
    setImages((current) => [...current, ...result.images]);
    setError(result.error);
  }

  async function attachFrame() {
    if (capturingFrame) return;
    setCapturingFrame(true);
    setError(null);
    try {
      const frame = await requestPremiereFrame();
      const bytes = Uint8Array.from(atob(frame.dataUrl.slice(22)), (character) =>
        character.charCodeAt(0),
      );
      await addImages([new File([bytes], frame.name, { type: frame.mimeType })]);
    } catch (failure) {
      setError(
        failure instanceof Error ? failure.message : "The current frame could not be attached.",
      );
    } finally {
      setCapturingFrame(false);
    }
  }

  useEffect(() => {
    if (paired.current) return;
    paired.current = true;
    const request = readHostedPairingRequest();
    if (!request) return;
    history.replaceState(null, "", "/premiere.html");
    void Promise.resolve().then(async () => {
      if (new URL(request.host).origin !== location.origin) {
        setError("The panel pairing address does not match this backend.");
        return;
      }
      setPairing(true);
      const result = await connect({ host: request.host, pairingCode: request.token });
      if (result._tag !== "Success")
        setError("Could not connect to the Axis backend. Reopen the extension to retry.");
      setPairing(false);
    });
  }, [connect]);

  useEffect(() => {
    if (projection?.turnItems && followTranscript.current && transcript.current)
      transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [projection?.turnItems]);

  function writeDraft(value: string) {
    setDraftState({ key: draftKey, value });
    try {
      localStorage.setItem(draftKey, value);
    } catch {
      /* The current draft remains in memory. */
    }
  }

  async function send(event?: FormEvent, transcriptionPrompt?: string) {
    event?.preventDefault();
    const action = transcriptionPrompt || images.length ? null : panelActionFor(draft);
    if (action && runPanelAction(action)) {
      writeDraft("");
      return;
    }
    if (
      !project ||
      !provider ||
      providerSignedOut ||
      !model ||
      (!transcriptionPrompt && !draft.trim() && !images.length) ||
      inFlight.current ||
      transcriptBusy ||
      capturingFrame ||
      !ready ||
      !canOperate ||
      !host.connected ||
      (selectedThread !== null && !thread) ||
      running ||
      timelineChanges.pending ||
      timelineChanges.undoing ||
      otherActive
    ) {
      if (transcriptionPrompt)
        throw new Error("Wait for the current turn and connect an agent before transcribing.");
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const prompt = transcriptionPrompt ?? draft;
    const sentImages = transcriptionPrompt ? [] : images;
    // Provider Plan modes forbid artifact writes. A transcription gets its own
    // execution-capable conversation while the composer's mode stays unchanged.
    const targetId = transcriptionPrompt ? newThreadId() : (selectedThread ?? newThreadId());
    const turnMode = transcriptionPrompt ? "default" : mode;
    const messageId = newMessageId();
    const options = editingModelOptions(model, optionValues);
    const selection = createModelSelection(provider.instanceId, model.slug, options);
    try {
      const context = await requestPremiereContext();
      if (mode === "default" && context === null)
        throw new Error("Open a Premiere sequence before starting an edit.");
      if (!samePremiereScope(context, host.context))
        throw new Error(
          "The active project or sequence changed. Check the timeline, then send again.",
        );
      if (!transcriptionPrompt)
        await timelineChanges.begin(
          targetId,
          messageId,
          mode === "default",
          context?.sequenceId,
          context?.projectDocumentId || context?.projectPath,
        );
      const result = await startTurn({
        environmentId: project.environmentId,
        input: {
          threadId: targetId,
          message: {
            messageId,
            role: "user",
            text: formatPremierePrompt(prompt, context),
            attachments: sentImages.map((image) => ({
              type: "image" as const,
              name: image.name,
              mimeType: image.mimeType,
              sizeBytes: image.sizeBytes,
              dataUrl: image.dataUrl,
            })),
          },
          modelSelection: selection,
          runtimeMode,
          interactionMode: turnMode,
          ...(!selectedThread || transcriptionPrompt
            ? {
                bootstrap: {
                  createThread: {
                    projectId: project.id,
                    title: (prompt.trim() || sentImages[0]?.name || "Image").slice(0, 80),
                    modelSelection: selection,
                    runtimeMode,
                    interactionMode: turnMode,
                    branch: null,
                    worktreePath: null,
                    createdAt: DateTime.formatIso(DateTime.nowUnsafe()),
                  },
                },
              }
            : {}),
        },
      });
      if (result._tag !== "Success") {
        const failure = squashAtomCommandFailure(result);
        throw new Error(
          failure instanceof Error
            ? failure.message
            : "The backend did not accept this request. Your draft has been kept.",
        );
      }
      if (!transcriptionPrompt) {
        try {
          localStorage.removeItem(draftKey);
        } catch {
          /* Sending is independent of browser draft storage. */
        }
        setDraftState({ key: draftKey, value: "" });
      }
      setSelectedThread(targetId);
      if (transcriptionPrompt) {
        setTranscriptionTurn({ threadId: targetId, messageId });
        const destination = `premiere-draft:${environmentId}:${project.id}:${targetId}`;
        setDraftState({ key: destination, value: draft });
        try {
          localStorage.setItem(destination, draft);
        } catch {
          /* Keep the draft in memory. */
        }
      }
      setImages((current) => current.filter((image) => !sentImages.includes(image)));
      followTranscript.current = true;
    } catch (failure) {
      timelineChanges.cancel(messageId);
      setError(
        failure instanceof Error
          ? failure.message
          : "The request failed. Your draft has been kept.",
      );
      if (transcriptionPrompt) throw failure;
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function accountSetup() {
    window.parent.postMessage({ type: "premiere.accounts", protocol: 1 }, "*");
  }

  return (
    <main data-premiere-client="">
      <header data-toolbar="">
        {projects.length > 1 || !project ? (
          <select
            aria-label="Editing workspace"
            data-workspace-select=""
            disabled={busy || timelineLocked}
            value={project ? `${project.environmentId}:${project.id}` : ""}
            onChange={(event) => {
              setWorkspaceKey(event.target.value);
              setSelectedThread(null);
              setProviderKey(null);
              setModelKey(null);
              setOptionValues({});
            }}
          >
            {!project ? (
              <option value="">
                {workspaceKey !== null
                  ? "Selected workspace unavailable"
                  : pairing
                    ? "Connecting..."
                    : "Loading workspace..."}
              </option>
            ) : null}
            {projects.map((candidate) => (
              <option
                key={`${candidate.environmentId}:${candidate.id}`}
                value={`${candidate.environmentId}:${candidate.id}`}
              >
                {candidate.title}
              </option>
            ))}
          </select>
        ) : null}
        <select
          aria-label="Editing conversation"
          disabled={busy || timelineLocked}
          value={selectedThread ?? ""}
          onChange={(event) => {
            const next = threads.find((candidate) => candidate.id === event.target.value);
            setSelectedThread(next?.id ?? null);
            if (next) {
              setProviderKey(next.providerInstanceId);
              setModelKey(next.modelSelection.model);
              setOptionValues(
                Object.fromEntries(
                  (next.modelSelection.options ?? []).map((option) => [option.id, option.value]),
                ),
              );
              setMode(next.interactionMode);
              setRuntimeMode(next.runtimeMode);
            }
          }}
        >
          <option value="">New conversation</option>
          {selectedThread !== null && !thread ? (
            <option value={selectedThread}>Selected conversation unavailable</option>
          ) : null}
          {threads.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.title}
            </option>
          ))}
        </select>
        <button
          type="button"
          data-icon-button=""
          aria-label="New conversation"
          disabled={busy || timelineLocked}
          onClick={() => {
            setSelectedThread(null);
            setError(null);
          }}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path d="M8 3v10M3 8h10" />
          </svg>
        </button>
        <button type="button" data-ghost-button="" onClick={accountSetup}>
          Accounts
        </button>
        <details data-axis-menu="">
          <summary aria-label="Panel menu">Menu</summary>
          <button type="button" onClick={() => setShowDiagnostics((current) => !current)}>
            Diagnostics
          </button>
        </details>
      </header>
      <SetupPanel
        ready={ready}
        connected={host.connected}
        providers={providers}
        diagnostics={showDiagnostics}
        onAccounts={accountSetup}
      />
      <nav data-panel-tabs="" aria-label="Panel views">
        <button
          type="button"
          aria-pressed={panelView === "conversation"}
          onClick={() => setPanelView("conversation")}
        >
          Conversation
        </button>
        <button
          type="button"
          aria-pressed={panelView === "transcript"}
          onClick={() => setPanelView("transcript")}
        >
          Transcript
        </button>
      </nav>
      {status ? (
        <p data-status="" role="status">
          {status}
        </p>
      ) : null}
      {timelineChanges.pending && timelineChanges.pendingThreadId !== selectedThread ? (
        <p data-notice="">
          Select{" "}
          {threads.find((candidate) => candidate.id === timelineChanges.pendingThreadId)?.title ??
            "the previous conversation"}{" "}
          to finish capturing its timeline changes.
        </p>
      ) : null}
      <div
        data-transcript=""
        hidden={panelView !== "conversation"}
        ref={transcript}
        role="log"
        aria-label="Editing conversation messages"
        onScroll={() => {
          const element = transcript.current;
          if (element)
            followTranscript.current =
              element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        }}
      >
        {!blocks.length ? (
          <section data-welcome="">
            <h1>What are we working on?</h1>
            <p>Plan a cut, find footage, or revise the active sequence.</p>
            <div data-suggestions="">
              {[
                "Review the active sequence",
                "Plan the opening from my script",
                "Find gaps in the shot plan",
              ].map((suggestion) => (
                <button key={suggestion} type="button" onClick={() => writeDraft(suggestion)}>
                  {suggestion}
                </button>
              ))}
            </div>
          </section>
        ) : (
          blocks.map((block) => {
            switch (block.kind) {
              case "user":
                return (
                  <p key={block.id} data-user-message="">
                    {block.text}
                    {block.images.length ? (
                      <span data-sent-images="">
                        {block.images.map((name) => (
                          <span key={name}>{name}</span>
                        ))}
                      </span>
                    ) : null}
                  </p>
                );
              case "assistant":
                return (
                  <div key={block.id} data-assistant-message="">
                    <Markdown
                      text={block.text}
                      onSeek={seek}
                      actions={timelineActions}
                      complete={!block.streaming}
                    />
                    {block.streaming ? <span data-typing="" aria-label="Writing" /> : null}
                    {timelineChanges.byBlock.has(block.id)
                      ? changeCard(timelineChanges.byBlock.get(block.id)!)
                      : null}
                  </div>
                );
              case "tools":
                return <ToolGroup key={block.id} steps={block.steps} />;
              case "plan":
                return (
                  <section key={block.id} data-card="">
                    <strong>Proposed edit</strong>
                    <Markdown
                      text={block.markdown}
                      onSeek={seek}
                      actions={timelineActions}
                      complete
                    />
                    <button
                      type="button"
                      data-primary-button=""
                      onClick={() => {
                        setMode("default");
                        writeDraft(
                          "Implement the proposed edit plan in the active sequence. Verify each placement and report any missing assets.",
                        );
                      }}
                    >
                      Prepare this edit
                    </button>
                  </section>
                );
              case "todo":
                return (
                  <ul key={block.id} data-checklist="">
                    {block.steps.map((step) => (
                      <li key={step.id} data-done={step.done ? "" : undefined}>
                        {step.text}
                      </li>
                    ))}
                  </ul>
                );
              case "notice":
                return (
                  <p key={block.id} data-inline-notice={block.error ? "error" : ""}>
                    {block.text}
                  </p>
                );
            }
          })
        )}
        {timelineChanges.unplaced.map(changeCard)}
        {running && blocks.at(-1)?.kind !== "tools" && !lastStreaming ? (
          <p data-working="">Working…</p>
        ) : null}
        {projection?.subagents.length ? (
          <p data-inline-notice="">
            {projection.subagents.length} delegated task
            {projection.subagents.length === 1 ? "" : "s"}
          </p>
        ) : null}
      </div>
      <div data-transcript-slot="" hidden={panelView !== "transcript"}>
        {host.context ? (
          <TranscriptView
            key={transcriptStorageKey(host.context)}
            context={host.context}
            cleanupRequest={
              cleanupRequest?.scope === transcriptStorageKey(host.context) ? cleanupRequest : null
            }
            active={transcriptVisible}
            disabled={
              !canOperate ||
              !host.connected ||
              busy ||
              running ||
              otherActive ||
              timelineChanges.pending ||
              timelineChanges.undoing
            }
            onBusy={setTranscriptBusy}
            onTranscribe={(prompt) => send(undefined, prompt)}
            transcriptionDisabled={
              !project ||
              !provider ||
              !model ||
              !ready ||
              !canOperate ||
              !host.connected ||
              busy ||
              running ||
              otherActive ||
              capturingFrame ||
              transcriptBusy ||
              timelineChanges.pending ||
              timelineChanges.undoing
            }
            agentStatus={
              busy ? "Sending to agent" : (transcriptionThread?.runtime?.status ?? "idle")
            }
            agentOutcome={
              transcriptionFinished
                ? transcriptionReply && "text" in transcriptionReply
                  ? transcriptionReply.text.slice(0, 1024)
                  : transcriptionRun.status
                : null
            }
            onAsk={(context) => {
              writeDraft(`${draft.trimEnd()}${draft.trim() ? "\n\n" : ""}${context}\n\n`);
              setPanelView("conversation");
              textarea.current?.focus();
            }}
          />
        ) : (
          <p data-notice="">Open a sequence in Premiere to load its transcript.</p>
        )}
      </div>
      {pending.approvals.map((request) => (
        <section key={request.requestId} data-request="">
          <strong>Approval needed</strong>
          <p>{request.detail ?? request.reason ?? request.requestKind}</p>
          <div>
            {(
              request.options ?? [
                { decision: "accept" as const, label: "Allow once" },
                { decision: "decline" as const, label: "Decline" },
              ]
            ).map((option) => (
              <button
                key={option.decision}
                type="button"
                disabled={busy || request.responseCapability !== "live"}
                onClick={() => {
                  if (environmentId && selectedThread)
                    void approve({
                      environmentId,
                      input: {
                        threadId: selectedThread,
                        requestId: request.requestId,
                        decision: option.decision,
                      },
                    }).then((result) => {
                      if (result._tag !== "Success")
                        setError("The approval could not be sent. It may have expired.");
                    });
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </section>
      ))}
      {environmentId && selectedThread
        ? pending.userInputs.map((request) => (
            <QuestionCard
              key={JSON.stringify([environmentId, selectedThread, request.requestId])}
              environmentId={environmentId}
              threadId={selectedThread}
              request={request}
              canOperate={canOperate}
              onError={setError}
            />
          ))
        : null}
      {error ? (
        <p data-error="" role="alert">
          {error}
        </p>
      ) : null}
      {otherActive ? (
        <p data-notice="">
          Another editing conversation is running. Wait for it to finish before starting another
          edit.
        </p>
      ) : null}
      {usage ? <UsageCard report={usage} onClose={() => setUsage(null)} /> : null}
      {premiereSelectionSummary(host.context) ? (
        <p data-selection-context="" aria-label="Timeline selection included with your message">
          {premiereSelectionSummary(host.context)}
        </p>
      ) : null}
      <form
        data-composer=""
        onSubmit={(event) => void send(event)}
        onDragOver={(event) => {
          if (event.dataTransfer.types.includes("Files")) event.preventDefault();
        }}
        onDrop={(event) => {
          if (!event.dataTransfer.files.length) return;
          event.preventDefault();
          void addImages([...event.dataTransfer.files]);
        }}
      >
        {slashOpen ? (
          <SlashMenu
            items={commandItems}
            highlighted={highlighted}
            onHover={setSlashHighlight}
            onPick={pickSlashItem}
          />
        ) : null}
        <ImageStrip
          images={images}
          onRemove={(id) => setImages((current) => current.filter((image) => image.id !== id))}
        />
        <textarea
          data-shot-scroll=""
          ref={textarea}
          aria-label="Message your editing assistant"
          placeholder={
            mode === "plan"
              ? "Ask for a plan… (/ for commands)"
              : "Describe the edit… (/ for commands)"
          }
          value={draft}
          disabled={busy}
          onChange={(event) => {
            writeDraft(event.target.value);
            setCursor(event.target.selectionStart);
            setSlashHighlight(0);
            setSlashDismissed(null);
          }}
          onSelect={(event) => setCursor(event.currentTarget.selectionStart)}
          onPaste={(event) => {
            const files = [...event.clipboardData.files].filter((file) =>
              file.type.startsWith("image/"),
            );
            if (!files.length) return;
            event.preventDefault();
            void addImages(files);
          }}
          onKeyDown={(event) => {
            if (slashOpen && commandItems.length) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                const step = event.key === "ArrowDown" ? 1 : -1;
                setSlashHighlight((highlighted + step + commandItems.length) % commandItems.length);
                return;
              }
              if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
                event.preventDefault();
                pickSlashItem(commandItems[highlighted]!);
                return;
              }
            }
            if (slashOpen && event.key === "Escape" && trigger) {
              event.preventDefault();
              setSlashDismissed(trigger.start);
              return;
            }
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }
          }}
          rows={2}
        />
        {showOptions && model && optionDescriptors.length ? (
          <div data-model-options="">
            {optionDescriptors.map((descriptor) => {
              const value = editingModelOptions(model, optionValues).find(
                (option) => option.id === descriptor.id,
              )?.value;
              return (
                <label key={descriptor.id}>
                  <span>{descriptor.label}</span>
                  {descriptor.type === "select" ? (
                    <select
                      aria-label={descriptor.label}
                      disabled={busy || running}
                      value={typeof value === "string" ? value : ""}
                      onChange={(event) =>
                        setOptionValues((current) => ({
                          ...current,
                          [descriptor.id]: event.target.value,
                        }))
                      }
                    >
                      {descriptor.options.map((choice) => (
                        <option key={choice.id} value={choice.id}>
                          {choice.label}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="checkbox"
                      aria-label={descriptor.label}
                      disabled={busy || running}
                      checked={value === true}
                      onChange={(event) =>
                        setOptionValues((current) => ({
                          ...current,
                          [descriptor.id]: event.target.checked,
                        }))
                      }
                    />
                  )}
                </label>
              );
            })}
          </div>
        ) : null}
        <div data-composer-bar="">
          <AttachButton disabled={busy} onFiles={(files) => void addImages(files)} />
          <button
            type="button"
            data-icon-button=""
            aria-label="Attach current frame"
            aria-busy={capturingFrame}
            disabled={busy || capturingFrame || !host.connected}
            onClick={() => void attachFrame()}
          >
            <CameraIcon size={15} aria-hidden="true" />
          </button>
          <div data-mode-toggle="" role="radiogroup" aria-label="Editing mode">
            {(
              [
                ["plan", "Plan"],
                ["default", "Edit"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={mode === value}
                onClick={() => setMode(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <AccessModeMenu value={runtimeMode} disabled={busy} onChange={setRuntimeMode} />
          <select
            aria-label="Account"
            disabled={busy || running}
            value={provider?.instanceId ?? ""}
            onChange={(event) => {
              setProviderKey(event.target.value);
              setModelKey(null);
              setOptionValues({});
            }}
          >
            {!provider ? (
              <option value="">
                {providerKey !== null ? "Selected account unavailable" : "Connect an account"}
              </option>
            ) : null}
            {providers
              .filter((candidate) => candidate.enabled)
              .map((candidate) => (
                <option key={candidate.instanceId} value={candidate.instanceId}>
                  {accountLabel(
                    candidate,
                    providers.filter((other) => other.enabled),
                  )}
                </option>
              ))}
          </select>
          <select
            ref={modelSelect}
            aria-label="Model"
            disabled={busy || running}
            value={model?.slug ?? ""}
            onChange={(event) => {
              setModelKey(event.target.value);
              setOptionValues({});
            }}
          >
            {!model ? (
              <option value="">
                {modelKey !== null ? "Selected model unavailable" : "Choose a model"}
              </option>
            ) : null}
            {provider?.models.map((candidate) => (
              <option key={candidate.slug} value={candidate.slug}>
                {candidate.name}
              </option>
            ))}
          </select>
          {optionDescriptors.length ? (
            <button
              type="button"
              data-icon-button=""
              aria-label="Model settings"
              aria-expanded={showOptions}
              onClick={() => setShowOptions((current) => !current)}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M2 4h7M12 4h2M2 12h2M7 12h7" />
                <circle cx="10.5" cy="4" r="1.6" />
                <circle cx="5.5" cy="12" r="1.6" />
              </svg>
            </button>
          ) : null}
          <div data-composer-primary="">
            <ComposerUsage
              context={contextUsage}
              limits={provider?.usageLimits}
              account={provider?.displayName ?? provider?.instanceId}
            />
            {running ? (
              <button
                type="button"
                data-send-button=""
                aria-label="Stop"
                onClick={() => {
                  if (environmentId && selectedThread)
                    void stopTurn({ environmentId, input: { threadId: selectedThread } });
                }}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <rect x="4.5" y="4.5" width="7" height="7" rx="1" />
                </svg>
              </button>
            ) : (
              <button
                type="submit"
                data-send-button=""
                aria-label={busy ? "Sending" : "Send"}
                disabled={
                  busy ||
                  transcriptBusy ||
                  capturingFrame ||
                  timelineChanges.pending ||
                  timelineChanges.undoing ||
                  !ready ||
                  !canOperate ||
                  (selectedThread !== null && !thread) ||
                  !host.connected ||
                  !provider ||
                  providerSignedOut ||
                  !model ||
                  (!draft.trim() && !images.length) ||
                  otherActive
                }
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
                </svg>
              </button>
            )}
          </div>
        </div>
      </form>
    </main>
  );
}

function ToolGroup({ steps }: { steps: ReadonlyArray<ToolStep> }) {
  const running = steps.some((step) => step.status === "running");
  const failed = steps.some((step) => step.status === "failed");
  return (
    <details data-tool-group={running ? "running" : failed ? "failed" : "done"}>
      <summary>
        <span data-tool-mark="" aria-hidden="true" />
        {summarizeSteps(steps)}
      </summary>
      <ol>
        {steps.map((step) => (
          <li key={step.id} data-step-status={step.status}>
            {step.label}
          </li>
        ))}
      </ol>
    </details>
  );
}
