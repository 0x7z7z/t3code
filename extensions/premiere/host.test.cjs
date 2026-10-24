"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { readFileSync } = fs;
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

async function panelFixture() {
  const elements = new Map();
  const listeners = new Map();
  const evaluations = [];
  const messages = [];
  const timers = new Map();
  let timerId = 0;
  const contentWindow = { postMessage: (packet, origin) => messages.push({ packet, origin }) };
  const document = {
    getElementById: (id) => {
      if (!elements.has(id))
        elements.set(id, { hidden: false, setAttribute() {}, addEventListener() {} });
      return elements.get(id);
    },
  };
  document.getElementById("workspace").contentWindow = contentWindow;
  const settings = { backendUrl: "http://127.0.0.1:5749/" };
  const runtime = {
    validateConfig: (value) => value,
    probeBackend: async () => {},
    pairBackend: async () => settings.backendUrl + "premiere.html",
  };
  const window = {
    addEventListener: (name, callback) => listeners.set(name, callback),
    __adobe_cep__: {
      evalScript: (script, callback) => evaluations.push({ script, callback }),
    },
  };
  const context = vm.createContext({
    document,
    window,
    location: { pathname: "/D:/fixture/index.html" },
    URL,
    Promise,
    require: (name) =>
      name === "path"
        ? path
        : name === "fs"
          ? {
              ...fs,
              readFileSync: (filename, encoding) =>
                filename.endsWith("config.json")
                  ? JSON.stringify(settings)
                  : fs.readFileSync(filename, encoding),
            }
          : name === "os"
            ? os
            : runtime,
    setInterval: () => 1,
    clearInterval() {},
    setTimeout: (callback, delay) => {
      timers.set(++timerId, { callback, delay });
      return timerId;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(readFileSync(path.join(__dirname, "host.js"), "utf8"), context);
  await new Promise(setImmediate);
  return {
    elements,
    listeners,
    evaluations,
    messages,
    contentWindow,
    runTimers: (delay) => {
      for (const [id, timer] of [...timers])
        if (timer.delay === delay) {
          timers.delete(id);
          timer.callback();
        }
    },
    send: (data, overrides = {}) =>
      listeners.get("message")({
        source: contentWindow,
        origin: "http://127.0.0.1:5749",
        data: { protocol: 1, ...data },
        ...overrides,
      }),
  };
}

test("reads the actual host scope, including reserved characters and a zero playhead", async () => {
  const fixture = await panelFixture();
  const scope = vm.runInNewContext(fixture.evaluations[0].script, {
    app: {
      project: {
        name: "Project | one",
        path: "D:/cuts/project one.prproj",
        documentID: "document-a",
        activeSequence: {
          name: "Opening | cut",
          sequenceID: "sequence-a",
          timebase: "8475667200",
          getPlayerPosition: () => ({ seconds: 0 }),
        },
      },
    },
  });
  const fields = scope.slice("premiere:".length).split("|").map(decodeURIComponent);
  assert.equal(fields[0], "Project | one");
  assert.equal(fields[3], "Opening | cut");
  assert.equal(fields[6], "0");
});

test("coalesces context reads without dropping simultaneous send requests", async () => {
  const fixture = await panelFixture();
  const send = (requestId, origin = "http://127.0.0.1:5749") =>
    fixture.listeners.get("message")({
      source: fixture.contentWindow,
      origin,
      data: { type: "premiere.context.request", protocol: 1, requestId },
    });
  send("ignored", "http://127.0.0.1:3773");
  send("first");
  send("second");
  assert.equal(fixture.evaluations.length, 1);
  fixture.evaluations[0].callback(
    "premiere:Project|D%3A%2Fcut.prproj|document-a|Sequence|sequence-a|29.97|0",
  );
  assert.deepEqual(
    fixture.messages.map((message) => message.packet.requestId),
    ["first", "second"],
  );
  assert.ok(fixture.messages.every((message) => message.origin === "http://127.0.0.1:5749"));
  assert.equal(fixture.messages[0].packet.context.sequenceId, "sequence-a");
});

test("clears host context when Premiere has no active sequence", async () => {
  const fixture = await panelFixture();
  fixture.listeners.get("message")({
    source: fixture.contentWindow,
    origin: "http://127.0.0.1:5749",
    data: { type: "premiere.context.request", protocol: 1, requestId: "no-sequence" },
  });
  fixture.evaluations[0].callback("premiere:none");
  assert.equal(fixture.messages[0].packet.context, null);
  assert.equal(fixture.elements.get("project").textContent, "Axis");
});

test("moves the playhead to a whole frame only in the sequence the chat refers to", async () => {
  const fixture = await panelFixture();
  const seek = (data) =>
    fixture.listeners.get("message")({
      source: fixture.contentWindow,
      origin: "http://127.0.0.1:5749",
      data: { type: "premiere.seek", protocol: 1, ...data },
    });
  const before = fixture.evaluations.length;
  seek({ seconds: -1, sequenceId: "sequence-a" });
  seek({ seconds: "10", sequenceId: "sequence-a" });
  assert.equal(fixture.evaluations.length, before);
  seek({ seconds: 1.01, sequenceId: 'sequence-"a' });
  assert.equal(fixture.evaluations.length, before + 1);
  const run = (sequenceID) => {
    const positions = [];
    const result = vm.runInNewContext(fixture.evaluations.at(-1).script, {
      app: {
        project: {
          activeSequence: {
            sequenceID,
            timebase: "8475667200",
            setPlayerPosition: (ticks) => positions.push(ticks),
          },
        },
      },
    });
    return { result, positions };
  };
  // 1.01 s at 29.97 fps rounds to frame 30.
  assert.deepEqual(run('sequence-"a'), { result: "premiere:ok", positions: ["254270016000"] });
  assert.deepEqual(run("sequence-b"), { result: "premiere:mismatch", positions: [] });
});

test("reads selected video/audio clips, bounded strings, and sequence in/out without JSON", async () => {
  const fixture = await panelFixture();
  const clips = Array.from({ length: 51 }, (_, i) => ({
    nodeId: String(i),
    name: i ? "A|B\n%" : "x".repeat(600),
    start: { seconds: i },
    end: { seconds: i + 1 },
    inPoint: { seconds: 2 },
    outPoint: { seconds: 3 },
    projectItem: { name: "Media", getMediaPath: () => "D:/a|b\nfile.mov" },
  }));
  const raw = vm.runInNewContext(fixture.evaluations[0].script, {
    JSON: undefined,
    app: {
      project: {
        name: "Project",
        path: "D:/cut.prproj",
        activeSequence: {
          name: "Sequence",
          sequenceID: "seq",
          timebase: "8467200000",
          getPlayerPosition: () => ({ seconds: 0 }),
          getSelection: () => clips,
          getInPointAsTime: () => ({ seconds: 0 }),
          getOutPointAsTime: () => ({ seconds: 12 }),
          videoTracks: { numTracks: 1, 0: { clips: { numItems: 1, 0: clips[0] } } },
          audioTracks: {
            numTracks: 1,
            0: { clips: Object.assign({ numItems: 50 }, clips.slice(1)) },
          },
        },
      },
    },
  });
  fixture.send({ type: "premiere.context.request", requestId: "selection" });
  fixture.evaluations[0].callback(raw);
  const context = fixture.messages[0].packet.context;
  assert.equal(context.selection.length, 50);
  assert.equal(context.selection[0].name.length, 512);
  assert.equal(context.selection[0].trackType, "V");
  assert.equal(context.selection[1].trackType, "A");
  assert.equal(context.selection[1].name, "A|B\n%");
  assert.equal(context.selection[1].mediaPath, "D:/a|b\nfile.mov");
  assert.equal(context.inPointSeconds, 0);
  assert.equal(context.outPointSeconds, 12);
});

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aG1cAAAAASUVORK5CYII=",
  "base64",
);

function runExport(fixture, { noSequence = false, fallback = false, throws = false } = {}) {
  let filename;
  const calls = [];
  const raw = vm.runInNewContext(fixture.evaluations.at(-1).script, {
    app: {
      enableQE: () => calls.push("enableQE"),
      project: {
        activeSequence: noSequence
          ? null
          : {
              name: 'Cut / "one"',
              getPlayerPosition: () => ({ getFormatted: () => "00:00:02:12" }),
              getSettings: () => ({ videoFrameRate: {} }),
              videoDisplayFormat: 102,
            },
      },
    },
    qe: {
      project: {
        getActiveSequence: () => ({
          CTI: fallback ? null : { timecode: "00:00:01:04" },
          exportFramePNG: (timecode, target) => {
            filename = target;
            calls.push(timecode);
            if (throws) throw new Error("Export unavailable");
          },
        }),
      },
    },
  });
  fixture.evaluations.at(-1).callback(raw);
  return { filename, calls };
}

test("exports a playhead frame, waits for a complete stable PNG, and deletes its temp directory", async () => {
  const fixture = await panelFixture();
  fixture.send({ type: "premiere.frame.request", requestId: "frame-1" });
  const { filename, calls } = runExport(fixture);
  try {
    assert.deepEqual(calls, ["enableQE", "00:00:01:04"]);
    fixture.runTimers(150);
    assert.equal(fixture.messages.length, 0);
    fs.writeFileSync(filename, png.subarray(0, 24));
    fixture.runTimers(150);
    fixture.runTimers(150);
    fixture.runTimers(150);
    assert.equal(fixture.messages.length, 0);
    fs.writeFileSync(filename, png);
    fixture.runTimers(150);
    fixture.runTimers(150);
    assert.equal(fixture.messages.length, 0);
    fixture.runTimers(150);
    const { packet, origin } = fixture.messages[0];
    assert.equal(packet.requestId, "frame-1");
    assert.equal(packet.ok, true);
    assert.equal(packet.mimeType, "image/png");
    assert.equal(packet.dataUrl, "data:image/png;base64," + png.toString("base64"));
    assert.match(packet.name, /^frame-Cut.*00-00-01-04\.png$/);
    assert.equal(origin, "http://127.0.0.1:5749");
    assert.equal(fs.existsSync(path.dirname(filename)), false);
  } finally {
    fixture.runTimers(8000);
  }
});

test("times out an asynchronous frame export and removes its private directory", async () => {
  const fixture = await panelFixture();
  fixture.send({ type: "premiere.frame.request", requestId: "timeout" });
  const { filename } = runExport(fixture);
  fixture.runTimers(8000);
  assert.equal(fixture.messages[0].packet.ok, false);
  assert.match(fixture.messages[0].packet.error, /did not finish/);
  assert.equal(fs.existsSync(path.dirname(filename)), false);
  fixture.runTimers(150);
  assert.equal(fixture.messages.length, 1);
});

test("reports no active sequence and ExtendScript export failures", async () => {
  for (const options of [{ noSequence: true }, { throws: true }]) {
    const fixture = await panelFixture();
    fixture.send({ type: "premiere.frame.request", requestId: "failure" });
    runExport(fixture, options);
    assert.equal(fixture.messages[0].packet.ok, false);
    assert.match(
      fixture.messages[0].packet.error,
      options.noSequence ? /Open a sequence/ : /Export unavailable/,
    );
  }
});

test("uses the sequence display format when QE has no timecode and rejects oversized frames", async () => {
  const fixture = await panelFixture();
  fixture.send({ type: "premiere.frame.request", requestId: "large" });
  const { filename, calls } = runExport(fixture, { fallback: true });
  try {
    assert.deepEqual(calls, ["enableQE", "00:00:02:12"]);
    fs.writeFileSync(filename, Buffer.alloc(10 * 1024 * 1024 + 1));
    fixture.runTimers(150);
    assert.equal(fixture.messages[0].packet.ok, false);
    assert.match(fixture.messages[0].packet.error, /larger than 10 MB/);
    assert.equal(fs.existsSync(path.dirname(filename)), false);
  } finally {
    fixture.runTimers(8000);
  }
});

test("ignores invalid frame requests and untrusted frames or origins", async () => {
  const fixture = await panelFixture();
  for (const requestId of [null, 1, "", "x".repeat(129)])
    fixture.send({ type: "premiere.frame.request", requestId });
  fixture.send(
    { type: "premiere.frame.request", requestId: "wrong-origin" },
    { origin: "https://example.com" },
  );
  fixture.send({ type: "premiere.frame.request", requestId: "wrong-source" }, { source: {} });
  assert.equal(fixture.evaluations.length, 1);
  assert.equal(fixture.messages.length, 0);
});
