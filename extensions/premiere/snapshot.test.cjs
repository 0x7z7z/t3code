"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const timelineModule = { exports: {} };
vm.runInNewContext(readFileSync(path.join(__dirname, "snapshot.js"), "utf8"), {
  module: timelineModule,
});
const { timelineOperation, handle } = timelineModule.exports;

function fixture() {
  const time = (seconds) => ({ seconds });
  const clip = {
    name: 'Clip | "one"\n',
    nodeId: "clip-a",
    projectItem: { name: "Source" },
    start: time(1),
    end: time(5),
    inPoint: time(0),
    outPoint: time(4),
    isDisabled: () => true,
  };
  const marker = {
    guid: "marker",
    name: "Mark",
    start: time(2),
    end: time(3),
    comments: "notes",
    getColorByIndex: () => 6,
  };
  const moves = [];
  const bin = { name: "Axis checkpoints", type: 2 };
  function sequence(id, clips = [clip]) {
    return {
      name: "Main Edit",
      sequenceID: id,
      videoTracks: { numTracks: 1, 0: { clips: { numItems: clips.length, ...clips } } },
      audioTracks: { numTracks: 0 },
      markers: { getFirstMarker: () => marker, getNextMarker: () => null },
      getInPointAsTime: () => time(0),
      getOutPointAsTime: () => time(10),
      projectItem: { moveBin: (value) => moves.push({ id, value }) },
    };
  }
  const original = sequence("sequence-a");
  const project = {
    documentID: "project-a",
    path: "D:/cut.prproj",
    activeSequence: original,
    sequences: { numSequences: 1, 0: original },
    rootItem: { children: { numItems: 0 }, createBin: () => bin },
    openSequence: (id) => {
      project.activeSequence = Object.values(project.sequences).find((s) => s.sequenceID === id);
    },
  };
  original.clone = () => {
    const clone = sequence("checkpoint-a", [
      {
        ...clip,
        nodeId: "cloned-node",
        start: { ...clip.start },
        end: { ...clip.end },
        inPoint: { ...clip.inPoint },
        outPoint: { ...clip.outPoint },
      },
    ]);
    project.sequences[project.sequences.numSequences++] = clone;
    project.activeSequence = clone;
    return true;
  };
  const run = (
    action = "snapshot",
    checkpoint = false,
    sequenceId = "sequence-a",
    checkpointId = "",
    signature = "",
    turn = 1,
    injectedCut = null,
  ) => {
    const args = [action, checkpoint, sequenceId, checkpointId, signature, turn]
      .map(JSON.stringify)
      .join(",");
    // Premiere's ExtendScript runtime has no native JSON object.
    const raw = vm.runInNewContext(`(${timelineOperation.toString()})(${args},range,injectedCut)`, {
      app: { project },
      JSON: undefined,
      range: { start: 1, end: 2, projectId: "project-a" },
      injectedCut,
    });
    return JSON.parse(raw.slice(5));
  };
  return { project, original, clip, marker, moves, run };
}

test("snapshots clips, markers, ranges and disabled state without native ExtendScript JSON", () => {
  const f = fixture();
  const result = f.run();
  assert.equal(result.ok, true);
  assert.equal(result.snapshot.videoTracks[0].clips[0].name, f.clip.name);
  assert.equal(result.snapshot.videoTracks[0].clips[0].enabled, false);
  assert.equal(result.snapshot.markers[0].color, 6);
  assert.equal(result.snapshot.outPoint, 10);
  assert.deepEqual(JSON.parse(result.signature), result.snapshot);
});

test("a transcript cut preflights, creates a verified checkpoint, then mutates in the same host operation", () => {
  const f = fixture();
  const phases = [];
  const result = f.run("cut", true, "sequence-a", "", "", 1, (seq, range, dryRun) => {
    phases.push(dryRun);
    assert.equal(seq, f.original);
    assert.equal(range.start, 1);
    if (dryRun) assert.equal(f.project.sequences.numSequences, 1);
    else {
      assert.equal(f.project.sequences.numSequences, 2);
      f.clip.end.seconds = 4;
    }
  });
  assert.deepEqual(phases, [true, false]);
  assert.equal(result.ok, true);
  assert.equal(result.checkpointId, "checkpoint-a");
  assert.equal(result.snapshot.videoTracks[0].clips[0].end, 4);
  assert.equal(result.cutError, null);
});

test("a transcript cut cannot mutate without a checkpoint and returns recovery data after a partial failure", () => {
  const f = fixture();
  f.original.clone = () => false;
  let writes = 0;
  const failed = f.run("cut", true, "sequence-a", "", "", 1, (_seq, _range, dryRun) => {
    if (!dryRun) writes++;
  });
  assert.equal(failed.ok, false);
  assert.equal(writes, 0);
  const partial = fixture();
  const result = partial.run("cut", true, "sequence-a", "", "", 1, (_seq, _range, dryRun) => {
    if (!dryRun) {
      partial.clip.end.seconds = 4;
      throw new Error("Host failed after razor");
    }
  });
  assert.equal(result.ok, true);
  assert.match(result.cutError, /Host failed after razor/);
  assert.equal(result.checkpointId, "checkpoint-a");
  assert.ok(result.signature);
  assert.ok(result.checkpointSignature);
});

