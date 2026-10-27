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

function timelineFixture() {
  const f = fixture();
  const tracks = [];
  const clip = (nodeId, mediaPath, start, mediaType = "Audio") => ({
    nodeId,
    mediaType,
    projectItem: { getMediaPath: () => mediaPath },
    start: { seconds: start },
    inPoint: { seconds: 2 },
    outPoint: { seconds: 90 },
    remove() {
      for (const track of tracks) {
        const index = track.list.indexOf(this);
        if (index >= 0) track.list.splice(index, 1);
      }
    },
  });
  const track = (name, list) => ({
    name,
    list,
    get clips() {
      const view = { numItems: list.length };
      list.forEach((value, index) => (view[index] = value));
      return view;
    },
    overwriteClip(item, start) {
      list.push(clip("placed", item.getMediaPath(), Number(start)));
    },
  });
  const vo = clip("vo", "D:/VO.wav", 12);
  tracks.push(track("VO", [vo]), track("SFX", [clip("sfx", "D:/boom.wav", 30)]));
  const audioTracks = {};
  const sync = () => {
    audioTracks.numTracks = tracks.length;
    tracks.forEach((value, index) => (audioTracks[index] = value));
  };
  sync();
  f.app.project.activeSequence = {
    sequenceID: "seq",
    audioTracks,
    videoTracks: { numTracks: 1, 0: { clips: { numItems: 1 } } },
    getSelection: () => [clip("vo-video", "D:/VO.wav", 12, "Video"), vo],
  };
  f.app.getProjectViewSelection = () => undefined;
  const points = [];
  const item = {
    getMediaPath: () => "D:/clean.wav",
    getInPoint: () => ({ seconds: 0 }),
    getOutPoint: () => ({ seconds: 100 }),
    setInPoint: (value) => points.push(["in", value]),
    setOutPoint: (value) => points.push(["out", value]),
    clearInPoint: () => points.push(["clear-in"]),
    clearOutPoint: () => points.push(["clear-out"]),
  };
  f.bin.children = { numItems: 1, 0: item };
  f.app.project.rootItem.children = { numItems: 1, 0: f.bin };
  f.app.enableQE = () => {};
  const qe = {
    project: {
      getActiveSequence: () => ({
        addTracks: (_video, _videoAfter, count, _type, after) => {
          for (let n = 0; n < count; n++)
            tracks.splice(after, 0, track("Audio " + (after + 1), []));
          sync();
        },
      }),
    },
  };
  function File(filename) {
    return { fsName: filename, exists: true };
  }
  const context = vm.createContext({ app: f.app, File, qe });
  return {
    tracks,
    points,
    evaluate: (text, callback) => callback(vm.runInContext(text, context)),
  };
}

test("VO selection falls back to the timeline clip when project views have no selection", async () => {
  const t = timelineFixture();
  const selected = await hostOperation({ action: "selected" }, __dirname, t.evaluate);
  assert.equal(selected.path, "D:/VO.wav");
  assert.deepEqual(selected.anchor, {
    sequenceId: "seq",
    trackIndex: 0,
    start: 12,
    inPoint: 2,
    outPoint: 90,
  });
});

test("VO placement adds a track below the VO without touching other tracks, then undoes", async () => {
  const t = timelineFixture();
  const request = {
    action: "place",
    path: "D:/clean.wav",
    projectId: "film",
    sequenceId: "seq",
    trackIndex: 0,
    start: 12,
    inPoint: 2,
    outPoint: 90,
    keepTiming: true,
  };
  await assert.rejects(
    hostOperation({ ...request, sequenceId: "other" }, __dirname, t.evaluate),
    /Open the sequence/,
  );
  assert.equal(t.tracks.length, 2);
  const placed = await hostOperation(request, __dirname, t.evaluate);
  assert.equal(placed.status, "placed");
  assert.equal(placed.trackIndex, 1);
  assert.deepEqual(
    t.tracks.map((track) => [track.name, track.list.length]),
    [
      ["VO", 1],
      ["Clean VO", 1],
      ["SFX", 1],
    ],
  );
  assert.equal(t.tracks[1].list[0].start.seconds, 12);
  assert.deepEqual(t.points, [["in", 2], ["out", 90], ["clear-in"], ["clear-out"]]);
  const undone = await hostOperation(
    {
      action: "unplace",
      path: "D:/clean.wav",
      projectId: "film",
      sequenceId: "seq",
      trackIndex: 1,
      start: 12,
    },
    __dirname,
    t.evaluate,
  );
  assert.equal(undone.status, "unplaced");
  assert.equal(t.tracks[1].list.length, 0);
  assert.equal(t.tracks[2].list.length, 1);
});
