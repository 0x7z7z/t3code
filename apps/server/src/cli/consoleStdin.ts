// @effect-diagnostics nodeBuiltinImport:off - Runs before the Effect runtime starts, on raw file descriptors.
import * as NodeFS from "node:fs";
import * as NodeTty from "node:tty";

import * as HostProcess from "@t3tools/shared/HostProcess";

/**
 * Whether this process is the desktop app's `t3.cmd` running the CLI in a
 * terminal with no stdin. The launcher runs the app's executable with
 * `ELECTRON_RUN_AS_NODE`, and Electron's Windows executable is a GUI program:
 * on start it points stdout and stderr at the parent's console but leaves
 * stdin unset, so prompts see no terminal and children such as the agent
 * `t3 triage` starts inherit nothing to read from. Input the user piped or
 * redirected is a valid descriptor and is left alone, as is any run whose
 * output is not a console (the desktop backend, scripts).
 */
function needsConsoleStdin(input: {
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

/** Call before reading process.stdin. Returns the reopened fd for children, or undefined without changing stdin. */
export function attachConsoleStdin(): number | undefined {
  const needed = needsConsoleStdin({
    platform: HostProcess.Platform.defaultValue(),
    env: process.env,
    stdinOpen: isOpen(0),
    stdoutIsConsole: NodeTty.isatty(1),
  });
  // The launcher marker must not propagate to child shells or t3 processes.
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
