"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const exported = { exports: {} };
vm.runInNewContext(readFileSync(path.join(__dirname, "rangeCut.js"), "utf8"), { module: exported });
const { cutRange } = exported.exports;
const { parse } = require(
  require.resolve("acorn", { paths: [path.join(__dirname, "../../apps/desktop")] }),
);
const TICKS = 254016000000;

test("the range cut sent to Premiere parses as ES3", () => {
  assert.doesNotThrow(() => parse("(" + cutRange.toString() + ")", { ecmaVersion: 3 }));
});

function fixture({
  locked = false,
  transitions = false,
  noopRazor = false,
  noopMove = false,
  linkedLocked = false,
} = {}) {
  let id = 0;
  const time = (value) => ({ ticks: String(value), seconds: value / TICKS });
  function clip(start, end, sourceIn = 0) {
    let a = start * TICKS;
    let b = end * TICKS;
    const item = {
      nodeId: `clip-${++id}`,
      inPoint: time(sourceIn * TICKS),
      outPoint: time((sourceIn + end - start) * TICKS),
      get start() {
        return time(a);
      },
      set start(value) {
        if (!noopMove) a = Number(value);
      },
      get end() {
        return time(b);
      },
      set end(value) {
        if (!noopMove) b = Number(value);
      },
      getLinkedItems: () =>
        linkedLocked ? { numItems: 1, 0: lockedTrack.clips[0] } : { numItems: 0 },
      remove: (ripple) => {
        assert.equal(ripple, false);
        for (const track of tracks) {
          const index = track.clips.indexOf(item);
          if (index >= 0) track.clips.splice(index, 1);
        }
      },
    };
    return item;
  }
  function track(items, isLocked = false) {
    Object.defineProperty(items, "numItems", { get: () => items.length });
    const result = {
      clips: items,
      transitions: { numItems: transitions ? 1 : 0, 0: { end: time(8 * TICKS) } },
    };
    result.qe = {
      isLocked: () => isLocked,
      razor: (formatted) => {
        if (noopRazor) return;
        const point = Number(formatted) / TICKS;
        const original = items.find(
          (item) => item.start.seconds < point && item.end.seconds > point,
        );
        if (original) {
          const left = clip(original.start.seconds, point, original.inPoint.seconds);
          const right = clip(
            point,
            original.end.seconds,
            original.inPoint.seconds + point - original.start.seconds,
          );
          items.splice(items.indexOf(original), 1, left, right);
        }
      },
    };
    return result;
  }
  const video = track([clip(0, 10), clip(12, 14)]);
  const audio = track([clip(0, 10)]);
  const lockedTrack = track([clip(0, 14)], locked || linkedLocked);
  const tracks = [video, audio, lockedTrack];
  const sequence = {
    timebase: String(TICKS / 25),
    end: String(14 * TICKS),
    videoDisplayFormat: 100,
    videoTracks: { numTracks: 2, 0: video, 1: lockedTrack },
    audioTracks: { numTracks: 1, 0: audio },
    setPlayerPosition: (value) => {
      sequence.playhead = Number(value) / TICKS;
    },
  };
  const app = { project: { documentID: "project" }, enableQE: () => {} };
  const qe = {
    project: {
      getActiveSequence: () => ({
        getVideoTrackAt: (index) => [video, lockedTrack][index].qe,
        getAudioTrackAt: () => audio.qe,
      }),
    },
  };
  function Time() {
    const value = { ticks: "0", getFormatted: () => value.ticks };
    return value;
  }
  const run = (dryRun = false, range = { start: 2, end: 4, projectId: "project" }) =>
    vm.runInNewContext(`(${cutRange.toString()})(sequence,range,dryRun)`, {
      app,
      qe,
      Time,
      sequence,
      range,
      dryRun,
      JSON: undefined,
    });
  const positions = (track) =>
    track.clips.map((item) => [
      item.start.seconds,
      item.end.seconds,
      item.inPoint.seconds,
      item.outPoint.seconds,
    ]);
  return { run, video, audio, lockedTrack, sequence, positions };
}

test("razors and removes an interior range on every unlocked track, shifts once, preserves source timing and skips locked tracks", () => {
  const f = fixture({ locked: true });
  const locked = f.positions(f.lockedTrack);
  f.run();
  assert.deepEqual(f.positions(f.video), [
    [0, 2, 0, 2],
    [2, 8, 4, 10],
    [10, 12, 0, 2],
  ]);
  assert.deepEqual(f.positions(f.audio), [
    [0, 2, 0, 2],
    [2, 8, 4, 10],
  ]);
  assert.deepEqual(f.positions(f.lockedTrack), locked);
  assert.equal(f.sequence.playhead, 2);
});

test("dry run and invalid project/ranges leave every clip untouched", () => {
  const f = fixture();
  const before = f.positions(f.video);
  f.run(true);
  assert.deepEqual(f.positions(f.video), before);
  assert.throws(() => f.run(false, { start: 2, end: 4, projectId: "other" }), /project changed/);
  assert.throws(
    () => f.run(false, { start: 2, end: 20, projectId: "project" }),
    /inside the sequence/,
  );
  assert.deepEqual(f.positions(f.video), before);
});

test("refuses transitions and linked locked tracks during preflight", () => {
  for (const options of [{ transitions: true }, { linkedLocked: true }]) {
    const f = fixture(options);
    const before = f.positions(f.video);
    assert.throws(() => f.run(true), /transition|linked to a locked track/);
    assert.deepEqual(f.positions(f.video), before);
  }
});

test("detects silent QE razor and DOM movement failures", () => {
  assert.throws(() => fixture({ noopRazor: true }).run(), /did not razor/);
  assert.throws(() => fixture({ noopMove: true }).run(), /did not shift/);
});

test("closes a range consisting of gaps without deleting later clips", () => {
  const f = fixture({ locked: true });
  f.run(false, { start: 10, end: 12, projectId: "project" });
  assert.deepEqual(f.positions(f.video), [
    [0, 10, 0, 10],
    [10, 12, 0, 2],
  ]);
});

test("the CEP cut handler validates ranges and serializes the checkpoint and range operation without native JSON", () => {
  const window = {};
  const context = { window };
  for (const file of ["rangeCut.js", "snapshot.js"])
    vm.runInNewContext(readFileSync(path.join(__dirname, file), "utf8"), context);
  const request = {
    type: "premiere.cut.request",
    requestId: "cut-1",
    sequenceId: "sequence",
    projectId: "project",
    start: 2,
    end: 4,
  };
  let evaluations = 0;
  const replies = [];
  const cep = {
    evalScript: (script, reply) => {
      evaluations++;
      // Parsing the complete generated script catches broken function/argument composition.
      const raw = vm.runInNewContext(script, { app: { project: null }, JSON: undefined });
      reply(raw);
    },
  };
  assert.equal(
    window.AxisTimeline.handle({ ...request, end: NaN }, cep, (reply) => replies.push(reply)),
    true,
  );
  assert.equal(evaluations, 0);
  assert.equal(replies[0].ok, false);
  window.AxisTimeline.handle(request, cep, (reply) => replies.push(reply));
  assert.equal(evaluations, 1);
  assert.match(replies[1].error, /Open a sequence/);
});
