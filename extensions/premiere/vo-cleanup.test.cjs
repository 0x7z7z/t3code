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
  assert.deepEqual(calls.at(-1).args.slice(0, 7), [
    path.join(__dirname, "tools", "axis_vo_cleanup.py"),
    "--input",
    source,
    "--mode",
    "both",
    "--keep-ms",
    "50",
  ]);
  assert.equal(calls.at(-1).args[7], "--cancel-file");
  assert.equal(fs.existsSync(path.dirname(calls.at(-1).args[8])), false);
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

function timelineFixture(options = {}) {
  const f = fixture();
  let serial = 0;
  const collection = (list, count) => Object.assign({ [count]: list.length }, list);
  const clip = (nodeId, filename, start = 12, inPoint = 2, outPoint = 90, mediaType = "Audio") => ({
    name: nodeId,
    nodeId,
    mediaType,
    projectItem: { nodeId: filename, name: filename, getMediaPath: () => filename },
    start: { seconds: start },
    end: { seconds: start + outPoint - inPoint },
    inPoint: { seconds: inPoint },
    outPoint: { seconds: outPoint },
    getSpeed: () => 1,
    isSpeedReversed: () => false,
    isDisabled: () => false,
    getLinkedItems: () => collection([], "numItems"),
    remove: () => false,
  });
  const points = { 1: [8, 9], 2: [0, 100] };
  const pointCalls = [];
  const item = {
    nodeId: "clean",
    name: "clean.wav",
    getMediaPath: () => "D:/clean.wav",
    // Adobe's CEP sample exposes this as a property, not a method.
    getAudioChannelMapping: { audioClipsNumber: 1, audioChannelsType: 1 },
    getInPoint: (type) => ({ seconds: points[type][0] }),
    getOutPoint: (type) => ({ seconds: points[type][1] }),
    setInPoint: (value, type) => {
      pointCalls.push(["in", value, type]);
      points[type][0] = value;
    },
    setOutPoint: (value, type) => {
      pointCalls.push(["out", value, type]);
      points[type][1] = value;
    },
  };
  let sequence;
  const track = (name, list = [], id = "track-" + serial++) => ({
    id,
    name,
    list,
    locked: false,
    isLocked() {
      return this.locked;
    },
    get clips() {
      return collection(this.list, "numItems");
    },
    overwriteClip(source, start) {
      const mapping = source.getAudioChannelMapping;
      const index = sequence.audio.indexOf(this);
      // Model spill from separate mono mappings, including count-preserving replacements.
      for (let n = 0; n < mapping.audioClipsNumber; n++) {
        const target = sequence.audio[index + n];
        if (!target) throw new Error("No destination track");
        const [a, b] = points[2];
        const duration = Math.floor((b - a) * 60 + 0.000001) / 60;
        const placed = clip("placed-" + n, source.getMediaPath(), Number(start), a, a + duration);
        placed.projectItem = source;
        target.list.splice(0, target.list.length, placed);
      }
      if (options.onOverwrite) options.onOverwrite({ sequence, source, track: this });
    },
  });
  const vo = clip("vo", "D:/VO.wav");
  const audio = [];
  for (let i = 0; i < (options.voIndex || 0); i++) audio.push(track("Empty", []));
  audio.push(track("VO", [vo]), track("SFX", [clip("sfx", "D:/boom.wav", 30)]));
  if (options.emptyBelow) audio.splice(audio.length - 1, 0, track("Audio 2"));
  function makeSequence(id, a, v) {
    const seq = {
      name: "Main",
      sequenceID: id,
      audio: a,
      video: v,
      timebase: "4233600000",
      get audioTracks() {
        return collection(this.audio, "numTracks");
      },
      get videoTracks() {
        return collection(this.video, "numTracks");
      },
      getSelection: () => [vo],
      getInPointAsTime: () => ({ seconds: 0 }),
      getOutPointAsTime: () => ({ seconds: 100 }),
      markers: { getFirstMarker: () => null, getNextMarker: () => null },
      projectItem: { nodeId: "seq-item-" + id, moveBin: () => true },
      clone() {
        if (options.noCheckpoint) return false;
        const copy = (tracks) =>
          tracks.map((t) =>
            track(
              t.name,
              t.list.map((c) => ({
                ...c,
                nodeId: c.nodeId + "-copy",
                start: { ...c.start },
                end: { ...c.end },
                inPoint: { ...c.inPoint },
                outPoint: { ...c.outPoint },
              })),
            ),
          );
        const saved = makeSequence("checkpoint-" + serial++, copy(this.audio), copy(this.video));
        // Lock state survives a real sequence clone.
        [...saved.audio, ...saved.video].forEach((t, i) => {
          t.locked = [...this.audio, ...this.video][i].locked;
        });
        sequences.push(saved);
        f.app.project.activeSequence = saved;
        return true;
      },
    };
    return seq;
  }
  sequence = makeSequence("seq", audio, [
    track("Video", [clip("video", "D:/picture.mov", 0, 0, 100, "Video")]),
  ]);
  const sequences = [sequence];
  Object.defineProperty(f.app.project, "sequences", {
    get: () => collection(sequences, "numSequences"),
  });
  f.app.project.activeSequence = sequence;
  f.app.project.openSequence = (id) => {
    const next = sequences.find((s) => s.sequenceID === id);
    if (options.failRestore && next !== sequence) return;
    f.app.project.activeSequence = next;
    if (options.onOpen) options.onOpen(next, sequence);
  };
  f.bin.children = collection([item], "numItems");
  f.app.project.rootItem.children = collection([f.bin], "numItems");
  f.app.enableQE = () => {};
  const qe = {
    project: {
      getActiveSequence: () => ({
        addTracks: (_video, _videoAfter, count, _type, after) => {
          const at = after + (options.insertOffset || 0);
          for (let n = 0; n < count + (options.extraTracks || 0); n++)
            sequence.audio.splice(at, 0, track("Audio " + (at + 1)));
          if (options.onAdd) options.onAdd(sequence);
        },
      }),
    },
  };
  function File(filename) {
    return { fsName: filename, exists: true };
  }
  const context = vm.createContext({ app: f.app, File, qe, JSON: undefined });
  // Exercise the real checkpoint implementation, including sequence clones and swaps.
  const timelineModule = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "snapshot.js"), "utf8"), {
    module: timelineModule,
  });
  const timeline = timelineModule.exports.timelineOperation.toString();
  return {
    ...f,
    sequence,
    vo,
    item,
    track,
    clip,
    points,
    pointCalls,
    sequences,
    get tracks() {
      return f.app.project.activeSequence.audio;
    },
    evaluate: (text, callback) => callback(vm.runInContext(text, context)),
    options: { timelineSource: timeline },
  };
}
async function select(f) {
  return (await hostOperation({ action: "selected" }, __dirname, f.evaluate, f.options)).anchor;
}
async function place(f, fields = {}) {
  const anchor = await select(f);
  return hostOperation(
    {
      action: "place",
      path: "D:/clean.wav",
      projectId: "film",
      ...anchor,
      keepTiming: true,
      confirmed: true,
      ...fields,
    },
    __dirname,
    f.evaluate,
    f.options,
  );
}
function content(f) {
  return f.tracks.map((t) => [
    t.name,
    t.list.map((c) => [
      c.projectItem.getMediaPath(),
      c.start.seconds,
      c.end.seconds,
      c.inPoint.seconds,
      c.outPoint.seconds,
    ]),
  ]);
}
test("VO selection captures project, sequence, track and clip identities and timing", async () => {
  const f = timelineFixture();
  assert.deepEqual(await select(f), {
    projectId: "film",
    sequenceId: "seq",
    nodeId: "vo",
    trackId: f.tracks[0].id,
    trackIndex: 0,
    start: 12,
    end: 100,
    inPoint: 2,
    outPoint: 90,
  });
});
for (const voIndex of [0, 1, 3]) {
  test(
    "VO placement at A" + (voIndex + 1) + " preserves all tracks and Undo restores its checkpoint",
    async () => {
      const f = timelineFixture({ voIndex, emptyBelow: true });
      const before = content(f);
      const placed = await place(f);
      assert.equal(placed.status, "placed");
      assert.equal(placed.trackIndex, voIndex + 1);
      assert.equal(f.tracks[voIndex + 1].name, "Clean VO");
      assert.deepEqual(
        content(f).filter((_, i) => i !== voIndex + 1),
        before,
      );
      assert.deepEqual(f.points[1], [8, 9]);
      assert.deepEqual(f.points[2], [0, 100]);
      assert.ok(f.pointCalls.every((call) => call[2] === 2));
      assert.ok(placed.checkpointId);
      const undone = await hostOperation(
        {
          projectId: "film",
          sequenceId: "seq",
          ...placed,
          action: "unplace",
        },
        __dirname,
        f.evaluate,
        f.options,
      );
      assert.equal(undone.status, "unplaced");
      assert.deepEqual(content(f), before);
      assert.notEqual(f.app.project.activeSequence, f.sequence);
    },
  );
}
test("two selected instances of the same source remain ambiguous", async () => {
  const f = timelineFixture();
  const second = f.clip("another", "D:/VO.wav", 120);
  f.tracks[0].list.push(second);
  f.sequence.getSelection = () => [f.vo, second, f.vo];
  await assert.rejects(select(f), /Select only one VO/);
});
test("linked mono channels of one instance count as one selection on the bottom channel track", async () => {
  const f = timelineFixture();
  const second = f.clip("channel-2", "D:/VO.wav");
  f.vo.projectItem.getAudioChannelMapping = { audioClipsNumber: 2, audioChannelsType: 0 };
  second.projectItem = f.vo.projectItem;
  f.tracks.splice(1, 0, f.track("VO right", [second]));
  f.vo.getLinkedItems = () => ({ numItems: 1, 0: second });
  second.getLinkedItems = () => ({ numItems: 1, 0: f.vo });
  f.sequence.getSelection = () => [f.vo, second, f.vo];
  const anchor = await select(f);
  assert.equal(anchor.nodeId, "channel-2");
  assert.equal(anchor.trackIndex, 1);
});
test("a moved, trimmed, replaced or deleted anchor refuses mutation", async () => {
  for (const change of [
    (f) => {
      f.vo.start.seconds = 120;
    },
    (f) => {
      f.vo.inPoint.seconds = 30;
    },
    (f) => {
      f.vo.nodeId = "replacement";
    },
    (f) => {
      f.tracks[0].id = "replacement-track";
    },
    (f) => {
      f.tracks[0].list.length = 0;
    },
  ]) {
    const f = timelineFixture();
    const anchor = await select(f);
    change(f);
    await assert.rejects(place(f, anchor), /changed|gone|again/);
    assert.equal(f.tracks.length, 2);
  }
});
test("separate mono, surround, multichannel and unknown imported mappings refuse placement", async () => {
  for (const mapping of [
    { audioClipsNumber: 2, audioChannelsType: 0 },
    { audioClipsNumber: 1, audioChannelsType: 2 },
    { audioClipsNumber: 1, audioChannelsType: 3 },
    {},
  ]) {
    const f = timelineFixture();
    f.item.getAudioChannelMapping = mapping;
    await assert.rejects(place(f), /single mono or stereo/);
    assert.equal(f.tracks.length, 2);
    assert.equal(f.sequences.length, 1);
  }
});
test("one mono clip is safe", async () => {
  const f = timelineFixture();
  f.item.getAudioChannelMapping = { audioClipsNumber: 1, audioChannelsType: 0 };
  assert.equal((await place(f)).status, "placed");
});
for (const [name, options] of [
  ["QE inserts at the wrong position", { insertOffset: 1 }],
  ["QE creates several tracks", { extraTracks: 1 }],
  [
    "SFX is replaced without changing the count",
    {
      onOverwrite: ({ sequence }) => {
        sequence.audio.at(-1).list[0].projectItem = { getMediaPath: () => "D:/WRONG-SFX.wav" };
      },
    },
  ],
  [
    "a video clip changes without changing the count",
    {
      onOverwrite: ({ sequence }) => {
        sequence.video[0].list[0].inPoint.seconds = 7;
      },
    },
  ],
  [
    "placement writes a partial result then throws",
    {
      onOverwrite: () => {
        throw new Error("Partial failure");
      },
    },
  ],
  [
    "the placed source range is wrong",
    {
      onOverwrite: ({ track }) => {
        track.list[0].inPoint.seconds = 0;
      },
    },
  ],
  [
    "the placed end is wrong",
    {
      onOverwrite: ({ track }) => {
        track.list[0].end.seconds += 1;
      },
    },
  ],
]) {
  test(name + " restores the checkpoint automatically", async () => {
    const f = timelineFixture(options);
    const before = content(f);
    await assert.rejects(place(f), /checkpoint was restored/);
    assert.deepEqual(content(f), before);
    assert.notEqual(f.app.project.activeSequence, f.sequence);
  });
}
test("requested source trim is read back before overwrite and restored afterwards", async () => {
  const f = timelineFixture();
  f.vo.inPoint.seconds = 30;
  f.vo.outPoint.seconds = 50;
  f.vo.end.seconds = 32;
  await place(f);
  assert.equal(f.tracks[1].list[0].inPoint.seconds, 30);
  assert.equal(f.tracks[1].list[0].outPoint.seconds, 50);
  assert.deepEqual(f.points[2], [0, 100]);
});
test("ignored source trim refuses overwrite", async () => {
  const f = timelineFixture();
  f.item.setInPoint = () => {};
  await assert.rejects(place(f), /source range/);
  assert.equal(f.tracks.length, 2);
});
test("retimed, reversed and unreadable speed clips refuse placement", async () => {
  for (const change of [
    (f) => {
      f.vo.getSpeed = () => 1.5;
    },
    (f) => {
      f.vo.isSpeedReversed = () => true;
    },
    (f) => {
      f.vo.getSpeed = undefined;
    },
  ]) {
    const f = timelineFixture();
    change(f);
    await assert.rejects(place(f), /100%|speed/);
    assert.equal(f.tracks.length, 2);
  }
});
test("locked VO or any track below it refuses placement", async () => {
  for (const index of [0, 1]) {
    const f = timelineFixture();
    f.tracks[index].locked = true;
    await assert.rejects(place(f), /Unlock/);
    assert.equal(f.tracks.length, 2);
  }
});
test("no verified checkpoint means no mutation", async () => {
  const f = timelineFixture({ noCheckpoint: true });
  await assert.rejects(place(f), /checkpoint/);
  assert.equal(f.tracks.length, 2);
});
test("failed Undo is reported and its receipt can still restore on a later attempt", async () => {
  const options = {};
  const f = timelineFixture(options);
  const before = content(f);
  const placed = await place(f);
  const request = { ...placed, action: "unplace", projectId: "film", sequenceId: "seq" };
  options.failRestore = true;
  await assert.rejects(
    hostOperation(request, __dirname, f.evaluate, f.options),
    /checkpoint|restore/,
  );
  assert.equal(f.tracks.length, 3);
  options.failRestore = false;
  await hostOperation(request, __dirname, f.evaluate, f.options);
  assert.deepEqual(content(f), before);
});
test("Undo refuses edits made after placement", async () => {
  const f = timelineFixture();
  const placed = await place(f);
  f.tracks.at(-1).list[0].end.seconds += 1;
  await assert.rejects(
    hostOperation(
      {
        ...placed,
        action: "unplace",
        projectId: "film",
        sequenceId: "seq",
      },
      __dirname,
      f.evaluate,
      f.options,
    ),
    /timeline changed/,
  );
});
test("lost CEP callbacks have a deadline, ignore late replies and never retry mutations", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  let callback;
  const pending = hostOperation(
    { action: "place" },
    __dirname,
    (_script, cb) => {
      calls++;
      callback = cb;
    },
    { deadlineMs: 100 },
  );
  const rejected = assert.rejects(pending, /Check the timeline.*Undo/);
  t.mock.timers.tick(101);
  await rejected;
  callback("axis:vo|placed|late");
  assert.equal(calls, 1);
});
test("missing source files have a plain error", async () => {
  await assert.rejects(
    operation(
      {
        action: "run",
        path: path.join(os.tmpdir(), "axis-vo-missing-file.wav"),
        mode: "silence",
        keepMs: 50,
      },
      __dirname,
    ),
    /Audio file not found\./,
  );
});

