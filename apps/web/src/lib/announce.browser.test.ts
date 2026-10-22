import { describe, expect, it, vi } from "vite-plus/test";

import { fakeTimers } from "../../test/render";
import { announce } from "./announce";

function spokenText() {
  return Array.from(document.querySelectorAll('[aria-live="polite"]'), (region) =>
    region.textContent?.trim(),
  ).filter(Boolean);
}

describe("announce", () => {
  it("speaks once focus settles, after the focus change that would cut it off", () => {
    using _timers = fakeTimers();
    const composer = document.createElement("textarea");
    document.body.append(composer);
    using _composer = { [Symbol.dispose]: () => composer.remove() };

    announce("Settled 1 thread, Ctrl+Z to undo");
    expect(spokenText()).toEqual([]);

    vi.advanceTimersByTime(200);
    composer.focus();
    announce("Fix login bug");
    vi.advanceTimersByTime(200);
    expect(spokenText()).toEqual([]);

    vi.advanceTimersByTime(50);
    expect(spokenText()).toEqual(["Settled 1 thread, Ctrl+Z to undo. Fix login bug"]);

    // A repeat lands in the other region so screen readers notice the change.
    announce("Fix login bug");
    vi.runAllTimers();
    const regions = document.querySelectorAll('[aria-live="polite"]');
    expect(regions[0]?.textContent).toBe("");
    expect(regions[1]?.textContent).toBe("Fix login bug");
  });
});
