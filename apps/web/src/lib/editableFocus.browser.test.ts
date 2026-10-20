import { describe, expect, it } from "vite-plus/test";

import { isEditableFocused } from "./editableFocus";

describe("isEditableFocused", () => {
  it("sees a text field focused inside an open shadow root", () => {
    // Page shortcuts receive the shadow host as the key event target.
    const host = document.createElement("div");
    const input = document.createElement("input");
    host.attachShadow({ mode: "open" }).append(input);
    document.body.append(host);
    using _host = { [Symbol.dispose]: () => host.remove() };

    expect(isEditableFocused(host)).toBe(false);
    input.focus();
    expect(isEditableFocused(host)).toBe(true);
    expect(isEditableFocused()).toBe(true);
  });
});
