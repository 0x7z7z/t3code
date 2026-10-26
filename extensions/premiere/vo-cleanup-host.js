// eslint-disable-next-line no-unused-vars -- Serialized by the CEP bridge and evaluated in ExtendScript.
function axisVOCleanupHost(request) {
  try {
    function packet(status, value) {
      return "axis:vo|" + status + "|" + encodeURIComponent(String(value || ""));
    }
    var project = app.project;
    if (request.action === "pick") {
      var chosen = File.openDialog("Choose voice-over audio");
      return packet("source", chosen ? chosen.fsName : "");
    }
    if (!project) throw new Error("Open a Premiere project first.");
    if (request.action === "selected") {
      var items = [];
      var seen = {};
      var views = app.getProjectViewIDs();
      for (var v = 0; v < views.length; v++) {
        var selection = app.getProjectViewSelection(views[v]);
        for (var i = 0; i < selection.length; i++) {
          var media = selection[i].getMediaPath();
          var key = "item:" + String(selection[i].nodeId || media);
          if (media && !seen[key]) {
            items.push(selection[i]);
            seen[key] = true;
          }
        }
      }
      if (items.length !== 1) throw new Error("Select one audio item in the Project panel.");
      return packet("source", items[0].getMediaPath());
    }
    if (request.action !== "import") throw new Error("Invalid VO project action.");
    if (String(project.documentID || project.path) !== request.projectId)
      throw new Error("The project changed. Open the original project before importing.");
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
    if (!bin || !project.importFiles([file.fsName], true, bin, false))
      throw new Error("Premiere could not import the cleaned VO. The file is saved.");
    var found = false;
    for (var c = 0; c < bin.children.numItems; c++) {
      if (
        String(bin.children[c].getMediaPath()).replace(/\\/g, "/").toLowerCase() ===
        String(file.fsName).replace(/\\/g, "/").toLowerCase()
      )
        found = true;
    }
    if (!found) throw new Error("Import could not be verified. The cleaned file is saved.");
    return packet("imported", file.fsName);
  } catch (error) {
    return "axis:error|" + encodeURIComponent(String(error).slice(0, 800));
  }
}
