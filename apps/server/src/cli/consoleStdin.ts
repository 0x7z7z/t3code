// @effect-diagnostics nodeBuiltinImport:off - Runs before the Effect runtime starts, on raw file descriptors.
import * as NodeFS from "node:fs";
import * as NodeTty from "node:tty";

import * as HostProcess from "@t3tools/shared/HostProcess";

/**
 * Electron's Windows GUI executable leaves stdin unset under ELECTRON_RUN_AS_NODE.
 * Reopen console input only for the launcher; preserve redirected input and non-console output.
 */
export function needsConsoleStdin(input: {
  readonly platform: NodeJS.Platform;
  readonly env: NodeJS.ProcessEnv;
  readonly stdinOpen: boolean;
  readonly stdoutIsConsole: boolean;
}): boolean {
  return (
    input.platform === "win32" &&
    // Set only by the launcher (DesktopCliShim), never for the desktop backend.
    input.env.T3CODE_DESKTOP_CLI_LAUNCHER === "1" &&
    !input.stdinOpen &&
    input.stdoutIsConsole
  );
}

const isOpen = (fd: number) => {
  try {
    NodeFS.fstatSync(fd);
    return true;
  } catch {
    return false;
  }
};

/**
 * Call before anything reads `process.stdin`. Returns the reopened console descriptor
 * for interactive children, or undefined without changing stdin.
 */
export function attachConsoleStdin(): number | undefined {
  const needed = needsConsoleStdin({
    platform: HostProcess.Platform.defaultValue(),
    env: process.env,
    stdinOpen: isOpen(0),
    stdoutIsConsole: NodeTty.isatty(1),
  });
  // The marker describes this process's own start; a server started here
  // must not pass it on to the shells and `t3` runs it spawns.
  delete process.env.T3CODE_DESKTOP_CLI_LAUNCHER;
  if (!needed) return undefined;
  let fd: number;
  try {
    fd = NodeFS.openSync("\\\\.\\CONIN$", "r+");
  } catch {
    return undefined;
  }
  if (!NodeTty.isatty(fd)) {
    NodeFS.closeSync(fd);
    return undefined;
  }
  const stdin = new NodeTty.ReadStream(fd);
  Object.defineProperty(process, "stdin", { value: stdin, configurable: true, enumerable: true });
  consoleStdinFd = fd;
  return fd;
}

let consoleStdinFd: number | undefined;

export const interactiveStdin = (): number | "inherit" => consoleStdinFd ?? "inherit";
