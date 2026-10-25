"use strict";

var fs = require("fs");
var http = require("http");
var childProcess = require("child_process");
var path = require("path");
var pendingStarts = Object.create(null);

function validateConfig(config) {
  if (!config || typeof config !== "object")
    throw new Error("Install the Premiere extension before opening it.");
  var url = new URL(config.backendUrl);
  if (
    url.protocol !== "http:" ||
    !/^(127\.0\.0\.1|localhost)$/.test(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("The Premiere backend must use a local HTTP origin.");
  }
  ["nodePath", "serverPath", "homeDir", "workspacePath", "connectorPath", "bridgePath"].forEach(
    function (key) {
      if (typeof config[key] !== "string" || !config[key])
        throw new Error("Missing extension setting: " + key);
    },
  );
  return config;
}

function probeBackend(config) {
  return new Promise(function (resolve, reject) {
    // Health checks must not reuse a socket belonging to a backend that just died.
    var request = http.get(
      config.backendUrl + "premiere-extension.json",
      { agent: false },
      function (response) {
        var body = "";
        response.setEncoding("utf8");
        response.on("data", function (chunk) {
          body += chunk;
          if (body.length > 4096) request.destroy(new Error("Unexpected backend response."));
        });
        response.on("error", reject);
        response.on("end", function () {
          if (response.statusCode === 503 && response.headers["retry-after"]) {
            var starting = new Error("The local backend is still starting.");
            starting.code = "AXIS_BACKEND_STARTING";
            reject(starting);
            return;
          }
          try {
            if (response.statusCode !== 200 || JSON.parse(body).protocol !== 1) {
              throw new Error(
                "This port belongs to a different server. Close Premiere and rerun the Axis installer to select a free local port. Your conversations are kept.",
              );
            }
            resolve();
          } catch {
            reject(
              new Error(
                "This port belongs to a different server. Close Premiere and rerun the Axis installer to select a free local port. Your conversations are kept.",
              ),
            );
          }
        });
      },
    );
    request.setTimeout(2500, function () {
      request.destroy(new Error("The local backend did not respond."));
    });
    request.on("error", reject);
  });
}

function startBackend(config) {
  if (!fs.existsSync(config.nodePath))
    throw new Error(
      "The Axis runtime is missing. Check Windows Security > Protection history for a quarantined Axis file, then reinstall Axis from your trusted installer. Your conversations will be kept.",
    );
  if (!fs.existsSync(config.serverPath))
    throw new Error(
      "The Axis backend is missing. Reinstall Axis from your trusted installer. Your conversations will be kept.",
    );
  if (!fs.existsSync(config.connectorPath))
    throw new Error("The bundled Premiere connector is missing. Reinstall the extension.");
  fs.mkdirSync(config.homeDir, { recursive: true });
  var url = new URL(config.backendUrl);
  var environment = Object.assign({}, process.env);
  if (config.runtimeRoot) {
    var pathKey =
      Object.keys(environment).find(function (key) {
        return key.toLowerCase() === "path";
      }) || "PATH";
    environment[pathKey] = [
      path.dirname(config.nodePath),
      path.join(config.runtimeRoot, "git/cmd"),
      environment[pathKey] || "",
    ].join(path.delimiter);
  }
  var child = childProcess.spawn(
    config.nodePath,
    [
      config.serverPath,
      "start",
      "--no-browser",
      "--auto-bootstrap-project-from-cwd",
      "--base-dir",
      config.homeDir,
      "--host",
      url.hostname,
      "--port",
      url.port || "80",
    ],
    {
      cwd: config.workspacePath,
      windowsHide: true,
      detached: true,
      stdio: "ignore",
      env: Object.assign(environment, {
        T3CODE_PREMIERE_MCP: JSON.stringify({
          workspacePath: config.workspacePath,
          command: config.nodePath,
          args: [config.connectorPath],
          env: { PREMIERE_TEMP_DIR: config.bridgePath },
        }),
      }),
    },
  );
  // The backend outlives the panel so closing it never interrupts an editing task.
  child.unref();
  if (config.runtimeRoot && child.pid)
    fs.writeFileSync(
      path.join(config.runtimeRoot, "backend-process.json"),
      JSON.stringify({ pid: child.pid, nodePath: config.nodePath, serverPath: config.serverPath }),
    );
  return child;
}

// Only a refused connection permits spawning. A busy or incompatible service
// must never trigger a competing backend, even while it is still starting.
function ensureBackend(config) {
  var key = config.backendUrl;
  if (pendingStarts[key]) return pendingStarts[key];
  var lock;
  var ownsLock = false;
  var childError;
  function wait(attempt) {
    return probeBackend(config).catch(function (error) {
      if (childError) throw childError;
      if (
        attempt >= 120 ||
        (error.code !== "ECONNREFUSED" && /different server/.test(error.message))
      )
        throw error;
      return new Promise(function (resolve) {
        setTimeout(resolve, 500);
      }).then(function () {
        return wait(attempt + 1);
      });
    });
  }
  var pending = probeBackend(config).catch(function (error) {
    if (error.code === "AXIS_BACKEND_STARTING") return wait(0);
    if (error.code !== "ECONNREFUSED") throw error;
    fs.mkdirSync(config.homeDir, { recursive: true });
    lock = path.join(config.homeDir, "axis-backend-start.lock");
    try {
      // The lease spans separate CEP Node contexts as well as concurrent calls.
      if (fs.existsSync(lock) && Date.now() - fs.statSync(lock).mtimeMs > 90000)
        fs.unlinkSync(lock);
      var descriptor = fs.openSync(lock, "wx");
      fs.closeSync(descriptor);
      ownsLock = true;
    } catch (lockError) {
      if (lockError.code !== "EEXIST") throw lockError;
    }
    if (!ownsLock) return wait(0);
    return probeBackend(config).catch(function (probeError) {
      if (probeError.code !== "ECONNREFUSED") throw probeError;
      var child = startBackend(config);
      child.on("error", function (error) {
        childError = error;
      });
      child.on("exit", function (code) {
        childError = new Error(
          "Axis backend exited during startup (" + code + "). Reinstall Axis or retry.",
        );
      });
      return wait(0);
    });
  });
  pendingStarts[key] = pending.then(
    function () {
      if (ownsLock) fs.unlinkSync(lock);
      delete pendingStarts[key];
    },
    function (error) {
      if (ownsLock) fs.unlinkSync(lock);
      delete pendingStarts[key];
      throw error;
    },
  );
  return pendingStarts[key];
}

function pairBackend(config) {
  return new Promise(function (resolve, reject) {
    childProcess.execFile(
      config.nodePath,
      [config.serverPath, "pair", "--base-dir", config.homeDir],
      {
        cwd: config.workspacePath,
        windowsHide: true,
        timeout: 20000,
        maxBuffer: 65536,
      },
      function (error, stdout) {
        if (error)
          return reject(
            new Error("Could not pair with the local backend. Retry after it finishes starting."),
          );
        var match = /Pairing URL:\s*(http:\/\/[^\s]+)/.exec(stdout);
        if (!match) return reject(new Error("The backend did not return a pairing address."));
        var url;
        try {
          url = new URL(match[1]);
        } catch {
          return reject(new Error("The backend returned an invalid pairing address."));
        }
        if (url.origin !== new URL(config.backendUrl).origin || url.pathname !== "/pair") {
          return reject(new Error("The backend returned an unexpected pairing address."));
        }
        url.searchParams.set("host", config.backendUrl);
        url.searchParams.set("label", "Axis");
        url.pathname = "/premiere.html";
        // This URL contains a one-use credential. Keep it in memory and out of logs.
        resolve(url.href);
      },
    );
  });
}

module.exports = {
  validateConfig: validateConfig,
  probeBackend: probeBackend,
  startBackend: startBackend,
  ensureBackend: ensureBackend,
  pairBackend: pairBackend,
};
