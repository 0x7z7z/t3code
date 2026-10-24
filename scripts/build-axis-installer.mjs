// oxlint-disable t3code/no-global-process-runtime -- Release tooling also runs outside an Effect application.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeModule from "node:module";
import * as NodeURL from "node:url";
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import { selectCliRuntimeExternalDependencies } from "./lib/cli-external-packages.ts";
import {
  buildConnectorBundle,
  defaultConnectorBundle,
  defaultConnectorRoot,
  validateConnectorBundle,
} from "./premiere-connector.mjs";

const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const { values } = NodeUtil.parseArgs({
  options: {
    "skip-build": { type: "boolean", default: false },
    "connector-root": { type: "string" },
    "connector-bundle": { type: "string" },
    output: { type: "string", default: NodePath.join(root, "dist/axis-installer") },
    cache: { type: "string", default: NodePath.join(root, "build/axis-cache") },
  },
});
if (process.platform !== "win32" || process.arch !== "x64")
  throw new Error("Build on Windows x64 so native dependencies match the installer.");
const output = NodePath.resolve(values.output);
const cache = NodePath.resolve(values.cache);
NodeFS.mkdirSync(output, { recursive: true });
NodeFS.mkdirSync(cache, { recursive: true });
const assets = {
  node: {
    name: "node-v24.22.1-win-x64.zip",
    url: "https://nodejs.org/dist/v24.22.1/node-v24.22.1-win-x64.zip",
    sha256: "d2046d28c2c3dcd211ac5145c0bf30e2047ef9dfb306693c8c6e2eccd8b95fa5",
  },
  nsis: {
    name: "nsis-3.11.zip",
    url: "https://sourceforge.net/projects/nsis/files/NSIS%203/3.11/nsis-3.11.zip/download",
    sha256: "c7d27f780ddb6cffb4730138cd1591e841f4b7edb155856901cdf5f214394fa1",
  },
  git: {
    name: "MinGit-2.56.0.3-64-bit.zip",
    url: "https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.3/MinGit-2.56.0.3-64-bit.zip",
    sha256: "2e5619966e588fde5f8122c5557cad50c0fbafcaed736689f40ec1dfb1d78ea7",
  },
};
function run(command, args, options = {}) {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} exited with ${result.status}`);
}
async function asset(item) {
  const file = NodePath.join(cache, item.name);
  if (!NodeFS.existsSync(file)) {
    console.log(`Downloading ${item.url}`);
    const response = await fetch(item.url, { signal: AbortSignal.timeout(120000) });
    if (!response.ok) throw new Error(`Download failed: ${response.status} ${item.url}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (NodeCrypto.createHash("sha256").update(bytes).digest("hex") !== item.sha256)
      throw new Error(`Checksum mismatch: ${item.name}`);
    NodeFS.writeFileSync(file, bytes, { flag: "wx" });
  }
  if (
    NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex") !== item.sha256
  )
    throw new Error(`Cached checksum mismatch: ${file}. Remove it and retry.`);
  return file;
}
function extract(zip, destination) {
  NodeFS.mkdirSync(destination, { recursive: true });
  run(NodePath.join(process.env.SystemRoot ?? "C:/Windows", "System32/tar.exe"), [
    "-xf",
    zip,
    "-C",
    destination,
  ]);
}
const downloads = {};
for (const [name, item] of Object.entries(assets)) downloads[name] = await asset(item);
if (!values["skip-build"])
  run(process.execPath, [
    NodePath.join(root, "node_modules/vite-plus/bin/vp"),
    "run",
    "--filter",
    "t3",
    "build",
  ]);
for (const file of [
  "apps/server/dist/bin.mjs",
  "apps/server/dist/client/index.html",
  "apps/server/dist/client/premiere.html",
]) {
  if (!NodeFS.existsSync(NodePath.join(root, file)))
    throw new Error(`Missing ${file}. Run vp run --filter t3 build.`);
}
if (values["connector-root"] && values["connector-bundle"])
  throw new Error("Choose one connector source.");
const connector = NodePath.resolve(values["connector-bundle"] ?? defaultConnectorBundle);
if (values["connector-root"] || !NodeFS.existsSync(connector))
  await buildConnectorBundle(
    NodePath.resolve(values["connector-root"] ?? defaultConnectorRoot),
    connector,
  );
validateConnectorBundle(connector);
const payload = NodeFS.mkdtempSync(NodePath.join(output, "payload-"));
const copy = (from, to) =>
  NodeFS.cpSync(from, to, {
    recursive: true,
    dereference: true,
    filter: (file) => !file.endsWith(".test.cjs") && !file.endsWith(".map"),
  });
