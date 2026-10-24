import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as NodeModule from "node:module";

export const repositoryRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
);
export const defaultConnectorRoot = NodePath.resolve(repositoryRoot, "../premiere-pro-mcp-aftr");
export const defaultConnectorBundle = NodePath.join(repositoryRoot, "build/premiere-connector");

export function connectorBundlePaths(directory) {
  return {
    server: NodePath.join(directory, "dist/index.mjs"),
    privateBridge: NodePath.join(directory, "dist/private-bridge.mjs"),
    resources: NodePath.join(directory, "dist/resources"),
  };
}

export function validateConnectorBundle(directory) {
  const paths = connectorBundlePaths(directory);
  for (const file of [
    paths.server,
    paths.privateBridge,
    paths.resources,
    NodePath.join(directory, "package.json"),
  ]) {
    if (!NodeFS.existsSync(file))
      throw new Error(
        `Incomplete Premiere connector bundle: ${file}. Rebuild with --connector-root.`,
      );
  }
  return paths;
}

export function validateConnectorSource(directory) {
  for (const file of [
    "dist/index.js",
    "dist/bridge/file-bridge.js",
    "dist/resources",
    "package.json",
    "LICENSE",
  ]) {
    if (!NodeFS.existsSync(NodePath.join(directory, file)))
      throw new Error(
        `Missing ${file} in ${directory}. Build the connector checkout or use --connector-bundle.`,
      );
  }
}

export async function buildConnectorBundle(source, destination = defaultConnectorBundle) {
  source = NodePath.resolve(source);
  destination = NodePath.resolve(destination);
  if (destination === source || destination.startsWith(source + NodePath.sep))
    throw new Error("Build the connector bundle outside its source checkout.");
  validateConnectorSource(source);
  const { Rolldown } = await import("vite-plus/pack");
  const paths = connectorBundlePaths(destination);
  NodeFS.mkdirSync(NodePath.dirname(paths.server), { recursive: true });
  const builtins = new Set(NodeModule.builtinModules.flatMap((name) => [name, `node:${name}`]));
  const dependencyDirectories = new Set();
  for (const [input, output] of [
    [NodePath.join(source, "dist/index.js"), paths.server],
    [NodePath.join(source, "dist/bridge/file-bridge.js"), paths.privateBridge],
  ]) {
    const bundle = await Rolldown.rolldown({
      input,
      platform: "node",
      external: (id) => builtins.has(id),
      onLog(level, log, handler) {
        // An unresolved dependency must never become a checkout dependency at runtime.
        if (log.code === "UNRESOLVED_IMPORT") throw new Error(log.message);
        handler(level, log);
      },
    });
    try {
      const result = await bundle.write({ file: output, format: "esm", codeSplitting: false });
      for (const chunk of result.output) {
        if (chunk.type !== "chunk") continue;
        for (const id of Object.keys(chunk.modules)) {
          const normalized = id.replaceAll("\\", "/");
          const match = /^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(normalized);
          if (match) dependencyDirectories.add(match[1]);
        }
      }
    } finally {
      await bundle.close();
    }
  }
  NodeFS.cpSync(NodePath.join(source, "dist/resources"), paths.resources, {
    recursive: true,
    filter: (file) => NodeFS.statSync(file).isDirectory() || file.endsWith(".json"),
  });
  const metadata = JSON.parse(NodeFS.readFileSync(NodePath.join(source, "package.json"), "utf8"));
  NodeFS.writeFileSync(
    NodePath.join(destination, "package.json"),
    JSON.stringify(
      {
        name: metadata.name,
        version: metadata.version,
        type: "module",
        license: metadata.license,
        homepage: metadata.homepage,
      },
      null,
      2,
    ) + "\n",
  );
  NodeFS.copyFileSync(NodePath.join(source, "LICENSE"), NodePath.join(destination, "LICENSE"));
  const notices = [];
  for (const directory of [...dependencyDirectories].sort()) {
    const pkg = JSON.parse(NodeFS.readFileSync(NodePath.join(directory, "package.json"), "utf8"));
    notices.push(`${pkg.name} ${pkg.version} (${pkg.license ?? "see license"})`);
    for (const name of NodeFS.readdirSync(directory).filter((name) =>
      /^(license|licence|notice)(\.|$)/i.test(name),
    )) {
      if (NodeFS.statSync(NodePath.join(directory, name)).isFile())
        notices.push(NodeFS.readFileSync(NodePath.join(directory, name), "utf8"));
    }
  }
  NodeFS.writeFileSync(
    NodePath.join(destination, "THIRD_PARTY_NOTICES.txt"),
    notices.join("\n\n") + "\n",
  );
  return validateConnectorBundle(destination);
}
