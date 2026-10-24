import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import * as NodeUtil from "node:util";

export function liveAxisPaths() {
  // userInfo does not follow HOME/USERPROFILE overrides used by test children.
  const home = NodeOS.userInfo().homedir;
  return [
    NodePath.join(home, "AppData/Roaming/Adobe/CEP/extensions/Axis"),
    NodePath.join(home, "AppData/Local/PremiereAssistant"),
    NodePath.join(home, "AppData/Local/Axis"),
    NodePath.join(home, "AppData/Local/Programs/Axis"),
    NodePath.join(home, ".premiere-pro-mcp"),
  ];
}

function canonical(directory) {
  let existing = NodePath.resolve(directory);
  const tail = [];
  while (!NodeFS.existsSync(existing)) {
    const parent = NodePath.dirname(existing);
    if (parent === existing) throw new Error(`Cannot resolve sandbox path: ${directory}`);
    tail.unshift(NodePath.basename(existing));
    existing = parent;
  }
  return NodePath.resolve(NodeFS.realpathSync(existing), ...tail);
}
function within(parent, child) {
  const relative = NodePath.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(".." + NodePath.sep) &&
      !NodePath.isAbsolute(relative))
  );
}

export function validateSandboxPaths(root, targets, protectedPaths = []) {
  if (!NodePath.isAbsolute(root)) throw new Error("Sandbox root must be absolute.");
  const sandbox = canonical(root);
  const protectedDirectories = [...liveAxisPaths(), ...protectedPaths].map(canonical);
  function validate(name, target) {
    if (!target || !NodePath.isAbsolute(target))
      throw new Error(`Sandbox ${name} must be an explicit absolute path.`);
    if (NodeFS.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error(`Refusing sandbox ${name}: linked paths can escape outside its root.`);
    const resolved = canonical(target);
    if (!within(sandbox, resolved)) throw new Error(`Sandbox ${name} resolves outside its root.`);
    if (
      protectedDirectories.some(
        (protectedPath) => within(protectedPath, resolved) || within(resolved, protectedPath),
      )
    )
      throw new Error(
        `Refusing sandbox ${name}: it overlaps a live Axis or PremiereAssistant path.`,
      );
  }
  for (const [name, target] of Object.entries({ root, ...targets })) {
    validate(name, target);
    // A safe directory can contain a linked config file or nested directory.
    // Copy/write/remove operations must not follow those into the live install.
    function descendants(directory) {
      if (!NodeFS.existsSync(directory) || !NodeFS.lstatSync(directory).isDirectory()) return;
      for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
        const child = NodePath.join(directory, entry.name);
        validate(name, child);
        if (entry.isDirectory() && !entry.isSymbolicLink()) descendants(child);
      }
    }
    if (name !== "root") descendants(target);
  }
}

export function validateSandboxEnvironment(root, runtime, env = process.env) {
  const protectedPaths = [
    ...(env.APPDATA ? [NodePath.join(env.APPDATA, "Adobe/CEP/extensions/Axis")] : []),
    ...(env.LOCALAPPDATA
      ? ["PremiereAssistant", "Programs/Axis"].map((name) => NodePath.join(env.LOCALAPPDATA, name))
      : []),
  ].filter((directory) => !root || !within(canonical(root), canonical(directory)));
  validateSandboxPaths(
    root,
    {
      runtime,
      configuredRuntime: env.AXIS_RUNTIME_DIR,
      cep: env.AXIS_CEP_DIR,
      data: env.AXIS_DATA_DIR,
      workspace: env.AXIS_WORKSPACE_DIR,
      bridge: env.AXIS_BRIDGE_DIR,
    },
    protectedPaths,
  );
  if (canonical(runtime) !== canonical(env.AXIS_RUNTIME_DIR) || env.AXIS_SKIP_REGISTRY !== "1")
    throw new Error("Sandbox runtime or registry override is invalid.");
}

export function validateSandboxPort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === 5739)
    throw new Error(
      "Sandbox installs require a spare port between 1024 and 65535, excluding 5739.",
    );
}

// NSIS runs this with its private bootstrap Node before extracting to INSTDIR.
if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  const { values } = NodeUtil.parseArgs({
    options: {
      runtime: { type: "string" },
      port: { type: "string" },
      uninstall: { type: "boolean" },
    },
  });
  validateSandboxEnvironment(process.env.AXIS_SANDBOX_ROOT, values.runtime);
  if (!values.uninstall) validateSandboxPort(values.port);
}