test("creates and verifies a clone with new clip IDs, bins it and reactivates the original", () => {
  const f = fixture();
  const result = f.run("snapshot", true);
  assert.equal(result.checkpointId, "checkpoint-a");
  assert.ok(result.checkpointSignature);
  assert.deepEqual(result.checkpointIds, ["checkpoint-a"]);
  assert.equal(f.project.activeSequence, f.original);
  assert.match(f.project.sequences[1].name, /^\[Axis checkpoint sequence-a\]/);
  assert.equal(f.moves[0].value.name, "Axis checkpoints");
});

test("prunes this sequence's other checkpoints and leaves the kept one and unrelated sequences", () => {
  const f = fixture();
  const deleted = [];
  const add = (sequenceID, name) => {
    f.project.sequences[f.project.sequences.numSequences++] = { sequenceID, name };
  };
  add("old", "[Axis checkpoint sequence-a] Main Edit 1");
  add("keep", "[Axis checkpoint sequence-a] Main Edit 2");
  add("other", "[Axis checkpoint sequence-b] Other 1");
  add("user", "Main Edit (after turn 1)");
  f.project.deleteSequence = (seq) => {
    deleted.push(seq.sequenceID);
    return true;
  };
  assert.deepEqual(f.run("prune", false, "sequence-a", "keep"), { ok: true, removed: 1 });
  assert.deepEqual(deleted, ["old"]);
  deleted.length = 0;
  assert.deepEqual(f.run("prune", false, "sequence-a", ""), { ok: true, removed: 2 });
  assert.deepEqual(deleted.sort(), ["keep", "old"]);
});

test("opens the checkpoint on restore and preserves the after version without deleting anything", () => {
  const f = fixture();
  const checkpoint = f.run("snapshot", true);
  f.clip.end.seconds = 4;
  const after = f.run();
  const restored = f.run(
    "restore",
    checkpoint.checkpointSignature,
    "sequence-a",
    checkpoint.checkpointId,
    after.signature,
    3,
  );
  assert.equal(restored.ok, true);
  assert.equal(f.project.activeSequence.sequenceID, "checkpoint-a");
  assert.equal(f.project.activeSequence.name, "Main Edit");
  assert.equal(f.original.name, "Main Edit (after turn 3)");
  assert.equal(f.project.sequences.numSequences, 2);
  assert.equal(f.moves.at(-1).id, "checkpoint-a");
  assert.equal(f.moves.at(-1).value, f.project.rootItem);
});

test("puts the restored version in the bin the original sequence was in", () => {
  const f = fixture();
  const edits = { name: "Edits", type: 2, children: { numItems: 1, 0: { nodeId: "main-item" } } };
  f.project.rootItem.children = { numItems: 1, 0: edits };
  f.original.projectItem.nodeId = "main-item";
  const checkpoint = f.run("snapshot", true);
  f.clip.end.seconds = 4;
  const after = f.run();
  f.run("restore", checkpoint.checkpointSignature, "sequence-a", "checkpoint-a", after.signature);
  assert.deepEqual(
    f.moves.slice(-2).map((move) => [move.id, move.value.name]),
    [
      ["sequence-a", "Axis checkpoints"],
      ["checkpoint-a", "Edits"],
    ],
  );
});

test("rejects restore after later edits, missing checkpoints, or sequence switches", () => {
  const f = fixture();
  const checkpoint = f.run("snapshot", true);
  const after = f.run();
  f.clip.start.seconds = 0;
  assert.match(
    f.run("restore", checkpoint.checkpointSignature, "sequence-a", "checkpoint-a", after.signature)
      .error,
    /timeline changed/,
  );
  f.clip.start.seconds = 1;
  assert.match(
    f.run("restore", checkpoint.checkpointSignature, "sequence-a", "missing", after.signature)
      .error,
    /gone/,
  );
  assert.match(
    f.run("restore", checkpoint.checkpointSignature, "other", "checkpoint-a", after.signature)
      .error,
    /active sequence changed/,
  );
});

test("rejects edited checkpoints and reports refusal to clone while preserving read-only snapshots", () => {
  const f = fixture();
  const checkpoint = f.run("snapshot", true);
  f.project.sequences[1].videoTracks[0].clips[0].name = "Changed";
  const after = f.run();
  assert.match(
    f.run("restore", checkpoint.checkpointSignature, "sequence-a", "checkpoint-a", after.signature)
      .error,
    /checkpoint was edited/,
  );
  f.original.clone = () => false;
  const refused = f.run("snapshot", true);
  assert.equal(refused.ok, true);
  assert.equal(refused.checkpointId, null);
  assert.match(refused.checkpointError, /refused/);
});

