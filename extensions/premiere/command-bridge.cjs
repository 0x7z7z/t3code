"use strict";

var fs = require("fs");
var path = require("path");
var security = require("./bridge-directory-security.cjs");

function createCommandBridge(options) {
  var files = options.fs || fs;
  var clock = options.clock || {
    now: Date.now,
    setInterval: setInterval,
    clearInterval: clearInterval,
  };
  var engineId = options.engineId || require("crypto").randomBytes(12).toString("hex");
  var directory;
  var running = false;
  var pollTimer = null;
  var heartbeatTimer = null;
  var inFlight = null;
  var lastStatus = "";
  var directorySecurity =
    options.security ||
    security.createBridgeDirectorySecurity({
      fs: files,
      path: path,
      process: process,
      Buffer: Buffer,
      childProcess: require("child_process"),
    });

  function status(state, message) {
    var key = state + ":" + message;
    if (lastStatus === key) return;
    lastStatus = key;
    if (options.onStatus) options.onStatus({ state: state, message: message });
  }

  function remove(file) {
    try {
      files.unlinkSync(file);
    } catch (error) {
      if (error.code !== "ENOENT") status("error", "Bridge cleanup failed: " + error.message);
    }
  }

  function publish(file, content, suffix) {
    var staged = file + suffix;
    try {
      files.writeFileSync(staged, content, "utf-8");
      files.renameSync(staged, file);
      return true;
    } catch (error) {
      remove(staged);
      status("error", "Bridge publish failed: " + error.message);
      return false;
    }
  }

  function lockPath() {
    return path.join(directory, "axis-bridge-owner.json");
  }

  function readOwner() {
    try {
      var raw = files.readFileSync(lockPath(), "utf-8");
      var value = JSON.parse(raw);
      return {
        raw: raw,
        value: value && typeof value === "object" ? value : {},
        mtime: files.statSync(lockPath()).mtimeMs,
      };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      // An interrupted write is reclaimable only once its file age exceeds the lease.
      if (error instanceof SyntaxError)
        return { raw: null, value: {}, mtime: files.statSync(lockPath()).mtimeMs };
      throw error;
    }
  }

  function ownsDirectory() {
    var owner = readOwner();
    return !!owner && owner.value.ownerId === engineId;
  }

  // Panel and Custom entries are separate CEP extensions, so assume separate JS
  // contexts. This lease suppresses redundant Axis polling only. The connector's
  // atomic per-command rename remains the execution-once guarantee, including
  // during a stale-owner takeover or when a legacy connector shares the directory.
  function renewOwnership() {
    var owner = readOwner();
    if (owner && owner.value.ownerId !== engineId) {
      var timestamp =
        typeof owner.value.timestamp === "number" && isFinite(owner.value.timestamp)
          ? owner.value.timestamp
          : owner.mtime;
      if (clock.now() - timestamp <= 5000) return false;
      var latest = readOwner();
      if (!latest || latest.raw !== owner.raw || latest.mtime !== owner.mtime) return false;
      remove(lockPath());
      owner = null;
    }
    var descriptor;
    try {
      // Refresh through the opened inode, so a resumed old owner cannot overwrite
      // a successor's lock after its own file has been removed during takeover.
      descriptor = files.openSync(lockPath(), owner ? "r+" : "wx", 0o600);
      if (owner) {
        var current = JSON.parse(files.readFileSync(descriptor, "utf-8"));
        if (current.ownerId !== engineId) return false;
      }
      var content = JSON.stringify({ ownerId: engineId, timestamp: clock.now() });
      files.writeSync(descriptor, content, 0, "utf-8");
      files.ftruncateSync(descriptor, Buffer.byteLength(content));
    } catch (error) {
      if (error.code === "EEXIST" || error.code === "ENOENT") return false;
      throw error;
    } finally {
      if (descriptor !== undefined) files.closeSync(descriptor);
    }
    return ownsDirectory();
  }

  function writeHeartbeat(state) {
    return publish(
      path.join(directory, "bridge-heartbeat.json"),
      JSON.stringify({ protocolVersion: 1, state: state }),
      "." + engineId + ".staged",
    );
  }

  function heartbeat() {
    try {
      if (!renewOwnership()) {
        status("standby", "Bridge active in another Axis instance");
        return;
      }
      if (writeHeartbeat("running")) status("running", "Bridge running");
    } catch (error) {
      status("error", "Bridge ownership failed: " + error.message);
    }
  }

  function responseFor(result) {
    if (!result || result === "undefined" || result === "null") {
      return JSON.stringify({
        success: false,
        error:
          "The bridge received an empty result from evalScript (got " +
          typeof result +
          "). The script may not have run. Close and reopen the Axis panel, or reinstall the extension.",
      });
    }
    try {
      return JSON.stringify(JSON.parse(result));
    } catch (_error) {
      return JSON.stringify(
        result === "EvalScript error." || result.indexOf("Error") === 0
          ? { success: false, error: result }
          : { success: true, data: result },
      );
    }
  }

  function processOne(name) {
    var command = path.join(directory, name);
    var claim = command + "." + engineId + ".claimed";
    try {
      files.renameSync(command, claim);
    } catch (error) {
      if (error.code !== "ENOENT") status("error", "Bridge claim failed: " + error.message);
      return;
    }
    var script;
    try {
      script = files.readFileSync(claim, "utf-8");
    } catch (error) {
      status("error", "Bridge could not read command: " + error.message);
    }
    remove(claim);
    if (!script) return;

    var id = name.replace("cmd_", "").replace(".jsx", "");
    var response = path.join(directory, "res_" + id + ".json");
    var busy = path.join(directory, "busy_" + id + ".json");
    var started = clock.now();
    var flight = { busy: busy, timer: null, finished: false };
    inFlight = flight;
    flight.timer = clock.setInterval(function () {
      try {
        files.writeFileSync(
          busy,
          JSON.stringify({ id: id, elapsedMs: clock.now() - started }),
          "utf-8",
        );
      } catch (error) {
        status("error", "Bridge busy update failed: " + error.message);
      }
    }, 2000);

    function finish(result) {
      if (flight.finished) return;
      flight.finished = true;
      clock.clearInterval(flight.timer);
      remove(busy);
      publish(response, responseFor(result), ".staged");
      inFlight = null;
      if (running) processCommands();
    }

    // Do not time out or retry evalScript locally: CEP cannot cancel an edit.
    // The server owns the timeout and hard cap; busy files keep it informed while
    // a modal dialog or long operation delays the callback (file-bridge.ts:612-717).
    try {
      options.evalScript(script, finish);
    } catch (error) {
      status("error", "Bridge dispatch failed: " + error.message);
      finish("Error: " + error.message);
    }
  }

  function processCommands() {
    if (!running || inFlight) return;
    try {
      if (!ownsDirectory()) return;
      var commands = files
        .readdirSync(directory)
        .filter(function (name) {
          return name.indexOf("cmd_") === 0 && name.slice(-4) === ".jsx";
        })
        .sort();
      if (commands.length) processOne(commands[0]);
    } catch (error) {
      status("error", "Bridge polling failed: " + error.message);
    }
  }

  function start() {
    if (running) return;
    if (typeof options.evalScript !== "function")
      throw new Error("Premiere evalScript is unavailable");
    directory = directorySecurity.ensurePrivateBridgeDirectory(options.bridgePath);
    running = true;
    heartbeat();
    heartbeatTimer = clock.setInterval(heartbeat, 1000);
    pollTimer = clock.setInterval(processCommands, 200);
    processCommands();
  }

  function stop() {
    if (!running) return;
    running = false;
    clock.clearInterval(pollTimer);
    clock.clearInterval(heartbeatTimer);
    pollTimer = heartbeatTimer = null;
    if (inFlight) {
      clock.clearInterval(inFlight.timer);
      remove(inFlight.busy);
    }
    try {
      if (ownsDirectory()) {
        writeHeartbeat("waiting");
        remove(lockPath());
      }
    } catch (error) {
      status("error", "Bridge shutdown failed: " + error.message);
      return;
    }
    status("stopped", "Bridge stopped");
  }

  return { start: start, stop: stop };
}

module.exports = { createCommandBridge: createCommandBridge };
