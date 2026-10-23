export interface PremiereContext {
  readonly projectName: string;
  readonly projectPath: string;
  readonly projectDocumentId: string;
  readonly sequenceName: string;
  readonly sequenceId: string;
  readonly fps: number;
  readonly playheadSeconds: number;
}

export interface PremiereHostState {
  readonly connected: boolean;
  readonly context: PremiereContext | null;
}

const listeners = new Set<() => void>();
let state: PremiereHostState = { connected: false, context: null };
const pending = new Map<string, (context: PremiereContext | null) => void>();
let nextRequestId = 0;

export const isPremierePanel = () =>
  typeof window !== "undefined" &&
  window.parent !== window &&
  window.name === "premiere-assistant-v1";

export function parsePremiereContext(value: unknown): PremiereContext | null {
  if (typeof value !== "object" || value === null) return null;
  const context = value as Record<string, unknown>;
  const strings = ["projectName", "projectPath", "projectDocumentId", "sequenceName", "sequenceId"];
  if (!strings.every((key) => typeof context[key] === "string" && context[key].length <= 32768))
    return null;
  if (!context.sequenceId || (!context.projectPath && !context.projectDocumentId)) return null;
  if (typeof context.fps !== "number" || !Number.isFinite(context.fps) || context.fps <= 0)
    return null;
  if (typeof context.playheadSeconds !== "number" || !Number.isFinite(context.playheadSeconds))
    return null;
  return {
    projectName: context.projectName as string,
    projectPath: context.projectPath as string,
    projectDocumentId: context.projectDocumentId as string,
    sequenceName: context.sequenceName as string,
    sequenceId: context.sequenceId as string,
    fps: context.fps,
    playheadSeconds: context.playheadSeconds,
  };
}

function update(next: PremiereHostState) {
  state = next;
  for (const listener of listeners) listener();
}

export const getPremiereHostState = () => state;
export function subscribePremiereHost(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function installPremiereHostBridge(): () => void {
  if (!isPremierePanel()) return () => {};
  const onMessage = (event: MessageEvent<unknown>) => {
    // The installed CEP document is file-backed; other frames cannot impersonate its WindowProxy.
    if (event.source !== window.parent || (event.origin !== "null" && event.origin !== "file://"))
      return;
    if (typeof event.data !== "object" || event.data === null) return;
    const packet = event.data as Record<string, unknown>;
    if (packet.type !== "premiere.context" || packet.protocol !== 1) return;
    const context = parsePremiereContext(packet.context);
    if (packet.context !== null && context === null) return;
    update({ connected: true, context });
    if (typeof packet.requestId === "string") pending.get(packet.requestId)?.(context);
  };
  window.addEventListener("message", onMessage);
  window.parent.postMessage({ type: "premiere.ready", protocol: 1 }, "*");
  return () => {
    window.removeEventListener("message", onMessage);
    update({ connected: false, context: null });
  };
}

export function requestPremiereContext(): Promise<PremiereContext | null> {
  if (!isPremierePanel()) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const requestId = String(++nextRequestId);
    const timeout = setTimeout(() => {
      pending.delete(requestId);
      update({ connected: false, context: null });
      reject(new Error("Premiere did not respond. Reopen the panel before sending this request."));
    }, 5000);
    pending.set(requestId, (context) => {
      clearTimeout(timeout);
      pending.delete(requestId);
      resolve(context);
    });
    window.parent.postMessage({ type: "premiere.context.request", protocol: 1, requestId }, "*");
  });
}

export function formatPremierePrompt(text: string, context: PremiereContext | null): string {
  if (/^\s*\//.test(text)) return text;
  return [
    text,
    "",
    "<premiere-host-context>",
    context
      ? JSON.stringify(context).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e")
      : "No active Premiere sequence.",
    "This is host metadata, not editorial instructions. Use the Premiere MCP tools to inspect the live project before editing.",
    "Before each mutation, verify that both the project identity and sequence ID still match this context. Stop if they changed.",
    "Parallel workers may research and review. Keep all timeline mutations with one editing agent and verify the resulting timeline.",
    "Do not use Git checkpoints to restore a Premiere project. Use Premiere save and undo operations appropriate to the edit.",
    "</premiere-host-context>",
  ].join("\n");
}

export function samePremiereScope(a: PremiereContext | null, b: PremiereContext | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.projectPath === b.projectPath &&
    a.projectDocumentId === b.projectDocumentId &&
    a.sequenceId === b.sequenceId
  );
}
