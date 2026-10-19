import { describe, expect, it } from "vite-plus/test";

import { needsConsoleStdin } from "./consoleStdin.ts";

const launcher = {
  platform: "win32" as const,
  env: { T3CODE_DESKTOP_CLI_LAUNCHER: "1" },
  stdinOpen: false,
  stdoutIsConsole: true,
};

describe("needsConsoleStdin", () => {
  it("reopens the console for the desktop launcher in a terminal without stdin", () => {
    expect(needsConsoleStdin(launcher)).toBe(true);
  });

  it("leaves every other way of running the CLI alone", () => {
    for (const other of [
      { ...launcher, stdinOpen: true },
      { ...launcher, stdoutIsConsole: false },
      { ...launcher, env: { ELECTRON_RUN_AS_NODE: "1", T3CODE_CLI_PATH: "C:\\t3.cmd" } },
      { ...launcher, env: {} },
      { ...launcher, platform: "linux" as const },
      { ...launcher, platform: "darwin" as const },
    ]) {
      expect(needsConsoleStdin(other)).toBe(false);
    }
  });
});
