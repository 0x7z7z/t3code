// eslint-disable-next-line no-unused-vars -- Serialized by the CEP bridge and evaluated in ExtendScript.
function axisVOCleanupHost(request) {
  try {
    function packet(status, values) {
      var parts = ["axis:vo", status];
      for (var p = 0; p < values.length; p++) parts.push(encodeURIComponent(String(values[p])));
      return parts.join("|");
    }
    function same(a, b) {
      return (
        String(a).replace(/\\/g, "/").toLowerCase() === String(b).replace(/\\/g, "/").toLowerCase()
      );
    }
    function mediaPath(item) {
      try {
        return item && item.getMediaPath ? String(item.getMediaPath() || "") : "";
      } catch (_error) {
        return "";
      }
    }
    function scope() {
      if (String(project.documentID || project.path) !== request.projectId)
        throw new Error("The project changed. Open the original project first.");
    }
    function activeSequence() {
      var s = project.activeSequence;
      if (!s || String(s.sequenceID) !== request.sequenceId)
        throw new Error("Open the sequence the VO came from, then try again.");
      return s;
    }
    function importCleaned() {
      var file = new File(request.path);
      if (!file.exists) throw new Error("The cleaned audio file is missing.");
      var bin = null;
      for (var b = 0; b < project.rootItem.children.numItems; b++) {
        var item = project.rootItem.children[b];
        if (item.type === 2 && item.name === "Axis VO cleanup") {
          bin = item;
          break;
        }
      }
      if (!bin) bin = project.rootItem.createBin("Axis VO cleanup");
      if (!bin) throw new Error("Premiere could not create the Axis VO cleanup bin.");
      var c;
      for (c = 0; c < bin.children.numItems; c++)
        if (same(mediaPath(bin.children[c]), file.fsName)) return bin.children[c];
      if (!project.importFiles([file.fsName], true, bin, false))
        throw new Error("Premiere could not import the cleaned VO. The file is saved.");
      for (c = 0; c < bin.children.numItems; c++)
        if (same(mediaPath(bin.children[c]), file.fsName)) return bin.children[c];
      throw new Error("Import could not be verified. The cleaned file is saved.");
    }
    function layout(s) {
      var rows = [];
      for (var t = 0; t < s.audioTracks.numTracks; t++)
        rows.push(String(s.audioTracks[t].name) + "#" + s.audioTracks[t].clips.numItems);
      return rows;
    }
    var project = app.project;
    if (request.action === "pick") {
      var chosen = File.openDialog("Choose voice-over audio");
      return packet("source", [chosen ? chosen.fsName : ""]);
    }
    if (!project) throw new Error("Open a Premiere project first.");
    if (request.action === "selected") {
      var seen = {};
      // A clip selected on the timeline wins, and Axis keeps where it sits.
      var s = project.activeSequence;
      var clips = (s && s.getSelection()) || [];
      var anchors = [];
      for (var k = 0; k < clips.length; k++) {
        if (String(clips[k].mediaType) !== "Audio") continue;
        var path = mediaPath(clips[k].projectItem);
        if (!path || seen["clip:" + path]) continue;
        for (var t = 0; t < s.audioTracks.numTracks; t++) {
          var trackClips = s.audioTracks[t].clips;
          for (var c = 0; c < trackClips.numItems; c++)
            if (String(trackClips[c].nodeId) === String(clips[k].nodeId)) {
              anchors.push([
                path,
                s.sequenceID,
                t,
                clips[k].start.seconds,
                clips[k].inPoint.seconds,
                clips[k].outPoint.seconds
              ]);
              seen["clip:" + path] = true;
            }
        }
      }
      if (anchors.length === 1) return packet("source", anchors[0]);
      if (anchors.length > 1) throw new Error("Select only one VO clip on the timeline.");
      var found = [];
      // Premiere returns undefined, not an empty array, for views with nothing selected.
      var views = (app.getProjectViewIDs && app.getProjectViewIDs()) || [];
      for (var v = 0; v < views.length; v++) {
        var selection = app.getProjectViewSelection(views[v]) || [];
        for (var i = 0; i < selection.length; i++) {
          var media = mediaPath(selection[i]);
          var key = "item:" + String(selection[i].nodeId || media);
          if (media && !seen[key]) {
            found.push([media]);
            seen[key] = true;
          }
        }
      }
      if (found.length === 1) return packet("source", found[0]);
      if (found.length > 1) throw new Error("Select only one audio item in the Project panel.");
      throw new Error("Select one VO clip on the timeline or one audio item in the Project panel.");
    }
    scope();
    if (request.action === "import") {
      return packet("imported", [mediaPath(importCleaned())]);
    }
    if (request.action === "place") {
      var sequence = activeSequence();
      var index = request.trackIndex;
      if (index < 0 || index >= sequence.audioTracks.numTracks)
        throw new Error("The VO track is gone. Select the VO clip again.");
      var item = importCleaned();
      var before = layout(sequence);
      var videoBefore = [];
      for (var vt = 0; vt < sequence.videoTracks.numTracks; vt++)
        videoBefore.push(sequence.videoTracks[vt].clips.numItems);
      app.enableQE();
      var qeSequence = qe.project.getActiveSequence();
      if (!qeSequence)
        throw new Error("Premiere could not add a track. The cleaned VO is in the bin.");
      // One stereo audio track, inserted after the VO's track (track numbers are 1-based).
      qeSequence.addTracks(0, 0, 1, 1, index + 1, 0, 0);
      var after = layout(sequence);
      if (after.length !== before.length + 1)
        throw new Error("Premiere could not add a track. The cleaned VO is in the bin.");
      // The new track is the one whose removal leaves the old layout unchanged.
      var added = -1;
      var order = [index + 1];
      for (var o = 0; o < after.length; o++) if (o !== index + 1) order.push(o);
      for (var q = 0; q < order.length && added < 0; q++) {
        var candidate = order[q];
        if (sequence.audioTracks[candidate].clips.numItems !== 0) continue;
        var rest = after.slice(0, candidate).concat(after.slice(candidate + 1));
        if (rest.join("\n") === before.join("\n")) added = candidate;
      }
      if (added < 0) throw new Error("Could not find the new empty track. Nothing was placed.");
      var track = sequence.audioTracks[added];
      track.name = "Clean VO";
      var oldIn = item.getInPoint(2);
      var oldOut = item.getOutPoint(2);
      var start = request.start;
      try {
        // Breath cleanup keeps the length, so the clip keeps the VO's trim and sync.
        if (request.keepTiming) {
          item.setInPoint(request.inPoint, 2);
          item.setOutPoint(Math.min(request.outPoint, Number(oldOut.seconds)), 2);
        }
        track.overwriteClip(item, String(start));
      } finally {
        if (item.clearInPoint && item.clearOutPoint) {
          item.clearInPoint();
          item.clearOutPoint();
        } else {
          item.setInPoint(oldIn.seconds, 2);
          item.setOutPoint(oldOut.seconds, 2);
        }
      }
      var placed = null;
      for (var n = 0; n < track.clips.numItems; n++)
        if (
          same(mediaPath(track.clips[n].projectItem), request.path) &&
          Math.abs(track.clips[n].start.seconds - start) < 0.05
        )
          placed = track.clips[n];
      var changed = layout(sequence);
      changed.splice(added, 1);
      var videoSame = true;
      for (var vc = 0; vc < sequence.videoTracks.numTracks; vc++)
        if (sequence.videoTracks[vc].clips.numItems !== videoBefore[vc]) videoSame = false;
      if (!placed || track.clips.numItems !== 1)
        throw new Error("Premiere did not place the cleaned VO. It is in the bin.");
      if (changed.join("\n") !== before.join("\n") || !videoSame)
        throw new Error(
          "Other tracks changed during placement. Press Ctrl+Z in Premiere to check."
        );
      return packet("placed", [mediaPath(item), added, placed.start.seconds]);
    }
    if (request.action === "unplace") {
      var seq = activeSequence();
      var target = seq.audioTracks[request.trackIndex];
      if (!target) throw new Error("The Clean VO track is gone.");
      for (var u = 0; u < target.clips.numItems; u++) {
        var clip = target.clips[u];
        if (
          same(mediaPath(clip.projectItem), request.path) &&
          Math.abs(clip.start.seconds - request.start) < 0.05
        ) {
          clip.remove(false, false);
          return packet("unplaced", [request.path]);
        }
      }
      throw new Error("The placed Clean VO clip was not found. It may already be removed.");
    }
    throw new Error("Invalid VO project action.");
  } catch (error) {
    return "axis:error|" + encodeURIComponent(String(error).slice(0, 800));
  }
}
