import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

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

export function validateSandboxPaths(root, targets, protectedPaths) {
  if (!NodePath.isAbsolute(root)) throw new Error("Sandbox root must be absolute.");
  const sandbox = canonical(root);
  const protectedDirectories = protectedPaths.map(canonical);
  for (const [name, target] of Object.entries({ root, ...targets })) {
    if (!target || !NodePath.isAbsolute(target))
      throw new Error(`Sandbox ${name} must be an explicit absolute path.`);
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
}
