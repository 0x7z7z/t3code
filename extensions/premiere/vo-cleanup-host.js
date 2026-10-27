/* eslint-disable no-unused-vars -- Serialized ExtendScript requires catch bindings even for optional host APIs. */
function axisVOCleanupHost(request, timeline) {
  var project;
  var checkpoint = null;
  var mutationStarted = false;
  var added = -1;
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
    try {
      return item && item.getMediaPath ? String(item.getMediaPath() || "") : "";
    } catch (ignored) {
      return "";
    }
  }
  function id(track) {
    if (!track || track.id === undefined || track.id === null || String(track.id) === "")
      fail("Premiere could not identify the audio tracks safely. Nothing was placed.");
    return String(track.id);
  }
  function scope() {
    if (String(project.documentID || project.path) !== request.projectId)
      fail("The project changed. Open the original project first.");
  }
  function activeSequence() {
    var s = project.activeSequence;
    if (!s || String(s.sequenceID) !== request.sequenceId)
      fail("Open the sequence the VO came from, then try again.");
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
    var result = state("snapshot", false);
    if (!result.ok || !result.signature || result.snapshot.truncated)
      fail(result.error || "Could not verify the VO timeline.");
    return result;
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
  function importCleaned() {
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
    for (c = 0; c < bin.children.numItems; c++)
      if (same(mediaPath(bin.children[c]), file.fsName)) return bin.children[c];
    if (!project.importFiles([file.fsName], true, bin, false))
      fail("Premiere could not import the cleaned VO. The file is saved.");
    for (c = 0; c < bin.children.numItems; c++)
      if (same(mediaPath(bin.children[c]), file.fsName)) return bin.children[c];
    fail("Import could not be verified. The cleaned file is saved.");
  }
  function timing(clip) {
    return [
      Number(clip.start.seconds),
      Number(clip.end.seconds),
      Number(clip.inPoint.seconds),
      Number(clip.outPoint.seconds)
    ].join("|");
  }
  function linked(a, b) {
    if (!a.getLinkedItems) return false;
    var items = a.getLinkedItems();
    if (!items) return false;
    for (var i = 0; i < items.numItems; i++)
      if (String(items[i].nodeId) === String(b.nodeId)) return true;
    return false;
  }
  function mapping(item) {
    // Adobe's CEP sample exposes a property. Some hosts expose a callable getter.
    var value = item.getAudioChannelMapping;
    return typeof value === "function" ? item.getAudioChannelMapping() : value;
  }
  function safeMapping(item) {
    var m = mapping(item);
    if (!m || m.audioClipsNumber !== 1 || (m.audioChannelsType !== 0 && m.audioChannelsType !== 1))
      fail(
        "Timeline import needs a single mono or stereo clip. Change the cleaned file's Audio Channels in Premiere, or import it into the bin."
      );
  }
  function anchor(s) {
    var found = null;
    for (var t = 0; t < s.audioTracks.numTracks; t++) {
      var track = s.audioTracks[t];
      var clips = track.clips;
      for (var c = 0; c < clips.numItems; c++)
        if (String(clips[c].nodeId) === request.nodeId) {
          if (found) fail("The VO clip is ambiguous. Select it again.");
          found = { clip: clips[c], track: track, index: t };
        }
    }
    if (
      !found ||
      id(found.track) !== request.trackId ||
      Number(found.clip.start.seconds) !== request.start ||
      Number(found.clip.end.seconds) !== request.end ||
      Number(found.clip.inPoint.seconds) !== request.inPoint ||
      Number(found.clip.outPoint.seconds) !== request.outPoint
    )
      fail("The VO clip changed or is gone. Select it again.");
    var speed;
    var reversed;
    try {
      speed = found.clip.getSpeed();
      reversed = found.clip.isSpeedReversed();
    } catch (ignoredSpeed) {
      fail("Could not verify the VO speed. Use a forward clip at 100%.");
    }
    if (
      typeof speed !== "number" ||
      Math.abs(speed - 1) > 0.000001 ||
      (reversed !== false && reversed !== 0)
    )
      fail("Timeline import needs a forward VO clip at 100% speed.");
    for (var i = found.index; i < s.audioTracks.numTracks; i++) {
      if (!s.audioTracks[i].isLocked || s.audioTracks[i].isLocked() !== false)
        fail("Unlock the VO track and all audio tracks below it before timeline import.");
    }
    return found;
  }
  function inventory(collection) {
    var rows = [];
    var ids = {};
    for (var t = 0; t < collection.numTracks; t++) {
      var track = collection[t];
      var trackId = id(track);
      if (ids["t" + trackId]) fail("Premiere returned duplicate track IDs. Nothing was placed.");
      ids["t" + trackId] = true;
      var parts = [trackId, String(track.name), String(track.isLocked())];
      for (var c = 0; c < track.clips.numItems; c++) {
        var clip = track.clips[c];
        if (!clip.nodeId || !mediaPath(clip.projectItem))
          fail("Could not identify every existing clip safely.");
        parts.push(String(clip.nodeId), timing(clip), mediaPath(clip.projectItem));
      }
      // Encode individual fields so delimiters in names and paths cannot hide a change.
      for (var p = 0; p < parts.length; p++) parts[p] = encodeURIComponent(parts[p]);
      rows.push({ id: trackId, signature: parts.join("|") });
    }
    return rows;
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
  function newTrack(before, s, vo) {
    var after = inventory(s.audioTracks);
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
    if (found !== vo.index + 1 || id(s.audioTracks[found - 1]) !== request.trackId)
      fail("Premiere added the track in the wrong position.");
    var track = s.audioTracks[found];
    if (track.clips.numItems !== 0 || track.isLocked())
      fail("The added audio track is not empty and unlocked.");
    return found;
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
      var clips = (s && s.getSelection()) || [];
      var selected = [];
      for (var k = 0; k < clips.length; k++) {
        var selectedClip = clips[k];
        if (String(selectedClip.mediaType) !== "Audio") continue;
        var path = mediaPath(selectedClip.projectItem);
        if (!selectedClip.nodeId || !path) fail("Select one audio file clip on the timeline.");
        var key = "clip:" + String(selectedClip.nodeId);
        if (seen[key]) continue;
        var located = false;
        for (var t = 0; t < s.audioTracks.numTracks; t++)
          for (var c = 0; c < s.audioTracks[t].clips.numItems; c++)
            if (String(s.audioTracks[t].clips[c].nodeId) === String(selectedClip.nodeId)) {
              selected.push({ clip: selectedClip, index: t, track: s.audioTracks[t], path: path });
              located = true;
            }
        if (!located) fail("The selected VO clip is gone. Select it again.");
        seen[key] = true;
      }
      if (selected.length) {
        var chosenClip = selected[0];
        for (var a = 1; a < selected.length; a++) {
          var other = selected[a];
          var sourceMap = mapping(chosenClip.clip.projectItem);
          // Only explicit linked mono channels with the same source and range are one instance.
          // Anchor the bottom channel so the new track does not split the linked group.
          if (
            !sourceMap ||
            sourceMap.audioChannelsType !== 0 ||
            sourceMap.audioClipsNumber < selected.length ||
            !chosenClip.clip.projectItem.nodeId ||
            String(chosenClip.clip.projectItem.nodeId) !== String(other.clip.projectItem.nodeId) ||
            timing(chosenClip.clip) !== timing(other.clip) ||
            !linked(chosenClip.clip, other.clip) ||
            !linked(other.clip, chosenClip.clip)
          )
            fail("Select only one VO clip on the timeline.");
          if (other.index > chosenClip.index) chosenClip = other;
        }
        return packet("source", [
          chosenClip.path,
          s.sequenceID,
          chosenClip.index,
          chosenClip.clip.start.seconds,
          chosenClip.clip.inPoint.seconds,
          chosenClip.clip.outPoint.seconds,
          String(project.documentID || project.path),
          String(chosenClip.clip.nodeId),
          id(chosenClip.track),
          chosenClip.clip.end.seconds
        ]);
      }
      var found = [];
      var views = (app.getProjectViewIDs && app.getProjectViewIDs()) || [];
      for (var v = 0; v < views.length; v++) {
        var selection = app.getProjectViewSelection(views[v]) || [];
        for (var i = 0; i < selection.length; i++) {
          var media = mediaPath(selection[i]);
          var itemKey = "item:" + String(selection[i].nodeId || media);
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
    var item = importCleaned();
    safeMapping(item);
    var beforeAudio = inventory(sequence.audioTracks);
    var beforeVideo = inventory(sequence.videoTracks);
    var frame = Number(sequence.timebase) / 254016000000;
    if (!(frame > 0 && frame < 1)) fail("Could not verify the sequence frame rate.");
    var oldIn = Number(item.getInPoint(2).seconds);
    var oldOut = Number(item.getOutPoint(2).seconds);
    var sourceIn = request.keepTiming ? request.inPoint : 0;
    var sourceOut = request.keepTiming ? request.outPoint : oldOut;
    if (
      !isFinite(oldIn) ||
      !isFinite(oldOut) ||
      !(sourceOut > sourceIn) ||
      sourceOut > oldOut + 0.001
    )
      fail("The cleaned source is shorter than the VO range.");
    var start = Number(vo.clip.start.seconds);
    var duration = Math.floor((sourceOut - sourceIn) / frame + 0.000001) * frame;
    if (!(duration > 0)) fail("The cleaned source range is too short.");
    try {
      // Same audio-only media type as Music. Never clear custom source points.
      item.setInPoint(sourceIn, 2);
      item.setOutPoint(sourceOut, 2);
      if (
        !near(item.getInPoint(2).seconds, sourceIn) ||
        !near(item.getOutPoint(2).seconds, sourceOut)
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
      safeMapping(item);
      app.enableQE();
      var qeSequence = qe.project.getActiveSequence();
      if (!qeSequence) fail("Premiere could not add a track.");
      mutationStarted = true;
      // Verify the result rather than trusting undocumented QE index semantics.
      qeSequence.addTracks(0, 0, 1, 1, vo.index + 1, 0, 0);
      added = newTrack(beforeAudio, sequence, vo);
      if (!unchanged(beforeVideo, inventory(sequence.videoTracks), -1))
        fail("Video tracks changed while adding the VO track.");
      var track = sequence.audioTracks[added];
      track.name = "Clean VO";
      safeMapping(item);
      track.overwriteClip(item, String(start));
      if (track.clips.numItems !== 1) fail("Premiere did not place exactly one cleaned VO clip.");
      var placed = track.clips[0];
      if (
        !same(mediaPath(placed.projectItem), request.path) ||
        !near(placed.start.seconds, start) ||
        !near(placed.end.seconds, start + duration) ||
        !near(placed.inPoint.seconds, sourceIn) ||
        !near(placed.outPoint.seconds, sourceIn + duration)
      )
        fail("Premiere did not place the expected cleaned VO range.");
      if (
        !unchanged(beforeAudio, inventory(sequence.audioTracks), added) ||
        !unchanged(beforeVideo, inventory(sequence.videoTracks), -1)
      )
        fail("Other clips changed during VO placement.");
    } finally {
      item.setInPoint(oldIn, 2);
      item.setOutPoint(oldOut, 2);
      if (!near(item.getInPoint(2).seconds, oldIn) || !near(item.getOutPoint(2).seconds, oldOut))
        fail("Premiere did not restore the cleaned item's source points.");
    }
    var completed = snapshot();
    return packet("placed", [
      mediaPath(item),
      added,
      start,
      checkpoint.checkpointId,
      checkpoint.checkpointSignature,
      completed.signature,
      ""
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
          request.start,
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
