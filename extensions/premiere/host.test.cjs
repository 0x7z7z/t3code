"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { readFileSync } = fs;
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { parse } = require(
  require.resolve("acorn", { paths: [path.join(__dirname, "../../apps/desktop")] }),
);

async function panelFixture(settingsOverride = {}) {
  const elements = new Map();
  const listeners = new Map();
  const evaluations = [];
  const messages = [];
  const timers = new Map();
  const intervals = new Map();
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
  const settings = { backendUrl: "http://127.0.0.1:5749/", ...settingsOverride };
  const runtime = {
    validateConfig: (value) => value,
    probeBackend: async () => {},
    ensureBackend: async () => {},
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
            : name.endsWith("transcript-handoff.cjs")
              ? require("./transcript-handoff.cjs")
              : runtime,
    setInterval: (callback, delay) => {
      intervals.set(++timerId, { callback, delay });
      return timerId;
    },
    clearInterval: (id) => intervals.delete(id),
    setTimeout: (callback, delay) => {
      timers.set(++timerId, { callback, delay });
      return timerId;
    },
    clearTimeout: (id) => timers.delete(id),
  });
  vm.runInContext(readFileSync(path.join(__dirname, "snapshot.js"), "utf8"), context);
  vm.runInContext(readFileSync(path.join(__dirname, "host.js"), "utf8"), context);
  await new Promise(setImmediate);
  return {
    elements,
    listeners,
    evaluations,
    messages,
    contentWindow,
    timelineOperation: window.AxisTimeline.operation,
    runIntervals: (delay) => {
      for (const timer of intervals.values()) if (timer.delay === delay) timer.callback();
    },
    setEvalScript: (callback) => {
      window.__adobe_cep__.evalScript = callback;
    },
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

test("scripts sent to Premiere for timeline actions parse as ES3", async () => {
  const f = await panelFixture();
  const requests = [
    { type: "premiere.clips.request", sequenceId: "seq-1" },
    { type: "premiere.select", sequenceId: "seq-1", nodeId: "clip-1" },
    { type: "premiere.markers.add", sequenceId: "seq-1", markers: [{ time: 0, name: "Test" }] },
    { type: "premiere.seek", sequenceId: "seq-1", seconds: 1 },
    { type: "premiere.frame.request" },
    { type: "premiere.transcript.active", enabled: true },
  ];
  for (const request of requests) f.send({ requestId: "syntax", ...request });
  for (const { script } of f.evaluations)
    assert.doesNotThrow(() => parse(script, { ecmaVersion: 3 }));
});

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

test("publishes current scope for agent startup and clears it when the sequence closes", async () => {
  using directory = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "axis-host-context-"));
  const fixture = await panelFixture({ bridgePath: directory.path });
  fixture.evaluations[0].callback(
    "premiere:Project|D%3A%2Fcut.prproj|document-a|Opening|sequence-a|29.97|0",
  );
  const filename = path.join(directory.path, "axis-context.json");
  const snapshot = JSON.parse(fs.readFileSync(filename, "utf8"));
  assert.equal(snapshot.context.projectName, "Project");
  assert.equal(snapshot.context.sequenceName, "Opening");
  assert.equal(snapshot.context.sequenceId, "sequence-a");
  assert.equal(typeof snapshot.capturedAt, "number");
  assert.equal(fs.existsSync(filename + ".tmp"), false);
  fixture.send({ type: "premiere.context.request", requestId: "closed" });
  fixture.evaluations.at(-1).callback("premiere:none");
  assert.equal(JSON.parse(fs.readFileSync(filename, "utf8")).context, null);
});

