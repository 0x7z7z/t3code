// Standalone entrypoint invoked by NSIS with the bundled Node runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeOS from "node:os";
import { availablePort } from "./axis-install-port.mjs";
import { captureAdobeSettings, restoreAdobeSettings } from "./axis-adobe-settings.mjs";
import {
  validateSandboxEnvironment,
  validateSandboxPaths,
  validateSandboxPort,
} from "./axis-sandbox-paths.mjs";

const { values } = NodeUtil.parseArgs({
  options: {
    "install-root": { type: "string" },
    "runtime-root": { type: "string" },
    "sandbox-root": { type: "string" },
    uninstall: { type: "boolean" },
    "prepare-upgrade": { type: "boolean" },
    port: { type: "string", default: "5739" },
  },
});
const runtimeRoot = values["runtime-root"]
  ? NodePath.resolve(values["runtime-root"])
  : NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const installRoot = NodePath.resolve(values["install-root"]);
const recordPath = NodePath.join(installRoot, "install-record.json");
const sandbox = values["sandbox-root"] ?? process.env.AXIS_SANDBOX_ROOT;
const sandboxRequested = Object.keys(process.env).some((name) =>
  /^AXIS_(SANDBOX_ROOT|RUNTIME_DIR|CEP_DIR|DATA_DIR|WORKSPACE_DIR|BRIDGE_DIR|SKIP_REGISTRY)$/.test(
    name,
  ),
);
if (sandbox || sandboxRequested) {
  validateSandboxEnvironment(sandbox, installRoot);
  if (!values.uninstall) validateSandboxPort(values.port);
}
function inside(parent, child) {
  const relative = NodePath.relative(parent, child);
  return relative && !relative.startsWith("..") && !NodePath.isAbsolute(relative);
}
if (!values["prepare-upgrade"] && !inside(installRoot, runtimeRoot))
  throw new Error("Runtime must be inside the install directory.");
