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
  var playheadTimer = null;
  var readingPlayhead = false;
  var nodeRequire =
    typeof require === "function" ? require : window.cep_node && window.cep_node.require;
  var runtime;
  var config;
  var extensionDirectory;
  var backendState = "starting";
  var backendMessage = "Starting";
  var bridgeStatus = null;

  function status(state, message) {
    backendState = state;
    backendMessage = message;
    renderStatus();
  }

  function renderStatus() {
    var bridgeError = bridgeStatus && bridgeStatus.state === "error";
    connection.setAttribute("data-state", bridgeError ? "error" : backendState);
    connection.textContent = bridgeError
      ? "Bridge needs attention"
      : backendMessage +
        (bridgeStatus
          ? " · " + (bridgeStatus.state === "standby" ? "Bridge shared" : bridgeStatus.message)
          : "");
    connection.title = backendMessage + (bridgeStatus ? " · " + bridgeStatus.message : "");
  }

  if (window.AxisPremiereBridge)
    window.AxisPremiereBridge.subscribe(function (value) {
      bridgeStatus = value;
      renderStatus();
    });

  /* eslint-disable no-unused-vars -- ExtendScript requires bindings for ignored errors. */
  function timelineContext() {
    try {
      var p = app.project;
      if (!p || !p.activeSequence) return "premiere:none";
      var s = p.activeSequence;
      var d = "";
      try {
        d = String(p.documentID || "");
      } catch (_error) {}
      function text(value, limit) {
        return String(value === undefined ? "" : value).slice(0, limit);
      }
      function point(method) {
        try {
          var seconds = Number(s[method]().seconds);
          if (isFinite(seconds) && seconds >= 0) return String(seconds);
        } catch (_error) {}
        return "";
      }
      var rows = [];
      try {
        var selected = s.getSelection();
        var locations = {};
        var remaining = 0;
        var i;
        for (i = 0; i < selected.length && i < 50; i++) {
          locations["n" + selected[i].nodeId] = null;
          remaining++;
        }
        var groups = [s.videoTracks, s.audioTracks];
        for (var g = 0; g < groups.length && remaining; g++) {
          var tracks = groups[g];
          for (var t = 0; t < tracks.numTracks && remaining; t++) {
            var clips = tracks[t].clips;
            for (var c = 0; c < clips.numItems && remaining; c++) {
              var key = "n" + clips[c].nodeId;
              if (locations[key] === null) {
                locations[key] = [g === 0 ? "V" : "A", t];
                remaining--;
              }
            }
          }
        }
        for (i = 0; i < selected.length && i < 50; i++) {
          try {
            var clip = selected[i];
            var location = locations["n" + clip.nodeId];
            if (!location) continue;
            var itemName = "";
            var mediaPath = "";
            try {
              itemName = text(clip.projectItem.name, 512);
            } catch (_error) {}
            try {
              mediaPath = text(clip.projectItem.getMediaPath(), 2048);
            } catch (_error) {}
            var row = [
              text(clip.name, 512),
              location[0],
              location[1],
              clip.start.seconds,
              clip.end.seconds,
              clip.inPoint.seconds,
              clip.outPoint.seconds,
              itemName,
              mediaPath,
            ];
            for (var j = 0; j < row.length; j++) row[j] = encodeURIComponent(String(row[j]));
            rows.push(row.join("|"));
          } catch (_error) {}
        }
      } catch (_error) {}
      var v = [
        text(p.name, 32768),
        text(p.path, 32768),
        text(d, 32768),
        text(s.name, 32768),
        text(s.sequenceID, 32768),
        String(254016000000 / parseFloat(s.timebase)),
        String(s.getPlayerPosition().seconds),
        point("getInPointAsTime"),
        point("getOutPointAsTime"),
        rows.join("\n"),
      ];
      for (var k = 0; k < v.length; k++) v[k] = encodeURIComponent(v[k]);
      return "premiere:" + v.join("|");
    } catch (_error) {
      return "premiere:error";
    }
  }
  /* eslint-enable no-unused-vars */

  function readContext(callback) {
    if (!window.__adobe_cep__) return callback(null);
    contextCallbacks.push(callback);
    if (readingContext) return;
    readingContext = true;
    var script = "(" + timelineContext.toString() + ")()";
    window.__adobe_cep__.evalScript(script, function (raw) {
      var next = null;
      try {
        if (String(raw).indexOf("premiere:") === 0 && raw !== "premiere:none") {
          var fields = raw.slice(9).split("|").map(decodeURIComponent);
          if (
            (fields.length === 7 || fields.length === 10) &&
            Number(fields[5]) > 0 &&
            isFinite(Number(fields[6]))
          ) {
            next = {
              projectName: fields[0],
              projectPath: fields[1],
              projectDocumentId: fields[2],
              sequenceName: fields[3],
              sequenceId: fields[4],
              fps: Number(fields[5]),
              playheadSeconds: Number(fields[6]),
            };
            if (fields.length === 10) {
              next.selection = fields[9]
                ? fields[9].split("\n").map(function (row) {
                    var clip = row.split("|").map(decodeURIComponent);
                    if (clip.length !== 9) throw new Error("Invalid selected clip");
                    return {
                      name: clip[0],
                      trackType: clip[1],
                      trackIndex: Number(clip[2]),
                      startSeconds: Number(clip[3]),
                      endSeconds: Number(clip[4]),
                      sourceInSeconds: Number(clip[5]),
                      sourceOutSeconds: Number(clip[6]),
                      projectItemName: clip[7],
                      mediaPath: clip[8],
                    };
                  })
                : [];
              if (fields[7] !== "") next.inPointSeconds = Number(fields[7]);
              if (fields[8] !== "") next.outPointSeconds = Number(fields[8]);
            }
          }
        }
      } catch {
        next = null;
      }
      document.getElementById("project").textContent = next ? next.projectName : "Axis";
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

  function playheadContext() {
    try {
      var p = app.project;
      var s = p && p.activeSequence;
      if (!s) return "";
      return [
        encodeURIComponent(String(p.documentID || p.path)),
        encodeURIComponent(String(s.sequenceID)),
        String(s.getPlayerPosition().seconds),
      ].join("|");
    } catch (error) {
      return "premiere:playhead-error|" + String(error);
    }
  }

  function publishPlayhead() {
    if (readingPlayhead || !playheadTimer || !window.__adobe_cep__) return;
    readingPlayhead = true;
    try {
      window.__adobe_cep__.evalScript("(" + playheadContext.toString() + ")()", function (raw) {
        readingPlayhead = false;
        if (!playheadTimer || !backendOrigin || !frame.contentWindow) return;
        var fields = String(raw).split("|");
        if (
          fields.length !== 3 ||
          !fields[2] ||
          !isFinite(Number(fields[2])) ||
          Number(fields[2]) < 0
        )
          return;
        try {
          frame.contentWindow.postMessage(
            {
              type: "premiere.playhead",
              protocol: 1,
              projectId: decodeURIComponent(fields[0]),
              sequenceId: decodeURIComponent(fields[1]),
              seconds: Number(fields[2]),
            },
            backendOrigin,
          );
        } catch {}
      });
    } catch {
      readingPlayhead = false;
    }
  }

  function exportFrame(targetPath) {
    try {
      var s = app.project && app.project.activeSequence;
      if (!s) return "premiere:frame-error|Open a sequence in Premiere before attaching a frame.";
      app.enableQE();
      var sequence = qe.project.getActiveSequence();
      if (!sequence) return "premiere:frame-error|Premiere could not access the active sequence.";
      var position = s.getPlayerPosition();
      var timecode = sequence.CTI && sequence.CTI.timecode;
      if (!timecode)
        timecode = position.getFormatted(s.getSettings().videoFrameRate, s.videoDisplayFormat);
      if (!timecode) return "premiere:frame-error|Premiere could not read the playhead timecode.";
      sequence.exportFramePNG(String(timecode), targetPath);
      return (
        "premiere:frame|" +
        encodeURIComponent(String(s.name).slice(0, 120)) +
        "|" +
        encodeURIComponent(String(timecode))
      );
    } catch (error) {
      return (
        "premiere:frame-error|" +
        encodeURIComponent("Premiere could not export this frame: " + String(error).slice(0, 300))
      );
    }
  }

  function captureFrame(requestId, origin) {
    var fs;
    var directory;
    var filename;
    var timeout;
    var poll;
    var finished = false;
    function finish(result) {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      clearTimeout(poll);
      try {
        if (directory)
          fs.readdirSync(directory).forEach(function (entry) {
            fs.unlinkSync(nodeRequire("path").join(directory, entry));
          });
      } catch {}
      try {
        if (directory) fs.rmdirSync(directory);
      } catch {}
      if (backendOrigin === origin && frame.contentWindow)
        frame.contentWindow.postMessage(
          Object.assign({ type: "premiere.frame", protocol: 1, requestId: requestId }, result),
          origin,
        );
    }
    try {
      if (!nodeRequire || !window.__adobe_cep__)
        throw new Error("Reopen Axis inside Premiere to attach a frame.");
      fs = nodeRequire("fs");
      var path = nodeRequire("path");
      directory = fs.mkdtempSync(path.join(nodeRequire("os").tmpdir(), "axis-frames-"));
      filename = path.join(directory, "frame.png");
      timeout = setTimeout(function () {
        finish({
          ok: false,
          error: "Premiere did not finish exporting the frame. Try attaching it again.",
        });
      }, 8000);
      var script = "(" + exportFrame.toString() + ")(" + JSON.stringify(filename) + ")";
      window.__adobe_cep__.evalScript(script, function (raw) {
        if (finished) return;
        try {
          var fields = String(raw).split("|");
          if (fields[0] !== "premiere:frame" || fields.length !== 3)
            throw new Error(
              fields[0] === "premiere:frame-error"
                ? decodeURIComponent(fields[1])
                : "Premiere could not export this frame.",
            );
          var name =
            ("frame-" + decodeURIComponent(fields[1]) + "-" + decodeURIComponent(fields[2]))
              .replace(/[^a-zA-Z0-9._-]/g, "-")
              .slice(0, 200) + ".png";
          var previousSize = 0;
          var stable = 0;
          function read() {
            if (finished) return;
            try {
              // Some Premiere versions append their own ".png" to the requested name.
              var exported = fs.readdirSync(directory).filter(function (entry) {
                return /.png$/i.test(entry);
              })[0];
              if (exported) filename = path.join(directory, exported);
              var size = fs.statSync(filename).size;
              if (size > 10 * 1024 * 1024) {
                finish({
                  ok: false,
                  error: "This frame is larger than 10 MB. Attach a smaller image instead.",
                });
                return;
              }
              stable = size > 0 && size === previousSize ? stable + 1 : 0;
              previousSize = size;
              if (stable >= 2) {
                var bytes = fs.readFileSync(filename);
                // A stable partial write can still be missing the PNG's final chunk.
                if (
                  bytes.length === size &&
                  bytes.length >= 20 &&
                  bytes.slice(0, 8).toString("hex") === "89504e470d0a1a0a" &&
                  bytes.slice(-12).toString("hex") === "0000000049454e44ae426082"
                ) {
                  finish({
                    ok: true,
                    name: name,
                    mimeType: "image/png",
                    dataUrl: "data:image/png;base64," + bytes.toString("base64"),
                  });
                  return;
                }
              }
            } catch (error) {
              if (error.code !== "ENOENT") {
                finish({ ok: false, error: "Axis could not read the exported frame." });
                return;
              }
            }
            poll = setTimeout(read, 150);
          }
          read();
        } catch (error) {
          finish({ ok: false, error: error.message });
        }
      });
    } catch (error) {
      finish({ ok: false, error: error.message });
    }
  }

  // These functions are serialized into ExtendScript. No native JSON is required there.
  function timelineClips(sequenceId) {
    try {
      var s = app.project && app.project.activeSequence;
      if (!s || String(s.sequenceID) !== sequenceId)
        return "axis:error|Sequence changed. Refresh the timeline.";
      var rows = [];
      var groups = [s.videoTracks, s.audioTracks];
      for (var g = 0; g < groups.length; g++) {
        var tracks = groups[g];
        for (var t = 0; t < tracks.numTracks && t < 10000; t++) {
          var clips = tracks[t].clips;
          for (var c = 0; c < clips.numItems; c++) {
            if (rows.length >= 2000) return "axis:clips|" + rows.join("\n");
            var clip = clips[c];
            var row = [
              String(clip.name || "").slice(0, 512),
              String(clip.nodeId || "").slice(0, 512),
              g === 0 ? "V" : "A",
              t,
              clip.start.seconds,
              clip.end.seconds,
            ];
            for (var i = 0; i < row.length; i++) row[i] = encodeURIComponent(String(row[i]));
            rows.push(row.join("|"));
          }
        }
      }
      return "axis:clips|" + rows.join("\n");
    } catch (error) {
      return "axis:error|" + encodeURIComponent(String(error).slice(0, 500));
    }
  }

  function timelineSelect(request) {
    try {
      var s = app.project && app.project.activeSequence;
      if (!s || String(s.sequenceID) !== request.sequenceId)
        return "axis:error|Sequence changed. Refresh the timeline.";
      var target = null;
      var groups = [s.videoTracks, s.audioTracks];
      for (var g = 0; g < groups.length && !target; g++) {
        var tracks = groups[g];
        for (var t = 0; t < tracks.numTracks && !target; t++) {
          if (
            !request.nodeId &&
            (request.trackType !== (g === 0 ? "V" : "A") || request.trackIndex !== t)
          )
            continue;
          var clips = tracks[t].clips;
          for (var c = 0; c < clips.numItems; c++) {
            var clip = clips[c];
            if (
              request.nodeId
                ? String(clip.nodeId) === request.nodeId
                : Math.abs(Number(clip.start.seconds) - request.start) < 0.000001
            ) {
              target = clip;
              break;
            }
          }
        }
      }
      if (!target) return "axis:error|Clip no longer exists. Wait for the clip index to refresh.";
      var selected = s.getSelection();
      for (var i = 0; i < selected.length; i++) selected[i].setSelected(false, true);
      target.setSelected(true, true);
      s.setPlayerPosition(String(target.start.ticks));
      return "axis:ok";
    } catch (error) {
      return "axis:error|" + encodeURIComponent(String(error).slice(0, 500));
    }
  }

  function timelineMarkers(request) {
    var created = [];
    var markers;
    try {
      var s = app.project && app.project.activeSequence;
      if (!s || String(s.sequenceID) !== request.sequenceId)
        return "axis:error|Sequence changed. Refresh the timeline.";
      markers = s.markers;
      if (!markers || typeof markers.createMarker !== "function")
        return "axis:error|Sequence markers are unavailable.";
      var colors = {
        green: 0,
        red: 1,
        purple: 2,
        magenta: 2,
        orange: 3,
        yellow: 4,
        blue: 6,
        cyan: 7,
      };
      var end = Number(s.end) / 254016000000;
      var i;
      for (i = 0; i < request.markers.length; i++) {
        var check = request.markers[i];
        if (isFinite(end) && check.time + (check.duration || 0) > end + 0.000001)
          return "axis:error|A marker extends beyond the sequence end.";
      }
      for (i = 0; i < request.markers.length; i++) {
        var row = request.markers[i];
        var marker = markers.createMarker(row.time);
        if (!marker) throw new Error("Premiere could not create a marker.");
        created.push(marker);
        marker.name = row.name;
        marker.comments = row.comment || "";
        if (row.duration) marker.end = row.time + row.duration;
        if (row.color) marker.setColorByIndex(colors[row.color]);
      }
      return "axis:ok";
    } catch (error) {
      var rollbackFailure = "";
      for (var j = created.length - 1; j >= 0; j--) {
        try {
          markers.deleteMarker(created[j]);
        } catch (rollbackError) {
          rollbackFailure = String(rollbackError).slice(0, 100);
        }
      }
      return (
        "axis:error|" +
        encodeURIComponent(
          String(error).slice(0, 400) +
            (rollbackFailure
              ? " Some markers remain. Inspect the timeline before retrying. " + rollbackFailure
              : " No markers were added."),
        )
      );
    }
  }

  function timelineMessage(data, origin) {
    if (
      ["premiere.clips.request", "premiere.select", "premiere.markers.add"].indexOf(data.type) < 0
    )
      return;
    if (typeof data.requestId !== "string" || !data.requestId || data.requestId.length > 128)
      return;
    var type = data.type === "premiere.clips.request" ? "premiere.clips" : data.type;
    function reply(result) {
      if (backendOrigin === origin && frame.contentWindow)
        frame.contentWindow.postMessage(
          Object.assign(
            { type: type, protocol: 1, requestId: data.requestId, sequenceId: data.sequenceId },
            result,
          ),
          origin,
        );
    }
    function text(value, limit) {
      return typeof value === "string" && value.length > 0 && value.length <= limit;
    }
    function seconds(value) {
      return typeof value === "number" && isFinite(value) && value >= 0 && value <= 8640000;
    }
    if (!text(data.sequenceId, 32768)) return reply({ ok: false, error: "Invalid sequence ID." });
    var operation = timelineClips;
    var argument = data.sequenceId;
    if (data.type === "premiere.select") {
      if (
        !(
          text(data.nodeId, 512) ||
          ((data.nodeId === undefined || data.nodeId === "") &&
            (data.trackType === "V" || data.trackType === "A") &&
            Number.isInteger(data.trackIndex) &&
            data.trackIndex >= 0 &&
            data.trackIndex < 10000 &&
            seconds(data.start))
        )
      )
        return reply({ ok: false, error: "Invalid clip selection." });
      operation = timelineSelect;
      argument = text(data.nodeId, 512)
        ? { sequenceId: data.sequenceId, nodeId: data.nodeId }
        : {
            sequenceId: data.sequenceId,
            trackType: data.trackType,
            trackIndex: data.trackIndex,
            start: data.start,
          };
    }
    if (data.type === "premiere.markers.add") {
      if (!Array.isArray(data.markers) || !data.markers.length || data.markers.length > 200)
        return reply({ ok: false, error: "Expected 1-200 markers." });
      var colors = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "magenta"];
      if (
        data.markers.some(function (row) {
          return (
            !row ||
            typeof row !== "object" ||
            !seconds(row.time) ||
            typeof row.name !== "string" ||
            row.name.length > 512 ||
            (row.comment !== undefined &&
              (typeof row.comment !== "string" || row.comment.length > 2000)) ||
            (row.color !== undefined && colors.indexOf(row.color) < 0) ||
            (row.duration !== undefined && !seconds(row.duration)) ||
            row.time + (row.duration || 0) > 8640000
          );
        })
      )
        return reply({ ok: false, error: "Invalid marker values." });
      operation = timelineMarkers;
      argument = {
        sequenceId: data.sequenceId,
        markers: data.markers.map(function (row) {
          return {
            time: row.time,
            name: row.name,
            comment: row.comment,
            color: row.color,
            duration: row.duration,
          };
        }),
      };
    }
    if (!window.__adobe_cep__)
      return reply({ ok: false, error: "Premiere scripting is unavailable." });
    var encoded = JSON.stringify(argument)
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
    try {
      window.__adobe_cep__.evalScript(
        "(" + operation.toString() + ")(" + encoded + ")",
        function (raw) {
          try {
            if (raw === "axis:ok") {
              reply({ ok: true });
              publishContext(null);
              return;
            }
            if (type === "premiere.clips" && String(raw).indexOf("axis:clips|") === 0) {
              var body = raw.slice(11);
              var clips = body
                ? body.split("\n").map(function (row) {
                    var fields = row.split("|").map(decodeURIComponent);
                    if (fields.length !== 6) throw new Error("Invalid clip index.");
                    return {
                      name: fields[0],
                      nodeId: fields[1],
                      trackType: fields[2],
                      trackIndex: Number(fields[3]),
                      start: Number(fields[4]),
                      end: Number(fields[5]),
                    };
                  })
                : [];
              reply({ ok: true, clips: clips });
              return;
            }
            reply({
              ok: false,
              error:
                String(raw).indexOf("axis:error|") === 0
                  ? decodeURIComponent(raw.slice(11)).slice(0, 1024)
                  : "Premiere could not complete this action.",
            });
          } catch (error) {
            reply({ ok: false, error: String(error).slice(0, 1024) });
          }
        },
      );
    } catch (error) {
      reply({ ok: false, error: String(error).slice(0, 1024) });
    }
  }

  window.addEventListener("message", function (event) {
    if (
      event.source !== frame.contentWindow ||
      event.origin !== backendOrigin ||
      !event.data ||
      event.data.protocol !== 1
    )
      return;
    if (event.data.type === "premiere.transcript.load.request") {
      var transcriptRequest = event.data;
      if (
        typeof transcriptRequest.requestId !== "string" ||
        transcriptRequest.requestId.length > 128
      )
        return;
      var transcriptResult;
      try {
        transcriptResult = nodeRequire(
          nodeRequire("path").join(extensionDirectory, "transcript-handoff.cjs"),
        ).loadTranscript(config, transcriptRequest, extensionDirectory);
      } catch (error) {
        transcriptResult = { ok: false, error: String(error.message).slice(0, 1024) };
      }
      frame.contentWindow.postMessage(
        Object.assign({}, transcriptResult, {
          type: "premiere.transcript.load",
          protocol: 1,
          requestId: transcriptRequest.requestId,
        }),
        event.origin,
      );
      return;
    }
    if (
      event.data.type === "premiere.transcript.active" &&
      typeof event.data.enabled === "boolean"
    ) {
      if (playheadTimer) clearInterval(playheadTimer);
      playheadTimer = event.data.enabled ? setInterval(publishPlayhead, 100) : null;
      if (playheadTimer) publishPlayhead();
      return;
    }
    timelineMessage(event.data, event.origin);
    if (
      event.data.type === "premiere.frame.request" &&
      typeof event.data.requestId === "string" &&
      event.data.requestId.length > 0 &&
      event.data.requestId.length <= 128
    )
      captureFrame(event.data.requestId, event.origin);
    if (window.AxisTimeline) {
      var requestOrigin = event.origin;
      var request = event.data;
      if (
        window.AxisTimeline.handle(request, window.__adobe_cep__, function (result) {
          if (backendOrigin === requestOrigin && frame.contentWindow)
            frame.contentWindow.postMessage(
              Object.assign({}, result, {
                type: request.type.replace(".request", ""),
                protocol: 1,
                requestId: request.requestId,
              }),
              requestOrigin,
            );
          if (
            result.ok &&
            (request.type === "premiere.restore.request" || request.type === "premiere.cut.request")
          )
            publishContext(null);
        })
      )
        return;
    }
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
    if (window.AxisPremiereBridge) window.AxisPremiereBridge.retry();
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
        extensionDirectory = directory;
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
    if (playheadTimer) clearInterval(playheadTimer);
  });
  readContext(function () {});
  connect();
})();
