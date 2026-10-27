import { useRef, useState, type FormEvent } from "react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { ThreadPendingUserInput } from "@t3tools/client-runtime/state/thread-requests";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { XIcon } from "lucide-react";

import {
  resolvePendingUserInputAnswer,
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../pendingUserInput";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";

export function QuestionCard({
  environmentId,
  threadId,
  request,
  canOperate,
  onError,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  request: ThreadPendingUserInput;
  canOperate: boolean;
  onError: (message: string | null) => void;
}) {
  const dismissalKey = `premiere-dismissed-question:${JSON.stringify([environmentId, threadId, request.requestId])}`;
  const [dismissed, setDismissed] = useState(() => {
    try {
      return localStorage.getItem(dismissalKey) === "true";
    } catch {
      return false;
    }
  });
  const [drafts, setDrafts] = useState<Record<string, PendingUserInputDraftAnswer>>(() =>
    Object.fromEntries(
      request.questions.map((question) => [
        question.id,
        { customAnswer: question.initialAnswer ?? "" },
      ]),
    ),
  );
  const [sending, setSending] = useState(false);
  const inFlight = useRef(false);
  const answer = useOrchestrationCommand(threadEnvironment.respondToUserInput);
  const dismiss = useOrchestrationCommand(threadEnvironment.dismissUserInput);
  const disabled = sending || !canOperate || request.responseCapability === "not_resumable";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || inFlight.current) return;
    const answers: Record<string, string | string[]> = {};
    for (const question of request.questions) {
      const value = resolvePendingUserInputAnswer(question, drafts[question.id]);
      if (value !== null) answers[question.id] = value;
      else if (question.required !== false) {
        onError("Answer each required question before sending.");
        return;
      }
    }
    inFlight.current = true;
    setSending(true);
    onError(null);
    return await (async () => {
      const result = await answer({
        environmentId,
        input: { threadId, requestId: request.requestId, answers },
      });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        onError(
          error instanceof Error
            ? error.message
            : "The answer could not be sent. Your conversation is unchanged.",
        );
      }
    })().finally(() => {
      inFlight.current = false;
      setSending(false);
    });
  }

  function close() {
    setDismissed(true);
    onError(null);
    try {
      localStorage.setItem(dismissalKey, "true");
    } catch {
      /* The dismissal remains in memory when storage is unavailable. */
    }
    // The server only supports dismissing asynchronous, message-based questions.
    if (request.responseCapability !== "message" || !canOperate) return;
    void dismiss({
      environmentId,
      input: { threadId, requestId: request.requestId },
    }).then((result) => {
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        onError(
          error instanceof Error
            ? error.message
            : "The question was hidden here, but could not be dismissed on the server.",
        );
      }
    });
  }

  if (dismissed) return null;
  return (
    <form data-request="" data-question-card="" onSubmit={submit}>
      <button
        type="button"
        data-icon-button=""
        data-dismiss-question=""
        aria-label="Dismiss question"
        onClick={close}
      >
        <XIcon aria-hidden="true" />
      </button>
      {request.questions.map((question) => {
        const draft = drafts[question.id];
        const changeCustom = (value: string) =>
          setDrafts((current) => ({
            ...current,
            [question.id]: setPendingUserInputCustomAnswer(current[question.id], value, question),
          }));
        return (
          <fieldset key={question.id} data-question="" disabled={disabled}>
            <legend>
              <small>{question.header}</small>
              {question.question}
            </legend>
            {question.options.length ? (
              <div data-question-options="">
                {question.options.map((option) => {
                  const value = option.value ?? option.label;
                  return (
                    <label key={option.label} data-question-option="">
                      <input
                        type={question.multiSelect ? "checkbox" : "radio"}
                        name={question.id}
                        value={value}
                        checked={draft?.selectedOptionValues?.includes(value) ?? false}
                        onChange={() =>
                          setDrafts((current) => ({
                            ...current,
                            [question.id]: togglePendingUserInputOptionSelection(
                              question,
                              current[question.id],
                              value,
                            ),
                          }))
                        }
                        required={
                          !question.multiSelect &&
                          question.required !== false &&
                          question.allowCustomAnswer === false
                        }
                      />
                      <span>
                        <strong>{option.label}</strong>
                        {option.description ? <small>{option.description}</small> : null}
                      </span>
                    </label>
                  );
                })}
              </div>
            ) : (
              <input
                name={question.id}
                aria-label={question.question}
                required={question.required !== false}
                value={draft?.customAnswer ?? ""}
                onChange={(event) => changeCustom(event.target.value)}
              />
            )}
            {question.options.length && question.allowCustomAnswer !== false ? (
              <input
                name={`${question.id}:custom`}
                aria-label={`Custom answer: ${question.question}`}
                placeholder="Something else…"
                value={draft?.customAnswer ?? ""}
                onChange={(event) => changeCustom(event.target.value)}
              />
            ) : null}
          </fieldset>
        );
      })}
      <button type="submit" disabled={disabled}>
        {sending ? "Sending answer…" : "Send answer"}
      </button>
    </form>
  );
}
