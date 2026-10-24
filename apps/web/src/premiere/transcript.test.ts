import { describe, expect, it } from "vite-plus/test";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import { buildTranscript, summarizeSteps } from "./transcript";

// The transcript reads only a handful of fields, so fixtures carry just those.
const item = (fields: Record<string, unknown>) =>
  ({ status: "completed", title: null, ...fields }) as unknown as OrchestrationV2TurnItem;

describe("buildTranscript", () => {
  it("shows the editor's request without the attached Premiere context", () => {
    const blocks = buildTranscript([
      item({
        id: "u1",
        type: "user_message",
        text: 'Count sequences\n\n<premiere-host-context>\n{"project":"a"}',
      }),
    ]);
    expect(blocks).toEqual([{ kind: "user", id: "u1", text: "Count sequences" }]);
  });

  it("groups consecutive tool calls and hides internal bookkeeping", () => {
    const blocks = buildTranscript([
      item({
        id: "c0",
        type: "command_execution",
        title: "Workspace ready",
        input: "Preparing workspace",
      }),
      item({ id: "a1", type: "assistant_message", text: "Checking.", streaming: false }),
      item({ id: "r1", type: "reasoning", text: "thinking", streaming: false }),
      item({
        id: "t1",
        type: "dynamic_tool",
        title: "get capabilities",
        toolName: "premiere.get_capabilities",
      }),
      item({ id: "t2", type: "dynamic_tool", title: null, toolName: "premiere.get_project_info" }),
      item({ id: "a2", type: "assistant_message", text: "Project: **x**", streaming: false }),
      item({ id: "k1", type: "checkpoint" }),
    ]);
    expect(blocks.map((block) => block.kind)).toEqual(["assistant", "tools", "assistant"]);
    const tools = blocks[1]!;
    expect(tools.kind === "tools" && tools.steps.map((step) => step.label)).toEqual([
      "Get capabilities",
      "Get project info",
    ]);
  });

  it("joins back-to-back assistant messages into one reply", () => {
    const blocks = buildTranscript([
      item({ id: "a1", type: "assistant_message", text: "First.", streaming: false }),
      item({ id: "a2", type: "assistant_message", text: "Second.", streaming: true }),
    ]);
    expect(blocks).toEqual([
      { kind: "assistant", id: "a1", text: "First.\n\nSecond.", streaming: true },
    ]);
  });
});

describe("summarizeSteps", () => {
  it("names the running step, otherwise counts steps and failures", () => {
    expect(
      summarizeSteps([
        { id: "1", label: "Get capabilities", status: "done" },
        { id: "2", label: "Get project info", status: "running" },
      ]),
    ).toBe("Get project info");
    expect(summarizeSteps([{ id: "1", label: "Get project info", status: "done" }])).toBe(
      "Get project info",
    );
    expect(
      summarizeSteps([
        { id: "1", label: "A", status: "done" },
        { id: "2", label: "B", status: "failed" },
      ]),
    ).toBe("2 steps · 1 failed");
  });
});
