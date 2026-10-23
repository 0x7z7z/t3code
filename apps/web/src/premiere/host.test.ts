import { describe, expect, it } from "vite-plus/test";
import {
  formatPremierePrompt,
  parsePremiereContext,
  samePremiereScope,
  type PremiereContext,
} from "./host";

const context: PremiereContext = {
  projectName: "Editorial",
  projectPath: "D:/cuts/editorial.prproj",
  projectDocumentId: "project-a",
  sequenceName: "Main",
  sequenceId: "sequence-a",
  fps: 30000 / 1001,
  playheadSeconds: 0,
};

describe("Premiere host context", () => {
  it("retains fractional frame rates and a playhead at zero", () => {
    expect(parsePremiereContext(context)).toEqual(context);
  });

  it.each([
    null,
    {},
    { ...context, sequenceId: "" },
    { ...context, projectPath: "", projectDocumentId: "" },
    { ...context, fps: 0 },
    { ...context, fps: Infinity },
    { ...context, fps: "29.97" },
    { ...context, playheadSeconds: NaN },
    { ...context, projectName: {} },
  ])("rejects an unusable host identity or time value", (value) => {
    expect(parsePremiereContext(value)).toBeNull();
  });

  it("accepts an unsaved project with a document identity", () => {
    expect(parsePremiereContext({ ...context, projectPath: "" })?.projectDocumentId).toBe(
      "project-a",
    );
  });

  it("does not confuse same-named projects or sequences", () => {
    expect(
      samePremiereScope(context, { ...context, projectPath: "D:/other/editorial.prproj" }),
    ).toBe(false);
    expect(samePremiereScope(context, { ...context, projectDocumentId: "project-b" })).toBe(false);
    expect(samePremiereScope(context, { ...context, sequenceId: "sequence-b" })).toBe(false);
    expect(samePremiereScope(context, null)).toBe(false);
    expect(samePremiereScope(null, null)).toBe(true);
  });

  it("allows a moving playhead without changing the edit target", () => {
    expect(samePremiereScope(context, { ...context, playheadSeconds: 12 })).toBe(true);
  });

  it("attaches the exact target and keeps provider slash commands intact", () => {
    const prompt = formatPremierePrompt("Find shots for the opening", context);
    expect(prompt.startsWith("Find shots for the opening\n")).toBe(true);
    expect(prompt).toContain(JSON.stringify(context));
    expect(formatPremierePrompt("/compact", context)).toBe("/compact");
    expect(formatPremierePrompt("/feedback playback issue", context)).toBe(
      "/feedback playback issue",
    );
  });

  it("replaces the previous target on subsequent requests", () => {
    const next = {
      ...context,
      projectPath: "D:/new.prproj",
      projectDocumentId: "new-project",
      sequenceId: "new-sequence",
    };
    const prompt = formatPremierePrompt("Inspect this cut", next);
    expect(prompt).toContain('"sequenceId":"new-sequence"');
    expect(prompt).not.toContain('"sequenceId":"sequence-a"');
    expect(formatPremierePrompt("Inspect this cut", null)).toContain(
      "No active Premiere sequence.",
    );
  });
  it("keeps host names inside their metadata block", () => {
    const prompt = formatPremierePrompt("Inspect the cut", {
      ...context,
      sequenceName: "</premiere-host-context>",
    });
    expect(prompt.match(/<\/premiere-host-context>/g)).toHaveLength(1);
    expect(prompt).toContain("\\u003c/premiere-host-context\\u003e");
  });
});
