/* eslint-disable no-unused-vars -- Serialized ExtendScript requires catch bindings even for optional host APIs. */
function axisVOCleanupHost(request, timeline) {
  var project;
  var checkpoint = null;
  var mutationStarted = false;
  var added = -1;
  var placementStart = request.start;
  var explanation = "";
  function read(work, label) {
    for (var attempt = 0; attempt < 3; attempt++) {
      try {
        var value = work();
        if (value !== undefined && value !== null) return value;
      } catch (ignoredRead) {}
      if (attempt < 2 && typeof $ !== "undefined" && $.sleep) $.sleep(40);
    }
    fail("Premiere could not read " + label + ". Try again when Premiere is ready.");
  }
  function seconds(clip, property) {
    return read(function () {
      var time = clip[property];
      if (!time || typeof time.seconds !== "number" || !isFinite(time.seconds)) return null;
      return time.seconds;
    }, "the clip's " + property);
  }
  function tracks(s, property) {
    return read(function () {
      var value = s[property];
      return value && typeof value.numTracks === "number" ? value : null;
    }, "the sequence's " + property);
  }
  function itemPoint(item, method) {
    return read(function () {
      var value = item[method](2);
      return value && typeof value.seconds === "number" && isFinite(value.seconds)
        ? value.seconds
        : null;
    }, "the cleaned source " + method);
  }
  function packet(status, values) {
    var parts = ["axis:vo", status];
    for (var p = 0; p < values.length; p++) parts.push(encodeURIComponent(String(values[p])));
    return parts.join("|");
  }
  function fail(message) {
    throw new Error(message);
  }
  function near(value, expected) {
    return isFinite(Number(value)) && Math.abs(Number(value) - expected) <= 0.001;
  }
  function same(a, b) {
    return (
      String(a).replace(/\\/g, "/").toLowerCase() === String(b).replace(/\\/g, "/").toLowerCase()
    );
  }
  function mediaPath(item) {
    if (!item || !item.getMediaPath) return "";
    return read(function () {
      return item.getMediaPath();
    }, "the media path");
  }
  function id(track) {
    return read(function () {
      var value = track && track.id;
      return value === undefined || value === null || String(value) === "" ? null : String(value);
    }, "the track ID");
  }
  function scope() {
    var current = read(function () {
      return project.documentID || project.path;
    }, "the project ID");
    if (String(current) !== request.projectId)
      fail(
        "The project changed. Open " +
          (request.projectName || request.projectId) +
          " first. The active project is " +
          (project.name || project.path || current) +
          "."
      );
  }
  function activeSequence() {
    var s = read(function () {
      return project.activeSequence;
    }, "the active sequence");
    var sequenceId = read(function () {
      return s.sequenceID;
    }, "the sequence ID");
    if (String(sequenceId) !== request.sequenceId)
      fail(
        "Open sequence " +
          (request.sequenceName || request.sequenceId) +
          ". The active sequence is " +
          (s ? s.name || s.sequenceID : "none") +
          "."
      );
    return s;
  }
  function state(action, save, expected, savedId, rollback) {
    if (typeof timeline !== "function")
      fail("Axis checkpoints are unavailable. Nothing was placed.");
    return timeline(
      action,
      save,
      request.sequenceId,
      savedId || "",
      expected || "",
      "VO cleanup",
      null,
      null,
      true,
      "vo",
      rollback === true
    );
  }
  function snapshot() {
    return read(function () {
      var result = state("snapshot", false);
      return result.ok && result.signature && result.snapshot && !result.snapshot.truncated
        ? result
        : null;
    }, "the VO timeline snapshot");
  }
  function restore(saved, expected, rollback) {
    var result = state(
      "restore",
      saved.checkpointSignature,
      expected,
      saved.checkpointId,
      rollback
    );
    if (!result.ok) fail(result.error || "The VO checkpoint could not be restored.");
    return result;
  }
  function importCleaned(fresh) {
    var file = new File(request.path);
    if (!file.exists) fail("Audio file not found.");
    var bin = null;
    for (var b = 0; b < project.rootItem.children.numItems; b++) {
      var item = project.rootItem.children[b];
      if (item.type === 2 && item.name === "Axis VO cleanup") {
        bin = item;
        break;
      }
    }
    if (!bin) bin = project.rootItem.createBin("Axis VO cleanup");
    if (!bin) fail("Premiere could not create the Axis VO cleanup bin.");
    var c;
    var existing = {};
    if (fresh) {
      // Import may deduplicate media. Only a genuinely new project item may
      // have its channel interpretation or source points changed.
      existing = read(function () {
        var ids = {};
        var pending = [project.rootItem];
        while (pending.length) {
          var folder = pending.pop();
          var children = folder.children;
          if (!children || typeof children.numItems !== "number") return null;
          for (var n = 0; n < children.numItems; n++) {
            var child = children[n];
            if (!child) return null;
            if (child.nodeId) ids["i" + String(child.nodeId)] = true;
            if (child.type === 2) pending.push(child);
          }
        }
        return ids;
      }, "the existing project items");
    }
    for (c = 0; c < bin.children.numItems; c++) {
      existing["i" + String(bin.children[c].nodeId)] = true;
      if (!fresh && same(mediaPath(bin.children[c]), file.fsName)) return bin.children[c];
    }
    if (!project.importFiles([file.fsName], true, bin, false))
      fail("Premiere could not import the cleaned VO. The file is saved.");
    return read(function () {
      for (var n = 0; n < bin.children.numItems; n++) {
        var imported = bin.children[n];
        if (
          same(mediaPath(imported), file.fsName) &&
          (!fresh || (imported.nodeId && !existing["i" + String(imported.nodeId)]))
        )
          return imported;
      }
      return null;
    }, "a separate imported cleaned VO item. The cleaned file is saved");
  }
  function timing(clip) {
    return [
      seconds(clip, "start"),
      seconds(clip, "end"),
      seconds(clip, "inPoint"),
      seconds(clip, "outPoint")
    ].join("|");
  }
  function linked(a, b) {
    if (!a.getLinkedItems) return false;
    var items = read(function () {
      return a.getLinkedItems();
    }, "linked audio channels");
    if (!items) return false;
    for (var i = 0; i < items.numItems; i++)
      if (String(items[i].nodeId) === String(b.nodeId)) return true;
    return false;
  }
  function mapping(item) {
    // Adobe's CEP sample exposes a property. Some hosts expose a callable getter.
    return read(function () {
      var value = item.getAudioChannelMapping;
      return typeof value === "function" ? item.getAudioChannelMapping() : value;
    }, "the cleaned item's audio channel mapping");
  }
  function singleMapping(m) {
    return (
      m && m.audioClipsNumber === 1 && (m.audioChannelsType === 0 || m.audioChannelsType === 1)
    );
  }
  function safeMapping(item, repair) {
    var m = mapping(item);
    if (singleMapping(m)) return;
    if (
      repair &&
      item.setAudioChannelMapping &&
      m.audioClipsNumber >= 1 &&
      m.audioChannelsType >= 0 &&
      m.audioChannelsType <= 5 &&
      m.setMappingForChannel
    ) {
      m.audioChannelsType = 1;
      m.audioClipsNumber = 1;
      if (m.setMappingForChannel(0, 0) === false || m.setMappingForChannel(1, 1) === false)
        fail("Premiere could not map the cleaned item's audio channels.");
      // Only our newly imported item is changed. A mutation is never retried.
      if (item.setAudioChannelMapping(m) === false)
        fail("Premiere could not set the cleaned item's audio channels.");
      if (singleMapping(mapping(item))) return;
    }
    fail(
      "Timeline import needs a single mono or stereo clip. Premiere could not set the cleaned item's Audio Channels. Import it into the bin instead."
    );
  }
  function audioClips(s) {
    return read(function () {
      var found = [];
      var audio = tracks(s, "audioTracks");
      for (var t = 0; t < audio.numTracks; t++) {
        var track = audio[t];
        var clips = track.clips;
        if (!clips || typeof clips.numItems !== "number") return null;
        for (var c = 0; c < clips.numItems; c++) {
          var clip = clips[c];
          if (!clip || !clip.nodeId || !clip.projectItem) return null;
          found.push({ clip: clip, track: track, index: t, path: mediaPath(clip.projectItem) });
        }
      }
      return found;
    }, "the sequence's audio clips");
  }
  function oneInstance(a, b) {
    if (
      !a.clip.projectItem.nodeId ||
      String(a.clip.projectItem.nodeId) !== String(b.clip.projectItem.nodeId) ||
      timing(a.clip) !== timing(b.clip) ||
      !linked(a.clip, b.clip) ||
      !linked(b.clip, a.clip)
    )
      return false;
    var m;
    try {
      m = mapping(a.clip.projectItem);
    } catch (ignoredMapping) {
      return false;
    }
    return m && m.audioChannelsType === 0 && m.audioClipsNumber >= 2;
  }
  function instances(clips) {
    var groups = [];
    for (var i = 0; i < clips.length; i++) {
      var group = null;
      for (var j = 0; j < groups.length; j++)
        if (oneInstance(groups[j].bottom, clips[i])) {
          group = groups[j];
          break;
        }
      if (!group) {
        group = { bottom: clips[i], members: [] };
        groups.push(group);
      }
      group.members.push(clips[i]);
      if (clips[i].index > group.bottom.index) group.bottom = clips[i];
    }
    return groups;
  }
  function selection(s) {
    return read(function () {
      return s.getSelection();
    }, "the timeline selection");
  }
  function usable(found, s) {
    var speed = read(function () {
      return found.clip.getSpeed();
    }, "the VO speed (use a forward clip at 100%)");
    var reversed = read(function () {
      return found.clip.isSpeedReversed();
    }, "the VO direction");
    if (reversed !== false && reversed !== 0)
      fail("The VO is reversed. Use forward playback for timeline import.");
    if (typeof speed !== "number" || !isFinite(speed) || Math.abs(speed - 1) > 0.000001)
      fail("The VO is retimed. Use 100% speed for timeline import.");
    if (
      !(seconds(found.clip, "end") > seconds(found.clip, "start")) ||
      !(seconds(found.clip, "outPoint") > seconds(found.clip, "inPoint"))
    )
      fail("The VO has an invalid source or timeline range. Select a usable VO clip.");
    id(found.track);
    var audio = tracks(s, "audioTracks");
    for (var i = found.index; i < audio.numTracks; i++) {
      var track = audio[i];
      var locked = read(
        function () {
          return track.isLocked();
        },
        "the lock state of A" + (i + 1)
      );
      if (locked !== false) fail("A" + (i + 1) + " is locked, unlock it and try again.");
    }
    return found;
  }
  function sourcePacket(found, s) {
    return packet("source", [
      found.path,
      s.sequenceID,
      found.index,
      seconds(found.clip, "start"),
      seconds(found.clip, "inPoint"),
      seconds(found.clip, "outPoint"),
      String(project.documentID || project.path),
      String(found.clip.nodeId),
      id(found.track),
      seconds(found.clip, "end"),
      project.name || project.path || "",
      s.name || ""
    ]);
  }
  function resolveSource(s, path) {
    var clips = audioClips(s);
    var matches = [];
    for (var i = 0; i < clips.length; i++) if (same(clips[i].path, path)) matches.push(clips[i]);
    var groups = instances(matches);
    if (groups.length === 1) return usable(groups[0].bottom, s);
    if (groups.length > 1) {
      var selected = selection(s);
      var chosen = [];
      for (var g = 0; g < groups.length; g++) {
        var has = false;
        for (var m = 0; m < groups[g].members.length; m++)
          for (var k = 0; k < selected.length; k++)
            if (String(selected[k].nodeId) === String(groups[g].members[m].clip.nodeId)) has = true;
        if (has) chosen.push(groups[g].bottom);
      }
      if (chosen.length === 1) return usable(chosen[0], s);
      if (chosen.length === 0) {
        var usableGroups = [];
        var problem = "";
        for (var u = 0; u < groups.length; u++) {
          try {
            usableGroups.push(usable(groups[u].bottom, s));
          } catch (unusable) {
            problem = String(unusable);
          }
        }
        if (usableGroups.length === 1) return usableGroups[0];
        if (!usableGroups.length && problem) fail(problem.replace(/^Error: /, ""));
      }
      fail(
        "Select the VO clip to use, then click Use selected clip. This file appears more than once."
      );
    }
    fail("No clip using this file was found in sequence " + (s.name || s.sequenceID) + ".");
  }
  function anchor(s) {
    var clips = audioClips(s);
    var byId = [];
    var byPosition = [];
    for (var i = 0; i < clips.length; i++) {
      if (String(clips[i].clip.nodeId) === request.nodeId) byId.push(clips[i]);
      if (
        same(clips[i].path, request.sourcePath) &&
        near(seconds(clips[i].clip, "start"), request.start)
      )
        byPosition.push(clips[i]);
    }
    var groups = instances(byId.length ? byId : byPosition);
    if (groups.length !== 1) fail("The VO clip is gone or ambiguous. Select the VO clip again.");
    var found = groups[0].bottom;
    if (!same(found.path, request.sourcePath))
      fail("The VO source changed. Select the VO clip again.");
    for (var linkedIndex = 0; linkedIndex < clips.length; linkedIndex++)
      if (clips[linkedIndex].index > found.index && oneInstance(found, clips[linkedIndex]))
        found = clips[linkedIndex];
    return usable(found, s);
  }
  function inventory(collection) {
    return read(function () {
      if (!collection || typeof collection.numTracks !== "number") return null;
      var rows = [];
      var ids = {};
      for (var t = 0; t < collection.numTracks; t++) {
        var track = collection[t];
        var trackId = id(track);
        if (ids["t" + trackId]) fail("Premiere returned duplicate track IDs. Nothing was placed.");
        ids["t" + trackId] = true;
        var locked = track.isLocked();
        var clips = track.clips;
        if (
          track.name === undefined ||
          (locked !== true && locked !== false) ||
          !clips ||
          typeof clips.numItems !== "number"
        )
          return null;
        var parts = [trackId, String(track.name), String(locked)];
        var header = parts.join("|");
        for (var c = 0; c < clips.numItems; c++) {
          var clip = clips[c];
          if (!clip.nodeId || !mediaPath(clip.projectItem))
            fail("Could not identify every existing clip safely.");
          parts.push(String(clip.nodeId), timing(clip), mediaPath(clip.projectItem));
        }
        // Encode individual fields so delimiters in names and paths cannot hide a change.
        for (var p = 0; p < parts.length; p++) parts[p] = encodeURIComponent(parts[p]);
        rows.push({
          id: trackId,
          header: header,
          signature: parts.join("|"),
          count: clips.numItems,
          locked: locked
        });
      }
      return rows;
    }, "every existing track and clip");
  }
  function unchanged(before, after, skip) {
    var n = 0;
    for (var i = 0; i < after.length; i++) {
      if (i === skip) continue;
      if (n >= before.length || before[n].signature !== after[i].signature) return false;
      n++;
    }
    return n === before.length;
  }
  function newTrack(before, s) {
    var after = inventory(tracks(s, "audioTracks"));
    var old = {};
    var found = -1;
    for (var i = 0; i < before.length; i++) old["t" + before[i].id] = true;
    for (var j = 0; j < after.length; j++)
      if (!old["t" + after[j].id]) {
        if (found >= 0) fail("Premiere added more than one audio track.");
        found = j;
      }
    if (after.length !== before.length + 1 || found < 0 || !unchanged(before, after, found))
      fail("Premiere did not add exactly one empty audio track safely.");
    if (after[found].count !== 0 || after[found].locked)
      fail("The added audio track is not empty and unlocked.");
    return found;
  }
  function placementUnchanged(before, after, target) {
    if (before.length !== after.length) return false;
    for (var i = 0; i < before.length; i++) {
      if (i === target) {
        if (before[i].count !== 0 || before[i].header !== after[i].header) return false;
      } else if (before[i].signature !== after[i].signature) return false;
    }
    return true;
  }
  try {
    project = app.project;
    if (request.action === "pick") {
      var chosen = File.openDialog("Choose voice-over audio");
      return packet("source", [chosen ? chosen.fsName : ""]);
    }
    if (!project) fail("Open a Premiere project first.");
    if (request.action === "selected") {
      var seen = {};
      var s = project.activeSequence;
      var clips = s ? selection(s) : [];
      var selected = [];
      var all = s ? audioClips(s) : [];
      for (var k = 0; k < clips.length; k++) {
        if (String(clips[k].mediaType) !== "Audio") continue;
        var key = "clip:" + String(clips[k].nodeId);
        if (seen[key]) continue;
        for (var c = 0; c < all.length; c++)
          if (String(all[c].clip.nodeId) === String(clips[k].nodeId)) selected.push(all[c]);
        seen[key] = true;
      }
      if (selected.length) {
        var groups = instances(selected);
        if (groups.length !== 1) fail("Select only one VO clip on the timeline.");
        return sourcePacket(usable(groups[0].bottom, s), s);
      }
      var found = [];
      var views = app.getProjectViewIDs
        ? read(function () {
            return app.getProjectViewIDs();
          }, "Project panel views")
        : [];
      for (var v = 0; v < views.length; v++) {
        var viewSelection = read(function () {
          return app.getProjectViewSelection(views[v]);
        }, "the Project panel selection");
        for (var i = 0; i < viewSelection.length; i++) {
          var media = mediaPath(viewSelection[i]);
          var itemKey = "item:" + String(viewSelection[i].nodeId || media);
          if (media && !seen[itemKey]) {
            found.push([media]);
            seen[itemKey] = true;
          }
        }
      }
      if (found.length === 1) return packet("source", found[0]);
      if (found.length > 1) fail("Select only one audio item in the Project panel.");
      fail("Select one VO clip on the timeline or one audio item in the Project panel.");
    }
    if (request.action === "resolve") {
      scope();
      var active = activeSequence();
      try {
        return sourcePacket(resolveSource(active, request.path), active);
      } catch (resolveError) {
        return packet("unanchored", [request.path, String(resolveError).replace(/^Error: /, "")]);
      }
    }
    scope();
    if (request.action === "import") return packet("imported", [mediaPath(importCleaned())]);
    if (request.action === "unplace") {
      activeSequence();
      if (!request.checkpointId || !request.checkpointSignature || !request.expectedSignature)
        fail("Missing VO checkpoint. Check the timeline and use Undo in Premiere.");
      var undone = restore(request, request.expectedSignature);
      return packet("unplaced", [
        "",
        undone.sequenceId,
        "Checkpoint restored. The changed sequence and its added track remain in Axis checkpoints."
      ]);
    }
    if (request.action !== "place") fail("Invalid VO project action.");
    if (request.confirmed !== true)
      fail("Choose Import into timeline, then Clean VO to confirm placement.");
    var sequence = activeSequence();
    var vo = anchor(sequence);
    var item = importCleaned(true);
    if (String(item.nodeId) === String(vo.clip.projectItem.nodeId))
      fail("Premiere did not import a separate cleaned VO item. Nothing was placed.");
    safeMapping(item, true);
    var beforeAudio = inventory(tracks(sequence, "audioTracks"));
    var beforeVideo = inventory(tracks(sequence, "videoTracks"));
    var frame = Number(sequence.timebase) / 254016000000;
    if (!(frame > 0 && frame < 1)) fail("Could not verify the sequence frame rate.");
    var oldIn = itemPoint(item, "getInPoint");
    var oldOut = itemPoint(item, "getOutPoint");
    var sourceIn = request.keepTiming ? seconds(vo.clip, "inPoint") : 0;
    var sourceOut = request.keepTiming ? seconds(vo.clip, "outPoint") : oldOut;
    if (
      !isFinite(oldIn) ||
      !isFinite(oldOut) ||
      !(sourceOut > sourceIn) ||
      sourceOut > oldOut + 0.001
    )
      fail("The cleaned source is shorter than the VO range.");
    var start = seconds(vo.clip, "start");
    placementStart = start;
    var duration = Math.floor((sourceOut - sourceIn) / frame + 0.000001) * frame;
    if (!(duration > 0)) fail("The cleaned source range is too short.");
    var readyAudio = null;
    try {
      // Same audio-only media type as Music. Never clear custom source points.
      item.setInPoint(sourceIn, 2);
      item.setOutPoint(sourceOut, 2);
      if (
        !near(itemPoint(item, "getInPoint"), sourceIn) ||
        !near(itemPoint(item, "getOutPoint"), sourceOut)
      )
        fail("Premiere did not accept the cleaned VO source range.");
      checkpoint = state("snapshot", true);
      if (
        !checkpoint.ok ||
        !checkpoint.checkpointId ||
        !checkpoint.checkpointSignature ||
        !checkpoint.snapshot ||
        checkpoint.snapshot.truncated
      ) {
        checkpoint = null;
        fail("Could not save a verified VO undo checkpoint. Nothing was placed.");
      }
      // Cloning can change the active sequence. Recheck the exact instance just before mutation.
      sequence = activeSequence();
      vo = anchor(sequence);
      if (
        !near(seconds(vo.clip, "start"), start) ||
        (request.keepTiming &&
          (!near(seconds(vo.clip, "inPoint"), sourceIn) ||
            !near(seconds(vo.clip, "outPoint"), sourceOut)))
      )
        fail("The VO changed while saving its checkpoint. Try placement again.");
      safeMapping(item);
      app.enableQE();
      var qeSequence = read(function () {
        return qe.project.getActiveSequence();
      }, "the QE sequence");
      if (!qeSequence) fail("Premiere could not add a track.");
      mutationStarted = true;
      // Verify the result rather than trusting undocumented QE index semantics.
      qeSequence.addTracks(0, 0, 1, 1, vo.index + 1, 0, 0);
      added = newTrack(beforeAudio, sequence);
      vo = anchor(sequence);
      var target = added;
      if (added !== vo.index + 1) {
        // The first write succeeded safely, but QE interpreted its index
        // differently. Choose a separately verified destination, never repeat it.
        var currentAudio = inventory(tracks(sequence, "audioTracks"));
        var below = currentAudio[vo.index + 1];
        if (below && below.count === 0 && !below.locked) {
          target = vo.index + 1;
          explanation =
            "Used the empty track below the VO because Premiere added the new track elsewhere.";
        } else if (added === currentAudio.length - 1) {
          explanation =
            "Used the bottom track because Premiere added the new track there instead of below the VO.";
        } else {
          var intermediate = currentAudio;
          qeSequence.addTracks(0, 0, 1, 1, intermediate.length, 0, 0);
          target = newTrack(intermediate, sequence);
          if (target !== tracks(sequence, "audioTracks").numTracks - 1)
            fail("Premiere could not add the fallback track at the bottom safely.");
          explanation =
            "Used the bottom track because Premiere could not add a track directly below the VO.";
        }
      }
      if (!unchanged(beforeVideo, inventory(tracks(sequence, "videoTracks")), -1))
        fail("Video tracks changed while adding the VO track.");
      var track = read(function () {
        return tracks(sequence, "audioTracks")[target];
      }, "the destination track");
      var isNew = true;
      for (var originalTrack = 0; originalTrack < beforeAudio.length; originalTrack++)
        if (beforeAudio[originalTrack].id === id(track)) isNew = false;
      if (isNew) track.name = "Clean VO";
      readyAudio = inventory(tracks(sequence, "audioTracks"));
      safeMapping(item);
      track.overwriteClip(item, String(start));
      var placed = read(function () {
        return track.clips.numItems === 1 ? track.clips[0] : null;
      }, "exactly one placed cleaned VO clip");
      if (
        !same(mediaPath(placed.projectItem), request.path) ||
        !near(seconds(placed, "start"), start) ||
        !near(seconds(placed, "end"), start + duration) ||
        !near(seconds(placed, "inPoint"), sourceIn) ||
        !near(seconds(placed, "outPoint"), sourceIn + duration)
      )
        fail("Premiere did not place the expected cleaned VO range.");
      if (
        !placementUnchanged(readyAudio, inventory(tracks(sequence, "audioTracks")), target) ||
        !unchanged(beforeVideo, inventory(tracks(sequence, "videoTracks")), -1)
      )
        fail("Other clips changed during VO placement.");
      added = target;
    } finally {
      item.setInPoint(oldIn, 2);
      item.setOutPoint(oldOut, 2);
      if (
        !near(itemPoint(item, "getInPoint"), oldIn) ||
        !near(itemPoint(item, "getOutPoint"), oldOut)
      )
        fail("Premiere did not restore the cleaned item's source points.");
    }
    var completed = snapshot();
    var finalClips = completed.snapshot.audioTracks[added].clips;
    if (
      finalClips.length !== 1 ||
      !same(finalClips[0].mediaPath, request.path) ||
      !near(finalClips[0].start, start) ||
      !near(finalClips[0].end, start + duration) ||
      !near(finalClips[0].inPoint, sourceIn) ||
      !near(finalClips[0].outPoint, sourceIn + duration)
    )
      fail("Premiere did not retain the final cleaned VO range.");
    if (
      !placementUnchanged(readyAudio, inventory(tracks(sequence, "audioTracks")), added) ||
      !unchanged(beforeVideo, inventory(tracks(sequence, "videoTracks")), -1)
    )
      fail("Other clips changed while restoring the cleaned item's source points.");
    return packet("placed", [
      mediaPath(item),
      added,
      start,
      checkpoint.checkpointId,
      checkpoint.checkpointSignature,
      completed.signature,
      "Placed on A" +
        (added + 1) +
        " at " +
        start.toFixed(3) +
        " s." +
        (explanation ? " " + explanation : "")
    ]);
  } catch (error) {
    var message = String(error).slice(0, 600);
    if (mutationStarted && checkpoint) {
      var after = null;
      try {
        try {
          after = snapshot();
        } catch (ignoredSnapshot) {}
        restore(checkpoint, after ? after.signature : "", true);
        message +=
          " The checkpoint was restored automatically, including the original track layout. The changed sequence remains in Axis checkpoints.";
      } catch (restoreError) {
        return packet("recovery", [
          request.path,
          added,
          placementStart,
          checkpoint.checkpointId,
          checkpoint.checkpointSignature,
          after ? after.signature : "",
          message +
            " Automatic restore failed: " +
            String(restoreError).slice(0, 250) +
            " The added track may still be present. Check the timeline and use Undo placement."
        ]);
      }
    }
    return "axis:error|" + encodeURIComponent(message);
  }
}
/* eslint-enable no-unused-vars */
