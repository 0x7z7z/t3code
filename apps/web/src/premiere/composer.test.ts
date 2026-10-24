import { describe, expect, it } from "vite-plus/test";
import type { ServerProvider } from "@t3tools/contracts";
import { accountLabel, slashItems, slashTrigger } from "./composer";

const account = (instanceId: string, displayName: string, email?: string) =>
  ({
    instanceId,
    displayName,
    auth: { status: "authenticated", ...(email ? { email } : {}) },
  }) as never;

describe("accountLabel", () => {
  it("uses the account name, adding the email only to tell two accounts apart", () => {
    const codexA = account("codex_a", "Codex", "anthony@example.com");
    const codexB = account("codex_b", "Codex", "editor@example.com");
    const claude = account("claude", "Claude", "anthony@example.com");
    expect(accountLabel(claude, [codexA, claude])).toBe("Claude");
    expect(accountLabel(codexA, [codexA, codexB, claude])).toBe("Codex · anthony");
  });
});

describe("slashTrigger", () => {
  it("finds the slash word at the cursor only at a word start", () => {
    expect(slashTrigger("/rev", 4)).toEqual({ start: 0, end: 4, query: "rev" });
    expect(slashTrigger("please /Plan", 12)).toEqual({ start: 7, end: 12, query: "plan" });
    expect(slashTrigger("a/b", 3)).toBeNull();
    expect(slashTrigger("/done now", 9)).toBeNull();
  });
});

describe("slashItems", () => {
  const provider = {
    slashCommands: [{ name: "review", description: "Review changes" }, { name: "shot-plan" }],
    skills: [
      { name: "shot-plan", path: "a", enabled: true, description: "Plan shots" },
      {
        name: "premiere-shot-placement",
        path: "b",
        enabled: true,
        shortDescription: "Place a plan",
      },
      { name: "hidden", path: "c", enabled: false },
    ],
    workspaceSnapshots: [],
  } as unknown as ServerProvider;

  it("lists commands and enabled skills, inserting skills as $mentions", () => {
    expect(slashItems(provider, null, "").map((item) => item.insert)).toEqual([
      "/review ",
      "$shot-plan ",
      "$premiere-shot-placement ",
    ]);
  });

  it("puts name prefix matches before other matches", () => {
    expect(slashItems(provider, null, "shot").map((item) => item.name)).toEqual([
      "shot-plan",
      "premiere-shot-placement",
    ]);
  });
});
