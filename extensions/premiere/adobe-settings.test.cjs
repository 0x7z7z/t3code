"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");

test("captures CSXS.9 through .12 and restores only values still owned by Axis", async () => {
  const { captureAdobeSettings, restoreAdobeSettings } =
    await import("../../scripts/axis-adobe-settings.mjs");
  const captured = captureAdobeSettings(() => ({ status: 1, stdout: "" }));
  assert.deepEqual(
    captured.map((entry) => entry.version),
    [9, 10, 11, 12],
  );
  const mutations = [];
  restoreAdobeSettings(captured, (args) => {
    if (args[0] === "query")
      return {
        status: 0,
        stdout: args.includes("/v")
          ? `PlayerDebugMode REG_SZ ${args[1].endsWith(".12") ? "0" : "1"}`
          : args[1],
      };
    mutations.push(args);
    return { status: 0 };
  });
  assert.equal(mutations.length, 6);
  assert.ok(mutations.every((args) => !args[1].endsWith(".12")));
  assert.ok(mutations.every((args) => args[0] === "delete"));
});
