import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeNet from "node:net";
import * as NodeModule from "node:module";
import * as NodeChildProcess from "node:child_process";
import * as NodeEvents from "node:events";
import * as NodeCrypto from "node:crypto";
import { liveAxisPaths, validateSandboxPaths } from "./axis-sandbox-paths.mjs";

const executable = NodePath.resolve(process.argv[2]);
const buildReport = JSON.parse(
  NodeFS.readFileSync(NodePath.join(NodePath.dirname(executable), "build-report.json"), "utf8"),
);
NodeAssert.equal(
  buildReport.sandboxProtocol,
  3,
  "Refusing an installer without the fail-closed sandbox contract.",
);
NodeAssert.equal(
  NodePath.resolve(buildReport.executable),
  executable,
  "Installer must match the build report.",
);
NodeAssert.equal(
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(executable)).digest("hex"),
  buildReport.installerSha256,
  "Installer checksum must match the build report.",
);
// The connector rejects shared writable ancestors such as this machine's D:\temp.
const sandbox = NodePath.join(NodeOS.homedir(), "axis installer smoke-" + NodeCrypto.randomUUID());
const listener = NodeNet.createServer();
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
NodeAssert.notEqual(port, 5739);
const installRoot = NodePath.join(sandbox, "Programs/Axis");
const destination = NodePath.join(sandbox, "Roaming/Adobe/CEP/extensions/Axis");
const legacyData = NodePath.join(sandbox, "Local/PremiereAssistant");
const workspace = NodePath.join(legacyData, "workspace");
const bridge = NodePath.join(sandbox, "User/axis-bridge");
const protectedPaths = liveAxisPaths();
const targets = { runtime: installRoot, cep: destination, data: legacyData, workspace, bridge };
validateSandboxPaths(sandbox, targets, protectedPaths);
NodeFS.mkdirSync(sandbox);
const liveConfigPath = NodePath.join(protectedPaths[0], "config.json");
const liveFiles = [
  liveConfigPath,
  ...["CSXS/manifest.xml", "host.js", "runtime.cjs"].map((name) =>
    NodePath.join(protectedPaths[0], name),
  ),
];
if (NodeFS.existsSync(liveConfigPath)) {
  const liveConfig = JSON.parse(NodeFS.readFileSync(liveConfigPath, "utf8"));
  if (liveConfig.workspacePath)
    liveFiles.push(
      NodePath.join(liveConfig.workspacePath, ".mcp.json"),
      NodePath.join(liveConfig.workspacePath, ".codex/config.toml"),
    );
}
const protectedContents = new Map(
  liveFiles
    .filter((file) => NodeFS.existsSync(file))
    .map((file) => [file, NodeFS.readFileSync(file)]),
);
const registryExecutable = NodePath.join(process.env.SystemRoot, "System32/reg.exe");
function registryState(key) {
  const result = NodeChildProcess.spawnSync(registryExecutable, ["query", key], {
    windowsHide: true,
    encoding: "utf8",
  });
  return JSON.stringify({ status: result.status, stdout: result.stdout });
}
const protectedRegistry = new Map(
  [
    ...[10, 11, 12].map((version) => `HKCU\\Software\\Adobe\\CSXS.${version}`),
    "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Axis",
  ].map((key) => [key, registryState(key)]),
);
const previous = {
  nodePath: "C:/missing-dev-node/node.exe",
  connectorPath: "C:/missing-repo/connector/index.mjs",
  bridgePath: bridge,
  homeDir: NodePath.join(legacyData, "backend"),
  workspacePath: workspace,
};
const oldMcp = {
  command: previous.nodePath,
  args: [previous.connectorPath],
  env: { PREMIERE_TEMP_DIR: bridge },
};
for (const dir of [destination, NodePath.join(workspace, ".codex"), previous.homeDir])
  NodeFS.mkdirSync(dir, { recursive: true });
