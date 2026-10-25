import * as NodeChildProcess from "node:child_process";

const runRegistry = (args) =>
  NodeChildProcess.spawnSync("reg.exe", args, {
    windowsHide: true,
    encoding: "utf8",
  });
const keyFor = (version) => `HKCU\\SOFTWARE\\Adobe\\CSXS.${version}`;

export function captureAdobeSettings(run = runRegistry) {
  return [9, 10, 11, 12].map((version) => {
    const key = keyFor(version);
    const result = run(["query", key, "/v", "PlayerDebugMode"]);
    const match = /PlayerDebugMode\s+(REG_\w+)\s+([^\r\n]*)/.exec(result.stdout || "");
    const keyExisted = match !== null || run(["query", key]).status === 0;
    return { version, keyExisted, type: match?.[1] ?? null, value: match?.[2] ?? null };
  });
}

export function restoreAdobeSettings(settings, run = runRegistry) {
  for (const entry of settings ?? []) {
    if (![9, 10, 11, 12].includes(entry.version))
      throw new Error("Invalid Adobe settings receipt.");
    const key = keyFor(entry.version);
    const current = run(["query", key, "/v", "PlayerDebugMode"]);
    // Shared Adobe settings changed by someone else are no longer ours to restore.
    if (!/PlayerDebugMode\s+REG_SZ\s+1\s*$/.test((current.stdout || "").trim())) continue;
    const result =
      entry.value === null
        ? run(["delete", key, "/v", "PlayerDebugMode", "/f"])
        : run(["add", key, "/v", "PlayerDebugMode", "/t", entry.type, "/d", entry.value, "/f"]);
    if (result.status !== 0)
      throw new Error("Could not restore Adobe settings. Retry uninstall with Premiere closed.");
    if (!entry.keyExisted) {
      const remaining = run(["query", key]);
      const lines = (remaining.stdout || "")
        .trim()
        .split(/\r?\n/)
        .filter((line) => line.trim());
      if (remaining.status === 0 && lines.length === 1) run(["delete", key, "/f"]);
    }
  }
}
