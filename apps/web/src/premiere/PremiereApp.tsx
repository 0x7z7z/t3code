import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { type ThreadId } from "@t3tools/contracts";
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
import { editingModelOptions } from "./models";

const ACTIVE = new Set(["preparing", "queued", "starting", "running", "waiting"]);

export function PremiereApp() {
  const projects = useProjects();
  const { environments } = useEnvironments();
  const providerMap = useEnvironmentProviders();
  const host = useSyncExternalStore(subscribePremiereHost, getPremiereHostState);
  const [workspaceKey, setWorkspaceKey] = useState<string | null>(null);
  const project =
    projects.find((candidate) => `${candidate.environmentId}:${candidate.id}` === workspaceKey) ??
    projects[0] ??
    null;
  const projectRef = project
    ? { environmentId: project.environmentId, projectId: project.id }
    : null;
  const environmentId = project?.environmentId ?? environments[0]?.environmentId ?? null;
  const providers = environmentId ? (providerMap.get(environmentId) ?? []) : [];
  const [providerKey, setProviderKey] = useState<string | null>(null);
  const provider =
    providers.find((candidate) => candidate.instanceId === providerKey) ??
    providers.find((candidate) => candidate.enabled && candidate.installed) ??
    null;
  const [modelKey, setModelKey] = useState<string | null>(null);
  const model =
    provider?.models.find((candidate) => candidate.slug === modelKey) ??
    provider?.models.find((candidate) => /gpt-6[.-]luna/i.test(candidate.slug)) ??
    provider?.models.find((candidate) => candidate.isDefault) ??
    provider?.models[0] ??
    null;
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
    if (projection?.messages && followTranscript.current && transcript.current)
      transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [projection?.messages]);

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
      <header data-workspace-controls="">
        <label>
          <span>Workspace</span>
          <select
            aria-label="Editing workspace"
            disabled={busy}
            value={project ? `${project.environmentId}:${project.id}` : ""}
            onChange={(event) => {
              setWorkspaceKey(event.target.value);
              setSelectedThread(null);
            }}
          >
            {!project ? (
              <option value="">{pairing ? "Connecting..." : "Loading workspace..."}</option>
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
        </label>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setSelectedThread(null);
            setError(null);
          }}
        >
          New edit
        </button>
        <button type="button" onClick={accountSetup}>
          Accounts
        </button>
      </header>
      <div data-conversation-controls="">
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
          {threads.map((candidate) => (
            <option key={candidate.id} value={candidate.id}>
              {candidate.title}
            </option>
          ))}
        </select>
        <span role="status">
          {ready
            ? host.connected
              ? host.context
                ? "Timeline attached"
                : "No active sequence"
              : "Waiting for Premiere"
            : pairing
              ? "Pairing"
              : "Connecting"}
        </span>
      </div>
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
        {!projection?.messages.length ? (
          <section data-welcome="">
            <span>Premiere Assistant</span>
            <h1>What are we making?</h1>
            <p>
              Plan a cut, find the right footage, or revise your sequence. Start with a plan, then
              choose Edit when you are ready.
            </p>
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
          projection.messages
            .filter((message) => message.role !== "system")
            .map((message) => (
              <article key={message.id} data-message-role={message.role}>
                <span>
                  {message.role === "user" ? "You" : "Assistant"}
                  {message.streaming ? " · writing" : ""}
                </span>
                <p>{message.text.split("\n<premiere-host-context>")[0]}</p>
              </article>
            ))
        )}
        {projection?.turnItems
          .filter((item) => !["user_message", "assistant_message", "reasoning"].includes(item.type))
          .slice(-6)
          .map((item) => (
            <details key={item.id} data-activity="">
              <summary>{item.type.replaceAll("_", " ")}</summary>
              {item.type === "proposed_plan" ? (
                <section data-edit-plan="">
                  <p>{item.markdown}</p>
                  <button
                    type="button"
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
              ) : null}
              {item.type === "todo_list" ? (
                <ol>
                  {item.steps.map((step) => (
                    <li key={step.id}>
                      {step.text} ({step.status})
                    </li>
                  ))}
                </ol>
              ) : null}
              {"title" in item && typeof item.title === "string" ? <p>{item.title}</p> : null}
              {"summary" in item && typeof item.summary === "string" ? <p>{item.summary}</p> : null}
            </details>
          ))}
        {projection?.subagents.length ? (
          <p data-task-count="">
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
          placeholder="Describe your edit..."
          value={draft}
          disabled={busy}
          onChange={(event) => writeDraft(event.target.value)}
          rows={3}
        />
        <div data-model-controls="">
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
            {!provider ? <option value="">Connect an account</option> : null}
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
            {provider?.models.map((candidate) => (
              <option key={candidate.slug} value={candidate.slug}>
                {candidate.name}
              </option>
            ))}
          </select>
          <select
            aria-label="Editing mode"
            value={mode}
            onChange={(event) => setMode(event.target.value === "plan" ? "plan" : "default")}
          >
            <option value="plan">Plan</option>
            <option value="default">Edit</option>
          </select>
        </div>
        {model ? (
          <div data-model-options="">
            {(model.capabilities?.optionDescriptors ?? []).map((descriptor) => {
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
        <div data-send-controls="">
          <span>
            {running
              ? thread?.runtime?.status
              : mode === "plan"
                ? "Plan before editing"
                : "Edits ask for approval"}
          </span>
          {running ? (
            <button
              type="button"
              onClick={() => {
                if (environmentId && selectedThread)
                  void stopTurn({ environmentId, input: { threadId: selectedThread } });
              }}
            >
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={
                busy ||
                !ready ||
                !host.connected ||
                !provider ||
                !model ||
                !draft.trim() ||
                otherActive
              }
            >
              {busy ? "Sending..." : "Send"}
            </button>
          )}
        </div>
      </form>
    </main>
  );
}