test("streams lightweight playhead reads only while the transcript view is active", async () => {
  const f = await panelFixture();
  f.send({ type: "premiere.transcript.active", enabled: true }, { origin: "https://other.test" });
  assert.equal(f.evaluations.length, 1);
  f.send({ type: "premiere.transcript.active", enabled: true });
  const read = f.evaluations.at(-1);
  const raw = vm.runInNewContext(read.script, {
    app: {
      project: {
        documentID: "project|a",
        activeSequence: { sequenceID: "sequence-a", getPlayerPosition: () => ({ seconds: 4.25 }) },
      },
    },
    JSON: undefined,
  });
  read.callback(raw);
  assert.equal(f.messages.at(-1).packet.type, "premiere.playhead");
  assert.equal(f.messages.at(-1).packet.projectId, "project|a");
  assert.equal(f.messages.at(-1).packet.seconds, 4.25);
  f.send({ type: "premiere.transcript.active", enabled: false });
  const count = f.messages.length;
  read.callback(raw);
  assert.equal(f.messages.length, count);
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

test("orders both playhead feeds by evalScript issue order, including coalesced requests", async () => {
  const f = await panelFixture();
  const contextRead = f.evaluations[0];
  f.send({ type: "premiere.context.request", requestId: "first" });
  f.send({ type: "premiere.transcript.active", enabled: true });
  const playheadRead = f.evaluations.at(-1);
  f.send({ type: "premiere.context.request", requestId: "second" });
  playheadRead.callback("project-a|sequence-a|2");
  contextRead.callback("premiere:Project|D%3A%2Fcut.prproj|project-a|Sequence|sequence-a|29.97|1");
  const packets = f.messages.map(({ packet }) => packet);
  assert.equal(packets[0].readId, 2);
  assert.deepEqual(
    packets.slice(1).map((packet) => packet.playheadReadId),
    [1, 1],
  );
  f.send({ type: "premiere.context.request", requestId: "third" });
  f.evaluations
    .at(-1)
    .callback("premiere:Project|D%3A%2Fcut.prproj|project-a|Sequence|sequence-a|29.97|3");
  assert.equal(f.messages.at(-1).packet.playheadReadId, 3);
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

test("a dropped context callback cannot permanently stop polling or revive a stale sequence", async () => {
  const f = await panelFixture();
  const abandoned = f.evaluations[0];
  f.send({ type: "premiere.context.request", requestId: "sleeping" });
  f.runTimers(5000);
  assert.equal(f.messages.at(-1)?.packet.requestId, "sleeping");
  assert.equal(f.messages.at(-1).packet.context, null);
  f.send({ type: "premiere.context.request", requestId: "awake" });
  assert.equal(f.evaluations.length, 2);
  f.evaluations
    .at(-1)
    .callback("premiere:Project|D%3A%2Fcut.prproj|document-a|New|sequence-b|25|9");
  const count = f.messages.length;
  abandoned.callback("premiere:Project|D%3A%2Fcut.prproj|document-a|Old|sequence-a|25|0");
  assert.equal(f.messages.length, count);
  assert.equal(f.messages.at(-1).packet.context.sequenceId, "sequence-b");
});

test("a dropped fast playhead callback cannot permanently stop the transcript clock", async () => {
  const f = await panelFixture();
  f.send({ type: "premiere.transcript.active", enabled: true });
  const abandoned = f.evaluations.at(-1);
  f.runTimers(5000);
  f.runIntervals(100);
  const fresh = f.evaluations.at(-1);
  assert.notEqual(fresh, abandoned);
  fresh.callback("project-a|sequence-b|9");
  const count = f.messages.length;
  abandoned.callback("project-a|sequence-a|0");
  assert.equal(f.messages.length, count);
  assert.equal(f.messages.at(-1).packet.sequenceId, "sequence-b");
});

test("recovers context reads after a synchronous CEP dispatch failure", async () => {
  const f = await panelFixture();
  f.evaluations[0].callback("premiere:none");
  // CEP can throw while the host is sleeping or reconnecting.
  f.setEvalScript(() => {
    throw new Error("CEP asleep");
  });
  assert.doesNotThrow(() => f.send({ type: "premiere.context.request", requestId: "asleep" }));
  assert.equal(f.messages.at(-1).packet.context, null);
  assert.equal(f.messages.at(-1).packet.requestId, "asleep");
  f.setEvalScript((script, callback) => f.evaluations.push({ script, callback }));
  f.send({ type: "premiere.context.request", requestId: "awake" });
  f.evaluations
    .at(-1)
    .callback("premiere:Project|D%3A%2Fcut.prproj|document-a|Main|sequence-a|25|1");
  assert.equal(f.messages.at(-1).packet.requestId, "awake");
  assert.equal(f.messages.at(-1).packet.context.sequenceId, "sequence-a");
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
      JSON: undefined,
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
  // 1.01 s lies after frame 30, so the first boundary at or after it is frame 31.
  assert.deepEqual(run('sequence-"a'), { result: "premiere:ok", positions: ["262745683200"] });
  assert.deepEqual(run("sequence-b"), { result: "premiere:mismatch", positions: [] });
  for (const seconds of [(30 * 1001) / 30000, (30 * 1001) / 30000 + 0.0000005]) {
    seek({ seconds, sequenceId: 'sequence-"a' });
    assert.deepEqual(run('sequence-"a').positions, ["254270016000"]);
  }
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

function timelineFixture() {
  const selected = [];
  const calls = [];
  const makeClip = (name, nodeId, start) => ({
    name,
    nodeId,
    start: { seconds: start, ticks: String(start * 254016000000) },
    end: { seconds: start + 2 },
    setSelected: (value, update) => calls.push([nodeId, value, update]),
  });
  const video = makeClip("Hero | closeup.mov", "video-1", 1);
  const audio = makeClip("Sound.wav", "audio-1", 3);
  const created = [];
  const sequence = {
    sequenceID: "seq-1",
    end: String(100 * 254016000000),
    videoTracks: { numTracks: 1, 0: { clips: { numItems: 1, 0: video } } },
    audioTracks: { numTracks: 1, 0: { clips: { numItems: 1, 0: audio } } },
    getSelection: () => selected,
    setPlayerPosition: (ticks) => calls.push(["seek", ticks]),
    markers: {
      createMarker: (seconds) => {
        const marker = {
          seconds,
          setColorByIndex: (color) => {
            marker.color = color;
          },
        };
        created.push(marker);
        return marker;
      },
      deleteMarker: (marker) => {
        created.splice(created.indexOf(marker), 1);
      },
    },
  };
  return {
    sequence,
    video,
    audio,
    selected,
    calls,
    created,
    app: { project: { activeSequence: sequence } },
    JSON: undefined,
  };
}

function runTimeline(fixture, context) {
  const evaluation = fixture.evaluations.at(-1);
  const raw = vm.runInNewContext(evaluation.script, context);
  evaluation.callback(raw);
  return raw;
}

test("rejects timeline actions after switching to a project with the same sequence ID", async () => {
  for (const action of [
    { type: "premiere.clips.request" },
    { type: "premiere.select", nodeId: "video-1" },
    { type: "premiere.markers.add", markers: [{ time: 1, name: "Beat" }] },
  ]) {
    const f = await panelFixture();
    const host = timelineFixture();
    host.app.project.documentID = "other-project";
    f.send({
      ...action,
      requestId: "project-race",
      sequenceId: "seq-1",
      projectId: "original-project",
    });
    runTimeline(f, host);
    assert.equal(f.messages.at(-1).packet.ok, false);
    assert.match(f.messages.at(-1).packet.error, /project changed/i);
    assert.equal(host.calls.length, 0);
    assert.equal(host.created.length, 0);
  }
});

test("publishes a bounded clip index without native JSON and preserves encoded names", async () => {
  const fixture = await panelFixture();
  fixture.send({ type: "premiere.clips.request", requestId: "clips", sequenceId: "seq-1" });
  const context = timelineFixture();
  runTimeline(fixture, context);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.messages[0])), {
    origin: "http://127.0.0.1:5749",
    packet: {
      type: "premiere.clips",
      protocol: 1,
      requestId: "clips",
      sequenceId: "seq-1",
      ok: true,
      clips: [
        {
          name: "Hero | closeup.mov",
          nodeId: "video-1",
          trackType: "V",
          trackIndex: 0,
          start: 1,
          end: 3,
        },
        { name: "Sound.wav", nodeId: "audio-1", trackType: "A", trackIndex: 0, start: 3, end: 5 },
      ],
    },
  });
  const clips = { numItems: 2100 };
  for (let i = 0; i < 2100; i++) clips[i] = context.video;
  context.sequence.videoTracks[0].clips = clips;
  fixture.send({ type: "premiere.clips.request", requestId: "bounded", sequenceId: "seq-1" });
  runTimeline(fixture, context);
  assert.equal(fixture.messages.at(-1).packet.clips.length, 2000);
});

test("selects by node or track/start, deselects other clips, and seeks the current clip start", async () => {
  for (const locator of [{ nodeId: "audio-1" }, { trackType: "A", trackIndex: 0, start: 3 }]) {
    const fixture = await panelFixture();
    const context = timelineFixture();
    context.selected.push(context.video);
    fixture.send({ type: "premiere.select", requestId: "select", sequenceId: "seq-1", ...locator });
    runTimeline(fixture, context);
    assert.deepEqual(context.calls, [
      ["video-1", false, true],
      ["audio-1", true, true],
      ["seek", String(3 * 254016000000)],
    ]);
    assert.equal(fixture.messages[0].packet.ok, true);
  }
});

test("fails stale or missing clip selection without changing selection", async () => {
  for (const request of [
    { sequenceId: "old", nodeId: "video-1" },
    { sequenceId: "seq-1", nodeId: "missing" },
  ]) {
    const fixture = await panelFixture();
    const context = timelineFixture();
    fixture.send({ type: "premiere.select", requestId: "select", ...request });
    runTimeline(fixture, context);
    assert.equal(fixture.messages[0].packet.ok, false);
    assert.equal(context.calls.length, 0);
  }
});

test("creates marker batches with connector colors and seconds-based durations without JSON", async () => {
  const fixture = await panelFixture();
  const context = timelineFixture();
  const colors = {
    green: 0,
    red: 1,
    purple: 2,
    magenta: 2,
    orange: 3,
    yellow: 4,
    blue: 6,
    cyan: 7,
  };
  const markers = Object.keys(colors).map((color) => ({
    time: 4,
    duration: 1.5,
    name: 'Cut "quoted"',
    comment: "Line\nTwo | \\ end",
    color,
  }));
  fixture.send({
    type: "premiere.markers.add",
    requestId: "markers",
    sequenceId: "seq-1",
    markers,
  });
  runTimeline(fixture, context);
  assert.equal(fixture.messages[0].packet.ok, true);
  assert.equal(context.created.length, 8);
  for (const [i, color] of Object.keys(colors).entries()) {
    assert.equal(context.created[i].seconds, 4);
    assert.equal(context.created[i].end, 5.5);
    assert.equal(context.created[i].name, markers[i].name);
    assert.equal(context.created[i].comments, markers[i].comment);
    assert.equal(context.created[i].color, colors[color]);
  }
});

test("validates complete marker ranges before writing and rolls back failed batches", async () => {
  const fixture = await panelFixture();
  const context = timelineFixture();
  fixture.send({
    type: "premiere.markers.add",
    requestId: "range",
    sequenceId: "seq-1",
    markers: [
      { time: 4, name: "OK" },
      { time: 99, duration: 2, name: "Too long" },
    ],
  });
  runTimeline(fixture, context);
  assert.equal(context.created.length, 0);
  assert.match(fixture.messages[0].packet.error, /beyond/);
  context.sequence.markers.createMarker = () => {
    const marker = {
      setColorByIndex: () => {
        throw new Error("Color failed");
      },
    };
    context.created.push(marker);
    return marker;
  };
  fixture.send({
    type: "premiere.markers.add",
    requestId: "rollback",
    sequenceId: "seq-1",
    markers: [{ time: 4, name: "Test", color: "red" }],
  });
  runTimeline(fixture, context);
  assert.equal(context.created.length, 0);
  assert.match(fixture.messages.at(-1).packet.error, /No markers were added/);
});

test("rejects malformed action payloads and ignores untrusted origins before evaluating", async () => {
  const fixture = await panelFixture();
  const before = fixture.evaluations.length;
  for (const markers of [
    [],
    Array.from({ length: 201 }, () => ({ time: 1, name: "x" })),
    [{ time: NaN, name: "x" }],
    [{ time: 1, name: "x", duration: -1 }],
    [{ time: 1, name: "x", color: "white" }],
    [{ time: 1, name: "x", comment: "x".repeat(2001) }],
  ])
    fixture.send({
      type: "premiere.markers.add",
      requestId: "invalid",
      sequenceId: "seq-1",
      markers,
    });
  fixture.send({ type: "premiere.select", requestId: "invalid", sequenceId: "seq-1", nodeId: 123 });
  fixture.send({ type: "premiere.clips.request", requestId: "invalid", sequenceId: 123 });
  fixture.send({ type: "premiere.clips.request", requestId: "x".repeat(129), sequenceId: "seq-1" });
  fixture.send(
    {
      type: "premiere.markers.add",
      requestId: "evil",
      sequenceId: "seq-1",
      markers: [{ time: 1, name: "x" }],
    },
    { origin: "https://evil.example" },
  );
  fixture.send(
    { type: "premiere.select", requestId: "evil", sequenceId: "seq-1", nodeId: "video-1" },
    { source: {} },
  );
  assert.equal(fixture.evaluations.length, before);
  assert.equal(fixture.messages.length, 8);
  assert.ok(fixture.messages.every(({ packet }) => packet.ok === false));
});

test("snapshot and restore replies are correlated and only sent to the trusted iframe origin", async () => {
  const f = await panelFixture();
  const send = (data, origin = "http://127.0.0.1:5749", source = f.contentWindow) =>
    f.listeners.get("message")({ source, origin, data: { protocol: 1, ...data } });
  const before = f.evaluations.length;
  const request = { type: "premiere.snapshot.request", requestId: "snapshot", checkpoint: true };
  send(request, "https://untrusted.test");
  send(request, "http://127.0.0.1:5749", {});
  send({ ...request, protocol: 2 });
  send({ ...request, requestId: "" });
  assert.equal(f.evaluations.length, before);
  send(request);
  assert.equal(f.evaluations.length, before + 1);
  f.evaluations
    .at(-1)
    .callback('axis:{"ok":true,"snapshot":{},"signature":"snapshot","checkpointIds":[]}');
  assert.equal(f.messages[0].packet.type, "premiere.snapshot");
  assert.equal(f.messages[0].packet.requestId, "snapshot");
  assert.equal(f.messages[0].origin, "http://127.0.0.1:5749");
  send({
    type: "premiere.restore.request",
    requestId: "restore",
    checkpointId: "checkpoint",
    sequenceId: "sequence",
    expectedSignature: "snapshot",
    checkpointSignature: "checkpoint",
    turnNumber: 1,
  });
  f.evaluations.at(-1).callback('axis:{"ok":false,"error":"checkpoint gone"}');
  assert.equal(f.messages[1].packet.type, "premiere.restore");
  assert.equal(f.messages[1].packet.error, "checkpoint gone");
});

test("transcript host requests require the panel origin and read only the workspace handoff", async (t) => {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "axis-host-transcript-"));
  t.after(() => fs.rmSync(workspacePath, { recursive: true, force: true }));
  const f = await panelFixture({ workspacePath });
  const request = {
    type: "premiere.transcript.load.request",
    requestId: "load-1",
    jobId: "job-1",
    projectId: "film",
    sequenceId: "seq",
  };
  f.send(request, { origin: "https://other.test" });
  f.send(request, { source: {} });
  assert.equal(f.messages.length, 0);
  f.send(request);
  const result = f.messages.at(-1).packet;
  assert.equal(result.type, "premiere.transcript.load");
  assert.equal(result.requestId, "load-1");
  assert.equal(result.ok, true);
  assert.equal(result.content, null);
  assert.ok(result.outputPath.startsWith(workspacePath + path.sep));
  fs.mkdirSync(path.dirname(result.outputPath), { recursive: true });
  fs.writeFileSync(
    result.outputPath,
    JSON.stringify({
      version: 1,
      requestId: "job-1",
      projectId: "film",
      sequenceId: "seq",
      status: "failed",
      error: "Source offline",
    }),
  );
  f.send(request);
  assert.equal(f.messages.at(-1).packet.error, "Source offline");
  f.send({ ...request, jobId: "../escape" });
  assert.equal(f.messages.at(-1).packet.ok, false);
});

function captionRequest(overrides = {}) {
  return {
    type: "premiere.captions.request",
    requestId: "captions",
    action: "add",
    confirmed: true,
    projectId: "project-a",
    sequenceId: "sequence-a",
    srt: "1\n00:00:12,000 --> 00:00:13,000\nHello\n",
    ...overrides,
  };
}

function captionHost(overrides = {}) {
  const writes = [];
  const imports = [];
  const placements = [];
  const removed = [];
  const bins = [];
  const root = {
    children: { numItems: 0 },
    createBin(name) {
      const bin = {
        name,
        nodeId: bins.length ? "bin-" + bins.length : "bin-a",
        type: 2,
        children: { numItems: 0 },
        deleteBin() {
          removed.push(this.nodeId);
          root.children = { numItems: 0 };
          return 0;
        },
      };
      root.children[root.children.numItems++] = bin;
      bins.push(bin);
      return bin;
    },
  };
  const sequence = {
    sequenceID: "sequence-a",
    name: "Main edit",
    projectItem: { nodeId: "sequence-item", moveBin() {} },
    videoTracks: { numTracks: 0 },
    audioTracks: { numTracks: 0 },
    markers: { getFirstMarker: () => null },
    getInPointAsTime: () => ({ seconds: 0 }),
    getOutPointAsTime: () => ({ seconds: 60 }),
    captions: ["Existing caption"],
    clone() {
      const clone = {
        ...this,
        sequenceID: "checkpoint-a",
        captions: [...this.captions],
        projectItem: { nodeId: "checkpoint-item", moveBin() {} },
      };
      project.sequences[project.sequences.numSequences++] = clone;
      return true;
    },
    createCaptionTrack(item, start, format) {
      placements.push({ item, start, format });
      this.captions.push("Hello");
      return true;
    },
    ...overrides.sequence,
  };
  const project = {
    documentID: "project-a",
    rootItem: root,
    activeSequence: sequence,
    sequences: { 0: sequence, numSequences: 1 },
    openSequence(id) {
      this.activeSequence = Object.values(this.sequences).find((value) => value.sequenceID === id);
    },
    importFiles(paths, suppress, bin, numbered) {
      imports.push({ paths, suppress, numbered, bin });
      bin.children = { 0: { nodeId: "item-a", name: "captions.srt" }, numItems: 1 };
      return true;
    },
    ...overrides.project,
  };
  function File(filename) {
    const file = {
      fsName: filename,
      open: () => true,
      write(content) {
        writes.push({ filename, content, encoding: file.encoding });
        return true;
      },
      close: () => true,
      remove() {
        removed.push(filename);
        return true;
      },
    };
    return file;
  }
  File.saveDialog = () =>
    overrides.saveFile === null ? null : new File("D:/exports/captions.srt");
  return {
    context: {
      app: { project },
      File,
      Folder: { temp: { fsName: "D:/temp" } },
      JSON: undefined,
      Sequence: { CAPTION_FORMAT_SUBTITLE: 42 },
    },
    writes,
    imports,
    placements,
    removed,
    bins,
    project,
  };
}

test("caption insertion writes UTF-8 SRT, imports it into its own bin and places at sequence zero without native JSON", async () => {
  const panel = await panelFixture();
  const host = captionHost();
  panel.send(captionRequest());
  const evaluation = panel.evaluations.at(-1);
  const raw = vm.runInNewContext(evaluation.script, host.context);
  assert.doesNotMatch(
    evaluation.script,
    /,\s*[)}]/,
    "ExtendScript does not support trailing commas",
  );
  evaluation.callback(raw);
  const result = panel.messages.at(-1).packet;
  assert.equal(result.status, "added");
  assert.equal(result.binId, "bin-a");
  assert.equal(result.itemId, "item-a");
  assert.equal(host.writes[0].content, captionRequest().srt);
  assert.equal(host.writes[0].encoding, "UTF-8");
  assert.equal(host.imports[0].suppress, true);
  assert.equal(host.imports[0].numbered, false);
  assert.equal(host.placements[0].start, 0);
  assert.equal(host.placements[0].item.nodeId, "item-a");
  assert.equal(host.placements[0].format, 42);
  assert.equal(result.checkpointId, "checkpoint-a");
  assert.match(host.project.sequences[1].name, /^\[Axis caption checkpoint /);
  assert.equal(host.removed.length, 0);
});

