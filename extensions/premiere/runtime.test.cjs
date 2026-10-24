"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { mkdir, mkdtemp, writeFile, rm } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const path = require("node:path");
const {
  validateConfig,
  probeBackend,
  pairBackend,
  startBackend,
  ensureBackend,
} = require("./runtime.cjs");
const { once } = require("node:events");
const { readFile } = require("node:fs/promises");

function config(backendUrl, directory) {
  return {
    backendUrl,
    nodePath: process.execPath,
    serverPath: path.join(directory, "server.mjs"),
    homeDir: directory,
    workspacePath: directory,
    connectorPath: path.join(directory, "connector", "dist", "index.mjs"),
    bridgePath: path.join(directory, "bridge"),
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
  assert.equal(paired.searchParams.get("label"), "Axis");
  await writeFile(
    settings.serverPath,
    'console.log("Pairing URL: http://127.0.0.1:3773/pair?token=fixture-only")',
  );
  await assert.rejects(pairBackend(settings), /unexpected pairing address/);
});

test("starts the dedicated backend with the installed connector and inherited environment", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "premiere-start-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = config("http://127.0.0.1:5739/", directory);
  await mkdir(path.dirname(settings.connectorPath), { recursive: true });
  await writeFile(settings.connectorPath, "// installed connector");
  const resultPath = path.join(directory, "started.json");
  await writeFile(
    settings.serverPath,
    `import { writeFileSync } from 'node:fs';
    writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ connector: JSON.parse(process.env.T3CODE_PREMIERE_MCP), inherited: process.env.PATH }));`,
  );
  const child = startBackend(settings);
  const [code] = await once(child, "exit");
  assert.equal(code, 0);
  const result = JSON.parse(await readFile(resultPath, "utf8"));
  assert.deepEqual(result.connector, {
    workspacePath: settings.workspacePath,
    command: settings.nodePath,
    args: [settings.connectorPath],
    env: { PREMIERE_TEMP_DIR: settings.bridgePath },
  });
  assert.equal(result.inherited, process.env.PATH);
});

test("reports a missing bundled connector before launching the backend", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "premiere-missing-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const settings = config("http://127.0.0.1:5739/", directory);
  await writeFile(settings.serverPath, 'throw new Error("must not start");');
  assert.throws(() => startBackend(settings), /bundled Premiere connector is missing/);
});

test("reuses a running backend and refuses another service without spawning", async (t) => {
  let protocol = 1;
  const server = createServer((_request, response) => response.end(JSON.stringify({ protocol })));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  // Deliberately missing executables: neither path may attempt to spawn.
  const settings = config(`http://127.0.0.1:${server.address().port}/`, "missing-runtime");
  await Promise.all([ensureBackend(settings), ensureBackend(settings)]);
  protocol = 2;
  await assert.rejects(ensureBackend(settings), /different server/);
});

test("waits for the backend's startup 503 response without launching another process", async (t) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests++;
    if (requests < 3) {
      response.writeHead(503, { "Retry-After": "1" });
      response.end();
    } else response.end('{"protocol":1}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await ensureBackend(config(`http://127.0.0.1:${server.address().port}/`, "missing-runtime"));
  assert.equal(requests, 3);
});

test("concurrent starts launch once and a dead backend can restart with packaged PATH", async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "axis-recovery-"));
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const settings = config(`http://127.0.0.1:${port}/`, directory);
  settings.runtimeRoot = directory;
  await mkdir(path.dirname(settings.connectorPath), { recursive: true });
  await writeFile(settings.connectorPath, "// connector");
  const resultPath = path.join(directory, "starts.jsonl");
  await writeFile(
    settings.serverPath,
    `
    import { appendFileSync } from 'node:fs';
    import { createServer } from 'node:http';
    appendFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ pid: process.pid, path: process.env.PATH }) + '\\n');
    createServer((req, res) => res.end('{"protocol":1}')).listen(${port}, '127.0.0.1');
  `,
  );
  const childProcess = require("node:child_process");
  const original = childProcess.spawn;
  const children = [];
  childProcess.spawn = (...args) => {
    const child = original(...args);
    children.push(child);
    return child;
  };
  t.after(async () => {
    childProcess.spawn = original;
    for (const child of children)
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        await exited;
      }
    await rm(directory, { recursive: true, force: true });
  });
  await Promise.all([ensureBackend(settings), ensureBackend(settings), ensureBackend(settings)]);
  assert.equal(children.length, 1);
  const exited = once(children[0], "exit");
  children[0].kill();
  await exited;
  await ensureBackend(settings);
  assert.equal(children.length, 2);
  const starts = (await readFile(resultPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(starts.length, 2);
  assert.ok(
    starts[0].path.startsWith(
      path.dirname(settings.nodePath) + path.delimiter + path.join(directory, "git/cmd"),
    ),
  );
});
