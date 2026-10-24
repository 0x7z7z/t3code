import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as NodeChildProcess from "node:child_process";
import {
  buildConnectorBundle,
  connectorBundlePaths,
  defaultConnectorBundle,
  defaultConnectorRoot,
  validateConnectorBundle,
  validateConnectorSource,
} from "./premiere-connector.mjs";

// oxlint-disable-next-line t3code/no-global-process-runtime -- Also runs from the standalone distribution without workspace packages.
const platform = process.platform;

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const { values } = NodeUtil.parseArgs({
  options: {
    "connector-root": { type: "string" },
    "connector-bundle": { type: "string" },
    destination: { type: "string" },
    "data-dir": { type: "string" },
    "bridge-dir": { type: "string" },
    port: { type: "string", default: "5739" },
    "dry-run": { type: "boolean", default: false },
    "skip-adobe-settings": { type: "boolean", default: false },
    "runtime-root": { type: "string" },
    "workspace-dir": { type: "string" },
  },
});
const port = Number(values.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("Choose a port between 1024 and 65535.");
if (platform !== "win32" && platform !== "darwin" && !values.destination) {
  throw new Error(
    "Premiere Pro is supported on Windows and macOS. Use --destination to prepare a bundle on another platform.",
  );
}
const dataRoot =
  platform === "win32"
    ? (process.env.LOCALAPPDATA ?? NodePath.join(NodeOS.homedir(), "AppData/Local"))
    : NodePath.join(NodeOS.homedir(), "Library/Application Support");
const legacyDataDir = NodePath.resolve(dataRoot, "PremiereAssistant");
let dataDir = NodePath.resolve(values["data-dir"] ?? NodePath.join(dataRoot, "Axis"));
const cepRoot =
  platform === "win32"
    ? NodePath.join(
        process.env.APPDATA ?? NodePath.join(NodeOS.homedir(), "AppData/Roaming"),
        "Adobe/CEP/extensions",
      )
    : NodePath.join(NodeOS.homedir(), "Library/Application Support/Adobe/CEP/extensions");
const destination = NodePath.resolve(values.destination ?? NodePath.join(cepRoot, "Axis"));
const legacyDestination = NodePath.resolve(cepRoot, "PremiereAssistant");
function isLegacyExtension() {
  try {
    // Do not remove an unrelated extension or follow a linked installation.
    if (
      !NodeFS.lstatSync(legacyDestination).isDirectory() ||
      NodePath.dirname(NodeFS.realpathSync(legacyDestination)) !== NodeFS.realpathSync(cepRoot)
    )
      return false;
    for (const file of ["CSXS", "CSXS/manifest.xml"])
      if (NodeFS.lstatSync(NodePath.join(legacyDestination, file)).isSymbolicLink()) return false;
    return /^\s*(?:<\?xml[^>]*\?>\s*)?<ExtensionManifest\b[^>]*\bExtensionBundleId\s*=\s*(["'])com\.premiere\.assistant\1/.test(
      NodeFS.readFileSync(NodePath.join(legacyDestination, "CSXS/manifest.xml"), "utf8"),
    );
  } catch {
    return false;
  }
}
const legacyExtension = isLegacyExtension();
if (legacyExtension && destination.startsWith(legacyDestination + NodePath.sep))
  throw new Error("Install outside the previous extension directory.");
const source = NodePath.join(root, "extensions/premiere");
if (destination === source || destination.startsWith(source + NodePath.sep))
  throw new Error("Install outside the extension source directory.");
const runtimeRoot = values["runtime-root"] ? NodePath.resolve(values["runtime-root"]) : root;
const nodePath = values["runtime-root"]
  ? NodePath.join(runtimeRoot, "node/node.exe")
  : process.execPath;
const serverPath = NodePath.join(runtimeRoot, "apps/server/dist/bin.mjs");
if (!NodeFS.existsSync(nodePath)) throw new Error("The packaged Node runtime is missing.");
if (values["connector-root"] && values["connector-bundle"])
  throw new Error(
    "Choose --connector-root to rebuild or --connector-bundle to use a prebuilt bundle.",
  );
const bundlePath = NodePath.resolve(values["connector-bundle"] ?? defaultConnectorBundle);
const connectorRoot = NodePath.resolve(values["connector-root"] ?? defaultConnectorRoot);
const rebuildConnector =
  Boolean(values["connector-root"]) ||
  (!values["connector-bundle"] && !NodeFS.existsSync(bundlePath));
if (
  destination === bundlePath ||
  destination.startsWith(bundlePath + NodePath.sep) ||
  bundlePath.startsWith(destination + NodePath.sep)
)
  throw new Error("Install outside the connector bundle directory.");
if (rebuildConnector) validateConnectorSource(connectorRoot);
else validateConnectorBundle(bundlePath);
if (!NodeFS.existsSync(serverPath))
  throw new Error("Build the fork first: vp run --filter t3 build");
const previousConfigPath = NodeFS.existsSync(NodePath.join(destination, "config.json"))
  ? NodePath.join(destination, "config.json")
  : NodePath.join(legacyExtension ? legacyDestination : destination, "config.json");
let previousConfig = NodeFS.existsSync(previousConfigPath)
  ? JSON.parse(NodeFS.readFileSync(previousConfigPath, "utf8"))
  : undefined;

// Conversations record their workspace by absolute path, so an existing
// PremiereAssistant data directory stays where it is rather than being renamed.
let dataMigration = null;
if (!values["data-dir"] && !NodeFS.existsSync(dataDir) && NodeFS.existsSync(legacyDataDir)) {
  dataMigration = { from: legacyDataDir, to: dataDir, action: "keep-legacy" };
  dataDir = legacyDataDir;
}
// Uninstall retains this receipt with the workspace so a later release can
// update its owned MCP command even after the previous CEP folder is gone.
const receiptPath = NodePath.join(
  values["workspace-dir"]
    ? NodePath.resolve(values["workspace-dir"])
    : NodePath.join(dataDir, "workspace"),
  ".axis-install.json",
);
if (!previousConfig && NodeFS.existsSync(receiptPath))
  previousConfig = JSON.parse(NodeFS.readFileSync(receiptPath, "utf8"));
const connectorPath = connectorBundlePaths(NodePath.join(destination, "connector")).server;
const workspacePath = NodePath.join(dataDir, "workspace");
// Axis owns its own bridge directory. The standalone connector panel keeps
// ~/.premiere-pro-mcp/bridge, so the two never process the same commands.
const bridgePath = NodePath.resolve(
  values["bridge-dir"] ??
    previousConfig?.bridgePath ??
    NodePath.join(NodeOS.homedir(), ".premiere-pro-mcp/axis-bridge"),
);
const config = {
  backendUrl: `http://127.0.0.1:${port}/`,
  nodePath,
  serverPath,
  homeDir:
    !values["data-dir"] && previousConfig?.homeDir
      ? previousConfig.homeDir
      : NodePath.join(dataDir, "backend"),
  workspacePath: values["workspace-dir"]
    ? NodePath.resolve(values["workspace-dir"])
    : !values["data-dir"] && previousConfig?.workspacePath
      ? previousConfig.workspacePath
      : workspacePath,
  connectorPath,
  bridgePath,
  ...(values["runtime-root"] ? { runtimeRoot } : {}),
};
const installedWorkspace = config.workspacePath;
const mcpPath = NodePath.join(installedWorkspace, ".mcp.json");
const mcp = NodeFS.existsSync(mcpPath) ? JSON.parse(NodeFS.readFileSync(mcpPath, "utf8")) : {};
if (!mcp || typeof mcp !== "object" || Array.isArray(mcp))
  throw new Error("The existing MCP configuration must be an object.");
mcp.mcpServers ??= {};
if (typeof mcp.mcpServers !== "object" || Array.isArray(mcp.mcpServers))
  throw new Error("The existing MCP servers configuration must be an object.");
const legacyPremiereServer = { command: nodePath, args: [connectorPath] };
const premiereServer = { ...legacyPremiereServer, env: { PREMIERE_TEMP_DIR: bridgePath } };
const previousServers = [legacyPremiereServer, premiereServer];
if (previousConfig?.nodePath && previousConfig?.connectorPath) {
  const previous = { command: previousConfig.nodePath, args: [previousConfig.connectorPath] };
  previousServers.push(previous);
  if (previousConfig.bridgePath)
    previousServers.push({ ...previous, env: { PREMIERE_TEMP_DIR: previousConfig.bridgePath } });
}
if (
  mcp.mcpServers.premiere &&
  !previousServers.some((server) => NodeUtil.isDeepStrictEqual(mcp.mcpServers.premiere, server))
) {
  throw new Error(
    "The editing workspace already has a different Premiere MCP configuration. Choose --data-dir to keep it.",
  );
}
mcp.mcpServers.premiere = premiereServer;
const codexPath = NodePath.join(installedWorkspace, ".codex/config.toml");
function codexConfiguration(server) {
  return (
    `[mcp_servers.premiere]\ncommand = ${JSON.stringify(server.command)}\nargs = [${server.args.map((arg) => JSON.stringify(arg)).join(", ")}]\n` +
    (server.env
      ? `\n[mcp_servers.premiere.env]\nPREMIERE_TEMP_DIR = ${JSON.stringify(server.env.PREMIERE_TEMP_DIR)}\n`
      : "")
  );
}
const codexConfig = codexConfiguration(premiereServer);
if (
  NodeFS.existsSync(codexPath) &&
  !previousServers.map(codexConfiguration).includes(NodeFS.readFileSync(codexPath, "utf8"))
) {
  throw new Error(
    "The editing workspace already has a different Codex configuration. Choose --data-dir to keep it.",
  );
}
if (values["dry-run"]) {
  console.log(
    JSON.stringify(
      {
        destination,
        dataMigration,
        legacyExtensionCleanup:
          legacyExtension && destination !== legacyDestination ? legacyDestination : null,
        backendUrl: config.backendUrl,
        workspacePath,
        serverPath,
        connectorPath,
        bridgePath,
        connectorBundle: bundlePath,
        connectorBuild: rebuildConnector ? connectorRoot : null,
        config,
        mcp,
        codexConfig,
      },
      null,
      2,
    ),
  );
} else {
  const bundle = rebuildConnector
    ? await buildConnectorBundle(connectorRoot, bundlePath)
    : validateConnectorBundle(bundlePath);
  // Use exactly the connector's ACL/ancestry checks before the CEP panel can process commands.
  const { ensurePrivateBridgeDirectory } = await import(
    NodeURL.pathToFileURL(bundle.privateBridge).href
  );
  ensurePrivateBridgeDirectory(bridgePath);
  NodeFS.mkdirSync(destination, { recursive: true });
  NodeFS.cpSync(source, destination, {
    recursive: true,
    filter: (file) => !file.endsWith(".test.cjs"),
  });
  NodeFS.cpSync(bundlePath, NodePath.join(destination, "connector"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(destination, "config.json"),
    JSON.stringify(config, null, 2) + "\n",
    {
      mode: 0o600,
    },
  );
  NodeFS.mkdirSync(NodePath.join(installedWorkspace, ".codex"), { recursive: true });
  NodeFS.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + "\n");
  NodeFS.writeFileSync(codexPath, codexConfig);
  NodeFS.writeFileSync(
    NodePath.join(installedWorkspace, ".axis-install.json"),
    JSON.stringify(config, null, 2) + "\n",
  );
  const instructionsPath = NodePath.join(installedWorkspace, "AGENTS.md");
  if (!NodeFS.existsSync(instructionsPath))
    NodeFS.writeFileSync(
      instructionsPath,
      [
        "# Premiere editing workspace",
        "",
        "Use the premiere MCP server to inspect and edit the active Adobe Premiere project.",
        "Verify the project and sequence identity from the panel context before each edit. Stop on a mismatch.",
        "Keep timeline changes with one editing agent. Delegate only research, planning, or review in parallel.",
        "Use GPT-6-Luna at max reasoning for delegated agents, with fast mode disabled. Resolve supported provider and model options through orchestrator_capabilities.",
        "Read back edits before reporting success. Git checkpoints do not restore Premiere timelines.",
        "Do not alter or delete source media. Keep temporary research and plans in this workspace.",
        "",
      ].join("\n"),
    );
  if (!values["skip-adobe-settings"] && platform === "win32") {
    for (const version of [10, 11, 12]) {
      const result = NodeChildProcess.spawnSync(
        "reg.exe",
        [
          "add",
          `HKCU\\SOFTWARE\\Adobe\\CSXS.${version}`,
          "/v",
          "PlayerDebugMode",
          "/t",
          "REG_SZ",
          "/d",
          "1",
          "/f",
        ],
        { windowsHide: true, encoding: "utf8" },
      );
      if (result.status !== 0)
        throw new Error(
          "The extension was copied, but Adobe development mode could not be enabled.",
        );
    }
  } else if (!values["skip-adobe-settings"] && platform === "darwin") {
    const result = NodeChildProcess.spawnSync(
      "defaults",
      ["write", "com.adobe.CSXS.12", "PlayerDebugMode", "1"],
      {
        encoding: "utf8",
      },
    );
    if (result.status !== 0)
      throw new Error("The extension was copied, but Adobe development mode could not be enabled.");
  }
  if (destination !== legacyDestination && isLegacyExtension()) {
    NodeFS.rmSync(legacyDestination, { recursive: true });
    console.log(`Removed the previous extension: ${legacyDestination}`);
  }
  console.log(`Installed Axis: ${destination}`);
  console.log(`Backend: ${config.backendUrl}`);
  console.log("Restart Premiere, then open Window > Extensions > Axis.");
  console.log("The extension runs the Premiere bridge itself.");
}