test("captions reject cross-origin, unconfirmed and malformed requests before scripting", async () => {
  const panel = await panelFixture();
  const before = panel.evaluations.length;
  panel.send(captionRequest(), { origin: "https://outside.test" });
  panel.send(captionRequest({ confirmed: false }));
  panel.send(captionRequest({ srt: "" }));
  panel.send(captionRequest({ srt: "a".repeat(4000001) }));
  panel.send(captionRequest({ action: "undo", binId: "", itemId: "" }));
  assert.equal(panel.evaluations.length, before);
  assert.equal(panel.messages.length, 4);
  assert.ok(panel.messages.every(({ packet }) => packet.ok === false));
});

test("captions check both project and sequence immediately before mutation", async () => {
  for (const request of [
    captionRequest({ sequenceId: "different" }),
    captionRequest({ projectId: "different" }),
  ]) {
    const panel = await panelFixture();
    const host = captionHost();
    panel.send(request);
    const evaluation = panel.evaluations.at(-1);
    evaluation.callback(vm.runInNewContext(evaluation.script, host.context));
    assert.equal(panel.messages.at(-1).packet.ok, false);
    assert.match(panel.messages.at(-1).packet.error, /changed/);
    assert.equal(host.writes.length, 0);
    assert.equal(host.imports.length, 0);
  }
});

