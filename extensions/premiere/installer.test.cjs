"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { existsSync } = require("node:fs");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { promisify } = require("node:util");
const execFile = promisify(require("node:child_process").execFile);
const { createServer } = require("node:net");

const root = path.resolve(__dirname, "../..");
const installer = path.join(root, "scripts/premiere-extension.mjs");

async function fixture(t) {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- E2E paths must match the real installer subprocess's OS.
  const platform = process.platform;
  const directory = await fs.mkdtemp(path.join(tmpdir(), "premiere-installer-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const bundle = path.join(directory, "prebuilt");
  await fs.mkdir(path.join(bundle, "dist/resources"), { recursive: true });
  await fs.writeFile(path.join(bundle, "dist/index.mjs"), 'console.log("fixture connector");');
  await fs.writeFile(path.join(bundle, "dist/resources/coverage.json"), '{"fixture":true}');
  await fs.writeFile(path.join(bundle, "package.json"), '{"type":"module"}');
  await fs.writeFile(
    path.join(bundle, "dist/private-bridge.mjs"),
    `
    import { mkdirSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    export function ensurePrivateBridgeDirectory(directory) {
      if (directory.endsWith("unsafe")) throw new Error("unsafe bridge ancestry");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(join(directory, "validated"), "private bridge initialized");
    }
  `,
  );
  const destination = path.join(directory, "extension");
  const data = path.join(directory, "data");
  const bridge = path.join(directory, "private-bridge");
  const environment = {
    ...process.env,
    HOME: directory,
    USERPROFILE: directory,
    LOCALAPPDATA: path.join(directory, "local"),
    APPDATA: path.join(directory, "roaming"),
  };
  const dataRoot =
    platform === "win32"
      ? environment.LOCALAPPDATA
      : path.join(directory, "Library/Application Support");
  const cepRoot =
    platform === "win32"
      ? path.join(environment.APPDATA, "Adobe/CEP/extensions")
      : path.join(dataRoot, "Adobe/CEP/extensions");
  const legacyData = path.join(dataRoot, "PremiereAssistant");
  const axisData = path.join(dataRoot, "Axis");
  const legacyExtension = path.join(cepRoot, "PremiereAssistant");
  const axisExtension = path.join(cepRoot, "Axis");
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const args = [
    "--connector-bundle",
    bundle,
    "--destination",
    destination,
    "--data-dir",
    data,
    "--bridge-dir",
    bridge,
    "--skip-adobe-settings",
    "--port",
    String(port),
  ];
  const run = (...extra) =>
    execFile(process.execPath, [installer, ...args, ...extra], {
      cwd: directory,
      windowsHide: true,
      env: environment,
    });
  const runDefaults = (...extra) =>
    execFile(
      process.execPath,
      [
        installer,
        "--connector-bundle",
        bundle,
        "--bridge-dir",
        bridge,
        "--skip-adobe-settings",
        "--port",
        String(port),
        ...(platform !== "win32" && platform !== "darwin" ? ["--destination", axisExtension] : []),
        ...extra,
      ],
      { cwd: directory, windowsHide: true, env: environment },
    );
  const writeLegacyManifest = async (id = "com.premiere.assistant") => {
    await fs.mkdir(path.join(legacyExtension, "CSXS"), { recursive: true });
    await fs.writeFile(
      path.join(legacyExtension, "CSXS/manifest.xml"),
      `<?xml version="1.0"?><ExtensionManifest ExtensionBundleId="${id}"></ExtensionManifest>`,
    );
  };
  return {
    directory,
    bundle,
    destination,
    data,
    bridge,
    args,
    run,
    runDefaults,
    legacyData,
    axisData,
    legacyExtension,
    axisExtension,
    writeLegacyManifest,
    environment,
  };
}

test("default installation uses Axis paths", async (t) => {
  const f = await fixture(t);
  const { stdout } = await f.runDefaults("--dry-run");
  const plan = JSON.parse(stdout);
  assert.equal(plan.destination, f.axisExtension);
  assert.equal(plan.config.homeDir, path.join(f.axisData, "backend"));
  assert.equal(existsSync(f.axisData), false);
});

test("keeps legacy accounts, conversations and owned MCP configs in place and removes the old panel", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.legacyData, "backend/userdata"), { recursive: true });
  const accountData = Buffer.from([0, 1, 2, 255]);
  await fs.writeFile(path.join(f.legacyData, "backend/userdata/statev2.sqlite"), accountData);
  await f.writeLegacyManifest();
  const oldConnector = path.join(f.legacyExtension, "connector/dist/index.mjs");
  await fs.writeFile(
    path.join(f.legacyExtension, "config.json"),
    JSON.stringify({
      nodePath: process.execPath,
      connectorPath: oldConnector,
      bridgePath: f.bridge,
    }),
  );
  const workspace = path.join(f.legacyData, "workspace");
  await fs.mkdir(path.join(workspace, ".codex"), { recursive: true });
  await fs.writeFile(path.join(workspace, "notes.txt"), "keep my editing workspace");
  await fs.writeFile(
    path.join(workspace, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        premiere: {
          command: process.execPath,
          args: [oldConnector],
          env: { PREMIERE_TEMP_DIR: f.bridge },
        },
        other: { command: "keep-me" },
      },
    }),
  );
  await fs.writeFile(
    path.join(workspace, ".codex/config.toml"),
    `[mcp_servers.premiere]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(oldConnector)}]\n\n[mcp_servers.premiere.env]\nPREMIERE_TEMP_DIR = ${JSON.stringify(f.bridge)}\n`,
  );
  const { stdout } = await f.runDefaults();
  assert.match(stdout, /Installed Axis/);
  assert.match(stdout, /Window > Extensions > Axis/);
  assert.equal(existsSync(f.axisData), false);
  assert.equal(existsSync(f.legacyExtension), false);
  assert.deepEqual(
    await fs.readFile(path.join(f.legacyData, "backend/userdata/statev2.sqlite")),
    accountData,
  );
  assert.equal(
    await fs.readFile(path.join(f.legacyData, "workspace/notes.txt"), "utf8"),
    "keep my editing workspace",
  );
  const mcp = JSON.parse(await fs.readFile(path.join(f.legacyData, "workspace/.mcp.json"), "utf8"));
  assert.equal(mcp.mcpServers.other.command, "keep-me");
  assert.equal(
    mcp.mcpServers.premiere.args[0],
    path.join(f.axisExtension, "connector/dist/index.mjs"),
  );
  const settings = JSON.parse(await fs.readFile(path.join(f.axisExtension, "config.json"), "utf8"));
  assert.equal(settings.homeDir, path.join(f.legacyData, "backend"));
});

