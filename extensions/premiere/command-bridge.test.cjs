"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createCommandBridge } = require("./command-bridge.cjs");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(__dirname, ".bridge-test-"));
  const bridges = [];
  const intervals = new Map();
  let now = 10000;
  let nextTimer = 0;
  t.after(() => {
    bridges.forEach((bridge) => bridge.stop());
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const clock = {
    now: () => now,
    setInterval: (callback, ms) => {
      const id = ++nextTimer;
      intervals.set(id, { callback, ms });
      return id;
    },
    clearInterval: (id) => intervals.delete(id),
  };
  const evaluations = [];
  const events = [];
  const create = (engineId = "panel", overrides = {}) => {
    const bridge = createCommandBridge({
      bridgePath: directory,
      engineId,
      clock,
      security: { ensurePrivateBridgeDirectory: (value) => value },
      evalScript: (script, callback) => evaluations.push({ script, callback, engineId }),
      onStatus: (event) => events.push({ ...event, engineId }),
      ...overrides,
    });
    bridges.push(bridge);
    return bridge;
  };
  return {
    directory,
    evaluations,
    events,
    intervals,
    create,
    write: (name, value) => fs.writeFileSync(path.join(directory, name), value),
    read: (name) => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")),
    names: () => fs.readdirSync(directory),
    advance: (ms) => {
      now += ms;
    },
    tick: (ms) =>
      [...intervals.values()]
        .filter((entry) => entry.ms === ms)
        .forEach((entry) => entry.callback()),
  };
}

test("claims only complete cmd_*.jsx files in lexical order and dispatches one at a time", (t) => {
  const f = fixture(t);
  f.write("cmd_b.jsx", "second()");
  f.write("cmd_a.jsx", "first()");
  f.write("cmd_c.jsx.staged", "incomplete");
  f.write("cmd_d.jsx.other.claimed", "already claimed");
  f.write("other.jsx", "ignored");
  const renames = [];
  const files = Object.create(fs);
  files.renameSync = (from, to) => {
    renames.push([path.basename(from), path.basename(to)]);
    fs.renameSync(from, to);
  };
  f.create("panel", { fs: files }).start();
  assert.deepEqual(
    f.evaluations.map((item) => item.script),
    ["first()"],
  );
  assert.ok(renames.some(([from, to]) => from === "cmd_a.jsx" && to === "cmd_a.jsx.panel.claimed"));
  assert.ok(
    renames.some(
      ([from, to]) =>
        from === "bridge-heartbeat.json.panel.staged" && to === "bridge-heartbeat.json",
    ),
  );
  assert.ok(!f.names().includes("cmd_a.jsx.panel.claimed"));
  f.tick(200);
  assert.equal(f.evaluations.length, 1);
  f.evaluations[0].callback('{"success":true,"data":17}');
  assert.deepEqual(f.read("res_a.json"), { success: true, data: 17 });
  assert.ok(renames.some(([from, to]) => from === "res_a.json.staged" && to === "res_a.json"));
  assert.deepEqual(
    f.evaluations.map((item) => item.script),
    ["first()", "second()"],
  );
  f.evaluations[1].callback("plain result");
  assert.deepEqual(f.read("res_b.json"), { success: true, data: "plain result" });
  assert.ok(f.names().includes("cmd_c.jsx.staged"));
  assert.ok(f.names().includes("cmd_d.jsx.other.claimed"));
  assert.ok(!f.names().some((name) => name.startsWith("res_") && name.endsWith(".staged")));
});

test("mirrors JSON, raw error and empty evalScript response semantics", (t) => {
  const f = fixture(t);
  const bridge = f.create();
  bridge.start();
  const results = [
    ['{"success":false,"error":"host rejected"}', { success: false, error: "host rejected" }],
    ["Error: host failed", { success: false, error: "Error: host failed" }],
    ["EvalScript error.", { success: false, error: "EvalScript error." }],
    ["hello", { success: true, data: "hello" }],
    ["42", 42],
    ["false", false],
  ];
  results.forEach(([result, expected], index) => {
    f.write("cmd_" + index + ".jsx", "run()");
    f.tick(200);
    f.evaluations.at(-1).callback(result);
    assert.deepEqual(f.read("res_" + index + ".json"), expected);
  });
  ["", "undefined", "null", undefined, null].forEach((result, index) => {
    f.write("cmd_empty" + index + ".jsx", "run()");
    f.tick(200);
    f.evaluations.at(-1).callback(result);
    const response = f.read("res_empty" + index + ".json");
    assert.equal(response.success, false);
    assert.match(response.error, /empty result from evalScript/);
  });
});

test("heartbeats each second, starts busy updates at two seconds and never retries a delayed edit", (t) => {
  const f = fixture(t);
  f.write("cmd_long.jsx", "longEdit()");
  const bridge = f.create();
  bridge.start();
  assert.deepEqual(f.read("bridge-heartbeat.json"), { protocolVersion: 1, state: "running" });
  assert.deepEqual(
    [...f.intervals.values()].map((entry) => entry.ms).sort((a, b) => a - b),
    [200, 1000, 2000],
  );
  assert.ok(!f.names().includes("busy_long.json"));
  f.advance(2000);
  f.tick(2000);
  assert.deepEqual(f.read("busy_long.json"), { id: "long", elapsedMs: 2000 });
  f.advance(120001);
  f.tick(1000);
  f.tick(2000);
  f.tick(200);
  assert.equal(f.evaluations.length, 1);
  assert.deepEqual(f.read("busy_long.json"), { id: "long", elapsedMs: 122001 });
  assert.equal(f.read("axis-bridge-owner.json").timestamp, 132001);
  f.evaluations[0].callback('{"success":true}');
  assert.ok(!f.names().includes("busy_long.json"));
  bridge.stop();
  assert.equal(f.intervals.size, 0);
  assert.deepEqual(f.read("bridge-heartbeat.json"), { protocolVersion: 1, state: "waiting" });
  assert.ok(!f.names().includes("axis-bridge-owner.json"));
});

test("only the Axis owner polls, and stopping a standby leaves the owner's heartbeat alone", (t) => {
  const f = fixture(t);
  const panel = f.create("panel");
  const headless = f.create("headless");
  panel.start();
  headless.start();
  assert.equal(f.read("axis-bridge-owner.json").ownerId, "panel");
  assert.ok(f.events.some((event) => event.state === "standby" && event.engineId === "headless"));
  f.write("cmd_once.jsx", "editOnce()");
  f.tick(200);
  assert.deepEqual(
    f.evaluations.map((item) => item.engineId),
    ["panel"],
  );
  headless.stop();
  assert.deepEqual(f.read("bridge-heartbeat.json"), { protocolVersion: 1, state: "running" });
  panel.stop();
  headless.start();
  assert.equal(f.read("axis-bridge-owner.json").ownerId, "headless");
});

test("a stale owner is replaced after five seconds and cannot release or refresh its successor's lease", (t) => {
  const f = fixture(t);
  const panel = f.create("panel");
  panel.start();
  f.advance(5000);
  const headless = f.create("headless");
  headless.start();
  assert.equal(f.read("axis-bridge-owner.json").ownerId, "panel");
  f.advance(1);
  // Run the standby heartbeat first to simulate an unresponsive panel context.
  [...f.intervals.values()]
    .filter((entry) => entry.ms === 1000)
    .at(-1)
    .callback();
  assert.equal(f.read("axis-bridge-owner.json").ownerId, "headless");
  f.tick(1000);
  f.write("cmd_handoff.jsx", "handoff()");
  f.tick(200);
  assert.deepEqual(
    f.evaluations.map((item) => item.engineId),
    ["headless"],
  );
  panel.stop();
  assert.equal(f.read("axis-bridge-owner.json").ownerId, "headless");
  assert.equal(f.read("bridge-heartbeat.json").state, "running");
});

test("an atomic command claim lost to another processor never dispatches", (t) => {
  const f = fixture(t);
  f.write("cmd_race.jsx", "onlyOnce()");
  const files = Object.create(fs);
  files.renameSync = (from, to) => {
    if (from.endsWith("cmd_race.jsx")) {
      fs.renameSync(from, from + ".legacy.claimed");
      const error = new Error("claimed by another processor");
      error.code = "ENOENT";
      throw error;
    }
    fs.renameSync(from, to);
  };
  f.create("panel", { fs: files }).start();
  assert.equal(f.evaluations.length, 0);
  assert.ok(f.names().includes("cmd_race.jsx.legacy.claimed"));
});

test("interrupted ownership files are reclaimable after their file age exceeds the lease", (t) => {
  const f = fixture(t);
  for (const raw of ["{", "null", "{}"]) {
    f.write("axis-bridge-owner.json", raw);
    fs.utimesSync(path.join(f.directory, "axis-bridge-owner.json"), 1, 1);
    const bridge = f.create();
    bridge.start();
    assert.equal(f.read("axis-bridge-owner.json").ownerId, "panel");
    bridge.stop();
  }
});

test("read and atomic response failures surface errors and clean up owned staging files", (t) => {
  const f = fixture(t);
  const files = Object.create(fs);
  files.renameSync = (from, to) => {
    if (to.endsWith("res_fail.json")) throw new Error("disk unavailable");
    fs.renameSync(from, to);
  };
  files.readFileSync = (file, encoding) => {
    if (typeof file === "string" && file.endsWith("cmd_unreadable.jsx.panel.claimed"))
      throw new Error("read denied");
    return fs.readFileSync(file, encoding);
  };
  f.write("cmd_unreadable.jsx", "unreadable()");
  f.create("panel", { fs: files }).start();
  assert.equal(f.evaluations.length, 0);
  assert.ok(!f.names().includes("cmd_unreadable.jsx.panel.claimed"));
  assert.ok(f.events.some((event) => /read denied/.test(event.message)));
  f.write("cmd_fail.jsx", "fail()");
  f.tick(200);
  f.evaluations[0].callback('{"success":true}');
  assert.ok(!f.names().includes("res_fail.json.staged"));
  assert.ok(!f.names().includes("res_fail.json"));
  assert.ok(f.events.some((event) => /disk unavailable/.test(event.message)));
});

test("synchronous dispatch failure produces an error response and allows the next command", (t) => {
  const f = fixture(t);
  f.write("cmd_throw.jsx", "throwing()");
  f.create("panel", {
    evalScript: () => {
      throw new Error("CEP unavailable");
    },
  }).start();
  assert.deepEqual(f.read("res_throw.json"), { success: false, error: "Error: CEP unavailable" });
  assert.ok(f.events.some((event) => /dispatch failed/.test(event.message)));
  assert.ok(!f.names().includes("busy_throw.json"));
});

test("stopping an in-flight bridge clears timers and a late callback does not dispatch queued edits", (t) => {
  const f = fixture(t);
  f.write("cmd_a.jsx", "first()");
  f.write("cmd_b.jsx", "second()");
  const bridge = f.create();
  bridge.start();
  f.advance(2000);
  f.tick(2000);
  bridge.stop();
  assert.equal(f.intervals.size, 0);
  assert.ok(!f.names().includes("busy_a.json"));
  f.evaluations[0].callback('{"success":true}');
  assert.equal(f.evaluations.length, 1);
  assert.ok(f.names().includes("cmd_b.jsx"));
  assert.deepEqual(f.read("res_a.json"), { success: true });
});

test("directory validation fails before creating timers, leases or executing commands", (t) => {
  const f = fixture(t);
  const bridge = f.create("panel", {
    security: {
      ensurePrivateBridgeDirectory: () => {
        throw new Error("unsafe ACL");
      },
    },
  });
  assert.throws(() => bridge.start(), /unsafe ACL/);
  assert.equal(f.intervals.size, 0);
  assert.deepEqual(f.names(), []);
  assert.equal(f.evaluations.length, 0);
});