test("unsupported, false-returning and throwing caption APIs retain the SRT for manual placement", async () => {
  for (const createCaptionTrack of [
    undefined,
    () => false,
    () => {
      throw new Error("Unsupported");
    },
  ]) {
    const panel = await panelFixture();
    const host = captionHost({ sequence: { createCaptionTrack } });
    panel.send(captionRequest());
    const evaluation = panel.evaluations.at(-1);
    evaluation.callback(vm.runInNewContext(evaluation.script, host.context));
    assert.equal(panel.messages.at(-1).packet.status, "imported");
    assert.equal(panel.messages.at(-1).packet.binId, "bin-a");
    assert.match(panel.messages.at(-1).packet.binName, /^Axis captions /);
    assert.equal(host.removed.length, 0);
  }
});

test("failed SRT import cleans up the created bin and temporary source", async () => {
  const panel = await panelFixture();
  const host = captionHost({ project: { importFiles: () => false } });
  panel.send(captionRequest());
  const evaluation = panel.evaluations.at(-1);
  evaluation.callback(vm.runInNewContext(evaluation.script, host.context));
  assert.equal(panel.messages.at(-1).packet.ok, false);
  assert.match(panel.messages.at(-1).packet.error, /import/);
  assert.equal(host.removed[0], "bin-a");
  assert.match(host.removed[1], /\.srt$/);
});