test("dry-run previews legacy migration and cleanup without changing any legacy files", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.legacyData, { recursive: true });
  await fs.writeFile(path.join(f.legacyData, "account.json"), "existing account");
  await f.writeLegacyManifest();
  const manifest = await fs.readFile(path.join(f.legacyExtension, "CSXS/manifest.xml"), "utf8");
  const { stdout } = await f.runDefaults("--dry-run");
  const plan = JSON.parse(stdout);
  assert.equal(plan.dataMigration.action, "keep-legacy");
  assert.equal(plan.legacyExtensionCleanup, f.legacyExtension);
  assert.equal(plan.config.homeDir, path.join(f.legacyData, "backend"));
  assert.equal(
    await fs.readFile(path.join(f.legacyData, "account.json"), "utf8"),
    "existing account",
  );
  assert.equal(
    await fs.readFile(path.join(f.legacyExtension, "CSXS/manifest.xml"), "utf8"),
    manifest,
  );
  for (const directory of [f.axisData, f.axisExtension, f.bridge])
    assert.equal(existsSync(directory), false);
});

test("preserves an existing Axis data directory and an unrelated old-named CEP folder", async (t) => {
  const f = await fixture(t);
  for (const directory of [f.axisData, f.legacyData]) {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "account.json"), directory);
  }
  await f.writeLegacyManifest("com.someone.else");
  await f.runDefaults();
  for (const directory of [f.axisData, f.legacyData])
    assert.equal(await fs.readFile(path.join(directory, "account.json"), "utf8"), directory);
  assert.match(
    await fs.readFile(path.join(f.legacyExtension, "CSXS/manifest.xml"), "utf8"),
    /com.someone.else/,
  );
});

test("explicit data paths do not migrate the default legacy data", async (t) => {
  const f = await fixture(t);
  await fs.mkdir(f.legacyData, { recursive: true });
  await fs.writeFile(path.join(f.legacyData, "account.json"), "keep legacy");
  await f.run();
  assert.equal(await fs.readFile(path.join(f.legacyData, "account.json"), "utf8"), "keep legacy");
  assert.equal(existsSync(f.axisData), false);
});

