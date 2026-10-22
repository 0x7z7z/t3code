import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  nextThreadAnnouncement,
  type ThreadActivitySnapshot,
  type ThreadAnnouncementMemory,
} from "./threadActivityAnnouncement";

const firstRun = RunId.make("run-1");
const secondRun = RunId.make("run-2");

const idle = (
  runId: RunId | null,
  runStatus: ThreadActivitySnapshot["runStatus"],
): ThreadActivitySnapshot => ({ status: "idle", activity: null, runId, runStatus });
const working = (activity: string | null, runId: RunId | null = secondRun) =>
  ({ status: "working", activity, runId, runStatus: "running" }) as const;

function speak(snapshots: ReadonlyArray<ThreadActivitySnapshot>) {
  let memory: ThreadAnnouncementMemory | null = null;
  const spoken: string[] = [];
  for (const snapshot of snapshots) {
    const result = nextThreadAnnouncement(memory, snapshot);
    memory = result.memory;
    spoken.push(...result.announcements.map((announcement) => announcement.text));
  }
  return spoken;
}

describe("nextThreadAnnouncement", () => {
  it("follows a turn from start to finish", () => {
    expect(
      speak([
        idle(firstRun, "completed"),
        working(null, firstRun),
        working("Thinking"),
        working("Reading ChatView.tsx"),
        working("Reading ChatView.tsx"),
        working("Running vp"),
        idle(secondRun, "completed"),
      ]),
    ).toEqual(["Working", "Thinking", "Reading ChatView.tsx", "Running vp", "Done"]);
  });

  it("announces the label that is already live when a turn starts", () => {
    expect(speak([idle(firstRun, "completed"), working("Running vp")])).toEqual([
      "Working",
      "Running vp",
    ]);
  });

  it("stays silent when a thread opens mid-turn or after one", () => {
    expect(speak([idle(firstRun, "completed"), idle(firstRun, "completed")])).toEqual([]);
    expect(speak([working("Running vp"), working("Running vp")])).toEqual([]);
  });

  it("announces the end of a turn that was already running when the thread opened", () => {
    expect(speak([working("Running vp"), idle(secondRun, "failed")])).toEqual(["Failed"]);
  });

  it("waits for the run to settle before announcing how the turn ended", () => {
    expect(
      speak([
        idle(firstRun, "completed"),
        working(null),
        idle(secondRun, "running"),
        idle(secondRun, "interrupted"),
      ]),
    ).toEqual(["Working", "Stopped"]);
  });

  it("does not report the previous turn's ending when work stops before a new run exists", () => {
    expect(
      speak([idle(firstRun, "completed"), working(null, firstRun), idle(firstRun, "completed")]),
    ).toEqual(["Working"]);
    // The previous run finished while this client looked idle.
    expect(
      speak([
        idle(firstRun, "completed"),
        idle(secondRun, "completed"),
        { ...working(null), runStatus: "completed" },
        idle(secondRun, "completed"),
      ]),
    ).toEqual(["Working"]);
  });

  it("announces requests once and resumes activity after them", () => {
    const approval = { ...working("Running vp"), status: "approval" } as const;
    const input = { ...working(null), status: "input" } as const;
    expect(
      speak([
        working("Running vp"),
        approval,
        approval,
        working("Running vp"),
        working("Editing ChatView.tsx"),
        input,
        idle(secondRun, "completed"),
      ]),
    ).toEqual(["Needs approval", "Editing ChatView.tsx", "Needs your input", "Done"]);
  });
});
