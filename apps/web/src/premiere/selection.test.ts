import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderModel } from "@t3tools/contracts";
import { selectEditingModel, selectEditingProvider, selectEditingWorkspace } from "./selection";

const projects = [{ id: "project-a", environmentId: "environment-a" }];
const providers = [{ instanceId: "account-a", enabled: true, installed: true }];
const models: ServerProviderModel[] = [
  { slug: "gpt-6-luna", name: "Luna", isCustom: false, capabilities: null },
];

describe("explicit editing selections", () => {
  it("does not replace a removed account with another subscription", () => {
    expect(selectEditingProvider(providers, "account-b")).toBeNull();
  });
  it("does not replace a removed workspace with another project", () => {
    expect(selectEditingWorkspace(projects, "environment-b:project-a")).toBeNull();
  });
  it("does not replace an unavailable model with a default model", () => {
    expect(selectEditingModel(models, "selected-model")).toBeNull();
  });
  it("keeps explicit accounts unavailable while disabled or uninstalled", () => {
    expect(selectEditingProvider([{ ...providers[0]!, enabled: false }], "account-a")).toBeNull();
    expect(selectEditingProvider([{ ...providers[0]!, installed: false }], "account-a")).toBeNull();
  });
  it("uses defaults only before the user makes a selection", () => {
    expect(selectEditingWorkspace(projects, null)).toBe(projects[0]);
    expect(selectEditingProvider(providers, null)).toBe(providers[0]);
    expect(selectEditingModel(models, null)).toBe(models[0]);
  });
  it("restores the exact account when it returns after a refresh", () => {
    expect(selectEditingProvider([], "account-a")).toBeNull();
    expect(selectEditingProvider(providers, "account-a")).toBe(providers[0]);
  });
});