extract(downloads.node, NodePath.join(payload, "node-archive"));
NodeFS.renameSync(
  NodePath.join(payload, "node-archive/node-v24.22.1-win-x64"),
  NodePath.join(payload, "node"),
);
NodeFS.rmdirSync(NodePath.join(payload, "node-archive"));
extract(downloads.git, NodePath.join(payload, "git"));
copy(NodePath.join(root, "apps/server/dist"), NodePath.join(payload, "apps/server/dist"));
copy(NodePath.join(root, "extensions/premiere"), NodePath.join(payload, "extensions/premiere"));
// A release cannot carry a developer's absolute paths or credentials.
NodeFS.rmSync(NodePath.join(payload, "extensions/premiere/config.json"), { force: true });
copy(connector, NodePath.join(payload, "connector"));
for (const file of [
  "premiere-extension.mjs",
  "premiere-connector.mjs",
  "axis-install.mjs",
  "axis-sandbox-paths.mjs",
])
  copy(NodePath.join(root, "scripts", file), NodePath.join(payload, "scripts", file));
copy(NodePath.join(root, "LICENSE"), NodePath.join(payload, "LICENSE"));
const metadata = JSON.parse(
  NodeFS.readFileSync(NodePath.join(root, "apps/server/package.json"), "utf8"),
);
NodeFS.writeFileSync(
  NodePath.join(payload, "apps/server/package.json"),
  JSON.stringify({ name: "axis-server", type: "module", version: metadata.version }),
);

// Resolve from each real pnpm package, then copy bytes, never junctions. A nested
// package is needed only when two runtime dependencies require different versions.
const copied = new Map();
function packageDirectory(name, from) {
  const require = NodeModule.createRequire(NodePath.join(from, "package.json"));
  for (const base of require.resolve.paths(name) ?? []) {
    const candidate = NodePath.join(base, name);
    if (NodeFS.existsSync(NodePath.join(candidate, "package.json")))
      return NodeFS.realpathSync(candidate);
  }
  return null;
}
const serverTarget = NodePath.join(payload, "apps/server");
function dependency(name, from, parentTarget, optional = false) {
  const source = packageDirectory(name, from);
  if (!source) {
    if (optional) return;
    throw new Error(`Missing runtime dependency ${name} required by ${from}`);
  }
  const pkg = JSON.parse(NodeFS.readFileSync(NodePath.join(source, "package.json"), "utf8"));
  function supports(list, value) {
    return (
      !list ||
      (!list.includes(`!${value}`) &&
        (!list.some((item) => !item.startsWith("!")) || list.includes(value)))
    );
  }
  if (!supports(pkg.os, "win32") || !supports(pkg.cpu, "x64")) return;
  let target = NodePath.join(serverTarget, "node_modules", name);
  const previous = copied.get(target);
  if (previous === source) return;
  if (previous) target = NodePath.join(parentTarget, "node_modules", name);
  if (copied.get(target) === source) return;
  copied.set(target, source);
  console.log(`Staging ${name}@${pkg.version}`);
  NodeFS.cpSync(source, target, {
    recursive: true,
    dereference: true,
    filter: (file) =>
      file === source ||
      !NodePath.relative(source, file).split(NodePath.sep).includes("node_modules"),
  });
  for (const child of Object.keys(pkg.dependencies ?? {}))
    dependency(child, source, target, Boolean(pkg.optionalDependencies?.[child]));
  for (const child of Object.keys(pkg.optionalDependencies ?? {}))
    if (!pkg.dependencies?.[child]) dependency(child, source, target, true);
}
for (const name of Object.keys(selectCliRuntimeExternalDependencies(metadata.dependencies)))
  dependency(name, NodePath.join(root, "apps/server"), serverTarget);
const digest = NodeCrypto.createHash("sha256");
let bytes = 0;
let files = 0;
function hashTree(directory) {
  for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const file = NodePath.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Distribution contains a link: ${file}`);
    if (entry.isDirectory()) hashTree(file);
    else {
      const content = NodeFS.readFileSync(file);
      digest.update(NodePath.relative(payload, file)).update(content);
      bytes += content.length;
      files++;
    }
  }
}
hashTree(payload);
digest.update(NodeFS.readFileSync(NodePath.join(root, "scripts/axis-installer.nsi")));
const buildId = `${metadata.version}-${digest.digest("hex").slice(0, 12)}`;
NodeFS.writeFileSync(
  NodePath.join(payload, "release.json"),
  JSON.stringify({ buildId, node: "24.22.1", assets }, null, 2) + "\n",
);
const nsis = NodeFS.mkdtempSync(NodePath.join(cache, "nsis-"));
extract(downloads.nsis, nsis);
const executable = NodePath.join(output, `Axis-${buildId}-Setup.exe`);
run(NodePath.join(nsis, "nsis-3.11/makensis.exe"), [
  "/V2",
  `/DPAYLOAD=${payload}`,
  `/DOUTPUT=${executable}`,
  `/DBUILD_ID=${buildId}`,
  `/DVERSION=${metadata.version}`,
  NodePath.join(root, "scripts/axis-installer.nsi"),
]);
const report = {
  executable,
  payload,
  buildId,
  payloadBytes: bytes,
  payloadFiles: files,
  installerBytes: NodeFS.statSync(executable).size,
  runtimePackages: copied.size,
  sandboxProtocol: 3,
  installerSha256: NodeCrypto.createHash("sha256")
    .update(NodeFS.readFileSync(executable))
    .digest("hex"),
};
NodeFS.writeFileSync(
  NodePath.join(output, "build-report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
