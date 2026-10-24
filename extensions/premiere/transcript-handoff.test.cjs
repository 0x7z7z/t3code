"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { loadTranscript } = require("./transcript-handoff.cjs");

function fixture(t) {
  const workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "axis-transcript-"));
  t.after(() => fs.rmSync(workspacePath, { recursive: true, force: true }));
  const config = { workspacePath };
  const request = {
    projectId: "D:/project|one.prproj",
    sequenceId: "../sequence:one",
    jobId: "job-1",
  };
  const load = (changes = {}) => loadTranscript(config, { ...request, ...changes }, __dirname);
  const filename = load().outputPath;
  const data = {
    version: 1,
    requestId: request.jobId,
    projectId: request.projectId,
    sequenceId: request.sequenceId,
    status: "complete",
    words: [{ word: "Goku", start: 0, end: 1 }],
  };
  const write = (value = data) => {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(filename, JSON.stringify(value));
  };
  return { config, request, load, filename, data, write, workspacePath };
}

test("only reads the fixed hashed workspace handoff and ignores old runs", (t) => {
  const f = fixture(t);
  assert.equal(f.load().content, null);
  assert.equal(path.relative(f.workspacePath, f.filename).split(path.sep).length, 3);
  f.write();
  assert.deepEqual(JSON.parse(f.load().content), f.data);
  assert.equal(f.load({ jobId: "another-job" }).content, null);
  assert.equal(f.load({ path: "../../secrets.json" }).outputPath, f.filename);
  assert.throws(() => f.load({ jobId: "../../secret" }), /Invalid/);
  assert.throws(() => f.load({ projectId: "\0" }), /Invalid/);
});

test("rejects mismatched identities, malformed, failed, and oversized handoffs", (t) => {
  const f = fixture(t);
  f.write({ ...f.data, sequenceId: "other" });
  assert.throws(f.load, /different project or sequence/);
  f.write({ ...f.data, status: "failed", error: "VO is offline" });
  assert.throws(f.load, /VO is offline/);
  fs.writeFileSync(f.filename, "{");
  assert.throws(f.load, /Invalid transcript handoff/);
  // A fresh job can still obtain its destination and overwrite a corrupt old result.
  assert.equal(f.load({ prepareOnly: true }).content, null);
  fs.writeFileSync(f.filename, Buffer.alloc(10000001));
  assert.throws(f.load, /10 MB/);
});

test("refuses directory traversal through a junction even when no result exists", (t) => {
  const f = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "axis-outside-"));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  fs.symlinkSync(outside, path.join(f.workspacePath, "axis-transcripts"), "junction");
  assert.throws(f.load, /without links/);
});

test("refuses a directory in place of a handoff", (t) => {
  const f = fixture(t);
  fs.mkdirSync(f.filename, { recursive: true });
  assert.throws(f.load);
});