test("dry-run previews installed paths and MCP configuration without creating directories", async (t) => {
  const f = await fixture(t);
  const { stdout } = await f.run("--dry-run");
  const plan = JSON.parse(stdout);
  assert.equal(plan.connectorPath, path.join(f.destination, "connector/dist/index.mjs"));
  assert.equal(plan.connectorBundle, f.bundle);
  assert.equal(plan.connectorBuild, null);
  assert.equal(plan.config.bridgePath, f.bridge);
  assert.deepEqual(plan.mcp.mcpServers.premiere, {
    command: process.execPath,
    args: [plan.connectorPath],
    env: { PREMIERE_TEMP_DIR: f.bridge },
  });
  assert.ok(plan.codexConfig.includes(JSON.stringify(plan.connectorPath)));
  for (const directory of [f.destination, f.data, f.bridge])
    assert.equal(existsSync(directory), false);
});

test("installs a prebuilt connector and both provider configs without its source checkout", async (t) => {
  const f = await fixture(t);
  const workspace = path.join(f.data, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  const unrelated = { command: "another-server", args: [] };
  await fs.writeFile(
    path.join(workspace, ".mcp.json"),
    JSON.stringify({ mcpServers: { other: unrelated } }),
  );
  await f.run();
  const settings = JSON.parse(await fs.readFile(path.join(f.destination, "config.json"), "utf8"));
  assert.equal(settings.connectorPath, path.join(f.destination, "connector/dist/index.mjs"));
  assert.equal(settings.bridgePath, f.bridge);
  assert.equal(
    await fs.readFile(path.join(f.bridge, "validated"), "utf8"),
    "private bridge initialized",
  );
  assert.equal(existsSync(path.join(f.destination, "installer.test.cjs")), false);
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(path.join(f.destination, "connector/dist/resources/coverage.json"), "utf8"),
    ),
    { fixture: true },
  );
  const mcp = JSON.parse(await fs.readFile(path.join(workspace, ".mcp.json"), "utf8"));
  assert.deepEqual(mcp.mcpServers.other, unrelated);
  assert.deepEqual(mcp.mcpServers.premiere, {
    command: settings.nodePath,
    args: [settings.connectorPath],
    env: { PREMIERE_TEMP_DIR: f.bridge },
  });
  const codex = await fs.readFile(path.join(workspace, ".codex/config.toml"), "utf8");
  assert.ok(codex.includes(`args = [${JSON.stringify(settings.connectorPath)}]`));
  assert.ok(codex.includes(`PREMIERE_TEMP_DIR = ${JSON.stringify(f.bridge)}`));
  // Removing the build input cannot break the installed server.
  await fs.rm(f.bundle, { recursive: true });
  const { stdout } = await execFile(process.execPath, [settings.connectorPath], {
    cwd: f.directory,
  });
  assert.equal(stdout.trim(), "fixture connector");
});

test("reinstallation migrates the previous external connector and bridge in owned configs", async (t) => {
  const f = await fixture(t);
  await f.run();
  const configPath = path.join(f.destination, "config.json");
  const settings = JSON.parse(await fs.readFile(configPath, "utf8"));
  settings.connectorPath = path.join(f.directory, "old-checkout/dist/index.js");
  settings.bridgePath = path.join(f.directory, "old-bridge");
  await fs.writeFile(configPath, JSON.stringify(settings));
  await fs.writeFile(
    path.join(settings.workspacePath, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        premiere: {
          command: settings.nodePath,
          args: [settings.connectorPath],
          env: { PREMIERE_TEMP_DIR: settings.bridgePath },
        },
      },
    }),
  );
  await fs.writeFile(
    path.join(settings.workspacePath, ".codex/config.toml"),
    `[mcp_servers.premiere]\ncommand = ${JSON.stringify(settings.nodePath)}\nargs = [${JSON.stringify(settings.connectorPath)}]\n\n[mcp_servers.premiere.env]\nPREMIERE_TEMP_DIR = ${JSON.stringify(settings.bridgePath)}\n`,
  );
  await f.run();
  const updated = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(updated.connectorPath, path.join(f.destination, "connector/dist/index.mjs"));
  assert.equal(updated.bridgePath, f.bridge);
  const { stdout } = await f.run("--dry-run");
  assert.deepEqual(JSON.parse(stdout).mcp.mcpServers.premiere, {
    command: updated.nodePath,
    args: [updated.connectorPath],
    env: { PREMIERE_TEMP_DIR: f.bridge },
  });
});

