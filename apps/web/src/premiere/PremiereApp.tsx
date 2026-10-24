import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { AuthOrchestrationOperateScope, type ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { derivePendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { createModelSelection } from "@t3tools/shared/model";
import * as Option from "effect/Option";

import { connectPairing } from "../connection/onboarding";
import { readHostedPairingRequest } from "../hostedPairing";
import { newMessageId, newThreadId } from "../lib/utils";
import { useProjects, useThreadShellsForProjectRefs } from "../state/entities";
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
  formatPremierePrompt,
  samePremiereScope,
} from "./host";
import { Markdown } from "./Markdown";
import { editingModelOptions } from "./models";
import { selectEditingModel, selectEditingProvider, selectEditingWorkspace } from "./selection";
import { buildTranscript, summarizeSteps, type ToolStep } from "./transcript";

const ACTIVE = new Set(["preparing", "queued", "starting", "running", "waiting"]);

export function PremiereApp() {
  const projects = useProjects();
  const { environments } = useEnvironments();
  const providerMap = useEnvironmentProviders();
  const host = useSyncExternalStore(subscribePremiereHost, getPremiereHostState);
  const [workspaceKey, setWorkspaceKey] = useState<string | null>(null);
  const project = selectEditingWorkspace(projects, workspaceKey);
  const projectRef = project
    ? { environmentId: project.environmentId, projectId: project.id }
    : null;
  const environmentId = project?.environmentId ?? environments[0]?.environmentId ?? null;
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const providers = environmentId ? (providerMap.get(environmentId) ?? []) : [];
  const [providerKey, setProviderKey] = useState<string | null>(null);
  const provider = selectEditingProvider(providers, providerKey);
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
  const [error, setError] = useState<string | null>(null);
  const [pairing, setPairing] = useState(false);
  const [mode, setMode] = useState<"plan" | "default">("plan");
  const [showOptions, setShowOptions] = useState(false);
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
  const answer = useOrchestrationCommand(threadEnvironment.respondToUserInput);
  const paired = useRef(false);
  const inFlight = useRef(false);
  const transcript = useRef<HTMLDivElement>(null);
  const followTranscript = useRef(true);
  const otherActive = threads.some(
    (candidate) =>
      candidate.id !== selectedThread && candidate.runtime && ACTIVE.has(candidate.runtime.status),
  );
  const running = thread?.runtime ? ACTIVE.has(thread.runtime.status) : false;
  const draftKey = `premiere-draft:${environmentId}:${project?.id}:${selectedThread ?? "new"}`;
  let storedDraft = "";
  try {
    storedDraft = localStorage.getItem(draftKey) ?? "";
  } catch {
    /* Browser storage can be unavailable. */
  }
  const draft = draftState?.key === draftKey ? draftState.value : storedDraft;

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
        setError("Could not pair with T3. Reopen the extension to retry.");
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

  async function send(event: FormEvent) {
    event.preventDefault();
    if (
      !project ||
      !provider ||
      !model ||
      !draft.trim() ||
      inFlight.current ||
      !ready ||
      !canOperate ||
      !host.connected ||
      (selectedThread !== null && !thread) ||
      running ||
      otherActive
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    const prompt = draft;
    const targetId = selectedThread ?? newThreadId();
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
      const result = await startTurn({
        environmentId: project.environmentId,
        input: {
          threadId: targetId,
          message: {
            messageId: newMessageId(),
            role: "user",
            text: formatPremierePrompt(prompt, context),
            attachments: [],
          },
          modelSelection: selection,
          runtimeMode: "approval-required",
          interactionMode: mode,
          ...(!selectedThread
            ? {
                bootstrap: {
                  createThread: {
                    projectId: project.id,
                    title: prompt.trim().slice(0, 80),
                    modelSelection: selection,
                    runtimeMode: "approval-required" as const,
                    interactionMode: mode,
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
            : "T3 did not accept this request. Your draft has been kept.",
        );
      }
      try {
        localStorage.removeItem(draftKey);
      } catch {
        /* Sending is independent of browser draft storage. */
      }
      setSelectedThread(targetId);
      setDraftState({ key: draftKey, value: "" });
      followTranscript.current = true;
    } catch (failure) {
      setError(
        failure instanceof Error
          ? failure.message
          : "The request failed. Your draft has been kept.",
      );
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
            disabled={busy}
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
          disabled={busy}
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
          disabled={busy}
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
      </header>
      {status ? (
        <p data-status="" role="status">
          {status}
        </p>
      ) : null}
      <div
        data-transcript=""
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
                  </p>
                );
              case "assistant":
                return (
                  <div key={block.id} data-assistant-message="">
                    <Markdown text={block.text} />
                    {block.streaming ? <span data-typing="" aria-label="Writing" /> : null}
                  </div>
                );
              case "tools":
                return <ToolGroup key={block.id} steps={block.steps} />;
              case "plan":
                return (
                  <section key={block.id} data-card="">
                    <strong>Proposed edit</strong>
                    <Markdown text={block.markdown} />
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
      {pending.userInputs.map((request) => (
        <form
          key={request.requestId}
          data-request=""
          onSubmit={(event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const answers = Object.fromEntries(
              request.questions.map((question) => [
                question.id,
                {
                  answers: String(data.get(`${question.id}:custom`) ?? "").trim()
                    ? [String(data.get(`${question.id}:custom`)).trim()]
                    : data.getAll(question.id).map(String).filter(Boolean),
                },
              ]),
            );
            if (
              request.questions.some(
                (question) =>
                  question.required !== false && (answers[question.id]?.answers.length ?? 0) === 0,
              )
            ) {
              setError("Answer each required question before sending.");
              return;
            }
            if (environmentId && selectedThread)
              void answer({
                environmentId,
                input: { threadId: selectedThread, requestId: request.requestId, answers },
              }).then((result) => {
                if (result._tag !== "Success")
                  setError("The answer could not be sent. Your conversation is unchanged.");
              });
          }}
        >
          {request.questions.map((question) => (
            <label key={question.id}>
              <span>{question.question}</span>
              {question.options.length ? (
                <select
                  name={question.id}
                  multiple={question.multiSelect}
                  required={question.required !== false && question.allowCustomAnswer === false}
                >
                  {!question.multiSelect ? <option value="">Choose an answer</option> : null}
                  {question.options.map((option) => (
                    <option key={option.label} value={option.value ?? option.label}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  name={question.id}
                  required={question.required !== false}
                  defaultValue={question.initialAnswer ?? ""}
                />
              )}
              {question.options.length && question.allowCustomAnswer !== false ? (
                <input
                  name={`${question.id}:custom`}
                  aria-label={`Custom answer: ${question.question}`}
                  placeholder="Or write your answer"
                />
              ) : null}
            </label>
          ))}
          <button type="submit" disabled={request.responseCapability === "not_resumable"}>
            Send answer
          </button>
        </form>
      ))}
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
      <form data-composer="" onSubmit={(event) => void send(event)}>
        <textarea
          aria-label="Message your editing assistant"
          placeholder={mode === "plan" ? "Ask for a plan…" : "Describe the edit…"}
          value={draft}
          disabled={busy}
          onChange={(event) => writeDraft(event.target.value)}
          onKeyDown={(event) => {
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
                  {candidate.displayName ?? candidate.instanceId}
                  {candidate.auth.email ? ` · ${candidate.auth.email}` : ""}
                </option>
              ))}
          </select>
          <select
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
                !ready ||
                !canOperate ||
                (selectedThread !== null && !thread) ||
                !host.connected ||
                !provider ||
                !model ||
                !draft.trim() ||
                otherActive
              }
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
              </svg>
            </button>
          )}
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
