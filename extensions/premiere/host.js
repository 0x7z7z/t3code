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
  var contextReadTimeout = null;
  var timer = null;
  var frameLoadTimer = null;
  var playheadTimer = null;
  var readingPlayhead = false;
  var playheadReadTimeout = null;
  var nextPlayheadReadId = 0;
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

  // prettier-ignore
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
              mediaPath
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
        rows.join("\n")
      ];
      for (var k = 0; k < v.length; k++) v[k] = encodeURIComponent(v[k]);
      return "premiere:" + v.join("|");
    } catch (_error) {
      return "premiere:error";
    }
  }

  function readContext(callback) {
    if (!window.__adobe_cep__) return callback(null);
    contextCallbacks.push(callback);
    if (readingContext) return;
    readingContext = true;
    // Publish the same ES3 operation to the existing agent command bridge. No
    // separate transport or MCP server is needed for agents that can run JSX.
    var script =
      "if(typeof $ !== 'undefined' && !$.global.axisCaptionOperation){$.global.axisCaptionOperation=" +
      captionScript() +
      ";}if(typeof $ !== 'undefined' && !$.global.axisMusicOperation){$.global.axisMusicOperation=" +
      musicScript() +
      ";}\n(" +
      timelineContext.toString() +
      ")()";
    var readId = ++nextPlayheadReadId;
    var completed = false;
    contextReadTimeout = setTimeout(function () {
      finish("premiere:error");
    }, 5000);
    function finish(raw) {
      if (completed) return;
      completed = true;
      clearTimeout(contextReadTimeout);
      contextReadTimeout = null;
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
              playheadSeconds: Number(fields[6])
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
                      mediaPath: clip[8]
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
      if (nodeRequire && config && config.bridgePath) {
        try {
          var contextFs = nodeRequire("fs");
          var contextFile = nodeRequire("path").join(config.bridgePath, "axis-context.json");
          var contextTemp = contextFile + ".tmp";
          contextFs.writeFileSync(
            contextTemp,
            JSON.stringify({ capturedAt: Date.now(), context: next })
          );
          contextFs.renameSync(contextTemp, contextFile);
        } catch {
          /* The agent can re-read the host if the snapshot is unavailable. */
        }
      }
      document.getElementById("project").textContent = next ? next.projectName : "Axis";
      document.getElementById("sequence").textContent = next
        ? next.sequenceName + " · " + Math.round(next.fps * 100) / 100 + " fps"
        : "Open a sequence to attach timeline context";
      readingContext = false;
      var callbacks = contextCallbacks;
      contextCallbacks = [];
      callbacks.forEach(function (notify) {
        notify(next, readId);
      });
    }
    try {
      window.__adobe_cep__.evalScript(script, finish);
    } catch {
      finish("premiere:error");
    }
  }

  function publishContext(requestId) {
    readContext(function (context, readId) {
      if (backendOrigin && frame.contentWindow)
        frame.contentWindow.postMessage(
          {
            type: "premiere.context",
            protocol: 1,
            requestId: requestId || null,
            context: context,
            playheadReadId: readId
          },
          backendOrigin
        );
    });
  }

  // prettier-ignore
  function playheadContext() {
    try {
      var p = app.project;
      var s = p && p.activeSequence;
      if (!s) return "";
      return [
        encodeURIComponent(String(p.documentID || p.path)),
        encodeURIComponent(String(s.sequenceID)),
        String(s.getPlayerPosition().seconds)
      ].join("|");
    } catch (error) {
      return "premiere:playhead-error|" + String(error);
    }
  }

  function publishPlayhead() {
    if (readingPlayhead || !playheadTimer || !window.__adobe_cep__) return;
    readingPlayhead = true;
    var completed = false;
    var readId = ++nextPlayheadReadId;
    playheadReadTimeout = setTimeout(function () {
      finish("");
    }, 5000);
    try {
      window.__adobe_cep__.evalScript("(" + playheadContext.toString() + ")()", finish);
    } catch {
      finish("");
    }
    function finish(raw) {
      if (completed) return;
      completed = true;
      clearTimeout(playheadReadTimeout);
      playheadReadTimeout = null;
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
            readId: readId
          },
          backendOrigin
        );
      } catch {}
    }
  }

  // prettier-ignore
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
          origin
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
          error: "Premiere did not finish exporting the frame. Try attaching it again."
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
                : "Premiere could not export this frame."
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
                  error: "This frame is larger than 10 MB. Attach a smaller image instead."
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
                    dataUrl: "data:image/png;base64," + bytes.toString("base64")
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
  // prettier-ignore
  function timelineClips(request) {
    try {
      var s = app.project && app.project.activeSequence;
      if (!s || String(s.sequenceID) !== request.sequenceId)
        return "axis:error|Sequence changed. Refresh the timeline.";
      if (request.projectId && String(app.project.documentID || app.project.path) !== request.projectId)
        return "axis:error|Project changed. Refresh the timeline.";
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
              clip.end.seconds
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

  // prettier-ignore
  function timelineSelect(request) {
    try {
      var s = app.project && app.project.activeSequence;
      if (!s || String(s.sequenceID) !== request.sequenceId)
        return "axis:error|Sequence changed. Refresh the timeline.";
      if (request.projectId && String(app.project.documentID || app.project.path) !== request.projectId)
        return "axis:error|Project changed. Refresh the timeline.";
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

  // prettier-ignore
  function timelineMarkers(request) {
    var created = [];
    var markers;
    try {
      var s = app.project && app.project.activeSequence;
      if (!s || String(s.sequenceID) !== request.sequenceId)
        return "axis:error|Sequence changed. Refresh the timeline.";
      if (request.projectId && String(app.project.documentID || app.project.path) !== request.projectId)
        return "axis:error|Project changed. Refresh the timeline.";
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
        cyan: 7
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
              : " No markers were added.")
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
            result
          ),
          origin
        );
    }
    function text(value, limit) {
      return typeof value === "string" && value.length > 0 && value.length <= limit;
    }
    function seconds(value) {
      return typeof value === "number" && isFinite(value) && value >= 0 && value <= 8640000;
    }
    if (!text(data.sequenceId, 32768)) return reply({ ok: false, error: "Invalid sequence ID." });
    if (data.projectId !== undefined && !text(data.projectId, 32768))
      return reply({ ok: false, error: "Invalid project ID." });
    var operation = timelineClips;
    var argument = { sequenceId: data.sequenceId, projectId: data.projectId };
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
        ? { sequenceId: data.sequenceId, projectId: data.projectId, nodeId: data.nodeId }
        : {
            sequenceId: data.sequenceId,
            projectId: data.projectId,
            trackType: data.trackType,
            trackIndex: data.trackIndex,
            start: data.start
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
        projectId: data.projectId,
        markers: data.markers.map(function (row) {
          return {
            time: row.time,
            name: row.name,
            comment: row.comment,
            color: row.color,
            duration: row.duration
          };
        })
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
                      end: Number(fields[5])
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
                  : "Premiere could not complete this action."
            });
          } catch (error) {
            reply({ ok: false, error: String(error).slice(0, 1024) });
          }
        }
      );
    } catch (error) {
      reply({ ok: false, error: String(error).slice(0, 1024) });
    }
  }

  function captionScript() {
    return (
      "function(request){return (" +
      captionOperation.toString() +
      ")(request," +
      window.AxisTimeline.operation.toString() +
      ");}"
    );
  }

  // Serialized into ES3 ExtendScript. Clone the entire sequence before adding:
  // ExtendScript exposes caption creation but no caption-track removal API.
  function captionOperation(request, timeline) {
    var bin = null;
    var file = null;
    try {
      if (
        !request ||
        typeof request.projectId !== "string" ||
        typeof request.sequenceId !== "string" ||
        (request.action !== "add" && request.action !== "save" && request.action !== "undo") ||
        (request.action !== "undo" &&
          (typeof request.srt !== "string" || !request.srt || request.srt.length > 4000000)) ||
        (request.action === "add" &&
          (request.confirmed !== true ||
            typeof request.id !== "string" ||
            !/^[a-zA-Z0-9-]{1,100}$/.test(request.id))) ||
        (request.action === "undo" &&
          (typeof request.binId !== "string" ||
            !request.binId ||
            typeof request.itemId !== "string" ||
            !request.itemId ||
            (request.checkpointId &&
              (typeof request.checkpointId !== "string" ||
                typeof request.checkpointSignature !== "string" ||
                request.checkpointSignature.length > 4000000 ||
                typeof request.expectedSignature !== "string" ||
                request.expectedSignature.length > 4000000))))
      )
        throw new Error("Invalid captions request. Preview and confirm captions before adding.");
      var p = app.project;
      var s = p && p.activeSequence;
      var projectId = p && String(p.documentID || p.path);
      if (!s || String(s.sequenceID) !== request.sequenceId || projectId !== request.projectId)
        throw new Error("The active project or sequence changed. Reopen Captions.");
      if (request.action === "undo") {
        if (request.checkpointId) {
          var restored = timeline(
            "restore",
            request.checkpointSignature,
            request.sequenceId,
            request.checkpointId,
            request.expectedSignature,
            "captions",
            null,
            null,
            true,
            "captions"
          );
          if (!restored.ok) throw new Error(restored.error);
          return "axis:captions|undone|" + encodeURIComponent(restored.sequenceId);
        }
        var children = p.rootItem.children;
        for (var i = 0; i < children.numItems; i++) {
          if (String(children[i].nodeId) === request.binId) bin = children[i];
        }
        if (!bin || String(bin.name).indexOf("Axis captions ") !== 0)
          throw new Error("The caption source bin is gone or was renamed.");
        if (bin.children.numItems !== 1 || String(bin.children[0].nodeId) !== request.itemId)
          throw new Error(
            "The caption bin changed. Remove its captions manually to preserve other items."
          );
        if (bin.deleteBin() !== 0)
          throw new Error("Premiere could not delete the caption source bin.");
        return "axis:captions|undone";
      }
      if (request.action === "save") {
        file = File.saveDialog("Save captions as SRT", "*.srt");
        if (!file) return "axis:captions|cancelled";
        if (!/\.srt$/i.test(file.fsName)) {
          var withExtension = new File(file.fsName + ".srt");
          if (withExtension.exists && !confirm("Replace " + withExtension.fsName + "?"))
            return "axis:captions|cancelled";
          file = withExtension;
        }
      } else {
        var candidateFile = new File(Folder.temp.fsName + "/axis-captions-" + request.id + ".srt");
        if (candidateFile.exists)
          throw new Error("This captions ID already exists. Inspect the project before retrying.");
        file = candidateFile;
      }
      file.encoding = "UTF-8";
      file.lineFeed = "Windows";
      if (!file.open("w")) throw new Error("Could not write the captions file.");
      var written = file.write(request.srt);
      var closed = file.close();
      if (!written || !closed) throw new Error("Could not finish writing the captions file.");
      if (request.action === "save")
        return "axis:captions|saved|" + encodeURIComponent(file.fsName);
      bin = p.rootItem.createBin("Axis captions " + request.id);
      if (!bin || typeof bin.deleteBin !== "function")
        throw new Error("Premiere cannot create an undoable captions bin.");
      if (!p.importFiles([file.fsName], true, bin, false) || bin.children.numItems !== 1)
        throw new Error("Premiere could not import the SRT.");
      var item = bin.children[0];
      var placed = false;
      var checkpoint = null;
      // Adobe PProPanel and the scripting guide use seconds, not ticks. The
      // optional caption format defaults to SUBTITLE in Premiere 2024/2025.
      // https://github.com/Adobe-CEP/Samples/blob/master/PProPanel/jsx/PPRO/Premiere.jsx
      // https://ppro-scripting.docsforadobe.dev/sequence/sequence/#sequencecreatecaptiontrack
      try {
        if (typeof s.createCaptionTrack === "function") {
          checkpoint = timeline(
            "snapshot",
            true,
            request.sequenceId,
            "",
            "",
            0,
            null,
            null,
            true,
            "captions"
          );
          if (checkpoint.ok && checkpoint.checkpointId && checkpoint.checkpointSignature) {
            if (
              typeof Sequence !== "undefined" &&
              typeof Sequence.CAPTION_FORMAT_SUBTITLE !== "undefined"
            )
              placed = s.createCaptionTrack(item, 0, Sequence.CAPTION_FORMAT_SUBTITLE) === true;
            else placed = s.createCaptionTrack(item, 0) === true;
          }
        }
      } catch (_ignoredCaption) {
        // Keep the imported source when this build cannot create caption tracks.
      }
      return (
        "axis:captions|" +
        (placed ? "added" : "imported") +
        "|" +
        encodeURIComponent(String(bin.nodeId)) +
        "|" +
        encodeURIComponent(String(item.nodeId)) +
        "|" +
        encodeURIComponent(file.fsName) +
        "|" +
        encodeURIComponent(String(bin.name)) +
        "|" +
        (checkpoint && checkpoint.ok && checkpoint.checkpointId
          ? encodeURIComponent(checkpoint.checkpointId) +
            "|" +
            encodeURIComponent(checkpoint.checkpointSignature) +
            "|" +
            encodeURIComponent(checkpoint.signature)
          : "")
      );
    } catch (error) {
      var cleanup = "";
      if (bin && request.action !== "undo") {
        try {
          if (bin.deleteBin() !== 0) cleanup = " Remove the Axis captions bin manually.";
        } catch (_ignoredCleanup) {
          cleanup = " Remove the Axis captions bin manually.";
        }
      }
      if (file && request.action === "add" && !cleanup) {
        try {
          file.remove();
        } catch (_ignoredFile) {}
      }
      return "axis:error|" + encodeURIComponent(String(error).slice(0, 800) + cleanup);
    }
  }

  function musicScript() {
    return (
      "(function(r){return (" +
      musicOperation.toString() +
      ")(r," +
      window.AxisTimeline.operation.toString() +
      ");})"
    );
  }
  function musicOperation(request, timeline) {
    var checkpoint = null;
    var bin = null;
    var effectRows = [];
    function time(seconds) {
      var t = new Time();
      t.seconds = seconds;
      return t;
    }
    function number(n) {
      return typeof n === "number" && isFinite(n);
    }
    function failure(message) {
      throw new Error(message);
    }
    function checked(result, label) {
      if (result !== 0) failure("Premiere refused " + label + ".");
    }
    function pathKey(path) {
      return String(path).toLowerCase().replace(/\\/g, "/");
    }
    function mediaPath(clip) {
      return clip.projectItem && clip.projectItem.getMediaPath
        ? pathKey(clip.projectItem.getMediaPath())
        : "";
    }
    function response(status, signature, message, sequenceId) {
      return (
        "axis:music|" +
        status +
        "|" +
        encodeURIComponent(checkpoint ? checkpoint.checkpointId : "") +
        "|" +
        encodeURIComponent(checkpoint ? checkpoint.checkpointSignature : "") +
        "|" +
        encodeURIComponent(signature || "") +
        "|" +
        encodeURIComponent(message || "") +
        "|" +
        encodeURIComponent(sequenceId || "") +
        "|" +
        encodeURIComponent(effectRows.join("\n"))
      );
    }
    function applyMusicEffect(targetClip, cue, effectName, audioTrackIndex, tolerance) {
      try {
        app.enableQE();
        var audioTrack = qe.project.getActiveSequence().getAudioTrackAt(audioTrackIndex);
        var effect = qe.project.getAudioEffectByName(effectName);
        if (!effect) throw new Error("effect unavailable");
        var qeClip = null;
        for (var qi = 0; qi < audioTrack.numItems; qi++) {
          var entry = audioTrack.getItemAt(qi);
          if (
            entry &&
            entry.type === "Clip" &&
            entry.start &&
            Math.abs(Number(entry.start.secs) - cue.start) < tolerance
          )
            qeClip = entry;
        }
        if (!qeClip || !qeClip.addAudioEffect) throw new Error("QE clip unavailable");
        var beforeCount = targetClip.components.numItems;
        qeClip.addAudioEffect(effect);
        var addedEffect = null;
        for (var ci = beforeCount; ci < targetClip.components.numItems; ci++) {
          if (targetClip.components[ci].displayName === effectName)
            addedEffect = targetClip.components[ci];
        }
        if (!addedEffect) throw new Error("insertion not verified");
        var preset =
          effectName === "Lowpass"
            ? [["Cutoff", 0.25]]
            : [
                ["Maximum Amplitude", 0.72],
                ["Input Boost", 0.6667],
                ["Look-Ahead|Look-Ahead Time", 0.1333],
                ["Release|Release Time", 0.375],
                ["Link Channels", 1],
                ["Decay to Ceiling", 1],
                ["Limit True Peak", 0]
              ];
        for (var pi = 0; pi < preset.length; pi++) {
          var param = null;
          var aliases = preset[pi][0]
            .toLowerCase()
            .replace(/[^a-z|]/g, "")
            .split("|");
          for (var pj = 0; pj < addedEffect.properties.numItems; pj++) {
            var prop = addedEffect.properties[pj];
            var propName = String(prop.displayName || "")
              .toLowerCase()
              .replace(/[^a-z]/g, "");
            for (var pa = 0; pa < aliases.length; pa++) if (propName === aliases[pa]) param = prop;
          }
          if (!param) throw new Error("preset parameter unavailable: " + preset[pi][0]);
          checked(param.setValue(preset[pi][1], true), effectName + " preset");
          if (param.getValue) {
            var actualValue = Number(param.getValue());
            if (!number(actualValue) || Math.abs(actualValue - preset[pi][1]) > 0.0002)
              throw new Error("preset readback failed");
          }
        }
        return effectName;
      } catch (effectError) {
        return effectName + " failed (" + String(effectError).slice(0, 160) + ")";
      }
    }
    try {
      if (
        !request ||
        typeof request.projectId !== "string" ||
        typeof request.sequenceId !== "string"
      )
        failure("Invalid music scope.");
      var p = app.project;
      var s = p && p.activeSequence;
      if (
        !s ||
        String(s.sequenceID) !== request.sequenceId ||
        String(p.documentID || p.path) !== request.projectId
      )
        failure("The project or sequence changed. Reopen Music.");
      if (request.action === "undo") {
        if (
          !request.checkpointId ||
          typeof request.checkpointSignature !== "string" ||
          typeof request.expectedSignature !== "string"
        )
          failure("Missing music checkpoint.");
        var restored = timeline(
          "restore",
          request.checkpointSignature,
          request.sequenceId,
          request.checkpointId,
          request.expectedSignature,
          "music",
          null,
          null,
          true,
          "music"
        );
        if (!restored.ok) failure(restored.error);
        return response("undone", "", "", restored.sequenceId);
      }
      if (
        (request.action !== "apply" && request.action !== "swap") ||
        request.confirmed !== true ||
        !request.expectedSignature ||
        !request.cues ||
        !request.cues.length ||
        request.cues.length > 200
      )
        failure("Preview and confirm the music plan first.");
      var current = timeline(
        "snapshot",
        false,
        request.sequenceId,
        "",
        "",
        0,
        null,
        null,
        true,
        "music"
      );
      if (!current.ok || current.signature !== request.expectedSignature)
        failure("The timeline changed after preview. Rebuild the music plan.");
      if (current.snapshot && current.snapshot.truncated)
        failure("The timeline is too large to inspect safely.");
      var fps = 254016000000 / Number(s.timebase);
      if (!number(fps) || fps <= 0) fps = 30;
      var frameDuration = 1 / fps;
      var cues = request.cues;
      var previousPath = "";
      var previousSection = "";
      var previousEnd = -1;
      var i, j, k, c, key, candidate, clip;
      for (i = 0; i < cues.length; i++) {
        c = cues[i];
        if (
          !c ||
          typeof c.track !== "string" ||
          !/\.(wav|mp3|m4a|aac|flac|ogg|opus|aif|aiff|wma)$/i.test(c.track) ||
          !new File(c.track).exists ||
          !number(c.start) ||
          c.start < 0 ||
          c.start < previousEnd ||
          !number(c.end) ||
          c.end <= c.start ||
          !number(c.sourceOffset) ||
          c.sourceOffset < 0 ||
          !c.keys ||
          c.keys.length < 2 ||
          c.keys.length > 20000
        )
          failure("Invalid or overlapping music cue.");
        if (
          Math.abs(c.start * fps - Math.round(c.start * fps)) > 0.0001 ||
          Math.abs(c.end * fps - Math.round(c.end * fps)) > 0.0001
        )
          failure("Music section boundaries must land on sequence frames.");
        var cuePath = pathKey(c.track);
        if (/\/00\. duplicate copies - review\//i.test(cuePath))
          failure("Duplicate-review music is excluded.");
        if (
          cuePath === previousPath &&
          Math.abs(c.start - previousEnd) < frameDuration / 2 &&
          (!c.sectionId || c.sectionId !== previousSection)
        )
          failure("Neighbouring sections need different songs.");
        previousPath = cuePath;
        previousSection = c.sectionId || "";
        previousEnd = c.end;
        var previousTime = -1;
        if (c.effects && c.effects.length > 2) failure("Invalid music effects.");
        for (k = 0; c.effects && k < c.effects.length; k++)
          if (c.effects[k] !== "Hard Limiter" && c.effects[k] !== "Lowpass")
            failure("Invalid music effect.");
        for (k = 0; k < c.keys.length; k++) {
          key = c.keys[k];
          if (
            !number(key.time) ||
            key.time < 0 ||
            key.time <= previousTime ||
            key.time > c.end - c.start + 0.00001 ||
            !number(key.value) ||
            key.value < 0 ||
            key.value > Math.pow(10, 15 / 20) ||
            (key.envelopeValue !== undefined &&
              (!number(key.envelopeValue) ||
                key.envelopeValue < 0 ||
                key.envelopeValue > Math.pow(10, 15 / 20)))
          )
            failure("Invalid music keyframes.");
          previousTime = key.time;
        }
        if (c.keys[0].time !== 0 || Math.abs(previousTime - (c.end - c.start)) > 0.00001)
          failure("Keyframes must cover the cue.");
      }
      if (request.silence) {
        if (request.silence.length > 500) failure("Too many silence ranges.");
        for (i = 0; i < request.silence.length; i++) {
          var silence = request.silence[i];
          if (
            !silence ||
            !number(silence.start) ||
            !number(silence.end) ||
            silence.start < 0 ||
            silence.end <= silence.start
          )
            failure("Invalid sponsor or silence range.");
          for (j = 0; j < cues.length; j++)
            if (cues[j].start < silence.end && cues[j].end > silence.start)
              failure("Music crosses a sponsor or silence range.");
        }
      }
      // Choose using actual source paths, not a track name or a guessed clip name.
      var track = null;
      var spare = null;
      var trackIndex = -1;
      var spareIndex = -1;
      var library = {};
      if (request.libraryPaths)
        for (i = 0; i < request.libraryPaths.length; i++)
          library["p:" + pathKey(request.libraryPaths[i])] = true;
      for (i = 0; i < cues.length; i++) library["p:" + pathKey(cues[i].track)] = true;
      for (i = 0; i < s.audioTracks.numTracks; i++) {
        candidate = s.audioTracks[i];
        var hasMusic = false;
        for (j = 0; j < candidate.clips.numItems; j++)
          if (library["p:" + mediaPath(candidate.clips[j])]) hasMusic = true;
        if (hasMusic && !track) {
          track = candidate;
          trackIndex = i;
        }
        if (!spare && !candidate.isLocked() && candidate.clips.numItems === 0) {
          spare = candidate;
          spareIndex = i;
        }
      }
      if (!track) {
        track = spare;
        trackIndex = spareIndex;
      }
      if (!track) failure("Add an empty audio track for music first.");
      if (track.isLocked()) failure("Unlock the existing music track first.");
      if (request.targetTrackIndex !== undefined && request.targetTrackIndex !== trackIndex)
        failure("The target music track changed.");
      var replaced = null;
      if (request.action === "swap") {
        var replacement = request.replace;
        if (
          !replacement ||
          cues.length !== 1 ||
          !request.checkpointId ||
          !request.checkpointSignature ||
          replacement.start !== cues[0].start ||
          replacement.end !== cues[0].end
        )
          failure("Invalid music swap.");
        for (i = 0; i < track.clips.numItems; i++) {
          candidate = track.clips[i];
          if (
            String(candidate.nodeId) === replacement.nodeId &&
            mediaPath(candidate) === pathKey(replacement.track) &&
            Math.abs(candidate.start.seconds - replacement.start) < 0.02 &&
            Math.abs(candidate.end.seconds - replacement.end) < 0.05
          )
            replaced = candidate;
        }
        if (!replaced) failure("The placed song changed. Refusing to swap.");
      }
      for (i = 0; i < cues.length; i++)
        for (j = 0; j < track.clips.numItems; j++) {
          candidate = track.clips[j];
          if (candidate === replaced) continue;
          if (
            candidate.start.seconds < cues[i].end - 0.00001 &&
            candidate.end.seconds > cues[i].start + 0.00001
          )
            failure("Music would overwrite an existing clip. Fill empty stretches only.");
          if (
            mediaPath(candidate) === pathKey(cues[i].track) &&
            (Math.abs(candidate.end.seconds - cues[i].start) < 0.05 ||
              Math.abs(candidate.start.seconds - cues[i].end) < 0.05)
          )
            failure("Neighbouring sections need different songs.");
        }
      if (replaced)
        checkpoint = {
          ok: true,
          checkpointId: request.checkpointId,
          checkpointSignature: request.checkpointSignature
        };
      else
        checkpoint = timeline(
          "snapshot",
          true,
          request.sequenceId,
          "",
          "",
          0,
          null,
          null,
          true,
          "music"
        );
      if (!checkpoint.ok || !checkpoint.checkpointId || !checkpoint.checkpointSignature) {
        checkpoint = null;
        failure("Could not save a music undo checkpoint.");
      }
      if (
        track.clips.numItems === 0 &&
        (!String(track.name || "") || /^Audio \d+$/.test(String(track.name)))
      )
        track.name = "Music";
      var placed = [];
      bin = p.rootItem.createBin("Music");
      if (!bin) failure("Could not create the Music bin.");
      for (i = 0; i < cues.length; i++) {
        c = cues[i];
        if (p.importFiles([c.track], true, bin, false) !== true)
          failure("Could not import music: " + c.track);
        var item = null;
        for (j = 0; j < bin.children.numItems; j++) {
          var child = bin.children[j];
          if (
            child.getMediaPath &&
            String(child.getMediaPath()).toLowerCase().replace(/\\/g, "/") ===
              c.track.toLowerCase().replace(/\\/g, "/")
          )
            item = child;
        }
        if (!item) failure("Imported music was not found in its bin.");
        var oldIn = item.getInPoint(2);
        var oldOut = item.getOutPoint(2);
        var durationSeconds = (Math.round(c.end * fps) - Math.round(c.start * fps)) / fps;
        var sourceEnd = c.sourceOffset + durationSeconds;
        if (sourceEnd > Number(oldOut.seconds) + 0.000001)
          failure("The music source is shorter than its planned range.");
        var followedByNew = i + 1 < cues.length && Math.abs(cues[i + 1].start - c.end) < 0.000001;
        // 26.x floors placed durations to frames. A following new overwrite trims
        // the small margin; a terminal edge gets only a few audio samples so it
        // cannot reach the next frame or overwrite existing music.
        var margin = followedByNew
          ? Math.min(Math.max(0.02, frameDuration), cues[i + 1].end - cues[i + 1].start)
          : 2 / 48000;
        var requestedOut = Math.min(Number(oldOut.seconds), sourceEnd + margin);
        try {
          item.setInPoint(c.sourceOffset, 2);
          item.setOutPoint(requestedOut, 2);
          var actualIn = Number(item.getInPoint(2).seconds);
          var actualOut = Number(item.getOutPoint(2).seconds);
          // Audio source points snap to samples, not exactly to the requested seconds.
          if (
            Math.abs(actualIn - c.sourceOffset) >= frameDuration ||
            Math.abs(actualOut - requestedOut) >= frameDuration
          )
            failure("Premiere did not accept the music source range.");
          var placedDuration = Math.floor((actualOut - actualIn) * fps + 0.000001) / fps;
          if (
            placedDuration < durationSeconds - 0.000001 ||
            (!followedByNew && placedDuration > durationSeconds + 0.000001)
          )
            failure("The source range cannot land safely on the section boundary.");
          // The exact target range was checked above. Swap removes only its identified clip.
          if (replaced) {
            checked(replaced.remove(false, false), "music swap removal");
            replaced = null;
          }
          track.overwriteClip(item, String(c.start));
        } finally {
          if (item.clearInPoint && item.clearOutPoint) {
            item.clearInPoint();
            item.clearOutPoint();
          } else {
            item.setInPoint(oldIn.seconds, 2);
            item.setOutPoint(oldOut.seconds, 2);
          }
        }
        clip = null;
        for (j = 0; j < track.clips.numItems; j++)
          if (
            String(track.clips[j].projectItem.nodeId) === String(item.nodeId) &&
            Math.abs(track.clips[j].start.seconds - c.start) < 0.02
          )
            clip = track.clips[j];
        if (
          !clip ||
          clip.end.seconds < c.end - frameDuration / 2 ||
          clip.end.seconds > c.end + (followedByNew ? margin + frameDuration : frameDuration / 2) ||
          Math.abs(clip.inPoint.seconds - c.sourceOffset) >= frameDuration
        )
          failure("Premiere did not place the expected music range.");
        placed.push({ clip: clip, cue: c, startTransition: false, endTransition: false });
      }
      // Read back after all overwrites, which remove the temporary source margin.
      for (i = 0; i < placed.length; i++) {
        if (Math.abs(placed[i].clip.end.seconds - placed[i].cue.end) > frameDuration / 2)
          failure("Premiere left a music gap or overrun at a section boundary.");
      }
      // QE items include gaps and transitions, so match by timing rather than DOM clip index.
      var transitionCount = 0;
      var crossfadeSeconds = request.crossfade === undefined ? 3 : request.crossfade;
      if (number(crossfadeSeconds) && crossfadeSeconds > 0 && crossfadeSeconds <= 30) {
        try {
          app.enableQE();
          var qseq = qe.project.getActiveSequence();
          var qtrack = qseq.getAudioTrackAt(trackIndex);
          var transition = qe.project.getAudioTransitionByName("Constant Power");
          for (i = 0; i < placed.length; i++) {
            var left = placed[i];
            var right = null;
            for (j = 0; j < placed.length; j++)
              if (Math.abs(placed[j].cue.start - left.cue.end) < 0.02) right = placed[j];
            // Existing clips are never given new effects or automation.
            if (!right || pathKey(left.cue.track) === pathKey(right.cue.track)) continue;
            var seconds = Math.min(
              crossfadeSeconds,
              (left.cue.end - left.cue.start) / 2,
              (right.cue.end - right.cue.start) / 2
            );
            var frames = Math.max(1, Math.round(seconds * fps));
            var whole = Math.floor(frames / Math.round(fps));
            var remainder = frames % Math.round(fps);
            var duration =
              "0:00:" +
              (whole < 10 ? "0" : "") +
              whole +
              ":" +
              (remainder < 10 ? "0" : "") +
              remainder;
            for (j = 0; j < qtrack.numItems; j++) {
              var qitem = qtrack.getItemAt(j);
              if (
                qitem &&
                qitem.type === "Clip" &&
                qitem.start &&
                Math.abs(Number(qitem.start.secs) - left.cue.start) < 0.02 &&
                qitem.addTransition &&
                transition
              ) {
                var added = qitem.addTransition(
                  transition,
                  false,
                  duration,
                  "0:00:00:00",
                  0.5,
                  false,
                  false
                );
                if (added === true) {
                  left.endTransition = true;
                  right.startTransition = true;
                  transitionCount++;
                }
                break;
              }
            }
          }
        } catch (_ignoredTransition) {
          /* Deterministic Volume keyframe fades below are the fallback. */
        }
      }
      for (i = 0; i < placed.length; i++) {
        clip = placed[i].clip;
        c = placed[i].cue;
        var effectRow = [encodeURIComponent(c.id || "")];
        for (j = 0; c.effects && j < c.effects.length; j++)
          effectRow.push(
            encodeURIComponent(
              applyMusicEffect(clip, c, c.effects[j], trackIndex, frameDuration / 2)
            )
          );
        effectRows.push(effectRow.join("\t"));
        var level = null;
        for (j = 0; j < clip.components.numItems; j++) {
          var component = clip.components[j];
          if (
            component.matchName === "AE.ADBE Volume" ||
            component.matchName === "ADBE Volume" ||
            component.matchName === "audioVolume" ||
            component.displayName === "Volume"
          ) {
            for (k = 0; k < component.properties.numItems; k++) {
              var property = component.properties[k];
              if (property.displayName === "Level" || property.matchName === "ADBE Volume-0001")
                level = property;
            }
          }
        }
        if (!level || !level.areKeyframesSupported())
          failure(
            "The audio Volume / Level keyframe API is unavailable on this Premiere build or locale."
          );
        // Level is normalized: displayed 0 dB = 10^(-15/20). Values in the plan are linear gain.
        // https://ppro-scripting.docsforadobe.dev/sequence/componentparam/
        checked(level.setTimeVarying(true), "volume automation");
        for (k = 0; k < c.keys.length; k++) {
          key = c.keys[k];
          var at = time(c.sourceOffset + key.time);
          var gain = key.value;
          // Do not double-fade a successful Constant Power transition. Ducking stays explicit.
          if (
            !request.ducking &&
            number(c.baseDb) &&
            ((placed[i].startTransition && key.time <= c.fadeIn) ||
              (placed[i].endTransition && key.time >= c.end - c.start - c.fadeOut))
          )
            gain = number(key.envelopeValue) ? key.envelopeValue : Math.pow(10, c.baseDb / 20);
          checked(level.addKey(at), "a volume keyframe");
          checked(
            level.setValueAtKey(at, gain * Math.pow(10, -15 / 20), k === c.keys.length - 1),
            "a keyframe level"
          );
          checked(level.setInterpolationTypeAtKey(at, 0, false), "linear volume interpolation");
        }
      }
      current = timeline(
        "snapshot",
        false,
        request.sequenceId,
        "",
        "",
        0,
        null,
        null,
        true,
        "music"
      );
      if (!current.ok) failure("Could not verify the completed music timeline.");
      return response(
        "applied",
        current.signature,
        transitionCount + " Constant Power joins; remaining edges use Volume fades."
      );
    } catch (error) {
      if (checkpoint) {
        var after = timeline(
          "snapshot",
          false,
          request.sequenceId,
          "",
          "",
          0,
          null,
          null,
          true,
          "music"
        );
        return response("partial", after.ok ? after.signature : "", String(error).slice(0, 800));
      }
      return "axis:error|" + encodeURIComponent(String(error).slice(0, 800));
    }
  }
  var musicBusy = false;
  function musicMessage(data, origin) {
    if (data.type !== "premiere.music.request") return;
    if (typeof data.requestId !== "string" || data.requestId.length > 128) return;
    function reply(result) {
      if (backendOrigin === origin && frame.contentWindow)
        frame.contentWindow.postMessage(
          Object.assign({ type: "premiere.music", protocol: 1, requestId: data.requestId }, result),
          origin
        );
    }
    if (musicBusy) return reply({ ok: false, error: "A music operation is running." });
    if (!window.__adobe_cep__)
      return reply({ ok: false, error: "Premiere scripting is unavailable." });
    musicBusy = true;
    function done(result) {
      musicBusy = false;
      reply(result);
    }
    if (data.action === "index" || data.action === "audition") {
      try {
        nodeRequire(nodeRequire("path").join(extensionDirectory, "music-library.cjs"))
          .operation(data, extensionDirectory)
          .then(done, function (error) {
            done({ ok: false, error: String(error.message).slice(0, 1024) });
          });
      } catch (error) {
        done({ ok: false, error: String(error.message).slice(0, 1024) });
      }
      return;
    }
    if (data.action === "pick") {
      window.__adobe_cep__.evalScript(
        "(function(){var f=Folder.selectDialog('Choose music library');return f?encodeURIComponent(f.fsName):'';})()",
        function (raw) {
          try {
            done({ ok: true, root: decodeURIComponent(raw || "") });
          } catch (error) {
            done({ ok: false, error: String(error.message).slice(0, 1024) });
          }
        }
      );
      return;
    }
    if (data.action !== "apply" && data.action !== "swap" && data.action !== "undo")
      return done({ ok: false, error: "Invalid music action." });
    try {
      var encoded = JSON.stringify(data);
      if (encoded.length > 4000000) throw new Error("Music plan is too large.");
      encoded = encoded.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
      window.__adobe_cep__.evalScript("(" + musicScript() + ")(" + encoded + ")", function (raw) {
        try {
          var fields = String(raw).split("|").map(decodeURIComponent);
          if (fields[0] !== "axis:music")
            return done({
              ok: false,
              error: fields[1] || "Music scripting failed. Inspect the timeline before retrying."
            });
          done({
            ok: true,
            status: fields[1],
            checkpointId: fields[2],
            checkpointSignature: fields[3],
            expectedSignature: fields[4],
            message: fields[5],
            sequenceId: fields[6],
            effectReports: fields[7]
              ? fields[7].split("\n").map(function (row) {
                  var values = row.split("\t").map(decodeURIComponent);
                  return { id: values[0], results: values.slice(1) };
                })
              : []
          });
        } catch (error) {
          done({ ok: false, error: String(error.message).slice(0, 1024) });
        }
      });
    } catch (error) {
      done({ ok: false, error: String(error.message).slice(0, 1024) });
    }
  }

  var voCleanupBusy = false;
  function voCleanupMessage(data, origin) {
    if (data.type !== "premiere.vo-cleanup.request") return;
    if (typeof data.requestId !== "string" || !data.requestId || data.requestId.length > 128)
      return;
    function reply(result) {
      if (backendOrigin === origin && frame.contentWindow)
        frame.contentWindow.postMessage(
          Object.assign(
            { type: "premiere.vo-cleanup", protocol: 1, requestId: data.requestId },
            result
          ),
          origin
        );
    }
    var readOnly = data.action === "resolve";
    if (voCleanupBusy && !readOnly)
      return reply({ ok: false, error: "A VO cleanup operation is running." });
    if (!window.__adobe_cep__)
      return reply({ ok: false, error: "Premiere scripting is unavailable." });
    if (!readOnly) voCleanupBusy = true;
    function done(result) {
      if (!readOnly) voCleanupBusy = false;
      reply(result);
    }
    try {
      nodeRequire(nodeRequire("path").join(extensionDirectory, "vo-cleanup.cjs"))
        .operation(
          data,
          extensionDirectory,
          function (script, callback) {
            window.__adobe_cep__.evalScript(script, callback);
          },
          { timelineSource: window.AxisTimeline.operation.toString() }
        )
        .then(done, function (error) {
          done({ ok: false, error: String(error.message).slice(0, 1024) });
        });
    } catch (error) {
      done({ ok: false, error: String(error.message).slice(0, 1024) });
    }
  }

  var captionsBusy = false;
  function captionsMessage(data, origin) {
    if (data.type !== "premiere.captions.request") return;
    function reply(result) {
      if (backendOrigin === origin && frame.contentWindow)
        frame.contentWindow.postMessage(
          Object.assign(
            { type: "premiere.captions", protocol: 1, requestId: data.requestId },
            result
          ),
          origin
        );
    }
    if (typeof data.requestId !== "string" || !data.requestId || data.requestId.length > 128)
      return;
    if (
      typeof data.projectId !== "string" ||
      !data.projectId ||
      data.projectId.length > 32768 ||
      typeof data.sequenceId !== "string" ||
      !data.sequenceId ||
      data.sequenceId.length > 32768 ||
      ["add", "save", "undo"].indexOf(data.action) < 0 ||
      (data.action !== "undo" &&
        (typeof data.srt !== "string" || !data.srt || data.srt.length > 4000000)) ||
      (data.action === "add" && data.confirmed !== true) ||
      (data.action === "undo" &&
        (typeof data.binId !== "string" ||
          !data.binId ||
          data.binId.length > 512 ||
          typeof data.itemId !== "string" ||
          !data.itemId ||
          data.itemId.length > 512 ||
          (data.checkpointId &&
            (typeof data.checkpointId !== "string" ||
              data.checkpointId.length > 512 ||
              typeof data.checkpointSignature !== "string" ||
              data.checkpointSignature.length > 4000000 ||
              typeof data.expectedSignature !== "string" ||
              data.expectedSignature.length > 4000000))))
    )
      return reply({
        ok: false,
        error: "Invalid captions request. Preview and confirm captions before adding."
      });
    if (captionsBusy)
      return reply({ ok: false, error: "A captions operation is already running." });
    if (!window.__adobe_cep__)
      return reply({ ok: false, error: "Premiere scripting is unavailable." });
    var argument = {
      action: data.action,
      confirmed: data.confirmed,
      projectId: data.projectId,
      sequenceId: data.sequenceId,
      srt: data.srt,
      binId: data.binId,
      itemId: data.itemId,
      checkpointId: data.checkpointId,
      checkpointSignature: data.checkpointSignature,
      expectedSignature: data.expectedSignature,
      id: Date.now() + "-" + Math.floor(Math.random() * 1000000000)
    };
    var encoded = JSON.stringify(argument)
      .replace(/\u2028/g, "\\u2028")
      .replace(/\u2029/g, "\\u2029");
    captionsBusy = true;
    try {
      window.__adobe_cep__.evalScript("(" + captionScript() + ")(" + encoded + ")", function (raw) {
        captionsBusy = false;
        try {
          var fields = String(raw).split("|").map(decodeURIComponent);
          if (fields[0] !== "axis:captions")
            throw new Error(
              fields[0] === "axis:error"
                ? fields[1]
                : "Premiere could not complete captions. Inspect the project before retrying."
            );
          reply({
            ok: true,
            status: fields[1],
            binId: fields[2],
            itemId: fields[3],
            path: fields[4] || fields[2],
            binName: fields[5],
            checkpointId: fields[6],
            checkpointSignature: fields[7],
            expectedSignature: fields[8],
            sequenceId: fields[1] === "undone" ? fields[2] : undefined
          });
        } catch (error) {
          reply({ ok: false, error: String(error.message).slice(0, 1024) });
        }
      });
    } catch (error) {
      captionsBusy = false;
      reply({ ok: false, error: String(error.message).slice(0, 1024) });
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
    captionsMessage(event.data, event.origin);
    musicMessage(event.data, event.origin);
    voCleanupMessage(event.data, event.origin);
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
          nodeRequire("path").join(extensionDirectory, "transcript-handoff.cjs")
        ).loadTranscript(config, transcriptRequest, extensionDirectory);
      } catch (error) {
        transcriptResult = { ok: false, error: String(error.message).slice(0, 1024) };
      }
      frame.contentWindow.postMessage(
        Object.assign({}, transcriptResult, {
          type: "premiere.transcript.load",
          protocol: 1,
          requestId: transcriptRequest.requestId
        }),
        event.origin
      );
      return;
    }
    if (
      event.data.type === "premiere.diagnostics.request" &&
      typeof event.data.requestId === "string" &&
      event.data.requestId.length <= 128
    ) {
      var diagnosticsRequest = event.data;
      var diagnosticsOrigin = event.origin;
      nodeRequire(nodeRequire("path").join(extensionDirectory, "diagnostics.cjs"))
        .collect(config, extensionDirectory, runtime.probeBackend)
        .then(function (report) {
          report.bridgeState = bridgeStatus ? bridgeStatus.state : "unavailable";
          report.host = hostVersions();
          if (backendOrigin === diagnosticsOrigin)
            frame.contentWindow.postMessage(
              {
                type: "premiere.diagnostics",
                protocol: 1,
                requestId: diagnosticsRequest.requestId,
                ok: true,
                report: report
              },
              diagnosticsOrigin
            );
        })
        .catch(function () {
          frame.contentWindow.postMessage(
            {
              type: "premiere.diagnostics",
              protocol: 1,
              requestId: diagnosticsRequest.requestId,
              ok: false,
              error: "Could not collect diagnostics. Close and reopen Axis, then try again."
            },
            diagnosticsOrigin
          );
        });
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
                requestId: request.requestId
              }),
              requestOrigin
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
        if (frameLoadTimer) clearTimeout(frameLoadTimer);
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
        ')return "premiere:mismatch";var tb=parseFloat(s.timebase);s.setPlayerPosition(String(Math.max(0,Math.ceil((' +
        Number(event.data.seconds) +
        '-0.000001)*254016000000/tb))*tb));return "premiere:ok";}())';
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
              new Error("Could not open account setup. Open the local backend in your browser.")
            );
        })
        .catch(fail);
    }
  });

  function fail(error) {
    startup.hidden = false;
    frame.hidden = true;
    document.getElementById("startup-message").textContent =
      error.code === "ENOENT"
        ? "An Axis installation file is missing. Check Windows Security > Protection history, then reinstall Axis from your trusted installer. Your conversations are kept."
        : /^(EACCES|EPERM|ECONNREFUSED|ECONNRESET|ETIMEDOUT)$/.test(error.code || "")
          ? "Axis could not reach its local backend. Click Try again. Check Windows Security > Protection history if this continues, or reinstall Axis. Public network access is not required. Your conversations are kept."
          : error.message;
    retry.hidden = false;
    status("error", "Needs attention");
  }

  function connect() {
    if (connecting) return;
    if (frameLoadTimer) clearTimeout(frameLoadTimer);
    if (window.AxisPremiereBridge) window.AxisPremiereBridge.retry();
    connecting = true;
    retry.hidden = true;
    status("starting", "Connecting");
    Promise.resolve()
      .then(function () {
        if (!nodeRequire)
          throw new Error(
            "Open this extension inside Premiere Pro after running the extension installer."
          );
        var path = nodeRequire("path");
        var fs = nodeRequire("fs");
        var directory = decodeURIComponent(location.pathname)
          .replace(/^\/(?:([A-Za-z]:))/, "$1")
          .replace(/\/[^/]*$/, "");
        extensionDirectory = directory;
        runtime = nodeRequire(path.join(directory, "runtime.cjs"));
        config = runtime.validateConfig(
          JSON.parse(fs.readFileSync(path.join(directory, "config.json"), "utf8"))
        );
        backendOrigin = new URL(config.backendUrl).origin;
        return runtime.ensureBackend(config);
      })
      .then(function () {
        return runtime.pairBackend(config);
      })
      .then(function (url) {
        frame.hidden = false;
        frame.src = url;
        document.getElementById("startup-message").textContent =
          "Opening your editing workspace...";
        frameLoadTimer = setTimeout(function () {
          if (!startup.hidden)
            fail(
              new Error(
                "The workspace did not finish opening. Click Try again. If this continues, reinstall Axis and check Windows Security > Protection history."
              )
            );
        }, 20000);
        if (!timer)
          timer = setInterval(function () {
            publishContext(null);
            if (!connecting)
              runtime.probeBackend(config).catch(function (error) {
                if (error.code === "ECONNREFUSED" || error.code === "AXIS_BACKEND_STARTING")
                  connect();
                else fail(error);
              });
          }, 2000);
      })
      .catch(fail)
      .then(function () {
        connecting = false;
      });
  }

  retry.addEventListener("click", connect);
  function hostVersions() {
    try {
      var environment = JSON.parse(window.__adobe_cep__.getHostEnvironment());
      return { premiere: environment.appVersion, cep: window.__adobe_cep__.getCurrentApiVersion() };
    } catch (_error) {
      return { premiere: "unavailable", cep: "unavailable" };
    }
  }
  function refreshDiagnostics() {
    var output = document.getElementById("diagnostics-report");
    output.value = "Collecting local versions and paths...";
    if (!runtime || !config) {
      output.value =
        "Axis configuration could not be loaded. Reinstall Axis from your trusted installer. User data is retained.";
      return;
    }
    nodeRequire(nodeRequire("path").join(extensionDirectory, "diagnostics.cjs"))
      .collect(config, extensionDirectory, runtime.probeBackend)
      .then(function (report) {
        report.host = hostVersions();
        report.bridge = bridgeStatus || "unavailable";
        report.providers = "Open workspace > Menu > Diagnostics for provider sign-in status.";
        output.value = JSON.stringify(report, null, 2);
      })
      .catch(function () {
        output.value = "Could not collect diagnostics. Close and reopen Axis, then try again.";
      });
  }
  document.getElementById("diagnostics-toggle").addEventListener("click", function () {
    var panel = document.getElementById("host-diagnostics");
    panel.hidden = !panel.hidden;
    if (!panel.hidden) refreshDiagnostics();
  });
  document.getElementById("diagnostics-refresh").addEventListener("click", refreshDiagnostics);
  document.getElementById("diagnostics-copy").addEventListener("click", function () {
    var output = document.getElementById("diagnostics-report");
    output.focus();
    output.select();
    document.getElementById("diagnostics-message").textContent = document.execCommand("copy")
      ? "Report copied."
      : "Press Ctrl+C to copy the selected report.";
  });
  window.addEventListener("unload", function () {
    if (timer) clearInterval(timer);
    if (playheadTimer) clearInterval(playheadTimer);
    clearTimeout(contextReadTimeout);
    clearTimeout(playheadReadTimeout);
    if (frameLoadTimer) clearTimeout(frameLoadTimer);
  });
  readContext(function () {});
  connect();
})();