test("caps clips and markers and never checkpoints a partial snapshot", () => {
  const f = fixture();
  f.original.videoTracks[0].clips = { numItems: 2001 };
  for (let n = 0; n < 2001; n++) f.original.videoTracks[0].clips[n] = f.clip;
  f.original.markers.getNextMarker = () => f.marker;
  const result = f.run("snapshot", true);
  assert.equal(result.snapshot.videoTracks[0].clips.length, 2000);
  assert.equal(result.snapshot.markers.length, 500);
  assert.equal(result.snapshot.truncated, true);
  assert.equal(result.checkpointId, null);
  assert.equal(f.project.sequences.numSequences, 1);
});

test("returns defensive errors for no project, invalid times and failed original reactivation", () => {
  const f = fixture();
  f.project.activeSequence = null;
  assert.equal(f.run().ok, false);
  f.project.activeSequence = f.original;
  f.clip.start.seconds = NaN;
  assert.match(f.run().error, /invalid timeline time/);
  f.clip.start.seconds = 1;
  f.project.openSequence = () => {};
  assert.match(f.run("snapshot", true).error, /reactivate/);
});

test("restoration failure returns an error and reopens the after version", () => {
  const f = fixture();
  const checkpoint = f.run("snapshot", true);
  const after = f.run();
  f.original.projectItem.moveBin = () => {
    throw new Error("bin failure");
  };
  assert.match(
    f.run("restore", checkpoint.checkpointSignature, "sequence-a", "checkpoint-a", after.signature)
      .error,
    /bin failure/,
  );
  assert.equal(f.project.activeSequence, f.original);
  assert.equal(f.original.name, "Main Edit");
});

test("failed restore rolls back both bin moves and names before reopening the original", () => {
  const f = fixture();
  const checkpoint = f.run("snapshot", true);
  const saved = f.project.sequences[1];
  const savedName = saved.name;
  const home = { name: "Edits", type: 2, children: { numItems: 1, 0: f.original.projectItem } };
  const checkpoints = { name: "Axis checkpoints", type: 2, children: { numItems: 1, 0: saved.projectItem } };
  f.original.projectItem.nodeId = "original-item";
  saved.projectItem.nodeId = "saved-item";
  f.project.rootItem.children = { numItems: 2, 0: home, 1: checkpoints };
  let originalBin = home;
  let savedBin = checkpoints;
  f.original.projectItem.moveBin = (value) => { originalBin = value; };
  saved.projectItem.moveBin = (value) => {
    savedBin = value;
    if (value === home) throw new Error("checkpoint bin move failed");
  };
  const after = f.run();
  const result = f.run("restore", checkpoint.checkpointSignature, "sequence-a", "checkpoint-a", after.signature);
  assert.match(result.error, /checkpoint bin move failed/);
  assert.equal(originalBin, home);
  assert.equal(savedBin, checkpoints);
  assert.equal(f.original.name, "Main Edit");
  assert.equal(saved.name, savedName);
  assert.equal(f.project.activeSequence, f.original);
});

test("a silently refused bin move cannot report a successful restore", () => {
  const f = fixture();
  const checkpoint = f.run("snapshot", true);
  const after = f.run();
  f.original.projectItem.moveBin = () => false;
  const result = f.run("restore", checkpoint.checkpointSignature, "sequence-a", "checkpoint-a", after.signature);
  assert.equal(result.ok, false);
  assert.match(result.error, /move/);
  assert.equal(f.project.activeSequence, f.original);
});

test("validates message arguments and parses malformed ExtendScript replies defensively", () => {
  const replies = [];
  const request = { type: "premiere.snapshot.request", requestId: "test", checkpoint: false };
  assert.equal(
    handle({ type: "other" }, null, () => {}),
    false,
  );
  handle({ ...request, checkpoint: "yes" }, {}, (reply) => replies.push(reply));
  handle(request, null, (reply) => replies.push(reply));
  for (const raw of [
    "EvalScript error.",
    "axis:{",
    "axis:null",
    'axis:{"ok":true}',
    'axis:{"ok":false}',
  ])
    handle(request, { evalScript: (_script, callback) => callback(raw) }, (reply) =>
      replies.push(reply),
    );
  assert.equal(replies.length, 7);
  assert.ok(replies.every((reply) => reply.ok === false && typeof reply.error === "string"));
});

test("escapes restore arguments before evaluating and rejects invalid restore requests", () => {
  const f = fixture();
  const checkpoint = f.run("snapshot", true);
  const after = f.run();
  const replies = [];
  const request = {
    type: "premiere.restore.request",
    requestId: "restore",
    sequenceId: "sequence-a",
    checkpointId: checkpoint.checkpointId,
    checkpointSignature: checkpoint.checkpointSignature,
    expectedSignature: after.signature,
    turnNumber: 1,
  };
  handle(
    request,
    {
      evalScript: (script, callback) =>
        callback(vm.runInNewContext(script, { app: { project: f.project }, JSON: undefined })),
    },
    (reply) => replies.push(reply),
  );
  assert.equal(replies.length, 1);
  assert.equal(replies[0].ok, true);
  handle({ ...request, turnNumber: -1 }, null, (reply) => replies.push(reply));
  assert.equal(replies[1].ok, false);
});
