"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function fixture({
  settings = { bridgePath: "D:/private/axis-bridge" },
  failStart = false,
  separateNode = false,
} = {}) {
  const listeners = new Map();
  const calls = [];
  const evaluations = [];
  let options;
  let failing = failStart;
  const window = {
    addEventListener: (name, callback) => listeners.set(name, callback),
    __adobe_cep__: { evalScript: (script, callback) => evaluations.push({ script, callback }) },
  };
  const nodeRequire = (name) => {
    if (name === "path") return path;
    if (name === "fs")
      return {
        readFileSync: (file) => {
          calls.push(["read", file]);
          return JSON.stringify(settings);
        },
      };
    assert.equal(name, path.join("D:/Axis Extension", "command-bridge.cjs"));
    return {
      createCommandBridge: (value) => {
        options = value;
        return {
          start: () => {
            calls.push(["start", value.bridgePath]);
            if (failing) throw new Error("unsafe bridge directory");
            value.onStatus({ state: "running", message: "Bridge running" });
          },
          stop: () => calls.push(["stop"]),
        };
      },
    };
  };
  if (separateNode) window.cep_node = { require: nodeRequire };
  vm.runInNewContext(readFileSync(path.join(__dirname, "bridge.js"), "utf8"), {
    window,
    location: { pathname: "/D:/Axis%20Extension/headless.html" },
    ...(separateNode ? {} : { require: nodeRequire }),
  });
  return {
    window,
    calls,
    listeners,
    evaluations,
    options: () => options,
    recover: () => {
      failing = false;
    },
  };
}

test("bridge bootstrap reads config.bridgePath, automatically starts and forwards CEP callbacks", () => {
  const f = fixture();
  assert.deepEqual(f.calls, [
    ["read", path.join("D:/Axis Extension", "config.json")],
    ["start", "D:/private/axis-bridge"],
  ]);
  const updates = [];
  f.window.AxisPremiereBridge.subscribe((value) => updates.push(value));
  assert.equal(updates[0].state, "running");
  f.options().onStatus({ state: "standby", message: "Bridge active in another Axis instance" });
  assert.equal(updates.at(-1).state, "standby");
  let result;
  f.options().evalScript("mcpBridgePing()", (value) => {
    result = value;
  });
  assert.equal(f.evaluations[0].script, "mcpBridgePing()");
  f.evaluations[0].callback("pong");
  assert.equal(result, "pong");
  f.window.AxisPremiereBridge.retry();
  assert.equal(f.calls.filter(([name]) => name === "start").length, 1);
  f.listeners.get("unload")();
  assert.equal(f.calls.at(-1)[0], "stop");
});

test("bridge bootstrap supports CEP's separate Node context", () => {
  const f = fixture({ separateNode: true });
  assert.equal(f.calls.at(-1)[0], "start");
});

test("bridge startup errors are observable and retry can recover", () => {
  const f = fixture({ failStart: true });
  const updates = [];
  f.window.AxisPremiereBridge.subscribe((value) => updates.push(value));
  assert.equal(updates[0].state, "error");
  assert.match(updates[0].message, /unsafe bridge directory/);
  f.recover();
  f.window.AxisPremiereBridge.retry();
  assert.equal(updates.at(-1).state, "running");
});

test("visible panel keeps bridge errors in its status line across backend connection updates", async () => {
  const elements = new Map();
  const document = {
    getElementById: (id) => {
      if (!elements.has(id))
        elements.set(id, {
          setAttribute(name, value) {
            this[name] = value;
          },
          addEventListener() {},
        });
      return elements.get(id);
    },
  };
  let update;
  const listeners = new Map();
  const runtime = {
    validateConfig: (value) => value,
    probeBackend: async () => {},
    ensureBackend: async () => {},
    pairBackend: async () => "http://127.0.0.1:5749/premiere.html",
  };
  vm.runInNewContext(readFileSync(path.join(__dirname, "host.js"), "utf8"), {
    document,
    window: {
      AxisPremiereBridge: {
        subscribe: (callback) => {
          update = callback;
          callback({ state: "error", message: "Bridge: unsafe ACL" });
        },
        retry() {},
      },
      addEventListener: (name, callback) => listeners.set(name, callback),
    },
    location: { pathname: "/D:/fixture/index.html" },
    URL,
    require: (name) =>
      name === "path"
        ? path
        : name === "fs"
          ? { readFileSync: () => '{"backendUrl":"http://127.0.0.1:5749/"}' }
          : runtime,
    setInterval: () => 1,
    clearInterval() {},
    setTimeout,
    clearTimeout,
  });
  await new Promise(setImmediate);
  const connection = elements.get("connection");
  assert.equal(connection["data-state"], "error");
  assert.equal(connection.textContent, "Bridge needs attention");
  assert.match(connection.title, /unsafe ACL/);
  update({ state: "running", message: "Bridge running" });
  listeners.get("message")({
    source: elements.get("workspace").contentWindow,
    origin: "http://127.0.0.1:5749",
    data: { type: "premiere.ready", protocol: 1 },
  });
  assert.equal(connection["data-state"], "ready");
  assert.match(connection.textContent, /Connected.*Bridge running/);
});
