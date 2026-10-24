(function () {
  "use strict";
  var listeners = [];
  var bridge;
  var current = { state: "starting", message: "Bridge starting" };

  function update(value) {
    current = value;
    listeners.forEach(function (listener) {
      listener(value);
    });
  }

  function start() {
    if (bridge) return;
    try {
      var nodeRequire =
        typeof require === "function" ? require : window.cep_node && window.cep_node.require;
      if (!nodeRequire || !window.__adobe_cep__) throw new Error("Open Axis inside Premiere Pro");
      var path = nodeRequire("path");
      var directory = decodeURIComponent(location.pathname)
        .replace(/^\/(?:([A-Za-z]:))/, "$1")
        .replace(/\/[^/]*$/, "");
      var config = JSON.parse(
        nodeRequire("fs").readFileSync(path.join(directory, "config.json"), "utf8"),
      );
      bridge = nodeRequire(path.join(directory, "command-bridge.cjs")).createCommandBridge({
        bridgePath: config.bridgePath,
        evalScript: function (script, callback) {
          window.__adobe_cep__.evalScript(script, callback);
        },
        onStatus: update,
      });
      bridge.start();
    } catch (error) {
      bridge = null;
      update({ state: "error", message: "Bridge: " + error.message });
    }
  }

  window.AxisPremiereBridge = {
    subscribe: function (listener) {
      listeners.push(listener);
      listener(current);
    },
    retry: function () {
      if (current.state === "error" && !bridge) start();
    },
  };
  window.addEventListener("unload", function () {
    if (bridge) bridge.stop();
  });
  start();
})();