function stopOwnedBackends() {
  // Stop only PIDs captured when Axis spawned a packaged backend, after checking
  // executable and entrypoint identity. A dev backend has no such receipt.
  for (const entry of NodeFS.readdirSync(installRoot, { withFileTypes: true })) {
    if (!entry.name.startsWith("app-")) continue;
    const releaseRoot = NodePath.join(installRoot, entry.name);
    const releaseFile = NodePath.join(releaseRoot, "release.json");
    if (!NodeFS.existsSync(releaseFile)) continue;
    if (
      entry.isSymbolicLink() ||
      !entry.isDirectory() ||
      NodeFS.lstatSync(releaseFile).isSymbolicLink()
    )
      throw new Error("Refusing to remove a linked runtime.");
    const release = JSON.parse(NodeFS.readFileSync(releaseFile, "utf8"));
    if (entry.name !== `app-${release.buildId}`)
      throw new Error("Runtime release ownership does not match its directory.");
    const processFile = NodePath.join(releaseRoot, "backend-process.json");
    if (!NodeFS.existsSync(processFile)) continue;
    const owned = JSON.parse(NodeFS.readFileSync(processFile, "utf8"));
    if (
      !Number.isSafeInteger(owned.pid) ||
      owned.pid <= 0 ||
      owned.nodePath !== NodePath.join(releaseRoot, "node/node.exe") ||
      owned.serverPath !== NodePath.join(releaseRoot, "apps/server/dist/bin.mjs")
    )
      throw new Error("Invalid backend ownership receipt.");
    const stopped = NodeChildProcess.spawnSync(
      NodePath.join(
        process.env.SystemRoot || "C:/Windows",
        "System32/WindowsPowerShell/v1.0/powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        '$ErrorActionPreference = "Stop"; $axisProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$env:AXIS_BACKEND_PID"; if ($axisProcess -and $axisProcess.ExecutablePath -ieq $env:AXIS_BACKEND_NODE -and $axisProcess.CommandLine.Contains($env:AXIS_BACKEND_SERVER)) { Stop-Process -Id $axisProcess.ProcessId -Force -ErrorAction Stop }',
      ],
      {
        windowsHide: true,
        encoding: "utf8",
        env: {
          ...process.env,
          AXIS_BACKEND_PID: String(owned.pid),
          AXIS_BACKEND_NODE: owned.nodePath,
          AXIS_BACKEND_SERVER: owned.serverPath,
        },
      },
    );
    if (stopped.status !== 0)
      throw new Error(stopped.stderr || "Could not stop the owned Axis backend.");
  }
}
if (values["prepare-upgrade"]) {
  stopOwnedBackends();
  console.log("Axis backend stopped for upgrade. User data was retained.");
} else if (values.uninstall) {
  const record = JSON.parse(NodeFS.readFileSync(recordPath, "utf8"));
  if (record.runtimeRoot !== runtimeRoot) throw new Error("Installation ownership changed.");
  if ((record.sandbox || undefined) !== (sandbox || undefined))
    throw new Error("Uninstall sandbox does not match its installation.");
  if (sandbox) validateSandboxPaths(sandbox, { runtimeRoot, destination: record.destination });
  stopOwnedBackends();
  const configPath = NodePath.join(record.destination, "config.json");
  if (NodeFS.existsSync(configPath)) {
    const config = JSON.parse(NodeFS.readFileSync(configPath, "utf8"));
    // A subsequent dev install owns its CEP directory. Leave that replacement alone.
    if (config.runtimeRoot === runtimeRoot) {
      if (NodeFS.lstatSync(record.destination).isSymbolicLink())
        throw new Error("Refusing to remove a linked CEP directory.");
      if (sandbox) validateSandboxPaths(sandbox, { destination: record.destination });
      // Keep the ownership config until restoration succeeds so uninstall can be retried.
      if (!sandbox) restoreAdobeSettings(record.adobeSettings);
      NodeFS.rmSync(record.destination, { recursive: true });
      if (
        record.ownedBridge === config.bridgePath &&
        config.bridgePath === NodePath.join(NodeOS.homedir(), ".premiere-pro-mcp/axis-bridge") &&
        NodeFS.existsSync(config.bridgePath) &&
        !NodeFS.lstatSync(config.bridgePath).isSymbolicLink()
      )
        NodeFS.rmSync(config.bridgePath, { recursive: true });
    }
  }
  console.log("Axis panel removed. All user data and conversations were retained.");
} else {
  const previousRecord = NodeFS.existsSync(recordPath)
    ? JSON.parse(NodeFS.readFileSync(recordPath, "utf8"))
    : null;
  const adobeSettings = sandbox
    ? undefined
    : (previousRecord?.adobeSettings ?? captureAdobeSettings());
  if (NodeFS.existsSync(recordPath)) stopOwnedBackends();
  const env = { ...process.env };
  if (sandbox) {
    if (!inside(sandbox, installRoot))
      throw new Error("Sandbox install must stay inside its root.");
    env.LOCALAPPDATA = NodePath.join(sandbox, "Local");
    env.APPDATA = NodePath.join(sandbox, "Roaming");
    env.USERPROFILE = NodePath.join(sandbox, "User");
    env.HOME = env.USERPROFILE;
    for (const name of [
      "AXIS_RUNTIME_DIR",
      "AXIS_CEP_DIR",
      "AXIS_DATA_DIR",
      "AXIS_WORKSPACE_DIR",
      "AXIS_BRIDGE_DIR",
    ]) {
      if (!env[name] || !inside(sandbox, NodePath.resolve(env[name])))
        throw new Error(`Sandbox requires an explicit ${name} inside its root.`);
    }
    if (env.AXIS_SKIP_REGISTRY !== "1" || NodePath.resolve(env.AXIS_RUNTIME_DIR) !== installRoot)
      throw new Error("Sandbox runtime or registry override is invalid.");
  }
  const destination = sandbox
    ? NodePath.resolve(env.AXIS_CEP_DIR)
    : NodePath.join(
        env.APPDATA || NodePath.join(NodeOS.homedir(), "AppData/Roaming"),
        "Adobe/CEP/extensions/Axis",
      );
  if (inside(installRoot, destination) || inside(destination, installRoot))
    throw new Error("Runtime and CEP directories must be separate.");
  if (sandbox) {
    for (const previousFile of [
      NodePath.join(destination, "config.json"),
      NodePath.join(env.APPDATA, "Adobe/CEP/extensions/PremiereAssistant/config.json"),
      ...["Axis", "PremiereAssistant"].map((name) =>
        NodePath.join(env.LOCALAPPDATA, name, "workspace/.axis-install.json"),
      ),
    ]) {
      if (!NodeFS.existsSync(previousFile)) continue;
      const previous = JSON.parse(NodeFS.readFileSync(previousFile, "utf8"));
      const paths = Object.fromEntries(
        ["homeDir", "workspacePath", "bridgePath"]
          .filter((key) => previous[key])
          .map((key) => [key, previous[key]]),
      );
      validateSandboxPaths(sandbox, paths);
    }
  }
  const args = [
    NodePath.join(runtimeRoot, "scripts/premiere-extension.mjs"),
    "--runtime-root",
    runtimeRoot,
    "--connector-bundle",
    NodePath.join(runtimeRoot, "connector"),
    "--destination",
    destination,
    "--port",
    sandbox ? values.port : await availablePort(values.port),
  ];
  if (sandbox)
    args.push(
      "--skip-adobe-settings",
      "--bridge-dir",
      env.AXIS_BRIDGE_DIR,
      "--data-dir",
      env.AXIS_DATA_DIR,
      "--workspace-dir",
      env.AXIS_WORKSPACE_DIR,
    );
  if (env.AXIS_SKIP_REGISTRY === "1" && !args.includes("--skip-adobe-settings"))
    args.push("--skip-adobe-settings");
  const result = NodeChildProcess.spawnSync(process.execPath, args, {
    env,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0)
    throw new Error(result.stderr || result.error?.message || "Axis installation failed.");
  NodeFS.writeFileSync(
    recordPath,
    JSON.stringify(
      {
        runtimeRoot,
        destination,
        sandbox,
        adobeSettings,
        ownedBridge: sandbox
          ? undefined
          : NodePath.join(NodeOS.homedir(), ".premiere-pro-mcp/axis-bridge"),
      },
      null,
      2,
    ) + "\n",
  );
  for (const entry of NodeFS.readdirSync(installRoot, { withFileTypes: true })) {
    const previousRoot = NodePath.join(installRoot, entry.name);
    if (
      !entry.name.startsWith("app-") ||
      previousRoot === runtimeRoot ||
      !entry.isDirectory() ||
      entry.isSymbolicLink()
    )
      continue;
    const marker = NodePath.join(previousRoot, "release.json");
    if (!NodeFS.existsSync(marker) || NodeFS.lstatSync(marker).isSymbolicLink()) continue;
    const release = JSON.parse(NodeFS.readFileSync(marker, "utf8"));
    if (entry.name !== `app-${release.buildId}`) continue;
    try {
      NodeFS.rmSync(previousRoot, { recursive: true });
    } catch {
      console.log(
        "An older Axis runtime is still in use. Close Premiere and reinstall to finish cleanup.",
      );
    }
  }
  console.log(result.stdout);
}
