import { describe, expect, it } from "vite-plus/test";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { premiereMcpServer } from "./McpConfig.ts";
import { codexThreadRuntimeParams } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { claudeMcpQueryOverrides } from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";

const server = {
  command: "C:/Node/node.exe",
  args: ["D:/Premiere connector/dist/index.js"],
  env: { PREMIERE_TEMP_DIR: "C:/Editing/bridge" },
};
const environment = {
  T3CODE_PREMIERE_MCP: JSON.stringify({ workspacePath: "C:/Editing/workspace", ...server }),
};
const runtimePolicy = (cwd: string) =>
  ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    cwd,
    runtimeMode: "approval-required",
    interactionMode: "default",
  });

describe("installed Premiere connector", () => {
  it("attaches only inside the dedicated workspace, preserving case-sensitive Unix paths", () => {
    expect(premiereMcpServer(environment, "c:\\editing\\workspace\\")).toEqual(server);
    expect(premiereMcpServer(environment, "C:/Editing/workspace/other")).toBeUndefined();
    expect(premiereMcpServer({}, "C:/Editing/workspace")).toBeUndefined();
    const unix = { T3CODE_PREMIERE_MCP: JSON.stringify({ workspacePath: "/Editing", ...server }) };
    expect(premiereMcpServer(unix, "/editing")).toBeUndefined();
    expect(premiereMcpServer(unix, "/Editing/")).toEqual(server);
  });

  it("rejects invalid installed configuration", () => {
    for (const value of [
      "{",
      "null",
      JSON.stringify({ workspacePath: "C:/Editing", command: "node", args: [1] }),
    ]) {
      expect(() => premiereMcpServer({ T3CODE_PREMIERE_MCP: value }, "C:/Editing")).toThrow(
        /Reinstall/,
      );
    }
  });

  it("passes Codex its connector independently of untrusted project configuration", () => {
    const params = codexThreadRuntimeParams({
      environment,
      mcpSession: undefined,
      runtimePolicy: runtimePolicy("C:/Editing/workspace"),
    });
    expect(params.config["mcp_servers.premiere"]).toEqual(server);
    expect(params.config["tools.update_plan.enabled"]).toBe(true);
    expect(
      codexThreadRuntimeParams({
        environment,
        mcpSession: undefined,
        runtimePolicy: runtimePolicy("/other"),
      }).config,
    ).not.toHaveProperty("mcp_servers.premiere");
  });

  it("attaches Claude's connector without pre-approving its mutating tools", () => {
    const overrides = claudeMcpQueryOverrides({
      environment,
      cwd: "C:/Editing/workspace",
      mcpSession: undefined,
      readOnlySandbox: true,
      allowedTools: ["Read"],
    });
    expect(overrides.mcpServers?.premiere).toEqual({ type: "stdio", ...server });
    expect(overrides.allowedTools).toEqual(["Read"]);
  });
});