for (const trackType of ["audio", "video"]) {
  for (const field of ["nodeId", "start", "end", "inPoint", "outPoint", "path"]) {
    test("count-preserving " + trackType + " " + field + " damage is restored", async () => {
      const f = timelineFixture({
        onOverwrite: ({ sequence }) => {
          const clip = sequence[trackType].at(-1).list[0];
          if (field === "nodeId") clip.nodeId = "replacement";
          else if (field === "path") clip.projectItem = { getMediaPath: () => "D:/wrong.wav" };
          else clip[field].seconds += 1;
        },
      });
      const before = content(f);
      await assert.rejects(place(f), /checkpoint was restored/);
      assert.deepEqual(content(f), before);
    });
  }
}
test("a damaged after-state that cannot be snapshotted still restores a verified checkpoint", async () => {
  const f = timelineFixture({
    onOverwrite: ({ track }) => {
      track.list[0].end.seconds = NaN;
    },
  });
  const before = content(f);
  await assert.rejects(place(f), /checkpoint was restored/);
  assert.deepEqual(content(f), before);
});
test("a mapping that unexpectedly spills during overwrite restores all original content", async () => {
  const f = timelineFixture();
  let reads = 0;
  Object.defineProperty(f.item, "getAudioChannelMapping", {
    get() {
      return { audioClipsNumber: ++reads > 3 ? 2 : 1, audioChannelsType: 0 };
    },
  });
  const before = content(f);
  await assert.rejects(place(f), /checkpoint was restored/);
  assert.deepEqual(content(f), before);
});
test("automatic restore failure returns a usable checkpoint receipt and a plain track warning", async () => {
  const options = {
    failRestore: true,
    onOverwrite: () => {
      throw new Error("partial write");
    },
  };
  const f = timelineFixture(options);
  const before = content(f);
  const recovery = await place(f);
  assert.equal(recovery.status, "recovery");
  assert.match(recovery.message, /Automatic restore failed.*added track may still be present/);
  assert.ok(recovery.checkpointId);
  options.failRestore = false;
  await hostOperation(
    {
      ...recovery,
      action: "unplace",
      projectId: "film",
      sequenceId: "seq",
    },
    __dirname,
    f.evaluate,
    f.options,
  );
  assert.deepEqual(content(f), before);
});
test("restore readback cannot claim success if opening the saved sequence corrupts it", async () => {
  const f = timelineFixture({
    onOpen: (next, original) => {
      if (next !== original && next.name.startsWith("[Axis VO checkpoint"))
        next.audio[0].list[0].end.seconds += 1;
    },
  });
  const receipt = await place(f);
  await assert.rejects(
    hostOperation(
      {
        ...receipt,
        action: "unplace",
        projectId: "film",
        sequenceId: "seq",
      },
      __dirname,
      f.evaluate,
      f.options,
    ),
    /restored checkpoint did not match/,
  );
  assert.equal(f.app.project.activeSequence, f.sequence);
});
test("silence cleanup uses the full cleaned source at the current anchor start", async () => {
  const f = timelineFixture();
  await place(f, { keepTiming: false });
  const clip = f.tracks[1].list[0];
  assert.equal(clip.start.seconds, 12);
  assert.equal(clip.end.seconds, 112);
  assert.equal(clip.inPoint.seconds, 0);
  assert.equal(clip.outPoint.seconds, 100);
});
test("a fractional source duration is verified against Premiere's frame floor", async () => {
  const f = timelineFixture();
  f.vo.outPoint.seconds = 50.005;
  f.vo.end.seconds = 60.005;
  await place(f);
  assert.equal(f.tracks[1].list[0].outPoint.seconds, 50);
});
test("missing confirmation cannot mutate a timeline", async () => {
  const f = timelineFixture();
  await assert.rejects(place(f, { confirmed: false }), /confirm/);
  assert.equal(f.sequences.length, 1);
});
test("a synchronous CEP exception clears its deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  await assert.rejects(
    hostOperation({ action: "pick" }, __dirname, () => {
      throw new Error("CEP unavailable");
    }),
    /CEP unavailable/,
  );
  t.mock.timers.runAll();
});

test("an existing identical empty track cannot be mistaken for QE's new track", async () => {
  const f = timelineFixture({
    emptyBelow: true,
    insertOffset: 1,
    onAdd: (sequence) => {
      sequence.audio[2].name = sequence.audio[1].name;
    },
  });
  const before = content(f);
  await assert.rejects(place(f), /wrong position.*checkpoint was restored/);
  assert.deepEqual(content(f), before);
});
test("the review's wrong trim reproduction restores instead of accepting source 2-90 for 30-50", async () => {
  const f = timelineFixture({
    onOverwrite: ({ track }) => {
      track.list[0].inPoint.seconds = 2;
      track.list[0].outPoint.seconds = 90;
    },
  });
  f.vo.inPoint.seconds = 30;
  f.vo.outPoint.seconds = 50;
  f.vo.end.seconds = 32;
  const before = content(f);
  await assert.rejects(place(f), /expected cleaned VO range.*checkpoint was restored/);
  assert.deepEqual(content(f), before);
});
