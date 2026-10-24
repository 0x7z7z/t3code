"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const MAX_BYTES = 10000000;

function identity(value) {
  if (typeof value !== "string" || !value || value.length > 32768 || /\0/.test(value))
    throw new Error("Invalid transcript identity.");
  return crypto.createHash("sha256").update(value).digest("hex");
}

// No caller-supplied paths. Hashes also support Premiere IDs containing slashes or colons.
function loadTranscript(config, request, extensionDirectory) {
  if (!config || typeof config.workspacePath !== "string" || !path.isAbsolute(config.workspacePath))
    throw new Error("The Axis workspace is not configured.");
  if (typeof request.jobId !== "string" || !/^[a-zA-Z0-9-]{1,128}$/.test(request.jobId))
    throw new Error("Invalid transcription request ID.");
  const workspace = fs.realpathSync(config.workspacePath);
  const project = identity(request.projectId);
  const sequence = identity(request.sequenceId);
  const directory = path.join(workspace, "axis-transcripts", project);
  const filename = path.join(directory, sequence + ".json");
  const result = {
    ok: true,
    content: null,
    outputPath: filename,
    helperPath: path.join(extensionDirectory, "tools", "axis_transcript.py"),
  };
  // Refuse symlinks/junctions at every level, even if the final file is absent.
  for (const candidate of [path.join(workspace, "axis-transcripts"), directory, filename]) {
    try {
      if (fs.lstatSync(candidate).isSymbolicLink() || fs.realpathSync(candidate) !== candidate)
        throw new Error("Transcript paths must stay inside the Axis workspace without links.");
    } catch (error) {
      if (error.code === "ENOENT") return result;
      throw error;
    }
  }
  if (request.prepareOnly === true) return result;
  const descriptor = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > MAX_BYTES)
      throw new Error("Choose a transcript file smaller than 10 MB.");
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    const length = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (length > MAX_BYTES) throw new Error("Choose a transcript file smaller than 10 MB.");
    const content = buffer.toString("utf8", 0, length);
    let data;
    try {
      data = JSON.parse(content);
    } catch {
      throw new Error("Invalid transcript handoff JSON. Write results atomically.");
    }
    if (data.requestId !== request.jobId) return result; // Previous run, never auto-import it.
    if (
      data.version !== 1 ||
      data.projectId !== request.projectId ||
      data.sequenceId !== request.sequenceId
    )
      throw new Error("The transcript belongs to a different project or sequence.");
    if (data.status === "failed")
      throw new Error(
        typeof data.error === "string" ? data.error.slice(0, 1024) : "Transcription failed.",
      );
    if (data.status !== "complete") throw new Error("Invalid transcript handoff status.");
    result.content = content;
    return result;
  } finally {
    fs.closeSync(descriptor);
  }
}

module.exports = { loadTranscript };