test("captions undo opens the pre-caption checkpoint and preserves the captioned edit", async () => {
  const panel = await panelFixture();
  const host = captionHost();
  panel.send(captionRequest());
  let evaluation = panel.evaluations.at(-1);
  evaluation.callback(vm.runInNewContext(evaluation.script, host.context));
  const added = panel.messages.at(-1).packet;
  assert.deepEqual(host.project.activeSequence.captions, ["Existing caption", "Hello"]);
  panel.send(
    captionRequest({
      ...added,
      sequenceId: "sequence-a",
      action: "undo",
      type: "premiere.captions.request",
    }),
  );
  evaluation = panel.evaluations.at(-1);
  evaluation.callback(vm.runInNewContext(evaluation.script, host.context));
  assert.equal(panel.messages.at(-1).packet.status, "undone");
  assert.equal(host.project.activeSequence.sequenceID, "checkpoint-a");
  assert.deepEqual(host.project.activeSequence.captions, ["Existing caption"]);
  assert.deepEqual(host.project.sequences[0].captions, ["Existing caption", "Hello"]);
  assert.deepEqual(host.removed, []);
});

test("captions undo refuses bins with added or replaced project items", async () => {
  const panel = await panelFixture();
  const host = captionHost();
  panel.send(captionRequest());
  let evaluation = panel.evaluations.at(-1);
  evaluation.callback(vm.runInNewContext(evaluation.script, host.context));
  host.bins[0].children.numItems = 2;
  panel.send(captionRequest({ action: "undo", binId: "bin-a", itemId: "item-a" }));
  evaluation = panel.evaluations.at(-1);
  evaluation.callback(vm.runInNewContext(evaluation.script, host.context));
  assert.equal(panel.messages.at(-1).packet.ok, false);
  assert.match(panel.messages.at(-1).packet.error, /bin changed/);
  assert.equal(host.removed.length, 0);
});