test("preserves conflicting user configurations and fails bridge validation before installing", async (t) => {
  const f = await fixture(t);
  const workspace = path.join(f.data, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  const mcpPath = path.join(workspace, ".mcp.json");
  const custom = JSON.stringify({ mcpServers: { premiere: { command: "custom" } } });
  await fs.writeFile(mcpPath, custom);
  await assert.rejects(f.run(), /different Premiere MCP configuration/);
  assert.equal(await fs.readFile(mcpPath, "utf8"), custom);
  assert.equal(existsSync(f.destination), false);
  await fs.rm(mcpPath);
  await assert.rejects(
    f.run("--bridge-dir", path.join(f.directory, "unsafe")),
    /unsafe bridge ancestry/,
  );
  assert.equal(existsSync(f.destination), false);
  assert.equal(existsSync(mcpPath), false);
});

test("rejects incomplete prebuilt bundles and ambiguous source flags", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.run("--connector-root", f.directory), /Choose --connector-root/);
  await fs.rm(path.join(f.bundle, "dist/private-bridge.mjs"));
  await assert.rejects(f.run("--dry-run"), /Incomplete Premiere connector bundle/);
});

test("bundles dependencies and preserves runtime JSON lookup after relocation", async (t) => {
  const f = await fixture(t);
  const source = path.join(f.directory, "checkout");
  const output = path.join(f.directory, "bundle-output");
  await fs.mkdir(path.join(source, "dist/bridge"), { recursive: true });
  await fs.mkdir(path.join(source, "dist/resources"), { recursive: true });
  await fs.mkdir(path.join(source, "node_modules/fixture-dependency"), { recursive: true });
  await fs.writeFile(
    path.join(source, "package.json"),
    '{"name":"fixture-connector","version":"1.2.3","type":"module","license":"MIT"}',
  );
  await fs.writeFile(path.join(source, "LICENSE"), "fixture license");
  await fs.writeFile(path.join(source, "dist/resources/coverage.json"), '{"tools":383}');
  await fs.writeFile(
    path.join(source, "node_modules/fixture-dependency/package.json"),
    '{"name":"fixture-dependency","version":"1.0.0","type":"module","main":"index.js","license":"MIT"}',
  );
  await fs.writeFile(
    path.join(source, "node_modules/fixture-dependency/index.js"),
    'export const name = "bundled dependency";',
  );
  await fs.writeFile(
    path.join(source, "node_modules/fixture-dependency/LICENSE"),
    "dependency license",
  );
  await fs.writeFile(
    path.join(source, "dist/index.js"),
    `
    import { createRequire } from "node:module";
    import { name } from "fixture-dependency";
    const require = createRequire(import.meta.url);
    console.log(JSON.stringify({ name, ...require("./resources/coverage.json") }));
  `,
  );
  await fs.copyFile(
    path.join(f.bundle, "dist/private-bridge.mjs"),
    path.join(source, "dist/bridge/file-bridge.js"),
  );
  const { buildConnectorBundle } = await import(
    pathToFileURL(path.join(root, "scripts/premiere-connector.mjs")).href
  );
  const built = await buildConnectorBundle(source, output);
  await fs.rm(source, { recursive: true });
  const { stdout } = await execFile(process.execPath, [built.server], { cwd: f.directory });
  assert.deepEqual(JSON.parse(stdout), { name: "bundled dependency", tools: 383 });
  assert.ok(
    (await fs.readFile(path.join(output, "THIRD_PARTY_NOTICES.txt"), "utf8")).includes(
      "dependency license",
    ),
  );
  assert.equal(existsSync(path.join(output, "node_modules")), false);
});

