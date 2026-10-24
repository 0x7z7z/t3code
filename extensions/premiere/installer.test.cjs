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

const root = path.resolve(__dirname, "../..");
const installer = path.join(root, "scripts/premiere-extension.mjs");

async function fixture(t) {
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
  ];
  const run = (...extra) =>
    execFile(process.execPath, [installer, ...args, ...extra], {
      cwd: directory,
      windowsHide: true,
    });
  return { directory, bundle, destination, data, bridge, args, run };
}

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