test("captions import safely when a verified checkpoint cannot be created", async () => {
  const panel = await panelFixture();
  const host = captionHost({ sequence: { clone: () => false } });
  panel.send(captionRequest());
  const evaluation = panel.evaluations.at(-1);
  evaluation.callback(vm.runInNewContext(evaluation.script, host.context));
  assert.equal(panel.messages.at(-1).packet.status, "imported");
  assert.equal(host.placements.length, 0);
  assert.equal(host.imports.length, 1);
});

test("caption checkpoint undo refuses later timeline edits", async () => {
  const panel = await panelFixture();
  const host = captionHost();
  panel.send(captionRequest());
  let evaluation = panel.evaluations.at(-1);
  evaluation.callback(vm.runInNewContext(evaluation.script, host.context));
  const added = panel.messages.at(-1).packet;
  host.project.activeSequence.getOutPointAsTime = () => ({ seconds: 61 });
  panel.send(
    captionRequest({
      ...added,
      sequenceId: "sequence-a",
      action: "undo",
      type: "premiere.captions.request",
    }),
  );
  evaluation = panel.evaluations.at(-1);
  evaluation.callback(vm.runInNewContext(evaluation.script, host.context));
  assert.match(panel.messages.at(-1).packet.error, /timeline changed/);
  assert.equal(host.project.activeSequence.sequenceID, "sequence-a");
  assert.equal(host.removed.length, 0);
});

