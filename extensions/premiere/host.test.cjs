"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

async function panelFixture() {
  const elements = new Map();
  const listeners = new Map();
  const evaluations = [];
  const messages = [];
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
          ? { readFileSync: () => JSON.stringify(settings) }
          : runtime,
    setInterval: () => 1,
    clearInterval() {},
    setTimeout,
  });
  vm.runInContext(readFileSync(path.join(__dirname, "host.js"), "utf8"), context);
  await new Promise(setImmediate);
  return { elements, listeners, evaluations, messages, contentWindow };
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
  assert.equal(fixture.elements.get("project").textContent, "Premiere Assistant");
});
