"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const child = require("node:child_process");
const { operation, hostOperation } = require("./vo-cleanup.cjs");
const { parse } = require(
  require.resolve("acorn", { paths: [path.join(__dirname, "../../apps/desktop")] }),
);
const script = fs.readFileSync(path.join(__dirname, "vo-cleanup-host.js"), "utf8");

function fixture() {
  const imports = [];
  const bin = { name: "Axis VO cleanup", type: 2, children: { numItems: 0 } };
  const project = {
    documentID: "film",
    path: "D:/film.prproj",
    rootItem: { children: { numItems: 0 }, createBin: () => bin },
    importFiles: (files, suppress, target, numbered) => {
      imports.push({ files, suppress, target, numbered });
      target.children = { numItems: 1, 0: { getMediaPath: () => files[0] } };
      return true;
    },
  };
  const app = { project, getProjectViewIDs: () => [1], getProjectViewSelection: () => [] };
  function File(filename) {
    return { fsName: filename, exists: true };
  }
  File.openDialog = () => ({ fsName: "D:/voice.wav" });
  const context = vm.createContext({ app, File });
  const host = vm.runInContext("(" + script + ")", context);
  return {
    app,
    imports,
    bin,
    host,
    evaluate: (text, callback) => callback(vm.runInContext(text, context)),
  };
}

test("VO project helper is ES3 and file picking leaves the project alone", async () => {
  parse(script, { ecmaVersion: 3 });
  const f = fixture();
  const picked = await hostOperation({ action: "pick" }, __dirname, f.evaluate);
  assert.equal(picked.path, "D:/voice.wav");
  assert.equal(f.imports.length, 0);
  assert.equal(f.host({ action: "selected" }).split("|")[0], "axis:error");
  f.app.getProjectViewSelection = () => [{ getMediaPath: () => "D:/VO & narration.wav" }];
  const selected = await hostOperation({ action: "selected" }, __dirname, f.evaluate);
  assert.equal(selected.path, "D:/VO & narration.wav");
});

test("VO import verifies the original project and imports only to the bin", async () => {
  const f = fixture();
  await assert.rejects(
    hostOperation(
      { action: "import", projectId: "other", path: "D:/clean.wav" },
      __dirname,
      f.evaluate,
    ),
    /project changed/,
  );
  assert.equal(f.imports.length, 0);
  const result = await hostOperation(
    { action: "import", projectId: "film", path: "D:/clean.wav" },
    __dirname,
    f.evaluate,
  );
  assert.equal(result.status, "imported");
  assert.equal(f.imports.length, 1);
  assert.equal(f.imports[0].target, f.bin);
  assert.equal(f.imports[0].numbered, false);
});

test("VO bridge validates settings and passes a literal file path to the Python helper", async (t) => {
  using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "axis-vo-bridge-"));
  const source = path.join(temp.path, "voice & $() ' literal.wav");
  fs.writeFileSync(source, "source bytes");
  const calls = [];
  t.mock.method(child, "execFile", (binary, args, options, callback) => {
    calls.push({ binary, args, options });
    if (args.join(" ").includes('"pydub"')) callback(null, "", "");
    else if (args.includes("-c"))
      callback(null, JSON.stringify({ version: "3.12", path: "python-test", whisperx: true }));
    else callback(null, JSON.stringify({ outputPath: "clean.wav", regions: 136 }), "");
  });
  const request = { action: "run", path: source, mode: "both", keepMs: 50 };
  const output = await operation(request, __dirname, () =>
    assert.fail("Cleanup must not call Premiere"),
  );
  assert.equal(output.regions, 136);
  assert.equal(calls.at(-1).binary, "python-test");
  assert.deepEqual(calls.at(-1).args, [
    path.join(__dirname, "tools", "axis_vo_cleanup.py"),
    "--input",
    source,
    "--mode",
    "both",
    "--keep-ms",
    "50",
  ]);
  assert.equal(calls.at(-1).options.windowsHide, true);
  assert.equal(fs.readFileSync(source, "utf8"), "source bytes");
  for (const fields of [{ keepMs: -1 }, { keepMs: 1.5 }, { mode: "delete" }, { path: temp.path }])
    await assert.rejects(operation({ ...request, ...fields }, __dirname), /Choose/);
});

test("VO bridge reports Python, transcription, and malformed-output failures", async (t) => {
  using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "axis-vo-fail-"));
  const source = path.join(temp.path, "voice.wav");
  fs.writeFileSync(source, "source bytes");
  const request = { action: "run", path: source, mode: "both", keepMs: 50 };
  let response = null;
  let missing = "";
  t.mock.method(child, "execFile", (_binary, args, _options, callback) => {
    if (args.join(" ").includes('"pydub"')) return callback(null, missing, "");
    callback(null, args.includes("-c") ? JSON.stringify(response) : "not json", "");
  });
  await assert.rejects(operation(request, __dirname), /Python/);
  response = { path: "python-test", whisperx: false };
  await assert.rejects(operation(request, __dirname), /WhisperX/);
  await assert.rejects(
    operation({ ...request, mode: "silence" }, __dirname),
    /Invalid cleanup output/,
  );
  missing = "pydub";
  await assert.rejects(
    operation({ ...request, mode: "silence" }, __dirname),
    /Clean VO needs pydub\. Run: py -3\.12 -m pip install/,
  );
});