NodeFS.writeFileSync(NodePath.join(destination, "config.json"), JSON.stringify(previous));
NodeFS.writeFileSync(
  NodePath.join(workspace, ".mcp.json"),
  JSON.stringify({ mcpServers: { premiere: oldMcp, unrelated: { command: "keep-me" } } }),
);
NodeFS.writeFileSync(
  NodePath.join(workspace, ".codex/config.toml"),
  `[mcp_servers.premiere]\ncommand = ${JSON.stringify(previous.nodePath)}\nargs = [${JSON.stringify(previous.connectorPath)}]\n\n[mcp_servers.premiere.env]\nPREMIERE_TEMP_DIR = ${JSON.stringify(bridge)}\n`,
);
const sentinel = NodePath.join(previous.homeDir, "existing-conversations.bin");
const originalBytes = Buffer.from([0, 1, 255, 42]);
NodeFS.writeFileSync(sentinel, originalBytes);
const log = NodePath.join(sandbox, "smoke.log");
const installerEnvironment = {
  ...process.env,
  TEMP: sandbox,
  TMP: sandbox,
  // Even a broken flag parser must fall back into this sandbox, never the live install.
  APPDATA: NodePath.join(sandbox, "SystemRoaming"),
  LOCALAPPDATA: NodePath.join(sandbox, "SystemLocal"),
  USERPROFILE: NodePath.join(sandbox, "User"),
  HOME: NodePath.join(sandbox, "User"),
  AXIS_SANDBOX_ROOT: sandbox,
  AXIS_RUNTIME_DIR: installRoot,
  AXIS_CEP_DIR: destination,
  AXIS_DATA_DIR: legacyData,
  AXIS_WORKSPACE_DIR: workspace,
  AXIS_BRIDGE_DIR: bridge,
  AXIS_SKIP_REGISTRY: "1",
};
function run(command, args, options = {}) {
  validateSandboxPaths(sandbox, targets, protectedPaths);
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: sandbox,
    windowsHide: true,
    encoding: "utf8",
    timeout: 300000,
    env: installerEnvironment,
    ...options,
  });
  NodeFS.appendFileSync(
    log,
    `${command}\n${result.stdout ?? ""}${result.stderr ?? ""}\nexit=${result.status}\n`,
  );
  if (result.error) throw result.error;
  NodeAssert.equal(result.status, 0, `Command failed. See ${log}`);
  return result.stdout;
}
const childProcess = NodeModule.createRequire(import.meta.url)("node:child_process");
const children = [];
const originalSpawn = childProcess.spawn;
const originalEnvironment = process.env;
try {
  const noOverrides = { ...installerEnvironment };
  for (const key of Object.keys(noOverrides)) if (key.startsWith("AXIS_")) delete noOverrides[key];
  noOverrides.AXIS_SKIP_REGISTRY = "1";
  for (const flag of ["/SANDBOX", "/sandbox", `/SANDBOX=${sandbox}`]) {
    const missingOverrides = NodeChildProcess.spawnSync(executable, ["/S", flag], {
      env: noOverrides,
      cwd: sandbox,
      windowsHide: true,
      timeout: 30000,
    });
    NodeAssert.equal(
      missingOverrides.status,
      2,
      "Sandbox intent must never fall back to defaults.",
    );
    NodeAssert.equal(NodeFS.existsSync(NodePath.join(sandbox, "SystemLocal/Programs/Axis")), false);
  }
  const rejected = NodeChildProcess.spawnSync(executable, ["/S", "/SANDBOX"], {
    env: { ...installerEnvironment, AXIS_SANDBOX_ROOT: "" },
    cwd: sandbox,
    windowsHide: true,
    timeout: 30000,
  });
  NodeAssert.equal(
    rejected.status,
    2,
    "Sandbox requests must fail closed when their root is missing.",
  );
  const rejectedQuoted = NodeChildProcess.spawnSync(executable, ["/S", `/SANDBOX=${sandbox}`], {
    env: { ...installerEnvironment, AXIS_SANDBOX_ROOT: "" },
    cwd: sandbox,
    windowsHide: true,
    timeout: 30000,
  });
  NodeAssert.equal(
    rejectedQuoted.status,
    2,
    "A quoted whole sandbox argument must never fall back to live defaults.",
  );
  NodeAssert.equal(
    NodeFS.existsSync(installRoot),
    false,
    "Rejected sandbox requests must not extract runtime files.",
  );
  // Each failure must occur before runtime extraction, including junction aliases.
  const outside = NodePath.join(sandbox, "outside-alias");
  NodeFS.symlinkSync(NodeOS.userInfo().homedir, outside, "junction");
  for (const overrides of [
    { AXIS_RUNTIME_DIR: NodePath.join(outside, "blocked-axis-test") },
    { AXIS_BRIDGE_DIR: NodePath.join(NodeOS.userInfo().homedir, ".premiere-pro-mcp") },
    { AXIS_CEP_DIR: "" },
    { AXIS_SKIP_REGISTRY: "0" },
  ]) {
    const refused = NodeChildProcess.spawnSync(executable, ["/S", "/SANDBOX", `/PORT=${port}`], {
      env: { ...installerEnvironment, ...overrides },
      cwd: sandbox,
      windowsHide: true,
      timeout: 30000,
    });
    NodeAssert.equal(refused.status, 2, "Unsafe overrides must fail before extraction.");
    NodeAssert.equal(NodeFS.existsSync(installRoot), false);
  }
  NodeFS.unlinkSync(outside);
  run(executable, ["/S", "/SANDBOX", `/PORT=${port}`], { env: installerEnvironment });
  const configPath = NodePath.join(destination, "config.json");
  const config = JSON.parse(NodeFS.readFileSync(configPath, "utf8"));
  validateSandboxPaths(
    sandbox,
    {
      runtime: config.runtimeRoot,
      cep: destination,
      data: config.homeDir,
      workspace: config.workspacePath,
      bridge: config.bridgePath,
    },
    protectedPaths,
  );
  NodeAssert.equal(config.homeDir, previous.homeDir);
  NodeAssert.equal(config.workspacePath, workspace);
  NodeAssert.ok(config.nodePath.startsWith(installRoot));
  NodeAssert.ok(config.serverPath.startsWith(installRoot));
  NodeAssert.deepEqual(NodeFS.readFileSync(sentinel), originalBytes);
  NodeAssert.equal(NodeFS.existsSync(NodePath.join(sandbox, "Local/Axis")), false);
  const mcp = JSON.parse(NodeFS.readFileSync(NodePath.join(workspace, ".mcp.json"), "utf8"));
  NodeAssert.equal(mcp.mcpServers.premiere.command, config.nodePath);
  NodeAssert.equal(mcp.mcpServers.unrelated.command, "keep-me");
  const environment = {
    SystemRoot: process.env.SystemRoot,
    WINDIR: process.env.WINDIR,
    COMSPEC: process.env.COMSPEC,
    PATH: NodePath.join(process.env.SystemRoot, "System32"),
    PATHEXT: ".EXE;.CMD;.BAT",
    TEMP: sandbox,
    TMP: sandbox,
    USERPROFILE: NodePath.join(sandbox, "User"),
    HOME: NodePath.join(sandbox, "User"),
    APPDATA: NodePath.join(sandbox, "Roaming"),
    LOCALAPPDATA: NodePath.join(sandbox, "Local"),
  };
  NodeAssert.match(run(config.nodePath, ["--version"], { env: environment }), /v24\.22\.1/);
  NodeAssert.match(
    run(NodePath.join(config.runtimeRoot, "git/cmd/git.exe"), ["--version"], { env: environment }),
    /git version/,
  );
  process.env = environment;
  childProcess.spawn = (...args) => {
    const descriptor = NodeFS.openSync(NodePath.join(sandbox, "backend.log"), "a");
    const child = originalSpawn(args[0], args[1], {
      ...args[2],
      stdio: ["ignore", descriptor, descriptor],
    });
    NodeFS.closeSync(descriptor);
    children.push(child);
    return child;
  };
  const require = NodeModule.createRequire(import.meta.url);
  const runtime = require(NodePath.join(destination, "runtime.cjs"));
  await Promise.all([runtime.ensureBackend(config), runtime.ensureBackend(config)]);
  children[0].ref();
  NodeAssert.equal(children.length, 1);
  const probe = await (await fetch(config.backendUrl + "premiere-extension.json")).json();
  NodeAssert.equal(probe.protocol, 1);
  const page = await fetch(config.backendUrl + "premiere.html");
  NodeAssert.equal(page.status, 200);
  const html = await page.text();
  NodeAssert.match(html, /<html/i);
  const asset = /<script[^>]+src="([^"]+)"/.exec(html);
  NodeAssert.ok(asset, "Packaged web entry must load a built script.");
  NodeAssert.equal((await fetch(new URL(asset[1], config.backendUrl))).status, 200);
  const paired = new URL(await runtime.pairBackend(config));
  NodeAssert.equal(paired.origin, new URL(config.backendUrl).origin);
  NodeAssert.equal(paired.pathname, "/premiere.html");
  NodeFS.appendFileSync(log, "Verified protocol 1, served web assets and packaged pairing CLI.\n");
  await runtime.ensureBackend(config);
  NodeAssert.equal(children.length, 1);
  // Same-version repair while the installed backend is running must reuse it.
  run(executable, ["/S", "/SANDBOX", `/PORT=${port}`], { env: installerEnvironment });
  await runtime.ensureBackend(config);
  NodeAssert.equal(children.length, 1);
  const exited = NodeEvents.once(children[0], "exit");
  NodeFS.appendFileSync(
    log,
    "Verified running repair. Stopping the captured backend for recovery.\n",
  );
  children[0].kill();
  await exited;
  await runtime.ensureBackend(config);
  NodeAssert.equal(children.length, 2);
  NodeFS.appendFileSync(
    log,
    "Verified crash recovery. Uninstalling with the owned backend running.\n",
  );
  children[1].ref();
  const stopped = NodeEvents.once(children[1], "exit");
  process.env = originalEnvironment;
  childProcess.spawn = originalSpawn;
  run(NodePath.join(installRoot, "Uninstall Axis.exe"), ["/S", `_?=${installRoot}`], {
    windowsVerbatimArguments: true,
  });
  await stopped;
  NodeAssert.equal(NodeFS.existsSync(destination), false);
  NodeAssert.equal(NodeFS.existsSync(config.runtimeRoot), false);
  NodeAssert.deepEqual(NodeFS.readFileSync(sentinel), originalBytes);
  NodeAssert.equal(NodeFS.existsSync(NodePath.join(workspace, ".mcp.json")), true);
  run(executable, ["/S", "/SANDBOX", `/PORT=${port}`], { env: installerEnvironment });
  NodeAssert.deepEqual(NodeFS.readFileSync(sentinel), originalBytes);
  run(NodePath.join(installRoot, "Uninstall Axis.exe"), ["/S", `_?=${installRoot}`], {
    windowsVerbatimArguments: true,
  });
  console.log(
    JSON.stringify(
      {
        sandbox,
        port,
        protocol: probe.protocol,
        installer: executable,
        verified: [
          "dev upgrade",
          "legacy data retained byte-for-byte",
          "no system Node/Git or repo runtime dependency",
          "web client served",
          "packaged pairing CLI",
          "concurrent starts reuse backend",
          "running same-version repair",
          "crash recovery",
          "uninstall stops only owned backend and retains data",
          "reinstall after uninstall",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  process.env = originalEnvironment;
  childProcess.spawn = originalSpawn;
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null) {
      child.ref();
      const exited = NodeEvents.once(child, "exit");
      child.kill();
      await exited;
    }
  // Keep the small sandbox and log for inspection; successful uninstall removes its runtime.
  for (const [file, bytes] of protectedContents)
    NodeAssert.ok(NodeFS.readFileSync(file).equals(bytes), `Protected live file changed: ${file}`);
  for (const [key, state] of protectedRegistry)
    NodeAssert.equal(registryState(key), state, `Protected registry key changed: ${key}`);
}
