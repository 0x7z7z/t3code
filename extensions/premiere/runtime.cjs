"use strict";

var fs = require("fs");
var http = require("http");
var childProcess = require("child_process");

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
    var request = http.get(config.backendUrl + "premiere-extension.json", function (response) {
      var body = "";
      response.setEncoding("utf8");
      response.on("data", function (chunk) {
        body += chunk;
        if (body.length > 4096) request.destroy(new Error("Unexpected backend response."));
      });
      response.on("error", reject);
      response.on("end", function () {
        try {
          if (response.statusCode !== 200 || JSON.parse(body).protocol !== 1) {
            throw new Error(
              "This port belongs to a different server. Choose another port when installing.",
            );
          }
          resolve();
        } catch {
          reject(
            new Error(
              "This port belongs to a different server. Choose another port when installing.",
            ),
          );
        }
      });
    });
    request.setTimeout(2500, function () {
      request.destroy(new Error("The local backend did not respond."));
    });
    request.on("error", reject);
  });
}

function startBackend(config) {
  if (!fs.existsSync(config.serverPath))
    throw new Error("Build the backend first with vp run --filter t3 build.");
  if (!fs.existsSync(config.connectorPath))
    throw new Error("The bundled Premiere connector is missing. Reinstall the extension.");
  fs.mkdirSync(config.homeDir, { recursive: true });
  var url = new URL(config.backendUrl);
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
      env: Object.assign({}, process.env, {
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
  return child;
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
        var url = new URL(match[1]);
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
  pairBackend: pairBackend,
};