test("caption creation uses the default subtitle format when the enum is unavailable", async () => {
  const panel = await panelFixture();
  const host = captionHost();
  delete host.context.Sequence;
  panel.send(captionRequest());
  const evaluation = panel.evaluations.at(-1);
  evaluation.callback(vm.runInNewContext(evaluation.script, host.context));
  assert.equal(panel.messages.at(-1).packet.status, "added");
  assert.equal(host.placements[0].format, undefined);
});

test("turn checkpoint pruning preserves caption undo checkpoints", async () => {
  const panel = await panelFixture();
  const host = captionHost();
  panel.send(captionRequest());
  const evaluation = panel.evaluations.at(-1);
  evaluation.callback(vm.runInNewContext(evaluation.script, host.context));
  const { timelineOperation } = panel;
  const result = vm.runInNewContext(
    "(" + timelineOperation.toString() + ")('prune',false,'sequence-a','','',0,null,null,true)",
    host.context,
  );
  assert.equal(result.removed, 0);
  assert.equal(host.project.sequences.numSequences, 2);
  assert.equal(host.project.sequences[1].sequenceID, "checkpoint-a");
});

test("import-only caption undo removes the unchanged imported bin", async () => {
  const panel = await panelFixture();
  const host = captionHost({ sequence: { createCaptionTrack: undefined } });
  panel.send(captionRequest());
  let evaluation = panel.evaluations.at(-1);
  evaluation.callback(vm.runInNewContext(evaluation.script, host.context));
  panel.send(captionRequest({ action: "undo", binId: "bin-a", itemId: "item-a" }));
  evaluation = panel.evaluations.at(-1);
  evaluation.callback(vm.runInNewContext(evaluation.script, host.context));
  assert.equal(panel.messages.at(-1).packet.status, "undone");
  assert.deepEqual(host.removed, ["bin-a"]);
  assert.deepEqual(host.project.activeSequence.captions, ["Existing caption"]);
});

