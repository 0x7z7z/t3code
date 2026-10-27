(function (root) {
  "use strict";

  /* eslint-disable no-unused-vars -- These functions also run in ES3 ExtendScript. */
  // prettier-ignore
  function timelineOperation(
    action,
    checkpoint,
    sequenceId,
    checkpointId,
    expected,
    turnNumber,
    range,
    cutRange,
    rawResult,
    checkpointKind,
    internalRollback
  ) {
    function result(value) {
      return rawResult ? value : "axis:" + json(value);
    }
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
            var speed = null;
            var reversed = null;
            try {
              var rate = clip.getSpeed();
              if (typeof rate === "number" && isFinite(rate)) speed = rate;
            } catch (ignoredSpeed) {}
            try {
              var direction = clip.isSpeedReversed();
              if (typeof direction === "boolean") reversed = direction;
            } catch (ignoredDirection) {}
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
              projectItemId: clip.projectItem ? text(clip.projectItem.nodeId) : "",
              mediaPath: clip.projectItem && clip.projectItem.getMediaPath ? text(clip.projectItem.getMediaPath()) : "",
              speed: speed,
              reversed: reversed,
              start: seconds(clip.start),
              end: seconds(clip.end),
              inPoint: seconds(clip.inPoint),
              outPoint: seconds(clip.outPoint),
              enabled: enabled
            });
          }
          if (items.length < clips.numItems) truncated = true;
          var locked = false;
          try { locked = collection[t].isLocked(); } catch (ignoredLock) {}
          list.push({ index: t, name: text(collection[t].name), locked: locked, clips: items });
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
          color: color
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
        truncated: truncated
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
    // The bin holding a project item; Premiere's ExtendScript has no parent link.
    function parentBin(target) {
      if (!target || !target.nodeId) return null;
      var pending = [app.project.rootItem];
      while (pending.length) {
        var folder = pending.shift();
        for (var c = 0; c < folder.children.numItems; c++) {
          var child = folder.children[c];
          if (String(child.nodeId) === String(target.nodeId)) return folder;
          if (child.type === 2) pending.push(child);
        }
      }
      return null;
    }
    function prefix(id) {
      // Caption, music and VO panels retain their own undo receipts. Keep these
      // clones out of automatic turn-checkpoint pruning.
      return (
        (checkpointKind === "captions" ? "[Axis caption checkpoint " : checkpointKind === "music" ? "[Axis music checkpoint " : checkpointKind === "vo" ? "[Axis VO checkpoint " : "[Axis checkpoint ") +
        id +
        "] "
      );
    }
    var mutationStarted = false;
    function requireStandalone(seq) {
      var itemId = seq.projectItem && seq.projectItem.nodeId;
      if (!itemId) return;
      for (var n = 0; n < app.project.sequences.numSequences; n++) {
        var other = app.project.sequences[n];
        if (String(other.sequenceID) === String(seq.sequenceID)) continue;
        var groups = [other.videoTracks, other.audioTracks];
        for (var g = 0; g < groups.length; g++) {
          for (var t = 0; t < groups[g].numTracks; t++) {
            var clips = groups[g][t].clips;
            for (var c = 0; c < clips.numItems; c++) {
              var item = clips[c].projectItem;
              if (item && String(item.nodeId) === String(itemId))
                fail(
                  "This sequence is nested in another sequence. Checkpoint swaps cannot restore its parent references."
                );
            }
          }
        }
      }
    }
    try {
      if (!app.project || !app.project.activeSequence) fail("Open a sequence in Premiere first.");
      var original = app.project.activeSequence;
      var originalId = String(original.sequenceID);
      if (sequenceId && originalId !== sequenceId)
        fail("The active sequence changed. Open the original sequence first.");
      if (action === "prune") {
        // Only the latest changed turn can be undone, so other checkpoints of
        // this sequence are deleted instead of piling up in the project.
        var removed = 0;
        for (var p = app.project.sequences.numSequences - 1; p >= 0; p--) {
          var old = app.project.sequences[p];
          if (
            String(old.name).indexOf(prefix(originalId)) === 0 &&
            String(old.sequenceID) !== checkpointId &&
            app.project.deleteSequence(old) !== false
          )
            removed++;
        }
        return result({ ok: true, removed: removed });
      }
      // Only a synchronous VO failure can skip reading a damaged after-state.
      // Normal Undo still requires the exact signature, including later edits.
      var rollingBack = action === "restore" && checkpointKind === "vo" && rawResult === true && internalRollback === true;
      var before = rollingBack ? null : snapshot(original, true);
      if (action === "restore") {
        requireStandalone(original);
        if (!rollingBack && (before.truncated || json(before) !== expected))
          fail("The timeline changed after this turn. Undo is unavailable.");
        var saved = find(checkpointId);
        if (!saved || String(saved.name).indexOf(prefix(originalId)) !== 0)
          fail("This turn's checkpoint is gone or was renamed.");
        if (json(snapshot(saved, false)) !== checkpoint)
          fail("The checkpoint was edited after this turn. Undo is unavailable.");
        var name = String(original.name);
        var savedName = String(saved.name);
        var destination = bin();
        var home = parentBin(original.projectItem) || app.project.rootItem;
        var savedHome = parentBin(saved.projectItem) || destination;
        try {
          app.project.openSequence(String(saved.sequenceID));
          if (
            !app.project.activeSequence ||
            String(app.project.activeSequence.sequenceID) !== String(saved.sequenceID)
          )
            fail("Premiere could not open the checkpoint.");
          original.name = name.slice(0, 210) + " (after turn " + turnNumber + ")";
          if (original.projectItem.moveBin(destination) === false)
            fail("Premiere refused to move the current sequence to the checkpoint bin.");
          saved.name = name;
          // The restored version takes the original's place in the project panel.
          if (saved.projectItem.moveBin(home) === false)
            fail("Premiere refused to move the restored sequence to its original bin.");
          if (
            !app.project.activeSequence ||
            String(app.project.activeSequence.sequenceID) !== String(saved.sequenceID) ||
            json(snapshot(saved, false)) !== checkpoint
          )
            fail("The restored checkpoint did not match the saved timeline.");
        } catch (restoreError) {
          var recovery = [
            function () {
              original.name = name;
            },
            function () {
              saved.name = savedName;
            },
            function () {
              if (original.projectItem.moveBin(home) === false)
                fail("Current sequence bin move failed.");
            },
            function () {
              if (saved.projectItem.moveBin(savedHome) === false)
                fail("Checkpoint bin move failed.");
            },
            function () {
              app.project.openSequence(originalId);
              if (
                !app.project.activeSequence ||
                String(app.project.activeSequence.sequenceID) !== originalId
              )
                fail("Could not reopen the current sequence.");
            }
          ];
          var recoveryErrors = [];
          for (var r = 0; r < recovery.length; r++) {
            try {
              recovery[r]();
            } catch (rollbackError) {
              recoveryErrors.push(String(rollbackError));
            }
          }
          if (recoveryErrors.length)
            fail(
              String(restoreError) +
                " Restore recovery was incomplete. Inspect both sequences: " +
                recoveryErrors.join("; ")
            );
          throw restoreError;
        }
        return result({ ok: true, sequenceId: String(saved.sequenceID) });
      }
      var cutting = action === "cut";
      if (cutting) {
        if (expected && json(before) !== expected)
          fail("The timeline changed since cleanup review. Review the cuts again.");
        if (before.truncated) fail("This sequence exceeds the checkpoint limit. No range was cut.");
        cutRange(original, range, true);
      }
      var savedId = null;
      var content = null;
      var checkpointError = null;
      if (checkpoint && !before.truncated) {
        try {
          requireStandalone(original);
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
                  "Premiere created multiple sequences; the checkpoint could not be identified."
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
      var cutError = null;
      if (cutting) {
        if (!savedId)
          fail(checkpointError || "No verified checkpoint could be created. No range was cut.");
        try {
          mutationStarted = true;
          cutRange(original, range, false);
        } catch (rangeError) {
          cutError = String(rangeError).slice(0, 1000);
        }
        before = snapshot(original, true);
      }
      var available = [];
      for (var n = app.project.sequences.numSequences - 1; n >= 0 && available.length < 500; n--) {
        var existing = app.project.sequences[n];
        if (String(existing.name).indexOf(prefix(originalId)) === 0)
          available.push(String(existing.sequenceID));
      }
      return result({
        ok: true,
        snapshot: before,
        signature: json(before),
        checkpointId: savedId,
        checkpointSignature: savedId ? content : null,
        checkpointError: checkpointError,
        checkpointIds: available,
        cutError: cutError
      });
    } catch (error) {
      return result({
        ok: false,
        error: String(error).slice(0, 1000),
        unchanged: !mutationStarted
      });
    }
  }
  /* eslint-enable no-unused-vars */

  function handle(data, cep, reply) {
    if (
      data.type !== "premiere.snapshot.request" &&
      data.type !== "premiere.restore.request" &&
      data.type !== "premiere.cut.request" &&
      data.type !== "premiere.prune.request"
    )
      return false;
    function valid(value, max) {
      return typeof value === "string" && value.length > 0 && value.length <= max;
    }
    if (!valid(data.requestId, 128)) return true;
    var restore = data.type === "premiere.restore.request";
    var prune = data.type === "premiere.prune.request";
    var cutting = data.type === "premiere.cut.request";
    var batch = cutting && data.ranges !== undefined;
    var rangesValid = true;
    if (batch) {
      rangesValid =
        Array.isArray(data.ranges) && data.ranges.length > 0 && data.ranges.length <= 2000;
      if (rangesValid)
        for (var ri = 0; ri < data.ranges.length; ri++) {
          var row = data.ranges[ri];
          if (
            !row ||
            typeof row.start !== "number" ||
            !isFinite(row.start) ||
            typeof row.end !== "number" ||
            !isFinite(row.end) ||
            row.start < 0 ||
            row.end <= row.start ||
            row.end > 8640000
          )
            rangesValid = false;
        }
    }
    if (
      (prune &&
        (!valid(data.sequenceId, 512) ||
          (data.keepId !== undefined && !valid(data.keepId, 512)))) ||
      (!restore && !prune && !cutting && typeof data.checkpoint !== "boolean") ||
      (cutting &&
        (!root.AxisRangeCut ||
          !valid(data.sequenceId, 512) ||
          !valid(data.projectId, 2048) ||
          !rangesValid ||
          (batch && !valid(data.expectedSignature, 4000000)) ||
          (!batch &&
            (typeof data.start !== "number" ||
              !isFinite(data.start) ||
              typeof data.end !== "number" ||
              !isFinite(data.end) ||
              data.start < 0 ||
              data.end <= data.start ||
              data.end > 8640000)))) ||
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
      restore ? "restore" : prune ? "prune" : cutting ? "cut" : "snapshot",
      restore ? data.checkpointSignature : cutting || data.checkpoint === true,
      data.sequenceId || "",
      (prune ? data.keepId : data.checkpointId) || "",
      data.expectedSignature || "",
      data.turnNumber || 1,
      cutting
        ? batch
          ? { ranges: data.ranges, projectId: data.projectId }
          : { start: data.start, end: data.end, projectId: data.projectId }
        : null
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
          (cutting ? "," + root.AxisRangeCut.toString() : "") +
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
                !prune &&
                (!result.snapshot ||
                  typeof result.signature !== "string" ||
                  !Array.isArray(result.checkpointIds)))
            )
              throw new Error("Invalid Premiere timeline response.");
            reply(result);
          } catch (error) {
            reply({ ok: false, error: error.message });
          }
        }
      );
    } catch (error) {
      reply({ ok: false, error: error.message });
    }
    return true;
  }

  root.AxisTimeline = { handle: handle, operation: timelineOperation };
  if (typeof module !== "undefined")
    module.exports = { handle: handle, timelineOperation: timelineOperation };
})(typeof window !== "undefined" ? window : globalThis);