test("packaged upgrades replace repo paths and keep custom workspace and backend locations", async (t) => {
  const f = await fixture(t);
  await f.run();
  const configPath = path.join(f.destination, "config.json");
  const previous = JSON.parse(await fs.readFile(configPath, "utf8"));
  const packaged = path.join(f.directory, "Programs/Axis/app-fixture");
  await fs.mkdir(path.join(packaged, "node"), { recursive: true });
  await fs.mkdir(path.join(packaged, "apps/server/dist"), { recursive: true });
  await fs.copyFile(process.execPath, path.join(packaged, "node/node.exe"));
  await fs.writeFile(path.join(packaged, "apps/server/dist/bin.mjs"), "// packaged server");
  await fs
    .writeFile(path.join(previous.homeDir, "sentinel"), "conversations", { flag: "a" })
    .catch(async () => {
      await fs.mkdir(previous.homeDir, { recursive: true });
      await fs.writeFile(path.join(previous.homeDir, "sentinel"), "conversations");
    });
  await f.runDefaults("--destination", f.destination, "--runtime-root", packaged);
  const updated = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.equal(updated.homeDir, previous.homeDir);
  assert.equal(updated.workspacePath, previous.workspacePath);
  assert.equal(updated.nodePath, path.join(packaged, "node/node.exe"));
  assert.equal(updated.serverPath, path.join(packaged, "apps/server/dist/bin.mjs"));
  assert.equal(updated.runtimeRoot, packaged);
  const mcp = JSON.parse(await fs.readFile(path.join(previous.workspacePath, ".mcp.json"), "utf8"));
  assert.equal(mcp.mcpServers.premiere.command, updated.nodePath);
  assert.equal(await fs.readFile(path.join(previous.homeDir, "sentinel"), "utf8"), "conversations");
});

test("reinstall after CEP removal updates retained owned MCP settings using the workspace receipt", async (t) => {
  const f = await fixture(t);
  await f.runDefaults();
  const receiptPath = path.join(f.axisData, "workspace/.axis-install.json");
  const previous = JSON.parse(await fs.readFile(receiptPath, "utf8"));
  previous.nodePath = path.join(f.directory, "removed-runtime/node.exe");
  await fs.writeFile(receiptPath, JSON.stringify(previous));
  await fs.writeFile(
    path.join(previous.workspacePath, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        premiere: {
          command: previous.nodePath,
          args: [previous.connectorPath],
          env: { PREMIERE_TEMP_DIR: previous.bridgePath },
        },
      },
    }),
  );
  await fs.writeFile(
    path.join(previous.workspacePath, ".codex/config.toml"),
    `[mcp_servers.premiere]\ncommand = ${JSON.stringify(previous.nodePath)}\nargs = [${JSON.stringify(previous.connectorPath)}]\n\n[mcp_servers.premiere.env]\nPREMIERE_TEMP_DIR = ${JSON.stringify(previous.bridgePath)}\n`,
  );
  await fs.rm(f.axisExtension, { recursive: true });
  await f.runDefaults();
  const updated = JSON.parse(
    await fs.readFile(path.join(previous.workspacePath, ".mcp.json"), "utf8"),
  );
  assert.equal(updated.mcpServers.premiere.command, process.execPath);
});

test("sandbox guards reject live paths, their parents, and junctions resolving outside the sandbox", async (t) => {
  const f = await fixture(t);
  const { validateSandboxPaths } = await import(
    pathToFileURL(path.join(root, "scripts/axis-sandbox-paths.mjs")).href
  );
  const sandbox = path.join(f.directory, "sandbox");
  const protectedData = path.join(f.directory, "live/PremiereAssistant");
  await fs.mkdir(sandbox, { recursive: true });
  await fs.mkdir(protectedData, { recursive: true });
  validateSandboxPaths(
    sandbox,
    { runtime: path.join(sandbox, "Programs/Axis"), data: path.join(sandbox, "data") },
    [protectedData],
  );
  assert.throws(
    () => validateSandboxPaths(sandbox, { data: protectedData }, [protectedData]),
    /outside|live/,
  );
  assert.throws(
    () =>
      validateSandboxPaths(path.join(f.directory, "live"), { data: protectedData }, [
        protectedData,
      ]),
    /live/,
  );
  const alias = path.join(sandbox, "linked-data");
  await fs.symlink(protectedData, alias, "junction");
  assert.throws(
    () => validateSandboxPaths(sandbox, { data: path.join(alias, "workspace") }, [protectedData]),
    /outside|live/,
  );
});

test("explicit workspace overrides retain owned configuration after removing the panel", async (t) => {
  const f = await fixture(t);
  const workspace = path.join(f.directory, "explicit-workspace");
  await f.run("--workspace-dir", workspace);
  const config = JSON.parse(await fs.readFile(path.join(f.destination, "config.json"), "utf8"));
  assert.equal(config.workspacePath, workspace);
  assert.equal(existsSync(path.join(workspace, ".mcp.json")), true);
  assert.equal(existsSync(path.join(f.data, "workspace")), false);
  await fs.rm(f.destination, { recursive: true });
  await f.run("--workspace-dir", workspace);
  assert.equal(existsSync(path.join(workspace, ".axis-install.json")), true);
});