test("SRT save and cancel never import or mutate the sequence", async () => {
  for (const saveFile of [null, true]) {
    const panel = await panelFixture();
    const host = captionHost({ saveFile });
    panel.send(captionRequest({ action: "save" }));
    const evaluation = panel.evaluations.at(-1);
    evaluation.callback(vm.runInNewContext(evaluation.script, host.context));
    assert.equal(panel.messages.at(-1).packet.status, saveFile ? "saved" : "cancelled");
    assert.equal(host.writes.length, saveFile ? 1 : 0);
    assert.equal(host.imports.length, 0);
    assert.equal(host.placements.length, 0);
  }
});

test("caption requests remain serialized while a native save dialog is open", async () => {
  const panel = await panelFixture();
  panel.send(captionRequest({ action: "save" }));
  const before = panel.evaluations.length;
  panel.send(captionRequest());
  assert.equal(panel.evaluations.length, before);
  assert.match(panel.messages.at(-1).packet.error, /already running/);
});

test("agent command bridge can call the same registered captions operation", async () => {
  const panel = await panelFixture();
  const host = captionHost();
  const globals = {};
  const context = vm.createContext({ ...host.context, $: { global: globals } });
  vm.runInContext(panel.evaluations[0].script, context);
  assert.equal(typeof globals.axisCaptionOperation, "function");
  const raw = globals.axisCaptionOperation({ ...captionRequest(), id: "agent-123" });
  assert.match(raw, /^axis:captions\|added\|/);
  assert.equal(host.placements[0].start, 0);
  const refused = globals.axisCaptionOperation({ ...captionRequest(), id: "../bad" });
  assert.match(decodeURIComponent(refused), /Invalid captions request/);
  assert.equal(host.placements.length, 1);
});
