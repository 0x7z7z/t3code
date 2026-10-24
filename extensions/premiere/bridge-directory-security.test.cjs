"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createBridgeDirectorySecurity } = require("./bridge-directory-security.cjs");

function status(overrides = {}) {
  return {
    uid: 1000,
    mode: 0o700,
    isSymbolicLink: () => false,
    isDirectory: () => true,
    ...overrides,
  };
}

function windows(overrides = {}) {
  return createBridgeDirectorySecurity({
    fs: { mkdirSync() {}, lstatSync: () => status() },
    path: path.win32,
    platform: "win32",
    inspectWindowsAcl: () => ({
      ownerSid: "owner",
      currentUserSid: "owner",
      unsafeWriteAces: [],
      ...overrides,
    }),
  });
}

test("Windows accepts only current-user-owned directories without untrusted writers or replaceable ancestors", () => {
  const directory = "C:\\Users\\editor\\AxisBridge";
  assert.equal(windows().ensurePrivateBridgeDirectory(directory), directory);
  assert.throws(
    () => windows({ ownerSid: "other" }).ensurePrivateBridgeDirectory(directory),
    /not owned/,
  );
  assert.throws(
    () =>
      windows({ unsafeWriteAces: [{ sid: "Everyone" }] }).ensurePrivateBridgeDirectory(directory),
    /untrusted identities/,
  );
  assert.throws(
    () =>
      windows({
        unsafeAncestorEntries: [{ path: "C:\\shared", sid: "Everyone" }],
      }).ensurePrivateBridgeDirectory(directory),
    /replaceable ancestor/,
  );
});

test("Windows ACL inspection uses the exact path through the environment and initializes only new directories", () => {
  [false, true].forEach((created) => {
    const directory = "C:\\Users\\editor & reviewer\\AxisBridge";
    const calls = [];
    const security = createBridgeDirectorySecurity({
      fs: {
        mkdirSync: () => (created ? directory : undefined),
        lstatSync: () => status(),
        readdirSync: () => [],
      },
      path: path.win32,
      platform: "win32",
      Buffer,
      process: { env: { SYSTEMROOT: "C:\\Windows" } },
      childProcess: {
        execFileSync: (...args) => {
          calls.push(args);
          return JSON.stringify({
            ownerSid: "owner",
            currentUserSid: "owner",
            unsafeWriteAces: [],
          });
        },
      },
    });
    assert.equal(security.ensurePrivateBridgeDirectory(directory), directory);
    const [command, args, options] = calls[0];
    assert.equal(command, "powershell.exe");
    assert.ok(!args.includes(directory));
    assert.equal(options.env.PREMIERE_MCP_ACL_PATH, directory);
    assert.equal(options.env.PREMIERE_MCP_ACL_INITIALIZE, created ? "1" : "0");
    assert.equal(options.timeout, 5000);
    assert.equal(options.windowsHide, true);
  });
});

test("rejects links, non-directories, foreign POSIX owners and previously writable directories", () => {
  [
    [{ isSymbolicLink: () => true }, /symbolic link or junction/],
    [{ isDirectory: () => false }, /not a directory/],
    [{ uid: 1001 }, /another user/],
    [{ mode: 0o777 }, /writable by other users/],
  ].forEach(([overrides, expected]) => {
    const security = createBridgeDirectorySecurity({
      fs: { mkdirSync() {}, lstatSync: () => status(overrides) },
      path: path.posix,
      platform: "linux",
      currentUid: 1000,
    });
    assert.throws(() => security.ensurePrivateBridgeDirectory("/home/editor/axis"), expected);
  });
});

test("clamps POSIX read permissions but rejects a replaceable ancestor", () => {
  let mode = 0o755;
  const changes = [];
  const directory = "/home/editor/axis";
  const security = createBridgeDirectorySecurity({
    fs: {
      mkdirSync() {},
      lstatSync: (value) => status({ mode: value === directory ? mode : 0o755 }),
      chmodSync: (value, next) => {
        changes.push([value, next]);
        mode = next;
      },
    },
    path: path.posix,
    platform: "linux",
    currentUid: 1000,
  });
  assert.equal(security.ensurePrivateBridgeDirectory(directory), directory);
  assert.deepEqual(changes, [[directory, 0o700]]);
  const unsafe = createBridgeDirectorySecurity({
    fs: {
      mkdirSync() {},
      lstatSync: (value) => status({ mode: value === directory ? 0o700 : 0o777 }),
    },
    path: path.posix,
    platform: "linux",
    currentUid: 1000,
  });
  assert.throws(() => unsafe.ensurePrivateBridgeDirectory(directory), /replaceable ancestor/);
});
