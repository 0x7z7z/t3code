(function (root) {
  "use strict";

  /* eslint-disable no-unused-vars -- These functions also run in ES3 ExtendScript. */
  function timelineOperation(action, checkpoint, sequenceId, checkpointId, expected, turnNumber) {
    function quote(value) {
      return (
        '"' +
        // eslint-disable-next-line no-control-regex -- ES3 has no JSON serializer; escape every control character.
        String(value).replace(/[\\"\x00-\x1f\u2028\u2029]/g, function (c) {
          return "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4);
        }) +
        '"'
      );
    }
    function json(value) {
      if (value === null) return "null";
      if (typeof value === "string") return quote(value);
      if (typeof value === "number") return isFinite(value) ? String(value) : "null";
      if (typeof value === "boolean") return String(value);
      var parts = [];
      var key;
      if (Object.prototype.toString.call(value) === "[object Array]") {
        for (var i = 0; i < value.length; i++) parts.push(json(value[i]));
        return "[" + parts.join(",") + "]";
      }
      for (key in value)
        if (value.hasOwnProperty(key)) parts.push(quote(key) + ":" + json(value[key]));
      return "{" + parts.join(",") + "}";
    }
    function fail(message) {
      throw new Error(message);
    }
    function text(value) {
      return String(value === undefined || value === null ? "" : value).slice(0, 2048);
    }
    function seconds(value) {
      var result = Number(value.seconds);
      if (!isFinite(result)) fail("Premiere returned an invalid timeline time.");
      return result;
    }
    function point(seq, method) {
      var value = seconds(seq[method]());
      return value < 0 ? null : value;
    }
    function snapshot(seq, identities) {
      var count = 0;
      var truncated = false;
      function tracks(collection) {
        var list = [];
        if (collection.numTracks > 256) truncated = true;
        for (var t = 0; t < collection.numTracks && t < 256; t++) {
          var clips = collection[t].clips;
          var items = [];
          for (var c = 0; c < clips.numItems && count < 2000; c++, count++) {
            var clip = clips[c];
            var enabled = null;
            try {
              enabled = !clip.isDisabled();
            } catch (ignored) {
              try {
                if (typeof clip.disabled === "boolean") enabled = !clip.disabled;
              } catch (ignoredDisabled) {}
            }
            items.push({
              name: text(clip.name),
              nodeId: identities ? text(clip.nodeId) : "",
              projectItemName: clip.projectItem ? text(clip.projectItem.name) : "",
              start: seconds(clip.start),
              end: seconds(clip.end),
              inPoint: seconds(clip.inPoint),
              outPoint: seconds(clip.outPoint),
              enabled: enabled,
            });
          }
          if (items.length < clips.numItems) truncated = true;
          list.push({ index: t, clips: items });
        }
        return list;
      }
      var video = tracks(seq.videoTracks);
      var audio = tracks(seq.audioTracks);
      var markers = [];
      var marker = seq.markers.getFirstMarker();
      while (marker && markers.length < 500) {
        var color = null;
        try {
          color = Number(marker.getColorByIndex());
          if (!isFinite(color)) color = null;
        } catch (ignoredColor) {}
        markers.push({
          id: identities ? text(marker.guid) : "",
          name: text(marker.name),
          start: seconds(marker.start),
          end: seconds(marker.end),
          comments: text(marker.comments),
          color: color,
        });
        marker = seq.markers.getNextMarker(marker);
      }
      if (marker) truncated = true;
      return {
        projectId: text(app.project.documentID || app.project.path),
        sequenceId: identities ? text(seq.sequenceID) : "",
        name: identities ? text(seq.name) : "",
        videoTrackCount: seq.videoTracks.numTracks,
        audioTrackCount: seq.audioTracks.numTracks,
        videoTracks: video,
        audioTracks: audio,
        markers: markers,
        inPoint: point(seq, "getInPointAsTime"),
        outPoint: point(seq, "getOutPointAsTime"),
        truncated: truncated,
      };
    }
    function find(id) {
      for (var i = 0; i < app.project.sequences.numSequences; i++) {
        var seq = app.project.sequences[i];
        if (String(seq.sequenceID) === id) return seq;
      }
      return null;
    }
    function bin() {
      var item = app.project.rootItem;
      for (var i = 0; i < item.children.numItems; i++) {
        var child = item.children[i];
        if (child.name === "Axis checkpoints" && child.type === 2) return child;
      }
      return item.createBin("Axis checkpoints");
    }
    function prefix(id) {
      return "[Axis checkpoint " + id + "] ";
    }
    try {
      if (!app.project || !app.project.activeSequence) fail("Open a sequence in Premiere first.");
      var original = app.project.activeSequence;
      var originalId = String(original.sequenceID);
      if (sequenceId && originalId !== sequenceId)
        fail("The active sequence changed. Open the original sequence first.");
      var before = snapshot(original, true);
      if (action === "restore") {
        if (before.truncated || json(before) !== expected)
          fail("The timeline changed after this turn. Undo is unavailable.");
        var saved = find(checkpointId);
        if (!saved || String(saved.name).indexOf(prefix(originalId)) !== 0)
          fail("This turn's checkpoint is gone or was renamed.");
        if (json(snapshot(saved, false)) !== checkpoint)
          fail("The checkpoint was edited after this turn. Undo is unavailable.");
        var name = String(original.name);
        var savedName = String(saved.name);
        var destination = bin();
        try {
          app.project.openSequence(String(saved.sequenceID));
          if (
            !app.project.activeSequence ||
            String(app.project.activeSequence.sequenceID) !== String(saved.sequenceID)
          )
            fail("Premiere could not open the checkpoint.");
          original.name = name.slice(0, 210) + " (after turn " + turnNumber + ")";
          original.projectItem.moveBin(destination);
          saved.name = name;
        } catch (restoreError) {
          try {
            original.name = name;
            saved.name = savedName;
            app.project.openSequence(originalId);
          } catch (rollbackError) {}
          throw restoreError;
        }
        return "axis:" + json({ ok: true });
      }
      var savedId = null;
      var content = null;
      var checkpointError = null;
      if (checkpoint && !before.truncated) {
        try {
          var ids = {};
          var i;
          for (i = 0; i < app.project.sequences.numSequences; i++)
            ids["s" + app.project.sequences[i].sequenceID] = true;
          content = json(snapshot(original, false));
          if (original.clone() === false) fail("Premiere refused to clone the sequence.");
          var clone = null;
          for (i = 0; i < app.project.sequences.numSequences; i++) {
            var candidate = app.project.sequences[i];
            if (!ids["s" + candidate.sequenceID]) {
              if (clone)
                fail(
                  "Premiere created multiple sequences; the checkpoint could not be identified.",
                );
              clone = candidate;
            }
          }
          if (!clone || json(snapshot(clone, false)) !== content)
            fail("The checkpoint did not match the original timeline.");
          clone.name =
            prefix(originalId) + String(original.name).slice(0, 80) + " " + new Date().getTime();
          clone.projectItem.moveBin(bin());
          savedId = String(clone.sequenceID);
        } catch (cloneError) {
          checkpointError = String(cloneError);
        }
        app.project.openSequence(originalId);
        if (
          !app.project.activeSequence ||
          String(app.project.activeSequence.sequenceID) !== originalId
        )
          fail("Premiere could not reactivate the original sequence. No turn was sent.");
      }
      var available = [];
      for (var n = app.project.sequences.numSequences - 1; n >= 0 && available.length < 500; n--) {
        var existing = app.project.sequences[n];
        if (String(existing.name).indexOf(prefix(originalId)) === 0)
          available.push(String(existing.sequenceID));
      }
      return (
        "axis:" +
        json({
          ok: true,
          snapshot: before,
          signature: json(before),
          checkpointId: savedId,
          checkpointSignature: savedId ? content : null,
          checkpointError: checkpointError,
          checkpointIds: available,
        })
      );
    } catch (error) {
      return "axis:" + json({ ok: false, error: String(error).slice(0, 1000) });
    }
  }
  /* eslint-enable no-unused-vars */

  function handle(data, cep, reply) {
    if (data.type !== "premiere.snapshot.request" && data.type !== "premiere.restore.request")
      return false;
    function valid(value, max) {
      return typeof value === "string" && value.length > 0 && value.length <= max;
    }
    if (!valid(data.requestId, 128)) return true;
    var restore = data.type === "premiere.restore.request";
    if (
      (!restore && typeof data.checkpoint !== "boolean") ||
      (data.sequenceId !== undefined && !valid(data.sequenceId, 512)) ||
      (restore &&
        (!valid(data.sequenceId, 512) ||
          !valid(data.checkpointId, 512) ||
          !valid(data.expectedSignature, 4000000) ||
          !valid(data.checkpointSignature, 4000000) ||
          !Number.isInteger(data.turnNumber) ||
          data.turnNumber < 1))
    ) {
      reply({ ok: false, error: "Invalid timeline request." });
      return true;
    }
    if (!cep) {
      reply({ ok: false, error: "Premiere is not connected." });
      return true;
    }
    var args = [
      restore ? "restore" : "snapshot",
      restore ? data.checkpointSignature : data.checkpoint === true,
      data.sequenceId || "",
      data.checkpointId || "",
      data.expectedSignature || "",
      data.turnNumber || 1,
    ];
    try {
      cep.evalScript(
        "(" +
          timelineOperation.toString() +
          ")(" +
          args
            .map(function (v) {
              return JSON.stringify(v)
                .replace(/\u2028/g, "\\u2028")
                .replace(/\u2029/g, "\\u2029");
            })
            .join(",") +
          ")",
        function (raw) {
          try {
            if (typeof raw !== "string" || raw.length > 8000000 || raw.indexOf("axis:") !== 0)
              throw new Error("Invalid Premiere timeline response.");
            var result = JSON.parse(raw.slice(5));
            if (
              !result ||
              typeof result.ok !== "boolean" ||
              (!result.ok && typeof result.error !== "string") ||
              (result.ok &&
                !restore &&
                (!result.snapshot ||
                  typeof result.signature !== "string" ||
                  !Array.isArray(result.checkpointIds)))
            )
              throw new Error("Invalid Premiere timeline response.");
            reply(result);
          } catch (error) {
            reply({ ok: false, error: error.message });
          }
        },
      );
    } catch (error) {
      reply({ ok: false, error: error.message });
    }
    return true;
  }

  root.AxisTimeline = { handle: handle };
  if (typeof module !== "undefined")
    module.exports = { handle: handle, timelineOperation: timelineOperation };
})(typeof window !== "undefined" ? window : globalThis);
