import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderModel } from "@t3tools/contracts";
import { editingModelOptions } from "./models";

const luna: ServerProviderModel = {
  slug: "gpt-6-luna",
  name: "Luna",
  isCustom: false,
  capabilities: {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Effort",
        type: "select",
        currentValue: "high",
        options: [
          { id: "high", label: "High" },
          { id: "max", label: "Max" },
        ],
      },
      { id: "fastMode", label: "Fast", type: "boolean", currentValue: false },
    ],
  },
};

describe("editing model options", () => {
  it("defaults Luna to supported max effort and retains an explicit selection", () => {
    expect(editingModelOptions(luna, {})).toEqual([
      { id: "reasoningEffort", value: "max" },
      { id: "fastMode", value: false },
    ]);
    expect(editingModelOptions(luna, { reasoningEffort: "high" })[0]).toEqual({
      id: "reasoningEffort",
      value: "high",
    });
  });
  it("does not send stale or unsupported options after changing models", () => {
    const model: ServerProviderModel = {
      ...luna,
      slug: "another-model",
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Effort",
            type: "select",
            options: [{ id: "standard", label: "Standard" }],
          },
        ],
      },
    };
    expect(editingModelOptions(model, { reasoningEffort: "max", fastMode: true })).toEqual([
      { id: "reasoningEffort", value: "standard" },
    ]);
  });
  it("omits unavailable controls instead of inventing provider options", () => {
    expect(
      editingModelOptions({ ...luna, capabilities: null }, { reasoningEffort: "max" }),
    ).toEqual([]);
  });
});
