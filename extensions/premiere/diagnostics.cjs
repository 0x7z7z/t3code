"use strict";

var fs = require("fs");
var path = require("path");
var childProcess = require("child_process");

function execute(command, args) {
  return new Promise(function (resolve) {
    childProcess.execFile(
      command,
      args,
      { windowsHide: true, timeout: 3500, maxBuffer: 16384 },
      function (error, stdout) {
        resolve(error ? null : stdout.trim());
      },
    );
  });
}

async function transcriptionStatus(run) {
  run = run || execute;
  // The launcher avoids PATH refresh problems after a per-user Python install.
  for (var candidate of [
    { command: "py", args: ["-3.12"] },
    { command: "python", args: [] },
  ]) {
    var output = await run(
      candidate.command,
      candidate.args.concat([
        "-c",
        'import sys,importlib.util,json; print(json.dumps({"version":sys.version.split()[0],"path":sys.executable,"whisperx":importlib.util.find_spec("whisperx") is not None}))',
      ]),
    );
    try {
      var result = JSON.parse(output);
      if (result && typeof result.path === "string" && typeof result.whisperx === "boolean")
        return result;
    } catch {
      /* A Windows Store alias or a broken Python is not an installed interpreter. */
    }
  }
  return { version: null, path: null, whisperx: false };
}

async function collect(config, directory, probe) {
  var backend = "unavailable";
  try {
    await probe(config);
    backend = "reachable";
  } catch {
    /* Report stays available offline. */
  }
  var release = {};
  try {
    release = JSON.parse(fs.readFileSync(path.join(config.runtimeRoot, "release.json"), "utf8"));
  } catch {
    /* Development installs have no release marker. */
  }
  var versions = await Promise.all([
    execute(config.nodePath, ["--version"]),
    config.runtimeRoot
      ? execute(path.join(config.runtimeRoot, "git/cmd/git.exe"), ["--version"])
      : null,
    transcriptionStatus(),
    execute("ffmpeg", ["-version"]),
  ]);
  return {
    axis: release.buildId || "development",
    node: versions[0],
    nodePath: config.nodePath,
    git: versions[1],
    gitPath: config.runtimeRoot ? path.join(config.runtimeRoot, "git/cmd/git.exe") : null,
    serverPath: config.serverPath,
    backend: backend,
    backendUrl: config.backendUrl,
    extensionPath: directory,
    runtimePath: config.runtimeRoot || null,
    dataPath: config.homeDir,
    workspacePath: config.workspacePath,
    bridgePath: config.bridgePath,
    python: versions[2],
    ffmpeg: versions[3] ? versions[3].split("\n")[0] : null,
  };
}

module.exports = { collect: collect, transcriptionStatus: transcriptionStatus };
