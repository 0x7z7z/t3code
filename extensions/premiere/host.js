(function () {
  "use strict";
  var frame = document.getElementById("workspace");
  var connection = document.getElementById("connection");
  var startup = document.getElementById("startup");
  var retry = document.getElementById("retry");
  var backendOrigin = null;
  var connecting = false;
  var contextCallbacks = [];
  var readingContext = false;
  var timer = null;
  var nodeRequire =
    typeof require === "function" ? require : window.cep_node && window.cep_node.require;
  var runtime;
  var config;

  function status(state, message) {
    connection.setAttribute("data-state", state);
    connection.textContent = message;
  }

  function readContext(callback) {
    if (!window.__adobe_cep__) return callback(null);
    contextCallbacks.push(callback);
    if (readingContext) return;
    readingContext = true;
    var script =
      '(function(){var p=app.project;if(!p||!p.activeSequence)return "premiere:none";var s=p.activeSequence;var d="";try{d=String(p.documentID||"");}catch(e){}var fps=254016000000/parseFloat(s.timebase);var v=[p.name,p.path,d,s.name,s.sequenceID,String(fps),String(s.getPlayerPosition().seconds)];for(var i=0;i<v.length;i++)v[i]=encodeURIComponent(String(v[i]===undefined?"":v[i]));return "premiere:"+v.join("|");}())';
    window.__adobe_cep__.evalScript(script, function (raw) {
      var next = null;
      try {
        if (String(raw).indexOf("premiere:") === 0 && raw !== "premiere:none") {
          var fields = raw.slice(9).split("|").map(decodeURIComponent);
          if (fields.length === 7 && Number(fields[5]) > 0 && isFinite(Number(fields[6]))) {
            next = {
              projectName: fields[0],
              projectPath: fields[1],
              projectDocumentId: fields[2],
              sequenceName: fields[3],
              sequenceId: fields[4],
              fps: Number(fields[5]),
              playheadSeconds: Number(fields[6]),
            };
          }
        }
      } catch {
        next = null;
      }
      document.getElementById("project").textContent = next
        ? next.projectName
        : "Premiere Assistant";
      document.getElementById("sequence").textContent = next
        ? next.sequenceName + " · " + Math.round(next.fps * 100) / 100 + " fps"
        : "Open a sequence to attach timeline context";
      readingContext = false;
      var callbacks = contextCallbacks;
      contextCallbacks = [];
      callbacks.forEach(function (notify) {
        notify(next);
      });
    });
  }

  function publishContext(requestId) {
    readContext(function (context) {
      if (backendOrigin && frame.contentWindow)
        frame.contentWindow.postMessage(
          { type: "premiere.context", protocol: 1, requestId: requestId || null, context: context },
          backendOrigin,
        );
    });
  }

  window.addEventListener("message", function (event) {
    if (
      event.source !== frame.contentWindow ||
      event.origin !== backendOrigin ||
      !event.data ||
      event.data.protocol !== 1
    )
      return;
    if (event.data.type === "premiere.ready" || event.data.type === "premiere.context.request") {
      publishContext(typeof event.data.requestId === "string" ? event.data.requestId : null);
      if (event.data.type === "premiere.ready") {
        startup.hidden = true;
        frame.hidden = false;
        status("ready", "Connected");
      }
    }
    if (
      event.data.type === "premiere.seek" &&
      window.__adobe_cep__ &&
      typeof event.data.seconds === "number" &&
      isFinite(event.data.seconds) &&
      event.data.seconds >= 0 &&
      typeof event.data.sequenceId === "string"
    ) {
      // Snap to a whole frame of the active sequence, and only if it is the one the chat refers to.
      var seek =
        "(function(){var s=app.project&&app.project.activeSequence;if(!s||String(s.sequenceID)!==" +
        JSON.stringify(event.data.sequenceId) +
        ')return "premiere:mismatch";var tb=parseFloat(s.timebase);s.setPlayerPosition(String(Math.round(' +
        Number(event.data.seconds) +
        '*254016000000/tb)*tb));return "premiere:ok";}())';
      window.__adobe_cep__.evalScript(seek, function () {
        publishContext(null);
      });
    }
    if (event.data.type === "premiere.accounts" && runtime && config) {
      runtime
        .pairBackend(config)
        .then(function (url) {
          var target = new URL(url);
          target.pathname = "/pair";
          target.searchParams.delete("host");
          target.searchParams.delete("label");
          if (window.cep && window.cep.util) window.cep.util.openURLInDefaultBrowser(target.href);
          else
            fail(
              new Error("Could not open account setup. Open the local backend in your browser."),
            );
        })
        .catch(fail);
    }
  });

  function fail(error) {
    startup.hidden = false;
    frame.hidden = true;
    document.getElementById("startup-message").textContent = error.message;
    retry.hidden = false;
    status("error", "Needs attention");
  }

  function waitForBackend(attempt) {
    return runtime.probeBackend(config).catch(function (error) {
      if (attempt >= 40 || /different server/.test(error.message)) throw error;
      return new Promise(function (resolve) {
        setTimeout(resolve, 500);
      }).then(function () {
        return waitForBackend(attempt + 1);
      });
    });
  }

  function connect() {
    if (connecting) return;
    connecting = true;
    retry.hidden = true;
    status("starting", "Connecting");
    Promise.resolve()
      .then(function () {
        if (!nodeRequire)
          throw new Error(
            "Open this extension inside Premiere Pro after running the extension installer.",
          );
        var path = nodeRequire("path");
        var fs = nodeRequire("fs");
        var directory = decodeURIComponent(location.pathname)
          .replace(/^\/(?:([A-Za-z]:))/, "$1")
          .replace(/\/[^/]*$/, "");
        runtime = nodeRequire(path.join(directory, "runtime.cjs"));
        config = runtime.validateConfig(
          JSON.parse(fs.readFileSync(path.join(directory, "config.json"), "utf8")),
        );
        backendOrigin = new URL(config.backendUrl).origin;
        return runtime.probeBackend(config).catch(function (error) {
          if (/different server/.test(error.message)) throw error;
          var child = runtime.startBackend(config);
          child.on("error", function () {
            fail(new Error("Could not launch Node.js. Run the extension installer again."));
          });
          return waitForBackend(0);
        });
      })
      .then(function () {
        return runtime.pairBackend(config);
      })
      .then(function (url) {
        frame.hidden = false;
        frame.src = url;
        document.getElementById("startup-message").textContent =
          "Opening your editing workspace...";
        if (!timer)
          timer = setInterval(function () {
            publishContext(null);
          }, 2000);
      })
      .catch(fail)
      .then(function () {
        connecting = false;
      });
  }

  retry.addEventListener("click", connect);
  window.addEventListener("unload", function () {
    if (timer) clearInterval(timer);
  });
  readContext(function () {});
  connect();
})();
