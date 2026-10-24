import type { OrchestrationV2TurnItem } from "@t3tools/contracts";

const HOST_CONTEXT_MARKER = "\n<premiere-host-context>";

export interface ToolStep {
  readonly id: string;
  readonly label: string;
  readonly status: "running" | "done" | "failed";
}

export type TranscriptBlock =
  | { readonly kind: "user"; readonly id: string; readonly text: string }
  | {
      readonly kind: "assistant";
      readonly id: string;
      readonly text: string;
      readonly streaming: boolean;
    }
  | { readonly kind: "tools"; readonly id: string; readonly steps: ReadonlyArray<ToolStep> }
  | { readonly kind: "plan"; readonly id: string; readonly markdown: string }
  | {
      readonly kind: "todo";
      readonly id: string;
      readonly steps: ReadonlyArray<{
        readonly id: string;
        readonly text: string;
        readonly done: boolean;
      }>;
    }
  | {
      readonly kind: "notice";
      readonly id: string;
      readonly text: string;
      readonly error: boolean;
    };

/** Removes the Premiere context the panel appends to every prompt. */
export function stripHostContext(text: string): string {
  return text.split(HOST_CONTEXT_MARKER)[0]!.trim();
}

function sentenceCase(value: string): string {
  const text = value.replaceAll("_", " ").replace(/\s+/g, " ").trim();
  return text ? text[0]!.toUpperCase() + text.slice(1) : text;
}

function stepStatus(item: OrchestrationV2TurnItem): ToolStep["status"] {
  if (item.status === "running" || item.status === "pending" || item.status === "waiting")
    return "running";
  if (item.status === "failed" || item.status === "cancelled" || item.status === "interrupted")
    return "failed";
  if (item.type === "command_execution" && item.outputIndicatesFailure) return "failed";
  return "done";
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function toolLabel(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "dynamic_tool": {
      const name = item.title ?? item.toolName?.split(/\.|__/).pop() ?? "tool";
      return sentenceCase(name);
    }
    case "command_execution":
      // T3 records its own workspace preparation as a command; it is not the agent's work.
      if (item.input === "Preparing workspace") return null;
      return item.title ? sentenceCase(item.title) : "Ran a command";
    case "file_change":
      return `Edited ${baseName(item.fileName)}`;
    case "file_search":
      return "Searched files";
    case "web_search":
      return "Searched the web";
    case "subagent":
      return "Delegated a task";
    default:
      return null;
  }
}

/**
 * Turns the raw turn items into what an editor needs to read: their messages,
 * the assistant's replies, and one compact group per run of tool calls.
 */
export function buildTranscript(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
): ReadonlyArray<TranscriptBlock> {
  const blocks: TranscriptBlock[] = [];
  for (const item of items) {
    const last = blocks.at(-1);
    if (item.type === "user_message") {
      const text = stripHostContext(item.text);
      if (text) blocks.push({ kind: "user", id: item.id, text });
      continue;
    }
    if (item.type === "assistant_message") {
      const text = item.text.trim();
      if (!text && !item.streaming) continue;
      if (last?.kind === "assistant")
        blocks[blocks.length - 1] = {
          ...last,
          text: text ? `${last.text}\n\n${text}` : last.text,
          streaming: item.streaming,
        };
      else blocks.push({ kind: "assistant", id: item.id, text, streaming: item.streaming });
      continue;
    }
    if (item.type === "proposed_plan") {
      blocks.push({ kind: "plan", id: item.id, markdown: item.markdown });
      continue;
    }
    if (item.type === "todo_list") {
      blocks.push({
        kind: "todo",
        id: item.id,
        steps: item.steps.map((step) => ({
          id: step.id,
          text: step.text,
          done: step.status === "completed",
        })),
      });
      continue;
    }
    if (item.type === "error") {
      blocks.push({ kind: "notice", id: item.id, text: item.failure.message, error: true });
      continue;
    }
    if (item.type === "run_interrupt_result") {
      blocks.push({ kind: "notice", id: item.id, text: "Stopped.", error: false });
      continue;
    }
    const label = toolLabel(item);
    if (label === null) continue;
    const step: ToolStep = { id: item.id, label, status: stepStatus(item) };
    if (last?.kind === "tools")
      blocks[blocks.length - 1] = { ...last, steps: [...last.steps, step] };
    else blocks.push({ kind: "tools", id: item.id, steps: [step] });
  }
  return blocks;
}

/** One line describing a group of tool calls. */
export function summarizeSteps(steps: ReadonlyArray<ToolStep>): string {
  const running = steps.findLast((step) => step.status === "running");
  if (running) return running.label;
  const failed = steps.filter((step) => step.status === "failed").length;
  const count = steps.length === 1 ? steps[0]!.label : `${steps.length} steps`;
  return failed ? `${count} · ${failed} failed` : count;
}
