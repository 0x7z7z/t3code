/** The installed CEP host supplies this only to its dedicated backend. */
export function premiereMcpServer(
  environment: Readonly<Record<string, string | undefined>>,
  cwd: string | null | undefined,
): { command: string; args: string[]; env?: Record<string, string> } | undefined {
  const value = environment.T3CODE_PREMIERE_MCP;
  if (!value || !cwd) return undefined;
  let config: unknown;
  try {
    config = JSON.parse(value);
  } catch {
    throw new Error("Invalid Premiere connector configuration. Reinstall the extension.");
  }
  if (
    typeof config !== "object" ||
    config === null ||
    !("workspacePath" in config) ||
    typeof config.workspacePath !== "string" ||
    !("command" in config) ||
    typeof config.command !== "string" ||
    !config.command ||
    !("args" in config) ||
    !Array.isArray(config.args) ||
    !config.args.every((arg): arg is string => typeof arg === "string")
  )
    throw new Error("Invalid Premiere connector configuration. Reinstall the extension.");
  const normalize = (path: string) => {
    const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "");
    return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
  };
  if (normalize(cwd) !== normalize(config.workspacePath)) return undefined;
  if (
    "env" in config &&
    (typeof config.env !== "object" ||
      config.env === null ||
      Array.isArray(config.env) ||
      !Object.values(config.env).every((value) => typeof value === "string"))
  ) {
    throw new Error("Invalid Premiere connector environment. Reinstall the extension.");
  }
  return {
    command: config.command,
    args: [...config.args],
    ...("env" in config ? { env: config.env as Record<string, string> } : {}),
  };
}
