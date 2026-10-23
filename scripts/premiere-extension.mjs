import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";
import * as NodeChildProcess from "node:child_process";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

const platform = Effect.runSync(HostProcess.Platform);

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const { values } = NodeUtil.parseArgs({
  options: {
    "connector-root": {
      type: "string",
      default: NodePath.resolve(root, "../premiere-pro-mcp-aftr"),
    },
    destination: { type: "string" },
    "data-dir": { type: "string" },
    port: { type: "string", default: "5739" },
    "dry-run": { type: "boolean", default: false },
    "skip-adobe-settings": { type: "boolean", default: false },
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
const dataDir = NodePath.resolve(
  values["data-dir"] ??
    (platform === "win32"
      ? NodePath.join(
          process.env.LOCALAPPDATA ?? NodePath.join(NodeOS.homedir(), "AppData/Local"),
          "PremiereAssistant",
        )
      : NodePath.join(NodeOS.homedir(), "Library/Application Support/PremiereAssistant")),
);
const cepRoot =
  platform === "win32"
    ? NodePath.join(
        process.env.APPDATA ?? NodePath.join(NodeOS.homedir(), "AppData/Roaming"),
        "Adobe/CEP/extensions",
      )
    : NodePath.join(NodeOS.homedir(), "Library/Application Support/Adobe/CEP/extensions");
const destination = NodePath.resolve(
  values.destination ?? NodePath.join(cepRoot, "PremiereAssistant"),
);
const source = NodePath.join(root, "extensions/premiere");
if (destination === source || destination.startsWith(source + NodePath.sep))
  throw new Error("Install outside the extension source directory.");
const serverPath = NodePath.join(root, "apps/server/dist/bin.mjs");
const connectorPath = NodePath.resolve(values["connector-root"], "dist/index.js");
const workspacePath = NodePath.join(dataDir, "workspace");
const config = {
  backendUrl: `http://127.0.0.1:${port}/`,
  nodePath: process.execPath,
  serverPath,
  homeDir: NodePath.join(dataDir, "backend"),
  workspacePath,
};
if (!NodeFS.existsSync(serverPath))
  throw new Error("Build the fork first: vp run --filter t3 build");
if (!NodeFS.existsSync(connectorPath))
  throw new Error("Build the existing Premiere MCP connector first, or supply --connector-root.");
const mcpPath = NodePath.join(workspacePath, ".mcp.json");
const mcp = NodeFS.existsSync(mcpPath) ? JSON.parse(NodeFS.readFileSync(mcpPath, "utf8")) : {};
if (!mcp || typeof mcp !== "object" || Array.isArray(mcp))
  throw new Error("The existing MCP configuration must be an object.");
mcp.mcpServers ??= {};
const premiereServer = { command: process.execPath, args: [connectorPath] };
if (
  mcp.mcpServers.premiere &&
  JSON.stringify(mcp.mcpServers.premiere) !== JSON.stringify(premiereServer)
) {
  throw new Error(
    "The editing workspace already has a different Premiere MCP configuration. Choose --data-dir to keep it.",
  );
}
mcp.mcpServers.premiere = premiereServer;
const codexPath = NodePath.join(workspacePath, ".codex/config.toml");
const codexConfig = `[mcp_servers.premiere]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(connectorPath)}]\n`;
if (NodeFS.existsSync(codexPath) && NodeFS.readFileSync(codexPath, "utf8") !== codexConfig) {
  throw new Error(
    "The editing workspace already has a different Codex configuration. Choose --data-dir to keep it.",
  );
}
if (values["dry-run"]) {
  console.log(
    JSON.stringify(
      { destination, backendUrl: config.backendUrl, workspacePath, serverPath, connectorPath },
      null,
      2,
    ),
  );
} else {
  NodeFS.mkdirSync(destination, { recursive: true });
  NodeFS.cpSync(source, destination, {
    recursive: true,
    filter: (file) => !file.endsWith(".test.cjs"),
  });
  NodeFS.writeFileSync(
    NodePath.join(destination, "config.json"),
    JSON.stringify(config, null, 2) + "\n",
    {
      mode: 0o600,
    },
  );
  NodeFS.mkdirSync(NodePath.join(workspacePath, ".codex"), { recursive: true });
  NodeFS.writeFileSync(mcpPath, JSON.stringify(mcp, null, 2) + "\n");
  NodeFS.writeFileSync(codexPath, codexConfig);
  const instructionsPath = NodePath.join(workspacePath, "AGENTS.md");
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
    const result = NodeChildProcess.spawnSync(
      "reg.exe",
      [
        "add",
        "HKCU\\SOFTWARE\\Adobe\\CSXS.12",
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
      throw new Error("The extension was copied, but Adobe development mode could not be enabled.");
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
  console.log(`Installed Premiere Assistant: ${destination}`);
  console.log(`Backend: ${config.backendUrl}`);
  console.log("Restart Premiere, then open Window > Extensions > Premiere Assistant.");
  console.log("Keep the existing MCP for Adobe Premiere Pro connector enabled for editing tools.");
}
