import {
  getProviderAttachmentLimitError,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ServerProvider,
} from "@t3tools/contracts";
import {
  getProviderSkillsForSlashMenu,
  getProviderSlashCommandsForSlashMenu,
  resolveProviderSkillsForCwd,
  resolveProviderSlashCommandsForCwd,
} from "@t3tools/client-runtime/providerSkills";

/** Names an account briefly; the email only appears when two accounts share a name. */
export function accountLabel(
  provider: Pick<ServerProvider, "instanceId" | "displayName" | "auth">,
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "displayName">>,
): string {
  const name = provider.displayName ?? provider.instanceId;
  const shared = providers.some(
    (other) =>
      other.instanceId !== provider.instanceId && (other.displayName ?? other.instanceId) === name,
  );
  const email = provider.auth.email?.split("@")[0];
  return shared && email ? `${name} · ${email}` : name;
}

export interface SlashTrigger {
  readonly start: number;
  readonly end: number;
  readonly query: string;
}

/** The "/word" being typed at the cursor, if any. */
export function slashTrigger(text: string, cursor: number): SlashTrigger | null {
  const match = /(?:^|\s)\/([^\s/]*)$/.exec(text.slice(0, cursor));
  if (!match) return null;
  const start = cursor - match[1]!.length - 1;
  return { start, end: cursor, query: match[1]!.toLowerCase() };
}

/** Commands the panel answers itself; the agent never receives them. */
export type PanelAction = "plan" | "edit" | "model" | "new" | "usage-limits";

const PANEL_COMMANDS: ReadonlyArray<{ name: string; action: PanelAction; description: string }> = [
  { name: "plan", action: "plan", description: "Plan first, without changing the timeline" },
  { name: "edit", action: "edit", description: "Let the assistant edit the timeline" },
  { name: "model", action: "model", description: "Choose the model" },
  { name: "new", action: "new", description: "Start a new conversation" },
];

export interface SlashItem {
  readonly id: string;
  readonly kind: "action" | "command" | "skill";
  readonly name: string;
  readonly description: string | undefined;
  /** Text that replaces the typed "/query". The server resolves "$name" to the skill for each provider. */
  readonly insert: string;
  readonly action?: PanelAction;
}

/** The panel action a whole message names, such as "/plan" sent on its own. */
export function panelActionFor(text: string): PanelAction | null {
  const name = /^\s*\/([\w-]+)\s*$/.exec(text)?.[1]?.toLowerCase();
  if (!name) return null;
  if (name === "usage-limits") return "usage-limits";
  if (name === "default") return "edit";
  return PANEL_COMMANDS.find((command) => command.name === name)?.action ?? null;
}

/**
 * Lists what "/" can run. Providers only expand their own commands at the very
 * start of a message, so those are offered there and nowhere else.
 */
export function slashItems(
  provider: ServerProvider | null,
  cwd: string | null,
  query: string,
  atStart: boolean,
): SlashItem[] {
  const skills = provider
    ? getProviderSkillsForSlashMenu(resolveProviderSkillsForCwd(provider, cwd), true)
    : [];
  const commands =
    provider && atStart
      ? getProviderSlashCommandsForSlashMenu(
          resolveProviderSlashCommandsForCwd(provider, cwd),
          skills,
        )
      : [];
  const items: SlashItem[] = [
    ...(atStart
      ? PANEL_COMMANDS.map((command) => ({
          id: `action:${command.name}`,
          kind: "action" as const,
          name: command.name,
          description: command.description,
          insert: "",
          action: command.action,
        }))
      : []),
    ...commands.map((command) => {
      const action = panelActionFor(`/${command.name}`);
      return {
        id: `command:${command.name}`,
        kind: action ? ("action" as const) : ("command" as const),
        name: command.name,
        description: command.description,
        insert: action ? "" : `/${command.name} `,
        ...(action ? { action } : {}),
      };
    }),
    ...skills.map((skill) => ({
      id: `skill:${skill.name}`,
      kind: "skill" as const,
      name: skill.displayName ?? skill.name,
      description: skill.shortDescription ?? skill.description,
      insert: `$${skill.name} `,
    })),
  ];
  if (!query) return items;
  const starts = items.filter((item) => item.name.toLowerCase().startsWith(query));
  const contains = items.filter(
    (item) =>
      !item.name.toLowerCase().startsWith(query) &&
      (item.name.toLowerCase().includes(query) || item.description?.toLowerCase().includes(query)),
  );
  return [...starts, ...contains];
}

export interface ComposerImage {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly dataUrl: string;
}

function readDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result)), { once: true });
    reader.addEventListener(
      "error",
      () => reject(reader.error ?? new Error("The image could not be read.")),
      { once: true },
    );
    reader.readAsDataURL(file);
  });
}

/** Reads picked, pasted or dropped images; returns an error for anything it skipped. */
export async function readImages(
  files: ReadonlyArray<File>,
  existing: ReadonlyArray<ComposerImage>,
): Promise<{ images: ComposerImage[]; error: string | null }> {
  const images: ComposerImage[] = [];
  let error: string | null = null;
  for (const file of files) {
    if (!file.type.startsWith("image/")) {
      error = `${file.name || "That file"} is not an image.`;
      continue;
    }
    if (file.size > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      error = `${file.name || "That image"} is larger than 10 MB.`;
      continue;
    }
    const next: ComposerImage = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name: (file.name || `pasted-image-${existing.length + images.length + 1}.png`).slice(0, 255),
      mimeType: file.type,
      sizeBytes: file.size,
      dataUrl: await readDataUrl(file),
    };
    const limit = getProviderAttachmentLimitError([
      ...existing.map((image) => ({ type: "image" as const, ...image })),
      ...images.map((image) => ({ type: "image" as const, ...image })),
      { type: "image" as const, ...next },
    ]);
    if (limit) {
      error = limit;
      break;
    }
    images.push(next);
  }
  return { images, error };
}
