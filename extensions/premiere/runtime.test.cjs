"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { mkdtemp, writeFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const { validateConfig, probeBackend, pairBackend } = require("./runtime.cjs");

function config(backendUrl, directory) {
  return {
    backendUrl,
    nodePath: process.execPath,
    serverPath: path.join(directory, "server.mjs"),
    homeDir: directory,
    workspacePath: directory,
  };
}

test("only accepts a loopback origin without credentials or a URL path", () => {
  for (const url of [
    "https://example.com/",
    "http://192.168.1.4/",
    "http://127.0.0.1/path",
    "http://user@localhost/",
    "http://localhost/?token=x",
  ]) {
    assert.throws(() => validateConfig(config(url, tmpdir())));
  }
  assert.equal(
    validateConfig(config("http://127.0.0.1:5739/", tmpdir())).backendUrl,
    "http://127.0.0.1:5739/",
  );
});

test("distinguishes this fork from another local service", async (t) => {
  let valid = true;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(valid ? { protocol: 1 } : { application: "other" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const settings = config(`http://127.0.0.1:${server.address().port}/`, tmpdir());
  await probeBackend(settings);
  valid = false;
  await assert.rejects(probeBackend(settings), /different server/);
});

test("pairs through the supported CLI and rejects a different server origin", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "premiere-pair-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = config("http://127.0.0.1:5739/", directory);
  await writeFile(
    settings.serverPath,
    'console.log("Pairing URL: http://127.0.0.1:5739/pair?token=fixture-only")',
  );
  const paired = new URL(await pairBackend(settings));
  assert.equal(paired.origin, "http://127.0.0.1:5739");
  assert.equal(paired.searchParams.get("host"), settings.backendUrl);
  assert.equal(paired.searchParams.get("token"), "fixture-only");
  await writeFile(
    settings.serverPath,
    'console.log("Pairing URL: http://127.0.0.1:3773/pair?token=fixture-only")',
  );
  await assert.rejects(pairBackend(settings), /unexpected pairing address/);
});
