"use strict";
const fs = require("fs");
const path = require("path");
const child = require("child_process");
const { transcriptionStatus } = require("./diagnostics.cjs");

function audioFile(value) {
  if (typeof value !== "string" || !value || value.length > 32768 || /\0/.test(value))
    throw new Error("Choose an audio file.");
  const filename = fs.realpathSync(value);
  if (
    !fs.statSync(filename).isFile() ||
    !/\.(wav|mp3|m4a|aac|flac|ogg|opus|aif|aiff|wma|mp4|mov|m4v|mkv|avi|mxf)$/i.test(filename)
  )
    throw new Error("Choose a supported audio or video file.");
  return filename;
}

function hostOperation(request, directory, evaluate) {
  const script = fs.readFileSync(path.join(directory, "vo-cleanup-host.js"), "utf8");
  const encoded = JSON.stringify(request)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return new Promise((resolve, reject) => {
    evaluate("(" + script + ")(" + encoded + ")", (raw) => {
      try {
        const fields = String(raw).split("|").map(decodeURIComponent);
        if (fields[0] !== "axis:vo")
          throw new Error(fields[1] || "Premiere could not complete VO cleanup.");
        const result = { ok: true, status: fields[1], path: fields[2] || "" };
        if (fields[1] === "source" && fields.length === 8) {
          const [trackIndex, start, inPoint, outPoint] = fields.slice(4).map(Number);
          if (
            [trackIndex, start, inPoint, outPoint].every(Number.isFinite) &&
            Number.isInteger(trackIndex) &&
            trackIndex >= 0
          )
            result.anchor = { sequenceId: fields[3], trackIndex, start, inPoint, outPoint };
        }
        if (fields[1] === "placed") {
          result.trackIndex = Number(fields[3]);
          result.start = Number(fields[4]);
        }
        resolve(result);
      } catch (error) {
        reject(error);
      }
    });
  });
}

async function operation(request, directory, evaluate) {
  if (request.action === "pick" || request.action === "selected") {
    const result = await hostOperation({ action: request.action }, directory, evaluate);
    if (result.path) result.path = audioFile(result.path);
    return result;
  }
  if (request.action === "import") {
    if (
      typeof request.projectId !== "string" ||
      !request.projectId ||
      request.projectId.length > 32768
    )
      throw new Error("Open the original Premiere project before importing.");
    return hostOperation(
      { action: "import", path: audioFile(request.path), projectId: request.projectId },
      directory,
      evaluate,
    );
  }
  if (request.action === "place" || request.action === "unplace") {
    const numbers = [request.trackIndex, request.start].concat(
      request.action === "place" ? [request.inPoint, request.outPoint] : [],
    );
    if (
      typeof request.projectId !== "string" ||
      !request.projectId ||
      typeof request.sequenceId !== "string" ||
      !request.sequenceId ||
      !Number.isInteger(request.trackIndex) ||
      request.trackIndex < 0 ||
      !numbers.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)
    )
      throw new Error("Select the VO clip on the timeline again.");
    const scoped = {
      action: request.action,
      path: audioFile(request.path),
      projectId: request.projectId,
      sequenceId: request.sequenceId,
      trackIndex: request.trackIndex,
      start: request.start,
    };
    if (request.action === "place")
      Object.assign(scoped, {
        inPoint: request.inPoint,
        outPoint: request.outPoint,
        keepTiming: request.keepTiming === true,
      });
    return hostOperation(scoped, directory, evaluate);
  }
  if (
    request.action !== "run" ||
    !["silence", "breaths", "both"].includes(request.mode) ||
    !Number.isInteger(request.keepMs) ||
    request.keepMs < 0 ||
    request.keepMs > 5000
  )
    throw new Error("Choose silence, breaths or both, and 0-5000 ms retained silence.");
  const source = audioFile(request.path);
  const python = await transcriptionStatus();
  if (!python.path) throw new Error("Install Python 3.12. See Axis Menu > Diagnostics.");
  if (request.mode !== "silence" && !python.whisperx)
    throw new Error(
      "Breath cleanup needs WhisperX. Complete Transcription setup in Axis Diagnostics.",
    );
  const missing = await new Promise((resolve) => {
    child.execFile(
      python.path,
      [
        "-c",
        'import importlib.util as u; print(" ".join(m for m in ("numpy","soundfile","pydub") if not u.find_spec(m)))',
      ],
      { windowsHide: true, timeout: 30000 },
      (error, stdout) => resolve(error ? "" : String(stdout).trim()),
    );
  });
  if (missing)
    throw new Error(
      "Clean VO needs " + missing + ". Run: py -3.12 -m pip install numpy soundfile pydub==0.25.1",
    );
  const args = [
    path.join(directory, "tools", "axis_vo_cleanup.py"),
    "--input",
    source,
    "--mode",
    request.mode,
    "--keep-ms",
    String(request.keepMs),
  ];
  const data = await new Promise((resolve, reject) => {
    child.execFile(
      python.path,
      args,
      { windowsHide: true, timeout: 21600000, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(String(stderr || error.message).slice(-1000)));
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error("Invalid cleanup output. Check the audio folder before retrying."));
        }
      },
    );
  });
  return { ok: true, ...data };
}

module.exports = { operation, audioFile, hostOperation };
