(function (root) {
  "use strict";

  function cutRange(sequence, range, dryRun) {
    function fail(message) {
      throw new Error(message);
    }
    var ticks = 254016000000;
    var frame = Number(sequence.timebase);
    if (!isFinite(frame) || frame <= 0) fail("Sequence frame rate is unavailable.");
    var format = Number(sequence.videoDisplayFormat);
    if (!((format >= 100 && format <= 108) || format === 110 || format === 113))
      fail("Set the sequence video display format to timecode before using transcript cuts.");
    var start = Math.round((range.start * ticks) / frame) * frame;
    var end = Math.round((range.end * ticks) / frame) * frame;
    if (!(start >= 0 && end > start && end <= Number(sequence.end) + frame / 100))
      fail("Select a positive range inside the sequence.");
    if (range.projectId !== String(app.project.documentID || app.project.path))
      fail("The active Premiere project changed.");
    app.enableQE();
    var qeSequence = qe.project.getActiveSequence();
    if (!qeSequence) fail("Premiere QE is unavailable; no range was cut.");
    var groups = [sequence.videoTracks, sequence.audioTracks];
    var tracks = [];
    var lockedIds = {};
    var g;
    var t;
    var c;
    var i;
    var clip;
    function clipTime(value) {
      return Number(value.ticks);
    }
    for (g = 0; g < groups.length; g++) {
      for (t = 0; t < groups[g].numTracks; t++) {
        var dom = groups[g][t];
        var qt = g === 0 ? qeSequence.getVideoTrackAt(t) : qeSequence.getAudioTrackAt(t);
        if (!qt || typeof qt.isLocked !== "function")
          fail("Cannot read track locks. No range was cut.");
        if (qt.isLocked()) {
          for (c = 0; c < dom.clips.numItems; c++) lockedIds["n" + dom.clips[c].nodeId] = true;
          continue;
        }
        if (typeof qt.razor !== "function") fail("This host cannot razor tracks.");
        // Moving clips does not reliably move their transitions in the scripting DOM.
        if (!dom.transitions || typeof dom.transitions.numItems !== "number")
          fail("Cannot inspect transitions. No range was cut.");
        for (i = 0; i < dom.transitions.numItems; i++)
          if (clipTime(dom.transitions[i].end) > start)
            fail(
              "Remove transitions at or after the cut on unlocked tracks before using transcript cuts.",
            );
        tracks.push({ dom: dom, qe: qt });
      }
    }
    if (!tracks.length) fail("All audio/video tracks are locked.");
    for (t = 0; t < tracks.length; t++) {
      for (c = 0; c < tracks[t].dom.clips.numItems; c++) {
        clip = tracks[t].dom.clips[c];
        if (clipTime(clip.end) <= start) continue;
        if (typeof clip.getLinkedItems === "function") {
          var linked = clip.getLinkedItems();
          var linkedCount = linked
            ? linked.numItems !== undefined
              ? linked.numItems
              : linked.length
            : 0;
          for (i = 0; i < linkedCount; i++)
            if (lockedIds["n" + linked[i].nodeId])
              fail("An affected clip is linked to a locked track. Unlock it before cutting.");
        }
      }
    }
    if (dryRun) return;
    function timecode(value) {
      var time = new Time();
      time.ticks = String(value);
      var rate = new Time();
      rate.ticks = String(frame);
      return time.getFormatted(rate, sequence.videoDisplayFormat);
    }
    function razor(track, point) {
      var spans = false;
      for (var n = 0; n < track.dom.clips.numItems; n++) {
        var item = track.dom.clips[n];
        if (clipTime(item.start) < point && clipTime(item.end) > point) spans = true;
      }
      if (!spans) return;
      var before = track.dom.clips.numItems;
      track.qe.razor(timecode(point));
      if (track.dom.clips.numItems <= before)
        fail("Premiere did not razor a boundary. Use Undo transcript cut before retrying.");
      for (var j = 0; j < track.dom.clips.numItems; j++) {
        var piece = track.dom.clips[j];
        if (
          clipTime(piece.start) < point - frame / 100 &&
          clipTime(piece.end) > point + frame / 100
        )
          fail("Premiere razored the wrong frame. Use Undo transcript cut before retrying.");
      }
    }
    for (t = 0; t < tracks.length; t++) {
      razor(tracks[t], end);
      razor(tracks[t], start);
    }
    var plans = [];
    var removed = [];
    for (t = 0; t < tracks.length; t++) {
      var track = tracks[t].dom;
      for (c = 0; c < track.clips.numItems; c++) {
        clip = track.clips[c];
        var cs = clipTime(clip.start);
        var ce = clipTime(clip.end);
        if (ce <= start + frame / 100) continue;
        if (cs < end - frame / 100) {
          if (cs < start - frame / 100 || ce > end + frame / 100)
            fail("A clip still crosses a cut boundary.");
          removed.push({ track: track, id: String(clip.nodeId) });
        } else
          plans.push({
            track: track,
            id: String(clip.nodeId),
            start: cs,
            end: ce,
            inPoint: clipTime(clip.inPoint),
            outPoint: clipTime(clip.outPoint),
          });
      }
    }
    function find(track, id) {
      for (var n = 0; n < track.clips.numItems; n++)
        if (String(track.clips[n].nodeId) === id) return track.clips[n];
      return null;
    }
    for (i = 0; i < removed.length; i++) {
      var victim = find(removed[i].track, removed[i].id);
      if (victim) victim.remove(false, false);
    }
    for (i = 0; i < removed.length; i++)
      if (find(removed[i].track, removed[i].id))
        fail("Premiere did not remove a clip. Use Undo transcript cut.");
    // A single explicit shift per clip avoids repeated per-track native ripple side effects.
    plans.sort(function (a, b) {
      return a.start - b.start;
    });
    for (i = 0; i < plans.length; i++) {
      var plan = plans[i];
      clip = find(plan.track, plan.id);
      if (!clip) fail("A linked clip disappeared unexpectedly. Use Undo transcript cut.");
      clip.start = String(plan.start - (end - start));
      clip.end = String(plan.end - (end - start));
      if (
        Math.abs(clipTime(clip.start) - (plan.start - (end - start))) > frame / 100 ||
        Math.abs(clipTime(clip.end) - (plan.end - (end - start))) > frame / 100 ||
        clipTime(clip.inPoint) !== plan.inPoint ||
        clipTime(clip.outPoint) !== plan.outPoint
      )
        fail("Premiere did not shift a clip correctly. Use Undo transcript cut.");
    }
    sequence.setPlayerPosition(String(start));
  }

  root.AxisRangeCut = cutRange;
  if (typeof module !== "undefined") module.exports = { cutRange: cutRange };
})(typeof window !== "undefined" ? window : globalThis);
