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
): ThreadActivitySnapshot => ({ status: "idle", runId, runStatus });
const busy = (
  status: Exclude<ThreadActivitySnapshot["status"], "idle"> = "working",
  runId: RunId | null = secondRun,
  runStatus: ThreadActivitySnapshot["runStatus"] = "running",
): ThreadActivitySnapshot => ({ status, runId, runStatus });

function speak(snapshots: ReadonlyArray<ThreadActivitySnapshot>) {
  let memory: ThreadAnnouncementMemory | null = null;
  const spoken: string[] = [];
  for (const snapshot of snapshots) {
    const result = nextThreadAnnouncement(memory, snapshot);
    memory = result.memory;
    if (result.announcement !== null) spoken.push(result.announcement);
  }
  return spoken;
}

describe("nextThreadAnnouncement", () => {
  it("follows a turn from start to finish", () => {
    expect(
      speak([idle(firstRun, "completed"), busy(), busy(), idle(secondRun, "completed")]),
    ).toEqual(["Working", "Done"]);
  });

  it("says Working once when a send looks idle before its run appears", () => {
    expect(
      speak([idle(null, null), busy(), idle(null, null), busy(), idle(secondRun, "completed")]),
    ).toEqual(["Working", "Done"]);
  });

  it("announces a queued message that starts as the last turn ends", () => {
    const thirdRun = RunId.make("run-3");
    expect(
      speak([
        idle(firstRun, "completed"),
        busy("working", firstRun, "completed"),
        busy(),
        busy("working", secondRun, "completed"),
        busy("working", thirdRun, "starting"),
        idle(thirdRun, "completed"),
      ]),
    ).toEqual(["Working", "Working", "Done"]);
    // The last turn's run is still settling when the follow-up is sent.
    expect(
      speak([
        idle(firstRun, "running"),
        busy("working", firstRun, "running"),
        busy("working", secondRun, "starting"),
      ]),
    ).toEqual(["Working"]);
    expect(
      speak([
        idle(firstRun, "running"),
        busy("working", firstRun, "running"),
        idle(firstRun, "completed"),
        busy("working", secondRun, "starting"),
        idle(secondRun, "completed"),
      ]),
    ).toEqual(["Working", "Done"]);
    expect(
      speak([
        busy("working", firstRun, "running"),
        idle(firstRun, "running"),
        busy("working", firstRun, "running"),
        busy("working", secondRun, "starting"),
      ]),
    ).toEqual(["Working"]);
  });

  it("treats a run that starts while the thread looks idle as the next turn", () => {
    const thirdRun = RunId.make("run-3");
    // A resume or a turn started from another device.
    expect(
      speak([
        idle(firstRun, "completed"),
        idle(secondRun, "starting"),
        busy("working", secondRun, "running"),
        idle(secondRun, "completed"),
      ]),
    ).toEqual(["Working", "Done"]);
    // A queued message waiting to start after the last turn.
    expect(
      speak([
        idle(firstRun, "completed"),
        busy(),
        idle(thirdRun, "queued"),
        idle(thirdRun, "starting"),
        busy("working", thirdRun, "running"),
        idle(thirdRun, "completed"),
      ]),
    ).toEqual(["Working", "Working", "Done"]);
  });

  it("stays silent when a thread opens mid-turn or after one", () => {
    expect(speak([idle(firstRun, "completed"), idle(firstRun, "completed")])).toEqual([]);
    expect(speak([busy(), busy()])).toEqual([]);
  });

  it("announces the end of a turn that was already running when the thread opened", () => {
    expect(speak([busy(), idle(secondRun, "failed")])).toEqual(["Failed"]);
  });

  it("waits for the run to settle before announcing how the turn ended", () => {
    expect(
      speak([
        idle(firstRun, "completed"),
        busy(),
        idle(secondRun, "running"),
        idle(secondRun, "interrupted"),
      ]),
    ).toEqual(["Working", "Stopped"]);
  });

  it("does not report the previous turn's ending when work stops before a new run exists", () => {
    expect(
      speak([
        idle(firstRun, "completed"),
        busy("working", firstRun, "completed"),
        idle(firstRun, "completed"),
        busy(),
        idle(secondRun, "completed"),
      ]),
    ).toEqual(["Working", "Working", "Done"]);
    // The previous run finished while this client looked idle.
    expect(
      speak([
        idle(firstRun, "completed"),
        idle(secondRun, "completed"),
        busy("working", secondRun, "completed"),
        idle(secondRun, "completed"),
      ]),
    ).toEqual(["Working"]);
  });

  it("lets the next turn start after one is rolled back", () => {
    expect(
      speak([
        idle(firstRun, "completed"),
        busy(),
        idle(secondRun, "rolled_back"),
        busy("working", RunId.make("run-3")),
      ]),
    ).toEqual(["Working", "Working"]);
  });

  it("announces each request once without repeating that work resumed", () => {
    expect(
      speak([
        busy(),
        busy("approval"),
        busy("approval"),
        busy(),
        busy("input"),
        idle(secondRun, "completed"),
      ]),
    ).toEqual(["Needs approval", "Needs your input", "Done"]);
  });
});
