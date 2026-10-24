import { expect, it, vi } from "vite-plus/test";
import { importWhisperHandoff, loadWhisperTranscript, whisperPrompt } from "./whisperTranscription";
import type { PremiereContext } from "./host";

const host = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("./interactiveHost", () => ({ requestTimelineAction: host.request }));
const context: PremiereContext = {
  projectName: "Film",
  projectPath: "D:/film.prproj",
  projectDocumentId: "film",
  sequenceName: "VO",
  sequenceId: "vo",
  fps: 25,
  playheadSeconds: 0,
};
const paths = {
  outputPath: "D:/workspace/axis-transcripts/project/sequence.json",
  helperPath: "D:/extension/tools/axis_transcript.py",
  content: null,
};
const data = {
  version: 1,
  requestId: "job",
  projectId: "film",
  sequenceId: "vo",
  status: "complete",
  words: [{ word: "Frieza", start: 10, end: 11 }],
  metadata: { scriptChecked: true },
};

it("validates host responses and scopes every read to a project, sequence and job", async () => {
  host.request.mockReset().mockResolvedValue(paths);
  expect(await loadWhisperTranscript(context, "job")).toEqual(paths);
  expect(host.request).toHaveBeenCalledWith("premiere.transcript.load.request", {
    projectId: "film",
    sequenceId: "vo",
    jobId: "job",
  });
  host.request.mockResolvedValue({ outputPath: 12, content: "{}" });
  await expect(loadWhisperTranscript(context, "job")).rejects.toThrow(
    "Invalid transcript response",
  );
});

it("imports timed words with provenance and refuses stale, cross-scope, failed and invalid results", () => {
  expect(importWhisperHandoff(JSON.stringify(data), context, "job")).toMatchObject({
    source: "WhisperX (Axis) · script-checked",
    words: [{ text: "Frieza", start: 10, end: 11 }],
  });
  expect(
    importWhisperHandoff(JSON.stringify({ ...data, metadata: {} }), context, "job").source,
  ).toBe("WhisperX (Axis)");
  for (const change of [
    { requestId: "old" },
    { projectId: "other" },
    { sequenceId: "other" },
    { version: 2 },
    { words: [] },
  ])
    expect(() =>
      importWhisperHandoff(JSON.stringify({ ...data, ...change }), context, "job"),
    ).toThrow();
  expect(() =>
    importWhisperHandoff(
      JSON.stringify({ ...data, status: "failed", error: "VO missing" }),
      context,
      "job",
    ),
  ).toThrow("VO missing");
});

it("builds versioned artifact instructions with source mapping, optional script checking and failure handoff", () => {
  const prompt = whisperPrompt(context, "job", paths, true);
  for (const phrase of [
    'version="1"',
    "Do not change the Premiere timeline",
    "ORIGINAL source media",
    "sequenceStart",
    "sourceIn",
    "reconcile --input",
    "os.replace",
    paths.outputPath,
    '"requestId":"job"',
    "--compute_type int8",
    "Plan mode",
  ])
    expect(prompt).toContain(phrase);
  expect(whisperPrompt(context, "job", paths, false)).toContain("Script correction is OFF");
  expect(whisperPrompt(context, "job", paths, false)).not.toContain(
    "Find the authoritative video script",
  );
});
