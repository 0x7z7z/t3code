"use strict";
const fs = require("fs");
const path = require("path");
const child = require("child_process");
const os = require("os");
const { transcriptionStatus } = require("./diagnostics.cjs");

function audioFile(value) {
  if (typeof value !== "string" || !value || value.length > 32768 || /\0/.test(value))
    throw new Error("Choose an audio file.");
  let filename;
  let stats;
  try {
    filename = fs.realpathSync(value);
    stats = fs.statSync(filename);
  } catch (error) {
    throw new Error("Audio file not found.", { cause: error });
  }
  if (
    !stats.isFile() ||
    !/\.(wav|mp3|m4a|aac|flac|ogg|opus|aif|aiff|wma|mp4|mov|m4v|mkv|avi|mxf)$/i.test(filename)
  )
    throw new Error("Choose a supported audio or video file.");
  return filename;
}

function hostOperation(request, directory, evaluate, options = {}) {
  const script = fs.readFileSync(path.join(directory, "vo-cleanup-host.js"), "utf8");
  const encoded = JSON.stringify(request)
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      settled = true;
      reject(
        new Error(
          request.action === "place" || request.action === "unplace"
            ? "Premiere did not respond. Check the timeline and use Undo in Premiere. Do not retry placement automatically."
            : "Premiere did not respond. Try again when any open dialog is closed.",
        ),
      );
    }, options.deadlineMs ?? 120000);
    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(result);
    }
    try {
      evaluate(
        "(" + script + ")(" + encoded + ",(" + (options.timelineSource || "null") + "))",
        (raw) => {
          if (settled) return;
          try {
            const fields = String(raw).split("|").map(decodeURIComponent);
            if (fields[0] !== "axis:vo")
              throw new Error(fields[1] || "Premiere could not complete VO cleanup.");
            const result = { ok: true, status: fields[1], path: fields[2] || "" };
            if (fields[1] === "source" && fields.length >= 12) {
              const [trackIndex, start, inPoint, outPoint] = fields.slice(4).map(Number);
              if (
                [trackIndex, start, inPoint, outPoint].every(Number.isFinite) &&
                Number.isInteger(trackIndex) &&
                trackIndex >= 0
              )
                result.anchor = {
                  sequenceId: fields[3],
                  trackIndex,
                  start,
                  inPoint,
                  outPoint,
                  projectId: fields[8],
                  nodeId: fields[9],
                  trackId: fields[10],
                  end: Number(fields[11]),
                  sourcePath: fields[2],
                  projectName: fields[12] || "",
                  sequenceName: fields[13] || "",
                };
            }
            if (fields[1] === "unanchored") result.message = fields[3] || "";
            if (fields[1] === "placed" || fields[1] === "recovery") {
              result.trackIndex = Number(fields[3]);
              result.start = Number(fields[4]);
              result.checkpointId = fields[5];
              result.checkpointSignature = fields[6];
              result.expectedSignature = fields[7];
              result.message = fields[8] || "";
            }
            if (fields[1] === "unplaced") {
              result.sequenceId = fields[3];
              result.message = fields[4] || "";
            }
            finish(null, result);
          } catch (error) {
            finish(error);
          }
        },
      );
    } catch (error) {
      finish(error);
    }
  });
}

async function operation(request, directory, evaluate, options = {}) {
  if (request.action === "resolve") {
    if (
      typeof request.projectId !== "string" ||
      !request.projectId ||
      typeof request.sequenceId !== "string" ||
      !request.sequenceId
    )
      throw new Error("Open the sequence containing this VO first.");
    return hostOperation(
      {
        action: "resolve",
        path: audioFile(request.path),
        projectId: request.projectId,
        sequenceId: request.sequenceId,
        projectName: request.projectName,
        sequenceName: request.sequenceName,
      },
      directory,
      evaluate,
      options,
    );
  }
  if (request.action === "pick" || request.action === "selected") {
    const result = await hostOperation({ action: request.action }, directory, evaluate, options);
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
      options,
    );
  }
  if (request.action === "place" || request.action === "unplace") {
    const placing = request.action === "place";
    const numbers = placing
      ? [request.trackIndex, request.start, request.end, request.inPoint, request.outPoint]
      : [];
    const validId = (value, max = 512) =>
      typeof value === "string" && value.length > 0 && value.length <= max;
    if (
      typeof request.projectId !== "string" ||
      !request.projectId ||
      typeof request.sequenceId !== "string" ||
      !request.sequenceId ||
      (placing &&
        (!Number.isInteger(request.trackIndex) ||
          !validId(request.trackId) ||
          !validId(request.nodeId) ||
          !validId(request.sourcePath, 32768) ||
          request.confirmed !== true)) ||
      (!placing &&
        (!validId(request.checkpointId) ||
          !validId(request.checkpointSignature, 4000000) ||
          !validId(request.expectedSignature, 4000000))) ||
      !numbers.every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)
    )
      throw new Error("Select the VO clip on the timeline again.");
    const scoped = {
      action: request.action,
      path: placing ? audioFile(request.path) : "",
      projectId: request.projectId,
      sequenceId: request.sequenceId,
      trackIndex: request.trackIndex,
      start: request.start,
      end: request.end,
      nodeId: request.nodeId,
      trackId: request.trackId,
      sourcePath: request.sourcePath,
      projectName: request.projectName,
      sequenceName: request.sequenceName,
      checkpointId: request.checkpointId,
      checkpointSignature: request.checkpointSignature,
      expectedSignature: request.expectedSignature,
    };
    if (request.action === "place")
      Object.assign(scoped, {
        inPoint: request.inPoint,
        outPoint: request.outPoint,
        keepTiming: request.keepTiming === true,
        confirmed: true,
      });
    return hostOperation(scoped, directory, evaluate, options);
  }
  if (
    request.action !== "run" ||
    !["silence", "breaths", "both", "sandwich"].includes(request.mode) ||
    !Number.isInteger(request.keepMs) ||
    request.keepMs < 0 ||
    request.keepMs > 5000
  )
    throw new Error("Choose a cleanup mode and 0-5000 ms retained silence.");
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
  const control = fs.mkdtempSync(path.join(os.tmpdir(), "axis-vo-control-"));
  const cancelFile = path.join(control, "stop");
  args.push("--cancel-file", cancelFile);
  const stop = () => fs.writeFileSync(cancelFile, "stop");
  options.signal?.addEventListener("abort", stop, { once: true });
  if (options.signal?.aborted) stop();
  try {
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
  } finally {
    options.signal?.removeEventListener("abort", stop);
    fs.rmSync(control, { recursive: true, force: true });
  }
}

module.exports = { operation, audioFile, hostOperation };
