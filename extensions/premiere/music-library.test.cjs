"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { operation, libraryFile } = require("./music-library.cjs");

test("music audition is read-only and streams a bounded real WAV at the requested offset", async () => {
  using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "axis-music-audition-"));
  const filename = path.join(temp.path, "sample.wav");
  const pcm = Buffer.alloc(8 * 8000 * 2);
  for (let i = 0; i < 8 * 8000; i++)
    pcm.writeInt16LE(Math.round(Math.sin((i * 2 * Math.PI * 220) / 8000) * 4000), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(16000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  const original = Buffer.concat([header, pcm]);
  fs.writeFileSync(filename, original);
  const result = await operation(
    { action: "audition", root: temp.path, path: filename, offset: 2 },
    __dirname,
  );
  assert.equal(result.ok, true);
  assert.match(result.dataUrl, /^data:audio\/wav;base64,/);
  const audio = Buffer.from(result.dataUrl.split(",")[1], "base64");
  assert.equal(audio.subarray(0, 4).toString(), "RIFF");
  assert.ok(audio.length >= 6 * 16000 * 2 && audio.length < 7 * 16000 * 2);
  assert.deepEqual(fs.readFileSync(filename), original);
});
test("music preview rejects paths outside the library, non-audio files and invalid offsets", async () => {
  using temp = fs.mkdtempDisposableSync(path.join(os.tmpdir(), "axis-music-path-"));
  const root = path.join(temp.path, "library");
  fs.mkdirSync(root);
  const outside = path.join(temp.path, "outside.wav");
  fs.writeFileSync(outside, "x");
  assert.throws(() => libraryFile(root, outside), /inside/);
  const text = path.join(root, "notes.txt");
  fs.writeFileSync(text, "x");
  assert.throws(() => libraryFile(root, text), /Unsupported/);
  const audio = path.join(root, "audio.wav");
  fs.writeFileSync(audio, "x");
  await assert.rejects(
    operation({ action: "audition", root, path: audio, offset: -1 }, __dirname),
    /Invalid/,
  );
});
