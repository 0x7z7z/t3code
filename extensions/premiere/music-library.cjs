"use strict";
// CEP's Node side owns filesystem access; the remote web panel never receives file:// URLs.
const fs = require("fs");
const path = require("path");
const child = require("child_process");
function run(binary, args, maxBuffer = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) =>
    child.execFile(
      binary,
      args,
      { windowsHide: true, timeout: 600000, maxBuffer },
      (error, stdout) =>
        error ? reject(new Error(String(stdout || error.message).slice(0, 800))) : resolve(stdout),
    ),
  );
}
function libraryFile(root, filename) {
  const base = fs.realpathSync(root);
  const file = fs.realpathSync(filename);
  const relative = path.relative(base, file);
  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    !fs.statSync(file).isFile()
  )
    throw new Error("Track must be inside the selected music library.");
  if (!/\.(wav|mp3|m4a|aac|flac|ogg|opus|aif|aiff|wma)$/i.test(file))
    throw new Error("Unsupported audio file.");
  return file;
}
async function operation(request, directory) {
  if (typeof request.root !== "string" || !request.root || request.root.length > 32768)
    throw new Error("Choose a music library folder.");
  const root = fs.realpathSync(request.root);
  const tool = path.join(directory, "tools", "axis_music.py");
  if (request.action === "index") {
    const args = [tool, "index", "--root", root, "--limit", "25", "--compact"];
    if (request.retryFailures === true) args.push("--retry-failures");
    const data = JSON.parse(await run("python", args));
    for (const track of data.tracks) track.energy = []; // Envelopes stay in the local cache.
    return { ok: true, ...data, tool };
  }
  if (request.action === "audition") {
    const file = libraryFile(root, request.path);
    if (!Number.isFinite(request.offset) || request.offset < 0 || request.offset > 14400)
      throw new Error("Invalid audition offset.");
    const bytes = await new Promise((resolve, reject) =>
      child.execFile(
        "ffmpeg",
        [
          "-v",
          "error",
          "-ss",
          String(request.offset),
          "-i",
          file,
          "-t",
          "30",
          "-vn",
          "-ac",
          "1",
          "-ar",
          "16000",
          "-f",
          "wav",
          "pipe:1",
        ],
        { windowsHide: true, timeout: 30000, maxBuffer: 2 * 1024 * 1024, encoding: "buffer" },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      ),
    );
    return {
      ok: true,
      dataUrl: "data:audio/wav;base64," + bytes.toString("base64"),
      name: path.basename(file) + ".wav",
      sizeBytes: bytes.length,
    };
  }
  throw new Error("Unknown music library action.");
}
module.exports = { operation, libraryFile };
