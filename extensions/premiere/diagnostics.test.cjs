"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { transcriptionStatus } = require("./diagnostics.cjs");

test("clean Windows with no Python or WhisperX reports optional setup instead of throwing", async () => {
  assert.deepEqual(await transcriptionStatus(async () => null), {
    version: null,
    path: null,
    whisperx: false,
  });
});

test("ignores Store aliases and detects a Python path containing spaces and unicode", async () => {
  const calls = [];
  const status = await transcriptionStatus(async (command, args) => {
    calls.push({ command, args });
    return command === "py"
      ? "not Python"
      : JSON.stringify({
          version: "3.12.9",
          path: "C:/Users/Zoë Editor/python.exe",
          whisperx: true,
        });
  });
  assert.equal(status.whisperx, true);
  assert.equal(status.path, "C:/Users/Zoë Editor/python.exe");
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.args.includes("-c")));
});
